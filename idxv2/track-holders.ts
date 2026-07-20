// holder-tracker.ts — Case 3: track all holders of one token, per-holder
// balance changes over time.
//
// Architecture (feed = advisory, snapshot = authoritative):
//
//   1. SNAPSHOT  getProgramAccounts(TokenProgram, memcmp mint) → full holder
//                set aggregated by owner. Runs at startup and every
//                RECONCILE_MIN minutes; corrects any drift from missed events
//                and records corrections as explicit 'reconcile' rows.
//   2. REALTIME  two modes:
//                  paid: Helius transactionSubscribe (atlas WS) with
//                        accountInclude=[mint] — meta pushed, no round-trip
//                  free: logsSubscribe(mentions=[mint]) → getTransaction
//                Deltas ALWAYS from pre/postTokenBalances (never instruction
//                parsing — a Jupiter route can touch 6 programs; balance diff
//                is the only truth).
//   3. HISTORY   bun:sqlite — holders table (current state) + append-only
//                changes log (owner, delta, balance_after, slot, signature,
//                kind). DAO reward calcs and "new holder" telegram hooks both
//                read from here.
//
// Known blind spot of the free realtime path: plain SPL `transfer` doesn't
// include the mint in account keys, so logsSubscribe misses it (transferChecked
// and all AMM/bonding-curve trades DO include it). Reconciliation exists
// precisely to sweep those up.
//
// Run:  HELIUS_API_KEY=... bun holder-tracker.ts <MINT>
//       RPC_HTTP_URL=... RPC_WS_URL=... bun holder-tracker.ts <MINT>   (free mode)
// Env:  MODE=enhanced|logs (default: enhanced if HELIUS_API_KEY set)
//       RECONCILE_MIN=10   DB_PATH=holders-<mint>.db   MIN_NOTIFY_UI=0

import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const MINT = process.argv[2] ?? process.env.MINT;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const KEY = process.env.HELIUS_API_KEY;
const HTTP_URL =
  process.env.RPC_HTTP_URL ??
  (KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : null);
const WS_URL =
  process.env.RPC_WS_URL ??
  (KEY ? `wss://mainnet.helius-rpc.com/?api-key=${KEY}` : null);
const ENHANCED_WS_URL =
  process.env.ENHANCED_WS_URL ??
  (KEY ? `wss://atlas-mainnet.helius-rpc.com/?api-key=${KEY}` : null);

const CONFIG = {
  mode: (process.env.MODE ?? "logs") as "enhanced" | "logs",
  commitment: "confirmed" as const, // balances feed rewards — don't use processed
  reconcileMs: Number(process.env.RECONCILE_MIN ?? 10) * 60_000,
  pingIntervalMs: 25_000,
  backoffBaseMs: 500,
  backoffMaxMs: 20_000,
  sigLruSize: 8_192,
  // suppress notification spam below this UI amount delta (still recorded in db)
  minNotifyUi: Number(process.env.MIN_NOTIFY_UI ?? 0),
};

// ---------------------------------------------------------------------------
// rpc helpers — throttled for free-tier RPS limits (RPC_RPS env, default 8)
// ---------------------------------------------------------------------------

import { ThrottledRpc } from "./free-rpc.ts";

let _rpc: ThrottledRpc | null = null;
function rpc<T = any>(method: string, params: unknown[]): Promise<T> {
  if (!_rpc) _rpc = new ThrottledRpc(HTTP_URL!);
  return _rpc.call<T>(method, params);
}

// ---------------------------------------------------------------------------
// delta engine — pure, testable
// ---------------------------------------------------------------------------

export interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface OwnerDelta {
  owner: string;
  pre: bigint;
  post: bigint;
  delta: bigint; // post - pre
}

/**
 * Aggregate per-OWNER deltas for `mint` from tx meta. An owner can hold
 * several token accounts (ATA + legacy); we sum them. Accounts appearing only
 * in post = created this tx; only in pre = closed this tx.
 */
