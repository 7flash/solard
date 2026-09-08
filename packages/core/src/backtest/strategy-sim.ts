export type BacktestMetric = "priceSol" | "marketCapUsd";

export type AthDipProfitStrategy = {
  version: 1;
  kind: "ath-dip-profit-ladder";
  name?: string;
  metric?: BacktestMetric;
  entry: {
    stepPct: number;
    buySol: number;
    maxLevels?: number;
    catchUpLevels?: boolean;
  };
  exit: {
    profitPct: number;
  };
  execution?: {
    /** Market-order deterioration applied independently to both buys and sells. */
    slippageBps?: number;
    /** Additional proportional execution cost, expressed in bps. */
    venueFeeBps?: number;
    /** Fixed SOL cost per simulated transaction. */
    networkFeeSol?: number;
    /** Trigger-to-fill delay. Fills always use a later tape event, never the trigger event. */
    latencyMs?: number;
  };
};

export type BacktestTapeEvent = {
  id: string;
  signature: string;
  slot: number;
  tradedAtMs: number;
  priceSol: number;
  marketCapUsd: number | null;
  source: string;
  confidence: "processed" | "confirmed" | "finalized" | "dropped";
};

export type BacktestLot = {
  id: number;
  level: number;
  status: "open" | "exit-pending" | "closed";
  referenceAthMetric: number;
  triggerMetric: number;
  triggerAtMs: number;
  entryAtMs: number;
  entryObservedPriceSol: number;
  entryPriceSol: number;
  spendSol: number;
  entryNetworkFeeSol: number;
  costSol: number;
  tokens: number;
  targetPriceSol: number;
  exitTriggerAtMs: number | null;
  exitAtMs: number | null;
  exitObservedPriceSol: number | null;
  exitPriceSol: number | null;
  proceedsSol: number | null;
  pnlSol: number | null;
  returnPct: number | null;
};

export type BacktestExecution = {
  eventIndex: number;
  eventId: string;
  signature: string;
  source: string;
  confidence: BacktestTapeEvent["confidence"];
  atMs: number;
  side: "buy" | "sell";
  status: "filled" | "skipped";
  lotId: number | null;
  level: number | null;
  observedPriceSol: number;
  executionPriceSol: number | null;
  amountSol: number | null;
  tokens: number | null;
  reason: string | null;
};

export type AthDipProfitBacktestSummary = {
  startingSol: number;
  endingCashSol: number;
  openLiquidationValueSol: number;
  finalEquitySol: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  netPnlSol: number;
  returnPct: number;
  maxDrawdownPct: number;
  maxDeployedSol: number;
  buys: number;
  sells: number;
  skippedEntries: number;
  lots: number;
  closedLots: number;
  openLots: number;
  winningLots: number;
  losingLots: number;
  winRatePct: number | null;
  averageHoldMs: number | null;
  fastestHoldMs: number | null;
  longestHoldMs: number | null;
};

export type AthDipProfitBacktestResult = {
  strategy: AthDipProfitStrategy;
  tape: {
    events: number;
    firstAtMs: number | null;
    lastAtMs: number | null;
    firstPriceSol: number | null;
    lastPriceSol: number | null;
  };
  summary: AthDipProfitBacktestSummary;
  lots: BacktestLot[];
  executions: BacktestExecution[];
};

type PendingEntry = {
  level: number;
  referenceAthMetric: number;
  triggerMetric: number;
  triggerAtMs: number;
  triggerEventIndex: number;
};

type PendingExit = {
  lotId: number;
  triggerAtMs: number;
  triggerEventIndex: number;
};

