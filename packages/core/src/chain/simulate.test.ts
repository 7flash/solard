import { expect, test } from "bun:test";
import { Keypair, TransactionMessage, VersionedTransaction, SystemProgram, type Connection } from "@solana/web3.js";
import { simulatePlanned } from "./simulate.ts";
import { Solard } from "../core/solard.ts";
import type { PlannedTransaction } from "../tx/types.ts";

function fixture(error: string | null, account: "missing" | "existing" | "unavailable") {
  const payer = Keypair.generate().publicKey;
  const message = new TransactionMessage({ payerKey: payer,
    recentBlockhash: SystemProgram.programId.toBase58(), instructions: [],
  }).compileToV0Message();
  const plan: PlannedTransaction = {
    transaction: new VersionedTransaction(message),
    draft: { instructions: [], signers: [], actions: [], trackedAccounts: [] },
    lookupTables: [], serializedSize: 0,
    // The diagnostic must use the actual compiled payer, not a stale plan field.
    payer: Keypair.generate().publicKey,
    recentBlockhash: SystemProgram.programId.toBase58(), lastValidBlockHeight: 0,
  };
  let reads = 0;
  const connection = {
    async simulateTransaction() {
      return { value: { err: error, logs: [], unitsConsumed: 0, accounts: [] } };
    },
    async getAccountInfo(address: typeof payer) {
      reads += 1;
      expect(address.equals(payer)).toBe(true);
      if (account === "unavailable") throw new Error("RPC unavailable");
      return account === "missing" ? null : { lamports: 100_000 };
    },
  } as unknown as Connection;
  return { connection, plan, payer, reads: () => reads };
}

test("AccountNotFound identifies an absent compiled fee payer without changing raw error/logs", async () => {
  const context = fixture("AccountNotFound", "missing");
  const result = await simulatePlanned(context.connection, context.plan);
  expect(result.error).toBe("AccountNotFound");
  expect(result.logs).toEqual([]);
  expect(result.diagnostics!.feePayer).toEqual({
    address: context.payer.toBase58(), exists: false, lamports: null,
  });
  expect(result.diagnostics!.message).toContain("has no SOL account");
});

test("existing fee payer is reported without incorrectly diagnosing a missing SOL account", async () => {
  const context = fixture("AccountNotFound", "existing");
  const result = await simulatePlanned(context.connection, context.plan);
  expect(result.diagnostics!.feePayer.exists).toBe(true);
  expect(result.diagnostics!.feePayer.lamports).toBe(100_000);
  expect(result.diagnostics!.message).not.toContain("has no SOL account");
});

test("diagnostic RPC failure preserves uncertainty and original simulation failure", async () => {
  const context = fixture("AccountNotFound", "unavailable");
  const result = await simulatePlanned(context.connection, context.plan);
  expect(result.success).toBe(false);
  expect(result.error).toBe("AccountNotFound");
  expect(result.diagnostics!.feePayer.exists).toBeNull();
  expect(result.diagnostics!.message).toContain("could not be checked");
});

test("successful simulation does not make a diagnostic RPC call", async () => {
  const context = fixture(null, "unavailable");
  const result = await simulatePlanned(context.connection, context.plan);
  expect(result.success).toBe(true);
  expect(result.diagnostics).toBeUndefined();
  expect(context.reads()).toBe(0);
});

test("submission stops before simulation/broadcast when actual compiled payer lacks SOL", async () => {
  const context = fixture("AccountNotFound", "missing");
  const slrd: Solard = Object.create(Solard.prototype);
  let simulations = 0;
  slrd.connection = () => ({ getBalance: async (payer) => { expect(payer.equals(context.payer)).toBe(true); return 0; }, getFeeForMessage: async () => ({ value: 5000 }) }) as unknown as Connection;
  slrd.simulatePlan = async () => { simulations++; return await simulatePlanned(context.connection, context.plan); };
  await expect(slrd.submitPlan(context.plan, "rpc")).rejects.toMatchObject({ code: "INSUFFICIENT_SOL", phase: "before-submission" });
  expect(simulations).toBe(0);
});
