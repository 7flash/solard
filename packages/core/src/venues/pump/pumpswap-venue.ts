import { Buffer } from "buffer";
import BN from "bn.js";
import { OnlinePumpAmmSdk, PUMP_AMM_SDK } from "@pump-fun/pump-swap-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { sameAsset, type RawAmount } from "../../core/amounts.ts";
import type { TokenRow } from "../../db/schema.ts";
import type {
  BuiltInstructions,
  MarketPrice,
  QuoteResult,
  TradeVenuePlugin,
  VenueContext,
  VenueMarket,
} from "../venue-plugin.ts";
import { ammUserVolumeAccumulatorPda, ata, pumpSwapPoolPda } from "./pda.ts";
import {
  AMM_BUY_D8,
  AMM_BUY_EXACT_QUOTE_IN_D8,
  AMM_SELL_D8,
  PUMP_AMM_PROGRAM_ID,
  WRAPPED_SOL_MINT,
} from "./constants.ts";
import { spotPriceQuotePerToken } from "./quote.ts";
import { resolvePumpSwapProtocolFeeRecipient, tokenMeta } from "./routing.ts";
import { fetchCurve, fetchPool } from "./state.ts";
import { snapshotSwapState, validateLivePoolReserves } from "./live-reserves.ts";
import {
  extraAccounts,
  poolAssetsAndReserves,
  poolMintMetadata,
  tokenAccountAmount,
  type PumpSwapMarketMeta,
} from "./common.ts";

function writable(pubkey: PublicKey): AccountMeta {
  return { pubkey, isWritable: true, isSigner: false };
}

function cashbackRemainingAccounts(
  user: PublicKey,
  isCashbackCoin: boolean,
): { buy?: AccountMeta[]; sell?: AccountMeta[] } {
  if (!isCashbackCoin) return {};

  const accumulator = ammUserVolumeAccumulatorPda(user);
  const cashbackWsolAta = ata(
    WRAPPED_SOL_MINT,
    accumulator,
    TOKEN_PROGRAM_ID,
    true,
  );
  return {
    buy: [writable(cashbackWsolAta)],
    sell: [writable(cashbackWsolAta), writable(accumulator)],
  };
}

function sdkSlippagePercent(slippageBps: number): number {
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps >= 10_000
  ) {
    throw new Error(`Invalid slippage bps: ${slippageBps}`);
  }
  // Pump's SDK takes percentage points: 1 = 1%, while Solard uses bps.
  return slippageBps / 100;
}

function readU64(data: Buffer | Uint8Array, offset: number): bigint {
  const bytes = Buffer.from(data);
  if (bytes.length < offset + 8)
    throw new Error("PumpSwap instruction data is truncated");
  return bytes.readBigUInt64LE(offset);
}

function instructionDiscriminatorEquals(
  instruction: TransactionInstruction,
  discriminator: Buffer,
): boolean {
  return (
    instruction.programId.equals(PUMP_AMM_PROGRAM_ID) &&
    instruction.data.length >= 24 &&
    Buffer.from(instruction.data.subarray(0, 8)).equals(discriminator)
  );
}

function pumpTradeInstruction(
  instructions: TransactionInstruction[],
  discriminator: Buffer,
  label: string,
): TransactionInstruction {
  const instruction = instructions.find((candidate) =>
    instructionDiscriminatorEquals(candidate, discriminator),
  );
  if (!instruction)
    throw new Error(`PumpSwap SDK did not build ${label} instruction`);
  return instruction;
}

function systemTransferLamports(
  instruction: TransactionInstruction,
  from: PublicKey,
  to: PublicKey,
): bigint | null {
  if (!instruction.programId.equals(SystemProgram.programId)) return null;
  if (instruction.keys.length < 2) return null;
  if (!instruction.keys[0]!.pubkey.equals(from)) return null;
  if (!instruction.keys[1]!.pubkey.equals(to)) return null;
  const data = Buffer.from(instruction.data);
  // SystemInstruction::Transfer = enum variant 2 (u32 LE), followed by u64 lamports.
  if (data.length < 12 || data.readUInt32LE(0) !== 2) return null;
  return data.readBigUInt64LE(4);
}

