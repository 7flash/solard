import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID, getTokenProgram, type VirtualPool, type PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { dbcClient } from "../venues/meteora/dbc.ts";
import { readMint } from "../chain/state.ts";
import { poolQuoteAsset } from "../venues/pump/common.ts";
import type { ClaimContext, ClaimSourcePlugin, ClaimPlan } from "./claim-source.ts";

/** DBC creator trading fees; migrated DAMM position fees need a separate position authority. */
export class MeteoraDbcCreatorFeesSource implements ClaimSourcePlugin {
  readonly id = "meteora-dbc-creator-fees";
  async resolveClaim(ctx: ClaimContext): Promise<ClaimPlan | null> {
    const mint = new PublicKey(ctx.token.mint), client = dbcClient(ctx.connection);
    const discovered = await client.state.getPoolByBaseMint(mint);
    if (!discovered) return null;
    const pool = discovered.publicKey;
    const account = await ctx.connection.getAccountInfo(pool, "confirmed");
    if (!account || !account.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) throw new Error("Invalid DBC creator-fee pool owner");
    const decoded = client.state.getProgram().coder.accounts.decode<VirtualPool>("virtualPool", account.data);
    const state = decoded.poolState;
    if (!state.baseMint.equals(mint)) throw new Error("DBC creator-fee pool base mint mismatch");
    if (!state.creator.equals(ctx.user)) return null;
    const configAccount = await ctx.connection.getAccountInfo(state.config, "confirmed");
    if (!configAccount || !configAccount.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) throw new Error("Invalid DBC creator-fee config owner");
    const config = client.state.getProgram().coder.accounts.decode<PoolConfig>("poolConfig", configAccount.data);
    const [base, quote] = await Promise.all([readMint(ctx.connection, mint), poolQuoteAsset(ctx.connection, ctx.token, config.quoteMint)]);
    if (!base.tokenProgram.equals(getTokenProgram(state.poolType)) || !quote.tokenProgram.equals(getTokenProgram(config.quoteTokenFlag)))
      throw new Error("DBC creator-fee mint program mismatch");
    const baseFee = BigInt(state.creatorBaseFee.toString()), quoteFee = BigInt(state.creatorQuoteFee.toString());
    const built = baseFee + quoteFee > 0n ? await client.creator.claimCreatorTradingFee({ creator: ctx.user, payer: ctx.user,
      pool, maxBaseAmount: new BN(baseFee.toString()), maxQuoteAmount: new BN(quoteFee.toString()) }) : null;
    return { source: this.id, quoteAsset: quote, instructions: built?.instructions ?? [], estimatedClaimRaw: quoteFee, spendableByUserRaw: quoteFee,
      meta: { eligibility: "creator", attribution: "source-defined", migrated: Boolean(state.isMigrated),
        claimComponents: [
          { key: `dbc:${pool.toBase58()}:base`, amountRaw: baseFee.toString(), spendableRaw: baseFee.toString(), quoteMint: mint.toBase58(), quoteDecimals: base.decimals },
          { key: `dbc:${pool.toBase58()}:quote`, amountRaw: quoteFee.toString(), spendableRaw: quoteFee.toString(), quoteMint: quote.mint.toBase58(), quoteDecimals: quote.decimals },
        ], unsupported: ["meteora-damm-v2-position-fees", "meteora-dlmm-position-fees", "dbc-partner-fees", "dbc-transfer-hook-pools"] } };
  }
}
