import { expect, test } from "bun:test";
import { Keypair, type Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getSupportedPumpPairs } from "./pairs.ts";
import { PUMP_PROGRAM_ID } from "../../venues/pump/constants.ts";

test("Pump whitelist ignores following creator-fee/holder-reward fields", async () => {
  const quote = Keypair.generate().publicKey; const unrelated = Keypair.generate().publicKey;
  const data = Buffer.alloc(1087); Buffer.from([167,232,232,177,200,108,114,127]).copy(data);
  quote.toBuffer().copy(data, 1013); unrelated.toBuffer().copy(data, 1054);
  const requested: string[] = []; const mint = Buffer.alloc(82); mint[44] = 6;
  const connection = { getAccountInfo: async () => ({ data, owner: PUMP_PROGRAM_ID }), getMultipleAccountsInfo: async (keys: typeof quote[]) => {
    requested.push(...keys.map(key => key.toBase58())); return keys.map(key => key.equals(quote) ? {data: mint, owner: TOKEN_PROGRAM_ID} : null);
  }} as unknown as Connection;
  const pairs = await getSupportedPumpPairs(connection);
  expect(pairs).toHaveLength(2); expect(pairs[1]!.mint).toBe(quote.toBase58()); expect(pairs[1]!.decimals).toBe(6);
  expect(requested).not.toContain(unrelated.toBase58());
});
test("Pump whitelist rejects unrelated account owners", async () => {
  const connection = {getAccountInfo: async () => ({data: Buffer.alloc(1100), owner: TOKEN_PROGRAM_ID})} as unknown as Connection;
  await expect(getSupportedPumpPairs(connection)).rejects.toThrow("Invalid Pump Global");
});
