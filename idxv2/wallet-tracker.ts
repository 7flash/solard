// wallet-tracker.ts — Case 4: watch a wallet or group of wallets, all trades
// across all tokens. Copy-trading feed + PnL ledger.
//
// Architecture:
//   REALTIME   enhanced: one transactionSubscribe with
//              accountInclude=[w1..wN], failed:false — one subscription covers
//              the whole group, meta pushed (no round-trip on the copy leg).
//              free: one logsSubscribe(mentions=[wallet]) PER wallet (the
//              method takes exactly one address) + getTransaction round-trip.
//   GAP-FILL   per-wallet getSignaturesForAddress with until=<last seen sig>,
//              run at startup and on every reconnect. Wallets are low-volume,
//              so cursor paging is cheap — this is the case where pull-based
//              repair genuinely works (unlike a program firehose).
//   CLASSIFY   pure balance-delta analysis (never instruction parsing):
//              SOL delta from pre/postBalances + wSOL token delta folded in,
//              token deltas from pre/postTokenBalances by owner.
//              → BUY / SELL / SWAP / TRANSFER_IN / TRANSFER_OUT / SOL_TRANSFER
//   PNL        average-cost ledger per (wallet, mint) in bun:sqlite.
//              BUY adds qty+cost, SELL realizes proceeds − avg cost,
//              TRANSFER_IN arrives at zero basis, TRANSFER_OUT carries basis
//              out without realizing. Trades table = full activity log.
//
// Run:  HELIUS_API_KEY=... bun wallet-tracker.ts <WALLET> [WALLET2 ...]
//       MODE=logs RPC_HTTP_URL=... RPC_WS_URL=... bun wallet-tracker.ts <W1> <W2>
// Env:  DB_PATH=wallets.db  BACKFILL_LIMIT=200 (txs per wallet on first run)

import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const WALLETS = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const WSOL = "So11111111111111111111111111111111111111112";

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
  commitment: "confirmed" as const,
  pingIntervalMs: 25_000,
  backoffBaseMs: 500,
  backoffMaxMs: 20_000,
  backfillLimit: Number(process.env.BACKFILL_LIMIT ?? 200), // first-run history depth
  gapFillPageSize: 1000,
  // |sol delta| at or below fee + this is treated as "no SOL leg" (ATA rent etc.)
  rentEpsilonLamports: 3_000_000n, // ~0.003 SOL covers ATA creation (2_039_280) + margin
};

// ---------------------------------------------------------------------------
// rpc — throttled for free-tier RPS limits (RPC_RPS env, default 8)
// ---------------------------------------------------------------------------

import { ThrottledRpc, MuxWs } from "./free-rpc";

let _rpc: ThrottledRpc | null = null;
function rpc<T = any>(method: string, params: unknown[]): Promise<T> {
  if (!_rpc) _rpc = new ThrottledRpc(HTTP_URL!);
  return _rpc.call<T>(method, params);
}

// ---------------------------------------------------------------------------
// classification — pure, testable
// ---------------------------------------------------------------------------

export interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface TxMetaLike {
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: TokenBalanceEntry[];
  postTokenBalances: TokenBalanceEntry[];
}

export type ActivityKind =
  | "BUY"
  | "SELL"
  | "SWAP" // token → token
  | "TRANSFER_IN"
  | "TRANSFER_OUT"
  | "SOL_TRANSFER"
  | "NONE";

export interface TokenLeg {
  mint: string;
  delta: bigint; // raw units
  decimals: number;
}

export interface WalletActivity {
  wallet: string;
  kind: ActivityKind;
  /** SOL delta incl. folded wSOL, incl. fee if wallet was fee payer (lamports) */
  solDelta: bigint;
  feePaid: bigint; // 0n unless wallet is fee payer
  legs: TokenLeg[]; // non-wSOL token deltas
  /** lamports per whole token, cost-inclusive — set for BUY/SELL single-leg */
  priceLamportsPerToken?: number;
}

