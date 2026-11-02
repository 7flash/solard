import { fraction } from "../tx/price-guard.ts";
import type { FixedPriceBand } from "./fixed-price-band.ts";

/** Fraction of the positive target spread, with an unconditional 2% execution cap. */
export function rangeSlippageBps(band: FixedPriceBand, shareBps = 1000): number {
  if (!Number.isInteger(shareBps) || shareBps < 0 || shareBps > 10000)
    throw Error("Range slippage share must be between 0 and 10000 basis points");
  const buy = fraction(band.buyPriceSol), sell = fraction(band.sellPriceSol);
  const spread = sell.numerator * buy.denominator - buy.numerator * sell.denominator;
  if (spread <= 0n) return 0;
  const bps = spread * BigInt(shareBps) / (buy.numerator * sell.denominator);
  return Number(bps > 200n ? 200n : bps);
}
