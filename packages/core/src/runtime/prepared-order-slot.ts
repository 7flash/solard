/** A background producer never blocks the trigger. Keys include exact limits and size. */
export class PreparedOrderSlot<T extends { expiresAt: number }> {
  private current?: { key: string; order: T };
  private pending?: Promise<void>;
  private generation = 0;
  constructor(private readonly desired: () => string | undefined,
    private readonly prepare: (key: string) => Promise<T>, private readonly now = Date.now) {}
  async refresh(): Promise<void> {
    if (this.pending) return this.pending;
    const key = this.desired();
    if (key == null) { this.invalidate(); return; }
    const generation = this.generation;
    this.pending = Promise.resolve().then(() => this.prepare(key)).then(order => {
      if (generation === this.generation && key === this.desired() && order.expiresAt > this.now())
        this.current = { key, order };
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  take(key: string): T | undefined {
    const current = this.current;
    if (current?.key !== key || this.desired() !== key || current.order.expiresAt <= this.now()) return;
    this.invalidate();
    return current.order;
  }
  invalidate() { this.generation++; this.current = undefined; }
}