function tokenDeltasForOwner(
  meta: TxMetaLike,
  owner: string,
): Map<string, { delta: bigint; decimals: number }> {
  const acc = new Map<
    string,
    { pre: bigint; post: bigint; decimals: number }
  >();
  const touch = (e: TokenBalanceEntry, side: "pre" | "post") => {
    if (e.owner !== owner) return;
    const cur = acc.get(e.mint) ?? {
      pre: 0n,
      post: 0n,
      decimals: e.uiTokenAmount.decimals,
    };
    cur[side] += BigInt(e.uiTokenAmount.amount);
    acc.set(e.mint, cur);
  };
  for (const e of meta.preTokenBalances ?? []) touch(e, "pre");
  for (const e of meta.postTokenBalances ?? []) touch(e, "post");
  const out = new Map<string, { delta: bigint; decimals: number }>();
  for (const [mint, v] of acc) {
    const d = v.post - v.pre;
    if (d !== 0n) out.set(mint, { delta: d, decimals: v.decimals });
  }
  return out;
}

/**
 * Classify what `wallet` did in this tx from balance deltas alone.
 * accountKeys: base58 pubkeys in tx order (index-aligned with pre/postBalances);
 * accountKeys[0] is the fee payer.
 */
export function classifyActivity(
  meta: TxMetaLike,
  accountKeys: string[],
  wallet: string,
): WalletActivity {
  const idx = accountKeys.indexOf(wallet);
  const nativeDelta =
    idx >= 0
      ? BigInt(meta.postBalances[idx]) - BigInt(meta.preBalances[idx])
      : 0n;
  const feePaid = accountKeys[0] === wallet ? BigInt(meta.fee) : 0n;

  const tokenDeltas = tokenDeltasForOwner(meta, wallet);
  const wsol = tokenDeltas.get(WSOL)?.delta ?? 0n;
  tokenDeltas.delete(WSOL);

  // effective SOL movement: native + wrapped folded together
  const solDelta = nativeDelta + wsol;
  const legs: TokenLeg[] = [...tokenDeltas.entries()].map(([mint, v]) => ({
    mint,
    delta: v.delta,
    decimals: v.decimals,
  }));

  const up = legs.filter((l) => l.delta > 0n);
  const down = legs.filter((l) => l.delta < 0n);
  const solNoise = feePaid + CONFIG.rentEpsilonLamports;
  const solMeaningful = solDelta < -solNoise || solDelta > 0n;

  let kind: ActivityKind;
  if (legs.length === 0) {
    kind =
      solDelta !== 0n && (solDelta > 0n || -solDelta > feePaid)
        ? "SOL_TRANSFER"
        : "NONE";
  } else if (up.length > 0 && down.length > 0) {
    kind = "SWAP";
  } else if (up.length > 0) {
    kind = solDelta < -solNoise ? "BUY" : "TRANSFER_IN";
  } else {
    kind = solDelta > 0n ? "SELL" : "TRANSFER_OUT";
  }

  const activity: WalletActivity = { wallet, kind, solDelta, feePaid, legs };

  if ((kind === "BUY" || kind === "SELL") && legs.length === 1) {
    const qty = legs[0].delta < 0n ? -legs[0].delta : legs[0].delta;
    if (qty > 0n) {
      const lamports = solDelta < 0n ? -solDelta : solDelta;
      activity.priceLamportsPerToken =
        Number(lamports) / (Number(qty) / 10 ** legs[0].decimals);
    }
  }
  void solMeaningful;
  return activity;
}

// ---------------------------------------------------------------------------
// PnL ledger — average cost, pure over sqlite
// ---------------------------------------------------------------------------

