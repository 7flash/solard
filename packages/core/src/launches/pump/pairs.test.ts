import { expect, test } from "bun:test";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getSupportedPumpPairs } from "./pairs.ts";
import { PUMP_PROGRAM_ID } from "../../venues/pump/constants.ts";
import capture from "./fixtures/pump-global-mainnet-454573144.json";

test("Pump whitelist ignores following creator-fee/holder-reward fields", async () => {
  const quote = Keypair.generate().publicKey;
  const unrelated = Keypair.generate().publicKey;
  const data = Buffer.alloc(1087);
  Buffer.from([167, 232, 232, 177, 200, 108, 114, 127]).copy(data);
  quote.toBuffer().copy(data, 1013);
  unrelated.toBuffer().copy(data, 1054);
  const requested: string[] = [];
  const mint = Buffer.alloc(82);
  mint[44] = 6;
  const connection = {
    getAccountInfo: async () => ({ data, owner: PUMP_PROGRAM_ID }),
    getMultipleAccountsInfo: async (keys: (typeof quote)[]) => {
      requested.push(...keys.map((key) => key.toBase58()));
      return keys.map((key) =>
        key.equals(quote) ? { data: mint, owner: TOKEN_PROGRAM_ID } : null,
      );
    },
  } as unknown as Connection;
  const pairs = await getSupportedPumpPairs(connection);
  expect(pairs).toHaveLength(2);
  expect(pairs[1]!.mint).toBe(quote.toBase58());
  expect(pairs[1]!.decimals).toBe(6);
  expect(requested).not.toContain(unrelated.toBase58());
});
test("Pump whitelist rejects unrelated account owners", async () => {
  const connection = {
    getAccountInfo: async () => ({
      data: Buffer.alloc(1100),
      owner: TOKEN_PROGRAM_ID,
    }),
  } as unknown as Connection;
  await expect(getSupportedPumpPairs(connection)).rejects.toThrow(
    "Invalid Pump Global",
  );
});

test("captured mainnet Pump Global decodes its one USDC whitelist entry without reading following fields as mints", async () => {
  const data = Buffer.from(capture.data, "base64");
  const quote = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const following = new PublicKey(data.subarray(1054, 1086));
  const requested: string[] = [];
  const mint = Buffer.alloc(82);
  mint[44] = 6;
  mint[45] = 1;
  const connection = {
    getAccountInfo: async (address: PublicKey) => {
      expect(address.toBase58()).toBe(capture.address);
      return { data, owner: new PublicKey(capture.owner) };
    },
    getMultipleAccountsInfo: async (addresses: PublicKey[]) => {
      requested.push(...addresses.map((address) => address.toBase58()));
      return addresses.map((address) =>
        address.equals(quote) ? { data: mint, owner: TOKEN_PROGRAM_ID } : null,
      );
    },
  } as unknown as Connection;
  expect(capture.slot).toBe(454573144);
  expect(data).toHaveLength(1087);
  const pairs = await getSupportedPumpPairs(connection);
  expect(pairs).toHaveLength(2);
  expect(pairs[1]).toMatchObject({
    mint: quote.toBase58(),
    symbol: "USDC",
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
  });
  expect(requested).not.toContain(following.toBase58());
});
