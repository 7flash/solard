/** Sells that follow what a buy actually cost. Range levels ignore fills: a coin bought at $10k in a $15-37k range could
 * not sell until $22k. Each fill sells at `multiple` x its price, wherever the range is, and then its step only buys
 * back after the price falls by that same multiple, so a take-profit is never bought straight back. An old bag's
 * average cost can be far under the price, so the rebuy follows the sale price, not the fill. */
export type Fill = { priceSol: number; raw: string };
export type FillBook = { seeded: boolean; fills: Fill[]; rebuyAtSol: number | null };
export const emptyBook = (): FillBook => ({ seeded: false, fills: [], rebuyAtSol: null });

/** Fills at or past their target: what to sell, what stays, the lowest acceptable price and the rebuy price. */
export function fillsToSell(book: FillBook, priceSol: number, multiple: number) {
  const hit = book.fills.filter(f => priceSol >= f.priceSol * multiple);
  if (!hit.length) return null;
  return { sellRaw: hit.reduce((s, f) => s + BigInt(f.raw), 0n), remaining: book.fills.filter(f => !hit.includes(f)),
    floorSol: Math.max(...hit.map(f => f.priceSol)), rebuyAtSol: priceSol / multiple };
}

/** A range sell: oldest fills leave first. */
export function consumeFills(fills: Fill[], soldRaw: bigint): Fill[] {
  const out: Fill[] = []; let left = soldRaw;
  for (const f of fills) {
    const raw = BigInt(f.raw);
    if (left >= raw) { left -= raw; continue; }
    out.push({ ...f, raw: (raw - left).toString() }); left = 0n;
  }
  return out;
}

/** A bag from before fills were kept: one fill at its average cost. No cost left to recover: range rules only. */
export function seedFromBag(balanceRaw: bigint, decimals: number, flowSol: number): Fill[] {
  if (balanceRaw <= 0n || flowSol >= 0) return [];
  return [{ priceSol: -flowSol / (Number(balanceRaw) / 10 ** decimals), raw: balanceRaw.toString() }];
}

/** A buy from the bot: tokens are worked out from the SOL it really spent. */
export function fillFromBuy(spentSol: number, priceSol: number, decimals: number): Fill {
  return { priceSol, raw: BigInt(Math.floor(spentSol / priceSol * 10 ** decimals)).toString() };
}
