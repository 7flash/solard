import {
  normalizeTargetWeightPolicy,
  planTargetWeightRebalance,
  type TargetWeightCandle,
  type TargetWeightPolicy,
  type TargetWeightRebalancePlan,
} from "../strategy/target-weight.ts";
import type { BacktestTapeEvent } from "./strategy-sim.ts";

export type TargetWeightBacktestExecution = {
  eventIndex: number;
  eventId: string;
  signature: string;
  source: string;
  confidence: BacktestTapeEvent["confidence"];
  atMs: number;
  triggerAtMs: number;
  side: "buy" | "sell";
  status: "filled" | "skipped";
  observedPriceSol: number;
  executionPriceSol: number | null;
  amountSol: number | null;
  tokens: number | null;
  reason: string | null;
  targetWeightPct: number;
  desiredWeightPct: number;
  weightBeforePct: number;
  weightAfterPct: number | null;
  outerGapPct: number;
  innerGapPct: number;
  previousCandleStartMs: number | null;
  previousCandleEndMs: number | null;
  previousCandleRangePct: number | null;
  networkFeeSol: number;
  degradationBps: number;
};

export type TargetWeightDecision = {
  atMs: number;
  eventIndex: number;
  priceSol: number;
  action: TargetWeightRebalancePlan["action"];
  reason: string;
  currentWeightPct: number;
  targetWeightPct: number;
  desiredWeightPct: number;
  outerGapPct: number;
  innerGapPct: number;
  tradeMarkValueSol: number;
  previousCandleStartMs: number | null;
  previousCandleEndMs: number | null;
  previousCandleRangePct: number | null;
};

export type TargetWeightBacktestSummary = {
  startingSol: number;
  endingSol: number;
  endingTokens: number;
  finalEquitySol: number;
  netPnlSol: number;
  returnPct: number;
  maxDrawdownPct: number;
  buys: number;
  sells: number;
  skippedExecutions: number;
  decisions: number;
  holdDecisions: number;
  rebalanceSignals: number;
  decisionOutsideBandPct: number;
  averageWeightPct: number;
  minWeightPct: number;
  maxWeightPct: number;
  totalTurnoverSol: number;
  totalNetworkFeesSol: number;
  totalDegradationCostSol: number;
  totalExecutionCostSol: number;
  benchmark100SolReturnPct: number;
  benchmark100TokenReturnPct: number;
  benchmarkInitialMixReturnPct: number;
  excessVsInitialMixPct: number;
};

export type TargetWeightBacktestResult = {
  strategy: TargetWeightPolicy;
  tape: {
    events: number;
    firstAtMs: number | null;
    lastAtMs: number | null;
    firstPriceSol: number | null;
    lastPriceSol: number | null;
    cadenceMs: number;
  };
  summary: TargetWeightBacktestSummary;
  executions: TargetWeightBacktestExecution[];
  decisions: TargetWeightDecision[];
};

type PendingRebalance = {
  triggerEventIndex: number;
  triggerAtMs: number;
  plan: TargetWeightRebalancePlan;
  candle: TargetWeightCandle | null;
};

function positive(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`${label} must be > 0`);
  return parsed;
}

