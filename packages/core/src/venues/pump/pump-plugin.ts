import { getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey, type AccountMeta } from "@solana/web3.js";
import {
  SOL_ASSET,
  sameAsset,
  type QuoteAsset,
  type RawAmount,
} from "../../core/amounts.ts";
import { resolveTokenProgram } from "../../chain/state.ts";
import type { TokenRow } from "../../db/schema.ts";
import type {
  BuiltInstructions,
  QuoteResult,
  VenueContext,
  VenueMarket,
  VenuePlugin,
} from "../venue-plugin.ts";
import { WRAPPED_SOL_MINT } from "./constants.ts";
import {
  ata,
  ammCreatorVaultPda,
  ammGlobalConfigPda,
  creatorVaultPda,
  pumpSwapPoolPda,
  sharingConfigPda,
} from "./pda.ts";
import { buildClaimInstructions } from "./claim-fees.ts";
import { buildCurveBuyV2, buildCurveSellV2 } from "./pump-instructions.ts";
import {
  buildPumpSwapBuy,
  buildPumpSwapSell,
} from "./pumpswap-instructions.ts";
import { quoteBuyConstantProduct, quoteSellConstantProduct } from "./quote.ts";
import {
  resolvePumpRouting,
  resolvePumpSwapProtocolFeeRecipient,
  tokenMeta,
} from "./routing.ts";
import {
  defaultTokenProgram,
  fetchCurve,
  fetchPool,
  hasSharingConfig,
} from "./state.ts";

type MarketMeta = {
  curve?: Awaited<ReturnType<typeof fetchCurve>>;
  pool?: PublicKey;
  poolBaseAta?: PublicKey;
  poolQuoteAta?: PublicKey;
  protocolFeeRecipient?: PublicKey;
  coinCreator?: PublicKey;
  reserves?: { virtualBase: bigint; virtualQuote: bigint };
  extraBuyAccounts?: AccountMeta[];
  extraSellAccounts?: AccountMeta[];
  sharingConfig?: boolean;
};
async function poolQuoteAsset(
  connection: Connection,
  token: TokenRow,
  quoteMint: PublicKey,
): Promise<QuoteAsset> {
  if (quoteMint.equals(WRAPPED_SOL_MINT)) return SOL_ASSET;
  const metadata = tokenMeta(token);
  const program = token.quoteTokenProgram
    ? new PublicKey(token.quoteTokenProgram)
    : await resolveTokenProgram(connection, quoteMint);
  return {
    kind: "spl-token",
    mint: quoteMint,
    tokenProgram: program,
    decimals:
      typeof metadata.quoteDecimals === "number" ? metadata.quoteDecimals : 6,
  };
}
function publicKey(value: unknown): PublicKey | undefined {
  return typeof value === "string" ? new PublicKey(value) : undefined;
}
function configuredTotalFeeBps(token: TokenRow): number {
  const value = tokenMeta(token).totalFeeBps;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value >= 10_000
  )
    return 200;
  return value;
}
function extras(value: unknown): AccountMeta[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    const row = item as {
      address: string;
      writable?: boolean;
      signer?: boolean;
    };
    return {
      pubkey: new PublicKey(row.address),
      isWritable: row.writable === true,
      isSigner: row.signer === true,
    };
  });
}
async function tokenAccountAmount(
  connection: Connection,
  address: PublicKey,
  tokenProgram: PublicKey,
): Promise<bigint> {
  return (await getAccount(connection, address, "confirmed", tokenProgram))
    .amount;
}
async function spendableVaultLamports(
  connection: Connection,
  address: PublicKey,
): Promise<bigint> {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) return 0n;
  const rent = BigInt(
    await connection.getMinimumBalanceForRentExemption(info.data.length),
  );
  const lamports = BigInt(info.lamports);
  return lamports > rent ? lamports - rent : 0n;
}

export class PumpPlugin implements VenuePlugin {
  readonly id = "pump";

