import type { MarketPrice } from "../venues/venue-plugin.ts";

/** Convert a reserve quote only through a caller-supplied verified quote market. */
export async function samplePriceInSol(
  sample: MarketPrice,
  loadQuoteSol: (mint: string, decimals: number) => Promise<number | null>,
): Promise<MarketPrice & { priceSol: number }> {
  const conversion = sample.quoteAsset.kind === "native-sol" ? 1
    : await loadQuoteSol(sample.quoteAsset.mint.toBase58(), sample.quoteAsset.decimals);
  const priceSol = conversion == null ? NaN : sample.priceQuotePerToken * conversion;
  if (conversion == null || !Number.isFinite(conversion) || conversion <= 0 ||
      !Number.isFinite(sample.priceQuotePerToken) || sample.priceQuotePerToken <= 0 ||
      !Number.isFinite(priceSol) || priceSol <= 0)
    throw Object.assign(new Error("Verified quote-to-SOL price conversion unavailable"), { code: "CONVERSION_UNAVAILABLE" });
  return { ...sample, priceSol };
}
