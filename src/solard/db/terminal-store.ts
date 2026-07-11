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
  description: z.string().nullable().default(null),
  website: z.string().nullable().default(null),
  twitter: z.string().nullable().default(null),
  telegram: z.string().nullable().default(null),
  creator: z.string().nullable().default(null),
  bondingCurveKey: z.string().nullable().default(null),
  source: z.string().default("unknown"),
  phase: z.enum(["pump", "migrated", "unknown"]).default("unknown"),
  isMayhemMode: z.number().default(0),
  quoteAsset: z.string().nullable().default(null),
  quoteMint: z.string().nullable().default(null),
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
    terminalTokensLive: TerminalTokenSchema,
    terminalTradesLive: TerminalTradeSchema,
    terminalIndicatorsLive: TerminalIndicatorSchema,
    processStatus: ProcessStatusSchema,
    workerCursors: WorkerCursorSchema,
    telegramSignals: TelegramSignalSchema,
  },
  {
    timestamps: false,
    softDeletes: false,
    reactive: false,
    unique: {
      terminalTokensLive: [["mint"]],
      terminalTradesLive: [["id"]],
      terminalIndicatorsLive: [["id"], ["mint", "intervalSec"]],
      processStatus: [["name"]],
      workerCursors: [["key"]],
      telegramSignals: [["id"]],
    },
    indexes: {
      terminalTokensLive: [
        "mint",
        "updatedAtMs",
        "marketCapUsd",
        "source",
        ["source", "updatedAtMs"],
        ["isMayhemMode", "updatedAtMs"],
      ],
      terminalTradesLive: [
        "id",
        "signature",
        "createdAtMs",
        "updatedAtMs",
        ["mint", "createdAtMs"],
      ],
      terminalIndicatorsLive: ["id", "updatedAtMs", ["mint", "intervalSec"]],
      processStatus: ["heartbeatAtMs"],
      workerCursors: ["key", "updatedAtMs"],
      telegramSignals: ["id", "receivedAtMs"],
    },
  },
);

let initialized = false;

function addColumnIfMissing(table: string, column: string, ddl: string): void {
  const rows = terminalDb.raw<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!rows.some((row) => row.name === column)) terminalDb.exec(ddl);
}

type PragmaColumn = { name: string; type?: string | null; pk?: number | null };

function tableColumns(table: string): PragmaColumn[] {
  return terminalDb.raw<PragmaColumn>(`PRAGMA table_info(${table})`);
}

function columnType(cols: PragmaColumn[], name: string): string {
  return String(
    cols.find((col) => col.name === name)?.type ?? "",
  ).toUpperCase();
}

function isTextColumn(cols: PragmaColumn[], name: string): boolean {
  return columnType(cols, name).includes("TEXT");
}

function safeBackupName(table: string): string {
  return `${table}_bad_${Date.now()}`;
}

function recreateIncompatibleTable(
  table: string,
  ddl: string,
  isCompatible: (columns: PragmaColumn[]) => boolean,
): void {
  const columns = tableColumns(table);
  if (!columns.length) {
    terminalDb.exec(ddl);
    return;
  }
  if (isCompatible(columns)) return;
  const backup = safeBackupName(table);
  terminalDb.exec(`ALTER TABLE ${table} RENAME TO ${backup}`);
  terminalDb.exec(ddl);
  upsertProcessStatus({
    name: "solard-db-schema",
    kind: "db",
    status: "migrated",
    data: { table, backup, reason: "incompatible live table schema" },
  });
}

function ensureTerminalLiveTables(): void {
  recreateIncompatibleTable(
    "terminalTokensLive",
    `CREATE TABLE IF NOT EXISTS terminalTokensLive (
      mint TEXT PRIMARY KEY,
      symbol TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      image TEXT,
      uri TEXT,
      description TEXT,
      website TEXT,
      twitter TEXT,
      telegram TEXT,
      creator TEXT,
      bondingCurveKey TEXT,
      source TEXT NOT NULL DEFAULT 'unknown',
      phase TEXT NOT NULL DEFAULT 'unknown',
      isMayhemMode INTEGER NOT NULL DEFAULT 0,
      quoteAsset TEXT,
      quoteMint TEXT,
      supplyUi REAL NOT NULL DEFAULT 1000000000,
      priceSol REAL,
      priceUsd REAL,
      marketCapSol REAL,
      marketCapUsd REAL,
      initialMarketCapUsd REAL,
      lastSlot INTEGER NOT NULL DEFAULT 0,
      signature TEXT,
      createdAtMs INTEGER NOT NULL DEFAULT 0,
      updatedAtMs INTEGER NOT NULL DEFAULT 0
    )`,
    (cols) => isTextColumn(cols, "mint"),
  );

  recreateIncompatibleTable(
    "terminalTradesLive",
    `CREATE TABLE IF NOT EXISTS terminalTradesLive (
      id TEXT PRIMARY KEY,
      mint TEXT NOT NULL,
      signature TEXT NOT NULL,
      slot INTEGER NOT NULL DEFAULT 0,
      owner TEXT,
      side TEXT NOT NULL DEFAULT 'unknown',
      tokenDeltaUi REAL NOT NULL DEFAULT 0,
      solDeltaUi REAL NOT NULL DEFAULT 0,
      priceSol REAL,
      priceUsd REAL,
      marketCapUsd REAL,
      confidence TEXT NOT NULL DEFAULT 'processed',
      source TEXT NOT NULL DEFAULT 'unknown',
      rawJson TEXT NOT NULL DEFAULT '{}',
      createdAtMs INTEGER NOT NULL DEFAULT 0,
      updatedAtMs INTEGER NOT NULL DEFAULT 0
    )`,
    (cols) =>
      isTextColumn(cols, "id") &&
      isTextColumn(cols, "mint") &&
      isTextColumn(cols, "signature"),
  );

  recreateIncompatibleTable(
    "terminalIndicatorsLive",
    `CREATE TABLE IF NOT EXISTS terminalIndicatorsLive (
      id TEXT NOT NULL,
      mint TEXT NOT NULL,
      intervalSec INTEGER NOT NULL,
      smaPriceUsd REAL,
      smaMarketCapUsd REAL,
      vwmaPriceUsd REAL,
      medianPriceUsd REAL,
      tradeCount INTEGER NOT NULL DEFAULT 0,
      volumeSol REAL NOT NULL DEFAULT 0,
      updatedAtMs INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (mint, intervalSec)
    )`,
    (cols) => isTextColumn(cols, "id") && isTextColumn(cols, "mint"),
  );
}

function finiteNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nullableFiniteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : null;
}

function finiteInteger(value: unknown, fallback = 0): number {
  const n = Math.trunc(finiteNumber(value, fallback));
  return Number.isSafeInteger(n) ? n : fallback;
}

function nullableText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value);
  return text.length ? text : null;
}

function requiredText(value: unknown, fallback = ""): string {
  const text = nullableText(value);
  return text ?? fallback;
}

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
      ensureTerminalLiveTables();
      addColumnIfMissing(
        "terminalTokensLive",
        "isMayhemMode",
        "ALTER TABLE terminalTokensLive ADD COLUMN isMayhemMode INTEGER DEFAULT 0",
      );
      addColumnIfMissing(
        "terminalTokensLive",
        "quoteAsset",
        "ALTER TABLE terminalTokensLive ADD COLUMN quoteAsset TEXT",
      );
      addColumnIfMissing(
        "terminalTokensLive",
        "quoteMint",
        "ALTER TABLE terminalTokensLive ADD COLUMN quoteMint TEXT",
      );
      terminalDb.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_tokens_live_mint ON terminalTokensLive(mint)",
      );
      terminalDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_terminal_tokens_live_updated ON terminalTokensLive(updatedAtMs DESC)",
      );
      terminalDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_terminal_tokens_live_mcap ON terminalTokensLive(marketCapUsd DESC)",
      );
      terminalDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_terminal_tokens_live_source ON terminalTokensLive(source)",
      );
      terminalDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_terminal_tokens_live_mayhem ON terminalTokensLive(isMayhemMode)",
      );
      terminalDb.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_trades_live_id ON terminalTradesLive(id)",
      );
      terminalDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_terminal_trades_live_mint_created ON terminalTradesLive(mint, createdAtMs DESC)",
      );
      terminalDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_terminal_trades_live_mint_priced_created ON terminalTradesLive(mint, createdAtMs DESC) WHERE priceUsd IS NOT NULL",
      );
      terminalDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_terminal_trades_live_sig ON terminalTradesLive(signature)",
      );
      terminalDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_terminal_trades_live_created ON terminalTradesLive(createdAtMs DESC)",
      );
      terminalDb.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_indicators_live_mint_interval ON terminalIndicatorsLive(mint, intervalSec)",
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

let terminalTransactionDepth = 0;

export function withTerminalDbTransaction<T>(fn: () => T): T {
  if (terminalTransactionDepth > 0) {
    terminalTransactionDepth++;
    try {
      return fn();
    } finally {
      terminalTransactionDepth--;
    }
  }

  terminalDb.exec("BEGIN IMMEDIATE");
  terminalTransactionDepth = 1;
  try {
    const result = fn();
    terminalDb.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      terminalDb.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors so the original error remains visible.
    }
    throw error;
  } finally {
    terminalTransactionDepth = 0;
  }
}