export class Ledger {
  db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS positions (
        wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        qty TEXT NOT NULL,            -- raw units, bigint string
        cost_lamports TEXT NOT NULL,  -- total basis for qty
        decimals INTEGER NOT NULL,
        realized_lamports TEXT NOT NULL DEFAULT '0',
        PRIMARY KEY (wallet, mint)
      );
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        slot INTEGER NOT NULL,
        signature TEXT NOT NULL,
        wallet TEXT NOT NULL,
        kind TEXT NOT NULL,
        mint TEXT,
        token_delta TEXT,
        sol_delta TEXT NOT NULL,
        realized_lamports TEXT,
        UNIQUE (signature, wallet, mint)
      );
      CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades(wallet, ts);
      CREATE TABLE IF NOT EXISTS cursors (
        wallet TEXT PRIMARY KEY,
        last_signature TEXT NOT NULL,
        last_slot INTEGER NOT NULL
      );
    `);
  }

  hasTx(signature: string, wallet: string): boolean {
    return !!this.db
      .query("SELECT 1 FROM trades WHERE signature = ? AND wallet = ? LIMIT 1")
      .get(signature, wallet);
  }

  position(wallet: string, mint: string) {
    const r = this.db
      .query<
        {
          qty: string;
          cost_lamports: string;
          realized_lamports: string;
          decimals: number;
        },
        [string, string]
      >(
        "SELECT qty, cost_lamports, realized_lamports, decimals FROM positions WHERE wallet = ? AND mint = ?",
      )
      .get(wallet, mint);
    return r
      ? {
          qty: BigInt(r.qty),
          cost: BigInt(r.cost_lamports),
          realized: BigInt(r.realized_lamports),
          decimals: r.decimals,
        }
      : { qty: 0n, cost: 0n, realized: 0n, decimals: 0 };
  }

  /**
   * Apply one classified activity. Returns realized PnL in lamports for SELLs.
   * Average-cost method:
   *   BUY: qty += q, cost += spent
   *   SELL: costOut = cost * q / qty; realized += proceeds - costOut
   *   TRANSFER_IN: qty += q at zero basis (airdrops/deposits — conservative)
   *   TRANSFER_OUT: qty -= q, cost reduced pro-rata (basis leaves, no PnL event)
   *   SWAP: treated as TRANSFER_OUT of leg A + TRANSFER_IN of leg B at the
   *         basis carried over (token-token swaps keep SOL-denominated basis).
   */
  apply(
    a: WalletActivity,
    ctx: { signature: string; slot: number; ts?: number },
  ): bigint | null {
    const ts = ctx.ts ?? Date.now();
    let realizedTotal: bigint | null = null;

    const upsert = (
      wallet: string,
      mint: string,
      qty: bigint,
      cost: bigint,
      realized: bigint,
      decimals: number,
    ) => {
      if (qty <= 0n && realized === 0n && cost === 0n) {
        // keep row if realized history exists
        const cur = this.position(wallet, mint);
        if (cur.realized === 0n) {
          this.db.run("DELETE FROM positions WHERE wallet = ? AND mint = ?", [
            wallet,
            mint,
          ]);
          return;
        }
      }
      this.db.run(
        `INSERT INTO positions (wallet, mint, qty, cost_lamports, decimals, realized_lamports)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(wallet, mint) DO UPDATE SET
           qty = excluded.qty, cost_lamports = excluded.cost_lamports,
           decimals = excluded.decimals, realized_lamports = excluded.realized_lamports`,
        [
          wallet,
          mint,
          qty.toString(),
          cost.toString(),
          decimals,
          realized.toString(),
        ],
      );
    };

    const record = (
      mint: string | null,
      tokenDelta: bigint | null,
      realized: bigint | null,
    ) => {
      this.db.run(
        `INSERT OR IGNORE INTO trades (ts, slot, signature, wallet, kind, mint, token_delta, sol_delta, realized_lamports)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ts,
          ctx.slot,
          ctx.signature,
          a.wallet,
          a.kind,
          mint,
          tokenDelta?.toString() ?? null,
          a.solDelta.toString(),
          realized?.toString() ?? null,
        ],
      );
    };

    const txn = this.db.transaction(() => {
      if (a.legs.length === 0) {
        record(null, null, null);
        return;
      }
      for (const leg of a.legs) {
        const p = this.position(a.wallet, leg.mint);
        let { qty, cost, realized } = p;
        let legRealized: bigint | null = null;

        if (leg.delta > 0n) {
          // acquiring: BUY carries SOL cost; TRANSFER_IN / SWAP-in at zero basis
          const spent = a.kind === "BUY" && a.solDelta < 0n ? -a.solDelta : 0n;
          qty += leg.delta;
          cost += spent;
        } else {
          const q = -leg.delta;
          const sellQty = q > qty ? qty : q; // clamp: basis unknown for excess
          const costOut = qty > 0n ? (cost * sellQty) / qty : 0n;
          if (a.kind === "SELL") {
            // proceeds attributed to this leg (single-leg by classification)
            const proceeds = a.solDelta > 0n ? a.solDelta : 0n;
            legRealized = proceeds - costOut;
            realized += legRealized;
            realizedTotal = (realizedTotal ?? 0n) + legRealized;
          }
          qty -= sellQty;
          cost -= costOut;
          if (qty === 0n) cost = 0n;
        }
        upsert(
          a.wallet,
          leg.mint,
          qty,
          cost,
          realized,
          leg.decimals || p.decimals,
        );
        record(leg.mint, leg.delta, legRealized);
      }
    });
    txn();
    return realizedTotal;
  }

  cursor(wallet: string): string | null {
    const r = this.db
      .query<{ last_signature: string }, [string]>(
        "SELECT last_signature FROM cursors WHERE wallet = ?",
      )
      .get(wallet);
    return r?.last_signature ?? null;
  }
  setCursor(wallet: string, signature: string, slot: number) {
    this.db.run(
      `INSERT INTO cursors (wallet, last_signature, last_slot) VALUES (?, ?, ?)
       ON CONFLICT(wallet) DO UPDATE SET last_signature = excluded.last_signature, last_slot = excluded.last_slot`,
      [wallet, signature, slot],
    );
  }

  pnlSummary(wallet: string) {
    return this.db
      .query<
        {
          mint: string;
          qty: string;
          cost_lamports: string;
          realized_lamports: string;
          decimals: number;
        },
        [string]
      >(
        "SELECT mint, qty, cost_lamports, realized_lamports, decimals FROM positions WHERE wallet = ?",
      )
      .all(wallet);
  }
}

