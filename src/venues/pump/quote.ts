import type { RawAmount } from "../../core/amounts.js";
export type CurveReserves = { virtualBase: bigint; virtualQuote: bigint };
function bpsFloor(value: bigint, bps: number): bigint { return value * BigInt(bps) / 10_000n; }
export function quoteBuyConstantProduct(amount: RawAmount, reserves: CurveReserves, slippageBps: number, totalFeeBps = 200) {
  const net = amount.raw * 10_000n / BigInt(10_000 + totalFeeBps);
  const output = (net * reserves.virtualBase) / (reserves.virtualQuote + net);
  const min = bpsFloor(output, 10_000 - slippageBps);
  if (min <= 0n) throw new Error("Buy quote resolves to zero output");
  return { inputRaw: amount.raw, expectedOutputRaw: output, minimumOutputRaw: min };
}
export function quoteSellConstantProduct(inputRaw: bigint, reserves: CurveReserves, slippageBps: number, totalFeeBps = 200) {
  const gross = (inputRaw * reserves.virtualQuote) / (reserves.virtualBase + inputRaw);
  const net = gross * BigInt(10_000 - totalFeeBps) / 10_000n;
  const min = bpsFloor(net, 10_000 - slippageBps);
  if (min <= 0n) throw new Error("Sell quote resolves to zero output");
  return { inputRaw, expectedOutputRaw: net, minimumOutputRaw: min };
}


/** Display/analytics-only spot price derived from current reserves. Trading
 * still obtains a protected quote and simulates before any submission. */
export function spotPriceQuotePerToken(reserves: CurveReserves, baseDecimals: number, quoteDecimals: number): number {
  if (reserves.virtualBase <= 0n || reserves.virtualQuote <= 0n) throw new Error("Cannot calculate price from empty reserves");
  const baseUnits = Number(reserves.virtualBase) / 10 ** baseDecimals;
  const quoteUnits = Number(reserves.virtualQuote) / 10 ** quoteDecimals;
  const price = quoteUnits / baseUnits;
  if (!Number.isFinite(price) || price <= 0) throw new Error("Price is not finite");
  return price;
}
