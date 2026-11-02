import { expect, test } from "bun:test";
import { retryLiquidationRead, runLiquidationWallets } from "./liquidation-wallets.ts";

test("read quota failures back off, keep completed wallets, never replay execution", async () => {
  const starts: string[] = [], executions: string[] = [], waits: number[] = [];
  let reads = 0;
  const failures = await runLiquidationWallets(["a", "a", "b", "c"], async wallet => {
    await retryLiquidationRead(async () => {
      if (wallet === "b" && reads++ < 2) throw Error("RPC_PROVIDER_UNAVAILABLE");
    }, () => {}, async ms => { waits.push(ms); });
    executions.push(wallet);
    if (wallet === "b") throw Error("Submission outcome uncertain");
  }, wallet => starts.push(wallet), () => {});
  expect(starts).toEqual(["a", "b", "c"]);
  expect(executions).toEqual(["a", "b", "c"]);
  expect(failures).toEqual(["b"]);
  expect(waits).toEqual([5000, 10000]);
});

test("invalid metadata is not retried; provider failures are bounded", async () => {
  let calls = 0;
  await expect(retryLiquidationRead(async () => { calls++; throw Error("Unknown wallet"); }, () => {}, async () => {})).rejects.toThrow("Unknown wallet");
  expect(calls).toBe(1);
  calls = 0;
  await expect(retryLiquidationRead(async () => { calls++; throw Error("HTTP 429"); }, () => {}, async () => {})).rejects.toThrow("429");
  expect(calls).toBe(7);
});
