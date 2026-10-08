import {
  PublicKey,
  type TransactionInstruction,
  type AccountInfo,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  NATIVE_MINT,
} from "@solana/spl-token";
import {
  LAUNCHPAD_PROGRAM,
  CREATE_CPMM_POOL_PROGRAM,
  LaunchpadPool,
  CpmmPoolInfoLayout,
  getPdaLaunchpadPoolId,
  getPdaCreatorVault,
  getPdaCreatorFeeVaultAuth,
  claimCreatorFee,
  getPdaPoolAuthority,
  makeCollectCreatorFeeInstruction,
  getLaunchpadPoolMintBProgram,
} from "@raydium-io/raydium-sdk-v2";
import { readMint } from "../chain/state.ts";
import type {
  ClaimSourcePlugin,
  ClaimContext,
  ClaimPlan,
} from "./claim-source.ts";
import type { QuoteAsset } from "../core/amounts.ts";

// Both official Anchor programs name their account PoolState:
// https://github.com/raydium-io/raydium-cpi/blob/master/programs/launch-cpi/src/states.rs
// https://github.com/raydium-io/raydium-cp-swap/blob/master/programs/cp-swap/src/states/pool.rs
const poolDiscriminator = createHash("sha256")
  .update("account:PoolState")
  .digest()
  .subarray(0, 8);
function assertPoolAccount(data: Buffer, span: number): void {
  if (
    data.length < span ||
    !data.subarray(0, poolDiscriminator.length).equals(poolDiscriminator)
  )
    throw new Error("Invalid Raydium creator-fee pool discriminator or size");
}

