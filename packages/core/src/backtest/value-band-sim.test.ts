import { describe, expect, test } from "bun:test";
import { simulateValueBandStrategy } from "./value-band-sim.ts";

const policy = {
  version: 1 as const,
  kind: "value-band" as const,
  baseSol: 0.1,
  lowerMultiple: 0.5,
  upperMultiple: 1.8,
  sellFraction: 0.5,
  buyMode: "same-value" as const,
  minTradeSol: 0,
  maxCapitalDeployedSol: 0.2,
};

describe("value-band backtest", () => {
  test("smooth ten-x trails hold but realizes repeated upper-band sells", () => {
    const prices = [1, 1.8, 3.6, 7.2, 10].map((priceSol, i) => ({
      atMs: i + 1,
      priceSol,
    }));
    const result = simulateValueBandStrategy(prices, policy, {
      startingSol: 1,
    });
    expect(result.summary.sells).toBeGreaterThanOrEqual(3);
    expect(result.summary.finalEquitySol).toBeLessThan(1.9); // 0.9 idle + 1.0 hold sleeve benchmark
  });

  test("repeated collapse cannot exceed the capital cap", () => {
    const prices = [1, 0.49, 0.24, 0.12, 0.06, 0.03].map((priceSol, i) => ({
      atMs: i + 1,
      priceSol,
    }));
    const result = simulateValueBandStrategy(prices, policy, {
      startingSol: 1,
    });
    expect(result.summary.peakNetCapitalDeployedSol).toBeLessThanOrEqual(
      0.200000001,
    );
  });

  test("a 70% upper sale cannot manufacture an immediate lower buy", () => {
    const crossingPolicy = {
      ...policy,
      lowerMultiple: 0.6,
      upperMultiple: 1.3,
      sellFraction: 0.7,
      maxCapitalDeployedSol: 0.5,
    };
    const prices = [1, 1.3, 1.3].map((priceSol, i) => ({
      atMs: i + 1,
      priceSol,
    }));
    const result = simulateValueBandStrategy(prices, crossingPolicy, {
      startingSol: 1,
    });
    expect(result.executions.map((row) => row.side)).toEqual(["buy", "sell"]);
    expect(result.summary.buys).toBe(1);
    expect(result.summary.sells).toBe(1);
  });

  test("lower buy returns only after market recovery and a new downward crossing", () => {
    const crossingPolicy = {
      ...policy,
      lowerMultiple: 0.6,
      upperMultiple: 1.3,
      sellFraction: 0.7,
      maxCapitalDeployedSol: 0.5,
    };
    // After the 1.3 upper sale, the remaining sleeve is ~0.039 SOL (below 0.06).
    // 2.1 recovers it above 0.06; 1.9 then crosses it back below and may buy.
    const prices = [1, 1.3, 1.3, 2.1, 1.9].map((priceSol, i) => ({
      atMs: i + 1,
      priceSol,
    }));
    const result = simulateValueBandStrategy(prices, crossingPolicy, {
      startingSol: 1,
    });
    expect(result.executions.map((row) => row.side)).toEqual([
      "buy",
      "sell",
      "buy",
    ]);
    expect(result.summary.buys).toBe(2);
    expect(result.summary.sells).toBe(1);
  });
});
