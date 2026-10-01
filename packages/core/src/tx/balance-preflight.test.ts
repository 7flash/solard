import { test, expect } from "bun:test";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { checkPlanBalance } from "./balance-preflight.ts";
test("SOL principal and fee are checked; rent produces a typed required-amount error", async () => {
  const payer = Keypair.generate().publicKey;
  const plan = { payer, transaction: { message: {} }, draft: { actions: [{ kind: "buy", meta: { inputRaw: "1000000" } }], instructions: [SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: Keypair.generate().publicKey, lamports: 2000000, space: 165, programId: SystemProgram.programId })] } } as any;
  const connection = { getBalance: async () => 1005000, getFeeForMessage: async () => ({ value: 5000 }) } as any;
  await expect(checkPlanBalance(connection, plan)).rejects.toMatchObject({ phase: "before-submission", code: "INSUFFICIENT_SOL_FOR_RENT", requiredLamports: 3005000n });
  plan.draft.instructions = []; await checkPlanBalance(connection, plan);
  connection.getBalance = async () => 1004999;
  await expect(checkPlanBalance(connection, plan)).rejects.toMatchObject({ code: "INSUFFICIENT_SOL" });
});
