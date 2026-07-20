// Realtime holder logger with:
// - absolute pre/post aggregation (correct event labels)
// - reorg-safe mutation ring buffer
// - optional RPC baseline seeding (SEED_FROM_RPC=1)
//
// Usage:
//   bun run sqd/holder-live.ts <MINT> [MINT2 ...]
//
// Env:
//   LOOKBACK_SLOTS=200
//   REORG_DEPTH=48
//   SEED_FROM_RPC=1          ← seed absolute balances from RPC at from-1
//   RPC_URL=https://api.mainnet-beta.solana.com
//   PORTAL_URL=...
import {
  getPortalHead,
  measure,
  type PortalBlock,
  type PortalQuery,
  type PortalTokenBalance,
  runPortal,
  transactionMap,
} from "./shared/portal.ts";

type HolderEventType = "NEW_HOLDER" | "INCREASE" | "DECREASE" | "EXIT";

function bigintValue(value: string | number | undefined): bigint {
  return value === undefined ? 0n : BigInt(value);
}

function classify(previous: bigint, next: bigint): HolderEventType {
  if (previous === 0n && next > 0n) return "NEW_HOLDER";
  if (next === 0n && previous > 0n) return "EXIT";
  return next > previous ? "INCREASE" : "DECREASE";
}

interface MintOwnerChange {
  mint: string;
  owner: string;
  preSum: bigint;
  postSum: bigint;
}

function aggregateChanges(
  rows: PortalTokenBalance[],
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
      get(row.preMint, row.preOwner).preSum += bigintValue(row.preAmount);
    }
    if (row.postMint && row.postOwner && watched.has(row.postMint)) {
      get(row.postMint, row.postOwner).postSum += bigintValue(row.postAmount);
    }
  }
  return [...map.values()].filter((e) => e.postSum !== e.preSum);
}

// ---------------------------------------------------------------------------
// Reorg-safe balance store
// ---------------------------------------------------------------------------
interface BlockMutation {
  slot: number;
  hash: string;
  parentHash?: string;
  deltas: Map<string, bigint>;
}

class ReorgSafeBalances {
  readonly balances = new Map<string, bigint>();
  private history: BlockMutation[] = [];
  private readonly maxDepth: number;

  constructor(maxDepth = 48) {
    this.maxDepth = Math.max(8, maxDepth);
  }

  applyBlock(
    slot: number,
    hash: string,
    parentHash: string | undefined,
    changes: { key: string; delta: bigint; next: bigint }[],
  ): void {
    const deltas = new Map<string, bigint>();
    for (const c of changes) {
      deltas.set(c.key, (deltas.get(c.key) ?? 0n) + c.delta);
      this.balances.set(c.key, c.next);
    }
    this.history.push({ slot, hash, parentHash, deltas });
    while (this.history.length > this.maxDepth) this.history.shift();
  }

  rollbackTo(commonSlot: number): number {
    let reverted = 0;
    while (this.history.length > 0) {
      const last = this.history[this.history.length - 1]!;
      if (last.slot <= commonSlot) break;
      for (const [key, delta] of last.deltas) {
        const cur = this.balances.get(key) ?? 0n;
        const restored = cur - delta;
        if (restored <= 0n) this.balances.delete(key);
        else this.balances.set(key, restored);
      }
      this.history.pop();
      reverted++;
    }
    return reverted;
  }

  findCommon(
    previousBlocks: { number: number; hash: string }[],
  ): number | null {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const m = this.history[i]!;
      if (
        previousBlocks.some((p) => p.number === m.slot && p.hash === m.hash)
      ) {
        return m.slot;
      }
    }
    return null;
  }

  seed(key: string, amount: bigint): void {
    if (amount > 0n) this.balances.set(key, amount);
    else this.balances.delete(key);
  }

  get(key: string): bigint | undefined {
    return this.balances.get(key);
  }

  has(key: string): boolean {
    return this.balances.has(key);
  }
}

