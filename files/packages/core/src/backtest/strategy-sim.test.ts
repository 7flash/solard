import { describe, expect, test } from "bun:test";
import {
  simulateAthDipProfitStrategy,
  type AthDipProfitStrategy,
  type BacktestTapeEvent,
} from "./strategy-sim.ts";

const strategy: AthDipProfitStrategy = {
  version: 1,
  kind: "ath-dip-profit-ladder",
  metric: "priceSol",
  entry: { stepPct: 20, buySol: 0.1 },
  exit: { profitPct: 40 },
  execution: { slippageBps: 0, venueFeeBps: 0, networkFeeSol: 0, latencyMs: 0 },
};

function tape(prices: number[]): BacktestTapeEvent[] {
  return prices.map((priceSol, index) => ({
    id: `e${index}`,
    signature: `s${index}`,
    slot: index + 1,
    tradedAtMs: (index + 1) * 1_000,
    priceSol,
    marketCapUsd: null,
    source: "test",
    confidence: "finalized",
  }));
}

describe("ath dip / profit replay", () => {
  test("never fills on the trigger event", () => {
    const result = simulateAthDipProfitStrategy(tape([100, 80, 78]), strategy, {
      startingSol: 1,
    });
    expect(result.summary.buys).toBe(1);
    expect(result.lots[0]?.triggerAtMs).toBe(2_000);
    expect(result.lots[0]?.entryAtMs).toBe(3_000);
    expect(result.lots[0]?.entryPriceSol).toBe(78);
  });

  test("uses each actual lot fill to calculate its own take profit", () => {
    const result = simulateAthDipProfitStrategy(
      tape([100, 80, 78, 110, 108]),
      strategy,
      { startingSol: 1 },
    );
    expect(result.lots[0]?.targetPriceSol).toBeCloseTo(109.2, 10);
    expect(result.lots[0]?.exitTriggerAtMs).toBe(4_000);
    expect(result.lots[0]?.exitAtMs).toBe(5_000);
    expect(result.lots[0]?.exitPriceSol).toBe(108);
  });

  test("a new ATH starts a fresh drawdown ladder", () => {
    const result = simulateAthDipProfitStrategy(
      tape([100, 80, 78, 120, 96, 95]),
      strategy,
      { startingSol: 1 },
    );
    expect(result.summary.buys).toBe(2);
    expect(result.lots[0]?.referenceAthMetric).toBe(100);
    expect(result.lots[1]?.referenceAthMetric).toBe(120);
  });

  test("crossing multiple ladder levels triggers each level when catch-up is enabled", () => {
    const result = simulateAthDipProfitStrategy(tape([100, 55, 54]), strategy, {
      startingSol: 1,
    });
    expect(result.summary.buys).toBe(2);
    expect(result.lots.map((lot) => lot.level).sort()).toEqual([1, 2]);
  });

  test("insufficient capital is explicit instead of creating impossible fills", () => {
    const result = simulateAthDipProfitStrategy(tape([100, 55, 54]), strategy, {
      startingSol: 0.15,
    });
    expect(result.summary.buys).toBe(1);
    expect(result.summary.skippedEntries).toBe(1);
    expect(result.executions.some((row) => row.status === "skipped")).toBe(
      true,
    );
  });

  test("slippage changes actual entry and take-profit price", () => {
    const result = simulateAthDipProfitStrategy(
      tape([100, 80, 78]),
      {
        ...strategy,
        execution: { ...strategy.execution, slippageBps: 500 },
      },
      { startingSol: 1 },
    );
    expect(result.lots[0]?.entryPriceSol).toBeCloseTo(81.9, 10);
    expect(result.lots[0]?.targetPriceSol).toBeCloseTo(114.66, 10);
  });
});
