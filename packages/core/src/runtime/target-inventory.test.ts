import { expect, test } from "bun:test";
import { rangeLevels, targetPlan } from "./target-inventory.ts";

// Prices in SOL/token; 6 decimals like pump tokens. Range 20..50 in 3 steps: 20,30,40,50 (scaled 1e-7).
const L = rangeLevels(20, 50, 3).map(x => x * 1e-7);
const base = { levels: L, budgetSol: 0.3, decimals: 6 };
const step = (i: number) => BigInt(Math.floor(0.1 / L[i]! * 1e6)); // tokens owned by step i

test("one step is the plain range bot", () => {
  const one = { levels: [20e-7, 50e-7], budgetSol: 0.1, decimals: 6 };
  expect(targetPlan({ ...one, balanceRaw: 0n, priceSol: 25e-7 }).action).toBeNull();          // in band, flat: wait
  expect(targetPlan({ ...one, balanceRaw: 0n, priceSol: 19e-7 }).action?.side).toBe("buy");   // at/below buy
  const held = BigInt(Math.floor(0.1 / 20e-7 * 1e6));
  expect(targetPlan({ ...one, balanceRaw: held, priceSol: 30e-7 }).action).toBeNull();        // in band, holding: keep
  expect(targetPlan({ ...one, balanceRaw: held, priceSol: 50e-7 }).action).toEqual({ side: "sell", amountRaw: held });
});

test("steps fill from the top as price falls and empty as it rises", () => {
  const p = targetPlan({ ...base, balanceRaw: 0n, priceSol: 35e-7 });
  expect(p.target).toBe(1);                                   // below 40: top step must be held
  expect(p.action).toMatchObject({ side: "buy", tokensRaw: step(2) });
  const all = step(0) + step(1) + step(2);
  expect(targetPlan({ ...base, balanceRaw: 0n, priceSol: 19e-7 }).target).toBe(3);
  const up = targetPlan({ ...base, balanceRaw: all, priceSol: 32e-7 });   // above 30: lowest step must sell
  expect(up.target).toBe(2);
  expect(up.action).toEqual({ side: "sell", amountRaw: step(0) });
  expect(targetPlan({ ...base, balanceRaw: all, priceSol: 25e-7 }).action).toBeNull();
});

test("external buys above budget are sold; external sells are re-bought only where the price says hold", () => {
  const all = step(0) + step(1) + step(2);
  expect(targetPlan({ ...base, balanceRaw: all * 3n, priceSol: 25e-7 }).action).toEqual({ side: "sell", amountRaw: all * 2n });
  // Sold outside while in band (price 35): only the top step is required, so one step is bought back.
  expect(targetPlan({ ...base, balanceRaw: 0n, priceSol: 35e-7 }).target).toBe(1);
  // Far below the range: hold everything, but never more than the budget (no averaging down).
  expect(targetPlan({ ...base, balanceRaw: all, priceSol: 5e-7 }).action).toBeNull();
});

test("below the range nothing is sold, even above budget", () => {
  const all = step(0) + step(1) + step(2);
  expect(targetPlan({ ...base, balanceRaw: all * 4n, priceSol: 10e-7 }).action).toBeNull();
  expect(targetPlan({ ...base, balanceRaw: all * 4n, priceSol: 20e-7 }).action?.side).toBe("sell");
});

test("paused buys never buy; small gaps are ignored", () => {
  expect(targetPlan({ ...base, balanceRaw: 0n, priceSol: 19e-7, buysPaused: true }).action).toBeNull();
  const all = step(0) + step(1) + step(2);
  expect(targetPlan({ ...base, balanceRaw: all - step(2) / 10n, priceSol: 19e-7 }).action).toBeNull();
  expect(targetPlan({ ...base, balanceRaw: all, priceSol: 25e-7 })).toMatchObject({ nextSell: 30e-7, nextBuy: null });
});
