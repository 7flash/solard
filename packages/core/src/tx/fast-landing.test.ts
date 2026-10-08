import { expect, test } from "bun:test";
import { PublicKey, type Connection, type Keypair } from "@solana/web3.js";
import { Solard } from "../core/solard.ts";
import type {
  PlannedTransaction,
  SimulationResult,
  TransactionDraft,
} from "./types.ts";

function simulation(
  overrides: Partial<SimulationResult> = {},
): SimulationResult {
  return {
    success: true,
    cuUsed: 105_000,
    error: null,
    logs: [],
    accountChanges: [],
    tokenChanges: [],
    solChanges: [],
    ...overrides,
  };
}
function kernel(results = [simulation()], notional = "100000000") {
  const slrd: Solard = Object.create(Solard.prototype);
  const payer = new PublicKey("11111111111111111111111111111111");
  const draft: TransactionDraft = {
    instructions: [],
    actions: [{ kind: "buy", meta: { inputRaw: notional } }],
    signers: [],
    trackedAccounts: [],
    cuLimit: 600_000,
  };
  const original = { payer, draft } as PlannedTransaction;
  const compiles: TransactionDraft[] = [];
  const probes: PlannedTransaction[] = [];
  let samples = 0;
  // Compile and signer are structural fakes; no key generation, signing or sending.
  slrd.signer = () => ({ publicKey: payer }) as Keypair;
  slrd.compile = async (_signer, next) => {
    compiles.push(next);
    return { ...original, draft: next };
  };
  slrd.simulatePlan = async (probe) => {
    probes.push(probe);
    return results.shift() ?? simulation();
  };
  slrd.connection = () =>
    ({
      async getRecentPrioritizationFees() {
        samples++;
        return [{ prioritizationFee: 5 }];
      },
    }) as unknown as Connection;
  return { slrd, original, compiles, probes, samples: () => samples };
}

test("automatic CU sizing includes one Helius tip before probing and preserves a low fixed fee", async () => {
  const k = kernel();
  const prepared = await k.slrd.prepareTradePlan("fake", k.original, {
    landing: {
      route: "helius-swqos",
      cuLimit: "auto",
      computeUnitMultiplier: 1.3,
      priorityMicroLamports: 20_000,
    },
  });
  expect(prepared.plan.draft.cuLimit).toBe(136_500);
  expect(prepared.priorityMicroLamports).toBe(20_000);
  expect(k.samples()).toBe(0);
  expect(k.probes).toHaveLength(1);
  expect(
    k.probes[0]!.draft.actions.filter(
      (action) => action.kind === "landing-tip",
    ),
  ).toHaveLength(1);
  expect(k.probes[0]!.draft.instructions).toHaveLength(1);
  expect(
    prepared.plan.draft.actions.find((action) => action.kind === "landing-tip")
      ?.meta?.lamports,
  ).toBe(5_000);
  const again = await k.slrd.prepareTradePlan("fake", prepared.plan, {
    landing: { route: "helius-swqos", priorityMicroLamports: 20_000 },
  });
  expect(again.plan.draft.instructions).toHaveLength(1);
  expect(
    again.plan.draft.actions.filter((action) => action.kind === "landing-tip"),
  ).toHaveLength(1);
  expect(k.original.draft.instructions).toHaveLength(0);
});

test("compute budget failure gets one larger probe before measured sizing", async () => {
  const k = kernel([
    simulation({
      success: false,
      cuUsed: 600_000,
      error: { InstructionError: [0, "ComputationalBudgetExceeded"] },
    }),
    simulation(),
  ]);
  const prepared = await k.slrd.prepareTradePlan("fake", k.original, {
    landing: { cuLimit: "auto", priorityMicroLamports: 20_000 },
  });
  expect(k.compiles.map((draft) => draft.cuLimit)).toEqual([
    600_000, 1_400_000, 136_500,
  ]);
  expect(prepared.plan.draft.cuLimit).toBe(136_500);
  const twice = kernel([
    simulation({ success: false, error: "ComputationalBudgetExceeded" }),
    simulation({ success: false, error: "ComputationalBudgetExceeded" }),
  ]);
  await expect(
    twice.slrd.prepareTradePlan("fake", twice.original, {
      landing: { cuLimit: "auto" },
    }),
  ).rejects.toThrow("Simulation failed");
  expect(twice.probes).toHaveLength(2);
});

test("configured floor permits a five micro-lamport automatic bid", async () => {
  const k = kernel();
  const prepared = await k.slrd.prepareTradePlan("fake", k.original, {
    landing: { minMicroLamports: 0 },
  });
  expect(prepared.priorityMicroLamports).toBe(5);
  expect(k.samples()).toBe(1);
});

test("notional fee cap includes the mandatory Helius tip", async () => {
  const tiny = kernel(undefined, "100000");
  await expect(
    tiny.slrd.prepareTradePlan("fake", tiny.original, {
      landing: {
        route: "helius-swqos",
        maxFeeBpsOfNotional: 500,
        minMicroLamports: 0,
      },
    }),
  ).rejects.toMatchObject({ code: "FEE_CAP_EXCEEDED" });
  expect(tiny.compiles).toHaveLength(0);
  const capped = kernel(undefined, "1000000");
  const prepared = await capped.slrd.prepareTradePlan("fake", capped.original, {
    landing: { route: "helius-swqos", maxFeeBpsOfNotional: 500 },
  });
  const priority = Math.ceil(
    (prepared.priorityMicroLamports * prepared.plan.draft.cuLimit!) / 1_000_000,
  );
  expect(priority + 5_000 + 5_000).toBeLessThanOrEqual(50_000);
});