// ---------------------------------------------------------------------------
// Optional RPC baseline seeding
// ---------------------------------------------------------------------------
async function seedFromRpc(
  mints: string[],
  store: ReorgSafeBalances,
  rpcUrl: string,
): Promise<number> {
  let seeded = 0;
  console.log(`[live] seeding balances from RPC (${rpcUrl}) …`);

  for (const mint of mints) {
    // getProgramAccounts filtered by mint is heavy; use getTokenLargestAccounts
    // as a practical approximation for the biggest holders, then fall back to
    // empty for everyone else. For full accuracy you would paginate
    // getProgramAccounts / use a DAS or indexer API.
    try {
      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenLargestAccounts",
        params: [mint, { commitment: "confirmed" }],
      };
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        console.warn(`[live] RPC ${res.status} for mint ${mint.slice(0, 8)}…`);
        continue;
      }
      const json = (await res.json()) as {
        result?: {
          value?: {
            address: string;
            amount: string;
            uiAmountString?: string;
          }[];
        };
      };
      const accounts = json.result?.value ?? [];
      for (const acc of accounts) {
        // We only get the token account address + amount, not the owner.
        // A second getAccountInfo would be needed for owner. For a logger
        // this is still useful as a warm-up of the biggest bags.
        // Full owner mapping requires getMultipleAccounts or a richer API.
        const amount = BigInt(acc.amount);
        if (amount > 0n) {
          // Key by token-account for now; real owner resolution is optional later.
          store.seed(`ta:${acc.address}`, amount);
          seeded++;
        }
      }
      console.log(
        `[live]   ${mint.slice(0, 8)}… largestAccounts=${accounts.length}`,
      );
    } catch (err) {
      console.warn(`[live] RPC seed failed for ${mint.slice(0, 8)}…`, err);
    }
  }

  console.log(`[live] RPC seed complete, ${seeded} accounts warmed`);
  return seeded;
}

/**
 * Better seed: resolve owner for each token account via getMultipleAccounts.
 * Kept separate so the simple path stays light.
 */
async function seedFromRpcWithOwners(
  mints: string[],
  store: ReorgSafeBalances,
  rpcUrl: string,
): Promise<number> {
  let seeded = 0;
  console.log(`[live] seeding with owners from RPC …`);

  for (const mint of mints) {
    try {
      // 1. largest accounts
      const largestRes = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenLargestAccounts",
          params: [mint, { commitment: "confirmed" }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!largestRes.ok) continue;
      const largestJson = (await largestRes.json()) as {
        result?: { value?: { address: string; amount: string }[] };
      };
      const accounts = largestJson.result?.value ?? [];
      if (accounts.length === 0) continue;

      // 2. resolve owners
      const addresses = accounts.map((a) => a.address);
      const infoRes = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "getMultipleAccounts",
          params: [
            addresses,
            { encoding: "jsonParsed", commitment: "confirmed" },
          ],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!infoRes.ok) continue;
      const infoJson = (await infoRes.json()) as {
        result?: {
          value?: ({
            data?: {
              parsed?: {
                info?: { owner?: string; tokenAmount?: { amount: string } };
              };
            };
          } | null)[];
        };
      };
      const infos = infoJson.result?.value ?? [];

      for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i]!;
        const info = infos[i];
        const owner = info?.data?.parsed?.info?.owner;
        const amountStr =
          info?.data?.parsed?.info?.tokenAmount?.amount ?? acc.amount;
        if (!owner) continue;
        const amount = BigInt(amountStr);
        if (amount > 0n) {
          store.seed(`${mint}:${owner}`, amount);
          seeded++;
        }
      }
      console.log(
        `[live]   ${mint.slice(0, 8)}… seeded ${accounts.length} holders`,
      );
    } catch (err) {
      console.warn(`[live] RPC seed failed for ${mint.slice(0, 8)}…`, err);
    }
  }

  console.log(`[live] RPC seed complete, ${seeded} owner balances`);
  return seeded;
}

function buildQuery(mints: string[], from: number): PortalQuery {
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
      transaction: {
        transactionIndex: true,
        signatures: true,
        err: true,
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
    tokenBalances: [
      { preMint: mints, transaction: true },
      { postMint: mints, transaction: true },
    ],
  };
}

