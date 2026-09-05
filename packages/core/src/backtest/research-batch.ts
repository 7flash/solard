import {
  normalizeAthDipProfitStrategy,
  simulateAthDipProfitStrategy,
  type AthDipProfitBacktestSummary,
  type AthDipProfitStrategy,
} from "./strategy-sim.ts";
import {
  loadTokenBacktestTape,
  type TokenBacktestCoverage,
} from "./token-backtest.ts";

export type HistoricalResearchToken = {
  mint: string;
  label?: string | null;
  tags?: string[];
};

export type HistoricalResearchStrategy = {
  id: string;
  strategy: AthDipProfitStrategy;
  source?: string | null;
};

export type HistoricalResearchRun = {
  mint: string;
  label: string | null;
  tags: string[];
  strategyId: string;
  strategyName: string;
  strategy: AthDipProfitStrategy;
  coverage: TokenBacktestCoverage;
  sourceRows: number;
  usableRows: number;
  periodDays: number;
  firstAtMs: number;
  lastAtMs: number;
  firstPriceSol: number;
  lastPriceSol: number;
  priceHoldReturnPct: number;
  excessVsHoldPct: number;
  summary: AthDipProfitBacktestSummary;
};

export type HistoricalResearchTokenSkip = {
  mint: string;
  label: string | null;
  reason: string;
  coverage: TokenBacktestCoverage | null;
  sourceRows: number;
  usableRows: number;
  periodDays: number | null;
};

export type HistoricalResearchFailure = {
  mint: string;
  label: string | null;
  strategyId: string;
  strategyName: string;
  error: string;
};

export type HistoricalResearchStrategySummary = {
  rank: number;
  strategyId: string;
  strategyName: string;
  completedTokens: number;
  profitableTokens: number;
  profitableTokenPct: number;
  outperformHoldTokens: number;
  outperformHoldPct: number;
  meanReturnPct: number;
  medianReturnPct: number;
  p25ReturnPct: number;
  p75ReturnPct: number;
  worstReturnPct: number;
  bestReturnPct: number;
  meanExcessVsHoldPct: number;
  medianExcessVsHoldPct: number;
  medianMaxDrawdownPct: number;
  worstMaxDrawdownPct: number;
  medianTrades: number;
  totalNetPnlSol: number;
};

export type HistoricalResearchBatchOptions = {
  startingSol?: number;
  includeProcessed?: boolean;
  coverageToleranceMs?: number;
  requireFromCreation?: boolean;
  minEvents?: number;
  minDays?: number;
};

export type HistoricalResearchBatchResult = {
  version: 1;
  generatedAtMs: number;
  options: Required<HistoricalResearchBatchOptions>;
  input: {
    tokens: number;
    strategies: number;
    matrixCells: number;
  };
  eligibleTokens: number;
  skippedTokens: HistoricalResearchTokenSkip[];
  failures: HistoricalResearchFailure[];
  runs: HistoricalResearchRun[];
  strategies: HistoricalResearchStrategySummary[];
};

