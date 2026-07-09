import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database, z } from "sqlite-zod-orm";
import { dbMeasure, measureRetry, summarizeForMeasure } from "../measure.js";

const DEFAULT_DB_PATH = join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".sowl",
  "sowl.sqlite",
);

export const SOLARD_DB_PATH =
  process.env.SOLARD_DB_PATH || process.env.SOWL_DB_PATH || DEFAULT_DB_PATH;

mkdirSync(dirname(SOLARD_DB_PATH), { recursive: true });

export const ConfidenceSchema = z.enum([
  "processed",
  "confirmed",
  "finalized",
  "dropped",
]);
export type TerminalConfidence = z.infer<typeof ConfidenceSchema>;

export const TerminalTokenSchema = z.object({
  mint: z.string(),
  symbol: z.string().default(""),
  name: z.string().default(""),
  image: z.string().nullable().default(null),
  uri: z.string().nullable().default(null),
  creator: z.string().nullable().default(null),
  bondingCurveKey: z.string().nullable().default(null),
  source: z.string().default("unknown"),
  phase: z.enum(["pump", "migrated", "unknown"]).default("unknown"),
  supplyUi: z.number().default(1_000_000_000),
  priceSol: z.number().nullable().default(null),
  priceUsd: z.number().nullable().default(null),
  marketCapSol: z.number().nullable().default(null),
  marketCapUsd: z.number().nullable().default(null),
  initialMarketCapUsd: z.number().nullable().default(null),
  lastSlot: z.number().default(0),
  signature: z.string().nullable().default(null),
  createdAtMs: z.number().default(0),
  updatedAtMs: z.number().default(0),
});

export const TerminalTradeSchema = z.object({
  id: z.string(),
  mint: z.string(),
  signature: z.string(),
  slot: z.number().default(0),
  owner: z.string().nullable().default(null),
  side: z.enum(["buy", "sell", "unknown"]).default("unknown"),
  tokenDeltaUi: z.number().default(0),
  solDeltaUi: z.number().default(0),
  priceSol: z.number().nullable().default(null),
  priceUsd: z.number().nullable().default(null),
  marketCapUsd: z.number().nullable().default(null),
  confidence: ConfidenceSchema.default("processed"),
  source: z.string().default("unknown"),
  rawJson: z.string().default("{}"),
  createdAtMs: z.number().default(0),
  updatedAtMs: z.number().default(0),
});

export const TerminalIndicatorSchema = z.object({
  id: z.string(),
  mint: z.string(),
  intervalSec: z.number(),
  smaPriceUsd: z.number().nullable().default(null),
  smaMarketCapUsd: z.number().nullable().default(null),
  vwmaPriceUsd: z.number().nullable().default(null),
  medianPriceUsd: z.number().nullable().default(null),
  tradeCount: z.number().default(0),
  volumeSol: z.number().default(0),
  updatedAtMs: z.number().default(0),
});

export const ProcessStatusSchema = z.object({
  name: z.string(),
  kind: z.string(),
  status: z.string(),
  heartbeatAtMs: z.number(),
  dataJson: z.string().default("{}"),
  error: z.string().nullable().default(null),
});

export const WorkerCursorSchema = z.object({
  key: z.string(),
  value: z.string().default(""),
  updatedAtMs: z.number().default(0),
});

export const TelegramSignalSchema = z.object({
  id: z.string(),
  sourceId: z.string().nullable().default(null),
  sourceName: z.string().nullable().default(null),
  chatRef: z.string().nullable().default(null),
  text: z.string().default(""),
  mintsJson: z.string().default("[]"),
  symbolsJson: z.string().default("[]"),
  urlsJson: z.string().default("[]"),
  status: z.string().default("new"),
  receivedAtMs: z.number().default(0),
  rawJson: z.string().default("{}"),
});

export type TerminalToken = z.infer<typeof TerminalTokenSchema>;
export type TerminalTrade = z.infer<typeof TerminalTradeSchema>;
export type TerminalIndicator = z.infer<typeof TerminalIndicatorSchema>;
export type ProcessStatus = z.infer<typeof ProcessStatusSchema>;
export type TelegramSignal = z.infer<typeof TelegramSignalSchema>;

