import { test, expect } from "bun:test";
import { Connection, PublicKey } from "@solana/web3.js";
import { getCompatibleParsedTransaction } from "./parsed-transaction.ts";
import seedcat from "./seedcat-v1.fixture.json";

const signature = "4X7KJJwCovRuoeVN4xUuNfKDbgZzJz2hCdFhzxtaNedNjGd3tCyCELBDw3nNDnyfJDnS7pbLqESUXWKj2gfECVMG";
function connectionWith(result: unknown) {
  return new Connection("http://localhost:8899", { fetch: (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result }))) as unknown as typeof fetch });
}
const transaction = {
  slot: 42, version: 1, meta: null,
  transaction: { signatures: [signature], message: {
    accountKeys: [{ pubkey: PublicKey.default.toBase58(), signer: true, writable: true }],
    instructions: [], recentBlockhash: PublicKey.default.toBase58(),
  } },
};
test("v1 parsed RPC retains its version and coerces/validates account keys", async () => {
  const connection = connectionWith(transaction);
  const parsed = await getCompatibleParsedTransaction(connection, signature);
  expect(parsed?.version).toBe(1);
  expect(parsed?.transaction.message.accountKeys[0]?.pubkey).toBeInstanceOf(PublicKey);
});
test("v1 compatibility never bypasses malformed body or unknown version validation", async () => {
  await expect(getCompatibleParsedTransaction(connectionWith({ ...transaction, slot: "invalid" }), signature)).rejects.toThrow();
  await expect(getCompatibleParsedTransaction(connectionWith({ ...transaction, version: 2 }), signature)).rejects.toThrow("Unsupported parsed transaction version");
  expect(await getCompatibleParsedTransaction(connectionWith(null), signature)).toBeNull();
});
test("captured SEEDCAT mainnet signature validates without relabelling version 1", async () => {
  const parsed = await getCompatibleParsedTransaction(connectionWith(seedcat), signature);
  expect(parsed?.version).toBe(1);
  expect(parsed?.slot).toBe(454653827);
  expect(parsed?.transaction.signatures[0]).toBe(signature);
  expect(parsed?.meta?.err).toBeNull();
});