/** Official Raydium builders; LaunchLab vaults and CPMM counters are independent. */
export class RaydiumCreatorFeesSource implements ClaimSourcePlugin {
  readonly id = "raydium-creator-fees";
  async resolveClaim(ctx: ClaimContext): Promise<ClaimPlan | null> {
    const mint = new PublicKey(ctx.token.mint);
    const quoteMint = new PublicKey(
      ctx.token.quoteMint ?? NATIVE_MINT.toBase58(),
    );
    const launch = getPdaLaunchpadPoolId(
      LAUNCHPAD_PROGRAM,
      mint,
      quoteMint,
    ).publicKey;
    const launchInfo = await ctx.connection.getAccountInfo(launch, "confirmed");
    const instructions: Array<TransactionInstruction> = [];
    const components: Array<{
      key: string;
      amountRaw: string;
      spendableRaw: string;
      quoteMint: string;
      quoteDecimals: number;
    }> = [];
    let asset: QuoteAsset | null = null;
    let estimate = 0n;
    async function tokenAsset(key: PublicKey): Promise<QuoteAsset> {
      const info = await readMint(ctx.connection, key);
      return {
        kind: "spl-token",
        mint: key,
        decimals: info.decimals,
        tokenProgram: info.tokenProgram,
      };
    }
    if (launchInfo?.owner.equals(LAUNCHPAD_PROGRAM)) {
      assertPoolAccount(launchInfo.data, LaunchpadPool.span);
      const pool = LaunchpadPool.decode(launchInfo.data);
      if (!pool.mintA.equals(mint) || !pool.mintB.equals(quoteMint))
        throw new Error("LaunchLab creator-fee mint mismatch");
      if (pool.creator.equals(ctx.user)) {
        asset = await tokenAsset(pool.mintB);
        if (
          !asset.tokenProgram.equals(
            getLaunchpadPoolMintBProgram(pool.mintProgramFlag),
          )
        )
          throw new Error("LaunchLab creator-fee quote program mismatch");
        const vault = getPdaCreatorVault(
          LAUNCHPAD_PROGRAM,
          ctx.user,
          pool.mintB,
        ).publicKey;
        const info = await ctx.connection.getAccountInfo(vault, "confirmed");
        const amount = info
          ? unpackAccount(vault, info, asset.tokenProgram)
          : null;
        if (amount && !amount.mint.equals(asset.mint))
          throw new Error("LaunchLab creator vault quote mint mismatch");
        if (
          amount &&
          !amount.owner.equals(
            getPdaCreatorFeeVaultAuth(LAUNCHPAD_PROGRAM).publicKey,
          )
        )
          throw new Error("LaunchLab creator vault authority mismatch");
        estimate = amount?.amount ?? 0n;
        components.push({
          key: `launchlab:${vault.toBase58()}`,
          amountRaw: estimate.toString(),
          spendableRaw: estimate.toString(),
          quoteMint: asset.mint.toBase58(),
          quoteDecimals: asset.decimals,
        });
        if (estimate > 0n) {
          const recipient = getAssociatedTokenAddressSync(
            asset.mint,
            ctx.user,
            false,
            asset.tokenProgram,
          );
          instructions.push(
            createAssociatedTokenAccountIdempotentInstruction(
              ctx.user,
              recipient,
              ctx.user,
              asset.mint,
              asset.tokenProgram,
            ),
            claimCreatorFee(
              LAUNCHPAD_PROGRAM,
              ctx.user,
              getPdaCreatorFeeVaultAuth(LAUNCHPAD_PROGRAM).publicKey,
              vault,
              recipient,
              asset.mint,
              asset.tokenProgram,
            ),
          );
        }
      }
    }
    // Query both mint positions using offsets supplied by the official SDK layout.
    const candidatePools = new Map<
      string,
      { pubkey: PublicKey; account: AccountInfo<Buffer> }
    >();
    for (const field of ["mintA", "mintB"] as const) {
      const offset = CpmmPoolInfoLayout.offsetOf(field);
      const creatorOffset = CpmmPoolInfoLayout.offsetOf("poolCreator");
      if (offset < 0 || creatorOffset < 0)
        throw new Error("Raydium CPMM SDK lacks creator-fee layout offsets");
      const rows = await ctx.connection.getProgramAccounts(
        CREATE_CPMM_POOL_PROGRAM,
        {
          commitment: "confirmed",
          filters: [
            { memcmp: { offset, bytes: mint.toBase58() } },
            { memcmp: { offset: creatorOffset, bytes: ctx.user.toBase58() } },
          ],
        },
      );
      for (const row of rows) candidatePools.set(row.pubkey.toBase58(), row);
    }
    for (const row of candidatePools.values()) {
      if (
        !row.account.owner.equals(CREATE_CPMM_POOL_PROGRAM) ||
        row.account.data.length < CpmmPoolInfoLayout.span
      )
        throw new Error("Invalid Raydium CPMM creator pool");
      assertPoolAccount(row.account.data, CpmmPoolInfoLayout.span);
      const pool = CpmmPoolInfoLayout.decode(row.account.data);
      if (
        !pool.poolCreator.equals(ctx.user) ||
        (!pool.mintA.equals(mint) && !pool.mintB.equals(mint))
      )
        continue;
      const [a, b] = await Promise.all([
        tokenAsset(pool.mintA),
        tokenAsset(pool.mintB),
      ]);
      if (
        !a.tokenProgram.equals(pool.mintProgramA) ||
        !b.tokenProgram.equals(pool.mintProgramB)
      )
        throw new Error("CPMM creator-fee mint program mismatch");
      const feesA = BigInt(pool.creatorFeesMintA.toString()),
        feesB = BigInt(pool.creatorFeesMintB.toString());
      for (const [side, value, fee] of [
        ["a", a, feesA],
        ["b", b, feesB],
      ] as const)
        components.push({
          key: `cpmm:${row.pubkey.toBase58()}:${side}`,
          amountRaw: fee.toString(),
          spendableRaw: fee.toString(),
          quoteMint: value.mint.toBase58(),
          quoteDecimals: value.decimals,
        });
      asset ??= b;
      if (asset.mint.equals(b.mint)) estimate += feesB;
      if (asset.mint.equals(a.mint)) estimate += feesA;
      if (feesA + feesB > 0n) {
        const recipientA = getAssociatedTokenAddressSync(
            a.mint,
            ctx.user,
            false,
            a.tokenProgram,
          ),
          recipientB = getAssociatedTokenAddressSync(
            b.mint,
            ctx.user,
            false,
            b.tokenProgram,
          );
        instructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            ctx.user,
            recipientA,
            ctx.user,
            a.mint,
            a.tokenProgram,
          ),
          createAssociatedTokenAccountIdempotentInstruction(
            ctx.user,
            recipientB,
            ctx.user,
            b.mint,
            b.tokenProgram,
          ),
          makeCollectCreatorFeeInstruction(
            CREATE_CPMM_POOL_PROGRAM,
            ctx.user,
            getPdaPoolAuthority(CREATE_CPMM_POOL_PROGRAM).publicKey,
            row.pubkey,
            pool.configId,
            pool.vaultA,
            pool.vaultB,
            a.mint,
            b.mint,
            recipientA,
            recipientB,
            a.tokenProgram,
            b.tokenProgram,
          ),
        );
      }
    }
    if (!asset || !components.length) return null;
    return {
      source: this.id,
      quoteAsset: asset,
      instructions,
      estimatedClaimRaw: estimate,
      spendableByUserRaw: estimate,
      meta: {
        attribution: "shared-creator-vault",
        eligibility: "creator",
        claimComponents: components,
        payoutKind: "spl-token",
        coverage: ["raydium-launchlab", "raydium-cpmm"],
        unsupported: [
          "raydium-amm",
          "raydium-clmm-position-fees",
          "legacy-locked-lp-fee-key",
        ],
      },
    };
  }
}
