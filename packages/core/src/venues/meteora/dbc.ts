import BN from "bn.js";
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  DynamicBondingCurveClient, DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  getCurrentPoint, getPriceFromSqrtPrice, getTokenProgram, SwapMode,
  type VirtualPool, type PoolConfig,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { readMint } from "../../chain/state.ts";
import { sameAsset, type RawAmount } from "../../core/amounts.ts";
import type { TokenRow } from "../../db/schema.ts";
import { poolQuoteAsset, tokenAccountAmount } from "../pump/common.ts";
import type { VenueContext, VenueMarket, TradeVenuePlugin, QuoteResult, BuiltInstructions, MarketPrice } from "../venue-plugin.ts";

export { DYNAMIC_BONDING_CURVE_PROGRAM_ID };
const clients = new WeakMap<Connection, DynamicBondingCurveClient>();
export function dbcClient(connection: Connection): DynamicBondingCurveClient {
  let client = clients.get(connection);
  if (!client) {
    client = new DynamicBondingCurveClient(connection, "confirmed");
    clients.set(connection, client);
  }
  return client;
}

export type DbcMarketState = {
  pool: PublicKey;
  virtualPool: VirtualPool;
  config: PoolConfig;
  baseDecimals: number;
  quoteDecimals: number;
  supplyRaw: bigint;
};

export async function readDbcMarket(connection: Connection, pool: PublicKey): Promise<DbcMarketState> {
  const account = await connection.getAccountInfo(pool, "confirmed");
  if (!account || !account.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))
    throw new Error(`Invalid Meteora DBC pool owner: ${pool.toBase58()}`);
  const client = dbcClient(connection);
  // Decode only the regular pool variant. Transfer-hook execution requires its
  // dedicated SDK builder and extra accounts, rather than the ordinary swap.
  const virtualPool = client.state.getProgram().coder.accounts.decode<VirtualPool>("virtualPool", account.data);
  const configAccount = await connection.getAccountInfo(virtualPool.poolState.config, "confirmed");
  if (!configAccount || !configAccount.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))
    throw new Error("Invalid Meteora DBC config owner");
  const config = client.state.getProgram().coder.accounts.decode<PoolConfig>("poolConfig", configAccount.data);
  const state = virtualPool.poolState;
  const [base, quote] = await Promise.all([readMint(connection, state.baseMint), readMint(connection, config.quoteMint)]);
  if (!base.tokenProgram.equals(getTokenProgram(state.poolType)) || !quote.tokenProgram.equals(getTokenProgram(config.quoteTokenFlag)))
    throw new Error("Meteora DBC mint program does not match pool/config token flags");
  await Promise.all([
    tokenAccountAmount(connection, state.baseVault, base.tokenProgram, state.baseMint),
    tokenAccountAmount(connection, state.quoteVault, quote.tokenProgram, config.quoteMint),
  ]);
  return { pool, virtualPool, config, baseDecimals: base.decimals, quoteDecimals: quote.decimals, supplyRaw: base.supply };
}

export function dbcPrice(state: DbcMarketState, sqrtPrice = state.virtualPool.poolState.sqrtPrice): number {
  const price = getPriceFromSqrtPrice(sqrtPrice, state.baseDecimals, state.quoteDecimals).toNumber();
  if (!Number.isFinite(price) || price <= 0) throw new Error("Invalid Meteora DBC price");
  return price;
}

