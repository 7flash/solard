import { expect, test } from "bun:test";
import { tradeFeeOptions } from "./trade-fees.ts";

test("native buy/sell fee flags preserve custom compute limit and price", () => {
  expect(tradeFeeOptions(new Map([
    ["cu-limit", "150000"], ["priority-micro-lamports", "1000000"],
    ["trade-attempts", "4"], ["max-priority-fee-lamports", "500000"],
  ]))).toMatchObject({ priorityFee: { cuLimit: 150_000, microLamports: 1_000_000 },
    landing: { maxAttempts: 4, maxPriorityFeeLamports: 500_000 } });
});

test("invalid fee flags reject instead of being ignored", () => {
  for (const [name, value] of [["cu-limit", "0"], ["priority-micro-lamports", "-1"], ["priority-micro-lamports", "true"]])
    expect(() => tradeFeeOptions(new Map([[name!, value!]]))).toThrow();
});
