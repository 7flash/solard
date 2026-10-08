import { expect, test } from "bun:test";
import { Solard } from "./solard.ts";
import { sol } from "./amounts.ts";
import { Keypair } from "@solana/web3.js";
import type { PlannedTransaction } from "../tx/types.ts";
import { TransactionComposer } from "../tx/composer.ts";
import type { TransactionDraft } from "../tx/types.ts";

// Exercise the convenience methods and real priority-fee builder without RPC,
// wallet keys, database initialization, or transaction submission.
function harness(failFirstBuy = false) {
  const slrd: Solard = Object.create(Solard.prototype);
  const drafts: Array<TransactionDraft> = [];
  const payer = Keypair.generate();
  slrd.signer = () => payer;
  slrd.compile = async (_payer, draft) =>
    ({ payer: payer.publicKey, draft }) as PlannedTransaction;
  slrd.connection = () =>
    ({
      async getRecentPrioritizationFees() {
        return [];
      },
    }) as unknown as ReturnType<Solard["connection"]>;
  Object.defineProperty(slrd, "cache", { value: { invalidate() {} } });
  slrd.submitPlan = async (plan) => {
    if (failFirstBuy && drafts.length === 1)
      throw new Error("Simulation failed: BuySlippageBelowMinBaseAmountOut");
    return { plan, signature: "test-signature", sender: "rpc", executionId: 1 };
  };
  slrd.settleSubmission = async () => ({
    signature: "test-signature",
    sender: "rpc",
    slot: null,
    status: "submitted",
  });
  slrd.tx = (wallet) => {
    const composer = new TransactionComposer(slrd, wallet);
    composer.buy = () => composer;
    composer.sell = () => composer;
    composer.build = async () => {
      drafts.push(composer.snapshot());
      return {
        payer: payer.publicKey,
        draft: composer.snapshot(),
      } as PlannedTransaction;
    };
    return composer;
  };
  return { slrd, drafts };
}

test("direct buy and sell preserve custom priority fees and submitted receipts", async () => {
  const { slrd, drafts } = harness();
  const priorityFee = { cuLimit: 300_000, microLamports: 250_000 };
  const buy = await slrd.buy("token", "wallet", sol(0.1), { priorityFee });
  const sell = await slrd.sell("token", "wallet", { priorityFee });
  for (const draft of drafts) {
    expect(draft.cuLimit).toBe(300_000);
    expect(draft.cuPriceMicroLamports).toBe(250_000);
  }
  expect(buy.status).toBe("unresolved");
  expect(sell.status).toBe("unresolved");
});

test("omitted priority fees leave assembly defaults intact", async () => {
  const { slrd, drafts } = harness();
  await slrd.buy("token", "wallet", sol(0.1));
  await slrd.sell("token", "wallet");
  for (const draft of drafts) {
    expect(draft.cuLimit).toBeUndefined();
    expect(draft.cuPriceMicroLamports).toBeUndefined();
  }
});

test("zero priority price and partial fee options survive direct trade methods", async () => {
  const { slrd, drafts } = harness();
  await slrd.buy("token", "wallet", sol(0.1), {
    priorityFee: { microLamports: 0 },
  });
  await slrd.sell("token", "wallet", { priorityFee: { cuLimit: 400_000 } });
  expect(drafts[0]!.cuPriceMicroLamports).toBe(0);
  expect(drafts[0]!.cuLimit).toBeUndefined();
  expect(drafts[1]!.cuLimit).toBe(400_000);
  expect(drafts[1]!.cuPriceMicroLamports).toBeUndefined();
});

test("the one-time PumpSwap buy rebuild retains the custom fee", async () => {
  const { slrd, drafts } = harness(true);
  await slrd.buy("token", "wallet", sol(0.1), {
    priorityFee: { cuLimit: 350_000, microLamports: 200_000 },
  });
  expect(drafts).toHaveLength(2);
  for (const draft of drafts) {
    expect(draft.cuLimit).toBe(350_000);
    expect(draft.cuPriceMicroLamports).toBe(200_000);
  }
});

test("skipping simulation does not rebuild a rejected buy", async () => {
  const { slrd, drafts } = harness(true);
  const result = await slrd.buy("token", "wallet", sol(0.1), {
    skipSimulation: true,
    priorityFee: { microLamports: 200_000 },
  });
  expect(result.status).toBe("failed");
  expect(result.message).toContain("Simulation failed");
  expect(drafts).toHaveLength(1);
});
