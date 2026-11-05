/** Routine step buys must leave `floorSol` free, so exceptional new pairs can still be bought. A buy larger than that
 * room is cut to it, not dropped. A bot within its first `newEntryMin` minutes is that new pair, so only its own guard
 * applies. Unknown balance: no routine buy. Returns the SOL the buy may use. */
export function buyRoom(o: { freeSol: number | null; buySol: number; addedAtMs?: number | null; nowMs: number; floorSol?: number; newEntryMin?: number }) {
  if (o.addedAtMs != null && o.nowMs - o.addedAtMs < (o.newEntryMin ?? 30) * 60_000) return o.buySol;
  return o.freeSol == null ? 0 : Math.max(0, Math.min(o.buySol, o.freeSol - (o.floorSol ?? 0.1)));
}
