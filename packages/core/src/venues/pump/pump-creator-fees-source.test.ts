import { expect, test } from "bun:test";
import { PublicKey, SystemProgram, type Connection } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { pumpAmmJson } from "@pump-fun/pump-swap-sdk";
import { defaultPumpQuoteShell } from "./common.ts";
import { PUMP_AMM_PROGRAM_ID } from "./constants.ts";
import { creatorVaultPda, ammCreatorVaultPda, ata } from "./pda.ts";
import { PumpCreatorFeesSource } from "./pump-creator-fees-source.ts";

function fixture() {
  const creator = NATIVE_MINT,
    mint = new PublicKey(new Uint8Array(32).fill(1)),
    address = new PublicKey(new Uint8Array(32).fill(2));
  const token = {
    ...defaultPumpQuoteShell(mint),
    pool: address.toBase58(),
    venueHint: "pumpswap" as const,
  };
  const data = Buffer.alloc(245);
  Buffer.from(
    pumpAmmJson.accounts.find((row) => row.name.toLowerCase() === "pool")!
      .discriminator,
  ).copy(data);
  // Fixture follows the existing PumpSwap decoder's published layout.
  mint.toBuffer().copy(data, 43);
  NATIVE_MINT.toBuffer().copy(data, 75);
  creator.toBuffer().copy(data, 211);
  const connection = {
    async getAccountInfo(key: PublicKey) {
      if (key.equals(address))
        return {
          owner: PUMP_AMM_PROGRAM_ID,
          data,
          lamports: 1,
          executable: false,
          rentEpoch: 0,
        };
      if (key.equals(creatorVaultPda(creator)))
        return {
          owner: SystemProgram.programId,
          data: Buffer.alloc(0),
          lamports: 1100,
          executable: false,
          rentEpoch: 0,
        };
      return null;
    },
    async getMinimumBalanceForRentExemption() {
      return 100;
    },
  } as unknown as Connection;
  return { creator, token, connection, data };
}

test("closed bonding curve still resolves PumpSwap creator fees from verified pool", async () => {
  const { creator, token, connection } = fixture();
  const plan = await new PumpCreatorFeesSource().resolveClaim({
    connection,
    token,
    user: creator,
  });
  expect(plan).not.toBeNull();
  expect(plan?.estimatedClaimRaw).toBe(1000n);
  expect(plan?.spendableByUserRaw).toBe(1000n);
  expect(plan?.meta).toMatchObject({
    includeAmm: true,
    attribution: "shared-creator-vault",
    eligibility: "creator",
  });
});

test("non-creator wallet and unrelated pool cannot produce an eligible claim", async () => {
  const f = fixture();
  expect(
    await new PumpCreatorFeesSource().resolveClaim({
      connection: f.connection,
      token: f.token,
      user: PublicKey.default,
    }),
  ).toBeNull();
  PublicKey.default.toBuffer().copy(f.data, 43);
  await expect(
    new PumpCreatorFeesSource().resolveClaim({
      connection: f.connection,
      token: f.token,
      user: f.creator,
    }),
  ).rejects.toThrow("base mint mismatch");
});

test("an unavailable fee vault RPC is an error rather than an empty balance", async () => {
  const f = fixture();
  const original = f.connection.getAccountInfo.bind(f.connection);
  const vault = ata(
    NATIVE_MINT,
    ammCreatorVaultPda(f.creator),
    TOKEN_PROGRAM_ID,
    true,
  );
  f.connection.getAccountInfo = async (key) => {
    if (key.equals(vault)) throw new Error("RPC unavailable");
    return original(key);
  };
  await expect(
    new PumpCreatorFeesSource().resolveClaim({
      connection: f.connection,
      token: f.token,
      user: f.creator,
    }),
  ).rejects.toThrow("RPC unavailable");
});
