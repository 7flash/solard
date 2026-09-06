import { chronologicalTokenHistoryTrades } from "../chain/token-history/ordering.ts";
import type {
  TokenHistoryCandle1s,
  TokenHistoryCoverage,
  TokenHistoryTrade,
} from "../chain/token-history/types.ts";
import type { BacktestTapeEvent } from "./strategy-sim.ts";
import { BacktestError } from "./errors.ts";

export type TokenBacktestCoverage = {
  tokenCreatedAtMs: number | null;
  firstRecordedTradeAtMs: number | null;
  lastRecordedTradeAtMs: number | null;
  creationGapMs: number | null;
  status: "likely-from-creation" | "partial" | "unknown";
  toleranceMs: number;
  provenFromCreation: boolean;
  backfillComplete: boolean;
  creationSignature: string | null;
};

export type TokenBacktestTape = {
  mint: string;
  source: "trades" | "candles-1s";
  sourceRows: number;
  usableRows: number;
  skippedDropped: number;
  skippedNoPrice: number;
  confidence: {
    processed: number;
    confirmed: number;
    finalized: number;
  };
  /** @deprecated Backtests intentionally do not depend on live terminal metadata. */
  token: null;
  coverage: TokenBacktestCoverage;
  events: BacktestTapeEvent[];
};

export type TokenBacktestTapeOptions = {
  source?: "candles-1s" | "trades";
  fromMs?: number;
  toMs?: number;
  includeProcessed?: boolean;
  coverageToleranceMs?: number;
};

function positive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function canonicalPriceSol(row: TokenHistoryTrade): number | null {
  const explicit = positive(row.priceSol);
  if (explicit != null) return explicit;
  const tokenDelta = Math.abs(Number(row.tokenDeltaUi));
  const solDelta = Math.abs(Number(row.solDeltaUi));
  if (
    Number.isFinite(tokenDelta) &&
    tokenDelta > 0 &&
    Number.isFinite(solDelta) &&
    solDelta > 0
  ) {
    return solDelta / tokenDelta;
  }
  return null;
}

/** Pure deterministic conversion from durable domain rows to replay events. */
export function buildTokenBacktestTape(input: {
  mint: string;
  rows: readonly TokenHistoryTrade[];
  historicalCoverage: TokenHistoryCoverage | null;
  options?: TokenBacktestTapeOptions;
}): TokenBacktestTape {
  const mint = input.mint.trim();
  if (!mint) {
    throw new BacktestError(
      "INVALID_INPUT",
      "Token mint is required for backtest",
    );
  }
  const options = input.options ?? {};
  const rows = chronologicalTokenHistoryTrades(input.rows);
  const fromMs = Math.max(0, Number(options.fromMs ?? 0) || 0);
  const toMsRaw = Number(options.toMs ?? Number.POSITIVE_INFINITY);
  const toMs = Number.isFinite(toMsRaw)
    ? Math.max(0, toMsRaw)
    : Number.POSITIVE_INFINITY;
  const toleranceMs = Math.max(
    0,
    Math.trunc(options.coverageToleranceMs ?? 60_000),
  );

  let skippedDropped = 0;
  let skippedNoPrice = 0;
  const confidence = { processed: 0, confirmed: 0, finalized: 0 };
  const events: BacktestTapeEvent[] = [];

  for (const row of rows) {
    if (row.tradedAtMs < fromMs || row.tradedAtMs > toMs) continue;
    if (row.confidence === "dropped") {
      skippedDropped += 1;
      continue;
    }
    if (row.confidence === "processed" && options.includeProcessed === false) {
      continue;
    }
    if (row.confidence === "processed") confidence.processed += 1;
    else if (row.confidence === "confirmed") confidence.confirmed += 1;
    else if (row.confidence === "finalized") confidence.finalized += 1;

    const priceSol = canonicalPriceSol(row);
    if (priceSol == null) {
      skippedNoPrice += 1;
      continue;
    }
    events.push({
      id: row.eventKey,
      signature: row.signature,
      slot: row.slot,
      tradedAtMs: row.tradedAtMs,
      priceSol,
      marketCapUsd: positive(row.marketCapUsd),
      source: row.source,
      confidence: row.confidence,
    });
  }

  const firstRecordedTradeAtMs = rows[0]?.tradedAtMs ?? null;
  const lastRecordedTradeAtMs = rows.at(-1)?.tradedAtMs ?? null;
  const tokenCreatedAtMs = input.historicalCoverage?.creationAtMs ?? null;
  const creationGapMs =
    tokenCreatedAtMs != null && firstRecordedTradeAtMs != null
      ? Math.max(0, firstRecordedTradeAtMs - tokenCreatedAtMs)
      : null;
  const provenFromCreation = input.historicalCoverage?.fromCreation === true;
  const backfillComplete = input.historicalCoverage?.complete === true;
  const status: TokenBacktestCoverage["status"] =
    provenFromCreation && backfillComplete
      ? "likely-from-creation"
      : rows.length > 0 || input.historicalCoverage != null
        ? "partial"
        : "unknown";

  return {
    mint,
    source: "trades",
    sourceRows: rows.length,
    usableRows: events.length,
    skippedDropped,
    skippedNoPrice,
    confidence,
    token: null,
    coverage: {
      tokenCreatedAtMs,
      firstRecordedTradeAtMs,
      lastRecordedTradeAtMs,
      creationGapMs,
      status,
      toleranceMs,
      provenFromCreation,
      backfillComplete,
      creationSignature: input.historicalCoverage?.creationSignature ?? null,
    },
    events,
  };
}

