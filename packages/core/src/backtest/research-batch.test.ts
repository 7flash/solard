import { describe, expect, test } from "bun:test";
import type {
  HistoricalResearchRun,
  HistoricalResearchStrategy,
} from "./research-batch.ts";
import { summarizeHistoricalResearchRuns } from "./research-batch.ts";

const strategy = (id: string): HistoricalResearchStrategy => ({
  id,
  strategy: {
    version: 1,
    kind: "ath-dip-profit-ladder",
    name: id,
    entry: { stepPct: 20, buySol: 0.1 },
    exit: { profitPct: 40 },
  },
});

function run(
  strategyId: string,
  ret: number,
  dd: number,
  hold: number,
): HistoricalResearchRun {
  return {
    mint: `${strategyId}-${ret}`,
    label: null,
    tags: [],
    strategyId,
    strategyName: strategyId,
    strategy: strategy(strategyId).strategy,
    coverage: {
      tokenCreatedAtMs: 1,
      firstRecordedTradeAtMs: 1,
      lastRecordedTradeAtMs: 2,
      creationGapMs: 0,
      status: "likely-from-creation",
      toleranceMs: 60_000,
    },
    sourceRows: 10,
    usableRows: 10,
    periodDays: 1,
    firstAtMs: 1,
    lastAtMs: 2,
    firstPriceSol: 1,
    lastPriceSol: 1 + hold / 100,
    priceHoldReturnPct: hold,
    excessVsHoldPct: ret - hold,
    summary: {
      startingSol: 5,
      endingCashSol: 5,
      openLiquidationValueSol: 0,
      finalEquitySol: 5 * (1 + ret / 100),
      realizedPnlSol: 5 * (ret / 100),
      unrealizedPnlSol: 0,
      netPnlSol: 5 * (ret / 100),
      returnPct: ret,
      maxDrawdownPct: dd,
      maxDeployedSol: 1,
      buys: 2,
      sells: 2,
      skippedEntries: 0,
      lots: 2,
      closedLots: 2,
      openLots: 0,
      winningLots: ret > 0 ? 2 : 0,
      losingLots: ret > 0 ? 0 : 2,
      winRatePct: ret > 0 ? 100 : 0,
      averageHoldMs: 1000,
      fastestHoldMs: 1000,
      longestHoldMs: 1000,
    },
  };
}

describe("historical research aggregation", () => {
  test("ranks by median return and reports cross-token robustness", () => {
    const strategies = [strategy("steady"), strategy("spiky")];
    const rows = [
      run("steady", 20, 10, 5),
      run("steady", 25, 12, 30),
      run("steady", 15, 9, -10),
      run("spiky", 100, 60, 20),
      run("spiky", -50, 70, -20),
      run("spiky", -40, 65, -10),
    ];
    const summary = summarizeHistoricalResearchRuns(rows, strategies);
    expect(summary[0]?.strategyId).toBe("steady");
    expect(summary[0]?.medianReturnPct).toBe(20);
    expect(summary[0]?.profitableTokenPct).toBe(100);
    expect(summary[0]?.outperformHoldTokens).toBe(2);
    expect(summary[1]?.medianReturnPct).toBe(-40);
  });
});
