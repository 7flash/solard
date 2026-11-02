import { expect, test } from "bun:test";
import { splitAmount, stepRungs } from "./range-steps.ts";
import { parseRangeFile, parseRangeSteps } from "./range-file.ts";

test("one step is the plain range", () => {
  expect(stepRungs("7000", "11000", 1, "0.1")).toEqual([{ slice: "s0", buy: "7000", sell: "11000", amount: "0.1" }]);
});

test("four steps split the range and the amount evenly", () => {
  expect(stepRungs("7000", "11000", 4, "0.1")).toEqual([
    { slice: "s0", buy: "7000", sell: "8000", amount: "0.025" },
    { slice: "s1", buy: "8000", sell: "9000", amount: "0.025" },
    { slice: "s2", buy: "9000", sell: "10000", amount: "0.025" },
    { slice: "s3", buy: "10000", sell: "11000", amount: "0.025" },
  ]);
});

test("amount per step is whole lamports and has a floor", () => {
  expect(splitAmount("0.1", 3)).toBe("0.033333333");
  expect(() => splitAmount("0.002", 4)).toThrow("too small");
  expect(() => stepRungs("11000", "7000", 2, "0.1")).toThrow("above");
});

test("range files accept an optional steps field", () => {
  const text = JSON.stringify({ buyMarketCapUsd: "7000", sellMarketCapUsd: "11000", steps: 4 });
  expect(parseRangeSteps(text)).toBe(4);
  expect(parseRangeFile(text)).toMatchObject({ kind: "market-cap", buyMarketCapUsd: "7000" });
  expect(parseRangeSteps(JSON.stringify({ buyMarketCapUsd: "1", sellMarketCapUsd: "2" }))).toBe(1);
  expect(() => parseRangeSteps(JSON.stringify({ buyMarketCapUsd: "1", sellMarketCapUsd: "2", steps: 0 }))).toThrow();
});
