import { expect, test } from "bun:test";
import { Keypair, type Connection } from "@solana/web3.js";
import { Solard } from "../core/solard.ts";
import { chooseTradeFee, normalizeLandingPolicy } from "./trade-policy.ts";
import { inspectExpiredSubmission } from "./expiry.ts";
import type { PlannedTransaction, SendReceipt } from "./types.ts";

test("market percentile, doubling, fixed prices and lamport cap", () => {
  const policy = normalizeLandingPolicy();
  expect(chooseTradeFee(policy, 600_000, [0, 200_000, 400_000, 800_000])).toBe(400_000);
  expect(chooseTradeFee(policy, 600_000, [], 400_000)).toBe(800_000);
  expect(chooseTradeFee(policy, 600_000, [], 1_000_000)).toBe(1_666_666);
  expect(chooseTradeFee(normalizeLandingPolicy({ microLamports: 0 }), 600_000, [800_000], 400_000)).toBe(0);
  expect(() => normalizeLandingPolicy({ maxAttempts: 6 })).toThrow();
  expect(() => chooseTradeFee(normalizeLandingPolicy({ microLamports: 2_000_000 }), 600_000, [])).toThrow();
});

function kernel(receipts: Array<SendReceipt>) {
  const slrd: Solard = Object.create(Solard.prototype);
  const payer = Keypair.generate();
  const fees: Array<number> = [];
  let invalidations = 0;
  let builds = 0;
  const plan = { payer: payer.publicKey,
    draft: { instructions: [], actions: [], signers: [], trackedAccounts: [], cuLimit: 150_000 },
  } as unknown as PlannedTransaction;
  slrd.signer = () => payer;
  slrd.compile = async (_payer, draft) => ({ ...plan, draft });
  slrd.connection = () => ({ async getRecentPrioritizationFees() {
    return [100_000, 200_000, 400_000, 800_000].map((prioritizationFee) => ({ prioritizationFee }));
  } } as unknown as Connection);
  Object.defineProperty(slrd, "cache", { value: { invalidate() {} } });
  Object.defineProperty(slrd, "executions", { value: { get() { return { metaJson: null }; } } });
  Object.defineProperty(slrd, "blockhash", { value: { invalidate() { invalidations++; } } });
  slrd.submitPlan = async (prepared) => {
    fees.push(prepared.draft.cuPriceMicroLamports!);
    return { plan: prepared, sender: "rpc", executionId: fees.length, signature: `signature-${fees.length}` };
  };
  slrd.settleSubmission = async () => receipts.shift()!;
  const build = async () => { builds++; return plan; };
  return { slrd, fees, build, builds: () => builds, invalidations: () => invalidations };
}
const receipt = (status: SendReceipt["status"], retryable = false): SendReceipt => ({
  signature: "test", sender: "rpc", slot: null, status, retryable,
});
test("relative notional cap limits tiny-trade priority fee", async () => {
  const context = kernel([receipt("confirmed")]);
  const original = context.build;
  const result = await context.slrd.executeTradePlan("wallet", async () => {
    const plan = await original(); plan.draft.actions = [{ kind: "buy", meta: { inputRaw: "1000000" } }]; return plan;
  }, "rpc", "buy", { landing: { maxFeeBpsOfNotional: 500 } });
  expect(context.fees[0]).toBe(300000);
  expect(Math.ceil(context.fees[0]! * 150000 / 1000000) + 5000).toBeLessThanOrEqual(50000);
  expect(result.receipt.status).toBe("confirmed");
});

test("real trade kernel rebuilds with twice the price only after retryable expiry", async () => {
  const context = kernel([receipt("failed", true), receipt("confirmed")]);
  const result = await context.slrd.executeTradePlan("wallet", context.build, "rpc", "sell");
  expect(context.fees).toEqual([400_000, 800_000]);
  expect(context.builds()).toBe(2);
  expect(context.invalidations()).toBe(1);
  expect(result.attempts.map((attempt) => attempt.priorityMicroLamports)).toEqual(context.fees);
});

test("pending and program-failed trades stop without replacement", async () => {
  for (const status of ["submitted", "failed"] as const) {
    const context = kernel([receipt(status)]);
    await context.slrd.executeTradePlan("wallet", context.build, "rpc", "buy");
    expect(context.fees).toHaveLength(1);
  }
});

test("retry count is bounded and an ambiguous submission exception is not retried", async () => {
  const context = kernel([receipt("failed", true), receipt("failed", true), receipt("failed", true)]);
  const result = await context.slrd.executeTradePlan("wallet", context.build, "rpc", "sell");
  expect(context.fees).toHaveLength(3);
  expect(result.receipt.status).toBe("failed");
  const ambiguous = kernel([]);
  let sends = 0;
  ambiguous.slrd.submitPlan = async () => { sends++; throw new Error("transport outcome unknown"); };
  await expect(ambiguous.slrd.executeTradePlan("wallet", ambiguous.build, "rpc", "sell")).rejects.toThrow("transport outcome unknown");
  expect(sends).toBe(1);
});

test("fixed price survives retries and non-waiting calls submit once", async () => {
  const context = kernel([receipt("failed", true), receipt("confirmed")]);
  await context.slrd.executeTradePlan("wallet", context.build, "rpc", "sell", {
    priorityFee: { microLamports: 1_000_000 },
  });
  expect(context.fees).toEqual([1_000_000, 1_000_000]);
  const immediate = kernel([]);
  const result = await immediate.slrd.executeTradePlan("wallet", immediate.build, "rpc", "buy", { waitForConfirmation: false });
  expect(result.receipt.status).toBe("submitted");
  expect(immediate.fees).toHaveLength(1);
});

test("expiry proof requires finalized height and successful history plus metadata absence", async () => {
  const calls: Array<string> = [];
  const connection = {
    async getBlockHeight(commitment: string) { calls.push(commitment); return 101; },
    async getSignatureStatuses() { calls.push("history"); return { value: [null] }; },
    async getTransaction() { calls.push("transaction"); return null; },
  } as unknown as Connection;
  expect(await inspectExpiredSubmission(connection, "signature", 100)).toBe("expired-unobserved");
  expect(calls).toEqual(["finalized", "history", "transaction"]);
  connection.getSignatureStatuses = async () => ({ value: [{ confirmationStatus: "processed" }] } as unknown as Awaited<ReturnType<Connection["getSignatureStatuses"]>>);
  expect(await inspectExpiredSubmission(connection, "signature", 100)).toBe("observed");
  connection.getSignatureStatuses = async () => { throw new Error("RPC unavailable"); };
  expect(await inspectExpiredSubmission(connection, "signature", 100)).toBe("unknown");
});
