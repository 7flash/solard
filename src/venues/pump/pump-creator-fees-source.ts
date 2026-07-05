import { PublicKey } from "@solana/web3.js";
import type {
  ClaimPlan,
  ClaimSourcePlugin,
  ClaimContext,
} from "../../claims/claim-source.js";
import {
  ata,
  ammCreatorVaultPda,
  creatorVaultPda,
  pumpSwapPoolPda,
  sharingConfigPda,
} from "./pda.js";
import { buildClaimInstructions } from "./claim-fees.js";
import { fetchCurve, fetchPool } from "./state.js";
import { fetchSharingConfig } from "./sharing-config.js";
import {
  poolQuoteAsset,
  spendableVaultLamports,
  tokenAccountAmount,
} from "./common.js";

/** Pump/PumpSwap creator revenue is a claim source, not a trade venue. */
export class PumpCreatorFeesSource implements ClaimSourcePlugin {
  readonly id = "pump-creator-fees";

  async resolveClaim(ctx: ClaimContext): Promise<ClaimPlan | null> {
    const curve = await fetchCurve(ctx.connection, ctx.token);
    if (!curve?.creator) return null;
    const mint = new PublicKey(ctx.token.mint);
    const sharing = await fetchSharingConfig(ctx.connection, mint);
    const shared = sharing != null;
    let quoteAsset = curve.quoteAsset;
    let coinCreator: PublicKey | undefined;
    let includeAmm = false;
    if (curve.complete) {
      const poolAddress = ctx.token.pool
        ? new PublicKey(ctx.token.pool)
        : pumpSwapPoolPda(mint, curve.quoteAsset.mint);
      const pool = await fetchPool(ctx.connection, poolAddress);
      quoteAsset = await poolQuoteAsset(
        ctx.connection,
        ctx.token,
        pool.quoteMint,
      );
      coinCreator = pool.coinCreator;
      includeAmm = true;
    }

    const vaultOwner = shared ? sharingConfigPda(mint) : curve.creator;
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
        );
      } catch {
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
        );
      } catch {
        /* no funded vault yet */
      }
    }

    // For sharing configs the AMM sweep runs before distribution. For SOL paired pools,
    // transfer_creator_fees_to_pump_v2 unwraps the AMM WSOL balance into the Pump vault,
    // so the shareholder distribution can fund a later SOL buy in the same transaction.
    const estimatedClaimRaw =
      pumpVaultRaw +
      (shared
        ? ammVaultRaw
        : quoteAsset.kind === "native-sol"
          ? 0n
          : ammVaultRaw);
    const userShare = sharing?.shareholders.find((holder) =>
      holder.address.equals(ctx.user),
    );
    const directToUser =
      !shared &&
      curve.creator.equals(ctx.user) &&
      (!coinCreator || coinCreator.equals(ctx.user));
    const spendableByUserRaw = shared
      ? userShare
        ? (estimatedClaimRaw * BigInt(userShare.shareBps)) / 10_000n
        : 0n
      : directToUser
        ? pumpVaultRaw
        : 0n;
    const nonSpendableClaimRaw = shared
      ? estimatedClaimRaw - spendableByUserRaw
      : quoteAsset.kind === "native-sol"
        ? ammVaultRaw
        : 0n;

    return {
      source: this.id,
      quoteAsset,
      instructions: buildClaimInstructions({
        token: ctx.token,
        caller: ctx.user,
        creator: curve.creator,
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
      meta: {
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
        payoutAddress: shared ? ctx.user.toBase58() : curve.creator.toBase58(),
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