export function computeOwnerDeltas(
  pre: TokenBalanceEntry[],
  post: TokenBalanceEntry[],
  mint: string,
): OwnerDelta[] {
  const preByOwner = new Map<string, bigint>();
  const postByOwner = new Map<string, bigint>();
  const add = (m: Map<string, bigint>, e: TokenBalanceEntry) => {
    if (e.mint !== mint || !e.owner) return;
    m.set(e.owner, (m.get(e.owner) ?? 0n) + BigInt(e.uiTokenAmount.amount));
  };
  for (const e of pre) add(preByOwner, e);
  for (const e of post) add(postByOwner, e);

  const owners = new Set([...preByOwner.keys(), ...postByOwner.keys()]);
  const out: OwnerDelta[] = [];
  for (const owner of owners) {
    const p = preByOwner.get(owner) ?? 0n;
    const q = postByOwner.get(owner) ?? 0n;
    if (p !== q) out.push({ owner, pre: p, post: q, delta: q - p });
  }
  return out;
}

export type ChangeKind = "trade" | "reconcile" | "snapshot";
export type HolderEventType = "NEW_HOLDER" | "INCREASE" | "DECREASE" | "EXIT";

export function classify(prev: bigint, next: bigint): HolderEventType {
  if (prev === 0n && next > 0n) return "NEW_HOLDER";
  if (next === 0n) return "EXIT";
  return next > prev ? "INCREASE" : "DECREASE";
}

// ---------------------------------------------------------------------------
// store — sqlite: current holders + append-only change log
// ---------------------------------------------------------------------------

export class HolderStore {
  db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS holders (
        owner TEXT PRIMARY KEY,
        balance TEXT NOT NULL,           -- raw amount as decimal string (bigint)
        updated_slot INTEGER NOT NULL,
        first_seen_ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS changes (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        slot INTEGER NOT NULL,
        signature TEXT,
        owner TEXT NOT NULL,
        delta TEXT NOT NULL,
        balance_after TEXT NOT NULL,
        kind TEXT NOT NULL,
        event TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_changes_owner ON changes(owner, ts);
      CREATE INDEX IF NOT EXISTS idx_changes_slot ON changes(slot);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `);
  }

  balance(owner: string): bigint {
    const row = this.db
      .query<{ balance: string }, [string]>(
        "SELECT balance FROM holders WHERE owner = ?",
      )
      .get(owner);
    return row ? BigInt(row.balance) : 0n;
  }

  apply(
    owner: string,
    newBalance: bigint,
    slot: number,
    signature: string | null,
    kind: ChangeKind,
  ): { event: HolderEventType; delta: bigint } | null {
    const prev = this.balance(owner);
    if (prev === newBalance) return null;
    const event = classify(prev, newBalance);
    const now = Date.now();
    const tx = this.db.transaction(() => {
      if (newBalance === 0n) {
        this.db.run("DELETE FROM holders WHERE owner = ?", [owner]);
      } else {
        this.db.run(
          `INSERT INTO holders (owner, balance, updated_slot, first_seen_ts)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(owner) DO UPDATE SET balance = excluded.balance,
             updated_slot = excluded.updated_slot`,
          [owner, newBalance.toString(), slot, now],
        );
      }
      this.db.run(
        `INSERT INTO changes (ts, slot, signature, owner, delta, balance_after, kind, event)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          now,
          slot,
          signature,
          owner,
          (newBalance - prev).toString(),
          newBalance.toString(),
          kind,
          event,
        ],
      );
    });
    tx();
    return { event, delta: newBalance - prev };
  }

  allHolders(): Map<string, bigint> {
    const out = new Map<string, bigint>();
    for (const r of this.db
      .query<{ owner: string; balance: string }, []>(
        "SELECT owner, balance FROM holders",
      )
      .all()) {
      out.set(r.owner, BigInt(r.balance));
    }
    return out;
  }

  top(n: number): { owner: string; balance: bigint }[] {
    // sort in JS: sqlite ORDER BY on TEXT/CAST breaks for supply-scale bigints
    return this.db
      .query<{ owner: string; balance: string }, []>(
        "SELECT owner, balance FROM holders",
      )
      .all()
      .map((r) => ({ owner: r.owner, balance: BigInt(r.balance) }))
      .sort((a, b) =>
        b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0,
      )
      .slice(0, n);
  }

  setMeta(key: string, value: string) {
    this.db.run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  }
  getMeta(key: string): string | null {
    const r = this.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM meta WHERE key = ?",
      )
      .get(key);
    return r?.value ?? null;
  }
}

// ---------------------------------------------------------------------------
// snapshot + reconciliation
// ---------------------------------------------------------------------------

interface SnapshotResult {
  holders: Map<string, bigint>;
  slot: number;
}

