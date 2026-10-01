import { test, expect } from "bun:test";
import { estimatePlanFee } from "./fee-estimate.ts";
test("selected priority charge rounds upward and unknown RPC estimate remains unavailable", async () => {
  const plan = { draft: { cuLimit: 10001, cuPriceMicroLamports: 100 }, transaction: { message: {} } } as any;
  expect(await estimatePlanFee({ getFeeForMessage: async () => ({ value: 5002 }) } as any, plan)).toEqual({ cuLimit: 10001, priorityMicroLamports: 100, priorityFeeLamports: 2, estimatedBaseFeeLamports: 5000, estimatedNetworkFeeLamports: 5002 });
  expect(await estimatePlanFee({ getFeeForMessage: async () => { throw new Error("RPC offline"); } } as any, plan)).toMatchObject({ priorityFeeLamports: 2, estimatedNetworkFeeLamports: null, estimatedBaseFeeLamports: null });
});