// ---------------------------------------------------------------------------
// tx plumbing: normalize a getTransaction/transactionSubscribe payload
// ---------------------------------------------------------------------------

function accountKeysOf(txMsg: any): string[] {
  const keys = txMsg?.accountKeys ?? [];
  return keys.map((k: any) => (typeof k === "string" ? k : k.pubkey));
}

function processTx(
  ledger: Ledger,
  wallets: string[],
  tx: {
    meta: TxMetaLike;
    msg: any;
    signature: string;
    slot: number;
    blockTime?: number;
  },
  onActivity: (a: WalletActivity, realized: bigint | null, sig: string) => void,
) {
  const keys = accountKeysOf(tx.msg);
  for (const wallet of wallets) {
    // wallet may be involved only via its token accounts (owner field), so
    // check both the key list and token balance owners
    const inKeys = keys.includes(wallet);
    const inTokens = [
      ...(tx.meta.preTokenBalances ?? []),
      ...(tx.meta.postTokenBalances ?? []),
    ].some((e) => e.owner === wallet);
    if (!inKeys && !inTokens) continue;
    if (ledger.hasTx(tx.signature, wallet)) continue; // gap-fill/live overlap guard
    const a = classifyActivity(tx.meta, keys, wallet);
    if (a.kind === "NONE") continue;
    const realized = ledger.apply(a, {
      signature: tx.signature,
      slot: tx.slot,
      ts: tx.blockTime ? tx.blockTime * 1000 : undefined,
    });
    ledger.setCursor(wallet, tx.signature, tx.slot);
    onActivity(a, realized, tx.signature);
  }
}

// ---------------------------------------------------------------------------
// gap-fill: getSignaturesForAddress with until-cursor, oldest-first apply
// ---------------------------------------------------------------------------

async function gapFill(
  ledger: Ledger,
  wallet: string,
  allWallets: string[],
  onActivity: (a: WalletActivity, realized: bigint | null, sig: string) => void,
) {
  const until = ledger.cursor(wallet);
  const sigs: { signature: string; slot: number }[] = [];
  let before: string | undefined;

  while (true) {
    const page = await rpc<any[]>("getSignaturesForAddress", [
      wallet,
      {
        limit: until
          ? CONFIG.gapFillPageSize
          : Math.min(CONFIG.backfillLimit, 1000),
        commitment: CONFIG.commitment,
        ...(until ? { until } : {}),
        ...(before ? { before } : {}),
      },
    ]);
    for (const s of page)
      if (!s.err) sigs.push({ signature: s.signature, slot: s.slot });
    if (
      page.length < CONFIG.gapFillPageSize ||
      (!until && sigs.length >= CONFIG.backfillLimit)
    )
      break;
    if (page.length === 0) break;
    before = page[page.length - 1].signature;
    if (sigs.length > 20_000) {
      console.warn(`[gapfill] ${wallet}: >20k txs behind cursor, truncating`);
      break;
    }
  }
  if (sigs.length === 0) return 0;

  sigs.reverse(); // oldest first — ledger order matters for avg cost
  let applied = 0;
  for (const { signature } of sigs) {
    try {
      const tx = await rpc<any>("getTransaction", [
        signature,
        {
          encoding: "jsonParsed",
          commitment: CONFIG.commitment,
          maxSupportedTransactionVersion: 0,
        },
      ]);
      if (!tx?.meta || tx.meta.err) continue;
      processTx(
        ledger,
        allWallets,
        {
          meta: tx.meta,
          msg: tx.transaction.message,
          signature,
          slot: tx.slot,
          blockTime: tx.blockTime ?? undefined,
        },
        onActivity,
      );
      applied++;
    } catch (e) {
      console.error(`[gapfill] getTransaction ${signature}:`, e);
    }
  }
  return applied;
}

