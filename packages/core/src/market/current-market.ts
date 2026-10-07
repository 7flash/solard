import { PublicKey, type Connection, type AccountInfo } from "@solana/web3.js";
import { unpackMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { CREATE_CPMM_POOL_PROGRAM, AMM_V4, LAUNCHPAD_PROGRAM, CpmmPoolInfoLayout, liquidityStateV4Layout, LaunchpadPool } from "@raydium-io/raydium-sdk-v2";
import { fetchCurve, fetchPool } from "../venues/pump/state.ts";
import { defaultPumpQuoteShell } from "../venues/pump/common.ts";
import { PUMP_AMM_PROGRAM_ID } from "../venues/pump/constants.ts";

export type CurrentMarket = {
  mint: string; pool: string; venue: "pump-curve" | "pumpswap" | "raydium-launchlab" | "raydium-cpmm" | "raydium-amm";
  quoteMint: string; baseDecimals: number; quoteDecimals: number; baseTokenProgram: string; quoteTokenProgram: string;
  supplyRaw: bigint; livePricesSupported: boolean; migrated: boolean | null;
};

/** Resolve actual on-chain identities. A Jupiter route hint does not establish a pool. */
export async function resolveCurrentMarket(connection: Connection, mintInput: string | PublicKey, options: { pool?: string | PublicKey } = {}): Promise<CurrentMarket | null> {
  const mint = new PublicKey(mintInput);
  if (!options.pool) {
    const curve = await fetchCurve(connection, defaultPumpQuoteShell(mint));
    if (curve && !curve.complete) {
      const info = await connection.getAccountInfo(mint, "confirmed");
      if (!info || (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID))) throw new Error("Unsupported current market mint owner");
      const decoded = unpackMint(mint, info, info.owner);
      return { mint: mint.toBase58(), pool: curve.address.toBase58(), venue: "pump-curve", quoteMint: curve.quoteAsset.mint.toBase58(), baseDecimals: decoded.decimals,
        quoteDecimals: curve.quoteAsset.decimals, baseTokenProgram: info.owner.toBase58(), quoteTokenProgram: curve.quoteAsset.tokenProgram.toBase58(), supplyRaw: decoded.supply,
        livePricesSupported: true, migrated: false };
    }
  }
  const candidates: Array<{ pubkey: PublicKey; account: AccountInfo<Buffer> }> = [];
  if (options.pool) {
    const pubkey = new PublicKey(options.pool); const account = await connection.getAccountInfo(pubkey, "confirmed");
    if (!account) return null; candidates.push({ pubkey, account });
  } else {
    const queries = [
      [PUMP_AMM_PROGRAM_ID, 43], [CREATE_CPMM_POOL_PROGRAM, CpmmPoolInfoLayout.offsetOf("mintA")],
      [CREATE_CPMM_POOL_PROGRAM, CpmmPoolInfoLayout.offsetOf("mintB")], [AMM_V4, liquidityStateV4Layout.offsetOf("baseMint")],
      [AMM_V4, liquidityStateV4Layout.offsetOf("quoteMint")], [LAUNCHPAD_PROGRAM, LaunchpadPool.offsetOf("mintA")],
    ] as const;
    const results = await Promise.all(queries.map(([program, offset]) => connection.getProgramAccounts(program, { commitment: "confirmed", filters: [{ memcmp: { offset, bytes: mint.toBase58() } }] })));
    candidates.push(...results.flat());
  }
  for (const { pubkey, account } of candidates) {
    let venue: CurrentMarket["venue"]; let base: PublicKey; let quote: PublicKey; let migrated: boolean | null = null;
    let expectedBaseProgram: PublicKey | undefined; let expectedQuoteProgram: PublicKey | undefined;
    if (account.owner.equals(PUMP_AMM_PROGRAM_ID)) {
      const pool = await fetchPool(connection, pubkey); base = pool.baseMint; quote = pool.quoteMint; venue = "pumpswap";
      if (!base.equals(mint)) continue;
    } else if (account.owner.equals(CREATE_CPMM_POOL_PROGRAM)) {
      if (!account.data.subarray(0, 8).equals(Buffer.from([247, 237, 227, 245, 215, 195, 222, 70]))) throw new Error("Invalid Raydium CPMM pool discriminator");
      const pool = CpmmPoolInfoLayout.decode(account.data); venue = "raydium-cpmm";
      if (!pool.mintA.equals(mint) && !pool.mintB.equals(mint)) continue;
      base = mint; quote = pool.mintA.equals(mint) ? pool.mintB : pool.mintA;
      expectedBaseProgram = pool.mintA.equals(mint) ? pool.mintProgramA : pool.mintProgramB;
      expectedQuoteProgram = pool.mintA.equals(mint) ? pool.mintProgramB : pool.mintProgramA;
    } else if (account.owner.equals(AMM_V4)) {
      const pool = liquidityStateV4Layout.decode(account.data); venue = "raydium-amm";
      if (!pool.baseMint.equals(mint) && !pool.quoteMint.equals(mint)) continue;
      base = mint; quote = pool.baseMint.equals(mint) ? pool.quoteMint : pool.baseMint;
    } else if (account.owner.equals(LAUNCHPAD_PROGRAM)) {
      if (!account.data.subarray(0, 8).equals(Buffer.from([247, 237, 227, 245, 215, 195, 222, 70]))) throw new Error("Invalid Raydium LaunchLab pool discriminator");
      const pool = LaunchpadPool.decode(account.data); venue = "raydium-launchlab"; migrated = false;
      if (!pool.mintA.equals(mint) || pool.status !== 0) continue;
      base = pool.mintA; quote = pool.mintB;
    } else continue;
    const infos = await connection.getMultipleAccountsInfo([base, quote], "confirmed");
    const verified = infos.map((info, index) => {
      if (!info || (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID))) throw new Error("Unsupported current market mint owner");
      const decoded = unpackMint(index ? quote : base, info, info.owner);
      if (!decoded.isInitialized) throw new Error("Uninitialized current market mint");
      return { ...decoded, program: info.owner };
    });
    if ((expectedBaseProgram && !expectedBaseProgram.equals(verified[0]!.program)) || (expectedQuoteProgram && !expectedQuoteProgram.equals(verified[1]!.program))) throw new Error("Current pool token program does not match mint owner");
    return { mint: mint.toBase58(), pool: pubkey.toBase58(), venue, quoteMint: quote.toBase58(), baseDecimals: verified[0]!.decimals,
      quoteDecimals: verified[1]!.decimals, baseTokenProgram: verified[0]!.program.toBase58(), quoteTokenProgram: verified[1]!.program.toBase58(),
      supplyRaw: verified[0]!.supply, livePricesSupported: venue !== "raydium-amm", migrated };
  }
  return null;
}
