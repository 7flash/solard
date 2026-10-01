export default function marketCapCross(input: {
  priceSol: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  holding: boolean;
  entryPriceSol: number | null;
  state: Record<string, number>;
  args: ReadonlyMap<string, string>;
}): "buy" | "sell" | null {
  if (!(input.marketCapUsd && input.marketCapUsd > 0)) return null;

  const buyMarketCapUsd = Number(input.args.get("buy-mcap"));
  const sellMarketCapUsd = Number(input.args.get("sell-mcap"));
  if (!(buyMarketCapUsd > 0) || !(sellMarketCapUsd > 0)) {
    throw new Error(
      "market-cap-cross requires --buy-mcap <usd> --sell-mcap <usd>",
    );
  }
  const previous = input.state.marketCapUsd;
  input.state.marketCapUsd = input.marketCapUsd;

  if (!(previous > 0)) return null;
  if (
    !input.holding &&
    previous < buyMarketCapUsd &&
    input.marketCapUsd >= buyMarketCapUsd
  ) {
    return "buy";
  }
  if (
    input.holding &&
    previous < sellMarketCapUsd &&
    input.marketCapUsd >= sellMarketCapUsd
  ) {
    return "sell";
  }
  return null;
}
