// Authoritative + self-healing balance store with optional reorg ring buffer.

export interface BlockMutation {
  slot: number;
  hash: string;
  parentHash?: string;
  /** key → absolute balance after this block */
  snapshots: Map<string, bigint>;
}

/**
 * Prefer postSum as truth when the observed pre matches what we have.
 * Falls back to delta application and records a per-block snapshot so
 * we can roll back on parentHash discontinuity.
 */
export class BalanceStore {
  readonly balances = new Map<string, bigint>();
  private history: BlockMutation[] = [];
  private readonly maxDepth: number;

  constructor(maxDepth = 48) {
    this.maxDepth = Math.max(8, maxDepth);
  }

  /**
   * Apply one observed change.
   * Returns the (prev, next) pair used for event classification, or null if no-op.
   */
  applyObserved(
    key: string,
    preSum: bigint,
    postSum: bigint,
  ): { prev: bigint; next: bigint } | null {
    const stored = this.balances.get(key);
    let prev: bigint;
    let next: bigint;

    if (stored === undefined) {
      // First sight — trust chain pre/post
      prev = preSum;
      next = postSum;
    } else if (stored === preSum) {
      // Consistent — take post as authoritative
      prev = stored;
      next = postSum;
    } else {
      // Divergence (missed events / reorg residue) — resync to post
      prev = stored;
      next = postSum;
    }

    if (next < 0n) next = 0n;
    if (prev === next && stored !== undefined) return null;

    this.balances.set(key, next);
    return { prev, next };
  }

  /** Call once per accepted block after all applies. */
  commitBlock(
    slot: number,
    hash: string,
    parentHash: string | undefined,
    touchedKeys: string[],
  ): void {
    const snapshots = new Map<string, bigint>();
    for (const k of touchedKeys) {
      const v = this.balances.get(k);
      if (v !== undefined) snapshots.set(k, v);
    }
    this.history.push({ slot, hash, parentHash, snapshots });
    while (this.history.length > this.maxDepth) this.history.shift();
  }

  rollbackTo(commonSlot: number): number {
    let reverted = 0;
    while (this.history.length > 0) {
      const last = this.history[this.history.length - 1]!;
      if (last.slot <= commonSlot) break;
      // Restore previous snapshot if we have one; otherwise delete touched keys
      const prev =
        this.history.length >= 2 ? this.history[this.history.length - 2] : null;
      for (const key of last.snapshots.keys()) {
        if (prev?.snapshots.has(key)) {
          this.balances.set(key, prev.snapshots.get(key)!);
        } else {
          this.balances.delete(key);
        }
      }
      this.history.pop();
      reverted++;
    }
    return reverted;
  }

  findCommon(points: { number: number; hash: string }[]): number | null {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const m = this.history[i]!;
      if (points.some((p) => p.number === m.slot && p.hash === m.hash)) {
        return m.slot;
      }
    }
    return null;
  }

  deletePrefix(prefix: string): void {
    for (const k of [...this.balances.keys()]) {
      if (k.startsWith(prefix)) this.balances.delete(k);
    }
  }

  get size() {
    return this.balances.size;
  }
}
