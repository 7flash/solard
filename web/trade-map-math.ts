/** Pure chart maths, separate so it can be tested without a browser (common.ts needs one). */
export type MapCandle = { m: number; o?: number; h: number; l: number; c: number };
export type MapFill = { atMs: number; side: "buy" | "sell"; sol: number };
export type MapRange = { buy: number; sell: number; steps: number };
export type MapHistory = { candles?: MapCandle[]; fills?: MapFill[]; range?: MapRange | null };

/** The saved candles (written once a minute) plus minutes built from the live trades, so the chart reaches now. */
export function liveCandles(saved: MapCandle[], ts: { atMs: number; capUsd: number | null }[]) {
  const out = [...saved].sort((a, b) => a.m - b.m), last = out[out.length - 1]?.m ?? -Infinity, fresh = new Map<number, MapCandle>();
  for (const t of [...ts].sort((a, b) => a.atMs - b.atMs)) {
    const m = Math.floor(t.atMs / 60_000), cap = t.capUsd!; if (m <= last) continue;
    const k = fresh.get(m); if (!k) fresh.set(m, { m, o: cap, h: cap, l: cap, c: cap }); else { k.h = Math.max(k.h, cap); k.l = Math.min(k.l, cap); k.c = cap; }
  }
  return [...out, ...fresh.values()];
}
/** Step levels of a range, bottom to top. */
export const rangeLines = (r: MapRange) => Array.from({ length: r.steps + 1 }, (_, i) => r.buy + (r.sell - r.buy) * i / r.steps);
/** Range lines stretch the price axis only when they are near the price; far away they would flatten the candles. */
export function axisWithRange(lo: number, hi: number, r: MapRange | null | undefined) {
  if (!r) return { lo, hi };
  return { lo: r.buy >= lo / 1.6 ? Math.min(lo, r.buy) : lo, hi: r.sell <= hi * 1.6 ? Math.max(hi, r.sell) : hi };
}

/** Time and cap the chart must cover: all candles, then the live trades on top of them. */
export function mapSpan(ts: { atMs: number; capUsd: number | null }[], candles: MapCandle[]) {
  const times = [...ts.map(t => t.atMs), ...candles.map(c => c.m * 60_000)], caps = [...ts.map(t => t.capUsd!), ...candles.flatMap(c => [c.h, c.l])];
  return { t0: Math.min(...times), t1: Math.max(...times) + 1, lo: Math.min(...caps), hi: Math.max(...caps) };
}
/** Cap at a moment: the candle of that minute, or the nearest one (the last minute is not saved yet), else the live trades. */
export function capAt(atMs: number, candles: MapCandle[], ts: { atMs: number; capUsd: number | null }[]) {
  const near = <T,>(xs: T[], time: (x: T) => number) => xs.reduce<T | null>((b, x) => b == null || Math.abs(time(x) - atMs) < Math.abs(time(b) - atMs) ? x : b, null);
  const trade = near(ts, t => t.atMs), candle = near(candles, c => c.m * 60_000 + 30_000);
  if (trade && (!candle || Math.abs(trade.atMs - atMs) < Math.abs(candle.m * 60_000 + 30_000 - atMs))) return trade.capUsd;
  return candle?.c ?? null;
}
