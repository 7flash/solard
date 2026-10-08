import {
  defaultTokenHistoryRepository,
  type TokenHistoryRepository,
} from "../chain/token-history/repository.ts";
import {
  buildTokenBacktestTape,
  type TokenBacktestTape,
  type TokenBacktestTapeOptions,
} from "./tape.ts";
import type { BacktestTapeEvent } from "./strategy-sim.ts";

export type HistoricalTradeTape = TokenBacktestTape & {
  completeness: {
    status: "complete" | "partial" | "unknown";
    missingTransactions: number | null;
    undecodedTransactions: number | null;
    missingTimestamps: number | null;
    missingPrices: number;
    warnings: string[];
    decoderCoverage: readonly string[];
  };
};

/** Cached history only. Populate with backfillTokenHistory first; no network or synthetic prices. */
export function loadHistoricalTradeTape(
  mint: string,
  options: TokenBacktestTapeOptions = {},
  repository: TokenHistoryRepository = defaultTokenHistoryRepository,
): HistoricalTradeTape {
  const coverage = repository.getCoverage(mint);
  const tape = buildTokenBacktestTape({
    mint,
    rows: repository.loadTrades(mint),
    historicalCoverage: coverage,
    options: {
      ...options,
      includeProcessed: options.includeProcessed ?? false,
    },
  });
  const missing = coverage?.missingTransactions ?? null;
  const undecoded = coverage?.skippedAmbiguous ?? null;
  const missingTimestamps = coverage?.skippedNoTimestamp ?? null;
  const warnings: string[] = [];
  if (!coverage)
    warnings.push(
      "No stored backfill coverage proves that the requested history was exhausted.",
    );
  if (missing) warnings.push(`${missing} transaction(s) could not be fetched.`);
  if (undecoded)
    warnings.push(
      `${undecoded} transaction(s) were ambiguous or unsupported by the history decoder.`,
    );
  if (missingTimestamps)
    warnings.push(
      `${missingTimestamps} transaction(s) lack a usable historical timestamp.`,
    );
  if (tape.skippedNoPrice)
    warnings.push(`${tape.skippedNoPrice} trade(s) have no usable SOL price.`);
  if (coverage?.historyMode === "price-sampled")
    warnings.push("Sampled price history is not a complete trade tape.");
  const outsideSnapshot =
    options.toMs != null && (!coverage || options.toMs > coverage.updatedAtMs);
  if (outsideSnapshot)
    warnings.push(
      "The requested end time is later than the cached history snapshot; refresh the backfill before treating this window as complete.",
    );
  warnings.push(
    "Historical decoder coverage is Pump curve, PumpSwap and Raydium; Meteora and unconverted custom quote prices are not guaranteed.",
  );
  const complete =
    !outsideSnapshot &&
    coverage?.complete === true &&
    missing === 0 &&
    undecoded === 0 &&
    missingTimestamps === 0 &&
    tape.skippedNoPrice === 0 &&
    tape.skippedAnomalousPrice === 0 &&
    coverage.historyMode !== "price-sampled";
  return {
    ...tape,
    completeness: {
      status: complete
        ? "complete"
        : coverage || tape.sourceRows
          ? "partial"
          : "unknown",
      missingTransactions: missing,
      undecodedTransactions: undecoded,
      missingTimestamps,
      missingPrices: tape.skippedNoPrice,
      warnings,
      decoderCoverage: ["pump-curve", "pumpswap", "raydium"],
    },
  };
}

export type HistoricalCandle = {
  bucketAtMs: number;
  closedAtMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  trades: number;
  buys: number;
  sells: number;
  volumeSol: number | null;
  volumeTokenUi: number | null;
};

/** Sparse observed candles only: absent periods remain absent, and missing size remains null. */
export function buildHistoricalCandles(
  events: readonly BacktestTapeEvent[],
  bucketMs = 1000,
): HistoricalCandle[] {
  if (!Number.isSafeInteger(bucketMs) || bucketMs <= 0)
    throw new Error("bucketMs must be a positive integer");
  const candles = new Map<number, HistoricalCandle>();
  for (const event of [...events].sort(
    (a, b) => a.tradedAtMs - b.tradedAtMs || a.slot - b.slot,
  )) {
    if (
      !Number.isFinite(event.priceSol) ||
      event.priceSol <= 0 ||
      !Number.isFinite(event.tradedAtMs) ||
      event.confidence === "dropped"
    )
      continue;
    const at = Math.floor(event.tradedAtMs / bucketMs) * bucketMs;
    const sol =
      Number.isFinite(event.solNotional) && event.solNotional! >= 0
        ? event.solNotional!
        : null;
    const token =
      Number.isFinite(event.tokenQuantityUi) && event.tokenQuantityUi! >= 0
        ? event.tokenQuantityUi!
        : null;
    const candle = candles.get(at);
    if (!candle)
      candles.set(at, {
        bucketAtMs: at,
        closedAtMs: at + bucketMs,
        open: event.priceSol,
        high: event.priceSol,
        low: event.priceSol,
        close: event.priceSol,
        trades: 1,
        buys: event.side === "buy" ? 1 : 0,
        sells: event.side === "sell" ? 1 : 0,
        volumeSol: sol,
        volumeTokenUi: token,
      });
    else {
      candle.high = Math.max(candle.high, event.priceSol);
      candle.low = Math.min(candle.low, event.priceSol);
      candle.close = event.priceSol;
      candle.trades++;
      if (event.side === "buy") candle.buys++;
      if (event.side === "sell") candle.sells++;
      candle.volumeSol =
        candle.volumeSol === null || sol === null
          ? null
          : candle.volumeSol + sol;
      candle.volumeTokenUi =
        candle.volumeTokenUi === null || token === null
          ? null
          : candle.volumeTokenUi + token;
    }
  }
  return [...candles.values()];
}