// ---------------------------------------------------------------------------
// realtime feed
// ---------------------------------------------------------------------------

class Feed {
  #ws: WebSocket | null = null; // enhanced mode only
  #mux: MuxWs | null = null; // logs (free) mode: ONE socket, N subscriptions
  #attempt = 0;
  #ping: ReturnType<typeof setInterval> | null = null;
  #stopped = false;
  #id = 1;
  // two watched wallets can share a tx → same signature arrives on two
  // logs subscriptions; fetch it once (processTx already fans out per wallet)
  #inFlight = new Set<string>();

  constructor(
    private wallets: string[],
    private onTx: (tx: {
      meta: TxMetaLike;
      msg: any;
      signature: string;
      slot: number;
    }) => void,
    private onReconnect: () => void,
  ) {}

  start() {
    if (CONFIG.mode === "enhanced") this.#connectEnhanced();
    else this.#startMux();
  }
  stop() {
    this.#stopped = true;
    if (this.#ping) clearInterval(this.#ping);
    this.#ws?.close();
    this.#mux?.stop();
  }

  // -- free mode: all wallets multiplexed on a single connection ------------

  #startMux() {
    const mux = new MuxWs(WS_URL!, {
      pingIntervalMs: CONFIG.pingIntervalMs,
      backoffBaseMs: CONFIG.backoffBaseMs,
      backoffMaxMs: CONFIG.backoffMaxMs,
    });
    this.#mux = mux;
    mux.onReconnect = () => this.onReconnect(); // cursor gap-fill repairs the drop
    for (const wallet of this.wallets) {
      mux.subscribe(
        `wallet:${wallet}`,
        "logsSubscribe",
        [{ mentions: [wallet] }, { commitment: CONFIG.commitment }],
        (result) => void this.#onLog(result),
      );
    }
    mux.start();
  }

  async #onLog(result: { value: { signature: string; err: unknown } }) {
    const { value } = result;
    if (value.err !== null) return;
    if (this.#inFlight.has(value.signature)) return;
    this.#inFlight.add(value.signature);
    try {
      const tx = await rpc<any>("getTransaction", [
        value.signature,
        {
          encoding: "jsonParsed",
          commitment: CONFIG.commitment,
          maxSupportedTransactionVersion: 0,
        },
      ]);
      if (!tx?.meta) return;
      this.onTx({
        meta: tx.meta,
        msg: tx.transaction.message,
        signature: value.signature,
        slot: tx.slot,
      });
    } catch (e) {
      console.error(
        `[feed] getTransaction ${value.signature} (gap-fill will cover):`,
        e,
      );
    } finally {
      // keep briefly to absorb the sibling subscription's duplicate, then free
      setTimeout(() => this.#inFlight.delete(value.signature), 30_000);
    }
  }

  // -- enhanced mode (unchanged): one transactionSubscribe for the group ----

  #connectEnhanced() {
    if (this.#stopped) return;
    const ws = new WebSocket(ENHANCED_WS_URL!);
    this.#ws = ws;

    ws.onopen = () => {
      this.#attempt = 0;
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: this.#id++,
          method: "transactionSubscribe",
          params: [
            { accountInclude: this.wallets, failed: false, vote: false },
            {
              commitment: CONFIG.commitment,
              encoding: "jsonParsed",
              transactionDetails: "full",
              maxSupportedTransactionVersion: 0,
            },
          ],
        }),
      );
      this.#ping = setInterval(() => {
        try {
          ws.send(
            JSON.stringify({ jsonrpc: "2.0", id: this.#id++, method: "ping" }),
          );
        } catch {}
      }, CONFIG.pingIntervalMs);
      console.log("[feed:enhanced] open");
    };

    ws.onmessage = (m) => {
      let msg: any;
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (msg.method !== "transactionNotification") return;
      const r = msg.params.result;
      if (!r.transaction?.meta) return;
      this.onTx({
        meta: r.transaction.meta,
        msg: r.transaction.transaction.message,
        signature: r.signature,
        slot: r.slot ?? 0,
      });
    };

    ws.onerror = (e) =>
      console.error("[feed:enhanced]", (e as any)?.message ?? e);
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
        `[feed:enhanced] closed — reconnect in ${Math.round(j)}ms + gap-fill`,
      );
      setTimeout(() => {
        this.#connectEnhanced();
        this.onReconnect();
      }, j);
    };
  }
}

