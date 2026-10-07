import { PublicKey } from "@solana/web3.js";
import { TokenAccountNotFoundError } from "@solana/spl-token";
import type {
  ClaimPlan,
  ClaimSourcePlugin,
  ClaimContext,
} from "../../claims/claim-source.ts";
import {
  ata,
  ammCreatorVaultPda,
  creatorVaultPda,
  pumpSwapPoolPda,
  sharingConfigPda,
} from "./pda.ts";
import { buildClaimInstructions } from "./claim-fees.ts";
import { fetchCurve, fetchPool } from "./state.ts";
import { fetchSharingConfig } from "./sharing-config.ts";
import {
  poolQuoteAsset,
  spendableVaultLamports,
  tokenAccountAmount,
} from "./common.ts";

/** Pump/PumpSwap creator revenue is a claim source, not a trade venue. */
export class PumpCreatorFeesSource implements ClaimSourcePlugin {
  readonly id = "pump-creator-fees";

  async resolveClaim(ctx: ClaimContext): Promise<ClaimPlan | null> {
    const curve = await fetchCurve(ctx.connection, ctx.token);
    const mint = new PublicKey(ctx.token.mint);
    if (!curve?.creator && !ctx.token.pool) return null;
    const sharing = await fetchSharingConfig(ctx.connection, mint);
    const shared = sharing != null;
    let quoteAsset = curve?.quoteAsset;
    let creator = curve?.creator ?? undefined;
    let coinCreator: PublicKey | undefined;
    let includeAmm = false;
    if (!curve || curve.complete || ctx.token.venueHint === "pumpswap") {
      const poolAddress = ctx.token.pool
        ? new PublicKey(ctx.token.pool)
        : pumpSwapPoolPda(mint, curve!.quoteAsset.mint);
      const pool = await fetchPool(ctx.connection, poolAddress);
      if (!pool.baseMint.equals(mint)) throw new Error("Creator-fee pool base mint mismatch");
      quoteAsset = await poolQuoteAsset(
        ctx.connection,
        ctx.token,
        pool.quoteMint,
      );
      coinCreator = pool.coinCreator;
      creator ??= pool.coinCreator;
      includeAmm = true;
    }
    if (!creator || !quoteAsset) return null;
    const userShare = sharing?.shareholders.find((holder) => holder.address.equals(ctx.user));
    if (shared ? !userShare : !creator.equals(ctx.user) && !coinCreator?.equals(ctx.user)) return null;
    if (shared && coinCreator && !coinCreator.equals(sharingConfigPda(mint)))
      throw new Error("PumpSwap fee creator does not match sharing configuration");

    const vaultOwner = shared ? sharingConfigPda(mint) : creator;
    let pumpVaultRaw = 0n;
    let ammVaultRaw = 0n;
    if (quoteAsset.kind === "native-sol") {
      pumpVaultRaw = await spendableVaultLamports(
        ctx.connection,
        creatorVaultPda(vaultOwner),
      );
    } else {
      const vaultAta = ata(
        quoteAsset.mint,
        creatorVaultPda(vaultOwner),
        quoteAsset.tokenProgram,
        true,
      );
      try {
        pumpVaultRaw = await tokenAccountAmount(
          ctx.connection,
          vaultAta,
          quoteAsset.tokenProgram,
          quoteAsset.mint,
        );
      } catch (error) {
        if (!(error instanceof TokenAccountNotFoundError)) throw error;
        /* no funded vault yet */
      }
    }
    if (includeAmm && coinCreator) {
      const ammVaultAta = ata(
        quoteAsset.mint,
        ammCreatorVaultPda(coinCreator),
        quoteAsset.tokenProgram,
        true,
      );
      try {
        ammVaultRaw = await tokenAccountAmount(
          ctx.connection,
          ammVaultAta,
          quoteAsset.tokenProgram,
          quoteAsset.mint,
        );
      } catch (error) {
        if (!(error instanceof TokenAccountNotFoundError)) throw error;
        /* no funded vault yet */
      }
    }

    // For sharing configs the AMM sweep runs before distribution. For SOL paired pools,
    // transfer_creator_fees_to_pump_v2 unwraps the AMM WSOL balance into the Pump vault,
    // so the shareholder distribution can fund a later SOL buy in the same transaction.
    const eligiblePumpRaw = shared || creator.equals(ctx.user) ? pumpVaultRaw : 0n;
    const eligibleAmmRaw = shared || coinCreator?.equals(ctx.user) ? ammVaultRaw : 0n;
    const estimatedClaimRaw = eligiblePumpRaw + eligibleAmmRaw;
    const spendableByUserRaw = shared
      ? userShare
        ? (estimatedClaimRaw * BigInt(userShare.shareBps)) / 10_000n
        : 0n
      : eligiblePumpRaw + (quoteAsset.kind === "spl-token" ? eligibleAmmRaw : 0n);
    const nonSpendableClaimRaw = shared
      ? estimatedClaimRaw - spendableByUserRaw
      : quoteAsset.kind === "native-sol"
        ? ammVaultRaw
        : 0n;
    const payouts = shared
      ? (sharing?.shareholders ?? []).map((holder) => ({
          address: holder.address,
          shareBps: holder.shareBps,
        }))
      : [
          { address: creator, shareBps: null },
          ...(includeAmm && coinCreator && !coinCreator.equals(creator)
            ? [{ address: coinCreator, shareBps: null }]
            : []),
        ];

    return {
      source: this.id,
      quoteAsset,
      instructions: buildClaimInstructions({
        token: ctx.token,
        caller: ctx.user,
        creator,
        quote: quoteAsset,
        includeAmm,
        sharingConfig: shared,
        coinCreator,
        shareholderAddresses: sharing?.shareholders.map(
          (holder) => holder.address,
        ),
      }),
      estimatedClaimRaw,
      spendableByUserRaw,
      payouts,
      meta: {
        eligibility: shared ? "shareholder" : "creator",
        attribution: shared ? "mint-sharing-vault" : "shared-creator-vault",
        claimComponents: [
          { key: `pump:${creatorVaultPda(vaultOwner).toBase58()}:${quoteAsset.mint.toBase58()}`, amountRaw: (shared ? eligiblePumpRaw * BigInt(userShare!.shareBps) / 10_000n : eligiblePumpRaw).toString(), spendableRaw: (shared ? eligiblePumpRaw * BigInt(userShare!.shareBps) / 10_000n : eligiblePumpRaw).toString() },
          ...(coinCreator ? [{ key: `pumpswap:${ammCreatorVaultPda(coinCreator).toBase58()}:${quoteAsset.mint.toBase58()}`, amountRaw: (shared ? eligibleAmmRaw * BigInt(userShare!.shareBps) / 10_000n : eligibleAmmRaw).toString(), spendableRaw: (shared ? eligibleAmmRaw * BigInt(userShare!.shareBps) / 10_000n : quoteAsset.kind === "native-sol" ? 0n : eligibleAmmRaw).toString() }] : []),
        ],
        path: shared
          ? "sharing-config"
          : includeAmm
            ? "direct-curve-and-amm"
            : "direct-curve",
        sharingConfig: shared,
        includeAmm,
        pumpVaultRaw: pumpVaultRaw.toString(),
        ammVaultRaw: ammVaultRaw.toString(),
        nonSpendableClaimRaw: nonSpendableClaimRaw.toString(),
        payoutAddress:
          payouts.length === 1 ? payouts[0]!.address.toBase58() : null,
        payoutAddresses: payouts.map((row) => row.address.toBase58()),
        spendableByUser: spendableByUserRaw > 0n,
        userShareBps: userShare?.shareBps ?? null,
        shareholders:
          sharing?.shareholders.map((holder) => ({
            address: holder.address.toBase58(),
            shareBps: holder.shareBps,
          })) ?? null,
      },
    };
  }
}
