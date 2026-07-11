import {
  SOLARD_DB_PATH,
  ensureSharedTerminalDb,
  terminalDb,
  type ProcessStatus,
  type TerminalDatabase,
} from "../shared/terminal-db.js";
import { json } from "./measure.js";
import type {
  IndexedComplete,
  IndexedCreate,
  IndexedTrade,
  TokenMetadataPatch,
} from "./types.js";

export type IndexerDb = {
  db: TerminalDatabase;
  path: string;
  close(): void;
};

export function openIndexerDb(): IndexerDb {
  ensureSharedTerminalDb();
  return {
    db: terminalDb,
    path: SOLARD_DB_PATH,
    // The indexer and web server are separate processes. Closing the process
    // releases its own sqlite-zod-orm connection.
    close: () => undefined,
  };
}

export function withWrite<T>(db: TerminalDatabase, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function changes(db: TerminalDatabase): number {
  return Number(
    db.raw<{ changes: number }>("SELECT changes() as changes")[0]?.changes ?? 0,
  );
}

export function rememberIngestionKey(
  db: TerminalDatabase,
  key: string,
  kind: string,
  now = Date.now(),
): boolean {
  db.exec(
    "INSERT OR IGNORE INTO terminalIngestionKeys (key, kind, seenAtMs) VALUES (?, ?, ?)",
    key,
    kind,
    now,
  );
  return changes(db) > 0;
}

export function pruneIngestionKeys(
  db: TerminalDatabase,
  kind: string,
  maxAgeMs: number,
  now = Date.now(),
): number {
  const cutoff = now - Math.max(60_000, maxAgeMs);
  db.exec(
    `DELETE FROM terminalIngestionKeys
     WHERE key IN (
       SELECT key FROM terminalIngestionKeys
       WHERE kind = ? AND seenAtMs < ?
       ORDER BY seenAtMs ASC
       LIMIT 50000
     )`,
    kind,
    cutoff,
  );
  return changes(db);
}

export function recordWorkerError(
  db: TerminalDatabase,
  worker: string,
  error: unknown,
  data: Record<string, unknown> = {},
): void {
  const err = error instanceof Error ? error : new Error(String(error));
  db.exec(
    `INSERT INTO terminalWorkerErrors
      (id, worker, message, stack, dataJson, createdAtMs)
     VALUES (?, ?, ?, ?, ?, ?)`,
    `${worker}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
    worker,
    err.message,
    err.stack ?? null,
    json(data),
    Date.now(),
  );
}

function parseObject(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function upsertProcessStatus(
  db: TerminalDatabase,
  input: {
    name: string;
    kind: string;
    status: string;
    buildId?: string | null;
    error?: unknown;
    data?: Record<string, unknown>;
    heartbeatAtMs?: number;
  },
): void {
  const existing = db.raw<Pick<ProcessStatus, "dataJson">>(
    "SELECT dataJson FROM processStatus WHERE name = ? LIMIT 1",
    input.name,
  )[0];

  const data = {
    ...parseObject(existing?.dataJson),
    pid: process.pid,
    buildId: input.buildId ?? null,
    ...(input.data ?? {}),
  };

  db.exec(
    `INSERT INTO processStatus
      (name, kind, status, heartbeatAtMs, dataJson, error)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       kind = excluded.kind,
       status = excluded.status,
       heartbeatAtMs = excluded.heartbeatAtMs,
       dataJson = excluded.dataJson,
       error = excluded.error`,
    input.name,
    input.kind,
    input.status,
    input.heartbeatAtMs ?? Date.now(),
    json(data),
    input.error == null
      ? null
      : input.error instanceof Error
        ? input.error.message
        : String(input.error),
  );
}

export function upsertCreate(
  db: TerminalDatabase,
  event: IndexedCreate,
  supplyUi: number,
): void {
  db.exec(
    `INSERT INTO terminalTokensLive
      (mint, symbol, name, uri, creator, bondingCurveKey, source, phase,
       supplyUi, signature, lastSlot, createdAtMs, updatedAtMs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET
       symbol = COALESCE(NULLIF(excluded.symbol, ''), terminalTokensLive.symbol),
       name = COALESCE(NULLIF(excluded.name, ''), terminalTokensLive.name),
       uri = COALESCE(NULLIF(excluded.uri, ''), terminalTokensLive.uri),
       creator = COALESCE(NULLIF(excluded.creator, ''), terminalTokensLive.creator),
       bondingCurveKey = COALESCE(NULLIF(excluded.bondingCurveKey, ''), terminalTokensLive.bondingCurveKey),
       source = excluded.source,
       phase = COALESCE(excluded.phase, terminalTokensLive.phase),
       supplyUi = COALESCE(excluded.supplyUi, terminalTokensLive.supplyUi),
       signature = COALESCE(excluded.signature, terminalTokensLive.signature),
       lastSlot = COALESCE(excluded.lastSlot, terminalTokensLive.lastSlot),
       createdAtMs = COALESCE(terminalTokensLive.createdAtMs, excluded.createdAtMs),
       updatedAtMs = excluded.updatedAtMs`,
    event.mint,
    event.symbol ?? "",
    event.name ?? "",
    event.uri ?? null,
    event.creator ?? null,
    event.bondingCurveKey ?? null,
    "helius-indexer-create",
    "pump",
    supplyUi,
    event.signature,
    event.slot,
    event.createdAtMs,
    Date.now(),
  );
}

export function insertTradeAndToken(
  db: TerminalDatabase,
  event: IndexedTrade,
  supplyUi: number,
): void {
  const now = Date.now();

  db.exec(
    `INSERT INTO terminalTradesLive
      (id, mint, signature, slot, owner, side, tokenDeltaUi, solDeltaUi,
       priceSol, priceUsd, marketCapUsd, confidence, source, rawJson,
       createdAtMs, updatedAtMs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       priceSol = COALESCE(excluded.priceSol, terminalTradesLive.priceSol),
       priceUsd = COALESCE(excluded.priceUsd, terminalTradesLive.priceUsd),
       marketCapUsd = COALESCE(excluded.marketCapUsd, terminalTradesLive.marketCapUsd),
       confidence = excluded.confidence,
       source = excluded.source,
       rawJson = excluded.rawJson,
       updatedAtMs = excluded.updatedAtMs`,
    event.id,
    event.mint,
    event.signature,
    event.slot,
    event.owner ?? null,
    event.side,
    event.tokenDeltaUi ?? 0,
    event.solDeltaUi ?? 0,
    event.priceSol,
    event.priceUsd,
    event.marketCapUsd,
    "processed",
    "helius-indexer-trade",
    json(event.raw),
    event.createdAtMs,
    now,
  );

  db.exec(
    `INSERT INTO terminalTokensLive
      (mint, source, phase, supplyUi, priceSol, priceUsd, marketCapSol,
       marketCapUsd, initialMarketCapUsd, lastSlot, signature, createdAtMs,
       updatedAtMs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET
       source = excluded.source,
       phase = COALESCE(terminalTokensLive.phase, excluded.phase),
       supplyUi = COALESCE(terminalTokensLive.supplyUi, excluded.supplyUi),
       priceSol = COALESCE(excluded.priceSol, terminalTokensLive.priceSol),
       priceUsd = COALESCE(excluded.priceUsd, terminalTokensLive.priceUsd),
       marketCapSol = COALESCE(excluded.marketCapSol, terminalTokensLive.marketCapSol),
       marketCapUsd = COALESCE(excluded.marketCapUsd, terminalTokensLive.marketCapUsd),
       initialMarketCapUsd = COALESCE(terminalTokensLive.initialMarketCapUsd, excluded.initialMarketCapUsd),
       lastSlot = COALESCE(excluded.lastSlot, terminalTokensLive.lastSlot),
       signature = COALESCE(excluded.signature, terminalTokensLive.signature),
       createdAtMs = COALESCE(terminalTokensLive.createdAtMs, excluded.createdAtMs),
       updatedAtMs = excluded.updatedAtMs`,
    event.mint,
    "helius-indexer-trade",
    "pump",
    supplyUi,
    event.priceSol,
    event.priceUsd,
    event.marketCapSol,
    event.marketCapUsd,
    event.marketCapUsd,
    event.slot,
    event.signature,
    event.createdAtMs,
    now,
  );
}

export function upsertComplete(
  db: TerminalDatabase,
  event: IndexedComplete,
): void {
  db.exec(
    `INSERT INTO terminalTokensLive
      (mint, bondingCurveKey, source, phase, lastSlot, signature,
       createdAtMs, updatedAtMs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET
       bondingCurveKey = COALESCE(NULLIF(excluded.bondingCurveKey, ''), terminalTokensLive.bondingCurveKey),
       source = excluded.source,
       phase = excluded.phase,
       lastSlot = COALESCE(excluded.lastSlot, terminalTokensLive.lastSlot),
       signature = COALESCE(excluded.signature, terminalTokensLive.signature),
       createdAtMs = COALESCE(terminalTokensLive.createdAtMs, excluded.createdAtMs),
       updatedAtMs = excluded.updatedAtMs`,
    event.mint,
    event.bondingCurveKey ?? null,
    "helius-indexer-complete",
    "migrated",
    event.slot,
    event.signature,
    event.createdAtMs,
    Date.now(),
  );
}

export function mergeTokenMetadata(
  db: TerminalDatabase,
  patch: TokenMetadataPatch,
): void {
  db.exec(
    `UPDATE terminalTokensLive SET
       name = COALESCE(NULLIF(?, ''), name),
       symbol = COALESCE(NULLIF(?, ''), symbol),
       image = COALESCE(NULLIF(?, ''), image),
       description = COALESCE(NULLIF(?, ''), description),
       website = COALESCE(NULLIF(?, ''), website),
       twitter = COALESCE(NULLIF(?, ''), twitter),
       telegram = COALESCE(NULLIF(?, ''), telegram),
       uri = COALESCE(NULLIF(?, ''), uri),
       updatedAtMs = ?
     WHERE mint = ?`,
    patch.name ?? null,
    patch.symbol ?? null,
    patch.image ?? null,
    patch.description ?? null,
    patch.website ?? null,
    patch.twitter ?? null,
    patch.telegram ?? null,
    patch.uri ?? null,
    Date.now(),
    patch.mint,
  );
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

export function recomputeIndicators(
  db: TerminalDatabase,
  mint: string,
  now = Date.now(),
): void {
  const intervals = [60, 300, 900] as const;
  const oldestSince = now - Math.max(...intervals) * 1000;

  const trades = db.raw<{
    createdAtMs: number;
    priceUsd: number | null;
    marketCapUsd: number | null;
    solDeltaUi: number | null;
  }>(
    `SELECT createdAtMs, priceUsd, marketCapUsd, solDeltaUi
     FROM terminalTradesLive
     WHERE mint = ? AND createdAtMs >= ? AND priceUsd IS NOT NULL
     ORDER BY createdAtMs DESC`,
    mint,
    oldestSince,
  );

  for (const intervalSec of intervals) {
    const since = now - intervalSec * 1000;
    const sample = trades.filter((row) => Number(row.createdAtMs) >= since);
    const prices = sample
      .map((row) => Number(row.priceUsd))
      .filter(Number.isFinite);
    const marketCaps = sample
      .map((row) => Number(row.marketCapUsd))
      .filter(Number.isFinite);
    const volumeSol = sample.reduce(
      (sum, row) => sum + Math.abs(Number(row.solDeltaUi ?? 0)),
      0,
    );

    db.exec(
      `INSERT INTO terminalIndicatorsLive
        (id, mint, intervalSec, smaPriceUsd, smaMarketCapUsd, vwmaPriceUsd,
         medianPriceUsd, tradeCount, volumeSol, updatedAtMs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mint, intervalSec) DO UPDATE SET
         id = excluded.id,
         smaPriceUsd = excluded.smaPriceUsd,
         smaMarketCapUsd = excluded.smaMarketCapUsd,
         vwmaPriceUsd = excluded.vwmaPriceUsd,
         medianPriceUsd = excluded.medianPriceUsd,
         tradeCount = excluded.tradeCount,
         volumeSol = excluded.volumeSol,
         updatedAtMs = excluded.updatedAtMs`,
      `${mint}:${intervalSec}`,
      mint,
      intervalSec,
      prices.length
        ? prices.reduce((sum, value) => sum + value, 0) / prices.length
        : null,
      marketCaps.length
        ? marketCaps.reduce((sum, value) => sum + value, 0) / marketCaps.length
        : null,
      null,
      median(prices),
      sample.length,
      volumeSol,
      now,
    );
  }
}
