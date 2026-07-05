import { type Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import {
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
  buyQuoteInput,
  canonicalPumpPoolPda,
  sellBaseInput,
} from "@pump-fun/pump-swap-sdk";
import { OnlinePumpSdk, hasCoinCreatorMigratedToSharingConfig } from "@pump-fun/pump-sdk";
import {
  SPL_TOKEN_PROGRAM_ID,
  WRAPPED_SOL_MINT,
} from "../core/constants.ts";
import {
  cloneCurve,
  quoteBuyExactSolIn,
  quoteSellExactTokenIn,
} from "../core/curve.ts";
import { userVolumeAccumulatorPda } from "../core/pda.ts";
import { fetchCurve, readTokenBalanceRaw, resolveTokenProgram } from "../chain/state.ts";
import { resolveRouting } from "./routing.ts";
import { ataCreateIx } from "./spl.ts";
import {
  buildBuyExactQuoteInV2Ix,
  buildBuyExactSolInIx,
  buildSellExactTokenInIx,
  buildSellV2Ix,
} from "./pump.ts";

export type CreateKind = "create" | "create_v2";

export type BuiltInstructions<M = Record<string, unknown>> = {
  instructions: TransactionInstruction[];
  /** Venue the trade routes through. */
  venue: "curve" | "amm";
  meta: M;
};

const DEFAULT_FEE_BPS = 200;
const DEFAULT_SLIPPAGE_BPS = 1500;

// --- BUY --------------------------------------------------------------------

export async function buildBuyInstructions(args: {
  connection: Connection;
  mint: PublicKey;
  user: PublicKey;
  /** Lamports of SOL to spend. */
  spendLamports: bigint;
  createKind?: CreateKind;
  slippageBps?: number;
  quoteTotalFeeBps?: number;
  trackVolume?: boolean;
  forceV2?: boolean;
}): Promise<BuiltInstructions<{ minTokensOut: bigint; tokensOut: bigint }>> {
  const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const curve = await fetchCurve({ connection: args.connection, mint: args.mint });

  // Migrated → trade on the AMM pool.
  if (curve.complete) {
    const sdk = new OnlinePumpAmmSdk(args.connection);
    const pool = canonicalPumpPoolPda(args.mint);
    const swapState = await sdk.swapSolanaState(pool, args.user);
    const quote = buyQuoteInput({
      quote: new BN(args.spendLamports.toString()),
      slippage: slippageBps / 100,
      baseReserve: swapState.poolBaseAmount,
      quoteReserve: swapState.poolQuoteAmount,
      globalConfig: swapState.globalConfig,
      baseMintAccount: swapState.baseMintAccount,
      baseMint: swapState.baseMint,
      coinCreator: swapState.pool.coinCreator,
      creator: swapState.pool.creator,
      feeConfig: swapState.feeConfig,
    });
    if (quote.base.lten(0)) throw new Error("AMM buy quote returned zero");
    const instructions = await PUMP_AMM_SDK.buyInstructions(swapState, quote.base, quote.maxQuote);
    const expected = BigInt(quote.base.toString());
    // The pool can move between quote and execution, so the realised base out
    // can be below `quote.base`. Expose a slippage-discounted floor as the
    // guaranteed-min so a same-tx forward never tries to move more than landed.
    const guaranteedMin = (expected * BigInt(10_000 - slippageBps)) / 10_000n;
    return {
      instructions,
      venue: "amm",
      meta: { minTokensOut: guaranteedMin, tokensOut: expected },
    };
  }

  // On the bonding curve.
  const baseTokenProgram = await resolveTokenProgram({
    connection: args.connection,
    mint: args.mint,
    createKindFallback: args.createKind,
  });
  const quote = quoteBuyExactSolIn({
    spendableSolIn: args.spendLamports,
    curve: cloneCurve(curve),
    totalFeeBps: args.quoteTotalFeeBps ?? DEFAULT_FEE_BPS,
    slippageBps,
  });
  if (quote.minTokensOut <= 0n) throw new Error("Curve buy quote returned zero");

  const { ix: baseAta } = ataCreateIx({
    payer: args.user,
    owner: args.user,
    mint: args.mint,
    tokenProgram: baseTokenProgram,
  });

  const useV2 = args.forceV2 || args.createKind === "create_v2";
  const instructions: TransactionInstruction[] = [baseAta];

  if (useV2) {
    const routing = resolveRouting({
      mint: args.mint,
      creator: curve.creator,
      isMayhemMode: curve.isMayhemMode,
      quoteMint: WRAPPED_SOL_MINT,
      quoteTokenProgram: SPL_TOKEN_PROGRAM_ID,
    });
    instructions.push(
      buildBuyExactQuoteInV2Ix({
        baseMint: args.mint,
        baseTokenProgram,
        user: args.user,
        feeRecipient: routing.feeRecipient,
        associatedQuoteFeeRecipient: routing.associatedQuoteFeeRecipient,
        buybackFeeRecipient: routing.buybackFeeRecipient,
        associatedQuoteBuybackFeeRecipient: routing.associatedQuoteBuybackFeeRecipient,
        creatorVault: routing.creatorVault,
        associatedCreatorVault: routing.associatedCreatorVault,
        spendableQuoteIn: args.spendLamports,
        minTokensOut: quote.minTokensOut,
      }),
    );
  } else {
    const routing = resolveRouting({
      mint: args.mint,
      creator: curve.creator,
      isMayhemMode: curve.isMayhemMode,
      quoteMint: WRAPPED_SOL_MINT,
      quoteTokenProgram: SPL_TOKEN_PROGRAM_ID,
    });
    instructions.push(
      buildBuyExactSolInIx({
        mint: args.mint,
        user: args.user,
        creator: curve.creator,
        feeRecipient: routing.feeRecipient,
        spendableSolIn: args.spendLamports,
        minTokensOut: quote.minTokensOut,
        trackVolume: args.trackVolume ?? true,
      }),
    );
  }

  return {
    instructions,
    venue: "curve",
    meta: { minTokensOut: quote.minTokensOut, tokensOut: quote.tokensOut },
  };
}

// --- SELL -------------------------------------------------------------------

export async function buildSellInstructions(args: {
  connection: Connection;
  mint: PublicKey;
  user: PublicKey;
  /** Basis points of the wallet's token balance to sell. */
  tokenBps: number;
  createKind?: CreateKind;
  slippageBps?: number;
  quoteTotalFeeBps?: number;
  trackVolume?: boolean;
}): Promise<BuiltInstructions<{ tokenAmountIn: bigint; minSolOut: bigint }>> {
  const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const curve = await fetchCurve({ connection: args.connection, mint: args.mint });
  const balance = await readTokenBalanceRaw({ connection: args.connection, owner: args.user, mint: args.mint.toBase58() });
  const tokenAmountIn = (balance.amountRaw * BigInt(args.tokenBps)) / 10_000n;
  if (tokenAmountIn <= 0n) throw new Error("Nothing to sell (zero balance or bps)");

  if (curve.complete) {
    const sdk = new OnlinePumpAmmSdk(args.connection);
    const pool = canonicalPumpPoolPda(args.mint);
    const swapState = await sdk.swapSolanaState(pool, args.user);
    const quote = sellBaseInput({
      base: new BN(tokenAmountIn.toString()),
      slippage: slippageBps / 100,
      baseReserve: swapState.poolBaseAmount,
      quoteReserve: swapState.poolQuoteAmount,
      globalConfig: swapState.globalConfig,
      baseMintAccount: swapState.baseMintAccount,
      baseMint: swapState.baseMint,
      coinCreator: swapState.pool.coinCreator,
      creator: swapState.pool.creator,
      feeConfig: swapState.feeConfig,
    });
    if (quote.minQuote.lten(0)) throw new Error("AMM sell quote returned zero");
    const instructions = await PUMP_AMM_SDK.sellInstructions(swapState, new BN(tokenAmountIn.toString()), quote.minQuote);
    return {
      instructions,
      venue: "amm",
      meta: { tokenAmountIn, minSolOut: BigInt(quote.minQuote.toString()) },
    };
  }

  const tokenProgram = await resolveTokenProgram({
    connection: args.connection,
    mint: args.mint,
    createKindFallback: args.createKind,
  });
  const quote = quoteSellExactTokenIn({
    tokenAmountIn,
    curve: cloneCurve(curve),
    totalFeeBps: args.quoteTotalFeeBps ?? DEFAULT_FEE_BPS,
    slippageBps,
  });
  if (quote.minSolOut <= 0n) throw new Error("Curve sell quote returned zero");

  const routing = resolveRouting({
    mint: args.mint,
    creator: curve.creator,
    isMayhemMode: curve.isMayhemMode,
    quoteMint: WRAPPED_SOL_MINT,
    quoteTokenProgram: SPL_TOKEN_PROGRAM_ID,
  });

  const instructions: TransactionInstruction[] = [];

  if (args.createKind === "create_v2") {
    // v2 sell settles to WSOL ATAs that may not exist yet.
    for (const owner of [
      args.user,
      routing.feeRecipient,
      routing.buybackFeeRecipient,
      routing.creatorVault,
      userVolumeAccumulatorPda(args.user),
    ]) {
      const offCurve = !owner.equals(args.user);
      instructions.push(
        ataCreateIx({
          payer: args.user,
          owner,
          mint: WRAPPED_SOL_MINT,
          tokenProgram: SPL_TOKEN_PROGRAM_ID,
          allowOwnerOffCurve: offCurve,
        }).ix,
      );
    }
    instructions.push(
      buildSellV2Ix({
        baseMint: args.mint,
        baseTokenProgram: tokenProgram,
        user: args.user,
        feeRecipient: routing.feeRecipient,
        associatedQuoteFeeRecipient: routing.associatedQuoteFeeRecipient,
        buybackFeeRecipient: routing.buybackFeeRecipient,
        associatedQuoteBuybackFeeRecipient: routing.associatedQuoteBuybackFeeRecipient,
        creatorVault: routing.creatorVault,
        associatedCreatorVault: routing.associatedCreatorVault,
        tokenAmountIn,
        minQuoteOut: quote.minSolOut,
      }),
    );
  } else {
    instructions.push(
      buildSellExactTokenInIx({
        mint: args.mint,
        user: args.user,
        creator: curve.creator,
        feeRecipient: routing.feeRecipient,
        buybackFeeRecipient: routing.buybackFeeRecipient,
        tokenProgram,
        exactTokenIn: tokenAmountIn,
        minSolOut: quote.minSolOut,
        trackVolume: args.trackVolume ?? true,
      }),
    );
  }

  return { instructions, venue: "curve", meta: { tokenAmountIn, minSolOut: quote.minSolOut } };
}

// --- CLAIM (creator fees) ---------------------------------------------------

export async function buildClaimInstructions(args: {
  connection: Connection;
  mint: PublicKey;
  /** The wallet that created the token / owns the creator fees. */
  creator: PublicKey;
  minClaimLamports?: bigint;
}): Promise<BuiltInstructions<{ claimableLamports: bigint; sharing: boolean }>> {
  const sdk = new OnlinePumpSdk(args.connection);
  const minClaim = args.minClaimLamports ?? 0n;
  const sharing = hasCoinCreatorMigratedToSharingConfig({ mint: args.mint, creator: args.creator });

  if (sharing) {
    const distributable = await sdk.getMinimumDistributableFee(args.mint);
    const claimable = BigInt(distributable.distributableFees.toString());
    if (!distributable.canDistribute || claimable < minClaim) {
      return { instructions: [], venue: "curve", meta: { claimableLamports: claimable, sharing } };
    }
    const built = await sdk.buildDistributeCreatorFeesInstructions(args.mint);
    return { instructions: built.instructions, venue: "curve", meta: { claimableLamports: claimable, sharing } };
  }

  const balance = await sdk.getCreatorVaultBalanceBothPrograms(args.creator);
  const claimable = BigInt(balance.toString());
  if (claimable < minClaim) {
    return { instructions: [], venue: "curve", meta: { claimableLamports: claimable, sharing } };
  }
  const instructions = await sdk.collectCoinCreatorFeeInstructions(args.creator, args.creator);
  return { instructions, venue: "curve", meta: { claimableLamports: claimable, sharing } };
}