export async function dbWriteBatch<T>(label: string, fn: () => T): Promise<T> {
  return await dbWrite(label, () => withTerminalDbTransaction(fn));
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
  const existing = terminalDb.raw<Pick<ProcessStatus, "dataJson">>(
    "SELECT dataJson FROM processStatus WHERE name = ? LIMIT 1",
    input.name,
  )[0];
  const mergedData = {
    ...parseJson(existing?.dataJson ?? "{}", {}),
    ...(input.data ?? {}),
  };
  const row: ProcessStatus = {
    name: input.name,
    kind: input.kind,
    status: input.status,
    heartbeatAtMs: input.heartbeatAtMs ?? Date.now(),
    dataJson: json(mergedData),
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

export function clearTerminalLiveData(
  input: { source?: string | null; keepSignals?: boolean } = {},
): Record<string, unknown> {
  const source = String(input.source ?? "").toLowerCase();
  const matchPump = source.includes("pump");
  const matchHelius = source.includes("helius");
  const clearAll =
    !source || source.includes("both") || (!matchPump && !matchHelius);
  const tokenWhere = clearAll
    ? "1=1"
    : matchHelius
      ? "LOWER(source) LIKE '%helius%'"
      : "LOWER(source) LIKE '%pumpportal%' OR LOWER(source) = 'pump'";
  const tradeWhere = clearAll
    ? "1=1"
    : matchHelius
      ? "LOWER(source) LIKE '%helius%'"
      : "LOWER(source) LIKE '%pumpportal%' OR LOWER(source) = 'pump'";
  const before = terminalStoreStats();
  terminalDb.exec(
    `DELETE FROM terminalIndicatorsLive WHERE mint IN (SELECT mint FROM terminalTokensLive WHERE ${tokenWhere})`,
  );
  terminalDb.exec(`DELETE FROM terminalTradesLive WHERE ${tradeWhere}`);
  terminalDb.exec(`DELETE FROM terminalTokensLive WHERE ${tokenWhere}`);
  const after = terminalStoreStats();
  return { source: source || "all", before, after };
}

function cleanDisplayText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const lowered = text.toLowerCase();
  if (
    lowered === "-" ||
    lowered === "new token" ||
    lowered === "token" ||
    lowered === "unknown" ||
    lowered === "null" ||
    lowered === "undefined"
  )
    return null;
  return text;
}

function pickDisplayText(
  input: unknown,
  existing: unknown,
  fallback = "",
): string {
  return cleanDisplayText(input) ?? cleanDisplayText(existing) ?? fallback;
}

function pickNullableText(input: unknown, existing: unknown): string | null {
  return cleanDisplayText(input) ?? cleanDisplayText(existing);
}

export function upsertTerminalToken(
  input: Partial<TerminalToken> & { mint: string },
): TerminalToken {
  const now = Date.now();

  const row: TerminalToken = {
    mint: requiredText(input.mint),
    symbol: cleanDisplayText(input.symbol) ?? "",
    name: cleanDisplayText(input.name) ?? "",
    image: cleanDisplayText(input.image),
    uri: cleanDisplayText(input.uri),
    description: nullableText((input as any).description),
    website: nullableText((input as any).website),
    twitter: nullableText((input as any).twitter),
    telegram: nullableText((input as any).telegram),
    creator: nullableText(input.creator),
    bondingCurveKey: nullableText(input.bondingCurveKey),
    source: requiredText(input.source, "unknown"),
    phase: (input.phase ?? "unknown") as TerminalToken["phase"],
    isMayhemMode: finiteInteger((input as any).isMayhemMode ?? 0, 0),
    quoteAsset: nullableText((input as any).quoteAsset),
    quoteMint: nullableText((input as any).quoteMint),
    supplyUi: finiteNumber(input.supplyUi ?? 1_000_000_000, 1_000_000_000),
    priceSol: nullableFiniteNumber(input.priceSol),
    priceUsd: nullableFiniteNumber(input.priceUsd),
    marketCapSol: nullableFiniteNumber(input.marketCapSol),
    marketCapUsd: nullableFiniteNumber(input.marketCapUsd),
    initialMarketCapUsd: nullableFiniteNumber(
      input.initialMarketCapUsd ?? input.marketCapUsd,
    ),
    lastSlot: finiteInteger(input.lastSlot ?? 0, 0),
    signature: nullableText(input.signature),
    createdAtMs: finiteInteger(input.createdAtMs ?? now, now),
    updatedAtMs: finiteInteger(input.updatedAtMs ?? now, now),
  };

  return terminalDb.terminalTokensLive.upsertOnConflict(row, "mint", (t) => ({
    symbol: t.excludedIfNotEmpty("symbol"),
    name: t.excludedIfNotEmpty("name"),
    image: t.excludedIfNotEmpty("image"),
    uri: t.excludedIfNotEmpty("uri"),

    description: t.excludedIfNotNull("description"),
    website: t.excludedIfNotNull("website"),
    twitter: t.excludedIfNotNull("twitter"),
    telegram: t.excludedIfNotNull("telegram"),

    creator: t.excluded("creator"),
    bondingCurveKey: t.excluded("bondingCurveKey"),
    source: t.excluded("source"),
    phase: t.excluded("phase"),

    isMayhemMode: t.max("isMayhemMode"),

    quoteAsset: t.excludedIfNotNull("quoteAsset"),
    quoteMint: t.excludedIfNotNull("quoteMint"),

    supplyUi: t.excluded("supplyUi"),

    priceSol: t.excludedIfNotNull("priceSol"),
    priceUsd: t.excludedIfNotNull("priceUsd"),
    marketCapSol: t.excludedIfNotNull("marketCapSol"),
    marketCapUsd: t.excludedIfNotNull("marketCapUsd"),

    initialMarketCapUsd: t.keepFirst("initialMarketCapUsd"),

    lastSlot: t.max("lastSlot"),
    signature: t.excludedIfNotNull("signature"),
    createdAtMs: t.keepFirst("createdAtMs"),
    updatedAtMs: t.excluded("updatedAtMs"),
  })) as TerminalToken;
}

export function insertTerminalTrade(
  input: Partial<TerminalTrade> & {
    id: string;
    mint: string;
    signature: string;
  },
): TerminalTrade {
  const now = Date.now();
  const side =
    input.side === "buy" || input.side === "sell" ? input.side : "unknown";
  const parsedConfidence = ConfidenceSchema.safeParse(input.confidence);
  const confidenceValue: TerminalConfidence = parsedConfidence.success
    ? parsedConfidence.data
    : "processed";

  const row: TerminalTrade = {
    id: requiredText(input.id),
    mint: requiredText(input.mint),
    signature: requiredText(input.signature),
    slot: finiteInteger(input.slot ?? 0, 0),
    owner: nullableText(input.owner),
    side,
    tokenDeltaUi: finiteNumber(input.tokenDeltaUi ?? 0, 0),
    solDeltaUi: finiteNumber(input.solDeltaUi ?? 0, 0),
    priceSol: nullableFiniteNumber(input.priceSol),
    priceUsd: nullableFiniteNumber(input.priceUsd),
    marketCapUsd: nullableFiniteNumber(input.marketCapUsd),
    confidence: confidenceValue,
    source: requiredText(input.source, "unknown"),
    rawJson:
      typeof input.rawJson === "string"
        ? input.rawJson
        : json(input.rawJson ?? {}),
    createdAtMs: finiteInteger(input.createdAtMs ?? now, now),
    updatedAtMs: finiteInteger(input.updatedAtMs ?? now, now),
  };

  return terminalDb.terminalTradesLive.upsertOnConflict(row, "id", (t) => ({
    mint: t.excluded("mint"),
    signature: t.excluded("signature"),
    slot: t.max("slot"),
    owner: t.excludedIfNotNull("owner"),
    side: t.excluded("side"),
    tokenDeltaUi: t.excluded("tokenDeltaUi"),
    solDeltaUi: t.excluded("solDeltaUi"),
    priceSol: t.excludedIfNotNull("priceSol"),
    priceUsd: t.excludedIfNotNull("priceUsd"),
    marketCapUsd: t.excludedIfNotNull("marketCapUsd"),
    confidence: t.excluded("confidence"),
    source: t.excluded("source"),
    rawJson: t.excludedIfNotEmpty("rawJson"),
    createdAtMs: t.keepFirst("createdAtMs"),
    updatedAtMs: t.excluded("updatedAtMs"),
  })) as TerminalTrade;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

const TERMINAL_INDICATOR_INTERVALS = [
  60, 300, 900, 3600, 21600, 86400,
] as const;

type IndicatorTradeRow = Pick<
  TerminalTrade,
  "createdAtMs" | "priceUsd" | "marketCapUsd" | "solDeltaUi" | "tokenDeltaUi"
>;

function computeTerminalIndicatorsForMint(
  mint: string,
  now = Date.now(),
): TerminalIndicator[] {
  const token = terminalDb.raw<TerminalToken>(
    "SELECT * FROM terminalTokensLive WHERE mint = ? LIMIT 1",
    mint,
  )[0];
  const maxIntervalSec = TERMINAL_INDICATOR_INTERVALS.at(-1) ?? 86400;
  const oldestSince = now - maxIntervalSec * 1000;
  const pricedTrades = terminalDb.raw<IndicatorTradeRow>(
    `SELECT createdAtMs, priceUsd, marketCapUsd, solDeltaUi, tokenDeltaUi
     FROM terminalTradesLive
     WHERE mint = ? AND createdAtMs >= ? AND priceUsd IS NOT NULL
     ORDER BY createdAtMs DESC`,
    mint,
    oldestSince,
  );

  return TERMINAL_INDICATOR_INTERVALS.map((intervalSec) => {
    const since = now - intervalSec * 1000;
    const trades = pricedTrades.filter(
      (row) => Number(row.createdAtMs || 0) >= since,
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
    return {
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
  });
}

function writeTerminalIndicators(
  indicators: readonly TerminalIndicator[],
): void {
  for (const indicator of indicators) {
    terminalDb.terminalIndicatorsLive.upsertOnConflict(
      indicator,
      "id",
      (t) => ({
        mint: t.excluded("mint"),
        intervalSec: t.excluded("intervalSec"),
        smaPriceUsd: t.excludedIfNotNull("smaPriceUsd"),
        smaMarketCapUsd: t.excludedIfNotNull("smaMarketCapUsd"),
        vwmaPriceUsd: t.excludedIfNotNull("vwmaPriceUsd"),
        medianPriceUsd: t.excludedIfNotNull("medianPriceUsd"),
        tradeCount: t.excluded("tradeCount"),
        volumeSol: t.excluded("volumeSol"),
        updatedAtMs: t.excluded("updatedAtMs"),
      }),
    );
  }
}

export function recomputeTerminalIndicators(
  mint: string,
  now = Date.now(),
): TerminalIndicator[] {
  const indicators = computeTerminalIndicatorsForMint(mint, now);
  withTerminalDbTransaction(() => writeTerminalIndicators(indicators));
  return indicators;
}

export function recomputeTerminalIndicatorsBatch(
  mints: Iterable<string>,
  now = Date.now(),
): TerminalIndicator[] {
  const uniqueMints = [
    ...new Set([...mints].map((mint) => mint.trim())),
  ].filter(Boolean);
  const out: TerminalIndicator[] = [];
  withTerminalDbTransaction(() => {
    for (const mint of uniqueMints) {
      const indicators = computeTerminalIndicatorsForMint(mint, now);
      writeTerminalIndicators(indicators);
      out.push(...indicators);
    }
  });
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
  lastTradeAtMs?: number | null;
  latestTradeUpdatedAtMs?: number | null;
  priceUpdatedAtMs?: number | null;
  priceAgeMs?: number | null;
};

function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function feedSourceMatches(value: unknown, source: string): boolean {
  if (!source || source.includes("both")) return true;

  const text = String(value ?? "").toLowerCase();
  if (!text) return false;

  if (source.includes("helius")) {
    return text.includes("helius") || text.startsWith("telegram");
  }

  if (source.includes("pump")) {
    return (
      text.includes("pumpportal") ||
      text === "pump" ||
      text.startsWith("telegram")
    );
  }

  return true;
}

function tokenPassesFeedFilters(
  token: TerminalToken,
  args: {
    includeUnpriced: boolean;
    hideMayhem?: boolean;
    hideUsdc?: boolean;
  },
): boolean {
  if (
    !args.includeUnpriced &&
    !String(token.source ?? "")
      .toLowerCase()
      .startsWith("telegram") &&
    token.marketCapUsd == null &&
    token.priceUsd == null &&
    !token.image
  ) {
    return false;
  }

  if (args.hideMayhem && Number((token as any).isMayhemMode ?? 0) !== 0) {
    return false;
  }

  if (args.hideUsdc) {
    const quoteAsset = String((token as any).quoteAsset ?? "").toLowerCase();
    const quoteMint = String((token as any).quoteMint ?? "").toLowerCase();
    if (
      quoteAsset === "usdc" ||
      quoteMint.includes("epjfwdd5aufqssqem2qn1xzybapc8g4wegkgzwydt1v")
    ) {
      return false;
    }
  }

  return true;
}

function latestTradeTime(trade: TerminalTrade | undefined): number {
  if (!trade) return 0;
  return Math.max(
    Number(trade.createdAtMs || 0),
    Number(trade.updatedAtMs || 0),
  );
}

function tradeHasPrice(trade: TerminalTrade | undefined): boolean {
  return Boolean(
    trade &&
    (trade.marketCapUsd != null ||
      trade.priceUsd != null ||
      trade.priceSol != null),
  );
}

function listLatestPricedTrade(mint: string): TerminalTrade | undefined {
  return terminalDb.raw<TerminalTrade>(
    `SELECT * FROM terminalTradesLive
     WHERE mint = ?
       AND (marketCapUsd IS NOT NULL OR priceUsd IS NOT NULL OR priceSol IS NOT NULL)
     ORDER BY createdAtMs DESC, updatedAtMs DESC
     LIMIT 1`,
    mint,
  )[0];
}

export function listTerminalFeed(
  args: {
    limit?: number;
    sinceMs?: number;
    activeWindowMs?: number;
    includeUnpriced?: boolean;
    source?: string | null;
    hideMayhem?: boolean;
    hideUsdc?: boolean;
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
  const source = String(args.source ?? "").toLowerCase();

  /**
   * Keep this endpoint fast and deterministic.
   *
   * The terminal UI polls this function on page load. Avoid correlated EXISTS,
   * LOWER(source) filters, ORDER BY subqueries, and exact COUNT(*) work here.
   * Those are the kind of queries that can look fine on small DBs and then hang
   * the entire page under Helius bursts or a large terminalTradesLive table.
   */
  const candidateLimit = Math.min(5000, Math.max(limit * 12, limit + 64));
  const tradeScanLimit = Math.min(5000, Math.max(limit * 24, limit + 128));

  const latestTradeByMint = new Map<string, TerminalTrade>();
  const candidateMints = new Set<string>();

  const recentTrades = terminalDb.raw<TerminalTrade>(
    `SELECT * FROM terminalTradesLive
     WHERE updatedAtMs >= ?
     ORDER BY updatedAtMs DESC
     LIMIT ?`,
    minUpdatedAt,
    tradeScanLimit,
  );

  for (const trade of recentTrades) {
    if (!trade.mint || !feedSourceMatches(trade.source, source)) continue;
    const previous = latestTradeByMint.get(trade.mint);
    if (!previous || latestTradeTime(trade) > latestTradeTime(previous)) {
      latestTradeByMint.set(trade.mint, trade);
    }
    candidateMints.add(trade.mint);
  }

  const tokenRows = terminalDb.raw<TerminalToken>(
    `SELECT * FROM terminalTokensLive
     WHERE updatedAtMs >= ?
     ORDER BY updatedAtMs DESC
     LIMIT ?`,
    minUpdatedAt,
    candidateLimit,
  );

  const tokensByMint = new Map<string, TerminalToken>();
  for (const token of tokenRows) {
    if (!token.mint) continue;
    if (
      !feedSourceMatches(token.source, source) &&
      !candidateMints.has(token.mint)
    ) {
      continue;
    }
    if (
      !tokenPassesFeedFilters(token, {
        includeUnpriced,
        hideMayhem: args.hideMayhem,
        hideUsdc: args.hideUsdc,
      })
    ) {
      continue;
    }
    tokensByMint.set(token.mint, token);
    candidateMints.add(token.mint);
  }

  const missingMints = [...candidateMints].filter(
    (mint) => !tokensByMint.has(mint),
  );
  for (let i = 0; i < missingMints.length; i += 250) {
    const chunk = missingMints.slice(i, i + 250);
    if (!chunk.length) continue;
    const fetched = terminalDb.raw<TerminalToken>(
      `SELECT * FROM terminalTokensLive WHERE mint IN (${sqlPlaceholders(chunk.length)})`,
      ...chunk,
    );
    for (const token of fetched) {
      if (!token.mint) continue;
      if (
        !tokenPassesFeedFilters(token, {
          includeUnpriced,
          hideMayhem: args.hideMayhem,
          hideUsdc: args.hideUsdc,
        })
      ) {
        continue;
      }
      tokensByMint.set(token.mint, token);
    }
  }

  const sortedTokens = [...tokensByMint.values()]
    .filter((token) => {
      const latestTrade = latestTradeByMint.get(token.mint);
      return (
        feedSourceMatches(token.source, source) ||
        feedSourceMatches(latestTrade?.source, source)
      );
    })
    .sort((a, b) => {
      const aTime = Math.max(
        Number(a.updatedAtMs || 0),
        latestTradeTime(latestTradeByMint.get(a.mint)),
      );
      const bTime = Math.max(
        Number(b.updatedAtMs || 0),
        latestTradeTime(latestTradeByMint.get(b.mint)),
      );
      return bTime - aTime;
    })
    .slice(0, limit);

  const mints = sortedTokens.map((token) => token.mint).filter(Boolean);
  const indicatorsByMint = new Map<string, TerminalIndicator[]>();
  if (mints.length) {
    const indicators = terminalDb.raw<TerminalIndicator>(
      `SELECT * FROM terminalIndicatorsLive WHERE mint IN (${sqlPlaceholders(mints.length)})`,
      ...mints,
    );
    for (const indicator of indicators) {
      const list = indicatorsByMint.get(indicator.mint) ?? [];
      list.push(indicator);
      indicatorsByMint.set(indicator.mint, list);
    }
  }

  const exactCounts = process.env.SOLARD_TERMINAL_FEED_EXACT_COUNTS === "1";
  const exactTradeCounts = new Map<string, number>();
  if (exactCounts && mints.length) {
    const counts = terminalDb.raw<{ mint: string; count: number }>(
      `SELECT mint, COUNT(*) as count
       FROM terminalTradesLive
       WHERE mint IN (${sqlPlaceholders(mints.length)})
       GROUP BY mint`,
      ...mints,
    );
    for (const row of counts)
      exactTradeCounts.set(row.mint, Number(row.count || 0));
  }

  return sortedTokens.map((token) => {
    const indicators = indicatorsByMint.get(token.mint) ?? [];
    const byInterval = new Map<number, TerminalIndicator>(
      indicators.map(
        (row) => [row.intervalSec, row] as [number, TerminalIndicator],
      ),
    );

    const latestRecentTrade = latestTradeByMint.get(token.mint);
    const latestPricedTrade = tradeHasPrice(latestRecentTrade)
      ? latestRecentTrade
      : listLatestPricedTrade(token.mint);
    const latestTradeAtMs = latestRecentTrade
      ? latestTradeTime(latestRecentTrade)
      : latestPricedTrade
        ? latestTradeTime(latestPricedTrade)
        : null;
    const latestPricedTradeAtMs = latestPricedTrade
      ? latestTradeTime(latestPricedTrade)
      : null;
    const liveMarketCapUsd =
      latestPricedTrade?.marketCapUsd ?? token.marketCapUsd ?? null;
    const livePriceUsd = latestPricedTrade?.priceUsd ?? token.priceUsd ?? null;
    const livePriceSol = latestPricedTrade?.priceSol ?? token.priceSol ?? null;
    const priceUpdatedAtMs =
      latestPricedTradeAtMs ??
      (liveMarketCapUsd != null || livePriceUsd != null || livePriceSol != null
        ? Number(token.updatedAtMs || 0) || null
        : null);
    const liveUpdatedAtMs = Math.max(
      Number(token.updatedAtMs || 0),
      Number(latestTradeAtMs || 0),
      Number(latestPricedTradeAtMs || 0),
    );
    const indicatorTradeCount =
      byInterval.get(86400)?.tradeCount ??
      byInterval.get(21600)?.tradeCount ??
      byInterval.get(3600)?.tradeCount ??
      byInterval.get(900)?.tradeCount ??
      byInterval.get(300)?.tradeCount ??
      byInterval.get(60)?.tradeCount ??
      0;

    return {
      ...token,
      priceSol: livePriceSol,
      priceUsd: livePriceUsd,
      marketCapUsd: liveMarketCapUsd,
      marketCapSol:
        latestPricedTrade?.priceSol != null
          ? latestPricedTrade.priceSol * Number(token.supplyUi ?? 1_000_000_000)
          : (token.marketCapSol ?? null),
      updatedAtMs: liveUpdatedAtMs || token.updatedAtMs,
      lastTradeAtMs: latestTradeAtMs,
      latestTradeUpdatedAtMs: latestTradeAtMs,
      priceUpdatedAtMs,
      priceAgeMs: priceUpdatedAtMs
        ? Math.max(0, Date.now() - priceUpdatedAtMs)
        : null,
      kind: token.source.startsWith("telegram") ? "signal" : "pump",
      sma1m: byInterval.get(60)?.smaMarketCapUsd ?? liveMarketCapUsd,
      sma5m: byInterval.get(300)?.smaMarketCapUsd ?? liveMarketCapUsd,
      sma15m: byInterval.get(900)?.smaMarketCapUsd ?? liveMarketCapUsd,
      tradeCount:
        exactTradeCounts.get(token.mint) ?? Number(indicatorTradeCount),
    };
  });
}

export function listTerminalTrades(
  args: {
    limit?: number;
    sinceMs?: number;
    mint?: string | null;
    source?: string | null;
  } = {},
): TerminalTrade[] {
  const limit = Math.max(1, Math.min(args.limit ?? 250, 1000));
  const since = args.sinceMs ?? 0;
  const source = String(args.source ?? "").toLowerCase();
  const sourceClause =
    source.includes("both") || !source
      ? "1=1"
      : source.includes("helius")
        ? "LOWER(source) LIKE '%helius%'"
        : "LOWER(source) LIKE '%pumpportal%' OR LOWER(source) = 'pump'";
  if (args.mint) {
    return terminalDb.raw<TerminalTrade>(
      `SELECT * FROM terminalTradesLive
       WHERE mint = ? AND createdAtMs >= ? AND ${sourceClause}
       ORDER BY createdAtMs DESC
       LIMIT ?`,
      args.mint,
      since,
      limit,
    );
  }
  return terminalDb.raw<TerminalTrade>(
    `SELECT * FROM terminalTradesLive
     WHERE createdAtMs >= ? AND ${sourceClause}
     ORDER BY createdAtMs DESC
     LIMIT ?`,
    since,
    limit,
  );
}

export type TerminalCurveSnapshotCandidate = Pick<
  TerminalToken,
  | "mint"
  | "bondingCurveKey"
  | "supplyUi"
  | "marketCapUsd"
  | "priceUsd"
  | "updatedAtMs"
  | "source"
  | "phase"
>;

export function listTerminalCurveSnapshotCandidates(
  args: {
    limit?: number;
    source?: string | null;
    activeWindowMs?: number;
    includeMigrated?: boolean;
  } = {},
): TerminalCurveSnapshotCandidate[] {
  const limit = Math.max(1, Math.min(args.limit ?? 80, 500));
  const activeWindowMs = Math.max(
    0,
    args.activeWindowMs ??
      Number(process.env.SOLARD_CURVE_SNAPSHOT_ACTIVE_WINDOW_MS ?? "900000"),
  );
  const minUpdatedAt = activeWindowMs > 0 ? Date.now() - activeWindowMs : 0;
  const source = String(args.source ?? "").toLowerCase();
  const sourceClause =
    source.includes("both") || !source
      ? "1=1"
      : source.includes("helius")
        ? "LOWER(source) LIKE '%helius%'"
        : "LOWER(source) LIKE '%pumpportal%' OR LOWER(source) = 'pump'";
  const phaseClause = args.includeMigrated
    ? "1=1"
    : "LOWER(COALESCE(phase, 'pump')) != 'migrated'";
  return terminalDb.raw<TerminalCurveSnapshotCandidate>(
    `SELECT mint, bondingCurveKey, supplyUi, marketCapUsd, priceUsd, updatedAtMs, source, phase
     FROM terminalTokensLive
     WHERE mint IS NOT NULL
       AND mint != ''
       AND updatedAtMs >= ?
       AND ${sourceClause}
       AND ${phaseClause}
     ORDER BY updatedAtMs DESC
     LIMIT ?`,
    minUpdatedAt,
    limit,
  );
}

export function applyTerminalCurveSnapshot(input: {
  mint: string;
  bondingCurveKey?: string | null;
  priceSol: number | null;
  priceUsd: number | null;
  marketCapSol: number | null;
  marketCapUsd: number | null;
  realTokenReservesUi?: number | null;
  realSolReservesUi?: number | null;
  virtualTokenReservesUi?: number | null;
  virtualSolReservesUi?: number | null;
  progressPct?: number | null;
  complete?: boolean | null;
  creator?: string | null;
  source?: string | null;
  slot?: number | null;
  now?: number;
}): TerminalToken {
  const now = input.now ?? Date.now();
  const rawSource = String(input.source ?? "curve-snapshot");
  const token = upsertTerminalToken({
    mint: input.mint,
    bondingCurveKey: input.bondingCurveKey ?? undefined,
    creator: input.creator ?? undefined,
    source: rawSource,
    phase: input.complete ? "migrated" : "pump",
    priceSol: input.priceSol ?? undefined,
    priceUsd: input.priceUsd ?? undefined,
    marketCapSol: input.marketCapSol ?? undefined,
    marketCapUsd: input.marketCapUsd ?? undefined,
    lastSlot: input.slot ?? undefined,
    updatedAtMs: now,
  });

  upsertProcessStatus({
    name: "solard-curve-snapshot-last",
    kind: "snapshot",
    status: input.complete ? "complete" : "updated",
    data: {
      mint: input.mint,
      bondingCurveKey: input.bondingCurveKey ?? null,
      source: rawSource,
      priceSol: input.priceSol,
      priceUsd: input.priceUsd,
      marketCapSol: input.marketCapSol,
      marketCapUsd: input.marketCapUsd,
      realTokenReservesUi: input.realTokenReservesUi ?? null,
      realSolReservesUi: input.realSolReservesUi ?? null,
      virtualTokenReservesUi: input.virtualTokenReservesUi ?? null,
      virtualSolReservesUi: input.virtualSolReservesUi ?? null,
      progressPct: input.progressPct ?? null,
      complete: input.complete ?? null,
    },
  });
  return token;
}

export function pendingTradeSignatures(limit = 100): string[] {
  return terminalDb
    .raw<{ signature: string }>(
      `SELECT DISTINCT signature FROM terminalTradesLive
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
    "UPDATE terminalTradesLive SET confidence = ?, updatedAtMs = ? WHERE signature = ?",
    confidence,
    Date.now(),
    signature,
  );
}

export function listTerminalTokensNeedingMetadata(
  limit = 20,
): Array<
  Pick<
    TerminalToken,
    "mint" | "uri" | "name" | "symbol" | "image" | "updatedAtMs"
  >
> {
  const capped = Math.max(1, Math.min(limit, 100));
  return terminalDb.raw(
    `SELECT mint, uri, name, symbol, image, updatedAtMs
     FROM terminalTokensLive
     WHERE mint IS NOT NULL
       AND mint != ''
       AND (
         image IS NULL OR image = ''
         OR name IS NULL OR name = '' OR LOWER(name) IN ('-', 'token', 'new token', 'unknown')
         OR symbol IS NULL OR symbol = '' OR LOWER(symbol) IN ('-', 'token', 'unknown')
       )
     ORDER BY updatedAtMs DESC
     LIMIT ?`,
    capped,
  );
}

export function insertTerminalProbeRow(
  input: { source?: string | null; now?: number } = {},
): Record<string, unknown> {
  const now = input.now ?? Date.now();
  const sourceText = String(input.source ?? "pumpportal")
    .toLowerCase()
    .includes("helius")
    ? "helius-probe"
    : "pumpportal-probe";
  const mint = sourceText.includes("helius")
    ? "So11111111111111111111111111111111111111112"
    : "11111111111111111111111111111111";
  const marketCapUsd = sourceText.includes("helius") ? 43210 : 32100;
  const token = upsertTerminalToken({
    mint,
    symbol: sourceText.includes("helius") ? "H-PROBE" : "P-PROBE",
    name: sourceText.includes("helius")
      ? "Helius probe row"
      : "PumpPortal probe row",
    source: sourceText,
    phase: "pump",
    priceUsd: marketCapUsd / 1_000_000_000,
    marketCapUsd,
    initialMarketCapUsd: marketCapUsd,
    signature: `probe-${sourceText}-${now}`,
    createdAtMs: now,
    updatedAtMs: now,
  });
  const trade = insertTerminalTrade({
    id: `probe:${sourceText}:${now}`,
    mint,
    signature: `probe-${sourceText}-${now}`,
    source: sourceText,
    side: "buy",
    solDeltaUi: 0.01,
    tokenDeltaUi: 1,
    priceUsd: token.priceUsd,
    marketCapUsd,
    createdAtMs: now,
    updatedAtMs: now,
  });
  recomputeTerminalIndicators(mint, now);
  return { token, trade };
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
          "SELECT COUNT(*) as count FROM terminalTokensLive",
        )[0]?.count ?? 0,
      ),
      activeTokens: Number(
        terminalDb.raw<{ count: number }>(
          "SELECT COUNT(*) as count FROM terminalTokensLive WHERE updatedAtMs >= ?",
          Date.now() -
            Number(process.env.SOLARD_TERMINAL_ACTIVE_WINDOW_MS ?? "1200000"),
        )[0]?.count ?? 0,
      ),
      pricedTokens: Number(
        terminalDb.raw<{ count: number }>(
          "SELECT COUNT(*) as count FROM terminalTokensLive WHERE marketCapUsd IS NOT NULL OR priceUsd IS NOT NULL",
        )[0]?.count ?? 0,
      ),
      imagedTokens: Number(
        terminalDb.raw<{ count: number }>(
          "SELECT COUNT(*) as count FROM terminalTokensLive WHERE image IS NOT NULL AND image != ''",
        )[0]?.count ?? 0,
      ),
      trades: Number(
        terminalDb.raw<{ count: number }>(
          "SELECT COUNT(*) as count FROM terminalTradesLive",
        )[0]?.count ?? 0,
      ),
      indicators: Number(
        terminalDb.raw<{ count: number }>(
          "SELECT COUNT(*) as count FROM terminalIndicatorsLive",
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
          "SELECT MAX(updatedAtMs) as latest FROM terminalTokensLive",
        )[0]?.latest ?? null,
      bySource: terminalDb.raw<{
        source: string;
        tokens: number;
        priced: number;
        images: number;
        latest: number | null;
      }>(
        `SELECT source, COUNT(*) as tokens,
                SUM(CASE WHEN marketCapUsd IS NOT NULL OR priceUsd IS NOT NULL THEN 1 ELSE 0 END) as priced,
                SUM(CASE WHEN image IS NOT NULL AND image != '' THEN 1 ELSE 0 END) as images,
                MAX(updatedAtMs) as latest
         FROM terminalTokensLive
         GROUP BY source
         ORDER BY latest DESC
         LIMIT 20`,
      ),
    }),
  );
}