// ---------------------------------------------------------------------------
// formatting + entry
// ---------------------------------------------------------------------------

const SOL = (l: bigint) => `${(Number(l) / 1e9).toFixed(4)} SOL`;
const uiAmt = (raw: bigint, dec: number) =>
  (Number(raw < 0n ? -raw : raw) / 10 ** dec).toLocaleString();

if (import.meta.main) {
  if (WALLETS.length === 0) {
    console.error("usage: bun wallet-tracker.ts <WALLET> [WALLET2 ...]");
    process.exit(1);
  }
  if (!HTTP_URL) {
    console.error(
      "Set HELIUS_API_KEY or RPC_HTTP_URL (+ RPC_WS_URL, MODE=logs)",
    );
    process.exit(1);
  }

  const ledger = new Ledger(process.env.DB_PATH ?? "wallets.db");

  const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
  const onActivity = (
    a: WalletActivity,
    realized: bigint | null,
    sig: string,
  ) => {
    const icon =
      a.kind === "BUY"
        ? "🟩"
        : a.kind === "SELL"
          ? "🟥"
          : a.kind === "SWAP"
            ? "🔄"
            : a.kind === "TRANSFER_IN"
              ? "⬅️"
              : a.kind === "TRANSFER_OUT"
                ? "➡️"
                : "◽";
    const legStr = a.legs
      .map(
        (l) =>
          `${l.delta > 0n ? "+" : "-"}${uiAmt(l.delta, l.decimals)} ${short(l.mint)}`,
      )
      .join(", ");
    console.log(
      `${icon} ${short(a.wallet)} ${a.kind.padEnd(12)} ${legStr || SOL(a.solDelta)}` +
        (a.kind === "BUY" || a.kind === "SELL"
          ? `  for ${SOL(a.solDelta < 0n ? -a.solDelta : a.solDelta)}`
          : "") +
        (realized !== null
          ? `  realized ${realized >= 0n ? "+" : ""}${SOL(realized)}`
          : "") +
        `  ${sig.slice(0, 12)}…`,
    );
    // copy-trade hook: on BUY, evaluate + mirror here. Enhanced mode delivers
    // meta directly, so this fires with zero extra round-trips on the hot path.
  };

  // 1) cold-start backfill / gap-fill from cursors
  for (const w of WALLETS) {
    const n = await gapFill(ledger, w, WALLETS, onActivity);
    console.log(`[gapfill] ${short(w)}: ${n} txs applied`);
  }

  // 2) realtime
  const feed = new Feed(
    WALLETS,
    (tx) => processTx(ledger, WALLETS, tx, onActivity),
    () => {
      // reconnect → repair the gap for every wallet from its cursor
      for (const w of WALLETS) void gapFill(ledger, w, WALLETS, onActivity);
    },
  );
  feed.start();

  // 3) periodic PnL summary
  setInterval(() => {
    for (const w of WALLETS) {
      const rows = ledger.pnlSummary(w);
      if (rows.length === 0) continue;
      const realized = rows.reduce(
        (a, r) => a + BigInt(r.realized_lamports),
        0n,
      );
      console.log(
        `[pnl] ${short(w)}: ${rows.length} positions, realized ${realized >= 0n ? "+" : ""}${SOL(realized)}`,
      );
    }
  }, 60_000);

  process.on("SIGINT", () => {
    feed.stop();
    process.exit(0);
  });
}
