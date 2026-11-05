/** Moves a range that the price has left back around the price. The bot's size is reset to what it really holds, so
 * moving the range never trades by itself: a lower range alone would make the steps cheaper, the bot would think it
 * holds too few tokens and buy more of a falling coin. A bot holding nothing keeps its base size and trades the new
 * range normally. Pure so the no-trade property can be tested. */
import { readFileSync } from "node:fs";
import { rangeLevels, targetPlan } from "../packages/core/src/runtime/target-inventory.ts";

export type Recentered = { buy: number; sell: number; steps: number; budgetSol: number; holding: boolean };
const sig3 = (v: number) => { const m = 10 ** (Math.floor(Math.log10(v)) - 2); return Math.round(v / m) * m; };

/** Market cap at which selling the whole bag gets back the SOL still in it, plus 4% for costs; null when nothing is at risk. */
export function breakEvenCap(o: { capUsd: number; priceSol: number; tokens: number; flowSol: number }) {
  if (!(o.flowSol < 0 && o.tokens > 0 && o.priceSol > 0)) return null;
  return -o.flowSol / o.tokens / o.priceSol * o.capUsd * 1.04;
}

/** More hourly volume -> wider range -> bigger size (the rule from Groyper: 18k SOL/h at $100k = 25-150, 0.2 SOL). */
export function volumeTier(volSol1h: number) {
  if (volSol1h >= 5_000) return { low: 0.25, high: 1.5, mult: 10, steps: 4 };
  if (volSol1h >= 1_000) return { low: 0.4, high: 1.6, mult: 5, steps: 4 };
  if (volSol1h >= 200) return { low: 0.55, high: 1.6, mult: 2, steps: 3 };
  return null;
}

/** A range file left from an earlier bot on this coin only counts if the price is still inside it. */
export function staleRange(path: string, capUsd: number) {
  try { const r = JSON.parse(readFileSync(path, "utf8")) as { buyMarketCapUsd?: string; sellMarketCapUsd?: string }; return !(capUsd >= Number(r.buyMarketCapUsd) && capUsd <= Number(r.sellMarketCapUsd)); } catch { return true; }
}

/** Size for a smart entry: more followable wallets in the coin, more size (2 wallets x2, 3 x3, 4+ x4), capped. Volume
 * plays no part: a new pair has none worth reading yet. */
export function smartEntrySize(baseSol: number, wallets: number, maxSol = 0.2) {
  return Math.max(baseSol, Math.min(baseSol * Math.min(Math.max(wallets, 1), 4), maxSol));
}

export function recenter(o: { capUsd: number; priceSol: number; balanceRaw: bigint; decimals: number; baseSol: number;
  floorCapUsd: number; dustSol?: number; low?: number; high?: number; steps?: number;
  /** Prices the coin kept touching in the last hour (tui/candles.ts). Used when at least 40% wide; steps about 20% each. */
  band?: { lo: number; hi: number } | null;
  /** Net SOL the bot has in or out so far (negative = still in). A moved bag never sells under what it cost. */
  flowSol?: number;
  /** SOL traded in the last hour and the largest size the volume rule may reach. */
  volSol1h?: number; maxSol?: number }): Recentered | null {
  const { capUsd, priceSol, balanceRaw, decimals, baseSol } = o, chart = o.band && o.band.hi >= o.band.lo * 1.4 ? o.band : null;
  if (!(capUsd > 0 && priceSol > 0 && baseSol > 0) || capUsd < o.floorCapUsd) return null;
  // The chart decides when it can, but the price must sit inside the range with room on both sides.
  const bottom = chart ? Math.min(chart.lo, capUsd * 0.85) : capUsd * (o.low ?? 0.7), ceiling = chart ? Math.max(chart.hi, capUsd * 1.2) : capUsd * (o.high ?? 1.6);
  const buy = sig3(Math.max(bottom, o.floorCapUsd)), sell = sig3(ceiling);
  const steps = o.steps ?? (chart ? Math.max(2, Math.min(5, Math.floor(Math.log(sell / buy) / Math.log(1.2)))) : 3);
  if (!(sell > buy)) return null;
  const tokens = Number(balanceRaw) / 10 ** decimals, toPrice = priceSol / capUsd, levels = rangeLevels(buy, sell, steps).map(x => x * toPrice);
  if (tokens * priceSol < (o.dustSol ?? 0.0005)) {
    // Empty: the only case where volume sets range and size. Bags keep what they hold.
    const tier = volumeTier(o.volSol1h ?? 0);
    if (!tier) return { buy, sell, steps, budgetSol: baseSol, holding: false };
    // Touched prices set the range when we have them; volume sets the size.
    const wide = chart ? { buy, sell, steps } : { buy: sig3(Math.max(capUsd * tier.low, o.floorCapUsd)), sell: sig3(capUsd * tier.high), steps: tier.steps };
    return { ...wide, budgetSol: Math.max(baseSol, Math.min(baseSol * tier.mult, o.maxSol ?? 0.2)), holding: false };
  }
  // Underwater bag: one step from here up to break-even (plus 4% for trading costs), so its only sale is at or above cost.
  const even = breakEvenCap({ capUsd, priceSol, tokens, flowSol: o.flowSol ?? 0 });
  if (even && even > capUsd * 1.2) {
    const budgetSol = Math.ceil(tokens * buy * toPrice * 1e6) / 1e6, top = Math.ceil(even / 10) * 10, one = [buy * toPrice, top * toPrice];
    return targetPlan({ levels: one, budgetSol, balanceRaw, decimals, priceSol }).action ? null : { buy, sell: top, steps: 1, budgetSol, holding: true };
  }
  // Steps the price says to hold: at least one, since we do hold tokens.
  const must = Math.max(1, levels.slice(0, steps).filter(l => priceSol <= l).length);
  const inverse = levels.slice(steps - must, steps).reduce((a, l) => a + 1 / l, 0);
  const budgetSol = Math.round(tokens * steps / inverse * 1e6) / 1e6;
  if (!(budgetSol > 0)) return null;
  // Must be a no-op: otherwise leave the range alone.
  return targetPlan({ levels, budgetSol, balanceRaw, decimals, priceSol }).action ? null : { buy, sell, steps, budgetSol, holding: true };
}
