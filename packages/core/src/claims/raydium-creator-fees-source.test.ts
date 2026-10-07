import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import BN from "bn.js";
import { PublicKey, type Connection, type AccountInfo } from "@solana/web3.js";
import { MintLayout, AccountLayout, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { LAUNCHPAD_PROGRAM, CREATE_CPMM_POOL_PROGRAM, LaunchpadPool, CpmmPoolInfoLayout,
  getPdaLaunchpadPoolId, getPdaCreatorVault, getPdaCreatorFeeVaultAuth } from "@raydium-io/raydium-sdk-v2";
import { defaultPumpQuoteShell } from "../venues/pump/common.ts";
import { RaydiumCreatorFeesSource } from "./raydium-creator-fees-source.ts";

const creator = NATIVE_MINT;
const mint = new PublicKey(new Uint8Array(32).fill(5));
const account = (owner: PublicKey, data: Buffer): AccountInfo<Buffer> => ({ owner, data, lamports: 1, executable: false, rentEpoch: 0 });
function mintData(decimals = 6) {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1_000_000n, decimals,
    isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  return data;
}
function fixture() {
  const accounts = new Map<string, AccountInfo<Buffer>>();
  accounts.set(mint.toBase58(), account(TOKEN_PROGRAM_ID, mintData()));
  accounts.set(NATIVE_MINT.toBase58(), account(TOKEN_PROGRAM_ID, mintData(9)));
  const poolAddress = new PublicKey(new Uint8Array(32).fill(6));
  const data = Buffer.alloc(CpmmPoolInfoLayout.span);
  const decoded = CpmmPoolInfoLayout.decode(data);
  Object.assign(decoded, { mintA: mint, mintB: NATIVE_MINT, poolCreator: creator, mintProgramA: TOKEN_PROGRAM_ID,
    mintProgramB: TOKEN_PROGRAM_ID, enableCreatorFee: true, creatorFeesMintA: new BN(20), creatorFeesMintB: new BN(100) });
  CpmmPoolInfoLayout.encode(decoded, data);
  createHash("sha256").update("account:PoolState").digest().subarray(0, 8).copy(data);
  const row = { pubkey: poolAddress, account: account(CREATE_CPMM_POOL_PROGRAM, data) };
  const queries: unknown[] = [];
  const connection = { async getAccountInfo(key: PublicKey) { return accounts.get(key.toBase58()) ?? null; },
    async getProgramAccounts(program: PublicKey, query: unknown) { expect(program.equals(CREATE_CPMM_POOL_PROGRAM)).toBe(true); queries.push(query); return [row]; },
  } as unknown as Connection;
  const token = { ...defaultPumpQuoteShell(mint), quoteMint: NATIVE_MINT.toBase58() };
  return { accounts, row, queries, connection, token };
}

test("CPMM fees use official counters and builders with independently denominated assets", async () => {
  const f = fixture();
  const plan = await new RaydiumCreatorFeesSource().resolveClaim({ connection: f.connection, token: f.token, user: creator });
  expect(plan?.estimatedClaimRaw).toBe(100n);
  expect(plan?.instructions).toHaveLength(3);
  expect(plan?.instructions[2]?.programId.equals(CREATE_CPMM_POOL_PROGRAM)).toBe(true);
  expect(plan?.meta?.claimComponents).toMatchObject([{ quoteMint: mint.toBase58(), amountRaw: "20" }, { quoteMint: NATIVE_MINT.toBase58(), amountRaw: "100" }]);
  expect(f.queries).toHaveLength(2);
});

test("LaunchLab retains creator vault claims and CPMM claims together after migration", async () => {
  const f = fixture();
  const launch = getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mint, NATIVE_MINT).publicKey;
  const data = Buffer.alloc(LaunchpadPool.span);
  const pool = LaunchpadPool.decode(data);
  Object.assign(pool, { mintA: mint, mintB: NATIVE_MINT, creator, status: 2 });
  LaunchpadPool.encode(pool, data);
  createHash("sha256").update("account:PoolState").digest().subarray(0, 8).copy(data);
  f.accounts.set(launch.toBase58(), account(LAUNCHPAD_PROGRAM, data));
  const vault = getPdaCreatorVault(LAUNCHPAD_PROGRAM, creator, NATIVE_MINT).publicKey;
  const vaultData = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint: NATIVE_MINT, owner: getPdaCreatorFeeVaultAuth(LAUNCHPAD_PROGRAM).publicKey, amount: 50n,
    delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n,
    closeAuthorityOption: 0, closeAuthority: PublicKey.default }, vaultData);
  f.accounts.set(vault.toBase58(), account(TOKEN_PROGRAM_ID, vaultData));
  const plan = await new RaydiumCreatorFeesSource().resolveClaim({ connection: f.connection, token: f.token, user: creator });
  expect(plan?.estimatedClaimRaw).toBe(150n);
  expect(plan?.instructions).toHaveLength(5);
  expect(plan?.meta?.claimComponents).toHaveLength(3);
});

test("CPMM non-owner and malformed discriminator cannot yield a claim", async () => {
  const f = fixture();
  expect(await new RaydiumCreatorFeesSource().resolveClaim({ connection: f.connection, token: f.token, user: PublicKey.default })).toBeNull();
  f.row.account.data.fill(0, 0, 8);
  await expect(new RaydiumCreatorFeesSource().resolveClaim({ connection: f.connection, token: f.token, user: creator })).rejects.toThrow("discriminator");
});
