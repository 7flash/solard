import { test, expect } from "bun:test";
import { estimatePlanFee } from "./fee-estimate.ts";
import { checkPlanBalanceAndFee } from "./balance-preflight.ts";
import { PublicKey } from "@solana/web3.js";

test("submission reuses the exact-message fee from balance preflight without a second RPC", async () => {
  let feeReads = 0;
  const connection = {
    getBalance: async () => 1000000,
    getFeeForMessage: async () => { feeReads++; return { value: 65000 }; },
  } as any;
  const plan = { payer: PublicKey.default, transaction: { message: { staticAccountKeys: [PublicKey.default] } },
    draft: { instructions: [], actions: [], cuLimit: 600000, cuPriceMicroLamports: 100000 } } as any;
  const verifiedFee = await checkPlanBalanceAndFee(connection, plan);
  const estimate = await estimatePlanFee(connection, plan, verifiedFee);
  expect(feeReads).toBe(1);
  expect(estimate.estimatedNetworkFeeLamports).toBe(65000);
  expect(estimate.estimatedBaseFeeLamports).toBe(5000);
  await expect(estimatePlanFee(connection, plan, -1)).rejects.toThrow();
});
test("selected priority charge rounds upward and unknown RPC estimate remains unavailable", async () => {
  const plan = {
    draft: { cuLimit: 10001, cuPriceMicroLamports: 100 },
    transaction: { message: {} },
  } as any;
  expect(
    await estimatePlanFee(
      { getFeeForMessage: async () => ({ value: 5002 }) } as any,
      plan,
    ),
  ).toEqual({
    cuLimit: 10001,
    priorityMicroLamports: 100,
    priorityFeeLamports: 2,
    estimatedBaseFeeLamports: 5000,
    estimatedNetworkFeeLamports: 5002,
  });
  expect(
    await estimatePlanFee(
      {
        getFeeForMessage: async () => {
          throw new Error("RPC offline");
        },
      } as any,
      plan,
    ),
  ).toMatchObject({
    priorityFeeLamports: 2,
    estimatedNetworkFeeLamports: null,
    estimatedBaseFeeLamports: null,
  });
});
