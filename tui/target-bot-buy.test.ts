import { expect, test } from "bun:test";
import { buySlippageBps } from "./target-bot.ts";

const levels = [5500, 8375, 11250, 14125];
test("a buy has room up to the next range level", () => {
  expect(buySlippageBps(levels, 6600, 300)).toBe(2690);
  expect(buySlippageBps(levels, 5000, 300)).toBe(1000);
});
test("never tighter than the base, and no room past the top", () => {
  expect(buySlippageBps(levels, 8370, 300)).toBe(300);
  expect(buySlippageBps(levels, 20000, 300)).toBe(300);
});
