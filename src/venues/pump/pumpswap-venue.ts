import { PublicKey } from "@solana/web3.js";
import { sameAsset, type RawAmount } from "../../core/amounts.js";
import type { BuiltInstructions, MarketPrice, QuoteResult, TradeVenuePlugin, VenueContext, VenueMarket } from "../venue-plugin.js";
import { ammGlobalConfigPda, pumpSwapPoolPda } from "./pda.js";
import { buildPumpSwapBuyExactQuoteIn, buildPumpSwapSell } from "./pumpswap-instructions.js";
import { quoteBuyConstantProduct, quoteSellConstantProduct, spotPriceQuotePerToken } from "./quote.js";
import { resolvePumpSwapProtocolFeeRecipient, tokenMeta } from "./routing.js";
import { defaultTokenProgram, fetchCurve, fetchPool } from "./state.js";
import { configuredTotalFeeBps, extraAccounts, poolQuoteAsset, tokenAccountAmount, type PumpSwapMarketMeta } from "./common.js";

/** Canonical PumpSwap AMM only. It is a separate swappable venue plugin from the launch curve. */
export class PumpSwapVenue implements TradeVenuePlugin {
  readonly id = "pumpswap";

  async resolveMarket(ctx: VenueContext): Promise<VenueMarket | null> {
    const curve = await fetchCurve(ctx.connection, ctx.token);
    if (!curve?.complete) return null;
    const mint = new PublicKey(ctx.token.mint);
    const pool = ctx.token.pool ? new PublicKey(ctx.token.pool) : pumpSwapPoolPda(mint, curve.quoteAsset.mint);
    const state = await fetchPool(ctx.connection, pool);
    if (!state.baseMint.equals(mint)) throw new Error(`Configured PumpSwap pool does not contain token ${ctx.token.mint}`);
    const quoteAsset = await poolQuoteAsset(ctx.connection, ctx.token, state.quoteMint);
    const baseTokenProgram = defaultTokenProgram(ctx.token);
    const [baseReserve, quoteReserve] = await Promise.all([
      tokenAccountAmount(ctx.connection, state.baseTokenAccount, baseTokenProgram),
      tokenAccountAmount(ctx.connection, state.quoteTokenAccount, quoteAsset.tokenProgram),
    ]);
    const meta = tokenMeta(ctx.token);
    const protocolFeeRecipient = await resolvePumpSwapProtocolFeeRecipient(
      ctx.connection, mint, state.isMayhemMode,
      typeof meta.protocolFeeRecipient === "string" ? meta.protocolFeeRecipient : process.env.PUMPSWAP_PROTOCOL_FEE_RECIPIENT,
    );
    return {
      venue: this.id, mint, quoteAsset, baseTokenProgram, creator: state.coinCreator,
      metadata: {
        pool, poolBaseAta: state.baseTokenAccount, poolQuoteAta: state.quoteTokenAccount,
        protocolFeeRecipient, coinCreator: state.coinCreator,
        reserves: { virtualBase: baseReserve, virtualQuote: quoteReserve },
        extraBuyAccounts: extraAccounts(meta.ammCashbackBuyAccounts), extraSellAccounts: extraAccounts(meta.ammCashbackSellAccounts),
      } satisfies PumpSwapMarketMeta,
    };
  }

  async quoteBuy(ctx: VenueContext, market: VenueMarket, amount: RawAmount, slippageBps: number): Promise<QuoteResult> {
    if (!sameAsset(market.quoteAsset, amount.asset)) throw new Error("Buy amount asset does not match PumpSwap quote asset");
    const reserves = (market.metadata as PumpSwapMarketMeta).reserves;
    const quote = quoteBuyConstantProduct(amount, reserves, slippageBps, configuredTotalFeeBps(ctx.token));
    return {
      venue: this.id,
      quoteAsset: market.quoteAsset,
      ...quote,
      meta: {
        protectionBasis: "program-base-output",
        note: "PumpSwap enforces min_base_amount_out inside the swap instruction. Token-2022 recipient transfer-fee inspection is intentionally not part of buy construction.",
      },
    };
  }

  async quoteSell(ctx: VenueContext, market: VenueMarket, amountRaw: bigint, slippageBps: number): Promise<QuoteResult> {
    const reserves = (market.metadata as PumpSwapMarketMeta).reserves;
    const value = quoteSellConstantProduct(amountRaw, reserves, slippageBps, configuredTotalFeeBps(ctx.token));
    return { venue: this.id, quoteAsset: market.quoteAsset, inputRaw: amountRaw, expectedOutputRaw: value.expectedOutputRaw, minimumOutputRaw: value.minimumOutputRaw };
  }

  async price(ctx: VenueContext, market: VenueMarket): Promise<MarketPrice> {
    const reserves = (market.metadata as PumpSwapMarketMeta).reserves;
    return {
      venue: this.id, mint: market.mint, quoteAsset: market.quoteAsset,
      priceQuotePerToken: spotPriceQuotePerToken(reserves, ctx.token.decimals ?? 6, market.quoteAsset.decimals),
      baseReserveRaw: reserves.virtualBase, quoteReserveRaw: reserves.virtualQuote, capturedAtMs: Date.now(),
    };
  }

  async buildBuy(ctx: VenueContext, market: VenueMarket, quote: QuoteResult): Promise<BuiltInstructions> {
    const m = market.metadata as PumpSwapMarketMeta;
    return {
      venue: this.id,
      quoteAsset: market.quoteAsset,
      instructions: buildPumpSwapBuyExactQuoteIn({
        pool: m.pool, globalConfig: ammGlobalConfigPda(), baseMint: market.mint, quote: market.quoteAsset,
        baseTokenProgram: market.baseTokenProgram, poolBaseAta: m.poolBaseAta, poolQuoteAta: m.poolQuoteAta,
        protocolFeeRecipient: m.protocolFeeRecipient, coinCreator: m.coinCreator, user: ctx.user,
        cashbackRemainingAccounts: m.extraBuyAccounts, spendableQuoteInRaw: quote.inputRaw,
        minBaseOutRaw: quote.minimumOutputRaw, trackVolume: true,
      }),
      minOutputRaw: quote.minimumOutputRaw,
      expectedOutputRaw: quote.expectedOutputRaw,
      meta: quote.meta,
    };
  }

  async buildSell(ctx: VenueContext, market: VenueMarket, quote: QuoteResult): Promise<BuiltInstructions> {
    const m = market.metadata as PumpSwapMarketMeta;
    return { venue: this.id, quoteAsset: market.quoteAsset,
      instructions: buildPumpSwapSell({
        pool: m.pool, globalConfig: ammGlobalConfigPda(), baseMint: market.mint, quote: market.quoteAsset,
        baseTokenProgram: market.baseTokenProgram, poolBaseAta: m.poolBaseAta, poolQuoteAta: m.poolQuoteAta,
        protocolFeeRecipient: m.protocolFeeRecipient, coinCreator: m.coinCreator, user: ctx.user,
        cashbackRemainingAccounts: m.extraSellAccounts, baseInRaw: quote.inputRaw, minQuoteOutRaw: quote.minimumOutputRaw,
      }), minOutputRaw: quote.minimumOutputRaw, expectedOutputRaw: quote.expectedOutputRaw };
  }
}
