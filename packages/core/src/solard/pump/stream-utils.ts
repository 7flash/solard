export type QueueStats = {
  queued: number;
  active: number;
  completed: number;
  failed: number;
  dropped: number;
  maxConcurrency: number;
  maxQueued: number;
};

export class TtlDeduper {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 120_000,
    private readonly maxEntries = 20_000,
  ) {}

  has(value: string, now = Date.now()): boolean {
    this.sweep(now);
    const until = this.seen.get(value);
    return until !== undefined && until > now;
  }

  add(value: string, now = Date.now()): boolean {
    this.sweep(now);
    if (this.has(value, now)) return false;
    this.seen.set(value, now + this.ttlMs);
    this.trim();
    return true;
  }

  size(): number {
    return this.seen.size;
  }

  sweep(now = Date.now()): void {
    for (const [value, until] of this.seen) {
      if (until <= now) this.seen.delete(value);
    }
  }

  private trim(): void {
    if (this.seen.size <= this.maxEntries) return;
    const remove = this.seen.size - this.maxEntries;
    let i = 0;
    for (const key of this.seen.keys()) {
      this.seen.delete(key);
      i++;
      if (i >= remove) break;
    }
  }
}

export class BoundedAsyncQueue<T> {
  private readonly queue: Array<T> = [];
  private active = 0;
  private completed = 0;
  private failed = 0;
  private dropped = 0;

  constructor(
    private readonly worker: (item: T) => Promise<void>,
    private readonly opts: { concurrency?: number; maxQueued?: number } = {},
  ) {}

  push(item: T): boolean {
    const maxQueued = this.opts.maxQueued ?? 2_000;
    if (this.queue.length >= maxQueued) {
      this.dropped++;
      return false;
    }
    this.queue.push(item);
    this.pump();
    return true;
  }

  stats(): QueueStats {
    return {
      queued: this.queue.length,
      active: this.active,
      completed: this.completed,
      failed: this.failed,
      dropped: this.dropped,
      maxConcurrency: this.opts.concurrency ?? 4,
      maxQueued: this.opts.maxQueued ?? 2_000,
    };
  }

  private pump(): void {
    const max = Math.max(1, this.opts.concurrency ?? 4);
    while (this.active < max && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.active++;
      Promise.resolve()
        .then(() => this.worker(item))
        .then(() => {
          this.completed++;
        })
        .catch(() => {
          this.failed++;
        })
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}

export function compactError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

export function shortSignature(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}
