/** Non-blocking metadata refresh. Old values retain their original timestamps;
 * expired or missing data is unavailable, never silently treated as fresh. */
export class RefreshingValue<T extends { atMs: number }> {
  private value?: T;
  private pending?: Promise<void>;
  private retryAt = 0;
  private closed = false;
  constructor(private load: () => Promise<T>, private options: {
    refreshAfterMs: number; maxAgeMs: number; now?: () => number;
    onUpdate?: () => void; onError?: (error: unknown) => void;
  }) {}
  get(): T | undefined {
    if (this.closed) return undefined;
    const now = (this.options.now ?? Date.now)();
    const age = this.value == null ? Infinity : now - this.value.atMs;
    if (!this.pending && now >= this.retryAt && age >= this.options.refreshAfterMs) {
      // A shared source may return the same still-valid cached timestamp.
      // Do not refresh/wake in a tight loop until its own cache rolls forward.
      this.retryAt = now + 5_000;
      this.pending = Promise.resolve().then(this.load).then(value => {
        const receivedAt = (this.options.now ?? Date.now)();
        if (!Number.isFinite(value.atMs) || value.atMs > receivedAt || receivedAt - value.atMs > this.options.maxAgeMs)
          throw Error("Metadata refresh returned stale or future data");
        if (!this.closed) { this.value = value; this.options.onUpdate?.(); }
      }).catch(error => {
        this.retryAt = (this.options.now ?? Date.now)() + 5_000;
        if (!this.closed) this.options.onError?.(error);
      }).finally(() => { this.pending = undefined; });
    }
    return age >= 0 && age <= this.options.maxAgeMs ? this.value : undefined;
  }
  close() { this.closed = true; }
}
