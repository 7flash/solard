import { test, expect } from "bun:test";
import { Keypair, TransactionInstruction } from "@solana/web3.js";
import { assembleTransaction } from "./assemble.ts";
test("oversized message reports candidates before accessing signing key", async () => {
  const publicKey = Keypair.generate().publicKey;
  let keyReads = 0;
  const payer = { publicKey, get secretKey() { keyReads++; throw new Error("signing forbidden"); } } as Keypair;
  await expect(assembleTransaction({ connection: {} as any, blockhash: { get: async () => ({ blockhash: publicKey.toBase58(), lastValidBlockHeight: 10 }) } as any,
    payer, altAddresses: [], draft: { instructions: [new TransactionInstruction({ programId: publicKey, keys: [], data: Buffer.alloc(1500) })], actions: [], signers: [], trackedAccounts: [] },
  })).rejects.toMatchObject({ code: "TRANSACTION_TOO_LARGE" });
  expect(keyReads).toBe(0);
});