let dasUnavailable = false;

/** Preferred on Helius (incl. free tier): indexed, paginated — no token-program scan. */
async function fetchSnapshotDas(mint: string): Promise<SnapshotResult> {
  const holders = new Map<string, bigint>();
  let page = 1;
  while (true) {
    const res = await rpc<{ token_accounts?: any[] }>("getTokenAccounts", [
      { mint, page, limit: 1000, options: { showZeroBalance: false } },
    ]);
    const accounts = res?.token_accounts ?? [];
    for (const a of accounts) {
      const amt = BigInt(a.amount ?? 0);
      if (amt === 0n) continue;
      holders.set(a.owner, (holders.get(a.owner) ?? 0n) + amt);
    }
    if (accounts.length < 1000) break;
    page++;
    if (page > 500) break; // safety valve
  }
  // DAS doesn't return a slot; pin the snapshot to the current slot instead
  const slot = await rpc<number>("getSlot", [
    { commitment: CONFIG.commitment },
  ]);
  return { holders, slot };
}

async function fetchSnapshot(
  mint: string,
  tokenProgram: string,
): Promise<SnapshotResult> {
  if (!dasUnavailable) {
    try {
      return await fetchSnapshotDas(mint);
    } catch (e) {
      dasUnavailable = true; // non-Helius RPC or method disabled — fall back for good
      console.warn(
        "[snapshot] DAS getTokenAccounts unavailable, using getProgramAccounts:",
        (e as Error).message,
      );
    }
  }
  // fallback: memcmp offset 0 = mint field; dataSize 165 = classic layout.
  // Heavy for the RPC — fine at 10-min intervals, but DAS is preferred.
  const filters: unknown[] = [{ memcmp: { offset: 0, bytes: mint } }];
  if (tokenProgram === TOKEN_PROGRAM) filters.unshift({ dataSize: 165 });
  const result = await rpc<
    | {
        context?: { slot: number };
        value?: any[];
      }
    | any[]
  >("getProgramAccounts", [
    tokenProgram,
    {
      encoding: "jsonParsed",
      commitment: CONFIG.commitment,
      filters,
      withContext: true,
    },
  ]);
  const ctx = Array.isArray(result) ? null : result.context;
  const accounts = Array.isArray(result) ? result : (result.value ?? []);
  const holders = new Map<string, bigint>();
  for (const { account } of accounts) {
    const info = account?.data?.parsed?.info;
    if (!info) continue;
    const amt = BigInt(info.tokenAmount.amount);
    if (amt === 0n) continue;
    holders.set(info.owner, (holders.get(info.owner) ?? 0n) + amt);
  }
  return { holders, slot: ctx?.slot ?? 0 };
}

/** Diff authoritative snapshot against local state; returns corrections applied. */
export function reconcile(
  store: HolderStore,
  snapshot: Map<string, bigint>,
  slot: number,
  notify: (
    owner: string,
    event: HolderEventType,
    delta: bigint,
    balance: bigint,
    kind: ChangeKind,
  ) => void,
): number {
  let corrections = 0;
  const local = store.allHolders();
  // owners in snapshot: fix mismatches
  for (const [owner, bal] of snapshot) {
    if ((local.get(owner) ?? 0n) !== bal) {
      const r = store.apply(owner, bal, slot, null, "reconcile");
      if (r) {
        corrections++;
        notify(owner, r.event, r.delta, bal, "reconcile");
      }
    }
    local.delete(owner);
  }
  // owners we track that snapshot says are gone
  for (const owner of local.keys()) {
    const r = store.apply(owner, 0n, slot, null, "reconcile");
    if (r) {
      corrections++;
      notify(owner, r.event, r.delta, 0n, "reconcile");
    }
  }
  return corrections;
}

// ---------------------------------------------------------------------------
// LRU signature dedupe
// ---------------------------------------------------------------------------

