import { describe, expect, test } from "bun:test";
import {
  planTargetWeightRebalance,
  type TargetWeightPolicy,
} from "../strategy/target-weight.ts";
import { simulateTargetWeightStrategy } from "./target-weight-sim.ts";
import type { BacktestTapeEvent } from "./strategy-sim.ts";

const policy: TargetWeightPolicy = {
  version: 1,
  kind: "target-weight",
  targetWeightPct: 40,
  gap: { mode: "fixed", outerPct: 3, innerPct: 1 },
  minTradeSol: 0,
  execution: { slippageBps: 0, venueFeeBps: 0, networkFeeSol: 0, latencyMs: 0 },
};

function event(i: number, at: number, price: number): BacktestTapeEvent {
  return {
    id: `e${i}`,
    signature: `s${i}`,
    slot: i,
    tradedAtMs: at,
    priceSol: price,
    marketCapUsd: null,
    source: "test",
    confidence: "finalized",
  };
}

describe("target-weight controller", () => {
  test("buys when underweight and sells when overweight", () => {
    const buy = planTargetWeightRebalance({
      policy,
      tokenAmount: 0,
      solAmount: 10,
      priceSol: 1,
    });
    expect(buy.action).toBe("buy");
    expect(buy.desiredWeightPct).toBeCloseTo(39, 8);
    expect(buy.buySol).toBeCloseTo(3.9, 8);

    const sell = planTargetWeightRebalance({
      policy,
      tokenAmount: 8,
      solAmount: 2,
      priceSol: 1,
    });
    expect(sell.action).toBe("sell");
    expect(sell.desiredWeightPct).toBeCloseTo(41, 8);
    expect(sell.sellTokens).toBeCloseTo(3.9, 8);
  });

  test("holds inside outer band", () => {
    const plan = planTargetWeightRebalance({
      policy,
      tokenAmount: 4,
      solAmount: 6,
      priceSol: 1,
    });
    expect(plan.action).toBe("hold");
  });

  test("oscillation produces rebalances at 5m cadence", () => {
    const base = Date.UTC(2026, 8, 1, 0, 0, 0);
    const tape = [
      event(0, base + 1_000, 1),
      event(1, base + 299_000, 1),
      event(2, base + 301_000, 1),
      event(3, base + 302_000, 1),
      event(4, base + 599_000, 0.7),
      event(5, base + 601_000, 0.7),
      event(6, base + 602_000, 0.7),
      event(7, base + 899_000, 1.1),
      event(8, base + 901_000, 1.1),
      event(9, base + 902_000, 1.1),
    ];
    const result = simulateTargetWeightStrategy(tape, policy, {
      startingSol: 10,
      cadenceMs: 300_000,
    });
    expect(result.summary.buys).toBeGreaterThan(0);
    expect(result.summary.sells).toBeGreaterThan(0);
    expect(result.summary.totalTurnoverSol).toBeGreaterThan(0);
  });
});
