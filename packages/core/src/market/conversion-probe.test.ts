import { expect, test } from "bun:test";
import { probeQuoteSol } from "./conversion-probe.ts";

test("BTC conversion uses small notional instead of a market-moving 100 BTC sale", async () => {
  const amounts: bigint[] = [];
  const price = await probeQuoteSol(8, async amount => {
    amounts.push(amount);
    return amount * 10000n;
  });
  expect(price).toBeCloseTo(1000, 8);
  expect(amounts).toEqual([100000n, 1000n]);
});
test("low price assets scale upward; unavailable quotes cannot fabricate prices", async () => {
  expect(await probeQuoteSol(6, async amount => amount / 100n)).toBe(0.00001);
  await expect(probeQuoteSol(8, async () => 0n)).rejects.toThrow("unavailable");
  await expect(probeQuoteSol(8, async () => { throw Error("provider failed"); })).rejects.toThrow("provider failed");
});
