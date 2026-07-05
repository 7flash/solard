import type { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { QuoteAsset, RawAmount } from "../core/amounts.js";
import type { TokenRow } from "../db/schema.js";

export type VenueId = string;
export type VenueContext = { connection: Connection; token: TokenRow; user: PublicKey };
export type VenueMarket = {
  venue: VenueId;
  mint: PublicKey;
  quoteAsset: QuoteAsset;
  baseTokenProgram: PublicKey;
  creator: PublicKey | null;
  metadata: Record<string, unknown>;
};
export type QuoteResult = {
  venue: VenueId;
  quoteAsset: QuoteAsset;
  inputRaw: bigint;
  expectedOutputRaw: bigint;
  minimumOutputRaw: bigint;
  meta?: Record<string, unknown>;
};
export type MarketPrice = {
  venue: VenueId;
  mint: PublicKey;
  quoteAsset: QuoteAsset;
  priceQuotePerToken: number;
  baseReserveRaw?: bigint;
  quoteReserveRaw?: bigint;
  capturedAtMs: number;
};
export type BuiltInstructions = {
  venue: VenueId;
  quoteAsset: QuoteAsset;
  instructions: TransactionInstruction[];
  minOutputRaw?: bigint;
  expectedOutputRaw?: bigint;
  meta?: Record<string, unknown>;
};

/**
 * A single executable trading venue: one curve, AMM, orderbook or RFQ adapter.
 * Claim sources and script-level strategies deliberately do not belong here.
 */
export interface TradeVenuePlugin {
  readonly id: VenueId;
  inspectToken?(connection: Connection, mint: PublicKey): Promise<Partial<TokenRow> | null>;
  resolveMarket(ctx: VenueContext): Promise<VenueMarket | null>;
  quoteBuy(ctx: VenueContext, market: VenueMarket, amount: RawAmount, slippageBps: number): Promise<QuoteResult>;
  quoteSell(ctx: VenueContext, market: VenueMarket, amountRaw: bigint, slippageBps: number): Promise<QuoteResult>;
  price(ctx: VenueContext, market: VenueMarket): Promise<MarketPrice>;
  buildBuy(ctx: VenueContext, market: VenueMarket, quote: QuoteResult): Promise<BuiltInstructions>;
  buildSell(ctx: VenueContext, market: VenueMarket, quote: QuoteResult): Promise<BuiltInstructions>;
}

/** @deprecated Import TradeVenuePlugin; retained only for source compatibility. */
export type VenuePlugin = TradeVenuePlugin;
