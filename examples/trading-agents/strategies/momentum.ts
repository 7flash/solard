export default function momentum(input: {
  priceSol: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  holding: boolean;
  entryPriceSol: number | null;
  state: Record<string, number>;
}): "buy" | "sell" | null {
  if (!(input.priceSol && input.priceSol > 0)) return null;
  const previous = input.state.previous ?? input.priceSol;
  input.state.previous = input.priceSol;
  if (
    input.holding &&
    input.entryPriceSol &&
    (input.priceSol >= input.entryPriceSol * 1.1 ||
      input.priceSol <= input.entryPriceSol * 0.94)
  ) {
    return "sell";
  }
  if (!input.holding && input.priceSol >= previous * 1.025) return "buy";
  return null;
}
