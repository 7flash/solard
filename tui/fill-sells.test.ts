import { expect, test } from "bun:test";
import { consumeFills, fillFromBuy, fillsToSell, seedFromBag, type FillBook } from "./fill-sells.ts";

const book = (...fills: [number, number][]): FillBook => ({ seeded: true, rebuyAtSol: null, fills: fills.map(([priceSol, raw]) => ({ priceSol, raw: String(raw) })) });

test("a fill sells at the multiple, wherever the range is", () => {
  expect(fillsToSell(book([10, 100]), 12.9, 1.3)).toBeNull();
  const t = fillsToSell(book([10, 100]), 13, 1.3)!;
  expect(t.sellRaw).toBe(100n); expect(t.remaining).toEqual([]); expect(t.floorSol).toBe(10); expect(t.rebuyAtSol).toBe(10);
});
test("the rebuy follows the sale, not an old bag's average", () => {
  expect(fillsToSell(book([1, 100]), 13, 1.3)!.rebuyAtSol).toBe(10);
});
test("only the fills past their target sell", () => {
  const t = fillsToSell(book([10, 100], [28, 50]), 14, 1.3)!;
  expect(t.sellRaw).toBe(100n); expect(t.remaining).toEqual([{ priceSol: 28, raw: "50" }]);
});
test("a range sell takes the oldest fills first", () => {
  expect(consumeFills(book([10, 100], [20, 50]).fills, 120n)).toEqual([{ priceSol: 20, raw: "30" }]);
  expect(consumeFills(book([10, 100]).fills, 500n)).toEqual([]);
});
test("an old bag seeds one fill at average cost", () => {
  expect(seedFromBag(2_000_000n, 6, -0.02)).toEqual([{ priceSol: 0.01, raw: "2000000" }]);
  expect(seedFromBag(2_000_000n, 6, 0.01)).toEqual([]);
  expect(seedFromBag(0n, 6, -0.02)).toEqual([]);
});
test("a buy records the tokens its SOL bought", () => {
  expect(fillFromBuy(0.01, 0.001, 6)).toEqual({ priceSol: 0.001, raw: "10000000" });
});
