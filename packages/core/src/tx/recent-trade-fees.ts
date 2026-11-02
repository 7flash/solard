import type { Connection, PublicKey } from "@solana/web3.js";

type Entry = { values: number[]; at: number; retryAt: number; pending?: Promise<void> };
const caches = new WeakMap<Connection, Map<string, Entry>>();
/** Fee suggestions are optional. Never hold transaction preparation on a slow
 * provider, nor launch duplicate lookups while an earlier request is pending. */
export async function recentTradeFees(connection: Connection, addresses: PublicKey[], waitMs = 250): Promise<number[]> {
  let cache = caches.get(connection);
  if (!cache) { cache = new Map(); caches.set(connection, cache); }
  const key = addresses.length <= 128 ? addresses.map(key => key.toBase58()).sort().join(",") : "global";
  let entry = cache.get(key);
  if (!entry) {
    if (cache.size >= 64) {
      const removable = [...cache].find(([, value]) => !value.pending);
      if (removable) cache.delete(removable[0]);
      else return []; // Bound outstanding requests as well as stored samples.
    }
    entry = { values: [], at: 0, retryAt: 0 }; cache.set(key, entry);
  }
  const current = entry;
  const fallback = () => Date.now() - current.at <= 60_000 ? [...current.values] : [];
  if (Date.now() - current.at < 10_000 || Date.now() < current.retryAt) return fallback();
  if (!current.pending) {
    current.pending = Promise.resolve().then(() => connection.getRecentPrioritizationFees(
      addresses.length <= 128 ? { lockedWritableAccounts: addresses } : undefined,
    )).then(rows => {
      current.values = rows.map(row => row.prioritizationFee).filter(value => Number.isSafeInteger(value) && value >= 0);
      current.at = Date.now();
    }).catch(() => { current.retryAt = Date.now() + 5_000; })
      .finally(() => { current.pending = undefined; });
  }
  // Stale samples are usable while refreshing; caller's fee floor/caps apply.
  if (fallback().length) return fallback();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([current.pending, new Promise<void>(resolve => {
      timer = setTimeout(() => { current.retryAt = Date.now() + 5_000; resolve(); }, waitMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
  return fallback();
}
