import BN from "bn.js";
import { GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, PUMP_AMM_SDK, type SwapSolanaState } from "@pump-fun/pump-swap-sdk";
import { getAssociatedTokenAddressSync, unpackMint, unpackAccount, MintLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import type { LivePoolReserves, VenueContext, VenueMarket } from "../venue-plugin.ts";

export function validateLivePoolReserves(snapshot: LivePoolReserves, identity: { pool: PublicKey; baseMint: PublicKey; quoteMint: PublicKey }): void {
  if (snapshot.pool !== identity.pool.toBase58() || snapshot.baseMint !== identity.baseMint.toBase58() || snapshot.quoteMint !== identity.quoteMint.toBase58()) throw new Error("Live pool reserves identity mismatch");
  const maxAge = snapshot.maxAgeMs ?? 2000;
  const age = Date.now() - snapshot.capturedAtMs;
  if (!Number.isSafeInteger(snapshot.slot) || snapshot.slot < 0 || !Number.isSafeInteger(snapshot.capturedAtMs) || !Number.isSafeInteger(maxAge) || maxAge < 1 || age < 0 || age > maxAge) throw new Error("Live pool reserves are stale or invalid");
  for (const amount of [snapshot.baseReserveRaw, snapshot.quoteReserveRaw]) if (typeof amount !== "bigint" || amount <= 0n || amount > 0xffffffffffffffffn) throw new Error("Live pool reserve amount is invalid");
}

/** Retain fresh protocol config, mint supply/extensions and user ATA state; skip vault reads. */
export async function snapshotSwapState(ctx: VenueContext, market: VenueMarket): Promise<SwapSolanaState> {
  const snapshot = ctx.reserves!;
  const poolKey = new PublicKey(String(market.metadata.pool));
  const identity = { pool: poolKey, baseMint: market.mint, quoteMint: market.quoteAsset.mint };
  validateLivePoolReserves(snapshot, identity);
  const baseAta = getAssociatedTokenAddressSync(market.mint, ctx.user, true, market.baseTokenProgram);
  const quoteAta = getAssociatedTokenAddressSync(market.quoteAsset.mint, ctx.user, true, market.quoteAsset.tokenProgram);
  const addresses = [GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, poolKey, market.mint, market.quoteAsset.mint, baseAta, quoteAta];
  const { context, value } = await ctx.connection.getMultipleAccountsInfoAndContext(addresses, { commitment: "confirmed", minContextSlot: snapshot.slot });
  if (context.slot < snapshot.slot) throw new Error("RPC state is older than live pool reserves");
  const [global, fee, poolInfo, baseInfo, quoteInfo, userBaseInfo, userQuoteInfo] = value;
  if (!global?.owner.equals(PUMP_AMM_PROGRAM_ID) || !poolInfo?.owner.equals(PUMP_AMM_PROGRAM_ID)) throw new Error("Invalid PumpSwap config or pool owner");
  if (fee && !fee.owner.equals(PUMP_FEE_PROGRAM_ID)) throw new Error("Invalid PumpSwap fee config owner");
  const pool = PUMP_AMM_SDK.decodePool(poolInfo);
  validateLivePoolReserves(snapshot, { pool: poolKey, baseMint: pool.baseMint, quoteMint: pool.quoteMint });
  if (!pool.poolBaseTokenAccount.equals(new PublicKey(String(market.metadata.poolBaseAta))) || !pool.poolQuoteTokenAccount.equals(new PublicKey(String(market.metadata.poolQuoteAta)))) throw new Error("PumpSwap vault identity changed");
  for (const program of [market.baseTokenProgram, market.quoteAsset.tokenProgram]) if (!program.equals(TOKEN_PROGRAM_ID) && !program.equals(TOKEN_2022_PROGRAM_ID)) throw new Error("Unsupported PumpSwap mint program");
  const baseMint = unpackMint(market.mint, baseInfo ?? null, market.baseTokenProgram);
  const quoteMint = unpackMint(market.quoteAsset.mint, quoteInfo ?? null, market.quoteAsset.tokenProgram);
  if (!baseMint.isInitialized || !quoteMint.isInitialized || baseMint.decimals !== Number(market.metadata.baseDecimals) || quoteMint.decimals !== market.quoteAsset.decimals) throw new Error("PumpSwap mint metadata changed");
  for (const [address, info, program, mint] of [[baseAta, userBaseInfo, market.baseTokenProgram, market.mint], [quoteAta, userQuoteInfo, market.quoteAsset.tokenProgram, market.quoteAsset.mint]] as const) {
    if (!info) continue;
    const account = unpackAccount(address, info, program);
    if (!account.mint.equals(mint) || !account.owner.equals(ctx.user)) throw new Error("PumpSwap user token account identity mismatch");
  }
  validateLivePoolReserves(snapshot, identity);
  return { globalConfig: PUMP_AMM_SDK.decodeGlobalConfig(global), feeConfig: fee ? PUMP_AMM_SDK.decodeFeeConfig(fee) : null,
    poolKey, poolAccountInfo: poolInfo, pool, poolBaseAmount: new BN(snapshot.baseReserveRaw.toString()), poolQuoteAmount: new BN(snapshot.quoteReserveRaw.toString()),
    baseTokenProgram: market.baseTokenProgram, quoteTokenProgram: market.quoteAsset.tokenProgram, baseMint: market.mint,
    baseMintAccount: MintLayout.decode(baseInfo!.data), user: ctx.user, userBaseTokenAccount: baseAta, userQuoteTokenAccount: quoteAta,
    userBaseAccountInfo: userBaseInfo ?? null, userQuoteAccountInfo: userQuoteInfo ?? null };
}