export class MeteoraDbcVenue implements TradeVenuePlugin {
  readonly id = "meteora-dbc";
  async inspectToken(connection: Connection, mint: PublicKey): Promise<Partial<TokenRow> | null> {
    const discovered = await dbcClient(connection).state.getPoolByBaseMint(mint);
    if (!discovered) return null;
    const state = await readDbcMarket(connection, discovered.publicKey);
    if (state.virtualPool.poolState.isMigrated) return null;
    if (!state.virtualPool.poolState.baseMint.equals(mint)) throw new Error("Meteora DBC discovery base mint mismatch");
    return {
      pool: state.pool.toBase58(), venueHint: this.id,
      quoteMint: state.config.quoteMint.toBase58(),
      quoteTokenProgram: getTokenProgram(state.config.quoteTokenFlag).toBase58(),
      metadataJson: JSON.stringify({ quoteDecimals: state.quoteDecimals }),
      refreshedAtMs: Date.now(),
    };
  }
  async resolveMarket(ctx: VenueContext): Promise<VenueMarket | null> {
    if (ctx.token.venueHint !== this.id) return null;
    if (!ctx.token.pool) throw new Error("Meteora DBC token has no configured pool");
    const state = await readDbcMarket(ctx.connection, new PublicKey(ctx.token.pool));
    if (!state.virtualPool.poolState.baseMint.equals(new PublicKey(ctx.token.mint)))
      throw new Error("Meteora DBC pool base mint mismatch");
    if (state.virtualPool.poolState.isMigrated) return null;
    if (state.virtualPool.poolState.migrationProgress)
      throw new Error("Meteora DBC pool has graduated; select its migrated market");
    return {
      venue: this.id, mint: state.virtualPool.poolState.baseMint,
      quoteAsset: await poolQuoteAsset(ctx.connection, ctx.token, state.config.quoteMint),
      baseTokenProgram: getTokenProgram(state.virtualPool.poolState.poolType),
      creator: state.virtualPool.poolState.creator, metadata: { dbc: state },
    };
  }
  private async quote(ctx: VenueContext, market: VenueMarket, amountRaw: bigint, slippageBps: number, sell: boolean): Promise<QuoteResult> {
    if (amountRaw <= 0n || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000)
      throw new Error("Invalid Meteora DBC swap amount/slippage");
    const state = market.metadata.dbc as DbcMarketState;
    const quoted = dbcClient(ctx.connection).pool.swapQuote2({
      virtualPool: state.virtualPool, config: state.config, swapBaseForQuote: sell,
      swapMode: SwapMode.ExactIn, amountIn: new BN(amountRaw.toString()), slippageBps, hasReferral: false,
      eligibleForFirstSwapWithMinFee: false,
      currentPoint: await getCurrentPoint(ctx.connection, state.config.activationType),
    });
    if (!quoted.includedFeeInputAmount.eq(new BN(amountRaw.toString())) || !quoted.amountLeft.isZero())
      throw new Error("Meteora DBC would partially fill this trade; exact input required");
    const minimumOutputRaw = BigInt(quoted.minimumAmountOut?.toString() ?? "0");
    if (minimumOutputRaw <= 0n) throw new Error("Meteora DBC quote has zero protected output");
    return { venue: this.id, quoteAsset: market.quoteAsset, inputRaw: amountRaw,
      expectedOutputRaw: BigInt(quoted.outputAmount.toString()), minimumOutputRaw,
      meta: { nextSqrtPrice: quoted.nextSqrtPrice.toString(), swapMode: "exact-in" } };
  }
  async quoteBuy(ctx: VenueContext, market: VenueMarket, amount: RawAmount, slippageBps: number): Promise<QuoteResult> {
    if (!sameAsset(amount.asset, market.quoteAsset)) throw new Error("Meteora DBC buy quote asset mismatch");
    return this.quote(ctx, market, amount.raw, slippageBps, false);
  }
  async quoteSell(ctx: VenueContext, market: VenueMarket, amountRaw: bigint, slippageBps: number): Promise<QuoteResult> {
    return this.quote(ctx, market, amountRaw, slippageBps, true);
  }
  async price(_ctx: VenueContext, market: VenueMarket): Promise<MarketPrice> {
    const state = market.metadata.dbc as DbcMarketState;
    return { venue: this.id, mint: market.mint, quoteAsset: market.quoteAsset,
      priceQuotePerToken: dbcPrice(state), capturedAtMs: Date.now(),
      baseReserveRaw: BigInt(state.virtualPool.poolState.baseReserve.toString()),
      quoteReserveRaw: BigInt(state.virtualPool.poolState.quoteReserve.toString()) };
  }
  private async build(ctx: VenueContext, market: VenueMarket, quote: QuoteResult, sell: boolean): Promise<BuiltInstructions> {
    const state = market.metadata.dbc as DbcMarketState;
    const transaction = await dbcClient(ctx.connection).pool.swap2({
      owner: ctx.user, payer: ctx.user, pool: state.pool,
      swapMode: SwapMode.ExactIn, amountIn: new BN(quote.inputRaw.toString()), minimumAmountOut: new BN(quote.minimumOutputRaw.toString()),
      swapBaseForQuote: sell, referralTokenAccount: null,
    });
    return { venue: this.id, quoteAsset: market.quoteAsset, instructions: transaction.instructions,
      minOutputRaw: quote.minimumOutputRaw, expectedOutputRaw: quote.expectedOutputRaw };
  }
  async buildBuy(ctx: VenueContext, market: VenueMarket, quote: QuoteResult): Promise<BuiltInstructions> { return this.build(ctx, market, quote, false); }
  async buildSell(ctx: VenueContext, market: VenueMarket, quote: QuoteResult): Promise<BuiltInstructions> { return this.build(ctx, market, quote, true); }
}