  async inspectToken(
    connection: Connection,
    mint: PublicKey,
  ): Promise<Partial<TokenRow> | null> {
    const now = Date.now();
    const shell = {
      mint: mint.toBase58(),
      name: null,
      symbol: null,
      decimals: null,
      createKind: "unknown" as const,
      creator: null,
      quoteMint: WRAPPED_SOL_MINT.toBase58(),
      quoteTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
      baseTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
      bondingCurve: null,
      pool: null,
      sharingConfig: null,
      venueHint: "unknown" as const,
      metadataJson: null,
      refreshedAtMs: now,
      createdAtMs: now,
      updatedAtMs: now,
      id: 0,
    };
    const curve = await fetchCurve(connection, shell);
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
    if (!curve) return null;
    const baseTokenProgram = defaultTokenProgram(ctx.token);
    if (!curve.complete) {
      return {
        venue: "pump-curve",
        mint: new PublicKey(ctx.token.mint),
        quoteAsset: curve.quoteAsset,
        baseTokenProgram,
        creator: curve.creator,
        metadata: { curve },
      };
    }
    const meta = tokenMeta(ctx.token);
    const pool = ctx.token.pool
      ? new PublicKey(ctx.token.pool)
      : pumpSwapPoolPda(new PublicKey(ctx.token.mint), curve.quoteAsset.mint);
    const state = await fetchPool(ctx.connection, pool);
    const mint = new PublicKey(ctx.token.mint);
    if (!state.baseMint.equals(mint))
      throw new Error(
        `Configured PumpSwap pool does not contain token ${ctx.token.mint}`,
      );
    const quote = await poolQuoteAsset(
      ctx.connection,
      ctx.token,
      state.quoteMint,
    );
    const [baseReserve, quoteReserve] = await Promise.all([
      tokenAccountAmount(
        ctx.connection,
        state.baseTokenAccount,
        baseTokenProgram,
      ),
      tokenAccountAmount(
        ctx.connection,
        state.quoteTokenAccount,
        quote.tokenProgram,
      ),
    ]);
    const protocolFeeRecipient = await resolvePumpSwapProtocolFeeRecipient(
      ctx.connection,
      mint,
      state.isMayhemMode,
      typeof meta.protocolFeeRecipient === "string"
        ? meta.protocolFeeRecipient
        : process.env.PUMPSWAP_PROTOCOL_FEE_RECIPIENT,
    );
    return {
      venue: "pumpswap",
      mint,
      quoteAsset: quote,
      baseTokenProgram,
      creator: state.coinCreator,
      metadata: {
        pool,
        poolBaseAta: state.baseTokenAccount,
        poolQuoteAta: state.quoteTokenAccount,
        protocolFeeRecipient,
        coinCreator: state.coinCreator,
        reserves: { virtualBase: baseReserve, virtualQuote: quoteReserve },
        extraBuyAccounts: extras(meta.ammCashbackBuyAccounts),
        extraSellAccounts: extras(meta.ammCashbackSellAccounts),
      } satisfies MarketMeta,
    };
  }

