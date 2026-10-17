import { test, expect } from "bun:test";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import seedcat from "./fixtures/seedcat-custom-quote-plans.json";
import { TransactionTooLargeError } from "../core/errors.ts";
import { assembleTransaction } from "./assemble.ts";
test("oversized message reports candidates before accessing signing key", async () => {
  const publicKey = Keypair.generate().publicKey;
  let keyReads = 0;
  const payer = {
    publicKey,
    get secretKey() {
      keyReads++;
      throw new Error("signing forbidden");
    },
  } as Keypair;
  await expect(
    assembleTransaction({
      connection: {} as any,
      blockhash: {
        get: async () => ({
          blockhash: publicKey.toBase58(),
          lastValidBlockHeight: 10,
        }),
      } as any,
      payer,
      altAddresses: [],
      draft: {
        instructions: [
          new TransactionInstruction({
            programId: publicKey,
            keys: [],
            data: Buffer.alloc(1500),
          }),
        ],
        actions: [],
        signers: [],
        trackedAccounts: [],
      },
    }),
  ).rejects.toMatchObject({ code: "TRANSACTION_TOO_LARGE" });
  expect(keyReads).toBe(0);
});

test("captured SEEDCAT custom-quote buy and sell reject with lookup candidates before signing", async () => {
  const publicKey = new PublicKey(seedcat.payer);
  let keyReads = 0;
  const payer = { publicKey, get secretKey() { keyReads++; throw new Error("signing forbidden"); } } as Keypair;
  for (const side of [seedcat.buy, seedcat.sell]) {
    const instructions = side.instructions.map(instruction => new TransactionInstruction({
      programId: new PublicKey(instruction.programId), data: Buffer.from(instruction.data, "base64"),
      keys: instruction.keys.map(key => ({ ...key, pubkey: new PublicKey(key.pubkey) })),
    }));
    let failure: unknown;
    try {
      await assembleTransaction({ connection: {} as any,
        blockhash: { get: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 10 }) } as any,
        payer, altAddresses: [], draft: { instructions, actions: [side.action as any], signers: [], trackedAccounts: [] } });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TransactionTooLargeError);
    expect(failure).toMatchObject({ code: "TRANSACTION_TOO_LARGE" });
    const candidates = (failure as TransactionTooLargeError).lookupCandidates;
    expect(candidates.length).toBeGreaterThan(25);
    expect(candidates).toContain(seedcat.quote);
    expect(candidates).not.toContain(seedcat.payer);
  }
  expect(keyReads).toBe(0);
});
