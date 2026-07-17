// Unified realtime Pump monitor
//
// - Auto-detects every new create / create_v2
// - Tracks holders for those mints (can drop any mint at runtime)
// - Tracks specific wallets (add / remove at runtime)
// - Single Portal subscription, hot stream, no DB
//
// Usage:
//   bun run sqd/pump-monitor.ts
//
// Runtime commands (type into stdin):
//   status                     show watched mints + wallets
//   mints                      list watched mints
//   wallets                    list watched wallets
//   drop <mint>                stop tracking a mint
//   dropall                    stop tracking all mints
//   watch <wallet>             start tracking a wallet
//   unwatch <wallet>           stop tracking a wallet
//   help
//
// Env:
//   LOOKBACK_SLOTS=400
//   REORG_DEPTH=48
//   PORTAL_URL=...
import * as readline from "node:readline";
import {
  getPortalHead,
  measure,
  type PortalBlock,
  type PortalQuery,
  type PortalTokenBalance,
  runPortal,
  transactionMap,
} from "./shared/portal.js";

// ---------------------------------------------------------------------------
// Pump constants
// ---------------------------------------------------------------------------
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const CREATE_D8 = "0x181ec828051c0777";
const CREATE_V2_D8 = "0xd6904cec5f8b31b4";
const CREATE_DISC = Uint8Array.from([
  0x18, 0x1e, 0xc8, 0x28, 0x05, 0x1c, 0x07, 0x77,
]);
const CREATE_V2_DISC = Uint8Array.from([
  0xd6, 0x90, 0x4c, 0xec, 0x5f, 0x8b, 0x31, 0xb4,
]);

const CREATE_LAYOUT = {
  create: { mint: 0, bondingCurve: 2, user: 7, minAccounts: 14 },
  create_v2: { mint: 0, bondingCurve: 2, user: 5, minAccounts: 16 },
} as const;

// ---------------------------------------------------------------------------
// Minimal base58 + borsh
// ---------------------------------------------------------------------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58].map((c, i) => [c, i]));

function base58Decode(value: string): Uint8Array {
  if (!value) return new Uint8Array();
  let leading = 0;
  while (leading < value.length && value[leading] === "1") leading++;
  const bytes: number[] = [];
  for (let i = leading; i < value.length; i++) {
    let carry = B58_INDEX.get(value[i]!) ?? -1;
    if (carry < 0) throw new Error("bad base58");
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(leading + bytes.length);
  for (let i = 0; i < leading; i++) out[i] = 0;
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i]!;
  return out;
}

function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let s = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) s += B58[digits[i]!];
  return s;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function createKind(data: Uint8Array): "create" | "create_v2" | null {
  if (data.length < 8) return null;
  const d = data.subarray(0, 8);
  if (equalBytes(d, CREATE_DISC)) return "create";
  if (equalBytes(d, CREATE_V2_DISC)) return "create_v2";
  return null;
}