class LruSet {
  #set = new Set<string>();
  constructor(private cap: number) {}
  addIfNew(key: string): boolean {
    if (this.#set.has(key)) return false;
    this.#set.add(key);
    if (this.#set.size > this.cap)
      this.#set.delete(this.#set.values().next().value!);
    return true;
  }
}

// ---------------------------------------------------------------------------
// realtime feed (both modes)
// ---------------------------------------------------------------------------

type MetaHandler = (
  meta: {
    preTokenBalances: TokenBalanceEntry[];
    postTokenBalances: TokenBalanceEntry[];
  },
  signature: string,
  slot: number,
) => void;

class Feed {
  #ws: WebSocket | null = null;
  #attempt = 0;
  #ping: ReturnType<typeof setInterval> | null = null;
  #sigLru = new LruSet(CONFIG.sigLruSize);
  #stopped = false;
  #id = 1;

  constructor(
    private mint: string,
    private onMeta: MetaHandler,
  ) {}

  start() {
    this.#connect();
  }
  stop() {
    this.#stopped = true;
    if (this.#ping) clearInterval(this.#ping);
    this.#ws?.close();
  }

  get #url() {
    return CONFIG.mode === "enhanced" ? ENHANCED_WS_URL! : WS_URL!;
  }

  #connect() {
    if (this.#stopped) return;
    console.log(
      `[feed] connecting mode=${CONFIG.mode} (attempt ${this.#attempt + 1})`,
    );
    const ws = new WebSocket(this.#url);
    this.#ws = ws;

    ws.onopen = () => {
      this.#attempt = 0;
      this.#subscribe();
      this.#startPing();
      console.log(`[feed] open — watching mint ${this.mint}`);
    };
    ws.onmessage = (m) => void this.#handle(String(m.data));
    ws.onerror = (e) =>
      console.error("[feed] error:", (e as any)?.message ?? e);
    ws.onclose = () => {
      if (this.#ping) clearInterval(this.#ping);
      if (this.#stopped) return;
      const d = Math.min(
        CONFIG.backoffBaseMs * 2 ** this.#attempt,
        CONFIG.backoffMaxMs,
      );
      const j = d / 2 + Math.random() * (d / 2);
      this.#attempt++;
      console.warn(
        `[feed] closed — reconnect in ${Math.round(j)}ms (snapshot will repair any gap)`,
      );
      setTimeout(() => this.#connect(), j);
    };
  }

  #subscribe() {
    const msg =
      CONFIG.mode === "enhanced"
        ? {
            jsonrpc: "2.0",
            id: this.#id++,
            method: "transactionSubscribe",
            params: [
              { accountInclude: [this.mint], failed: false, vote: false },
              {
                commitment: CONFIG.commitment,
                encoding: "jsonParsed",
                transactionDetails: "full",
                maxSupportedTransactionVersion: 0,
              },
            ],
          }
        : {
            jsonrpc: "2.0",
            id: this.#id++,
            method: "logsSubscribe",
            params: [
              { mentions: [this.mint] },
              { commitment: CONFIG.commitment },
            ],
          };
    this.#ws!.send(JSON.stringify(msg));
  }

  #startPing() {
    this.#ping = setInterval(() => {
      try {
        this.#ws?.send(
          JSON.stringify({ jsonrpc: "2.0", id: this.#id++, method: "ping" }),
        );
      } catch {}
    }, CONFIG.pingIntervalMs);
  }

  async #handle(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.method === "transactionNotification") {
      const r = msg.params.result;
      const signature: string = r.signature;
      if (!this.#sigLru.addIfNew(signature)) return;
      const meta = r.transaction?.meta;
      if (!meta) return;
      this.onMeta(meta, signature, r.slot ?? 0);
      return;
    }

    if (msg.method === "logsNotification") {
      const { value, context } = msg.params.result;
      if (value.err !== null) return;
      if (!this.#sigLru.addIfNew(value.signature)) return;
      // free tier: one targeted round-trip per mint-touching tx
      try {
        const tx = await rpc<any>("getTransaction", [
          value.signature,
          {
            encoding: "jsonParsed",
            commitment: CONFIG.commitment,
            maxSupportedTransactionVersion: 0,
          },
        ]);
        if (tx?.meta)
          this.onMeta(tx.meta, value.signature, tx.slot ?? context.slot);
      } catch (e) {
        console.error(
          `[feed] getTransaction ${value.signature} failed (reconcile will cover):`,
          e,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// formatting + entry
// ---------------------------------------------------------------------------

function ui(amount: bigint, decimals: number): string {
  const neg = amount < 0n;
  const a = neg ? -amount : amount;
  const d = 10n ** BigInt(decimals);
  const whole = a / d;
  const frac = (a % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

if (import.meta.main) {
  if (!MINT) {
    console.error("usage: bun holder-tracker.ts <MINT>");
    process.exit(1);
  }
  if (!HTTP_URL || (CONFIG.mode === "enhanced" ? !ENHANCED_WS_URL : !WS_URL)) {
    console.error(
      "Set HELIUS_API_KEY, or RPC_HTTP_URL + RPC_WS_URL (with MODE=logs)",
    );
    process.exit(1);
  }

  const store = new HolderStore(
    process.env.DB_PATH ?? `holders-${MINT.slice(0, 8)}.db`,
  );

  // resolve decimals + supply + owning token program once
  const mintInfo = await rpc<any>("getAccountInfo", [
    MINT,
    { encoding: "jsonParsed" },
  ]);
  if (!mintInfo?.value) {
    console.error("mint not found");
    process.exit(1);
  }
  const tokenProgram: string =
    mintInfo.value.owner === TOKEN_2022 ? TOKEN_2022 : TOKEN_PROGRAM;
  const decimals: number = mintInfo.value.data.parsed.info.decimals;
  const supply = BigInt(mintInfo.value.data.parsed.info.supply);
  store.setMeta("decimals", String(decimals));
  console.log(
    `[init] mint=${MINT} program=${tokenProgram === TOKEN_2022 ? "token-2022" : "spl-token"} decimals=${decimals} supply=${ui(supply, decimals)}`,
  );

  const notify = (
    owner: string,
    event: HolderEventType,
    delta: bigint,
    balance: bigint,
    kind: ChangeKind,
    signature?: string,
  ) => {
    const uiDelta = Math.abs(Number(ui(delta, decimals)));
    if (kind === "trade" && uiDelta < CONFIG.minNotifyUi) return;
    const pct = supply > 0n ? Number((balance * 10_000n) / supply) / 100 : 0;
    const icon =
      event === "NEW_HOLDER"
        ? "🟢"
        : event === "EXIT"
          ? "🔴"
          : event === "INCREASE"
            ? "📈"
            : "📉";
    console.log(
      `${icon} ${event.padEnd(10)} ${owner}  Δ${ui(delta, decimals)}  → ${ui(balance, decimals)} (${pct.toFixed(2)}%)` +
        (kind === "reconcile" ? "  [reconcile]" : "") +
        (signature ? `  ${signature.slice(0, 16)}…` : ""),
    );
    // telegram / dao-reward hooks plug in here
  };

  // 1) authoritative baseline
  console.log("[snapshot] fetching full holder set…");
  const snap = await fetchSnapshot(MINT, tokenProgram);
  console.log(`[snapshot] ${snap.holders.size} holders at slot ${snap.slot}`);
  const isFirstRun = store.allHolders().size === 0;
  const fixed = reconcile(store, snap.holders, snap.slot, (o, e, d, b, k) => {
    if (!isFirstRun) notify(o, e, d, b, k); // don't spam NEW_HOLDER x N on first run
  });
  console.log(
    isFirstRun
      ? `[snapshot] baseline stored (${snap.holders.size} holders)`
      : `[reconcile] ${fixed} corrections`,
  );

  // 2) realtime deltas
  const feed = new Feed(MINT, (meta, signature, slot) => {
    const deltas = computeOwnerDeltas(
      meta.preTokenBalances ?? [],
      meta.postTokenBalances ?? [],
      MINT,
    );
    for (const d of deltas) {
      const r = store.apply(d.owner, d.post, slot, signature, "trade");
      if (r) notify(d.owner, r.event, r.delta, d.post, "trade", signature);
    }
  });
  feed.start();

  // 3) periodic authoritative repair + distribution report
  setInterval(async () => {
    try {
      const s = await fetchSnapshot(MINT, tokenProgram);
      const n = reconcile(store, s.holders, s.slot, notify);
      const top = store.top(10);
      const top10 = top.reduce((a, h) => a + h.balance, 0n);
      const share = supply > 0n ? Number((top10 * 10_000n) / supply) / 100 : 0;
      console.log(
        `[reconcile] ${n} corrections | holders=${s.holders.size} | top10 hold ${share.toFixed(2)}%`,
      );
    } catch (e) {
      console.error("[reconcile] snapshot failed:", e);
    }
  }, CONFIG.reconcileMs);

  process.on("SIGINT", () => {
    feed.stop();
    process.exit(0);
  });
}
