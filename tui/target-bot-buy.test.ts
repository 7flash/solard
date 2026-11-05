import { expect, test } from "bun:test";
import { buyLimitSol } from "./target-bot.ts";

const levels = [5500, 8375, 11250, 14125];
test("a buy may pay up to the range level it is buying for", () => {
  expect(buyLimitSol(levels, 6600, 300)).toBe(8375);
  expect(buyLimitSol(levels, 5000, 300)).toBe(5500);
});
test("a level just above the price keeps the old stream room", () => {
  expect(buyLimitSol(levels, 8370, 300)).toBeCloseTo(9207, 0);
  expect(buyLimitSol(levels, 20000, 300)).toBeCloseTo(22000, 0);
});