class Reader {
  #o: number;
  #v: DataView;
  constructor(
    readonly data: Uint8Array,
    o = 0,
  ) {
    this.#o = o;
    this.#v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  get rem() {
    return this.data.length - this.#o;
  }
  bytes(n: number) {
    if (this.rem < n) throw new Error("underrun");
    const s = this.data.subarray(this.#o, this.#o + n);
    this.#o += n;
    return s;
  }
  u32() {
    if (this.rem < 4) throw new Error("underrun");
    const v = this.#v.getUint32(this.#o, true);
    this.#o += 4;
    return v;
  }
  string() {
    const len = this.u32();
    if (len > 1_000_000) throw new Error("bad string");
    return new TextDecoder().decode(this.bytes(len));
  }
  pubkey() {
    return base58Encode(this.bytes(32));
  }
  bool() {
    const v = this.bytes(1)[0]!;
    if (v !== 0 && v !== 1) throw new Error("bad bool");
    return v === 1;
  }
}

function decodeArgs(data: Uint8Array) {
  const kind = createKind(data);
  if (!kind) return null;
  try {
    const r = new Reader(data, 8);
    const name = r.string();
    const symbol = r.string();
    const uri = r.string();
    let creator: string | undefined;
    if (r.rem >= 32) creator = r.pubkey();
    let isMayhemMode: boolean | undefined;
    if (kind === "create_v2" && r.rem >= 1) isMayhemMode = r.bool();
    return { kind, name, symbol, uri, creator, isMayhemMode };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const watchedMints = new Set<string>(); // auto + kept until dropped
const watchedWallets = new Set<string>(); // explicit only
const balances = new Map<string, bigint>(); // "m:mint:owner" | "w:owner:mint" → amount
const mintMeta = new Map<
  string,
  { name: string; symbol: string; slot: number }
>();

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------
function classify(prev: bigint, next: bigint): string {
  if (prev === 0n && next > 0n) return "NEW";
  if (next === 0n && prev > 0n) return "EXIT";
  return next > prev ? "INCREASE" : "DECREASE";
}

interface Change {
  key: string; // balance map key
  mint: string;
  owner: string;
  preSum: bigint;
  postSum: bigint;
  kind: "holder" | "wallet";
}

function collectChanges(rows: PortalTokenBalance[]): Change[] {
  // We aggregate both mint-centric and wallet-centric views in one pass.
  const holderMap = new Map<
    string,
    { mint: string; owner: string; pre: bigint; post: bigint }
  >();
  const walletMap = new Map<
    string,
    { mint: string; owner: string; pre: bigint; post: bigint }
  >();

  const hGet = (mint: string, owner: string) => {
    const k = `${mint}:${owner}`;
    let e = holderMap.get(k);
    if (!e) {
      e = { mint, owner, pre: 0n, post: 0n };
      holderMap.set(k, e);
    }
    return e;
  };
  const wGet = (owner: string, mint: string) => {
    const k = `${owner}:${mint}`;
    let e = walletMap.get(k);
    if (!e) {
      e = { mint, owner, pre: 0n, post: 0n };
      walletMap.set(k, e);
    }
    return e;
  };

  for (const row of rows) {
    if (row.preMint && row.preOwner) {
      if (watchedMints.has(row.preMint)) {
        hGet(row.preMint, row.preOwner).pre += BigInt(row.preAmount ?? 0);
      }
      if (watchedWallets.has(row.preOwner)) {
        wGet(row.preOwner, row.preMint).pre += BigInt(row.preAmount ?? 0);
      }
    }
    if (row.postMint && row.postOwner) {
      if (watchedMints.has(row.postMint)) {
        hGet(row.postMint, row.postOwner).post += BigInt(row.postAmount ?? 0);
      }
      if (watchedWallets.has(row.postOwner)) {
        wGet(row.postOwner, row.postMint).post += BigInt(row.postAmount ?? 0);
      }
    }
  }

  const out: Change[] = [];
  for (const e of holderMap.values()) {
    if (e.post !== e.pre) {
      out.push({
        key: `m:${e.mint}:${e.owner}`,
        mint: e.mint,
        owner: e.owner,
        preSum: e.pre,
        postSum: e.post,
        kind: "holder",
      });
    }
  }
  for (const e of walletMap.values()) {
    if (e.post !== e.pre) {
      out.push({
        key: `w:${e.owner}:${e.mint}`,
        mint: e.mint,
        owner: e.owner,
        preSum: e.pre,
        postSum: e.post,
        kind: "wallet",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Query builder (single subscription)
// ---------------------------------------------------------------------------
function buildQuery(from: number): PortalQuery {
  const mints = [...watchedMints];
  const wallets = [...watchedWallets];

  const tokenBalances: any[] = [];
  if (mints.length > 0) {
    tokenBalances.push({ preMint: mints, transaction: true });
    tokenBalances.push({ postMint: mints, transaction: true });
  }
  if (wallets.length > 0) {
    tokenBalances.push({ preOwner: wallets, transaction: true });
    tokenBalances.push({ postOwner: wallets, transaction: true });
  }

  return {
    type: "solana",
    fromBlock: from,
    fields: {
      block: {
        number: true,
        hash: true,
        parentNumber: true,
        parentHash: true,
        height: true,
        timestamp: true,
      },
      transaction: { transactionIndex: true, signatures: true, err: true },
      instruction: {
        transactionIndex: true,
        instructionAddress: true,
        programId: true,
        accounts: true,
        data: true,
        isCommitted: true,
      },
      tokenBalance: {
        transactionIndex: true,
        account: true,
        preMint: true,
        postMint: true,
        preOwner: true,
        postOwner: true,
        preAmount: true,
        postAmount: true,
      },
    },
    instructions: [
      {
        programId: [PUMP_PROGRAM],
        d8: [CREATE_D8, CREATE_V2_D8],
        isCommitted: true,
        transaction: true,
      },
    ],
    ...(tokenBalances.length > 0 ? { tokenBalances } : {}),
  };
}

// ---------------------------------------------------------------------------
// Stdin control
// ---------------------------------------------------------------------------
function startControl() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.setPrompt("> ");
  // don't call prompt immediately so logs stay clean; user can press enter

  rl.on("line", (line) => {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    const cmd = (parts[0] ?? "").toLowerCase();
    const arg = parts[1] ?? "";

    switch (cmd) {
      case "help":
      case "?":
        console.log(`
commands:
  status                 watched mints + wallets counts
  mints                  list mints
  wallets                list wallets
  drop <mint>            stop tracking mint
  dropall                stop tracking all mints
  watch <wallet>         start tracking wallet
  unwatch <wallet>       stop tracking wallet
  help
`);
        break;
      case "status":
        console.log(
          `[status] mints=${watchedMints.size} wallets=${watchedWallets.size} balances=${balances.size}`,
        );
        break;
      case "mints":
        if (watchedMints.size === 0) console.log("(none)");
        else {
          for (const m of watchedMints) {
            const meta = mintMeta.get(m);
            console.log(
              `  ${m}${meta ? `  ${meta.name} ($${meta.symbol}) slot=${meta.slot}` : ""}`,
            );
          }
        }
        break;
      case "wallets":
        if (watchedWallets.size === 0) console.log("(none)");
        else for (const w of watchedWallets) console.log(`  ${w}`);
        break;
      case "drop":
        if (!arg) {
          console.log("usage: drop <mint>");
          break;
        }
        if (watchedMints.delete(arg)) {
          // also purge related balance keys
          for (const k of [...balances.keys()]) {
            if (k.startsWith(`m:${arg}:`)) balances.delete(k);
          }
          mintMeta.delete(arg);
          console.log(
            `[ctrl] dropped mint ${arg.slice(0, 12)}…  (now ${watchedMints.size})`,
          );
        } else {
          console.log(`[ctrl] mint not watched: ${arg.slice(0, 12)}…`);
        }
        break;
      case "dropall":
        watchedMints.clear();
        mintMeta.clear();
        for (const k of [...balances.keys()]) {
          if (k.startsWith("m:")) balances.delete(k);
        }
        console.log("[ctrl] dropped all mints");
        break;
      case "watch":
        if (!arg || arg.length < 32) {
          console.log("usage: watch <wallet>");
          break;
        }
        if (watchedWallets.has(arg)) {
          console.log(`[ctrl] already watching ${arg.slice(0, 12)}…`);
        } else {
          watchedWallets.add(arg);
          console.log(
            `[ctrl] watching wallet ${arg.slice(0, 12)}…  (now ${watchedWallets.size})`,
          );
        }
        break;
      case "unwatch":
        if (!arg) {
          console.log("usage: unwatch <wallet>");
          break;
        }
        if (watchedWallets.delete(arg)) {
          for (const k of [...balances.keys()]) {
            if (k.startsWith(`w:${arg}:`)) balances.delete(k);
          }
          console.log(`[ctrl] unwatched wallet ${arg.slice(0, 12)}…`);
        } else {
          console.log(`[ctrl] wallet not watched: ${arg.slice(0, 12)}…`);
        }
        break;
      case "":
        break;
      default:
        console.log(`unknown command: ${cmd}  (type help)`);
    }
  });

  // Keep the process alive even if stdin ends in some environments
  rl.on("close", () => {});
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const portal =
    process.env.PORTAL_URL ?? "https://portal.sqd.dev/datasets/solana-mainnet";
  const lookback = Math.max(
    0,
    Number(process.env.LOOKBACK_SLOTS ?? process.env.SQD_LIVE_LOOKBACK ?? 400),
  );

  const head = await getPortalHead(portal, false);
  const from = Math.max(0, head.number - lookback);

  console.log(
    `[monitor] start from=${from} head=${head.number} lookback=${lookback}`,
  );
  console.log(`[monitor] auto-tracking new Pump mints + holders`);
  console.log(`[monitor] type "help" for runtime commands`);
  startControl();

  let lastProgress = 0;

  await runPortal({
    name: "pump-monitor",
    portalUrl: portal,
    finalized: false,
    from,
    buildQuery: (cursor) => buildQuery(cursor),
    onBlock: async (block: PortalBlock) => {
      const slot = block.header.number;
      const txs = transactionMap(block);

      // ---------- 1. New tokens ----------
      for (const ix of block.instructions ?? []) {
        if (ix.programId !== PUMP_PROGRAM || ix.isCommitted === false) continue;
        if (!ix.data || !ix.accounts) continue;

        let data: Uint8Array;
        try {
          data = base58Decode(ix.data);
        } catch {
          continue;
        }
        const args = decodeArgs(data);
        if (!args) continue;

        const layout = CREATE_LAYOUT[args.kind];
        if (ix.accounts.length < layout.minAccounts) continue;

        const tx = txs.get(ix.transactionIndex);
        if (!tx || tx.err) continue;
        const sig = tx.signatures?.[0];
        if (!sig) continue;

        const mint = ix.accounts[layout.mint];
        const bondingCurve = ix.accounts[layout.bondingCurve];
        const user = ix.accounts[layout.user];
        if (!mint || !bondingCurve || !user) continue;

        if (!watchedMints.has(mint)) {
          watchedMints.add(mint);
          mintMeta.set(mint, { name: args.name, symbol: args.symbol, slot });
          console.log(
            `\n🚀 NEW ${args.name} ($${args.symbol}) [${args.kind}]` +
              (args.isMayhemMode ? " mayhem" : "") +
              `\n   mint   ${mint}` +
              `\n   curve  ${bondingCurve}` +
              `\n   user   ${user}` +
              `\n   creator ${args.creator ?? user}` +
              `\n   sig    ${sig}` +
              `\n   slot   ${slot}` +
              `\n   mints now: ${watchedMints.size}`,
          );
        }
      }

      // ---------- 2. Balance changes (holders + wallets) ----------
      const rows = block.tokenBalances ?? [];
      if (rows.length === 0) {
        if (slot - lastProgress >= 50) {
          process.stdout.write(
            `\x1b[2K\r[monitor] slot=${slot}  mints=${watchedMints.size} wallets=${watchedWallets.size}   `,
          );
          lastProgress = slot;
        }
        return;
      }

      const byTx = new Map<number, PortalTokenBalance[]>();
      for (const r of rows) {
        const list = byTx.get(r.transactionIndex) ?? [];
        list.push(r);
        byTx.set(r.transactionIndex, list);
      }

      for (const txIndex of [...byTx.keys()].sort((a, b) => a - b)) {
        const tx = txs.get(txIndex);
        if (!tx || tx.err) continue;
        const sig = tx.signatures?.[0];
        if (!sig) continue;

        for (const c of collectChanges(byTx.get(txIndex)!)) {
          // Skip if the mint/wallet was dropped between query and processing
          if (c.kind === "holder" && !watchedMints.has(c.mint)) continue;
          if (c.kind === "wallet" && !watchedWallets.has(c.owner)) continue;

          const prev = balances.has(c.key) ? balances.get(c.key)! : c.preSum;
          const delta = c.postSum - c.preSum;
          const next = prev + delta;
          const safeNext = next < 0n ? 0n : next;
          balances.set(c.key, safeNext);

          const event = classify(prev, safeNext);
          if (prev === safeNext) continue;

          if (c.kind === "holder") {
            const meta = mintMeta.get(c.mint);
            const label = meta ? `${meta.symbol}` : c.mint.slice(0, 8);
            console.log(
              `\n[holder] ${event.padEnd(8)} $${label}  ` +
                `owner=${c.owner.slice(0, 8)}…  ` +
                `δ=${delta.toString().padStart(12)}  ` +
                `bal=${safeNext.toString().padStart(12)}  ` +
                `slot=${slot}  ${sig.slice(0, 12)}…`,
            );
          } else {
            console.log(
              `\n[wallet] ${event.padEnd(8)} wallet=${c.owner.slice(0, 8)}…  ` +
                `mint=${c.mint.slice(0, 8)}…  ` +
                `δ=${delta.toString().padStart(12)}  ` +
                `bal=${safeNext.toString().padStart(12)}  ` +
                `slot=${slot}  ${sig.slice(0, 12)}…`,
            );
          }
        }
      }

      lastProgress = slot;
    },
  });
}

if (import.meta.main) {
  await measure.root({ start: () => "pump-monitor" }, main).catch((err) => {
    console.error("[monitor] fatal", err);
    process.exitCode = 1;
  });
}
