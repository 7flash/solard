import { readFileSync, watch } from "fs";
import { basename, dirname, resolve } from "path";
import { parseRangeCsv, rangeCsvIdentities } from "./range-csv.ts";
import type { RangeSpec } from "./market-cap-band.ts";

/** One filesystem watcher; per-row subscriptions retain their last valid limits. */
export class SharedRanges {
  private text = "";
  private error: Error | null = null;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private watcher: ReturnType<typeof watch>;
  readonly path: string;
  constructor(path: string, private changed: () => void) {
    this.path = resolve(path);
    this.refresh();
    this.watcher = watch(dirname(this.path), (_event, name) => {
      if (name != null && String(name) !== basename(this.path)) return;
      clearTimeout(this.timer); this.timer = setTimeout(() => this.refresh(), 75);
    });
    this.watcher.on("error", error => { this.error = error; this.publish(); });
  }
  private publish() { for (const listener of this.listeners) listener(); this.changed(); }
  refresh() {
    try {
      const text = readFileSync(this.path, "utf8");
      if (text === this.text && !this.error) return;
      rangeCsvIdentities(text);
      this.text = text; this.error = null;
    } catch (error) { this.error = error instanceof Error ? error : Error(String(error)); }
    this.publish();
  }
  identities() { if (this.error) throw this.error; return rangeCsvIdentities(this.text); }
  read(wallet: string, mint: string) { if (this.error) throw this.error; return parseRangeCsv(this.text, wallet, mint); }
  subscribe(wallet: string, mint: string, changed: (spec: RangeSpec | null, error?: string) => void) {
    let current = this.read(wallet, mint), valid = true, previous = JSON.stringify(current);
    const refresh = () => {
      try {
        const next = this.read(wallet, mint), encoded = JSON.stringify(next);
        if (!valid || encoded !== previous) { current = next; previous = encoded; valid = true; changed(next); }
      } catch (error) { if (valid) { valid = false; changed(null, String(error)); } }
    };
    this.listeners.add(refresh);
    return { get current() { return current; }, get valid() { return valid; }, refresh,
      close: () => { this.listeners.delete(refresh); } };
  }
  close() { clearTimeout(this.timer); this.watcher.close(); this.listeners.clear(); }
}

/** Coalesces refreshes and backs off failed sources without refreshing stale timestamps. */
export function sharedTimedPrice<T extends { atMs: number }>(load: () => Promise<T>, now = Date.now) {
  let value: T | undefined, pending: Promise<T> | undefined, retryAt = 0;
  return async (): Promise<T> => {
    if (value && now() - value.atMs < 60_000) return value;
    if (pending) return pending;
    if (now() < retryAt) {
      if (value && now() - value.atMs < 120_000) return value;
      throw Error("SOL/USD source cooling down; new trade decisions paused");
    }
    pending = load().then(next => {
      if (!Number.isFinite(next.atMs) || next.atMs > now() || now() - next.atMs >= 120_000) throw Error("Fresh SOL/USD required");
      value = next; retryAt = now() - next.atMs >= 60_000 ? now() + 30_000 : 0; return next;
    }).catch(error => {
      retryAt = now() + 30_000;
      if (value && now() - value.atMs < 120_000) return value;
      throw error;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
