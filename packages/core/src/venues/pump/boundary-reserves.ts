import { fraction } from "../../tx/price-guard.ts";
import type { CurveReserves } from "./quote.ts";

function sqrtFloor(value: bigint): bigint {
  if (value < 2n) return value;
  let x = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
  for (;;) { const next = (x + value / x) / 2n; if (next >= x) return x; x = next; }
}

/** Quote-only constant-product state at a spot boundary. Never observed account data. */
export function boundaryReserves(reserves: CurveReserves, baseDecimals: number, quoteDecimals: number,
  priceQuotePerToken: string, side: "buy" | "sell"): CurveReserves {
  if (reserves.virtualBase <= 0n || reserves.virtualQuote <= 0n ||
      !Number.isInteger(baseDecimals) || baseDecimals < 0 || baseDecimals > 255 ||
      !Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 255)
    throw Error("Verified positive reserves and mint decimals required for a spot boundary");
  const price = fraction(priceQuotePerToken);
  const numerator = price.numerator * 10n ** BigInt(quoteDecimals);
  const denominator = price.denominator * 10n ** BigInt(baseDecimals);
  const invariant = reserves.virtualBase * reserves.virtualQuote;
  const radicand = invariant * denominator;
  let base = sqrtFloor(radicand / numerator);
  if (side === "sell" && base * base * numerator < radicand) base++;
  if (base <= 0n) throw Error("Spot boundary cannot be represented by positive reserves");
  const quote = side === "buy" ? (invariant + base - 1n) / base : invariant / base;
  if (quote <= 0n || base > 0xffffffffffffffffn || quote > 0xffffffffffffffffn)
    throw Error("Spot boundary reserves exceed supported amounts");
  return {virtualBase:base,virtualQuote:quote};
}