async function main() {
  const mints = process.argv
    .slice(2)
    .filter((v) => !v.startsWith("--") && v.length > 30);

  if (mints.length === 0) {
    console.error("usage: bun run sqd/holder-live.ts <MINT> [MINT2 ...]");
    process.exit(1);
  }

  const watched = new Set(mints);
  const portal =
    process.env.PORTAL_URL ?? "https://portal.sqd.dev/datasets/solana-mainnet";
  const rpcUrl = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const lookback = Math.max(0, Number(process.env.LOOKBACK_SLOTS ?? 200));
  const reorgDepth = Math.max(8, Number(process.env.REORG_DEPTH ?? 48));
  const doSeed = process.env.SEED_FROM_RPC === "1";

  const head = await getPortalHead(portal, false);
  const from = Math.max(0, head.number - lookback);

  const store = new ReorgSafeBalances(reorgDepth);

  console.log(
    `[live] watching ${mints.length} mint(s) from=${from} head=${head.number} ` +
      `lookback=${lookback} reorgDepth=${reorgDepth} seedRpc=${doSeed}`,
  );
  for (const m of mints) console.log(`[live]   ${m}`);

  if (doSeed) {
    await seedFromRpcWithOwners(mints, store, rpcUrl);
  }

  let lastProgress = 0;
  let lastHash: string | undefined;
  let lastSlot = from - 1;

  await runPortal({
    name: "holder-live",
    portalUrl: portal,
    finalized: false,
    from,
    buildQuery: (cursor) => buildQuery(mints, cursor),
    onBlock: async (block: PortalBlock) => {
      const slot = block.header.number;
      const hash = block.header.hash;
      const parentHash = block.header.parentHash;

      if (
        lastHash &&
        parentHash &&
        parentHash !== lastHash &&
        slot === lastSlot + 1
      ) {
        console.warn(
          `\n[live] parentHash mismatch at slot ${slot} — possible fork`,
        );
        const common = store.findCommon([{ number: lastSlot, hash: lastHash }]);
        if (common !== null) {
          const n = store.rollbackTo(common - 1);
          console.warn(`[live] rolled back ${n} block(s)`);
        }
      }

      const rows = block.tokenBalances ?? [];

      if (rows.length > 0 || slot - lastProgress >= 40) {
        process.stdout.write(
          `\x1b[2K\r[live] slot=${slot}  tokenBalances=${rows.length}   `,
        );
        lastProgress = slot;
      }

      const pending: { key: string; delta: bigint; next: bigint }[] = [];

      if (rows.length > 0) {
        const txs = transactionMap(block);
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

          for (const c of aggregateChanges(byTx.get(txIndex)!, watched)) {
            const key = `${c.mint}:${c.owner}`;
            const prev = store.has(key) ? store.get(key)! : c.preSum;
            const delta = c.postSum - c.preSum;
            const next = prev + delta;
            const safeNext = next < 0n ? 0n : next;

            if (next < 0n) {
              console.warn(
                `\n[live] WARNING negative ${c.mint.slice(0, 8)}… ` +
                  `owner=${c.owner.slice(0, 8)}… next=${next}`,
              );
            }

            pending.push({ key, delta, next: safeNext });

            const event = classify(prev, safeNext);
            if (prev === safeNext) continue;

            console.log(
              `\n[live] ${event.padEnd(10)} ${c.mint.slice(0, 8)}… ` +
                `owner=${c.owner.slice(0, 8)}…  ` +
                `δ=${delta.toString().padStart(12)}  ` +
                `bal=${safeNext.toString().padStart(12)}  ` +
                `slot=${slot}  ${sig.slice(0, 12)}…`,
            );
          }
        }
      }

      store.applyBlock(slot, hash, parentHash, pending);
      lastHash = hash;
      lastSlot = slot;
    },
  });
}

if (import.meta.main) {
  await measure.root({ start: () => "holder-live" }, main).catch((err) => {
    console.error("[live] fatal", err);
    process.exitCode = 1;
  });
}