function bpsFloor(value: bigint, keepBps: number): bigint {
  if (!Number.isInteger(keepBps) || keepBps < 0 || keepBps > 10_000) {
    throw new Error(`Invalid keep bps: ${keepBps}`);
  }
  return (value * BigInt(keepBps)) / 10_000n;
}

/**
 * Convert a ZERO-SLIPPAGE SDK quote-driven PumpSwap buy into the protocol's
 * exact-quote-input wire instruction.
 *
 * Why zero slippage?
 * PumpAmmSdk.buyQuoteInput historically emits legacy
 *   buy(base_out, max_quote_in)
 * where max_quote_in is the quote budget scaled UP by slippage. Reusing that
 * base_out as buy_exact_quote_in.min_base_out is invalid: it asks an exact
 * quote budget to buy the amount that the legacy path was allowed to spend
 * MORE quote to obtain.
 *
 * Instead, call the SDK with slippage=0. At zero slippage:
 *   - max_quote_in must equal the requested exact quote input
 *   - base_out is the SDK's authoritative current expected base output
 *
 * Solard then applies its own BPS slippage DOWN to that base output and encodes:
 *   buy_exact_quote_in(requested_quote_in, min_base_out)
 *
 * All SDK-selected setup/accounts remain unchanged.
 */
export function normalizeZeroSlippageSdkBuyToExactQuoteIn(args: {
  instructions: TransactionInstruction[];
  requestedQuoteInRaw: bigint;
  slippageBps: number;
  user: PublicKey;
  userQuoteTokenAccount: PublicKey;
  nativeQuote: boolean;
}): {
  instructions: TransactionInstruction[];
  expectedOutputRaw: bigint;
  minimumOutputRaw: bigint;
  sdkWire: "buy" | "buy_exact_quote_in";
} {
  if (args.requestedQuoteInRaw <= 0n)
    throw new Error("PumpSwap exact quote input must be positive");
  if (
    !Number.isInteger(args.slippageBps) ||
    args.slippageBps < 0 ||
    args.slippageBps >= 10_000
  ) {
    throw new Error(`Invalid slippage bps: ${args.slippageBps}`);
  }

  const exactIndex = args.instructions.findIndex((candidate) =>
    instructionDiscriminatorEquals(candidate, AMM_BUY_EXACT_QUOTE_IN_D8),
  );
  const legacyIndex = args.instructions.findIndex((candidate) =>
    instructionDiscriminatorEquals(candidate, AMM_BUY_D8),
  );

  if (exactIndex < 0 && legacyIndex < 0) {
    const observed = args.instructions
      .filter((candidate) => candidate.programId.equals(PUMP_AMM_PROGRAM_ID))
      .map((candidate) =>
        Buffer.from(candidate.data.subarray(0, 8)).toString("hex"),
      );
    throw new Error(
      `PumpSwap SDK did not build a recognized quote-driven buy instruction` +
        `${observed.length ? ` (AMM discriminators: ${observed.join(",")})` : ""}`,
    );
  }

  const tradeIndex = exactIndex >= 0 ? exactIndex : legacyIndex;
  const trade = args.instructions[tradeIndex]!;
  const sdkWire: "buy" | "buy_exact_quote_in" =
    exactIndex >= 0 ? "buy_exact_quote_in" : "buy";

  let expectedOutputRaw: bigint;

  if (sdkWire === "buy_exact_quote_in") {
    const sdkQuoteInRaw = readU64(trade.data, 8);
    expectedOutputRaw = readU64(trade.data, 16);
    if (sdkQuoteInRaw !== args.requestedQuoteInRaw) {
      throw new Error(
        `PumpSwap zero-slippage SDK exact-input changed quote amount: requested=${args.requestedQuoteInRaw} built=${sdkQuoteInRaw}`,
      );
    }
  } else {
    expectedOutputRaw = readU64(trade.data, 8);
    const zeroSlippageMaxQuoteInRaw = readU64(trade.data, 16);
    if (zeroSlippageMaxQuoteInRaw !== args.requestedQuoteInRaw) {
      throw new Error(
        `PumpSwap zero-slippage SDK legacy buy did not preserve quote budget: requested=${args.requestedQuoteInRaw} maxQuote=${zeroSlippageMaxQuoteInRaw}`,
      );
    }
  }

  if (expectedOutputRaw <= 0n)
    throw new Error("PumpSwap zero-slippage quote resolves to zero output");

  const minimumOutputRaw = bpsFloor(
    expectedOutputRaw,
    10_000 - args.slippageBps,
  );
  if (minimumOutputRaw <= 0n)
    throw new Error(
      "PumpSwap slippage-protected minimum resolves to zero output",
    );

  const exactData = Buffer.from(trade.data);
  AMM_BUY_EXACT_QUOTE_IN_D8.copy(exactData, 0);
  exactData.writeBigUInt64LE(args.requestedQuoteInRaw, 8);
  exactData.writeBigUInt64LE(minimumOutputRaw, 16);

  const normalized = args.instructions.map((instruction, index) =>
    index === tradeIndex
      ? new TransactionInstruction({
          programId: instruction.programId,
          keys: instruction.keys,
          data: exactData,
        })
      : instruction,
  );

  if (args.nativeQuote) {
    const funding = normalized
      .map((instruction, index) => ({
        index,
        lamports: systemTransferLamports(
          instruction,
          args.user,
          args.userQuoteTokenAccount,
        ),
      }))
      .filter(
        (row): row is { index: number; lamports: bigint } =>
          row.lamports != null,
      );

    if (funding.length !== 1) {
      throw new Error(
        `Expected exactly one PumpSwap WSOL funding transfer, found ${funding.length}`,
      );
    }
    if (funding[0]!.lamports !== args.requestedQuoteInRaw) {
      throw new Error(
        `PumpSwap zero-slippage WSOL funding does not equal exact quote budget: requested=${args.requestedQuoteInRaw} funding=${funding[0]!.lamports}`,
      );
    }
  }

  return {
    instructions: normalized,
    expectedOutputRaw,
    minimumOutputRaw,
    sdkWire,
  };
}

