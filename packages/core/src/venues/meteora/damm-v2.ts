import BN from "bn.js";
import { PublicKey, type Connection } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import {
  CpAmm,
  CP_AMM_PROGRAM_ID,
  SwapMode,
  getPriceFromSqrtPrice,
  getCurrentPoint,
  getTokenProgram,
  type PoolState,
} from "@meteora-ag/cp-amm-sdk";
import { readMint } from "../../chain/state.ts";
import { sameAsset, type RawAmount } from "../../core/amounts.ts";
import type { TokenRow } from "../../db/schema.ts";
import { poolQuoteAsset, tokenAccountAmount } from "../pump/common.ts";
import { WRAPPED_SOL_MINT } from "../pump/constants.ts";
import type {
  TradeVenuePlugin,
  VenueContext,
  VenueMarket,
  QuoteResult,
  BuiltInstructions,
  MarketPrice,
} from "../venue-plugin.ts";

export { CP_AMM_PROGRAM_ID };
const clients = new WeakMap<Connection, CpAmm>();
export function dammV2Client(connection: Connection): CpAmm {
  let client = clients.get(connection);
  if (!client) {
    client = new CpAmm(connection);
    clients.set(connection, client);
  }
  return client;
}
export type DammV2MarketState = {
  pool: PublicKey;
  state: PoolState;
  decimalsA: number;
  decimalsB: number;
  reserveA: bigint;
  reserveB: bigint;
};
export async function readDammV2Market(
  connection: Connection,
  pool: PublicKey,
): Promise<DammV2MarketState> {
  const account = await connection.getAccountInfo(pool, "confirmed");
  if (!account || !account.owner.equals(CP_AMM_PROGRAM_ID))
    throw new Error("Invalid Meteora DAMM v2 pool owner");
  const state = dammV2Client(
    connection,
  )._program.coder.accounts.decode<PoolState>("pool", account.data);
  const [mintA, mintB] = await Promise.all([
    readMint(connection, state.tokenAMint),
    readMint(connection, state.tokenBMint),
  ]);
  if (
    !mintA.tokenProgram.equals(getTokenProgram(state.tokenAFlag)) ||
    !mintB.tokenProgram.equals(getTokenProgram(state.tokenBFlag))
  )
    throw new Error(
      "Meteora DAMM v2 mint program does not match pool token flags",
    );
  const [reserveA, reserveB] = await Promise.all([
    tokenAccountAmount(
      connection,
      state.tokenAVault,
      mintA.tokenProgram,
      state.tokenAMint,
    ),
    tokenAccountAmount(
      connection,
      state.tokenBVault,
      mintB.tokenProgram,
      state.tokenBMint,
    ),
  ]);
  return {
    pool,
    state,
    decimalsA: mintA.decimals,
    decimalsB: mintB.decimals,
    reserveA,
    reserveB,
  };
}
export function dammV2Price(
  market: DammV2MarketState,
  baseMint: PublicKey,
  sqrtPrice = market.state.sqrtPrice,
): number {
  const priceBPerA = getPriceFromSqrtPrice(
    sqrtPrice,
    market.decimalsA,
    market.decimalsB,
  ).toNumber();
  const price = market.state.tokenAMint.equals(baseMint)
    ? priceBPerA
    : 1 / priceBPerA;
  if (!Number.isFinite(price) || price <= 0)
    throw new Error("Invalid Meteora DAMM v2 price");
  return price;
}
export class MeteoraDammV2Venue implements TradeVenuePlugin {
  readonly id = "meteora-damm-v2";
  private async discover(
    connection: Connection,
    mint: PublicKey,
  ): Promise<PublicKey | null> {
    const pools =
      await dammV2Client(connection).fetchPoolStatesByTokenMint(mint);
    const active = pools.filter(
      ({ account }) => account.poolStatus === 0 && !account.liquidity.isZero(),
    );
    const solPools = active.filter(
      ({ account }) =>
        account.tokenAMint.equals(WRAPPED_SOL_MINT) ||
        account.tokenBMint.equals(WRAPPED_SOL_MINT),
    );
    const candidates = solPools.length
      ? solPools
      : active.length === 1
        ? active
        : [];
    candidates.sort((a, b) => b.account.liquidity.cmp(a.account.liquidity));
    return candidates[0]?.publicKey ?? null;
  }
  async inspectToken(
    connection: Connection,
    mint: PublicKey,
  ): Promise<Partial<TokenRow> | null> {
    const pool = await this.discover(connection, mint);
    if (!pool) return null;
    const market = await readDammV2Market(connection, pool);
    const quoteMint = market.state.tokenAMint.equals(mint)
      ? market.state.tokenBMint
      : market.state.tokenAMint;
    if (
      !market.state.tokenAMint.equals(mint) &&
      !market.state.tokenBMint.equals(mint)
    )
      throw new Error("Meteora DAMM v2 discovery mint mismatch");
    const quote = await readMint(connection, quoteMint);
    return {
      venueHint: this.id,
      pool: pool.toBase58(),
      quoteMint: quoteMint.toBase58(),
      quoteTokenProgram: quote.tokenProgram.toBase58(),
      metadataJson: JSON.stringify({ quoteDecimals: quote.decimals }),
      refreshedAtMs: Date.now(),
    };
  }
  async resolveMarket(ctx: VenueContext): Promise<VenueMarket | null> {
    if (![this.id, "meteora-dbc"].includes(ctx.token.venueHint)) return null;
    const mint = new PublicKey(ctx.token.mint);
    const pool =
      ctx.token.venueHint === this.id && ctx.token.pool
        ? new PublicKey(ctx.token.pool)
        : await this.discover(ctx.connection, mint);
    if (!pool) return null;
    const market = await readDammV2Market(ctx.connection, pool);
    if (
      !market.state.tokenAMint.equals(mint) &&
      !market.state.tokenBMint.equals(mint)
    )
      throw new Error("Meteora DAMM v2 pool mint mismatch");
    if (market.state.poolStatus !== 0 || market.state.liquidity.isZero())
      throw new Error("Meteora DAMM v2 pool is inactive");
    const baseIsA = market.state.tokenAMint.equals(mint);
    const quoteMint = baseIsA
      ? market.state.tokenBMint
      : market.state.tokenAMint;
    return {
      venue: this.id,
      mint,
      quoteAsset: await poolQuoteAsset(ctx.connection, ctx.token, quoteMint),
      baseTokenProgram: getTokenProgram(
        baseIsA ? market.state.tokenAFlag : market.state.tokenBFlag,
      ),
      creator: market.state.creator,
      metadata: { dammV2: market },
    };
  }
  private async quote(
    ctx: VenueContext,
    market: VenueMarket,
    inputRaw: bigint,
    slippageBps: number,
    sell: boolean,
  ): Promise<QuoteResult> {
    if (
      inputRaw <= 0n ||
      !Number.isInteger(slippageBps) ||
      slippageBps < 0 ||
      slippageBps >= 10_000
    )
      throw new Error("Invalid Meteora DAMM v2 amount/slippage");
    const data = market.metadata.dammV2 as DammV2MarketState;
    const inputMint = sell ? market.mint : market.quoteAsset.mint;
    const outputMint = sell ? market.quoteAsset.mint : market.mint;
    const currentEpoch = (await ctx.connection.getEpochInfo("confirmed")).epoch;
    const [inputInfo, outputInfo] = await Promise.all([
      getMint(
        ctx.connection,
        inputMint,
        "confirmed",
        inputMint.equals(data.state.tokenAMint)
          ? getTokenProgram(data.state.tokenAFlag)
          : getTokenProgram(data.state.tokenBFlag),
      ),
      getMint(
        ctx.connection,
        outputMint,
        "confirmed",
        outputMint.equals(data.state.tokenAMint)
          ? getTokenProgram(data.state.tokenAFlag)
          : getTokenProgram(data.state.tokenBFlag),
      ),
    ]);
    const quote = dammV2Client(ctx.connection).getQuote2({
      swapMode: SwapMode.ExactIn,
      amountIn: new BN(inputRaw.toString()),
      inputTokenMint: inputMint,
      slippage: slippageBps,
      poolState: data.state,
      currentPoint: await getCurrentPoint(
        ctx.connection,
        data.state.activationType,
      ),
      inputTokenInfo: { mint: inputInfo, currentEpoch },
      outputTokenInfo: { mint: outputInfo, currentEpoch },
      tokenADecimal: data.decimalsA,
      tokenBDecimal: data.decimalsB,
      hasReferral: false,
    });
    if (
      !quote.includedFeeInputAmount.eq(new BN(inputRaw.toString())) ||
      !quote.amountLeft.isZero()
    )
      throw new Error("Meteora DAMM v2 partial fill refused");
    const minimumOutputRaw = BigInt(quote.minimumAmountOut?.toString() ?? "0");
    if (minimumOutputRaw <= 0n)
      throw new Error("Meteora DAMM v2 has zero protected output");
    return {
      venue: this.id,
      quoteAsset: market.quoteAsset,
      inputRaw,
      minimumOutputRaw,
      expectedOutputRaw: BigInt(quote.outputAmount.toString()),
    };
  }
  async quoteBuy(
    ctx: VenueContext,
    market: VenueMarket,
    input: RawAmount,
    slippageBps: number,
  ): Promise<QuoteResult> {
    if (!sameAsset(input.asset, market.quoteAsset))
      throw new Error("Meteora DAMM v2 quote asset mismatch");
    return this.quote(ctx, market, input.raw, slippageBps, false);
  }
  async quoteSell(
    ctx: VenueContext,
    market: VenueMarket,
    inputRaw: bigint,
    slippageBps: number,
  ): Promise<QuoteResult> {
    return this.quote(ctx, market, inputRaw, slippageBps, true);
  }
  async price(_ctx: VenueContext, market: VenueMarket): Promise<MarketPrice> {
    const data = market.metadata.dammV2 as DammV2MarketState;
    return {
      venue: this.id,
      mint: market.mint,
      quoteAsset: market.quoteAsset,
      priceQuotePerToken: dammV2Price(data, market.mint),
      capturedAtMs: Date.now(),
      baseReserveRaw: data.state.tokenAMint.equals(market.mint)
        ? data.reserveA
        : data.reserveB,
      quoteReserveRaw: data.state.tokenAMint.equals(market.mint)
        ? data.reserveB
        : data.reserveA,
    };
  }
  private async build(
    ctx: VenueContext,
    market: VenueMarket,
    quote: QuoteResult,
    sell: boolean,
  ): Promise<BuiltInstructions> {
    const data = market.metadata.dammV2 as DammV2MarketState;
    const transaction = await dammV2Client(ctx.connection).swap2({
      payer: ctx.user,
      pool: data.pool,
      swapMode: SwapMode.ExactIn,
      inputTokenMint: sell ? market.mint : market.quoteAsset.mint,
      outputTokenMint: sell ? market.quoteAsset.mint : market.mint,
      amountIn: new BN(quote.inputRaw.toString()),
      minimumAmountOut: new BN(quote.minimumOutputRaw.toString()),
      tokenAMint: data.state.tokenAMint,
      tokenBMint: data.state.tokenBMint,
      tokenAVault: data.state.tokenAVault,
      tokenBVault: data.state.tokenBVault,
      tokenAProgram: getTokenProgram(data.state.tokenAFlag),
      tokenBProgram: getTokenProgram(data.state.tokenBFlag),
      referralTokenAccount: null,
      poolState: data.state,
    });
    return {
      venue: this.id,
      quoteAsset: market.quoteAsset,
      instructions: transaction.instructions,
      minOutputRaw: quote.minimumOutputRaw,
      expectedOutputRaw: quote.expectedOutputRaw,
    };
  }
  async buildBuy(
    ctx: VenueContext,
    market: VenueMarket,
    quote: QuoteResult,
  ): Promise<BuiltInstructions> {
    return this.build(ctx, market, quote, false);
  }
  async buildSell(
    ctx: VenueContext,
    market: VenueMarket,
    quote: QuoteResult,
  ): Promise<BuiltInstructions> {
    return this.build(ctx, market, quote, true);
  }
}
