import { expect, test } from "bun:test";
import { rangeLevels, targetPlan } from "../packages/core/src/runtime/target-inventory.ts";
import { recenter, smartEntrySize } from "./recenter.ts";

const supply = 1e9, solUsd = 90, d = 6;
const at = (capUsd: number) => capUsd / (supply * solUsd);
const raw = (tokens: number) => BigInt(Math.floor(tokens * 10 ** d));

test("moving a range never trades, whatever the bag", () => {
  for (const cap of [3_500, 8_000, 25_000, 90_000, 400_000, 1_500_000]) for (const sol of [0.001, 0.008, 0.05, 0.3]) {
    const priceSol = at(cap), balanceRaw = raw(sol / priceSol), r = recenter({ capUsd: cap, priceSol, balanceRaw, decimals: d, baseSol: 0.05, floorCapUsd: 3_000 });
    expect(r).not.toBeNull();
    const levels = rangeLevels(r!.buy, r!.sell, r!.steps).map(x => x / (supply * solUsd));
    expect(targetPlan({ levels, budgetSol: r!.budgetSol, balanceRaw, decimals: d, priceSol }).action).toBeNull();
  }
});
test("a dumped bag gets a size that matches it, not the old one", () => {
  const cap = 20_000, priceSol = at(cap), r = recenter({ capUsd: cap, priceSol, balanceRaw: raw(0.008 / priceSol), decimals: d, baseSol: 0.05, floorCapUsd: 3_000 })!;
  expect(r.holding).toBe(true);
  expect(r.budgetSol).toBeLessThan(0.02);
  expect(r.buy).toBeCloseTo(14_000, -2); expect(r.sell).toBeCloseTo(32_000, -2);
});
test("an empty bot keeps its base size and trades the new range", () => {
  const cap = 100_000, priceSol = at(cap), r = recenter({ capUsd: cap, priceSol, balanceRaw: 0n, decimals: d, baseSol: 0.02, floorCapUsd: 3_000 })!;
  expect(r).toMatchObject({ budgetSol: 0.02, holding: false });
});
test("never lifts a dying coin's range under the dead line", () => {
  expect(recenter({ capUsd: 2_500, priceSol: at(2_500), balanceRaw: raw(1e5), decimals: d, baseSol: 0.05, floorCapUsd: 3_000 })).toBeNull();
  expect(recenter({ capUsd: 3_500, priceSol: at(3_500), balanceRaw: raw(1e6), decimals: d, baseSol: 0.05, floorCapUsd: 3_000 })!.buy).toBeGreaterThanOrEqual(3_000);
});
test("uses the chart band when it has one, and still never trades", () => {
  const cap = 50_000, priceSol = at(cap), balanceRaw = raw(0.02 / priceSol);
  const r = recenter({ capUsd: cap, priceSol, balanceRaw, decimals: d, baseSol: 0.05, floorCapUsd: 3_000, band: { lo: 30_000, hi: 90_000 } })!;
  expect(r.buy).toBe(30_000); expect(r.sell).toBe(90_000); expect(r.steps).toBe(5);
  const levels = rangeLevels(r.buy, r.sell, r.steps).map(x => x / (supply * solUsd));
  expect(targetPlan({ levels, budgetSol: r.budgetSol, balanceRaw, decimals: d, priceSol }).action).toBeNull();
});
test("a flat chart band falls back to the blanket range", () => {
  const cap = 50_000, r = recenter({ capUsd: cap, priceSol: at(cap), balanceRaw: 0n, decimals: d, baseSol: 0.05, floorCapUsd: 3_000, band: { lo: 49_000, hi: 52_000 } })!;
  expect(r.buy).toBe(35_000); expect(r.steps).toBe(3);
});
test("an underwater bag sells only at or above what it cost, and the move still does not trade", () => {
  const cap = 35_000, priceSol = at(cap), tokens = 0.03 / priceSol, balanceRaw = raw(tokens); // 0.08 SOL in, worth 0.03
  const r = recenter({ capUsd: cap, priceSol, balanceRaw, decimals: d, baseSol: 0.08, floorCapUsd: 3_000, flowSol: -0.08 })!;
  expect(r.steps).toBe(1);
  expect(r.sell * (0.03 / cap)).toBeGreaterThanOrEqual(0.08);
  const levels = [r.buy, r.sell].map(x => x / (supply * solUsd));
  expect(targetPlan({ levels, budgetSol: r.budgetSol, balanceRaw, decimals: d, priceSol }).action).toBeNull();
  // a rally short of break-even keeps the bag; at break-even it sells
  expect(targetPlan({ levels, budgetSol: r.budgetSol, balanceRaw, decimals: d, priceSol: at(r.sell * 0.95) }).action).toBeNull();
  expect(targetPlan({ levels, budgetSol: r.budgetSol, balanceRaw, decimals: d, priceSol: at(r.sell) }).action?.side).toBe("sell");
});
test("more volume: wider range and bigger size, capped; bags ignore it", () => {
  const cap = 100_000, priceSol = at(cap), base = { capUsd: cap, priceSol, decimals: d, baseSol: 0.02, floorCapUsd: 3_000 };
  const groyper = recenter({ ...base, balanceRaw: 0n, volSol1h: 18_000 })!;
  expect(groyper).toMatchObject({ buy: 25_000, sell: 150_000, steps: 4, budgetSol: 0.2 });
  expect(recenter({ ...base, balanceRaw: 0n, volSol1h: 50 })).toMatchObject({ buy: 70_000, budgetSol: 0.02 });
  expect(recenter({ ...base, baseSol: 0.1, balanceRaw: 0n, volSol1h: 18_000 })!.budgetSol).toBe(0.2);
  expect(recenter({ ...base, balanceRaw: raw(0.05 / priceSol), volSol1h: 18_000 })!.budgetSol).toBeLessThan(0.15);
});
test("touched prices set the range, volume sets the size", () => {
  const cap = 100_000, r = recenter({ capUsd: cap, priceSol: at(cap), balanceRaw: 0n, decimals: d, baseSol: 0.02, floorCapUsd: 3_000, volSol1h: 18_000, band: { lo: 60_000, hi: 140_000 } })!;
  expect(r).toMatchObject({ buy: 60_000, sell: 140_000, budgetSol: 0.2 });
});
test("smart entries grow with the wallets in the coin, capped", () => {
  expect(smartEntrySize(0.05, 2)).toBe(0.1);
  expect(smartEntrySize(0.05, 3)).toBeCloseTo(0.15);
  expect(smartEntrySize(0.05, 8)).toBe(0.2);
  expect(smartEntrySize(0.3, 8)).toBe(0.3);
});