async function freshSdkBuy(
  ctx: VenueContext,
  market: VenueMarket,
  inputRaw: bigint,
  slippageBps: number,
): Promise<{
  instructions: TransactionInstruction[];
  minimumOutputRaw: bigint;
  expectedOutputRaw: bigint;
  sdkWire: "buy" | "buy_exact_quote_in";
}> {
  const m = market.metadata as PumpSwapMarketMeta;
  const online = new OnlinePumpAmmSdk(ctx.connection);
  const swapState = ctx.reserves ? await snapshotSwapState(ctx, market) : await online.swapSolanaState(m.pool, ctx.user);

  // Quote the exact budget with ZERO SDK slippage. The legacy SDK expresses
  // slippage by increasing maxQuoteIn, which cannot be translated directly to
  // buy_exact_quote_in. Solard applies its BPS protection to base output below.
  const sdkInstructions = await PUMP_AMM_SDK.buyQuoteInput(
    swapState,
    new BN(inputRaw.toString()),
    0,
  );

  return normalizeZeroSlippageSdkBuyToExactQuoteIn({
    instructions: sdkInstructions,
    requestedQuoteInRaw: inputRaw,
    slippageBps,
    user: ctx.user,
    userQuoteTokenAccount: swapState.userQuoteTokenAccount,
    nativeQuote: market.quoteAsset.kind === "native-sol",
  });
}