/**
 * Pure sparse-candle replay tape.
 *
 * `priceSol` is the candle close and the event timestamp is the END of the
 * second, preventing a strategy from seeing the close before that second has
 * actually elapsed. OHLC remains available on the source candle for future
 * conservative intrabar execution models; exact-trade replay remains available
 * with `source: "trades"`.
 */
export function buildTokenBacktestTapeFromCandles(input: {
  mint: string;
  candles: readonly TokenHistoryCandle1s[];
  historicalCoverage: TokenHistoryCoverage | null;
  options?: TokenBacktestTapeOptions;
}): TokenBacktestTape {
  const mint = input.mint.trim();
  if (!mint) {
    throw new BacktestError(
      "INVALID_INPUT",
      "Token mint is required for backtest",
    );
  }
  const options = input.options ?? {};
  const fromMs = Math.max(0, Number(options.fromMs ?? 0) || 0);
  const toMsRaw = Number(options.toMs ?? Number.POSITIVE_INFINITY);
  const toMs = Number.isFinite(toMsRaw)
    ? Math.max(0, toMsRaw)
    : Number.POSITIVE_INFINITY;
  const toleranceMs = Math.max(
    0,
    Math.trunc(options.coverageToleranceMs ?? 60_000),
  );

  const rows = [...input.candles].sort(
    (left, right) =>
      left.bucketAtMs - right.bucketAtMs ||
      left.firstSlot - right.firstSlot ||
      left.candleKey.localeCompare(right.candleKey),
  );
  const events: BacktestTapeEvent[] = [];
  for (const row of rows) {
    const eventAtMs = row.bucketAtMs + 999;
    if (eventAtMs < fromMs || eventAtMs > toMs) continue;
    if (!Number.isFinite(row.closePriceSol) || row.closePriceSol <= 0) continue;
    events.push({
      id: row.candleKey,
      signature: row.lastSignature,
      slot: row.lastSlot,
      tradedAtMs: eventAtMs,
      priceSol: row.closePriceSol,
      marketCapUsd: null,
      source: "history-candle-1s",
      confidence:
        input.historicalCoverage?.commitment === "finalized"
          ? "finalized"
          : "confirmed",
    });
  }

  const firstRecordedTradeAtMs = rows[0]?.bucketAtMs ?? null;
  const lastRecordedTradeAtMs = rows.at(-1)?.bucketAtMs ?? null;
  const tokenCreatedAtMs = input.historicalCoverage?.creationAtMs ?? null;
  const creationGapMs =
    tokenCreatedAtMs != null && firstRecordedTradeAtMs != null
      ? Math.max(0, firstRecordedTradeAtMs - tokenCreatedAtMs)
      : null;
  const provenFromCreation = input.historicalCoverage?.fromCreation === true;
  const backfillComplete = input.historicalCoverage?.complete === true;
  const status: TokenBacktestCoverage["status"] =
    provenFromCreation && backfillComplete
      ? "likely-from-creation"
      : rows.length > 0 || input.historicalCoverage != null
        ? "partial"
        : "unknown";
  const confidence = {
    processed: 0,
    confirmed:
      input.historicalCoverage?.commitment === "confirmed" ? events.length : 0,
    finalized:
      input.historicalCoverage?.commitment === "finalized" ? events.length : 0,
  };

  return {
    mint,
    source: "candles-1s",
    sourceRows: rows.length,
    usableRows: events.length,
    skippedDropped: 0,
    skippedNoPrice: rows.length - events.length,
    confidence,
    token: null,
    coverage: {
      tokenCreatedAtMs,
      firstRecordedTradeAtMs,
      lastRecordedTradeAtMs,
      creationGapMs,
      status,
      toleranceMs,
      provenFromCreation,
      backfillComplete,
      creationSignature: input.historicalCoverage?.creationSignature ?? null,
    },
    events,
  };
}
