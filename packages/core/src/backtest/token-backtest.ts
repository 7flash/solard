import { db, type TerminalToken, type TokenTrade } from "../db.ts";
import {
  normalizeAthDipProfitStrategy,
  simulateAthDipProfitStrategy,
  type AthDipProfitBacktestResult,
  type AthDipProfitStrategy,
  type BacktestTapeEvent,
} from "./strategy-sim.ts";

export * from "./strategy-sim.ts";

export type TokenBacktestCoverage = {
  tokenCreatedAtMs: number | null;
  firstRecordedTradeAtMs: number | null;
  lastRecordedTradeAtMs: number | null;
  creationGapMs: number | null;
  status: "likely-from-creation" | "partial" | "unknown";
  toleranceMs: number;
};

export type TokenBacktestTape = {
  mint: string;
  sourceRows: number;
  usableRows: number;
  skippedDropped: number;
  skippedNoPrice: number;
  confidence: {
    processed: number;
    confirmed: number;
    finalized: number;
  };
  token: TerminalToken | null;
  coverage: TokenBacktestCoverage;
  events: BacktestTapeEvent[];
};

function positive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function canonicalPriceSol(row: TokenTrade): number | null {
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

export function loadTokenBacktestTape(
  mintInput: string,
  options: {
    fromMs?: number;
    toMs?: number;
    includeProcessed?: boolean;
    coverageToleranceMs?: number;
  } = {},
): TokenBacktestTape {
  const mint = mintInput.trim();
  if (!mint) throw new Error("Token mint is required for backtest");
  const fromMs = Math.max(0, Number(options.fromMs ?? 0) || 0);
  const toMsRaw = Number(options.toMs ?? Number.POSITIVE_INFINITY);
  const toMs = Number.isFinite(toMsRaw)
    ? Math.max(0, toMsRaw)
    : Number.POSITIVE_INFINITY;
  const toleranceMs = Math.max(
    0,
    Math.trunc(options.coverageToleranceMs ?? 60_000),
  );

  const rows = db.tokenTradesV2
    .select()
    .where({ mint })
    .orderBy("tradedAtMs", "asc")
    .all() as TokenTrade[];
  const token =
    (db.terminalTokensLive
      .select()
      .where({ mint })
      .get() as TerminalToken | null) ?? null;

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

  const firstRecordedTradeAtMs = rows.length
    ? Math.min(...rows.map((row) => row.tradedAtMs))
    : null;
  const lastRecordedTradeAtMs = rows.length
    ? Math.max(...rows.map((row) => row.tradedAtMs))
    : null;
  const tokenCreatedAtMs = positive(token?.createdAtMs);
  const creationGapMs =
    tokenCreatedAtMs != null && firstRecordedTradeAtMs != null
      ? Math.max(0, firstRecordedTradeAtMs - tokenCreatedAtMs)
      : null;
  const status: TokenBacktestCoverage["status"] =
    tokenCreatedAtMs == null || firstRecordedTradeAtMs == null
      ? "unknown"
      : creationGapMs! <= toleranceMs
        ? "likely-from-creation"
        : "partial";

  return {
    mint,
    sourceRows: rows.length,
    usableRows: events.length,
    skippedDropped,
    skippedNoPrice,
    confidence,
    token,
    coverage: {
      tokenCreatedAtMs,
      firstRecordedTradeAtMs,
      lastRecordedTradeAtMs,
      creationGapMs,
      status,
      toleranceMs,
    },
    events,
  };
}

export type TokenAthDipProfitBacktestResult = AthDipProfitBacktestResult & {
  mint: string;
  coverage: TokenBacktestCoverage;
  input: {
    sourceRows: number;
    usableRows: number;
    skippedDropped: number;
    skippedNoPrice: number;
    confidence: TokenBacktestTape["confidence"];
  };
};

export function backtestTokenTrades(
  mint: string,
  inputStrategy: AthDipProfitStrategy,
  options: {
    startingSol?: number;
    fromMs?: number;
    toMs?: number;
    includeProcessed?: boolean;
    coverageToleranceMs?: number;
    requireFromCreation?: boolean;
  } = {},
): TokenAthDipProfitBacktestResult {
  const strategy = normalizeAthDipProfitStrategy(inputStrategy);
  const tape = loadTokenBacktestTape(mint, options);
  if (tape.events.length < 2) {
    throw new Error(
      `Backtest requires at least two usable historical price events for ${tape.mint}; found ${tape.events.length}. Backfill tokenTradesV2 first.`,
    );
  }
  if (
    options.requireFromCreation &&
    tape.coverage.status !== "likely-from-creation"
  ) {
    const detail =
      tape.coverage.status === "partial"
        ? `first stored trade is ${tape.coverage.creationGapMs}ms after token.createdAtMs`
        : "token creation coverage cannot be proven from the local database";
    throw new Error(
      `Full-history backtest refused for ${tape.mint}: ${detail}. Run/verify the historical backfill or omit --require-from-start.`,
    );
  }
  return {
    mint: tape.mint,
    coverage: tape.coverage,
    input: {
      sourceRows: tape.sourceRows,
      usableRows: tape.usableRows,
      skippedDropped: tape.skippedDropped,
      skippedNoPrice: tape.skippedNoPrice,
      confidence: tape.confidence,
    },
    ...simulateAthDipProfitStrategy(tape.events, strategy, {
      startingSol: options.startingSol,
    }),
  };
}
