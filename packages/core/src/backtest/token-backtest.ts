import { createSolardMeasure } from "../core/log.ts";
import { measuredSync } from "../core/measured.ts";
import {
  defaultTokenHistoryRepository,
  type TokenHistoryRepository,
} from "../chain/token-history/repository.ts";
import {
  normalizeAthDipProfitStrategy,
  simulateAthDipProfitStrategy,
  type AthDipProfitBacktestResult,
  type AthDipProfitStrategy,
} from "./strategy-sim.ts";
import { BacktestError } from "./errors.ts";
import {
  simulateTargetWeightStrategy,
  type TargetWeightBacktestResult,
} from "./target-weight-sim.ts";
import {
  normalizeTargetWeightPolicy,
  type TargetWeightPolicy,
} from "../strategy/target-weight.ts";
import {
  buildTokenBacktestTape,
  buildTokenBacktestTapeFromCandles,
  type TokenBacktestCoverage,
  type TokenBacktestTape,
  type TokenBacktestTapeOptions,
} from "./tape.ts";

export * from "./strategy-sim.ts";
export * from "./target-weight-sim.ts";
export * from "../strategy/target-weight.ts";
export { BacktestError } from "./errors.ts";
export {
  buildTokenBacktestTape,
  buildTokenBacktestTapeFromCandles,
} from "./tape.ts";
export type {
  TokenBacktestCoverage,
  TokenBacktestTape,
  TokenBacktestTapeOptions,
} from "./tape.ts";

const m = createSolardMeasure("backtest");

export type TokenBacktestDependencies = {
  repository: TokenHistoryRepository;
};

const defaults: TokenBacktestDependencies = {
  repository: defaultTokenHistoryRepository,
};

export type TokenBacktestRunOptions = TokenBacktestTapeOptions & {
  startingSol?: number;
  requireFromCreation?: boolean;
};

export function loadTokenBacktestTapeWithDependencies(
  deps: TokenBacktestDependencies,
  mintInput: string,
  options: TokenBacktestTapeOptions = {},
): TokenBacktestTape {
  const mint = mintInput.trim();
  return measuredSync(
    m,
    "build tape",
    () => {
      const historicalCoverage = deps.repository.getCoverage(mint);
      const requestedSource = options.source ?? "candles-1s";
      if (requestedSource === "candles-1s") {
        const candles = deps.repository.loadCandles1s(mint);
        if (candles.length > 0) {
          return buildTokenBacktestTapeFromCandles({
            mint,
            candles,
            historicalCoverage,
            options,
          });
        }
      }
      return buildTokenBacktestTape({
        mint,
        rows: deps.repository.loadTrades(mint),
        historicalCoverage,
        options,
      });
    },
    (tape) => ({
      mint: tape.mint.slice(0, 8),
      source: tape.source,
      sourceRows: tape.sourceRows,
      usableRows: tape.usableRows,
      skippedNoPrice: tape.skippedNoPrice,
      skippedAnomalousPrice: tape.skippedAnomalousPrice,
      coverage: tape.coverage.status,
    }),
  );
}

export function loadTokenBacktestTape(
  mintInput: string,
  options: TokenBacktestTapeOptions = {},
): TokenBacktestTape {
  return loadTokenBacktestTapeWithDependencies(defaults, mintInput, options);
}

export type TokenAthDipProfitBacktestResult = AthDipProfitBacktestResult & {
  mint: string;
  coverage: TokenBacktestCoverage;
  input: {
    source: TokenBacktestTape["source"];
    sourceRows: number;
    usableRows: number;
    skippedDropped: number;
    skippedNoPrice: number;
    skippedAnomalousPrice: number;
    priceAnomalies: TokenBacktestTape["priceAnomalies"];
    confidence: TokenBacktestTape["confidence"];
  };
};

