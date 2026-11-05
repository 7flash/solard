import { expect, test } from "bun:test";
import { startOutcome, stepOutcome } from "./kris-outcomes.ts";

const coin = { mint: "m", symbol: "M", capUsd: 100, traders: 50, trades: 80, smart: 1, volSol: 9 };
test("no cap, nothing to follow", () => { expect(startOutcome({ mint: "m" }, "coin", "skip", 0)).toBeNull(); });
test("each time is filled once, and high and low follow the cap", () => {
  const o = startOutcome(coin, "coin", "watch", 0)!;
  expect(stepOutcome(o, 150, 30_000)).toBe(false); expect(o.at).toEqual({});
  stepOutcome(o, 120, 61_000); stepOutcome(o, 200, 62_000);
  expect(o.at["1"]).toBe(120); expect(o.high).toBe(200);
  stepOutcome(o, 40, 181_000); expect(o.at["3"]).toBe(40); expect(o.low).toBe(40);
});
test("records which came first, up 20% or down 15%", () => {
  const o = startOutcome(coin, "coin", "skip", 0)!;
  stepOutcome(o, 110, 60_000); stepOutcome(o, 125, 120_000); stepOutcome(o, 80, 180_000); stepOutcome(o, 130, 240_000);
  expect(o.upMin).toBe(2); expect(o.downMin).toBe(3);
});
test("a coin that left the list records null and still finishes", () => {
  const o = startOutcome(coin, "coin", "skip", 0)!;
  expect(stepOutcome(o, null, 1_800_000)).toBe(true);
  expect(o.at).toEqual({ "1": null, "3": null, "5": null, "10": null, "30": null });
});