export const terminalDb = new Database(
  SOLARD_DB_PATH,
  {
    terminalTokens: TerminalTokenSchema,
    terminalTrades: TerminalTradeSchema,
    terminalIndicators: TerminalIndicatorSchema,
    processStatus: ProcessStatusSchema,
    workerCursors: WorkerCursorSchema,
    telegramSignals: TelegramSignalSchema,
  },
  {
    timestamps: false,
    softDeletes: false,
    reactive: false,
    unique: {
      terminalTokens: [["mint"]],
      terminalTrades: [["id"]],
      terminalIndicators: [["mint", "intervalSec"]],
      processStatus: [["name"]],
      workerCursors: [["key"]],
      telegramSignals: [["id"]],
    },
  },
);

let initialized = false;

export function initTerminalStore(): void {
  if (initialized) return;
  initialized = true;
  dbMeasure.measureSync(
    {
      start: () => `init terminal sqlite ${SOLARD_DB_PATH}`,
      end: () => "ready",
    },
    () => {
      terminalDb.exec("PRAGMA journal_mode=WAL");
      terminalDb.exec("PRAGMA synchronous=NORMAL");
      terminalDb.exec("PRAGMA busy_timeout=5000");
      terminalDb.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_tokens_mint ON terminalTokens(mint)",
      );
      terminalDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_terminal_tokens_updated ON terminalTokens(updatedAtMs DESC)",
      );
      terminalDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_terminal_tokens_mcap ON terminalTokens(marketCapUsd DESC)",
      );
      terminalDb.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_trades_id ON terminalTrades(id)",
      );
      terminalDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_terminal_trades_mint_created ON terminalTrades(mint, createdAtMs DESC)",
      );
      terminalDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_terminal_trades_sig ON terminalTrades(signature)",
      );
      terminalDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_terminal_trades_created ON terminalTrades(createdAtMs DESC)",
      );
      terminalDb.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_indicators_mint_interval ON terminalIndicators(mint, intervalSec)",
      );
      terminalDb.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_process_status_name ON processStatus(name)",
      );
      terminalDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_process_status_heartbeat ON processStatus(heartbeatAtMs DESC)",
      );
      terminalDb.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_cursors_key ON workerCursors(key)",
      );
      terminalDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_telegram_signals_received ON telegramSignals(receivedAtMs DESC)",
      );
    },
  );
}

initTerminalStore();

export async function dbWrite<T>(label: string, fn: () => T): Promise<T> {
  return await measureRetry(
    `db.${label}`,
    { attempts: 5, delay: 20, backoff: 2 },
    async () => fn(),
  );
}

