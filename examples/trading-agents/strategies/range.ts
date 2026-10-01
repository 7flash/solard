export default function range(input: {
  priceSol: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  holding: boolean;
  entryPriceSol: number | null;
  state: Record<string, number>;
}): "buy" | "sell" | null {
  if (!(input.priceSol && input.priceSol > 0)) return null;
  const anchor = input.state.anchor ?? input.priceSol;
  input.state.anchor = anchor;
  if (
    input.holding &&
    input.entryPriceSol &&
    (input.priceSol >= anchor * 1.04 ||
      input.priceSol <= input.entryPriceSol * 0.94)
  ) {
    return "sell";
  }
  if (!input.holding && input.priceSol <= anchor * 0.96) return "buy";
  return null;
}
