export default function dip(input: {
  priceSol: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  holding: boolean;
  entryPriceSol: number | null;
  state: Record<string, number>;
}): "buy" | "sell" | null {
  if (!(input.priceSol && input.priceSol > 0)) return null;
  input.state.high = Math.max(
    input.state.high ?? input.priceSol,
    input.priceSol,
  );
  if (
    input.holding &&
    input.entryPriceSol &&
    (input.priceSol >= input.entryPriceSol * 1.1 ||
      input.priceSol <= input.entryPriceSol * 0.94)
  ) {
    return "sell";
  }
  if (!input.holding && input.priceSol <= input.state.high * 0.92) return "buy";
  return null;
}
