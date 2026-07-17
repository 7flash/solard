// Watched-mint set with FIFO eviction so the Portal filter stays bounded.

export interface MintMeta {
  name: string;
  symbol: string;
  slot: number;
  addedAt: number; // Date.now()
}

export class MintRegistry {
  private readonly order: string[] = []; // oldest → newest
  private readonly meta = new Map<string, MintMeta>();
  private readonly maxMints: number;

  constructor(maxMints = 300) {
    this.maxMints = Math.max(10, maxMints);
  }

  get size() {
    return this.order.length;
  }

  has(mint: string): boolean {
    return this.meta.has(mint);
  }

  values(): string[] {
    return [...this.order];
  }

  getMeta(mint: string): MintMeta | undefined {
    return this.meta.get(mint);
  }

  /** Returns list of evicted mints (may be empty). */
  add(mint: string, info: Omit<MintMeta, "addedAt">): string[] {
    if (this.meta.has(mint)) return [];

    this.order.push(mint);
    this.meta.set(mint, { ...info, addedAt: Date.now() });

    const evicted: string[] = [];
    while (this.order.length > this.maxMints) {
      const old = this.order.shift()!;
      this.meta.delete(old);
      evicted.push(old);
    }
    return evicted;
  }

  delete(mint: string): boolean {
    if (!this.meta.has(mint)) return false;
    this.meta.delete(mint);
    const idx = this.order.indexOf(mint);
    if (idx >= 0) this.order.splice(idx, 1);
    return true;
  }

  clear(): void {
    this.order.length = 0;
    this.meta.clear();
  }

  list(): { mint: string; meta: MintMeta }[] {
    return this.order.map((mint) => ({ mint, meta: this.meta.get(mint)! }));
  }
}