function finitePositive(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteNonNegative(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function round(value: number, digits = 8): number {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function mean(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * Math.max(0, Math.min(1, q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function strategyName(row: HistoricalResearchStrategy): string {
  return row.strategy.name?.trim() || row.id;
}

function canonicalTokens(
  tokens: HistoricalResearchToken[],
): HistoricalResearchToken[] {
  const out: HistoricalResearchToken[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const mint = token.mint?.trim();
    if (!mint || seen.has(mint)) continue;
    seen.add(mint);
    out.push({
      mint,
      label: token.label?.trim() || null,
      tags: [
        ...new Set(
          (token.tags ?? [])
            .map((value) => String(value).trim())
            .filter(Boolean),
        ),
      ],
    });
  }
  return out;
}

function canonicalStrategies(
  rows: HistoricalResearchStrategy[],
): HistoricalResearchStrategy[] {
  const out: HistoricalResearchStrategy[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row.id?.trim();
    if (!id) throw new Error("Research strategy id is required");
    if (seen.has(id)) throw new Error(`Duplicate research strategy id: ${id}`);
    seen.add(id);
    out.push({
      id,
      strategy: normalizeAthDipProfitStrategy(row.strategy),
      source: row.source ?? null,
    });
  }
  if (!out.length)
    throw new Error("At least one research strategy is required");
  return out;
}

export function summarizeHistoricalResearchRuns(
  runs: HistoricalResearchRun[],
  strategies: HistoricalResearchStrategy[],
): HistoricalResearchStrategySummary[] {
  const summaries = strategies.map((strategy) => {
    const rows = runs.filter((run) => run.strategyId === strategy.id);
    const returns = rows.map((row) => row.summary.returnPct);
    const excess = rows.map((row) => row.excessVsHoldPct);
    const drawdowns = rows.map((row) => row.summary.maxDrawdownPct);
    const trades = rows.map((row) => row.summary.buys + row.summary.sells);
    const profitable = rows.filter((row) => row.summary.returnPct > 0).length;
    const outperformHold = rows.filter((row) => row.excessVsHoldPct > 0).length;
    return {
      rank: 0,
      strategyId: strategy.id,
      strategyName: strategyName(strategy),
      completedTokens: rows.length,
      profitableTokens: profitable,
      profitableTokenPct: rows.length
        ? round((profitable / rows.length) * 100)
        : 0,
      outperformHoldTokens: outperformHold,
      outperformHoldPct: rows.length
        ? round((outperformHold / rows.length) * 100)
        : 0,
      meanReturnPct: round(mean(returns)),
      medianReturnPct: round(quantile(returns, 0.5)),
      p25ReturnPct: round(quantile(returns, 0.25)),
      p75ReturnPct: round(quantile(returns, 0.75)),
      worstReturnPct: round(returns.length ? Math.min(...returns) : 0),
      bestReturnPct: round(returns.length ? Math.max(...returns) : 0),
      meanExcessVsHoldPct: round(mean(excess)),
      medianExcessVsHoldPct: round(quantile(excess, 0.5)),
      medianMaxDrawdownPct: round(quantile(drawdowns, 0.5)),
      worstMaxDrawdownPct: round(drawdowns.length ? Math.max(...drawdowns) : 0),
      medianTrades: round(quantile(trades, 0.5), 2),
      totalNetPnlSol: round(
        rows.reduce((sum, row) => sum + row.summary.netPnlSol, 0),
      ),
    } satisfies HistoricalResearchStrategySummary;
  });

  summaries.sort((a, b) => {
    if (b.medianReturnPct !== a.medianReturnPct)
      return b.medianReturnPct - a.medianReturnPct;
    if (b.profitableTokenPct !== a.profitableTokenPct)
      return b.profitableTokenPct - a.profitableTokenPct;
    if (a.medianMaxDrawdownPct !== b.medianMaxDrawdownPct)
      return a.medianMaxDrawdownPct - b.medianMaxDrawdownPct;
    return a.strategyId.localeCompare(b.strategyId);
  });
  summaries.forEach((row, index) => {
    row.rank = index + 1;
  });
  return summaries;
}

export function runHistoricalStrategyBatch(
  inputTokens: HistoricalResearchToken[],
  inputStrategies: HistoricalResearchStrategy[],
  inputOptions: HistoricalResearchBatchOptions = {},
): HistoricalResearchBatchResult {
  const tokens = canonicalTokens(inputTokens);
  if (!tokens.length) throw new Error("At least one token mint is required");
  const strategies = canonicalStrategies(inputStrategies);
  const options: Required<HistoricalResearchBatchOptions> = {
    startingSol: finitePositive(inputOptions.startingSol, 5),
    includeProcessed: inputOptions.includeProcessed !== false,
    coverageToleranceMs: Math.trunc(
      finiteNonNegative(inputOptions.coverageToleranceMs, 60_000),
    ),
    requireFromCreation: inputOptions.requireFromCreation === true,
    minEvents: Math.max(
      2,
      Math.trunc(finitePositive(inputOptions.minEvents, 2)),
    ),
    minDays: finiteNonNegative(inputOptions.minDays, 0),
  };

  const runs: HistoricalResearchRun[] = [];
  const skippedTokens: HistoricalResearchTokenSkip[] = [];
  const failures: HistoricalResearchFailure[] = [];
  let eligibleTokens = 0;

  for (const token of tokens) {
    let tape: ReturnType<typeof loadTokenBacktestTape>;
    try {
      tape = loadTokenBacktestTape(token.mint, {
        includeProcessed: options.includeProcessed,
        coverageToleranceMs: options.coverageToleranceMs,
      });
    } catch (error) {
      skippedTokens.push({
        mint: token.mint,
        label: token.label ?? null,
        reason: error instanceof Error ? error.message : String(error),
        coverage: null,
        sourceRows: 0,
        usableRows: 0,
        periodDays: null,
      });
      continue;
    }

    const firstAtMs = tape.events[0]?.tradedAtMs ?? null;
    const lastAtMs = tape.events.at(-1)?.tradedAtMs ?? null;
    const periodDays =
      firstAtMs != null && lastAtMs != null
        ? Math.max(0, (lastAtMs - firstAtMs) / 86_400_000)
        : 0;
    let skipReason: string | null = null;
    if (tape.events.length < options.minEvents) {
      skipReason = `usable events ${tape.events.length} < minEvents ${options.minEvents}`;
    } else if (periodDays < options.minDays) {
      skipReason = `history ${periodDays.toFixed(3)}d < minDays ${options.minDays}`;
    } else if (
      options.requireFromCreation &&
      tape.coverage.status !== "likely-from-creation"
    ) {
      skipReason = `coverage is ${tape.coverage.status}, not likely-from-creation`;
    }

    if (skipReason) {
      skippedTokens.push({
        mint: token.mint,
        label: token.label ?? null,
        reason: skipReason,
        coverage: tape.coverage,
        sourceRows: tape.sourceRows,
        usableRows: tape.usableRows,
        periodDays: round(periodDays, 6),
      });
      continue;
    }

    const first = tape.events[0]!;
    const last = tape.events.at(-1)!;
    const priceHoldReturnPct = (last.priceSol / first.priceSol - 1) * 100;
    eligibleTokens += 1;

    for (const strategyRow of strategies) {
      try {
        const result = simulateAthDipProfitStrategy(
          tape.events,
          strategyRow.strategy,
          { startingSol: options.startingSol },
        );
        runs.push({
          mint: token.mint,
          label: token.label ?? null,
          tags: token.tags ?? [],
          strategyId: strategyRow.id,
          strategyName: strategyName(strategyRow),
          strategy: result.strategy,
          coverage: tape.coverage,
          sourceRows: tape.sourceRows,
          usableRows: tape.usableRows,
          periodDays: round(periodDays, 6),
          firstAtMs: first.tradedAtMs,
          lastAtMs: last.tradedAtMs,
          firstPriceSol: first.priceSol,
          lastPriceSol: last.priceSol,
          priceHoldReturnPct: round(priceHoldReturnPct),
          excessVsHoldPct: round(result.summary.returnPct - priceHoldReturnPct),
          summary: result.summary,
        });
      } catch (error) {
        failures.push({
          mint: token.mint,
          label: token.label ?? null,
          strategyId: strategyRow.id,
          strategyName: strategyName(strategyRow),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    version: 1,
    generatedAtMs: Date.now(),
    options,
    input: {
      tokens: tokens.length,
      strategies: strategies.length,
      matrixCells: tokens.length * strategies.length,
    },
    eligibleTokens,
    skippedTokens,
    failures,
    runs,
    strategies: summarizeHistoricalResearchRuns(runs, strategies),
  };
}
