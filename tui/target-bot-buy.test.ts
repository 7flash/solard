import { expect, test } from "bun:test";
import { buyOrder } from "./target-bot.ts";

const levels = [5500, 8375, 11250, 14125];
test("a buy always has room to land, at most 15%", () => {
  expect(buyOrder(levels, 8000, 300).slippageBps).toBeCloseTo(1000, -1);
  expect(buyOrder(levels, 6600, 300).slippageBps).toBe(1500);
  expect(buyOrder(levels, 8370, 300).slippageBps).toBeCloseTo(1000, -1);
});
test("a quote up to 5% over the level passes the guard, more does not", () => {
  const { slippageBps, maxPriceSol } = buyOrder(levels, 8000, 300);
  const worst = (quote: number) => quote * (1 + slippageBps / 10_000);
  expect(worst(8375 * 1.05)).toBeLessThanOrEqual(maxPriceSol * 1.0001);
  expect(worst(8800 * 1.1)).toBeGreaterThan(maxPriceSol);
});