function expectedFromMinimum(
  minimumOutputRaw: bigint,
  slippageBps: number,
): bigint {
  const keptBps = 10_000 - slippageBps;
  if (keptBps <= 0) return minimumOutputRaw;
  const denominator = BigInt(keptBps);
  return (minimumOutputRaw * 10_000n + denominator - 1n) / denominator;
}

async function freshSdkSell(
  ctx: VenueContext,
  market: VenueMarket,
  inputRaw: bigint,
  slippageBps: number,
): Promise<{
  instructions: TransactionInstruction[];
  minimumOutputRaw: bigint;
  expectedOutputRaw: bigint;
}> {
  const m = market.metadata as PumpSwapMarketMeta;
  const online = new OnlinePumpAmmSdk(ctx.connection);
  const swapState = ctx.reserves ? await snapshotSwapState(ctx, market) : await online.swapSolanaState(m.pool, ctx.user);
  const instructions = await PUMP_AMM_SDK.sellBaseInput(
    swapState,
    new BN(inputRaw.toString()),
    sdkSlippagePercent(slippageBps),
  );
  const trade = pumpTradeInstruction(instructions, AMM_SELL_D8, "Sell");
  const baseInRaw = readU64(trade.data, 8);
  const minimumOutputRaw = readU64(trade.data, 16);
  if (baseInRaw !== inputRaw) {
    throw new Error(
      `PumpSwap SDK changed sell input: requested=${inputRaw} built=${baseInRaw}`,
    );
  }
  if (minimumOutputRaw <= 0n)
    throw new Error("PumpSwap SDK sell quote resolves to zero output");
  return {
    instructions,
    minimumOutputRaw,
    expectedOutputRaw: expectedFromMinimum(minimumOutputRaw, slippageBps),
  };
}

function quoteSlippageBps(quote: QuoteResult): number {
  const value = quote.meta?.slippageBps;
  return typeof value === "number" && Number.isInteger(value) ? value : 1_500;
}

/** Canonical PumpSwap AMM only. It is a separate swappable venue plugin from the launch curve. */
export class PumpSwapVenue implements TradeVenuePlugin {
  readonly id = "pumpswap";

  async inspectToken(connection: VenueContext["connection"], mint: PublicKey): Promise<Partial<TokenRow> | null> {
    const pools = await connection.getProgramAccounts(PUMP_AMM_PROGRAM_ID, {
      commitment: "confirmed", filters: [{ memcmp: { offset: 43, bytes: mint.toBase58() } }],
    });
    const verified = await Promise.all(pools.map(async ({ pubkey }) => fetchPool(connection, pubkey)));
    const solPools = verified.filter((pool) => pool.baseMint.equals(mint) && pool.quoteMint.equals(WRAPPED_SOL_MINT));
    const ranked = await Promise.all(solPools.map(async (pool) => ({ pool,
      quoteReserve: await tokenAccountAmount(connection, pool.quoteTokenAccount, TOKEN_PROGRAM_ID, WRAPPED_SOL_MINT) })));
    ranked.sort((a, b) => a.quoteReserve === b.quoteReserve ? a.pool.address.toBase58().localeCompare(b.pool.address.toBase58()) : a.quoteReserve > b.quoteReserve ? -1 : 1);
    const solPool = ranked.find((row) => row.quoteReserve > 0n)?.pool;
    const selected = solPool ?? (verified.length === 1 ? verified[0] : null);
    if (!selected) return null;
    if (!selected.baseMint.equals(mint)) throw new Error("PumpSwap discovery base mint mismatch");
    const quote = await poolMintMetadata(connection, selected.quoteMint);
    return { venueHint: this.id, pool: selected.address.toBase58(),
      quoteMint: selected.quoteMint.toBase58(), quoteTokenProgram: quote.tokenProgram.toBase58(),
      metadataJson: JSON.stringify({ quoteDecimals: quote.decimals }), refreshedAtMs: Date.now() };
  }

