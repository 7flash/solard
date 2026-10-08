import { test, expect } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { Solard, estimatePlanFee, type PlannedTransaction } from "@solard/core";
import { runTransferCommand } from "./transfer.ts";
function fixture(status: "confirmed" | "submitted" | "failed" = "confirmed") {
  const core: Solard = Object.create(Solard.prototype);
  const payer = Keypair.generate();
  const prices: number[] = [];
  let samples = 0;
  core.signer = () => payer;
  core.connection = () =>
    ({
      getRecentPrioritizationFees: async () => {
        samples++;
        return [200_000, 400_000, 800_000, 1_000_000].map(
          (prioritizationFee) => ({ prioritizationFee }),
        );
      },
      getFeeForMessage: async (message: { price: number }) => ({
        value: 5000 + Math.ceil((10_000 * message.price) / 1_000_000),
      }),
    }) as any;
  core.compile = async (_payer, draft) =>
    ({
      draft,
      payer: payer.publicKey,
      transaction: {
        message: { price: draft.cuPriceMicroLamports ?? 100_000 },
      },
    }) as unknown as PlannedTransaction;
  core.submitPlan = async (plan, sender) => {
    prices.push(plan.draft.cuPriceMicroLamports!);
    return {
      signature: "test-signature",
      executionId: 1,
      sender,
      plan,
      feeEstimate: await estimatePlanFee(core.connection(), plan),
    };
  };
  core.settleSubmission = async () => ({
    signature: "test-signature",
    sender: "rpc",
    status,
    slot: status === "confirmed" ? 1 : null,
    ...(status === "confirmed" ? { feeLamports: 13000 } : {}),
  });
  Object.defineProperty(core, "executions", {
    value: { get: () => ({ metaJson: null }) },
  });
  return { core, prices, samples: () => samples };
}
const flags = (extra: Array<[string, string]> = []) =>
  new Map([["wallet", "bags"], ["sol", "2"], ["live", "true"], ...extra]);
test("SOL transfer uses writable market fees and reports selected versus actual network fees", async () => {
  const ctx = fixture();
  const result = await runTransferCommand({
    slrd: ctx.core,
    values: [Keypair.generate().publicKey.toBase58()],
    flags: flags(),
  });
  expect(ctx.prices).toEqual([800_000]);
  expect(ctx.samples()).toBe(1);
  expect(result.status).toBe("confirmed");
  expect(result.feeEstimate).toEqual({
    cuLimit: 10_000,
    priorityMicroLamports: 800_000,
    priorityFeeLamports: 8000,
    estimatedBaseFeeLamports: 5000,
    estimatedNetworkFeeLamports: 13000,
  });
  expect(result.feeLamports).toBe(13000);
});
test("explicit zero disables transfer fee estimation and pending outcome is never repeated blindly", async () => {
  const ctx = fixture("submitted");
  const result = await runTransferCommand({
    slrd: ctx.core,
    values: [Keypair.generate().publicKey.toBase58()],
    flags: flags([["priority-micro-lamports", "0"]]),
  });
  expect(ctx.prices).toEqual([0]);
  expect(ctx.samples()).toBe(0);
  expect(result.status).toBe("unresolved");
  expect(result.code).toBe("UNRESOLVED");
  expect(result.feeLamports).toBeUndefined();
  expect(result.feeEstimate).toMatchObject({
    priorityFeeLamports: 0,
    estimatedNetworkFeeLamports: 5000,
  });
});
