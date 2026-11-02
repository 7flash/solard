import { fixedPriceBand, positivePrice, type FixedPriceBand } from "./fixed-price-band.ts";
export type MarketCapBand = { kind: "market-cap"; buyMarketCapUsd: string; sellMarketCapUsd: string; buyPriceSol?: never; sellPriceSol?: never; entryPaused?: true };
export type RangeSpec = FixedPriceBand | MarketCapBand;
export function marketCapPrices(spec: MarketCapBand, mint: { supply: bigint; decimals: number; atMs: number }, solUsd: {price:number;atMs:number}, now=Date.now()): FixedPriceBand {
 if(mint.supply<=0n||!Number.isInteger(mint.decimals)||mint.decimals<0||mint.decimals>255||now-mint.atMs>120000||now<mint.atMs||!Number.isFinite(solUsd.price)||solUsd.price<=0||now-solUsd.atMs>120000||now<solUsd.atMs)throw new Error("Fresh verified supply and SOL/USD required for market-cap range");
 const scale=Number(mint.supply)/10**mint.decimals*solUsd.price;
 const buy=String(Number(spec.buyMarketCapUsd)/scale),sell=String(Number(spec.sellMarketCapUsd)/scale);
 if(spec.entryPaused)return {kind:'fixed',buyPriceSol:positivePrice(buy),sellPriceSol:positivePrice(sell),entryPaused:true};
 return fixedPriceBand(buy,sell);
}