export function backtestTokenTradesWithDependencies(
  deps: TokenBacktestDependencies,
  mint: string,
  inputStrategy: AthDipProfitStrategy,
  options: TokenBacktestRunOptions = {},
): TokenAthDipProfitBacktestResult {
  const strategy = normalizeAthDipProfitStrategy(inputStrategy);
  const tape = loadTokenBacktestTapeWithDependencies(deps, mint, options);
  if (tape.events.length < 2) {
    throw new BacktestError(
      "INSUFFICIENT_HISTORY",
      `Backtest requires at least two usable durable historical price events for ${tape.mint}; found ${tape.events.length}. Run: slrd token backfill ${tape.mint}`,
      { mint: tape.mint, events: tape.events.length },
    );
  }
  if (
    options.requireFromCreation &&
    (!tape.coverage.provenFromCreation || !tape.coverage.backfillComplete)
  ) {
    throw new BacktestError(
      "INCOMPLETE_HISTORY",
      `Full-history backtest refused for ${tape.mint}: durable creation coverage is incomplete. Re-run the archival backfill and resolve RPC/parser gaps.`,
      {
        mint: tape.mint,
        provenFromCreation: tape.coverage.provenFromCreation,
        backfillComplete: tape.coverage.backfillComplete,
      },
    );
  }

  const simulated = measuredSync(
    m,
    "simulate strategy",
    () =>
      simulateAthDipProfitStrategy(tape.events, strategy, {
        startingSol: options.startingSol,
      }),
    (result) => ({
      events: tape.events.length,
      buys: result.summary.buys,
      sells: result.summary.sells,
      returnPct: result.summary.returnPct,
      maxDrawdownPct: result.summary.maxDrawdownPct,
    }),
  );
  return {
    mint: tape.mint,
    coverage: tape.coverage,
    input: {
      source: tape.source,
      sourceRows: tape.sourceRows,
      usableRows: tape.usableRows,
      skippedDropped: tape.skippedDropped,
      skippedNoPrice: tape.skippedNoPrice,
      skippedAnomalousPrice: tape.skippedAnomalousPrice,
      priceAnomalies: tape.priceAnomalies,
      confidence: tape.confidence,
    },
    ...simulated,
  };
}

export function backtestTokenTrades(
  mint: string,
  inputStrategy: AthDipProfitStrategy,
  options: TokenBacktestRunOptions = {},
): TokenAthDipProfitBacktestResult {
  return backtestTokenTradesWithDependencies(
    defaults,
    mint,
    inputStrategy,
    options,
  );
}

export type TokenTargetWeightBacktestResult = TargetWeightBacktestResult & {
  mint: string;
  coverage: TokenBacktestCoverage;
  input: TokenAthDipProfitBacktestResult["input"];
};

export function backtestTargetWeightTokenWithDependencies(
  deps: TokenBacktestDependencies,
  mint: string,
  inputStrategy: TargetWeightPolicy,
  options: TokenBacktestRunOptions & { cadenceMs?: number } = {},
): TokenTargetWeightBacktestResult {
  const strategy = normalizeTargetWeightPolicy(inputStrategy);
  const tape = loadTokenBacktestTapeWithDependencies(deps, mint, options);
  if (tape.events.length < 2) {
    throw new BacktestError(
      "INSUFFICIENT_HISTORY",
      `Backtest requires at least two usable durable historical price events for ${tape.mint}; found ${tape.events.length}. Run: slrd token backfill ${tape.mint}`,
      { mint: tape.mint, events: tape.events.length },
    );
  }
  if (
    options.requireFromCreation &&
    (!tape.coverage.provenFromCreation || !tape.coverage.backfillComplete)
  ) {
    throw new BacktestError(
      "INCOMPLETE_HISTORY",
      `Full-history backtest refused for ${tape.mint}: durable creation coverage is incomplete. Re-run the archival backfill and resolve RPC/parser gaps.`,
      {
        mint: tape.mint,
        provenFromCreation: tape.coverage.provenFromCreation,
        backfillComplete: tape.coverage.backfillComplete,
      },
    );
  }

  const simulated = measuredSync(
    m,
    "simulate target-weight strategy",
    () =>
      simulateTargetWeightStrategy(tape.events, strategy, {
        startingSol: options.startingSol,
        cadenceMs: options.cadenceMs,
      }),
    (result) => ({
      events: tape.events.length,
      buys: result.summary.buys,
      sells: result.summary.sells,
      returnPct: result.summary.returnPct,
      maxDrawdownPct: result.summary.maxDrawdownPct,
      turnoverSol: result.summary.totalTurnoverSol,
    }),
  );
  return {
    mint: tape.mint,
    coverage: tape.coverage,
    input: {
      source: tape.source,
      sourceRows: tape.sourceRows,
      usableRows: tape.usableRows,
      skippedDropped: tape.skippedDropped,
      skippedNoPrice: tape.skippedNoPrice,
      skippedAnomalousPrice: tape.skippedAnomalousPrice,
      priceAnomalies: tape.priceAnomalies,
      confidence: tape.confidence,
    },
    ...simulated,
  };
}

export function backtestTargetWeightToken(
  mint: string,
  inputStrategy: TargetWeightPolicy,
  options: TokenBacktestRunOptions & { cadenceMs?: number } = {},
): TokenTargetWeightBacktestResult {
  return backtestTargetWeightTokenWithDependencies(
    defaults,
    mint,
    inputStrategy,
    options,
  );
}