function round(value: number, digits = 12): number {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function weightPct(tokens: number, sol: number, priceSol: number): number {
  const tokenValue = tokens * priceSol;
  const nav = tokenValue + sol;
  return nav > 0 ? (tokenValue / nav) * 100 : 0;
}

function buildCandles(
  tape: BacktestTapeEvent[],
  cadenceMs: number,
): Map<number, TargetWeightCandle> {
  const out = new Map<number, TargetWeightCandle>();
  for (const event of tape) {
    const startMs = Math.floor(event.tradedAtMs / cadenceMs) * cadenceMs;
    const existing = out.get(startMs);
    if (!existing) {
      out.set(startMs, {
        startMs,
        endMs: startMs + cadenceMs,
        open: event.priceSol,
        high: event.priceSol,
        low: event.priceSol,
        close: event.priceSol,
      });
      continue;
    }
    existing.high = Math.max(existing.high, event.priceSol);
    existing.low = Math.min(existing.low, event.priceSol);
    existing.close = event.priceSol;
  }
  return out;
}

export function simulateTargetWeightStrategy(
  inputTape: BacktestTapeEvent[],
  inputStrategy: TargetWeightPolicy,
  options: { startingSol?: number; cadenceMs?: number } = {},
): TargetWeightBacktestResult {
  const strategy = normalizeTargetWeightPolicy(inputStrategy);
  const startingSol = positive(options.startingSol ?? 5, "startingSol");
  const cadenceMs = Math.max(1_000, Math.trunc(options.cadenceMs ?? 300_000));
  const tape = inputTape
    .filter(
      (event) =>
        event.confidence !== "dropped" &&
        Number.isFinite(event.tradedAtMs) &&
        event.tradedAtMs > 0 &&
        Number.isFinite(event.priceSol) &&
        event.priceSol > 0,
    )
    .slice()
    .sort(
      (a, b) =>
        a.tradedAtMs - b.tradedAtMs ||
        a.slot - b.slot ||
        a.id.localeCompare(b.id),
    );

  if (tape.length === 0) {
    return {
      strategy,
      tape: {
        events: 0,
        firstAtMs: null,
        lastAtMs: null,
        firstPriceSol: null,
        lastPriceSol: null,
        cadenceMs,
      },
      summary: {
        startingSol,
        endingSol: startingSol,
        endingTokens: 0,
        finalEquitySol: startingSol,
        netPnlSol: 0,
        returnPct: 0,
        maxDrawdownPct: 0,
        buys: 0,
        sells: 0,
        skippedExecutions: 0,
        decisions: 0,
        holdDecisions: 0,
        rebalanceSignals: 0,
        decisionOutsideBandPct: 0,
        averageWeightPct: 0,
        minWeightPct: 0,
        maxWeightPct: 0,
        totalTurnoverSol: 0,
        totalNetworkFeesSol: 0,
        totalDegradationCostSol: 0,
        totalExecutionCostSol: 0,
        benchmark100SolReturnPct: 0,
        benchmark100TokenReturnPct: 0,
        benchmarkInitialMixReturnPct: 0,
        excessVsInitialMixPct: 0,
      },
      executions: [],
      decisions: [],
    };
  }

  const candles = buildCandles(tape, cadenceMs);
  const degradationBps =
    (strategy.execution?.slippageBps ?? 0) +
    (strategy.execution?.venueFeeBps ?? 0);
  const degradation = degradationBps / 10_000;
  const networkFeeSol = strategy.execution?.networkFeeSol ?? 0;
  const latencyMs = strategy.execution?.latencyMs ?? 0;

  let sol = startingSol;
  let tokens = 0;
  let pending: PendingRebalance | null = null;
  let nextBoundary =
    (Math.floor(tape[0]!.tradedAtMs / cadenceMs) + 1) * cadenceMs;
  let peakEquity = startingSol;
  let maxDrawdownPct = 0;
  let turnover = 0;
  let paidNetworkFees = 0;
  let degradationCost = 0;
  const weights: number[] = [];
  const decisionWeights: number[] = [];
  let outsideBandDecisions = 0;
  let rebalanceSignals = 0;
  let holdDecisions = 0;
  const executions: TargetWeightBacktestExecution[] = [];
  const decisions: TargetWeightDecision[] = [];

  const fillPending = (eventIndex: number, event: BacktestTapeEvent) => {
    if (!pending) return;
    if (
      eventIndex <= pending.triggerEventIndex ||
      event.tradedAtMs < pending.triggerAtMs + latencyMs
    ) {
      return;
    }
    const plan = pending.plan;
    const beforeWeight = weightPct(tokens, sol, event.priceSol);
    const common = {
      eventIndex,
      eventId: event.id,
      signature: event.signature,
      source: event.source,
      confidence: event.confidence,
      atMs: event.tradedAtMs,
      triggerAtMs: pending.triggerAtMs,
      targetWeightPct: plan.targetWeightPct,
      desiredWeightPct: plan.desiredWeightPct,
      weightBeforePct: beforeWeight,
      outerGapPct: plan.outerGapPct,
      innerGapPct: plan.innerGapPct,
      previousCandleStartMs: pending.candle?.startMs ?? null,
      previousCandleEndMs: pending.candle?.endMs ?? null,
      previousCandleRangePct: plan.previousCandleRangePct,
      networkFeeSol,
      degradationBps,
    };

    if (plan.action === "buy") {
      const required = plan.buySol + networkFeeSol;
      if (plan.buySol <= 0 || sol + 1e-15 < required) {
        executions.push({
          ...common,
          side: "buy",
          status: "skipped",
          observedPriceSol: event.priceSol,
          executionPriceSol: null,
          amountSol: plan.buySol,
          tokens: null,
          weightAfterPct: null,
          reason: `insufficient simulated SOL: cash=${sol} required=${required}`,
        });
        pending = null;
        return;
      }
      const executionPriceSol = event.priceSol * (1 + degradation);
      const boughtTokens = plan.buySol / executionPriceSol;
      const markValue = boughtTokens * event.priceSol;
      sol -= required;
      tokens += boughtTokens;
      turnover += plan.buySol;
      paidNetworkFees += networkFeeSol;
      degradationCost += Math.max(0, plan.buySol - markValue);
      executions.push({
        ...common,
        side: "buy",
        status: "filled",
        observedPriceSol: event.priceSol,
        executionPriceSol,
        amountSol: plan.buySol,
        tokens: boughtTokens,
        weightAfterPct: weightPct(tokens, sol, event.priceSol),
        reason: null,
      });
      pending = null;
      return;
    }

    const sellTokens = Math.min(tokens, plan.sellTokens);
    if (!(sellTokens > 0)) {
      executions.push({
        ...common,
        side: "sell",
        status: "skipped",
        observedPriceSol: event.priceSol,
        executionPriceSol: null,
        amountSol: 0,
        tokens: 0,
        weightAfterPct: null,
        reason: "no simulated token inventory available",
      });
      pending = null;
      return;
    }
    const executionPriceSol = event.priceSol * (1 - degradation);
    const markValue = sellTokens * event.priceSol;
    const grossProceeds = sellTokens * executionPriceSol;
    const netProceeds = Math.max(0, grossProceeds - networkFeeSol);
    tokens -= sellTokens;
    sol += netProceeds;
    turnover += markValue;
    paidNetworkFees += networkFeeSol;
    degradationCost += Math.max(0, markValue - grossProceeds);
    executions.push({
      ...common,
      side: "sell",
      status: "filled",
      observedPriceSol: event.priceSol,
      executionPriceSol,
      amountSol: netProceeds,
      tokens: sellTokens,
      weightAfterPct: weightPct(tokens, sol, event.priceSol),
      reason: null,
    });
    pending = null;
  };

  for (let eventIndex = 0; eventIndex < tape.length; eventIndex += 1) {
    const event = tape[eventIndex]!;
    fillPending(eventIndex, event);

    if (event.tradedAtMs >= nextBoundary) {
      let boundary = nextBoundary;
      while (boundary + cadenceMs <= event.tradedAtMs) boundary += cadenceMs;
      nextBoundary = boundary + cadenceMs;
      const previousCandle = candles.get(boundary - cadenceMs) ?? null;
      let plan: TargetWeightRebalancePlan | null = null;
      let decisionReason = "";
      try {
        plan = planTargetWeightRebalance({
          policy: strategy,
          tokenAmount: tokens,
          solAmount: sol,
          priceSol: event.priceSol,
          previousCandle,
        });
      } catch (error) {
        decisionReason = error instanceof Error ? error.message : String(error);
      }

      if (plan) {
        const outside =
          plan.currentWeightPct < plan.lowerTriggerWeightPct ||
          plan.currentWeightPct > plan.upperTriggerWeightPct;
        if (outside) outsideBandDecisions += 1;
        decisionWeights.push(plan.currentWeightPct);
        if (plan.action === "hold") holdDecisions += 1;
        else rebalanceSignals += 1;
        decisions.push({
          atMs: event.tradedAtMs,
          eventIndex,
          priceSol: event.priceSol,
          action: plan.action,
          reason: plan.reason,
          currentWeightPct: plan.currentWeightPct,
          targetWeightPct: plan.targetWeightPct,
          desiredWeightPct: plan.desiredWeightPct,
          outerGapPct: plan.outerGapPct,
          innerGapPct: plan.innerGapPct,
          tradeMarkValueSol: plan.tradeMarkValueSol,
          previousCandleStartMs: previousCandle?.startMs ?? null,
          previousCandleEndMs: previousCandle?.endMs ?? null,
          previousCandleRangePct: plan.previousCandleRangePct,
        });
        if (!pending && plan.action !== "hold") {
          pending = {
            triggerEventIndex: eventIndex,
            triggerAtMs: event.tradedAtMs,
            plan,
            candle: previousCandle,
          };
        }
      } else {
        holdDecisions += 1;
        decisions.push({
          atMs: event.tradedAtMs,
          eventIndex,
          priceSol: event.priceSol,
          action: "hold",
          reason: decisionReason || "unable to construct rebalance plan",
          currentWeightPct: weightPct(tokens, sol, event.priceSol),
          targetWeightPct: strategy.targetWeightPct,
          desiredWeightPct: strategy.targetWeightPct,
          outerGapPct: strategy.gap.outerPct,
          innerGapPct: strategy.gap.innerPct,
          tradeMarkValueSol: 0,
          previousCandleStartMs: previousCandle?.startMs ?? null,
          previousCandleEndMs: previousCandle?.endMs ?? null,
          previousCandleRangePct: null,
        });
      }
    }

    const w = weightPct(tokens, sol, event.priceSol);
    weights.push(w);
    const equity = sol + tokens * event.priceSol;
    peakEquity = Math.max(peakEquity, equity);
    if (peakEquity > 0) {
      maxDrawdownPct = Math.max(
        maxDrawdownPct,
        ((peakEquity - equity) / peakEquity) * 100,
      );
    }
  }

  const firstPrice = tape[0]!.priceSol;
  const lastPrice = tape.at(-1)!.priceSol;
  const finalEquitySol = sol + tokens * lastPrice;
  const target = strategy.targetWeightPct / 100;
  const priceRatio = lastPrice / firstPrice;
  const benchmark100Token = startingSol * priceRatio;
  const benchmarkInitialMix = startingSol * (1 - target + target * priceRatio);
  const benchmarkInitialMixReturnPct =
    ((benchmarkInitialMix - startingSol) / startingSol) * 100;
  const returnPct = ((finalEquitySol - startingSol) / startingSol) * 100;
  const filled = executions.filter((row) => row.status === "filled");
  const avgWeight = weights.length
    ? weights.reduce((sum, value) => sum + value, 0) / weights.length
    : 0;

  return {
    strategy,
    tape: {
      events: tape.length,
      firstAtMs: tape[0]?.tradedAtMs ?? null,
      lastAtMs: tape.at(-1)?.tradedAtMs ?? null,
      firstPriceSol: firstPrice,
      lastPriceSol: lastPrice,
      cadenceMs,
    },
    summary: {
      startingSol: round(startingSol),
      endingSol: round(sol),
      endingTokens: round(tokens),
      finalEquitySol: round(finalEquitySol),
      netPnlSol: round(finalEquitySol - startingSol),
      returnPct: round(returnPct, 8),
      maxDrawdownPct: round(maxDrawdownPct, 8),
      buys: filled.filter((row) => row.side === "buy").length,
      sells: filled.filter((row) => row.side === "sell").length,
      skippedExecutions: executions.filter((row) => row.status === "skipped")
        .length,
      decisions: decisions.length,
      holdDecisions,
      rebalanceSignals,
      decisionOutsideBandPct: decisions.length
        ? round((outsideBandDecisions / decisions.length) * 100, 8)
        : 0,
      averageWeightPct: round(avgWeight, 8),
      minWeightPct: round(weights.length ? Math.min(...weights) : 0, 8),
      maxWeightPct: round(weights.length ? Math.max(...weights) : 0, 8),
      totalTurnoverSol: round(turnover),
      totalNetworkFeesSol: round(paidNetworkFees),
      totalDegradationCostSol: round(degradationCost),
      totalExecutionCostSol: round(paidNetworkFees + degradationCost),
      benchmark100SolReturnPct: 0,
      benchmark100TokenReturnPct: round((priceRatio - 1) * 100, 8),
      benchmarkInitialMixReturnPct: round(benchmarkInitialMixReturnPct, 8),
      excessVsInitialMixPct: round(returnPct - benchmarkInitialMixReturnPct, 8),
    },
    executions,
    decisions,
  };
}