function finitePositive(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a finite number greater than zero`);
  }
  return parsed;
}

function finiteNonNegative(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `${label} must be a finite number greater than or equal to zero`,
    );
  }
  return parsed;
}

export function normalizeAthDipProfitStrategy(
  input: AthDipProfitStrategy,
): AthDipProfitStrategy {
  if (!input || input.kind !== "ath-dip-profit-ladder") {
    throw new Error('Strategy kind must be "ath-dip-profit-ladder"');
  }
  const stepPct = finitePositive(input.entry?.stepPct, "entry.stepPct");
  if (stepPct >= 100) throw new Error("entry.stepPct must be less than 100");
  const buySol = finitePositive(input.entry?.buySol, "entry.buySol");
  const profitPct = finitePositive(input.exit?.profitPct, "exit.profitPct");
  const slippageBps = finiteNonNegative(
    input.execution?.slippageBps ?? 0,
    "execution.slippageBps",
  );
  const venueFeeBps = finiteNonNegative(
    input.execution?.venueFeeBps ?? 0,
    "execution.venueFeeBps",
  );
  if (slippageBps + venueFeeBps >= 10_000) {
    throw new Error("slippageBps + venueFeeBps must be less than 10000");
  }
  const networkFeeSol = finiteNonNegative(
    input.execution?.networkFeeSol ?? 0,
    "execution.networkFeeSol",
  );
  const latencyMs = finiteNonNegative(
    input.execution?.latencyMs ?? 0,
    "execution.latencyMs",
  );
  const naturalMaxLevels = Math.max(1, Math.floor(99.999999 / stepPct));
  const maxLevelsRaw = input.entry?.maxLevels ?? naturalMaxLevels;
  const maxLevels = Math.max(
    1,
    Math.min(
      naturalMaxLevels,
      Math.trunc(finitePositive(maxLevelsRaw, "entry.maxLevels")),
    ),
  );
  const metric = input.metric ?? "priceSol";
  if (metric !== "priceSol" && metric !== "marketCapUsd") {
    throw new Error('metric must be "priceSol" or "marketCapUsd"');
  }
  return {
    version: 1,
    kind: "ath-dip-profit-ladder",
    ...(input.name ? { name: String(input.name) } : {}),
    metric,
    entry: {
      stepPct,
      buySol,
      maxLevels,
      catchUpLevels: input.entry?.catchUpLevels !== false,
    },
    exit: { profitPct },
    execution: {
      slippageBps,
      venueFeeBps,
      networkFeeSol,
      latencyMs,
    },
  };
}

function eventMetric(
  event: BacktestTapeEvent,
  metric: BacktestMetric,
): number | null {
  const value = metric === "priceSol" ? event.priceSol : event.marketCapUsd;
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function round(value: number, digits = 12): number {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function simulateAthDipProfitStrategy(
  inputTape: BacktestTapeEvent[],
  inputStrategy: AthDipProfitStrategy,
  options: { startingSol?: number } = {},
): AthDipProfitBacktestResult {
  const strategy = normalizeAthDipProfitStrategy(inputStrategy);
  const startingSol = finitePositive(options.startingSol ?? 5, "startingSol");
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

  const degradationBps =
    (strategy.execution?.slippageBps ?? 0) +
    (strategy.execution?.venueFeeBps ?? 0);
  const buyMultiplier = 1 + degradationBps / 10_000;
  const sellMultiplier = 1 - degradationBps / 10_000;
  const networkFeeSol = strategy.execution?.networkFeeSol ?? 0;
  const latencyMs = strategy.execution?.latencyMs ?? 0;
  const metric = strategy.metric ?? "priceSol";
  const maxLevels = strategy.entry.maxLevels!;

  let cashSol = startingSol;
  let athMetric = 0;
  let ladderAthMetric = 0;
  let nextLevel = 1;
  let nextLotId = 1;
  let maxDeployedSol = 0;
  let peakEquity = startingSol;
  let maxDrawdownPct = 0;
  let skippedEntries = 0;

  const lots: BacktestLot[] = [];
  const executions: BacktestExecution[] = [];
  const pendingEntries: PendingEntry[] = [];
  const pendingExits: PendingExit[] = [];

  const openLots = () => lots.filter((lot) => lot.status !== "closed");
  const deployedSol = () =>
    openLots().reduce((sum, lot) => sum + lot.costSol, 0);
  const equityAt = (priceSol: number) =>
    cashSol +
    openLots().reduce(
      (sum, lot) => sum + lot.tokens * priceSol * sellMultiplier,
      0,
    );

  for (let eventIndex = 0; eventIndex < tape.length; eventIndex += 1) {
    const event = tape[eventIndex]!;
    const priceSol = event.priceSol;

    // Deterministic same-event ordering: exits fill before entries. A trigger can
    // never fill on the event that created it, even when latencyMs=0.
    for (let index = pendingExits.length - 1; index >= 0; index -= 1) {
      const pending = pendingExits[index]!;
      if (
        eventIndex <= pending.triggerEventIndex ||
        event.tradedAtMs < pending.triggerAtMs + latencyMs
      ) {
        continue;
      }
      const lot = lots.find((candidate) => candidate.id === pending.lotId);
      pendingExits.splice(index, 1);
      if (!lot || lot.status === "closed") continue;

      const executionPriceSol = priceSol * sellMultiplier;
      const proceedsSol = Math.max(
        0,
        lot.tokens * executionPriceSol - networkFeeSol,
      );
      cashSol += proceedsSol;
      lot.status = "closed";
      lot.exitAtMs = event.tradedAtMs;
      lot.exitObservedPriceSol = priceSol;
      lot.exitPriceSol = executionPriceSol;
      lot.proceedsSol = proceedsSol;
      lot.pnlSol = proceedsSol - lot.costSol;
      lot.returnPct = lot.costSol > 0 ? (lot.pnlSol / lot.costSol) * 100 : null;
      executions.push({
        eventIndex,
        eventId: event.id,
        signature: event.signature,
        source: event.source,
        confidence: event.confidence,
        atMs: event.tradedAtMs,
        side: "sell",
        status: "filled",
        lotId: lot.id,
        level: lot.level,
        observedPriceSol: priceSol,
        executionPriceSol,
        amountSol: proceedsSol,
        tokens: lot.tokens,
        reason: null,
      });
    }

    for (let index = pendingEntries.length - 1; index >= 0; index -= 1) {
      const pending = pendingEntries[index]!;
      if (
        eventIndex <= pending.triggerEventIndex ||
        event.tradedAtMs < pending.triggerAtMs + latencyMs
      ) {
        continue;
      }
      pendingEntries.splice(index, 1);
      const requiredCash = strategy.entry.buySol + networkFeeSol;
      if (cashSol + 1e-15 < requiredCash) {
        skippedEntries += 1;
        executions.push({
          eventIndex,
          eventId: event.id,
          signature: event.signature,
          source: event.source,
          confidence: event.confidence,
          atMs: event.tradedAtMs,
          side: "buy",
          status: "skipped",
          lotId: null,
          level: pending.level,
          observedPriceSol: priceSol,
          executionPriceSol: null,
          amountSol: strategy.entry.buySol,
          tokens: null,
          reason: `insufficient simulated SOL: cash=${cashSol} required=${requiredCash}`,
        });
        continue;
      }

      const entryPriceSol = priceSol * buyMultiplier;
      const tokens = strategy.entry.buySol / entryPriceSol;
      cashSol -= requiredCash;
      const lot: BacktestLot = {
        id: nextLotId++,
        level: pending.level,
        status: "open",
        referenceAthMetric: pending.referenceAthMetric,
        triggerMetric: pending.triggerMetric,
        triggerAtMs: pending.triggerAtMs,
        entryAtMs: event.tradedAtMs,
        entryObservedPriceSol: priceSol,
        entryPriceSol,
        spendSol: strategy.entry.buySol,
        entryNetworkFeeSol: networkFeeSol,
        costSol: requiredCash,
        tokens,
        targetPriceSol: entryPriceSol * (1 + strategy.exit.profitPct / 100),
        exitTriggerAtMs: null,
        exitAtMs: null,
        exitObservedPriceSol: null,
        exitPriceSol: null,
        proceedsSol: null,
        pnlSol: null,
        returnPct: null,
      };
      lots.push(lot);
      executions.push({
        eventIndex,
        eventId: event.id,
        signature: event.signature,
        source: event.source,
        confidence: event.confidence,
        atMs: event.tradedAtMs,
        side: "buy",
        status: "filled",
        lotId: lot.id,
        level: lot.level,
        observedPriceSol: priceSol,
        executionPriceSol: entryPriceSol,
        amountSol: strategy.entry.buySol,
        tokens,
        reason: null,
      });
      maxDeployedSol = Math.max(maxDeployedSol, deployedSol());
    }

    // Exit triggers are per-lot and use the actual simulated entry fill price.
    for (const lot of lots) {
      if (lot.status !== "open") continue;
      if (priceSol < lot.targetPriceSol) continue;
      lot.status = "exit-pending";
      lot.exitTriggerAtMs = event.tradedAtMs;
      pendingExits.push({
        lotId: lot.id,
        triggerAtMs: event.tradedAtMs,
        triggerEventIndex: eventIndex,
      });
    }

    const metricValue = eventMetric(event, metric);
    if (metricValue != null) {
      if (metricValue > athMetric) {
        athMetric = metricValue;
        ladderAthMetric = metricValue;
        nextLevel = 1;
      } else if (ladderAthMetric > 0 && nextLevel <= maxLevels) {
        const drawdownPct = (1 - metricValue / ladderAthMetric) * 100;
        const reachedLevel = Math.min(
          maxLevels,
          Math.max(
            0,
            Math.floor((drawdownPct + 1e-10) / strategy.entry.stepPct),
          ),
        );
        if (reachedLevel >= nextLevel) {
          const lastLevel =
            strategy.entry.catchUpLevels === false ? nextLevel : reachedLevel;
          for (let level = nextLevel; level <= lastLevel; level += 1) {
            pendingEntries.push({
              level,
              referenceAthMetric: ladderAthMetric,
              triggerMetric:
                ladderAthMetric * (1 - (level * strategy.entry.stepPct) / 100),
              triggerAtMs: event.tradedAtMs,
              triggerEventIndex: eventIndex,
            });
          }
          nextLevel = lastLevel + 1;
        }
      }
    }

    const equity = equityAt(priceSol);
    peakEquity = Math.max(peakEquity, equity);
    if (peakEquity > 0) {
      maxDrawdownPct = Math.max(
        maxDrawdownPct,
        ((peakEquity - equity) / peakEquity) * 100,
      );
    }
  }

  const lastPriceSol = tape.at(-1)?.priceSol ?? null;
  const stillOpen = openLots();
  const openCostSol = stillOpen.reduce((sum, lot) => sum + lot.costSol, 0);
  const openLiquidationValueSol =
    lastPriceSol == null || stillOpen.length === 0
      ? 0
      : Math.max(
          0,
          stillOpen.reduce(
            (sum, lot) => sum + lot.tokens * lastPriceSol * sellMultiplier,
            0,
          ) - networkFeeSol,
        );
  const realizedPnlSol = lots
    .filter((lot) => lot.status === "closed")
    .reduce((sum, lot) => sum + (lot.pnlSol ?? 0), 0);
  const unrealizedPnlSol = openLiquidationValueSol - openCostSol;
  const finalEquitySol = cashSol + openLiquidationValueSol;
  const closed = lots.filter((lot) => lot.status === "closed");
  const winners = closed.filter((lot) => (lot.pnlSol ?? 0) > 0);
  const losers = closed.filter((lot) => (lot.pnlSol ?? 0) <= 0);
  const holdTimes = closed
    .map((lot) => (lot.exitAtMs ?? lot.entryAtMs) - lot.entryAtMs)
    .filter((value) => value >= 0);

  return {
    strategy,
    tape: {
      events: tape.length,
      firstAtMs: tape[0]?.tradedAtMs ?? null,
      lastAtMs: tape.at(-1)?.tradedAtMs ?? null,
      firstPriceSol: tape[0]?.priceSol ?? null,
      lastPriceSol,
    },
    summary: {
      startingSol: round(startingSol),
      endingCashSol: round(cashSol),
      openLiquidationValueSol: round(openLiquidationValueSol),
      finalEquitySol: round(finalEquitySol),
      realizedPnlSol: round(realizedPnlSol),
      unrealizedPnlSol: round(unrealizedPnlSol),
      netPnlSol: round(finalEquitySol - startingSol),
      returnPct: round(((finalEquitySol - startingSol) / startingSol) * 100, 8),
      maxDrawdownPct: round(maxDrawdownPct, 8),
      maxDeployedSol: round(maxDeployedSol),
      buys: executions.filter(
        (row) => row.side === "buy" && row.status === "filled",
      ).length,
      sells: executions.filter(
        (row) => row.side === "sell" && row.status === "filled",
      ).length,
      skippedEntries,
      lots: lots.length,
      closedLots: closed.length,
      openLots: stillOpen.length,
      winningLots: winners.length,
      losingLots: losers.length,
      winRatePct: closed.length
        ? round((winners.length / closed.length) * 100, 8)
        : null,
      averageHoldMs: holdTimes.length
        ? Math.round(
            holdTimes.reduce((sum, value) => sum + value, 0) / holdTimes.length,
          )
        : null,
      fastestHoldMs: holdTimes.length ? Math.min(...holdTimes) : null,
      longestHoldMs: holdTimes.length ? Math.max(...holdTimes) : null,
    },
    lots,
    executions,
  };
}
