// Realtime holder logger with reorg-safe in-memory state.
// Maintains a ring buffer of per-block mutations so balances can be
// rolled back on hot-stream forks (HTTP 409 / parentHash mismatch).
//
// Usage:
//   bun run sqd/holder-live.ts <MINT> [MINT2 ...]
//
// Optional:
//   LOOKBACK_SLOTS=200
//   REORG_DEPTH=48
//   PORTAL_URL=...
import {
  getPortalHead,
  measure,
  type PortalBlock,
  type PortalQuery,
  type PortalTokenBalance,
  runPortal,
  timestampMs,
  transactionMap,
} from "./shared/portal.js";

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
  /** key (mint:owner) → net delta applied in this block */
  deltas: Map<string, bigint>;
}

class ReorgSafeBalances {
  /** Current absolute balances */
  readonly balances = new Map<string, bigint>();
  /** Recent block mutations (oldest → newest) */
  private history: BlockMutation[] = [];
  private readonly maxDepth: number;

  constructor(maxDepth = 48) {
    this.maxDepth = Math.max(8, maxDepth);
  }

  /** Apply a set of net deltas for a newly accepted block. Returns events to print. */
  applyBlock(
    slot: number,
    hash: string,
    parentHash: string | undefined,
    changes: { key: string; delta: bigint; prev: bigint; next: bigint }[],
  ): { key: string; prev: bigint; next: bigint }[] {
    const deltas = new Map<string, bigint>();
    const events: { key: string; prev: bigint; next: bigint }[] = [];

    for (const c of changes) {
      deltas.set(c.key, (deltas.get(c.key) ?? 0n) + c.delta);
      this.balances.set(c.key, c.next);
      events.push({ key: c.key, prev: c.prev, next: c.next });
    }

    this.history.push({ slot, hash, parentHash, deltas });
    while (this.history.length > this.maxDepth) {
      this.history.shift();
    }
    return events;
  }

  /**
   * Roll back all mutations after the given common ancestor slot.
   * Returns the number of blocks reverted.
   */
  rollbackTo(commonSlot: number): number {
    let reverted = 0;
    while (this.history.length > 0) {
      const last = this.history[this.history.length - 1]!;
      if (last.slot <= commonSlot) break;

      // Reverse the deltas
      for (const [key, delta] of last.deltas) {
        const cur = this.balances.get(key) ?? 0n;
        const restored = cur - delta;
        if (restored === 0n) this.balances.delete(key);
        else this.balances.set(key, restored < 0n ? 0n : restored);
      }
      this.history.pop();
      reverted++;
    }
    return reverted;
  }

  /** Find highest slot in history whose hash matches one of the provided points. */
  findCommon(
    previousBlocks: { number: number; hash: string }[],
  ): number | null {
    // Walk from newest to oldest
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

  get(key: string): bigint | undefined {
    return this.balances.get(key);
  }

  has(key: string): boolean {
    return this.balances.has(key);
  }

  get tipSlot(): number | null {
    return this.history.length
      ? this.history[this.history.length - 1]!.slot
      : null;
  }
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
  const lookback = Math.max(0, Number(process.env.LOOKBACK_SLOTS ?? 200));
  const reorgDepth = Math.max(8, Number(process.env.REORG_DEPTH ?? 48));

  const head = await getPortalHead(portal, false);
  const from = Math.max(0, head.number - lookback);

  const store = new ReorgSafeBalances(reorgDepth);

  console.log(
    `[live] watching ${mints.length} mint(s) from=${from} head=${head.number} ` +
      `lookback=${lookback} reorgDepth=${reorgDepth}`,
  );
  for (const m of mints) console.log(`[live]   ${m}`);

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

      // Cheap parent-hash continuity check (detects some forks early)
      if (
        lastHash &&
        parentHash &&
        parentHash !== lastHash &&
        slot === lastSlot + 1
      ) {
        console.warn(
          `\n[live] parentHash mismatch at slot ${slot} — possible fork. ` +
            `localTip=${lastHash.slice(0, 12)}… parent=${parentHash.slice(0, 12)}…`,
        );
        // Best-effort: roll back the last block if we still have it
        const common = store.findCommon([{ number: lastSlot, hash: lastHash }]);
        if (common !== null) {
          const n = store.rollbackTo(common - 1);
          console.warn(
            `[live] rolled back ${n} block(s) to slot ${common - 1}`,
          );
        }
      }

      const rows = block.tokenBalances ?? [];

      if (rows.length > 0 || slot - lastProgress >= 40) {
        process.stdout.write(
          `\x1b[2K\r[live] slot=${slot}  tokenBalances=${rows.length}   `,
        );
        lastProgress = slot;
      }

      const pending: {
        key: string;
        delta: bigint;
        prev: bigint;
        next: bigint;
      }[] = [];

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

            pending.push({ key, delta, prev, next: safeNext });

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

      // Record the block mutation (even if empty) so we can roll it back
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
