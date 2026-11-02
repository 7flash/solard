import { describe, expect, test } from "bun:test";
import { parseRangeAmount, parseRangeCommand, rangeBounds, rangeFileBody } from "./range-commands.ts";

describe("range console commands", () => {
  test("amount suffixes and formatting", () => {
    expect(parseRangeAmount("540k")).toBe("540000");
    expect(parseRangeAmount("1.2M")).toBe("1200000");
    expect(parseRangeAmount("$75,000")).toBe("75000");
    expect(parseRangeAmount("0.0000012")).toBe("0.0000012");
    expect(parseRangeAmount("1e-6")).toBe("1e-6");
    for (const bad of ["0", "-5", "abc", "5kk", ""]) expect(() => parseRangeAmount(bad)).toThrow();
  });

  test("commands", () => {
    expect(parseRangeCommand("b 540k")).toEqual({ kind: "set", buy: "540000" });
    expect(parseRangeCommand("sell 600k")).toEqual({ kind: "set", sell: "600000" });
    expect(parseRangeCommand("r 540k 600k")).toEqual({ kind: "set", buy: "540000", sell: "600000" });
    expect(parseRangeCommand("540k 600k")).toEqual({ kind: "set", buy: "540000", sell: "600000" });
    expect(parseRangeCommand("  ")).toEqual({ kind: "noop" });
    expect(parseRangeCommand("st").kind).toBe("status");
    expect(parseRangeCommand("q").kind).toBe("quit");
    expect(() => parseRangeCommand("b")).toThrow();
    expect(() => parseRangeCommand("frobnicate")).toThrow();
  });

  test("range file bodies round-trip through the engine parser", () => {
    const usd = rangeFileBody("usd", "540000", "580000");
    expect(usd.spec.kind).toBe("market-cap");
    expect(rangeBounds(usd.spec)).toEqual({ unit: "usd", buy: "540000", sell: "580000" });
    const sol = rangeFileBody("sol", "0.000001", "0.0000012");
    expect(rangeBounds(sol.spec)).toEqual({ unit: "sol", buy: "0.000001", sell: "0.0000012" });
    expect(() => rangeFileBody("sol", "2", "1")).toThrow(); // fixed SOL band requires sell > buy
    expect((rangeFileBody("usd", "600000", "500000").spec as { entryPaused?: true }).entryPaused).toBe(true);
  });
});

import { parseRangeLevel } from "./range-commands.ts";
test("bare USD market caps are thousands; suffixes and SOL prices are literal", () => {
  expect(parseRangeLevel("7", "usd")).toBe("7000");
  expect(parseRangeLevel("7.5", "usd")).toBe("7500");
  expect(parseRangeLevel("11k", "usd")).toBe("11000");
  expect(parseRangeLevel("1.2m", "usd")).toBe("1200000");
  expect(parseRangeLevel("75000", "usd")).toBe("75000");
  expect(parseRangeLevel("0.0000012", "sol")).toBe("0.0000012");
  expect(parseRangeCommand("7 11")).toEqual({ kind: "set", buy: "7000", sell: "11000" });
  expect(parseRangeCommand("b 6.5")).toEqual({ kind: "set", buy: "6500" });
});

test("steps: 7 11 4, r 7 11 4, steps 4", () => {
  expect(parseRangeCommand("7 11 4")).toEqual({ kind: "set", buy: "7000", sell: "11000", steps: 4 });
  expect(parseRangeCommand("r 7 11 4")).toEqual({ kind: "set", buy: "7000", sell: "11000", steps: 4 });
  expect(parseRangeCommand("steps 3")).toEqual({ kind: "set", steps: 3 });
  expect(() => parseRangeCommand("7 11 0")).toThrow("steps");
  expect(rangeFileBody("usd", "7000", "11000", 4).text).toContain('"steps": 4');
  expect(rangeFileBody("usd", "7000", "11000", 1).text).not.toContain("steps");
});
