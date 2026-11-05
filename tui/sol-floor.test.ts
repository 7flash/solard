import { expect, test } from "bun:test";
import { buyRoom } from "./sol-floor.ts";

const now = 10_000_000_000, old = now - 3_600_000;
test("a buy that fits above the floor is left alone", () => {
  expect(buyRoom({ freeSol: 0.5, buySol: 0.03, addedAtMs: old, nowMs: now })).toBe(0.03);
});
test("a buy too big for the floor is cut, not dropped", () => {
  expect(buyRoom({ freeSol: 0.189, buySol: 0.15, addedAtMs: old, nowMs: now })).toBeCloseTo(0.089);
});
test("no room at all gives zero", () => {
  expect(buyRoom({ freeSol: 0.05, buySol: 0.01, addedAtMs: null, nowMs: now })).toBe(0);
});
test("a new pair may use the floor", () => {
  expect(buyRoom({ freeSol: 0.06, buySol: 0.05, addedAtMs: now - 60_000, nowMs: now })).toBe(0.05);
  expect(buyRoom({ freeSol: 0.06, buySol: 0.05, addedAtMs: now - 31 * 60_000, nowMs: now })).toBe(0);
});
test("an unknown balance blocks routine buys", () => {
  expect(buyRoom({ freeSol: null, buySol: 0.01, addedAtMs: old, nowMs: now })).toBe(0);
});
