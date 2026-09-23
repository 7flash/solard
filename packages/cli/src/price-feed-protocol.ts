export type PriceFeedVenue =
  "pump" | "pumpswap" | "raydium-launchlab" | "rpc-fallback";

export type PriceFeedLaunch = {
  type: "launch";
  atMs: number;
  signature: string | null;
  slot: number | null;
  mint: string;
  venue: "pump" | "raydium-launchlab";
  decimals: number;
  supplyUi: number;
  quoteMint: string | null;
  pool: string | null;
  name: string | null;
  symbol: string | null;
  isMayhemMode: boolean | null;
};

export type PriceFeedPrice = {
  type: "price";
  atMs: number;
  signature: string | null;
  slot: number | null;
  mint: string;
  venue: PriceFeedVenue;
  priceSol: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  source: string;
};

export type PriceFeedStatus = {
  type: "status";
  atMs: number;
  event: string;
  data?: Record<string, unknown>;
};

export type PriceFeedMessage =
  PriceFeedLaunch | PriceFeedPrice | PriceFeedStatus;

export type PriceFeedCommand =
  | {
      op: "subscribe";
      mints?: string[];
      launches?: boolean;
      allPrices?: boolean;
    }
  | { op: "unsubscribe"; mints?: string[] }
  | { op: "ping" };
