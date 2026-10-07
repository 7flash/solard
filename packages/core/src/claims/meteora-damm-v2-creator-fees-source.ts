import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { unpackAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { CP_AMM_PROGRAM_ID, getTokenProgram, getUnClaimLpFee, type PoolState, type PositionState } from "@meteora-ag/cp-amm-sdk";
import { dammV2Client } from "../venues/meteora/damm-v2.ts";
import { readMint } from "../chain/state.ts";
import type { QuoteAsset } from "../core/amounts.ts";
import type { ClaimContext, ClaimSourcePlugin, ClaimPlan } from "./claim-source.ts";

/** Claims creator-owned DAMM v2 positions. Creator identity alone is insufficient: the wallet must own the position NFT. */
export class MeteoraDammV2CreatorFeesSource implements ClaimSourcePlugin {
  readonly id = "meteora-damm-v2-creator-fees";
  async resolveClaim(ctx: ClaimContext): Promise<ClaimPlan | null> {
    const mint = new PublicKey(ctx.token.mint), client = dammV2Client(ctx.connection);
    const positions = await client.getPositionsByUserAndTokenMint(ctx.user, mint);
    const instructions: Array<TransactionInstruction> = [];
    const components: Array<{ key: string; amountRaw: string; spendableRaw: string; quoteMint: string; quoteDecimals: number }> = [];
    let quoteAsset: QuoteAsset | null = null, estimate = 0n;
    for (const row of positions) {
      const [poolInfo, positionInfo, nftInfo] = await ctx.connection.getMultipleAccountsInfo([row.pool, row.position, row.positionNftAccount], "confirmed");
      if (!poolInfo?.owner.equals(CP_AMM_PROGRAM_ID) || !positionInfo?.owner.equals(CP_AMM_PROGRAM_ID) || !nftInfo) throw new Error("Invalid DAMM v2 creator position owner");
      const pool = client._program.coder.accounts.decode<PoolState>("pool", poolInfo.data);
      const position = client._program.coder.accounts.decode<PositionState>("position", positionInfo.data);
      if (!pool.creator.equals(ctx.user)) continue;
      if (!position.pool.equals(row.pool) || (!pool.tokenAMint.equals(mint) && !pool.tokenBMint.equals(mint))) throw new Error("DAMM v2 creator position pool mismatch");
      if (!nftInfo.owner.equals(TOKEN_PROGRAM_ID) && !nftInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error("Invalid DAMM v2 position NFT token program");
      const nft = unpackAccount(row.positionNftAccount, nftInfo, nftInfo.owner);
      if (!nft.owner.equals(ctx.user) || nft.amount !== 1n || !nft.mint.equals(position.nftMint)) throw new Error("DAMM v2 position NFT ownership mismatch");
      const [a, b] = await Promise.all([readMint(ctx.connection, pool.tokenAMint), readMint(ctx.connection, pool.tokenBMint)]);
      if (!a.tokenProgram.equals(getTokenProgram(pool.tokenAFlag)) || !b.tokenProgram.equals(getTokenProgram(pool.tokenBFlag))) throw new Error("DAMM v2 creator fee mint program mismatch");
      const fees = getUnClaimLpFee(pool, position);
      const feeA = BigInt(fees.feeTokenA.toString()), feeB = BigInt(fees.feeTokenB.toString());
      for (const [side, tokenMint, info, fee] of [["a", pool.tokenAMint, a, feeA], ["b", pool.tokenBMint, b, feeB]] as const)
        components.push({ key: `damm-v2:${row.position.toBase58()}:${side}`, amountRaw: fee.toString(), spendableRaw: fee.toString(), quoteMint: tokenMint.toBase58(), quoteDecimals: info.decimals });
      quoteAsset ??= { kind: "spl-token", mint: pool.tokenBMint, tokenProgram: b.tokenProgram, decimals: b.decimals };
      if (quoteAsset.mint.equals(pool.tokenBMint)) estimate += feeB;
      if (quoteAsset.mint.equals(pool.tokenAMint)) estimate += feeA;
      if (feeA + feeB > 0n) {
        const built = await client.claimPositionFee({ owner: ctx.user, feePayer: ctx.user,
          position: row.position, pool: row.pool, positionNftAccount: row.positionNftAccount,
          tokenAMint: pool.tokenAMint, tokenBMint: pool.tokenBMint, tokenAVault: pool.tokenAVault, tokenBVault: pool.tokenBVault,
          tokenAProgram: a.tokenProgram, tokenBProgram: b.tokenProgram });
        instructions.push(...built.instructions);
      }
    }
    if (!quoteAsset || !components.length) return null;
    return { source: this.id, quoteAsset, instructions, estimatedClaimRaw: estimate, spendableByUserRaw: estimate,
      meta: { eligibility: "creator-and-position-nft-owner", attribution: "source-defined", claimComponents: components,
        unsupported: ["delegated-or-lock-escrow-positions", "damm-v2-reward-claims", "meteora-dlmm-position-fees", "transfer-hook-fee-claims"] } };
  }
}
