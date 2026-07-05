export type CacheLoader<T> = () => Promise<T>;
type Entry<T> = { value: T; expiresAt: number };

export class AccountCache {
  private readonly data = new Map<string, Entry<unknown>>();
  constructor(readonly ttlMs = Number(process.env.SOWL_CACHE_TTL_MS ?? "3000")) {}
  async get<T>(key: string, loader: CacheLoader<T>, ttlMs = this.ttlMs): Promise<T> {
    const hit = this.data.get(key) as Entry<T> | undefined;
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = await loader();
    this.data.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }
  invalidate(key?: string): void { key ? this.data.delete(key) : this.data.clear(); }
  async refresh<T>(key: string, loader: CacheLoader<T>, ttlMs = this.ttlMs): Promise<T> {
    this.data.delete(key); return this.get(key, loader, ttlMs);
  }
}
