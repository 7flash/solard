import type { SolUsdSource, TradeSide, TradeVenue } from "@solard/sdk";

export type PriceFeedMarket = {
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  supply: number;
  baseReserve: number;
  quoteReserve: number;
  priceQuotePerToken: number;
  marketCapQuote: number;
  priceSol: number | null;
  marketCapSol: number | null;
  solUsd: number | null;
  solUsdSource: SolUsdSource | null;
  solUsdAtMs: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
};

export type PriceFeedPrice = {
  type: "price";
  atMs: number;
  signature: string;
  slot: number;
  mint: string;
  pool: string | null;
  venue: TradeVenue;
  side: TradeSide | null;
  market: PriceFeedMarket;
};

export type PriceFeedStatus = {
  type: "status";
  atMs: number;
  event: string;
  data?: Record<string, unknown>;
};

export type PriceFeedMessage = PriceFeedPrice | PriceFeedStatus;

export type PriceFeedCommand =
  | { op: "subscribe"; mints: string[] }
  | { op: "unsubscribe"; mints: string[] }
  | { op: "ping" };
