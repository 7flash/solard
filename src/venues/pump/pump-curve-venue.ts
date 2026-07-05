import { PublicKey, type Connection } from "@solana/web3.js";
import { sameAsset, type RawAmount } from "../../core/amounts.js";
import type { TokenRow } from "../../db/schema.js";
import type {
  BuiltInstructions,
  MarketPrice,
  QuoteResult,
  TradeVenuePlugin,
  VenueContext,
  VenueMarket,
} from "../venue-plugin.js";
import { buildCurveBuyV2, buildCurveSellV2 } from "./pump-instructions.js";
import {
  quoteBuyConstantProduct,
  quoteSellConstantProduct,
  spotPriceQuotePerToken,
} from "./quote.js";
import { resolvePumpRouting } from "./routing.js";
import { defaultTokenProgram, fetchCurve, hasSharingConfig } from "./state.js";
import { pumpSwapPoolPda, sharingConfigPda } from "./pda.js";
import {
  configuredTotalFeeBps,
  defaultPumpQuoteShell,
  type CurveMarketMeta,
} from "./common.js";

/** Pump bonding curve only. Graduated tokens intentionally fall through to PumpSwapVenue. */
export class PumpCurveVenue implements TradeVenuePlugin {
  readonly id = "pump-curve";

  async inspectToken(
    connection: Connection,
    mint: PublicKey,
  ): Promise<Partial<TokenRow> | null> {
    const now = Date.now();
    const curve = await fetchCurve(
      connection,
      defaultPumpQuoteShell(mint, now),
    );
    if (!curve) return null;
    const sharing = await hasSharingConfig(connection, mint);
    return {
      bondingCurve: curve.address.toBase58(),
      creator: curve.creator?.toBase58() ?? null,
      quoteMint: curve.quoteAsset.mint.toBase58(),
      quoteTokenProgram: curve.quoteAsset.tokenProgram.toBase58(),
      pool: curve.complete
        ? pumpSwapPoolPda(mint, curve.quoteAsset.mint).toBase58()
        : null,
      venueHint: curve.complete ? "pumpswap" : "pump-curve",
      sharingConfig: sharing ? sharingConfigPda(mint).toBase58() : null,
      refreshedAtMs: now,
    };
  }

  async resolveMarket(ctx: VenueContext): Promise<VenueMarket | null> {
    const curve = await fetchCurve(ctx.connection, ctx.token);
    if (!curve || curve.complete) return null;
    return {
      venue: this.id,
      mint: new PublicKey(ctx.token.mint),
      quoteAsset: curve.quoteAsset,
      baseTokenProgram: defaultTokenProgram(ctx.token),
      creator: curve.creator,
      metadata: { curve } satisfies CurveMarketMeta,
    };
  }

  async quoteBuy(
    ctx: VenueContext,
    market: VenueMarket,
    amount: RawAmount,
    slippageBps: number,
  ): Promise<QuoteResult> {
    if (!sameAsset(market.quoteAsset, amount.asset))
      throw new Error("Buy amount asset does not match Pump curve quote asset");
    const curve = (market.metadata as CurveMarketMeta).curve;
    const value = quoteBuyConstantProduct(
      amount,
      curve,
      slippageBps,
      configuredTotalFeeBps(ctx.token),
    );
    return { venue: this.id, quoteAsset: market.quoteAsset, ...value };
  }

  async quoteSell(
    ctx: VenueContext,
    market: VenueMarket,
    amountRaw: bigint,
    slippageBps: number,
  ): Promise<QuoteResult> {
    const curve = (market.metadata as CurveMarketMeta).curve;
    const value = quoteSellConstantProduct(
      amountRaw,
      curve,
      slippageBps,
      configuredTotalFeeBps(ctx.token),
    );
    return {
      venue: this.id,
      quoteAsset: market.quoteAsset,
      inputRaw: amountRaw,
      expectedOutputRaw: value.expectedOutputRaw,
      minimumOutputRaw: value.minimumOutputRaw,
    };
  }

  async price(ctx: VenueContext, market: VenueMarket): Promise<MarketPrice> {
    const curve = (market.metadata as CurveMarketMeta).curve;
    return {
      venue: this.id,
      mint: market.mint,
      quoteAsset: market.quoteAsset,
      priceQuotePerToken: spotPriceQuotePerToken(
        curve,
        ctx.token.decimals ?? 6,
        market.quoteAsset.decimals,
      ),
      baseReserveRaw: curve.virtualBase,
      quoteReserveRaw: curve.virtualQuote,
      capturedAtMs: Date.now(),
    };
  }

  async buildBuy(
    ctx: VenueContext,
    market: VenueMarket,
    quote: QuoteResult,
  ): Promise<BuiltInstructions> {
    if (!market.creator)
      throw new Error(
        "Pump curve creator is unknown; refresh token metadata first",
      );
    const curve = (market.metadata as CurveMarketMeta).curve;
    const routing = await resolvePumpRouting(
      ctx.connection,
      ctx.token,
      market.creator,
      market.quoteAsset,
      curve.isMayhemMode,
    );
    return {
      venue: this.id,
      quoteAsset: market.quoteAsset,
      instructions: buildCurveBuyV2({
        mint: market.mint,
        user: ctx.user,
        baseTokenProgram: market.baseTokenProgram,
        quote: market.quoteAsset,
        routing,
        quoteInRaw: quote.inputRaw,
        minBaseOutRaw: quote.minimumOutputRaw,
      }),
      minOutputRaw: quote.minimumOutputRaw,
      expectedOutputRaw: quote.expectedOutputRaw,
    };
  }

  async buildSell(
    ctx: VenueContext,
    market: VenueMarket,
    quote: QuoteResult,
  ): Promise<BuiltInstructions> {
    if (!market.creator)
      throw new Error(
        "Pump curve creator is unknown; refresh token metadata first",
      );
    const curve = (market.metadata as CurveMarketMeta).curve;
    const routing = await resolvePumpRouting(
      ctx.connection,
      ctx.token,
      market.creator,
      market.quoteAsset,
      curve.isMayhemMode,
    );
    return {
      venue: this.id,
      quoteAsset: market.quoteAsset,
      instructions: buildCurveSellV2({
        mint: market.mint,
        user: ctx.user,
        baseTokenProgram: market.baseTokenProgram,
        quote: market.quoteAsset,
        routing,
        baseInRaw: quote.inputRaw,
        minQuoteOutRaw: quote.minimumOutputRaw,
      }),
      minOutputRaw: quote.minimumOutputRaw,
      expectedOutputRaw: quote.expectedOutputRaw,
    };
  }
}
