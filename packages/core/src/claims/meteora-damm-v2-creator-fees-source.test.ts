import { expect, test } from "bun:test";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { AccountLayout, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { type PositionState } from "@meteora-ag/cp-amm-sdk";
import { fixtureConnection } from "../venues/meteora/fixtures/connection.ts";
import { dammV2Client, readDammV2Market, CP_AMM_PROGRAM_ID } from "../venues/meteora/damm-v2.ts";
import { defaultPumpQuoteShell } from "../venues/pump/common.ts";
import { MeteoraDammV2CreatorFeesSource } from "./meteora-damm-v2-creator-fees-source.ts";

test("DAMM creator must own a verified position NFT; official builder claims its accrued fees", async () => {
  const { connection, accounts } = fixtureConnection();
  connection.getMinimumBalanceForRentExemption = async () => 2_039_280;
  const pool = new PublicKey("4CmPy9CYhVpTTEE1dWLt4ezHgn8Y3niJj9CtUQkDLstb");
  const mint = new PublicKey("3QEbHMK6ceYevtaCdLmBQMJgcPb9PJQpgyFBP6f6x6Rg");
  const client = dammV2Client(connection), market = await readDammV2Market(connection, pool);
  const user = market.state.creator;
  const positionAddress = new PublicKey(new Uint8Array(32).fill(8)), nftAccount = new PublicKey(new Uint8Array(32).fill(9)), nftMint = new PublicKey(new Uint8Array(32).fill(10));
  const discriminator = client._program.idl.accounts!.find((account) => account.name === "position")!.discriminator;
  const raw = Buffer.alloc(client._program.coder.accounts.size("position"));
  Buffer.from(discriminator).copy(raw);
  const position = client._program.coder.accounts.decode<PositionState>("position", raw);
  position.pool = pool; position.nftMint = nftMint; position.feeAPending = new BN(20); position.feeBPending = new BN(100);
  accounts.set(positionAddress.toBase58(), { owner: CP_AMM_PROGRAM_ID, data: await client._program.coder.accounts.encode("position", position), lamports: 1, executable: false, rentEpoch: 0 });
  const nftData = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint: nftMint, owner: user, amount: 1n, delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, nftData);
  accounts.set(nftAccount.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: nftData, lamports: 1, executable: false, rentEpoch: 0 });
  client.getPositionsByUserAndTokenMint = async () => [{ positionNftAccount: nftAccount, position: positionAddress, positionState: position, pool, poolState: market.state }];
  const plan = await new MeteoraDammV2CreatorFeesSource().resolveClaim({ connection, token: defaultPumpQuoteShell(mint), user });
  expect(plan?.meta?.eligibility).toBe("creator-and-position-nft-owner");
  expect(plan?.meta?.claimComponents).toMatchObject([{ amountRaw: "20" }, { amountRaw: "100" }]);
  expect(plan?.instructions.some((ix) => ix.programId.equals(CP_AMM_PROGRAM_ID))).toBe(true);
  nftData.writeBigUInt64LE(0n, AccountLayout.offsetOf("amount"));
  await expect(new MeteoraDammV2CreatorFeesSource().resolveClaim({ connection, token: defaultPumpQuoteShell(mint), user })).rejects.toThrow("NFT ownership");
});