  async quoteBuy(
    ctx: VenueContext,
    market: VenueMarket,
    amount: RawAmount,
    slippageBps: number,
  ): Promise<QuoteResult> {
    if (!sameAsset(market.quoteAsset, amount.asset))
      throw new Error("Buy amount asset does not match market quote asset");
    const meta = market.metadata as MarketMeta;
    const reserves =
      market.venue === "pump-curve"
        ? (meta.curve! as NonNullable<MarketMeta["curve"]>)
        : meta.reserves!;
    const value = quoteBuyConstantProduct(
      amount,
      {
        virtualBase: reserves.virtualBase,
        virtualQuote: reserves.virtualQuote,
      },
      slippageBps,
      configuredTotalFeeBps(ctx.token),
    );
    return { venue: market.venue, quoteAsset: market.quoteAsset, ...value };
  }
  async quoteSell(
    ctx: VenueContext,
    market: VenueMarket,
    amountRaw: bigint,
    slippageBps: number,
  ): Promise<QuoteResult> {
    const meta = market.metadata as MarketMeta;
    const reserves =
      market.venue === "pump-curve"
        ? (meta.curve! as NonNullable<MarketMeta["curve"]>)
        : meta.reserves!;
    const value = quoteSellConstantProduct(
      amountRaw,
      {
        virtualBase: reserves.virtualBase,
        virtualQuote: reserves.virtualQuote,
      },
      slippageBps,
      configuredTotalFeeBps(ctx.token),
    );
    return {
      venue: market.venue,
      quoteAsset: market.quoteAsset,
      inputRaw: amountRaw,
      expectedOutputRaw: value.expectedOutputRaw,
      minimumOutputRaw: value.minimumOutputRaw,
    };
  }
  async buildBuy(
    ctx: VenueContext,
    market: VenueMarket,
    quote: QuoteResult,
  ): Promise<BuiltInstructions> {
    if (market.venue === "pump-curve") {
      if (!market.creator)
        throw new Error(
          "Pump curve creator is unknown; refresh token metadata first",
        );
      const routing = await resolvePumpRouting(
        ctx.connection,
        ctx.token,
        market.creator,
        market.quoteAsset,
        Boolean((market.metadata as MarketMeta).curve?.isMayhemMode),
      );
      return {
        venue: market.venue,
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
    const m = market.metadata as MarketMeta;
    return {
      venue: market.venue,
      quoteAsset: market.quoteAsset,
      instructions: buildPumpSwapBuy({
        pool: m.pool!,
        globalConfig: ammGlobalConfigPda(),
        baseMint: market.mint,
        quote: market.quoteAsset,
        baseTokenProgram: market.baseTokenProgram,
        poolBaseAta: m.poolBaseAta!,
        poolQuoteAta: m.poolQuoteAta!,
        protocolFeeRecipient: m.protocolFeeRecipient!,
        coinCreator: m.coinCreator!,
        user: ctx.user,
        cashbackRemainingAccounts: m.extraBuyAccounts,
        baseOutRaw: quote.minimumOutputRaw,
        maxQuoteInRaw: quote.inputRaw,
        trackVolume: true,
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
    if (market.venue === "pump-curve") {
      if (!market.creator)
        throw new Error(
          "Pump curve creator is unknown; refresh token metadata first",
        );
      const routing = await resolvePumpRouting(
        ctx.connection,
        ctx.token,
        market.creator,
        market.quoteAsset,
        Boolean((market.metadata as MarketMeta).curve?.isMayhemMode),
      );
      return {
        venue: market.venue,
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
    const m = market.metadata as MarketMeta;
    return {
      venue: market.venue,
      quoteAsset: market.quoteAsset,
      instructions: buildPumpSwapSell({
        pool: m.pool!,
        globalConfig: ammGlobalConfigPda(),
        baseMint: market.mint,
        quote: market.quoteAsset,
        baseTokenProgram: market.baseTokenProgram,
        poolBaseAta: m.poolBaseAta!,
        poolQuoteAta: m.poolQuoteAta!,
        protocolFeeRecipient: m.protocolFeeRecipient!,
        coinCreator: m.coinCreator!,
        user: ctx.user,
        cashbackRemainingAccounts: m.extraSellAccounts,
        baseInRaw: quote.inputRaw,
        minQuoteOutRaw: quote.minimumOutputRaw,
      }),
      minOutputRaw: quote.minimumOutputRaw,
      expectedOutputRaw: quote.expectedOutputRaw,
    };
  }
  async buildClaimFees(
    ctx: VenueContext,
    market: VenueMarket,
  ): Promise<BuiltInstructions> {
    if (!market.creator)
      throw new Error("Cannot claim creator fees without a resolved creator");
    const shared =
      Boolean(ctx.token.sharingConfig) ||
      (await hasSharingConfig(ctx.connection, market.mint));
    const coinCreator =
      market.venue === "pumpswap"
        ? ((market.metadata as MarketMeta).coinCreator ?? undefined)
        : undefined;
    let estimatedClaimRaw = 0n;
    let nonSpendableClaimRaw = 0n;
    const meta = tokenMeta(ctx.token);
    const claimCreator = shared
      ? sharingConfigPda(market.mint)
      : market.creator;
    if (market.quoteAsset.kind === "native-sol") {
      estimatedClaimRaw += await spendableVaultLamports(
        ctx.connection,
        creatorVaultPda(claimCreator),
      );
    } else {
      const vaultAta = ata(
        market.quoteAsset.mint,
        creatorVaultPda(claimCreator),
        market.quoteAsset.tokenProgram,
        true,
      );
      try {
        estimatedClaimRaw += await tokenAccountAmount(
          ctx.connection,
          vaultAta,
          market.quoteAsset.tokenProgram,
        );
      } catch {
        /* empty vault */
      }
    }
    if (market.venue === "pumpswap" && coinCreator) {
      const ammVaultAta = ata(
        market.quoteAsset.mint,
        ammCreatorVaultPda(coinCreator),
        market.quoteAsset.tokenProgram,
        true,
      );
      try {
        const ammClaimRaw = await tokenAccountAmount(
          ctx.connection,
          ammVaultAta,
          market.quoteAsset.tokenProgram,
        );
        // SOL-paired PumpSwap collections land as WSOL. They are claimable, but cannot
        // finance a native-SOL buy in the same atomic flow until an explicit unwrap
        // or WSOL-funded route is selected. Never overstate usable native budget.
        if (market.quoteAsset.kind === "native-sol")
          nonSpendableClaimRaw += ammClaimRaw;
        else estimatedClaimRaw += ammClaimRaw;
      } catch {
        /* empty vault */
      }
    }
    const instructions = buildClaimInstructions({
      token: ctx.token,
      caller: ctx.user,
      creator: market.creator,
      quote: market.quoteAsset,
      includeAmm: market.venue === "pumpswap",
      sharingConfig: shared,
      coinCreator,
    });
    const directDestinationMatchesUser =
      !shared &&
      market.creator.equals(ctx.user) &&
      (coinCreator == null || coinCreator.equals(ctx.user));
    return {
      venue: market.venue,
      quoteAsset: market.quoteAsset,
      instructions,
      estimatedClaimRaw,
      meta: {
        sharingConfig: shared,
        payoutAddress: shared ? null : market.creator.toBase58(),
        spendableByUser: directDestinationMatchesUser,
        nonSpendableClaimRaw: nonSpendableClaimRaw.toString(),
      },
    };
  }
}
