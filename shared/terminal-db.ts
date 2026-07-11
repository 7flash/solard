import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database, z } from "sqlite-zod-orm";

const DEFAULT_DB_PATH = join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".sowl",
  "sowl.sqlite",
);

/**
 * One database path for the server, app API, and standalone indexer.
 *
 * Do not add an indexer-specific fallback. Separate processes get separate
 * SQLite connections, but every connection must point at this same file.
 */
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
export type WorkerCursor = z.infer<typeof WorkerCursorSchema>;
export type TelegramSignal = z.infer<typeof TelegramSignalSchema>;

export const terminalDb = new Database(
  SOLARD_DB_PATH,
  {
    /**
     * Live terminal tables are created explicitly below.
     *
     * Older sqlite-zod-orm versions can reserve integer `id` shapes. The live
     * trade table uses TEXT ids, so the ORM owns only the ordinary keyed tables
     * while raw SQL owns the high-volume live tables.
     */
    processStatus: ProcessStatusSchema,
    workerCursors: WorkerCursorSchema,
    telegramSignals: TelegramSignalSchema,
  },
  {
    timestamps: false,
    softDeletes: false,
    reactive: false,
    unique: {
      processStatus: [["name"]],
      workerCursors: [["key"]],
      telegramSignals: [["id"]],
    },
  },
);

export type TerminalDatabase = typeof terminalDb;

let initialized = false;

function tableColumns(table: string): Set<string> {
  return new Set(
    terminalDb
      .raw<{ name: string }>(`PRAGMA table_info(${table})`)
      .map((row) => row.name),
  );
}

function addColumnIfMissing(
  table: string,
  column: string,
  definition: string,
): void {
  if (!tableColumns(table).has(column)) {
    terminalDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * Idempotent schema boot shared by both the web process and indexer process.
 */
export function ensureSharedTerminalDb(): void {
  if (initialized) return;
  initialized = true;

  terminalDb.exec("PRAGMA journal_mode=WAL");
  terminalDb.exec("PRAGMA synchronous=NORMAL");
  terminalDb.exec("PRAGMA busy_timeout=5000");

  terminalDb.exec(`
    CREATE TABLE IF NOT EXISTS terminalTokensLive (
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
    )
  `);

  terminalDb.exec(`
    CREATE TABLE IF NOT EXISTS terminalTradesLive (
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
    )
  `);

  terminalDb.exec(`
    CREATE TABLE IF NOT EXISTS terminalIndicatorsLive (
      id TEXT PRIMARY KEY,
      mint TEXT NOT NULL,
      intervalSec INTEGER NOT NULL,
      smaPriceUsd REAL,
      smaMarketCapUsd REAL,
      vwmaPriceUsd REAL,
      medianPriceUsd REAL,
      tradeCount INTEGER NOT NULL DEFAULT 0,
      volumeSol REAL NOT NULL DEFAULT 0,
      updatedAtMs INTEGER NOT NULL DEFAULT 0
    )
  `);

  terminalDb.exec(`
    CREATE TABLE IF NOT EXISTS terminalIngestionKeys (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      seenAtMs INTEGER NOT NULL
    )
  `);

  terminalDb.exec(`
    CREATE TABLE IF NOT EXISTS terminalWorkerErrors (
      id TEXT PRIMARY KEY,
      worker TEXT NOT NULL,
      message TEXT NOT NULL,
      stack TEXT,
      dataJson TEXT NOT NULL DEFAULT '{}',
      createdAtMs INTEGER NOT NULL
    )
  `);

  addColumnIfMissing(
    "terminalTokensLive",
    "isMayhemMode",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing("terminalTokensLive", "quoteAsset", "TEXT");
  addColumnIfMissing("terminalTokensLive", "quoteMint", "TEXT");

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
  terminalDb.exec(
    "CREATE INDEX IF NOT EXISTS idx_terminal_ingestion_kind_seen ON terminalIngestionKeys(kind, seenAtMs DESC)",
  );
  terminalDb.exec(
    "CREATE INDEX IF NOT EXISTS idx_terminal_worker_errors_worker_created ON terminalWorkerErrors(worker, createdAtMs DESC)",
  );
}

ensureSharedTerminalDb();
