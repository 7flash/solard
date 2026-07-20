// Realtime Pump.fun monitor:
// 1. Detects new create / create_v2 tokens
// 2. Automatically starts tracking holder changes for every new mint
// Uses absolute pre/post sums so labels are correct.
// No DB. Hot stream only. Pure logs.
//
// Usage:
//   bun run sqd/pump-live.ts
//
// Optional:
//   LOOKBACK_SLOTS=400
//   PORTAL_URL=...
import {
  getPortalHead,
  measure,
  type PortalBlock,
  type PortalQuery,
  runPortal,
  timestampMs,
  transactionMap,
} from "./shared/portal.ts";

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
    let isCashbackEnabled: boolean | null | undefined;
    if (kind === "create_v2" && r.rem >= 1) isMayhemMode = r.bool();
    if (kind === "create_v2" && r.rem >= 1) {
      const tag = r.bytes(1)[0]!;
      isCashbackEnabled = tag === 0 ? null : r.bool();
    }
    return {
      kind,
      name,
      symbol,
      uri,
      creator,
      isMayhemMode,
      isCashbackEnabled,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Holder change aggregation (absolute pre/post)
// ---------------------------------------------------------------------------
interface MintOwnerChange {
  mint: string;
  owner: string;
  preSum: bigint;
  postSum: bigint;
}

function aggregateChanges(
  rows: NonNullable<PortalBlock["tokenBalances"]>,
  watched: ReadonlySet<string>,
): MintOwnerChange[] {
  const map = new Map<string, MintOwnerChange>();
  const get = (mint: string, owner: string) => {
    const key = `${mint}:${owner}`;
    let e = map.get(key);
    if (!e) {
      e = { mint, owner, preSum: 0n, postSum: 0n };
      map.set(key, e);
    }
    return e;
  };

  for (const row of rows) {
    if (row.preMint && row.preOwner && watched.has(row.preMint)) {
      get(row.preMint, row.preOwner).preSum += BigInt(row.preAmount ?? 0);
    }
    if (row.postMint && row.postOwner && watched.has(row.postMint)) {
      get(row.postMint, row.postOwner).postSum += BigInt(row.postAmount ?? 0);
    }
  }
  return [...map.values()].filter((e) => e.postSum !== e.preSum);
}

function classify(prev: bigint, next: bigint): string {
  if (prev === 0n && next > 0n) return "NEW_HOLDER";
  if (next === 0n && prev > 0n) return "EXIT";
  return next > prev ? "INCREASE" : "DECREASE";
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

  const watchedMints = new Set<string>();
  const balances = new Map<string, bigint>(); // mint:owner -> amount

  console.log(
    `[pump-live] start from=${from} head=${head.number} lookback=${lookback}`,
  );
  console.log(
    `[pump-live] will auto-track holders for every new create / create_v2`,
  );

  await runPortal({
    name: "pump-live",
    portalUrl: portal,
    finalized: false,
    from,
    buildQuery: (cursor) => {
      const mints = [...watchedMints];
      return {
        type: "solana",
        fromBlock: cursor,
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
        ...(mints.length > 0
          ? {
              tokenBalances: [
                { preMint: mints, transaction: true },
                { postMint: mints, transaction: true },
              ],
            }
          : {}),
      };
    },
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
          console.log(
            `\n🚀 NEW ${args.name} ($${args.symbol}) [${args.kind}]` +
              (args.isMayhemMode ? " mayhem" : "") +
              `\n   mint   ${mint}` +
              `\n   curve  ${bondingCurve}` +
              `\n   user   ${user}` +
              `\n   creator ${args.creator ?? user}` +
              `\n   sig    ${sig}` +
              `\n   slot   ${slot}` +
              `\n   watching holders now (${watchedMints.size} total)`,
          );
        }
      }

      // ---------- 2. Holder changes ----------
      const rows = block.tokenBalances ?? [];
      if (rows.length === 0 || watchedMints.size === 0) {
        if (slot % 50 === 0) {
          process.stdout.write(
            `\x1b[2K\r[pump-live] slot=${slot}  mints=${watchedMints.size}   `,
          );
        }
        return;
      }

      const byTx = new Map<number, typeof rows>();
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

        for (const c of aggregateChanges(byTx.get(txIndex)!, watchedMints)) {
          const key = `${c.mint}:${c.owner}`;
          const prev = balances.has(key) ? balances.get(key)! : c.preSum;
          const next = prev + (c.postSum - c.preSum);

          if (next < 0n) {
            console.warn(
              `\n[holder] WARNING negative ${c.mint.slice(0, 8)}… ` +
                `owner=${c.owner.slice(0, 8)}… next=${next}`,
            );
          }
          const safeNext = next < 0n ? 0n : next;
          balances.set(key, safeNext);

          const event = classify(prev, safeNext);
          if (prev === safeNext) continue;

          console.log(
            `[holder] ${event.padEnd(10)} ${c.mint.slice(0, 8)}… ` +
              `owner=${c.owner.slice(0, 8)}…  ` +
              `δ=${(c.postSum - c.preSum).toString().padStart(12)}  ` +
              `bal=${safeNext.toString().padStart(12)}  ` +
              `slot=${slot}  ${sig.slice(0, 12)}…`,
          );
        }
      }
    },
  });
}

if (import.meta.main) {
  await measure.root({ start: () => "pump-live" }, main).catch((err) => {
    console.error("[pump-live] fatal", err);
    process.exitCode = 1;
  });
}