function json(value: unknown): string {
  return JSON.stringify(value, (_, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function upsertProcessStatus(input: {
  name: string;
  kind: string;
  status: string;
  data?: Record<string, unknown>;
  error?: unknown;
  heartbeatAtMs?: number;
}): void {
  const row: ProcessStatus = {
    name: input.name,
    kind: input.kind,
    status: input.status,
    heartbeatAtMs: input.heartbeatAtMs ?? Date.now(),
    dataJson: json(input.data ?? {}),
    error:
      input.error == null
        ? null
        : input.error instanceof Error
          ? input.error.message
          : String(input.error),
  };
  terminalDb.exec(
    `INSERT INTO processStatus (name, kind, status, heartbeatAtMs, dataJson, error)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       kind=excluded.kind,
       status=excluded.status,
       heartbeatAtMs=excluded.heartbeatAtMs,
       dataJson=excluded.dataJson,
       error=excluded.error`,
    row.name,
    row.kind,
    row.status,
    row.heartbeatAtMs,
    row.dataJson,
    row.error,
  );
}

export function listProcessStatus(): Array<
  ProcessStatus & { data: Record<string, unknown> }
> {
  return terminalDb
    .raw<ProcessStatus>(
      "SELECT * FROM processStatus ORDER BY heartbeatAtMs DESC",
    )
    .map((row) => ({ ...row, data: parseJson(row.dataJson, {}) }));
}

export function getCursor(key: string): string | null {
  const row = terminalDb.raw<{ value: string }>(
    "SELECT value FROM workerCursors WHERE key = ? LIMIT 1",
    key,
  )[0];
  return row?.value ?? null;
}

export function setCursor(key: string, value: string): void {
  terminalDb.exec(
    `INSERT INTO workerCursors (key, value, updatedAtMs)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAtMs=excluded.updatedAtMs`,
    key,
    value,
    Date.now(),
  );
}

export function upsertTerminalToken(
  input: Partial<TerminalToken> & { mint: string },
): TerminalToken {
  const now = Date.now();
  const existing = terminalDb.raw<TerminalToken>(
    "SELECT * FROM terminalTokens WHERE mint = ? LIMIT 1",
    input.mint,
  )[0];
  const row: TerminalToken = {
    mint: input.mint,
    symbol: input.symbol ?? existing?.symbol ?? "",
    name: input.name ?? existing?.name ?? "",
    image: input.image ?? existing?.image ?? null,
    uri: input.uri ?? existing?.uri ?? null,
    creator: input.creator ?? existing?.creator ?? null,
    bondingCurveKey: input.bondingCurveKey ?? existing?.bondingCurveKey ?? null,
    source: input.source ?? existing?.source ?? "unknown",
    phase: input.phase ?? existing?.phase ?? "pump",
    supplyUi: input.supplyUi ?? existing?.supplyUi ?? 1_000_000_000,
    priceSol: input.priceSol ?? existing?.priceSol ?? null,
    priceUsd: input.priceUsd ?? existing?.priceUsd ?? null,
    marketCapSol: input.marketCapSol ?? existing?.marketCapSol ?? null,
    marketCapUsd: input.marketCapUsd ?? existing?.marketCapUsd ?? null,
    initialMarketCapUsd:
      existing?.initialMarketCapUsd ??
      input.initialMarketCapUsd ??
      input.marketCapUsd ??
      null,
    lastSlot: input.lastSlot ?? existing?.lastSlot ?? 0,
    signature: input.signature ?? existing?.signature ?? null,
    createdAtMs: existing?.createdAtMs ?? input.createdAtMs ?? now,
    updatedAtMs: input.updatedAtMs ?? now,
  };
  terminalDb.exec(
    `INSERT INTO terminalTokens (mint, symbol, name, image, uri, creator, bondingCurveKey, source, phase, supplyUi, priceSol, priceUsd, marketCapSol, marketCapUsd, initialMarketCapUsd, lastSlot, signature, createdAtMs, updatedAtMs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET
       symbol=excluded.symbol,
       name=excluded.name,
       image=excluded.image,
       uri=excluded.uri,
       creator=excluded.creator,
       bondingCurveKey=excluded.bondingCurveKey,
       source=excluded.source,
       phase=excluded.phase,
       supplyUi=excluded.supplyUi,
       priceSol=COALESCE(excluded.priceSol, terminalTokens.priceSol),
       priceUsd=COALESCE(excluded.priceUsd, terminalTokens.priceUsd),
       marketCapSol=COALESCE(excluded.marketCapSol, terminalTokens.marketCapSol),
       marketCapUsd=COALESCE(excluded.marketCapUsd, terminalTokens.marketCapUsd),
       initialMarketCapUsd=COALESCE(terminalTokens.initialMarketCapUsd, excluded.initialMarketCapUsd),
       lastSlot=MAX(terminalTokens.lastSlot, excluded.lastSlot),
       signature=COALESCE(excluded.signature, terminalTokens.signature),
       updatedAtMs=excluded.updatedAtMs`,
    row.mint,
    row.symbol,
    row.name,
    row.image,
    row.uri,
    row.creator,
    row.bondingCurveKey,
    row.source,
    row.phase,
    row.supplyUi,
    row.priceSol,
    row.priceUsd,
    row.marketCapSol,
    row.marketCapUsd,
    row.initialMarketCapUsd,
    row.lastSlot,
    row.signature,
    row.createdAtMs,
    row.updatedAtMs,
  );
  return row;
}

export function insertTerminalTrade(
  input: Partial<TerminalTrade> & {
    id: string;
    mint: string;
    signature: string;
  },
): TerminalTrade {
  const now = Date.now();
  const row: TerminalTrade = {
    id: input.id,
    mint: input.mint,
    signature: input.signature,
    slot: input.slot ?? 0,
    owner: input.owner ?? null,
    side: input.side ?? "unknown",
    tokenDeltaUi: input.tokenDeltaUi ?? 0,
    solDeltaUi: input.solDeltaUi ?? 0,
    priceSol: input.priceSol ?? null,
    priceUsd: input.priceUsd ?? null,
    marketCapUsd: input.marketCapUsd ?? null,
    confidence: input.confidence ?? "processed",
    source: input.source ?? "unknown",
    rawJson: input.rawJson ?? "{}",
    createdAtMs: input.createdAtMs ?? now,
    updatedAtMs: input.updatedAtMs ?? now,
  };
  terminalDb.exec(
    `INSERT INTO terminalTrades (id, mint, signature, slot, owner, side, tokenDeltaUi, solDeltaUi, priceSol, priceUsd, marketCapUsd, confidence, source, rawJson, createdAtMs, updatedAtMs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       confidence=excluded.confidence,
       updatedAtMs=excluded.updatedAtMs`,
    row.id,
    row.mint,
    row.signature,
    row.slot,
    row.owner,
    row.side,
    row.tokenDeltaUi,
    row.solDeltaUi,
    row.priceSol,
    row.priceUsd,
    row.marketCapUsd,
    row.confidence,
    row.source,
    row.rawJson,
    row.createdAtMs,
    row.updatedAtMs,
  );
  return row;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

export function recomputeTerminalIndicators(
  mint: string,
  now = Date.now(),
): TerminalIndicator[] {
  const intervals = [60, 300, 900, 3600, 21600, 86400];
  const token = terminalDb.raw<TerminalToken>(
    "SELECT * FROM terminalTokens WHERE mint = ? LIMIT 1",
    mint,
  )[0];
  const out: TerminalIndicator[] = [];
  for (const intervalSec of intervals) {
    const since = now - intervalSec * 1000;
    const trades = terminalDb.raw<TerminalTrade>(
      `SELECT * FROM terminalTrades
       WHERE mint = ? AND createdAtMs >= ? AND priceUsd IS NOT NULL
       ORDER BY createdAtMs DESC`,
      mint,
      since,
    );
    const tradeCount = trades.length;
    const volumeSol = trades.reduce(
      (sum, row) => sum + Number(row.solDeltaUi || 0),
      0,
    );
    const sumPrice = trades.reduce(
      (sum, row) => sum + Number(row.priceUsd || 0),
      0,
    );
    const weighted = trades.reduce(
      (sum, row) =>
        sum +
        Number(row.priceUsd || 0) * Math.max(0, Number(row.tokenDeltaUi || 0)),
      0,
    );
    const volumeTokenUi = trades.reduce(
      (sum, row) => sum + Math.max(0, Number(row.tokenDeltaUi || 0)),
      0,
    );
    const smaPriceUsd =
      tradeCount > 0 ? sumPrice / tradeCount : (token?.priceUsd ?? null);
    const vwmaPriceUsd =
      volumeTokenUi > 0 ? weighted / volumeTokenUi : (token?.priceUsd ?? null);
    const med =
      median(
        trades
          .map((row) => Number(row.priceUsd))
          .filter((value) => Number.isFinite(value) && value > 0),
      ) ??
      token?.priceUsd ??
      null;
    const indicator: TerminalIndicator = {
      id: `${mint}:${intervalSec}`,
      mint,
      intervalSec,
      smaPriceUsd,
      smaMarketCapUsd:
        smaPriceUsd != null
          ? smaPriceUsd * Number(token?.supplyUi ?? 1_000_000_000)
          : (token?.marketCapUsd ?? null),
      vwmaPriceUsd,
      medianPriceUsd: med,
      tradeCount,
      volumeSol,
      updatedAtMs: now,
    };
    terminalDb.exec(
      `INSERT INTO terminalIndicators (id, mint, intervalSec, smaPriceUsd, smaMarketCapUsd, vwmaPriceUsd, medianPriceUsd, tradeCount, volumeSol, updatedAtMs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mint, intervalSec) DO UPDATE SET
         smaPriceUsd=excluded.smaPriceUsd,
         smaMarketCapUsd=excluded.smaMarketCapUsd,
         vwmaPriceUsd=excluded.vwmaPriceUsd,
         medianPriceUsd=excluded.medianPriceUsd,
         tradeCount=excluded.tradeCount,
         volumeSol=excluded.volumeSol,
         updatedAtMs=excluded.updatedAtMs`,
      indicator.id,
      indicator.mint,
      indicator.intervalSec,
      indicator.smaPriceUsd,
      indicator.smaMarketCapUsd,
      indicator.vwmaPriceUsd,
      indicator.medianPriceUsd,
      indicator.tradeCount,
      indicator.volumeSol,
      indicator.updatedAtMs,
    );
    out.push(indicator);
  }
  return out;
}

export type TerminalFeedRow = TerminalToken & {
  kind: "pump" | "signal";
  signalText?: string | null;
  signalSource?: string | null;
  sma1m?: number | null;
  sma5m?: number | null;
  sma15m?: number | null;
  tradeCount?: number;
};

export function listTerminalFeed(
  args: {
    limit?: number;
    sinceMs?: number;
    activeWindowMs?: number;
    includeUnpriced?: boolean;
  } = {},
): TerminalFeedRow[] {
  const limit = Math.max(1, Math.min(args.limit ?? 250, 1000));
  const activeWindowMs = Math.max(
    0,
    args.activeWindowMs ??
      Number(process.env.SOLARD_TERMINAL_ACTIVE_WINDOW_MS ?? "1200000"),
  );
  const minUpdatedAt = Math.max(
    args.sinceMs ?? 0,
    activeWindowMs > 0 ? Date.now() - activeWindowMs : 0,
  );
  const includeUnpriced =
    args.includeUnpriced === true ||
    process.env.SOLARD_TERMINAL_INCLUDE_UNPRICED === "1";
  const tokens = includeUnpriced
    ? terminalDb.raw<TerminalToken>(
        `SELECT * FROM terminalTokens
         WHERE updatedAtMs >= ?
         ORDER BY updatedAtMs DESC
         LIMIT ?`,
        minUpdatedAt,
        limit,
      )
    : terminalDb.raw<TerminalToken>(
        `SELECT * FROM terminalTokens
         WHERE updatedAtMs >= ?
           AND (
             source LIKE 'telegram%'
             OR marketCapUsd IS NOT NULL
             OR priceUsd IS NOT NULL
             OR image IS NOT NULL
           )
         ORDER BY updatedAtMs DESC
         LIMIT ?`,
        minUpdatedAt,
        limit,
      );
  return tokens.map((token) => {
    const indicators = terminalDb.raw<TerminalIndicator>(
      "SELECT * FROM terminalIndicators WHERE mint = ?",
      token.mint,
    );
    const byInterval = new Map(indicators.map((row) => [row.intervalSec, row]));
    const tradeCount =
      terminalDb.raw<{ count: number }>(
        "SELECT COUNT(*) as count FROM terminalTrades WHERE mint = ?",
        token.mint,
      )[0]?.count ?? 0;
    return {
      ...token,
      kind: token.source.startsWith("telegram") ? "signal" : "pump",
      sma1m: byInterval.get(60)?.smaMarketCapUsd ?? token.marketCapUsd ?? null,
      sma5m: byInterval.get(300)?.smaMarketCapUsd ?? token.marketCapUsd ?? null,
      sma15m:
        byInterval.get(900)?.smaMarketCapUsd ?? token.marketCapUsd ?? null,
      tradeCount: Number(tradeCount),
    };
  });
}

export function listTerminalTrades(
  args: { limit?: number; sinceMs?: number; mint?: string | null } = {},
): TerminalTrade[] {
  const limit = Math.max(1, Math.min(args.limit ?? 250, 1000));
  const since = args.sinceMs ?? 0;
  if (args.mint) {
    return terminalDb.raw<TerminalTrade>(
      `SELECT * FROM terminalTrades
       WHERE mint = ? AND createdAtMs >= ?
       ORDER BY createdAtMs DESC
       LIMIT ?`,
      args.mint,
      since,
      limit,
    );
  }
  return terminalDb.raw<TerminalTrade>(
    `SELECT * FROM terminalTrades
     WHERE createdAtMs >= ?
     ORDER BY createdAtMs DESC
     LIMIT ?`,
    since,
    limit,
  );
}

export function pendingTradeSignatures(limit = 100): string[] {
  return terminalDb
    .raw<{ signature: string }>(
      `SELECT DISTINCT signature FROM terminalTrades
       WHERE confidence IN ('processed', 'confirmed')
       ORDER BY updatedAtMs ASC
       LIMIT ?`,
      limit,
    )
    .map((row) => row.signature)
    .filter(Boolean);
}

export function updateTradeConfidence(
  signature: string,
  confidence: TerminalConfidence,
): void {
  terminalDb.exec(
    "UPDATE terminalTrades SET confidence = ?, updatedAtMs = ? WHERE signature = ?",
    confidence,
    Date.now(),
    signature,
  );
}

export function upsertTelegramSignal(input: {
  id: string;
  sourceId?: string | null;
  sourceName?: string | null;
  chatRef?: string | null;
  text: string;
  mints: string[];
  symbols?: string[];
  urls?: string[];
  raw?: Record<string, unknown> | null;
  receivedAtMs?: number;
}): TelegramSignal {
  const row: TelegramSignal = {
    id: input.id,
    sourceId: input.sourceId ?? null,
    sourceName: input.sourceName ?? null,
    chatRef: input.chatRef ?? null,
    text: input.text,
    mintsJson: json(input.mints),
    symbolsJson: json(input.symbols ?? []),
    urlsJson: json(input.urls ?? []),
    status: "new",
    receivedAtMs: input.receivedAtMs ?? Date.now(),
    rawJson: json(input.raw ?? {}),
  };
  terminalDb.exec(
    `INSERT INTO telegramSignals (id, sourceId, sourceName, chatRef, text, mintsJson, symbolsJson, urlsJson, status, receivedAtMs, rawJson)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status=excluded.status,
       receivedAtMs=excluded.receivedAtMs,
       rawJson=excluded.rawJson`,
    row.id,
    row.sourceId,
    row.sourceName,
    row.chatRef,
    row.text,
    row.mintsJson,
    row.symbolsJson,
    row.urlsJson,
    row.status,
    row.receivedAtMs,
    row.rawJson,
  );
  for (const mint of input.mints) {
    upsertTerminalToken({
      mint,
      symbol: input.symbols?.[0] ?? "",
      name: input.symbols?.[0] ?? "telegram signal",
      source: "telegram-signal",
      updatedAtMs: row.receivedAtMs,
    });
  }
  return row;
}

export function listTelegramSignals(
  limit = 100,
): Array<
  TelegramSignal & { mints: string[]; symbols: string[]; urls: string[] }
> {
  return terminalDb
    .raw<TelegramSignal>(
      "SELECT * FROM telegramSignals ORDER BY receivedAtMs DESC LIMIT ?",
      limit,
    )
    .map((row) => ({
      ...row,
      mints: parseJson<string[]>(row.mintsJson, []),
      symbols: parseJson<string[]>(row.symbolsJson, []),
      urls: parseJson<string[]>(row.urlsJson, []),
    }));
}

export function terminalStoreStats(): Record<string, unknown> {
  return dbMeasure.measureSync(
    {
      start: () => "terminal store stats",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    () => ({
      dbPath: SOLARD_DB_PATH,
      tokens: Number(
        terminalDb.raw<{ count: number }>(
          "SELECT COUNT(*) as count FROM terminalTokens",
        )[0]?.count ?? 0,
      ),
      activeTokens: Number(
        terminalDb.raw<{ count: number }>(
          "SELECT COUNT(*) as count FROM terminalTokens WHERE updatedAtMs >= ?",
          Date.now() -
            Number(process.env.SOLARD_TERMINAL_ACTIVE_WINDOW_MS ?? "1200000"),
        )[0]?.count ?? 0,
      ),
      pricedTokens: Number(
        terminalDb.raw<{ count: number }>(
          "SELECT COUNT(*) as count FROM terminalTokens WHERE marketCapUsd IS NOT NULL OR priceUsd IS NOT NULL",
        )[0]?.count ?? 0,
      ),
      imagedTokens: Number(
        terminalDb.raw<{ count: number }>(
          "SELECT COUNT(*) as count FROM terminalTokens WHERE image IS NOT NULL AND image != ''",
        )[0]?.count ?? 0,
      ),
      trades: Number(
        terminalDb.raw<{ count: number }>(
          "SELECT COUNT(*) as count FROM terminalTrades",
        )[0]?.count ?? 0,
      ),
      indicators: Number(
        terminalDb.raw<{ count: number }>(
          "SELECT COUNT(*) as count FROM terminalIndicators",
        )[0]?.count ?? 0,
      ),
      signals: Number(
        terminalDb.raw<{ count: number }>(
          "SELECT COUNT(*) as count FROM telegramSignals",
        )[0]?.count ?? 0,
      ),
      processes: Number(
        terminalDb.raw<{ count: number }>(
          "SELECT COUNT(*) as count FROM processStatus",
        )[0]?.count ?? 0,
      ),
      latestUpdatedAtMs:
        terminalDb.raw<{ latest: number }>(
          "SELECT MAX(updatedAtMs) as latest FROM terminalTokens",
        )[0]?.latest ?? null,
    }),
  );
}
