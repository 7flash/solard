import { Database } from "bun:sqlite";
import { json, summarizeError } from "./measure.js";
import type { IndexedComplete, IndexedCreate, IndexedTrade } from "./types.js";
export type IndexerDb = { db: Database; close(): void };
export function openIndexerDb(path: string): IndexerDb {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  initSchema(db);
  return { db, close: () => db.close() };
}
function tableColumns(db: Database, table: string): Set<string> {
  return new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name),
  );
}
function ensureColumn(
  db: Database,
  table: string,
  name: string,
  definition: string,
): void {
  if (!tableColumns(db, table).has(name))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}
function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS terminalTokensLive (mint TEXT PRIMARY KEY, symbol TEXT, name TEXT, uri TEXT, image TEXT, description TEXT, website TEXT, twitter TEXT, telegram TEXT, creator TEXT, bondingCurveKey TEXT, source TEXT, phase TEXT, isMayhemMode INTEGER, quoteAsset TEXT, quoteMint TEXT, supplyUi REAL, priceSol REAL, priceUsd REAL, marketCapSol REAL, marketCapUsd REAL, initialMarketCapSol REAL, initialMarketCapUsd REAL, lastSlot INTEGER, signature TEXT, rawJson TEXT, createdAtMs INTEGER, updatedAtMs INTEGER);
    CREATE TABLE IF NOT EXISTS terminalTradesLive (id TEXT PRIMARY KEY, mint TEXT NOT NULL, signature TEXT, slot INTEGER, owner TEXT, side TEXT, tokenDeltaUi REAL, solDeltaUi REAL, priceSol REAL, priceUsd REAL, marketCapUsd REAL, confidence TEXT, source TEXT, rawJson TEXT, createdAtMs INTEGER NOT NULL, updatedAtMs INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS terminalIndicatorsLive (mint TEXT NOT NULL, intervalSec INTEGER NOT NULL, smaMarketCapUsd REAL, smaPriceUsd REAL, medianMarketCapUsd REAL, tradeCount INTEGER, buyCount INTEGER, sellCount INTEGER, volumeSol REAL, volumeUsd REAL, updatedAtMs INTEGER NOT NULL, PRIMARY KEY (mint, intervalSec));
    CREATE TABLE IF NOT EXISTS terminalProcessStatus (name TEXT PRIMARY KEY, kind TEXT, status TEXT, heartbeatAtMs INTEGER, pid INTEGER, buildId TEXT, error TEXT, dataJson TEXT, updatedAtMs INTEGER);
    CREATE TABLE IF NOT EXISTS terminalWorkerErrors (id TEXT PRIMARY KEY, worker TEXT NOT NULL, message TEXT NOT NULL, stack TEXT, dataJson TEXT, createdAtMs INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS terminalIngestionKeys (key TEXT PRIMARY KEY, kind TEXT NOT NULL, seenAtMs INTEGER NOT NULL);
  `);
  for (const [name, definition] of Object.entries({
    symbol: "TEXT",
    name: "TEXT",
    uri: "TEXT",
    image: "TEXT",
    description: "TEXT",
    website: "TEXT",
    twitter: "TEXT",
    telegram: "TEXT",
    creator: "TEXT",
    bondingCurveKey: "TEXT",
    source: "TEXT",
    phase: "TEXT",
    isMayhemMode: "INTEGER",
    quoteAsset: "TEXT",
    quoteMint: "TEXT",
    supplyUi: "REAL",
    priceSol: "REAL",
    priceUsd: "REAL",
    marketCapSol: "REAL",
    marketCapUsd: "REAL",
    initialMarketCapSol: "REAL",
    initialMarketCapUsd: "REAL",
    lastSlot: "INTEGER",
    signature: "TEXT",
    rawJson: "TEXT",
    createdAtMs: "INTEGER",
    updatedAtMs: "INTEGER",
  }))
    ensureColumn(db, "terminalTokensLive", name, definition);
  for (const [name, definition] of Object.entries({
    slot: "INTEGER",
    owner: "TEXT",
    side: "TEXT",
    tokenDeltaUi: "REAL",
    solDeltaUi: "REAL",
    priceSol: "REAL",
    priceUsd: "REAL",
    marketCapUsd: "REAL",
    confidence: "TEXT",
    source: "TEXT",
    rawJson: "TEXT",
    updatedAtMs: "INTEGER",
  }))
    ensureColumn(db, "terminalTradesLive", name, definition);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_terminal_tokens_updated ON terminalTokensLive(updatedAtMs DESC); CREATE INDEX IF NOT EXISTS idx_terminal_tokens_source_updated ON terminalTokensLive(source, updatedAtMs DESC); CREATE INDEX IF NOT EXISTS idx_terminal_trades_mint_created ON terminalTradesLive(mint, createdAtMs DESC); CREATE INDEX IF NOT EXISTS idx_terminal_trades_created ON terminalTradesLive(createdAtMs DESC); CREATE INDEX IF NOT EXISTS idx_terminal_trades_signature ON terminalTradesLive(signature); CREATE INDEX IF NOT EXISTS idx_terminal_worker_errors_worker_created ON terminalWorkerErrors(worker, createdAtMs DESC); CREATE INDEX IF NOT EXISTS idx_terminal_ingestion_kind_seen ON terminalIngestionKeys(kind, seenAtMs);`,
  );
}
export function withWrite<T>(db: Database, fn: () => T): T {
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
export function rememberIngestionKey(
  db: Database,
  key: string,
  kind: string,
  now = Date.now(),
): boolean {
  db.query(
    "INSERT OR IGNORE INTO terminalIngestionKeys (key, kind, seenAtMs) VALUES (?, ?, ?)",
  ).run(key, kind, now);
  return (
    Number(
      db.query<{ changes: number }, []>("SELECT changes() as changes").get()
        ?.changes ?? 0,
    ) > 0
  );
}
export function pruneIngestionKeys(
  db: Database,
  kind: string,
  maxAgeMs: number,
  now = Date.now(),
): number {
  const cutoff = now - Math.max(60000, maxAgeMs);
  db.query(
    `DELETE FROM terminalIngestionKeys WHERE key IN (SELECT key FROM terminalIngestionKeys WHERE kind = ? AND seenAtMs < ? ORDER BY seenAtMs ASC LIMIT 50000)`,
  ).run(kind, cutoff);
  return Number(
    db.query<{ changes: number }, []>("SELECT changes() as changes").get()
      ?.changes ?? 0,
  );
}
export function recordWorkerError(
  db: Database,
  worker: string,
  error: unknown,
  data: Record<string, unknown> = {},
): void {
  const err = error instanceof Error ? error : new Error(String(error));
  db.query(
    `INSERT INTO terminalWorkerErrors (id, worker, message, stack, dataJson, createdAtMs) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    `${worker}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
    worker,
    err.message,
    err.stack ?? null,
    json(data),
    Date.now(),
  );
}
export function upsertProcessStatus(
  db: Database,
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
  const now = Date.now();
  const error =
    input.error == null
      ? null
      : input.error instanceof Error
        ? input.error.message
        : JSON.stringify(summarizeError(input.error));
  db.query(
    `INSERT INTO terminalProcessStatus (name, kind, status, heartbeatAtMs, pid, buildId, error, dataJson, updatedAtMs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET kind=excluded.kind, status=excluded.status, heartbeatAtMs=excluded.heartbeatAtMs, pid=excluded.pid, buildId=excluded.buildId, error=excluded.error, dataJson=excluded.dataJson, updatedAtMs=excluded.updatedAtMs`,
  ).run(
    input.name,
    input.kind,
    input.status,
    input.heartbeatAtMs ?? now,
    process.pid,
    input.buildId ?? null,
    error,
    json(input.data ?? {}),
    now,
  );
}
export function upsertCreate(
  db: Database,
  event: IndexedCreate,
  supplyUi: number,
): void {
  const now = Date.now();
  db.query(
    `INSERT INTO terminalTokensLive (mint, symbol, name, uri, creator, bondingCurveKey, source, phase, supplyUi, signature, rawJson, lastSlot, createdAtMs, updatedAtMs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mint) DO UPDATE SET symbol=COALESCE(NULLIF(excluded.symbol,''), terminalTokensLive.symbol), name=COALESCE(NULLIF(excluded.name,''), terminalTokensLive.name), uri=COALESCE(NULLIF(excluded.uri,''), terminalTokensLive.uri), creator=COALESCE(NULLIF(excluded.creator,''), terminalTokensLive.creator), bondingCurveKey=COALESCE(NULLIF(excluded.bondingCurveKey,''), terminalTokensLive.bondingCurveKey), source=excluded.source, phase=COALESCE(excluded.phase, terminalTokensLive.phase), supplyUi=COALESCE(excluded.supplyUi, terminalTokensLive.supplyUi), signature=COALESCE(excluded.signature, terminalTokensLive.signature), rawJson=COALESCE(NULLIF(excluded.rawJson,'{}'), terminalTokensLive.rawJson), lastSlot=COALESCE(excluded.lastSlot, terminalTokensLive.lastSlot), createdAtMs=COALESCE(terminalTokensLive.createdAtMs, excluded.createdAtMs), updatedAtMs=excluded.updatedAtMs`,
  ).run(
    event.mint,
    event.symbol ?? null,
    event.name ?? null,
    event.uri ?? null,
    event.creator ?? null,
    event.bondingCurveKey ?? null,
    "helius-indexer-create",
    "pump",
    supplyUi,
    event.signature,
    json(event.raw),
    event.slot,
    event.createdAtMs,
    now,
  );
}
export function insertTradeAndToken(
  db: Database,
  event: IndexedTrade,
  supplyUi: number,
): void {
  const now = Date.now();
  db.query(
    `INSERT INTO terminalTradesLive (id, mint, signature, slot, owner, side, tokenDeltaUi, solDeltaUi, priceSol, priceUsd, marketCapUsd, confidence, source, rawJson, createdAtMs, updatedAtMs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET priceSol=COALESCE(excluded.priceSol, terminalTradesLive.priceSol), priceUsd=COALESCE(excluded.priceUsd, terminalTradesLive.priceUsd), marketCapUsd=COALESCE(excluded.marketCapUsd, terminalTradesLive.marketCapUsd), confidence=excluded.confidence, source=excluded.source, rawJson=COALESCE(NULLIF(excluded.rawJson,'{}'), terminalTradesLive.rawJson), updatedAtMs=excluded.updatedAtMs`,
  ).run(
    event.id,
    event.mint,
    event.signature,
    event.slot,
    event.owner ?? null,
    event.side,
    event.tokenDeltaUi,
    event.solDeltaUi,
    event.priceSol,
    event.priceUsd,
    event.marketCapUsd,
    "processed",
    "helius-indexer-trade",
    json(event.raw),
    event.createdAtMs,
    now,
  );
  db.query(
    `INSERT INTO terminalTokensLive (mint, source, phase, supplyUi, priceSol, priceUsd, marketCapSol, marketCapUsd, initialMarketCapSol, initialMarketCapUsd, lastSlot, signature, rawJson, createdAtMs, updatedAtMs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mint) DO UPDATE SET source=excluded.source, phase=COALESCE(terminalTokensLive.phase, excluded.phase), supplyUi=COALESCE(terminalTokensLive.supplyUi, excluded.supplyUi), priceSol=COALESCE(excluded.priceSol, terminalTokensLive.priceSol), priceUsd=COALESCE(excluded.priceUsd, terminalTokensLive.priceUsd), marketCapSol=COALESCE(excluded.marketCapSol, terminalTokensLive.marketCapSol), marketCapUsd=COALESCE(excluded.marketCapUsd, terminalTokensLive.marketCapUsd), initialMarketCapSol=COALESCE(terminalTokensLive.initialMarketCapSol, excluded.initialMarketCapSol), initialMarketCapUsd=COALESCE(terminalTokensLive.initialMarketCapUsd, excluded.initialMarketCapUsd), lastSlot=COALESCE(excluded.lastSlot, terminalTokensLive.lastSlot), signature=COALESCE(excluded.signature, terminalTokensLive.signature), rawJson=COALESCE(NULLIF(excluded.rawJson,'{}'), terminalTokensLive.rawJson), createdAtMs=COALESCE(terminalTokensLive.createdAtMs, excluded.createdAtMs), updatedAtMs=excluded.updatedAtMs`,
  ).run(
    event.mint,
    "helius-indexer-trade",
    "pump",
    supplyUi,
    event.priceSol,
    event.priceUsd,
    event.marketCapSol,
    event.marketCapUsd,
    event.marketCapSol,
    event.marketCapUsd,
    event.slot,
    event.signature,
    json(event.raw),
    event.createdAtMs,
    now,
  );
}
export function upsertComplete(db: Database, event: IndexedComplete): void {
  db.query(
    `INSERT INTO terminalTokensLive (mint, bondingCurveKey, source, phase, lastSlot, signature, rawJson, createdAtMs, updatedAtMs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mint) DO UPDATE SET bondingCurveKey=COALESCE(NULLIF(excluded.bondingCurveKey,''), terminalTokensLive.bondingCurveKey), source=excluded.source, phase=excluded.phase, lastSlot=COALESCE(excluded.lastSlot, terminalTokensLive.lastSlot), signature=COALESCE(excluded.signature, terminalTokensLive.signature), rawJson=COALESCE(NULLIF(excluded.rawJson,'{}'), terminalTokensLive.rawJson), createdAtMs=COALESCE(terminalTokensLive.createdAtMs, excluded.createdAtMs), updatedAtMs=excluded.updatedAtMs`,
  ).run(
    event.mint,
    event.bondingCurveKey ?? null,
    "helius-indexer-complete",
    "migrated",
    event.slot,
    event.signature,
    json(event.raw),
    event.createdAtMs,
    Date.now(),
  );
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}
export function recomputeIndicators(
  db: Database,
  mint: string,
  now = Date.now(),
): void {
  const intervals = [60, 300, 900] as const;
  const oldestSince = now - Math.max(...intervals) * 1000;
  const trades = db
    .query<
      {
        createdAtMs: number;
        side: string | null;
        priceUsd: number | null;
        marketCapUsd: number | null;
        solDeltaUi: number | null;
      },
      [string, number]
    >(
      `SELECT createdAtMs, side, priceUsd, marketCapUsd, solDeltaUi FROM terminalTradesLive WHERE mint = ? AND createdAtMs >= ? AND priceUsd IS NOT NULL ORDER BY createdAtMs DESC`,
    )
    .all(mint, oldestSince);
  for (const intervalSec of intervals) {
    const since = now - intervalSec * 1000;
    const sample = trades.filter((r) => Number(r.createdAtMs) >= since);
    const marketCaps = sample
      .map((r) => Number(r.marketCapUsd))
      .filter(Number.isFinite);
    const prices = sample
      .map((r) => Number(r.priceUsd))
      .filter(Number.isFinite);
    const buyCount = sample.filter((r) => r.side === "buy").length;
    const sellCount = sample.filter((r) => r.side === "sell").length;
    const volumeSol = sample.reduce(
      (sum, r) => sum + Math.abs(Number(r.solDeltaUi ?? 0)),
      0,
    );
    const smaMarketCapUsd = marketCaps.length
      ? marketCaps.reduce((s, v) => s + v, 0) / marketCaps.length
      : null;
    const smaPriceUsd = prices.length
      ? prices.reduce((s, v) => s + v, 0) / prices.length
      : null;
    db.query(
      `INSERT INTO terminalIndicatorsLive (mint, intervalSec, smaMarketCapUsd, smaPriceUsd, medianMarketCapUsd, tradeCount, buyCount, sellCount, volumeSol, volumeUsd, updatedAtMs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mint, intervalSec) DO UPDATE SET smaMarketCapUsd=excluded.smaMarketCapUsd, smaPriceUsd=excluded.smaPriceUsd, medianMarketCapUsd=excluded.medianMarketCapUsd, tradeCount=excluded.tradeCount, buyCount=excluded.buyCount, sellCount=excluded.sellCount, volumeSol=excluded.volumeSol, volumeUsd=excluded.volumeUsd, updatedAtMs=excluded.updatedAtMs`,
    ).run(
      mint,
      intervalSec,
      smaMarketCapUsd,
      smaPriceUsd,
      median(marketCaps),
      sample.length,
      buyCount,
      sellCount,
      volumeSol,
      null,
      now,
    );
  }
}