  async resolveMarket(ctx: VenueContext): Promise<VenueMarket | null> {
    if (ctx.token.venueHint && !["unknown", "pump-curve", "pumpswap"].includes(ctx.token.venueHint)) return null;
    const curve = ctx.token.pool ? null : await fetchCurve(ctx.connection, ctx.token);
    if (!ctx.token.pool && !curve?.complete) return null;
    const mint = new PublicKey(ctx.token.mint);
    const pool = ctx.token.pool
      ? new PublicKey(ctx.token.pool)
      : pumpSwapPoolPda(mint, curve!.quoteAsset.mint);
    const state = await fetchPool(ctx.connection, pool);
    if (!state.baseMint.equals(mint))
      throw new Error(
        `Configured PumpSwap pool does not contain token ${ctx.token.mint}`,
      );
    if (curve && !state.quoteMint.equals(curve.quoteAsset.mint)) {
      throw new Error(
        `PumpSwap pool ${pool.toBase58()} quote mint ${state.quoteMint.toBase58()} does not match curve quote ${curve.quoteAsset.mint.toBase58()}`,
      );
    }
    if (ctx.reserves) validateLivePoolReserves(ctx.reserves, { pool, baseMint: state.baseMint, quoteMint: state.quoteMint });
    const { baseMintState, quoteAsset, baseReserve, rawQuoteReserve } = await poolAssetsAndReserves(ctx.connection, state, ctx.reserves);
    const baseTokenProgram = baseMintState.tokenProgram;
    const effectiveQuoteReserve = rawQuoteReserve + state.virtualQuoteReserves;
    if (baseReserve <= 0n || effectiveQuoteReserve <= 0n) {
      throw new Error(
        `Invalid PumpSwap reserves for ${pool.toBase58()}: base=${baseReserve} rawQuote=${rawQuoteReserve} virtualQuote=${state.virtualQuoteReserves}`,
      );
    }
    const meta = tokenMeta(ctx.token);
    const protocolFeeRecipient = await resolvePumpSwapProtocolFeeRecipient(
      ctx.connection,
      mint,
      state.isMayhemMode,
      typeof meta.protocolFeeRecipient === "string"
        ? meta.protocolFeeRecipient
        : (
            globalThis as {
              process?: { env?: Record<string, string | undefined> };
            }
          ).process?.env?.PUMPSWAP_PROTOCOL_FEE_RECIPIENT,
    );
    const cashback = cashbackRemainingAccounts(ctx.user, state.isCashbackCoin);
    return {
      venue: this.id,
      mint,
      quoteAsset,
      baseTokenProgram,
      creator: state.coinCreator,
      metadata: {
        pool,
        baseDecimals: baseMintState.decimals,
        poolBaseAta: state.baseTokenAccount,
        poolQuoteAta: state.quoteTokenAccount,
        protocolFeeRecipient,
        coinCreator: state.coinCreator,
        rawQuoteReserve,
        virtualQuoteReserves: state.virtualQuoteReserves,
        reserves: {
          virtualBase: baseReserve,
          virtualQuote: effectiveQuoteReserve,
        },
        // Retained for Solard metadata/debugging. Live PumpSwap trade instructions
        // below are built by the official SDK from freshly fetched chain state.
        extraBuyAccounts:
          cashback.buy ?? extraAccounts(meta.ammCashbackBuyAccounts),
        extraSellAccounts:
          cashback.sell ?? extraAccounts(meta.ammCashbackSellAccounts),
      } satisfies PumpSwapMarketMeta,
    };
  }

  async quoteBuy(
    ctx: VenueContext,
    market: VenueMarket,
    amount: RawAmount,
    slippageBps: number,
  ): Promise<QuoteResult> {
    if (!sameAsset(market.quoteAsset, amount.asset))
      throw new Error("Buy amount asset does not match PumpSwap quote asset");

    // Authoritative quote/build math comes from Pump's current SDK, including
    // fee_config and Pool.virtual_quote_reserves. This intentionally replaces
    // Solard's historical fixed-fee constant-product approximation for PumpSwap.
    const fresh = await freshSdkBuy(ctx, market, amount.raw, slippageBps);
    return {
      venue: this.id,
      quoteAsset: market.quoteAsset,
      inputRaw: amount.raw,
      expectedOutputRaw: fresh.expectedOutputRaw,
      minimumOutputRaw: fresh.minimumOutputRaw,
      meta: {
        protectionBasis: "program-base-output",
        quoteSource: "@pump-fun/pump-swap-sdk",
        sdkWire: fresh.sdkWire,
        slippageBps,
        note: "PumpSwap SDK supplies current pool/fee pricing and accounts; Solard normalizes quote-driven buys to the protocol buy_exact_quote_in wire instruction.",
      },
    };
  }

  async quoteSell(
    ctx: VenueContext,
    market: VenueMarket,
    amountRaw: bigint,
    slippageBps: number,
  ): Promise<QuoteResult> {
    const fresh = await freshSdkSell(ctx, market, amountRaw, slippageBps);
    return {
      venue: this.id,
      quoteAsset: market.quoteAsset,
      inputRaw: amountRaw,
      expectedOutputRaw: fresh.expectedOutputRaw,
      minimumOutputRaw: fresh.minimumOutputRaw,
      meta: {
        quoteSource: "@pump-fun/pump-swap-sdk",
        slippageBps,
      },
    };
  }

  async price(ctx: VenueContext, market: VenueMarket): Promise<MarketPrice> {
    const reserves = (market.metadata as PumpSwapMarketMeta).reserves;
    return {
      venue: this.id,
      mint: market.mint,
      quoteAsset: market.quoteAsset,
      priceQuotePerToken: spotPriceQuotePerToken(
        reserves,
        Number(market.metadata.baseDecimals),
        market.quoteAsset.decimals,
      ),
      baseReserveRaw: reserves.virtualBase,
      quoteReserveRaw: reserves.virtualQuote,
      capturedAtMs: Date.now(),
    };
  }

  async buildBuy(
    ctx: VenueContext,
    market: VenueMarket,
    quote: QuoteResult,
  ): Promise<BuiltInstructions> {
    // Re-fetch immediately before transaction construction. If the pool moved
    // after quoteBuy(), this replaces the stale minimum instead of carrying it
    // into simulation and tripping PumpSwap 6040.
    const slippageBps = quoteSlippageBps(quote);
    const fresh = await freshSdkBuy(ctx, market, quote.inputRaw, slippageBps);
    quote.expectedOutputRaw = fresh.expectedOutputRaw;
    quote.minimumOutputRaw = fresh.minimumOutputRaw;
    quote.meta = {
      ...(quote.meta ?? {}),
      refreshedAtBuild: true,
      sdkWireAtBuild: fresh.sdkWire,
    };
    return {
      venue: this.id,
      quoteAsset: market.quoteAsset,
      instructions: fresh.instructions,
      minOutputRaw: fresh.minimumOutputRaw,
      expectedOutputRaw: fresh.expectedOutputRaw,
      meta: quote.meta,
    };
  }

  async buildSell(
    ctx: VenueContext,
    market: VenueMarket,
    quote: QuoteResult,
  ): Promise<BuiltInstructions> {
    const slippageBps = quoteSlippageBps(quote);
    const fresh = await freshSdkSell(ctx, market, quote.inputRaw, slippageBps);
    quote.expectedOutputRaw = fresh.expectedOutputRaw;
    quote.minimumOutputRaw = fresh.minimumOutputRaw;
    quote.meta = {
      ...(quote.meta ?? {}),
      refreshedAtBuild: true,
    };
    return {
      venue: this.id,
      quoteAsset: market.quoteAsset,
      instructions: fresh.instructions,
      minOutputRaw: fresh.minimumOutputRaw,
      expectedOutputRaw: fresh.expectedOutputRaw,
      meta: quote.meta,
    };
  }
}
