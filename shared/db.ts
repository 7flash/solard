import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Database, defineView, z } from "sqlite-zod-orm";

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || ".";
const RENAMED_DEFAULT_DB_PATH = join(HOME_DIR, ".solard", "solard.sqlite");
export const SOLARD_LEGACY_DB_PATH = join(HOME_DIR, ".sowl", "sowl.sqlite");

/**
 * New installations use ~/.solard/solard.sqlite. Existing installations keep
 * using the legacy file until SOLARD_DB_PATH is set or the file is migrated, so
 * this change never silently starts an empty database.
 */
const DEFAULT_DB_PATH =
  !existsSync(RENAMED_DEFAULT_DB_PATH) && existsSync(SOLARD_LEGACY_DB_PATH)
    ? SOLARD_LEGACY_DB_PATH
    : RENAMED_DEFAULT_DB_PATH;

export const SOLARD_DB_PATH =
  process.env.SOLARD_DB_PATH || process.env.SOWL_DB_PATH || DEFAULT_DB_PATH;

mkdirSync(dirname(SOLARD_DB_PATH), {
  recursive: true,
});

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

  isMayhemMode: z.coerce.number().default(0),

  /**
   * Zero means unknown. A positive timestamp means the Pump bonding-curve
   * account was decoded (or the upstream source explicitly supplied the flag).
   */
  mayhemCheckedAtMs: z.coerce.number().default(0),

  quoteAsset: z.string().nullable().default(null),
  quoteMint: z.string().nullable().default(null),

  supplyUi: z.coerce.number().default(1_000_000_000),

  priceSol: z.coerce.number().nullable().default(null),
  priceUsd: z.coerce.number().nullable().default(null),

  marketCapSol: z.coerce.number().nullable().default(null),
  marketCapUsd: z.coerce.number().nullable().default(null),

  initialMarketCapUsd: z.coerce.number().nullable().default(null),

  lastSlot: z.coerce.number().default(0),
  signature: z.string().nullable().default(null),

  createdAtMs: z.coerce.number().default(0),

  /**
   * Feed membership timestamp.
   *
   * This is set only by a token create/discovery path. A trade by itself does
   * not make an arbitrary historical token eligible for the Terminal feed.
   */
  observedAtMs: z.coerce.number().default(0),

  priceUpdatedAtMs: z.coerce.number().default(0),
  updatedAtMs: z.coerce.number().default(0),
});

export const TokenTradeSchema = z.object({
  eventKey: z.string(),

  mint: z.string(),
  signature: z.string(),
  slot: z.coerce.number().default(0),

  owner: z.string().nullable().default(null),

  side: z.enum(["buy", "sell", "unknown"]).default("unknown"),

  tokenDeltaUi: z.coerce.number().default(0),
  solDeltaUi: z.coerce.number().default(0),

  priceSol: z.coerce.number().nullable().default(null),
  priceUsd: z.coerce.number().nullable().default(null),
  marketCapUsd: z.coerce.number().nullable().default(null),

  confidence: z
    .enum(["processed", "confirmed", "finalized", "dropped"])
    .default("processed"),

  source: z.string().default("unknown"),
  rawJson: z.string().default("{}"),

  tradedAtMs: z.coerce.number(),
  updatedAtMs: z.coerce.number(),
});

export const WatchedWalletSchema = z.object({
  address: z.string(),
  label: z.string().nullable().default(null),
  enabled: z.coerce.number().default(1),
  backfillEnabled: z.coerce.number().default(1),
  lastBackfillSignature: z.string().nullable().default(null),
  lastBackfillAtMs: z.coerce.number().default(0),
  lastSeenSlot: z.coerce.number().default(0),
  createdAtMs: z.coerce.number(),
  updatedAtMs: z.coerce.number(),
});

export const WalletTransactionSchema = z.object({
  walletTxKey: z.string(),
  wallet: z.string(),
  signature: z.string(),
  slot: z.coerce.number().default(0),
  confidence: z
    .enum(["processed", "confirmed", "finalized", "dropped"])
    .default("confirmed"),
  parseStatus: z
    .enum(["pending", "parsed", "ignored", "error"])
    .default("pending"),
  parserVersion: z.string().default("wallet-v1"),
  rawJson: z.string().default("{}"),
  error: z.string().nullable().default(null),
  tradedAtMs: z.coerce.number().default(0),
  updatedAtMs: z.coerce.number().default(0),
});

export const WalletSwapSchema = z.object({
  eventKey: z.string(),
  wallet: z.string(),
  signature: z.string(),
  slot: z.coerce.number().default(0),

  inputMint: z.string(),
  inputAmountUi: z.coerce.number().default(0),
  outputMint: z.string(),
  outputAmountUi: z.coerce.number().default(0),

  subjectMint: z.string(),
  quoteMint: z.string().nullable().default(null),
  side: z.enum(["buy", "sell", "swap", "unknown"]).default("unknown"),

  venue: z.string().default("unknown"),
  programId: z.string().nullable().default(null),
  parser: z.string().default("unknown"),
  classificationConfidence: z
    .enum(["exact", "inferred", "ambiguous"])
    .default("ambiguous"),
  copyable: z.coerce.number().default(0),

  priceSol: z.coerce.number().nullable().default(null),
  priceUsd: z.coerce.number().nullable().default(null),
  marketCapUsd: z.coerce.number().nullable().default(null),

  rawJson: z.string().default("{}"),
  tradedAtMs: z.coerce.number().default(0),
  updatedAtMs: z.coerce.number().default(0),
});

export const CopyTradeProfileSchema = z.object({
  profileKey: z.string(),
  leaderWallet: z.string(),
  followerRef: z.string(),
  label: z.string().nullable().default(null),

  enabled: z.coerce.number().default(1),
  mode: z.enum(["paper", "live"]).default("paper"),
  copyBuys: z.coerce.number().default(1),
  copySells: z.coerce.number().default(1),

  buySizing: z.enum(["fixed", "leader-ratio"]).default("fixed"),
  fixedBuyAmountUi: z.coerce.number().default(0.05),
  leaderScaleBps: z.coerce.number().default(10_000),
  maxBuyAmountUi: z.coerce.number().default(1),
  sellBalanceBps: z.coerce.number().default(10_000),

  slippageBps: z.coerce.number().default(500),
  maxEventAgeMs: z.coerce.number().default(30_000),

  // Terminal-style token and market filters.
  requirePriceData: z.coerce.number().default(1),
  allowMayhem: z.coerce.number().default(0),
  minMarketCapUsd: z.coerce.number().nullable().default(null),
  maxMarketCapUsd: z.coerce.number().nullable().default(null),
  maxPriceAgeMs: z.coerce.number().nullable().default(null),
  minTokenAgeMs: z.coerce.number().nullable().default(null),
  maxTokenAgeMs: z.coerce.number().nullable().default(null),
  minHolders: z.coerce.number().nullable().default(null),
  minTrades1m: z.coerce.number().nullable().default(null),
  minTrades5m: z.coerce.number().nullable().default(null),
  minTrades15m: z.coerce.number().nullable().default(null),
  minVolumeSol1m: z.coerce.number().nullable().default(null),
  minVolumeSol5m: z.coerce.number().nullable().default(null),
  minVolumeSol15m: z.coerce.number().nullable().default(null),
  minLeaderQuoteAmountUi: z.coerce.number().nullable().default(null),
  maxLeaderQuoteAmountUi: z.coerce.number().nullable().default(null),

  allowedMintsJson: z.string().default("[]"),
  blockedMintsJson: z.string().default("[]"),
  allowedQuoteMintsJson: z.string().default("[]"),
  allowedPhasesJson: z.string().default("[]"),
  allowedVenuesJson: z.string().default("[]"),
  allowedParsersJson: z.string().default("[]"),

  createdAtMs: z.coerce.number(),
  updatedAtMs: z.coerce.number(),
});

export const CopyTradeIntentSchema = z.object({
  intentKey: z.string(),
  profileKey: z.string(),
  leaderEventKey: z.string(),
  leaderWallet: z.string(),
  followerRef: z.string(),

  sourceSignature: z.string(),
  sourceSlot: z.coerce.number().default(0),
  sourceTradedAtMs: z.coerce.number().default(0),

  side: z.enum(["buy", "sell"]).default("buy"),
  inputMint: z.string(),
  outputMint: z.string(),
  subjectMint: z.string(),
  quoteMint: z.string().nullable().default(null),

  amountKind: z.enum(["exact-input-ui", "balance-bps"]),
  amountUi: z.coerce.number().nullable().default(null),
  balanceBps: z.coerce.number().nullable().default(null),
  slippageBps: z.coerce.number().default(500),

  mode: z.enum(["paper", "live"]).default("paper"),
  status: z
    .enum(["queued", "paper", "sending", "sent", "skipped", "failed"])
    .default("queued"),
  reason: z.string().nullable().default(null),

  attempts: z.coerce.number().default(0),
  nextAttemptAtMs: z.coerce.number().default(0),
  executionSignature: z.string().nullable().default(null),
  requestJson: z.string().default("{}"),
  resultJson: z.string().default("{}"),

  createdAtMs: z.coerce.number(),
  updatedAtMs: z.coerce.number(),
});

export const ProcessStatusSchema = z.object({
  name: z.string(),
  kind: z.string(),
  status: z.string(),

  heartbeatAtMs: z.coerce.number(),
  pid: z.coerce.number().default(0),
  buildId: z.string().nullable().default(null),

  error: z.string().nullable().default(null),
  dataJson: z.string().default("{}"),

  updatedAtMs: z.coerce.number(),
});

export const WorkerErrorSchema = z.object({
  errorKey: z.string(),
  worker: z.string(),
  message: z.string(),
  stack: z.string().nullable().default(null),
  dataJson: z.string().default("{}"),
  createdAtMs: z.number(),
});

export const WorkerCursorSchema = z.object({
  key: z.string(),
  value: z.string().default(""),
  updatedAtMs: z.coerce.number().default(0),
});

export const TelegramSignalSchema = z.object({
  signalKey: z.string(),
  sourceId: z.string().nullable().default(null),
  sourceName: z.string().nullable().default(null),
  chatRef: z.string().nullable().default(null),
  text: z.string().default(""),
  mintsJson: z.string().default("[]"),
  symbolsJson: z.string().default("[]"),
  urlsJson: z.string().default("[]"),
  status: z.string().default("new"),
  receivedAtMs: z.coerce.number().default(0),
  rawJson: z.string().default("{}"),
});

export const TerminalFeedStateSchema = z.object({
  scope: z.string(),
  resetAtMs: z.number(),
  updatedAtMs: z.coerce.number(),
});

export const LaunchJobDbSchema = z.object({
  jobId: z.string(),
  kind: z.string().default("launch:pump"),
  status: z.string().default("queued"),

  inputJson: z.string().default("{}"),
  argvJson: z.string().default("[]"),
  resultJson: z.string().nullable().default(null),
  error: z.string().nullable().default(null),

  createdAtMs: z.number(),
  updatedAtMs: z.coerce.number(),
});

export const LaunchJobLogDbSchema = z.object({
  logId: z.string(),
  jobId: z.string(),
  atMs: z.number(),
  label: z.string(),
  valueJson: z.string().default("null"),
});

export const PumpLaunchSessionDbSchema = z.object({
  sessionId: z.string(),

  status: z.string().default("prepared"),
  buyerStatus: z.string().default("idle"),
  deploymentStatus: z.string().default("pending"),

  mint: z.string(),
  creator: z.string(),
  mintKeypairPath: z.string(),
  metadataUri: z.string(),

  tokenJson: z.string().default("{}"),
  buyPlanJson: z.string().default("[]"),
  buyerArgvJson: z.string().default("[]"),
  deployArgvJson: z.string().default("[]"),

  fireToken: z.string().nullable().default(null),
  fireAcknowledgedToken: z.string().nullable().default(null),

  abortReason: z.string().nullable().default(null),
  deploymentSignature: z.string().nullable().default(null),

  armedPid: z.number().default(0),

  armedAtMs: z.number().default(0),
  heartbeatAtMs: z.number().default(0),
  fireRequestedAtMs: z.number().default(0),
  fireAcknowledgedAtMs: z.number().default(0),
  deploymentBroadcastAtMs: z.number().default(0),
  completedAtMs: z.number().default(0),

  createdAtMs: z.number(),
  updatedAtMs: z.coerce.number(),
});

export const PumpLaunchBuyerDbSchema = z.object({
  buyerKey: z.string(),
  sessionId: z.string(),

  walletRef: z.string(),
  address: z.string(),
  label: z.string().nullable().default(null),

  selectedBps: z.number().nullable().default(null),
  spendLamports: z.string(),
  reserveLamports: z.string(),

  sender: z.string(),
  strategy: z.string(),
  configJson: z.string().default("{}"),

  status: z.string().default("prepared"),
  resultJson: z.string().nullable().default(null),
  error: z.string().nullable().default(null),

  heartbeatAtMs: z.number().default(0),
  createdAtMs: z.number(),
  updatedAtMs: z.coerce.number(),
});

export const ConfidenceSchema = z.enum([
  "processed",
  "confirmed",
  "finalized",
  "dropped",
]);

export const TerminalTradeSchema = z.object({
  tradeKey: z.string(),
  mint: z.string(),
  signature: z.string(),
  slot: z.coerce.number().default(0),
  owner: z.string().nullable().default(null),
  side: z.enum(["buy", "sell", "unknown"]).default("unknown"),
  tokenDeltaUi: z.coerce.number().default(0),
  solDeltaUi: z.coerce.number().default(0),
  priceSol: z.coerce.number().nullable().default(null),
  priceUsd: z.coerce.number().nullable().default(null),
  marketCapUsd: z.coerce.number().nullable().default(null),
  confidence: ConfidenceSchema.default("processed"),
  source: z.string().default("unknown"),
  rawJson: z.string().default("{}"),
  createdAtMs: z.coerce.number().default(0),
  updatedAtMs: z.coerce.number().default(0),
});

export const TerminalIndicatorSchema = z.object({
  indicatorKey: z.string(),
  mint: z.string(),
  intervalSec: z.coerce.number(),
  smaPriceUsd: z.coerce.number().nullable().default(null),
  smaMarketCapUsd: z.coerce.number().nullable().default(null),
  vwmaPriceUsd: z.coerce.number().nullable().default(null),
  medianPriceUsd: z.coerce.number().nullable().default(null),
  tradeCount: z.coerce.number().default(0),
  volumeSol: z.coerce.number().default(0),
  updatedAtMs: z.coerce.number().default(0),
});

export const TokenMarketExtremaSchema = z.object({
  mint: z.string(),
  athMarketCapUsd: z.number().nullable(),
  atlMarketCapUsd: z.number().nullable(),
});

export const TokenHolderWindowsSchema = z.object({
  mint: z.string(),

  holdersNow: z.number(),
  holders1mAgo: z.number(),
  holders5mAgo: z.number(),
  holders15mAgo: z.number(),
});

export const TokenPriceWindowsSchema = z.object({
  mint: z.string(),

  avgPriceUsd1m: z.number().nullable(),
  avgPriceUsd5m: z.number().nullable(),
  avgPriceUsd15m: z.number().nullable(),

  avgMarketCapUsd1m: z.number().nullable(),
  avgMarketCapUsd5m: z.number().nullable(),
  avgMarketCapUsd15m: z.number().nullable(),

  previousAvgMarketCapUsd1m: z.number().nullable(),
  previousAvgMarketCapUsd5m: z.number().nullable(),
  previousAvgMarketCapUsd15m: z.number().nullable(),

  trades1m: z.number(),
  trades5m: z.number(),
  trades15m: z.number(),

  previousTrades1m: z.number(),
  previousTrades5m: z.number(),
  previousTrades15m: z.number(),

  volumeSol1m: z.number(),
  volumeSol5m: z.number(),
  volumeSol15m: z.number(),

  previousVolumeSol1m: z.number(),
  previousVolumeSol5m: z.number(),
  previousVolumeSol15m: z.number(),

  latestPriceSol: z.number().nullable(),
  latestPriceUsd: z.number().nullable(),
  latestMarketCapUsd: z.number().nullable(),

  /**
   * Latest explicit market-cap value from the same 30-minute scan.
   */
  currentMarketCapUsd: z.number().nullable(),

  latestTradeAtMs: z.number().nullable(),
  latestTradeSource: z.string().nullable(),

  /**
   * Earliest trade actually present in tokenTradesV2.
   * This is recorded-data coverage, not necessarily the true first trade.
   */
  firstRecordedTradeAtMs: z.number().nullable(),
});

export type TerminalToken = z.infer<typeof TerminalTokenSchema>;

export type TokenTrade = z.infer<typeof TokenTradeSchema>;

export type WatchedWallet = z.infer<typeof WatchedWalletSchema>;
export type WalletTransaction = z.infer<typeof WalletTransactionSchema>;
export type WalletSwap = z.infer<typeof WalletSwapSchema>;

export type CopyTradeProfile = z.infer<typeof CopyTradeProfileSchema>;
export type CopyTradeIntent = z.infer<typeof CopyTradeIntentSchema>;

export type ProcessStatus = z.infer<typeof ProcessStatusSchema>;

export type TokenPriceWindows = z.infer<typeof TokenPriceWindowsSchema>;

export type TokenMarketExtrema = z.infer<typeof TokenMarketExtremaSchema>;

export type TokenHolderWindows = z.infer<typeof TokenHolderWindowsSchema>;

export type WorkerError = z.infer<typeof WorkerErrorSchema>;

export type TerminalFeedState = z.infer<typeof TerminalFeedStateSchema>;

export type LaunchJobDbRow = z.infer<typeof LaunchJobDbSchema>;

export type LaunchJobLogDbRow = z.infer<typeof LaunchJobLogDbSchema>;

export type PumpLaunchSessionDbRow = z.infer<typeof PumpLaunchSessionDbSchema>;

export type PumpLaunchBuyerDbRow = z.infer<typeof PumpLaunchBuyerDbSchema>;

export type TerminalConfidence = z.infer<typeof ConfidenceSchema>;
export type TerminalTradeDbRow = z.infer<typeof TerminalTradeSchema>;
export type TerminalIndicatorDbRow = z.infer<typeof TerminalIndicatorSchema>;
export type TelegramSignalDbRow = z.infer<typeof TelegramSignalSchema>;

export type TerminalTrade = Omit<TerminalTradeDbRow, "tradeKey"> & {
  id: string;
  tradeKey?: string;
};

export type TerminalIndicator = Omit<TerminalIndicatorDbRow, "indicatorKey"> & {
  id: string;
  indicatorKey?: string;
};

export type TelegramSignal = Omit<TelegramSignalDbRow, "signalKey"> & {
  id: string;
  signalKey?: string;
};

export type TerminalFeedRow = TerminalToken & {
  sma1m: number | null;
  sma5m: number | null;
  sma15m: number | null;

  previousSma1m: number | null;
  previousSma5m: number | null;
  previousSma15m: number | null;

  avgPriceUsd1m: number | null;
  avgPriceUsd5m: number | null;
  avgPriceUsd15m: number | null;

  tradeCount: number;
  trades1m: number;
  trades5m: number;
  trades15m: number;

  previousTrades1m: number;
  previousTrades5m: number;
  previousTrades15m: number;

  volumeSol1m: number;
  volumeSol5m: number;
  volumeSol15m: number;

  previousVolumeSol1m: number;
  previousVolumeSol5m: number;
  previousVolumeSol15m: number;

  holdersNow: number;
  holders1mAgo: number;
  holders5mAgo: number;
  holders15mAgo: number;

  athMarketCapUsd: number | null;
  atlMarketCapUsd: number | null;

  lastTradeAtMs: number | null;
  latestTradeSource: string | null;

  /**
   * Latest of creation, observation, and first recorded trade timestamps.
   * Deltas must not compare against history before this boundary.
   */
  dataCoverageStartedAtMs: number | null;

  priceAgeMs: number | null;
  priceStatus: "live" | "stale" | "missing";

  raw: TerminalToken;
};

function sqliteErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

export function isSqliteBusyError(error: unknown): boolean {
  const message = sqliteErrorMessage(error);

  return (
    message.includes("database is locked") ||
    message.includes("database is busy") ||
    message.includes("sqlite_busy") ||
    message.includes("sqlite_locked")
  );
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);

  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

const DB_OPEN_TIMEOUT_MS = positiveInteger(
  process.env.SOLARD_DB_OPEN_TIMEOUT_MS,
  45_000,
);

const DB_INIT_LOCK_STALE_MS = positiveInteger(
  process.env.SOLARD_DB_INIT_LOCK_STALE_MS,
  Math.max(90_000, DB_OPEN_TIMEOUT_MS * 2),
);

const DB_INIT_LOCK_PATH = `${SOLARD_DB_PATH}.init.lock`;

function startupDelayMs(attempt: number): number {
  const exponential = Math.min(1_000, 25 * 2 ** Math.min(attempt, 6));

  const jitter = Math.floor(Math.random() * 50);

  return exponential + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function removeStaleInitLock(): boolean {
  try {
    const stat = statSync(DB_INIT_LOCK_PATH);

    if (Date.now() - stat.mtimeMs < DB_INIT_LOCK_STALE_MS) {
      return false;
    }

    rmSync(DB_INIT_LOCK_PATH, {
      recursive: true,
      force: true,
    });

    console.warn(
      `[solard:db] removed stale database initialization lock: ${DB_INIT_LOCK_PATH}`,
    );

    return true;
  } catch {
    return false;
  }
}

async function acquireInitLock(deadlineAtMs: number): Promise<() => void> {
  let attempt = 0;

  while (true) {
    try {
      mkdirSync(DB_INIT_LOCK_PATH);

      writeFileSync(
        join(DB_INIT_LOCK_PATH, "owner.json"),
        JSON.stringify(
          {
            pid: process.pid,

            createdAtMs: Date.now(),

            dbPath: SOLARD_DB_PATH,
          },
          null,
          2,
        ),
      );

      return () => {
        rmSync(DB_INIT_LOCK_PATH, {
          recursive: true,
          force: true,
        });
      };
    } catch (error) {
      const code = (
        error as {
          code?: unknown;
        }
      )?.code;

      if (code !== "EEXIST") {
        throw error;
      }

      if (removeStaleInitLock()) {
        continue;
      }

      if (Date.now() >= deadlineAtMs) {
        throw new Error(
          `Timed out waiting for database initialization lock: ${DB_INIT_LOCK_PATH}`,
          {
            cause: error,
          },
        );
      }

      await sleep(startupDelayMs(attempt++));
    }
  }
}

async function openDatabaseWithRetry<T>(factory: () => T): Promise<T> {
  const deadlineAtMs = Date.now() + DB_OPEN_TIMEOUT_MS;

  const release = await acquireInitLock(deadlineAtMs);

  let attempt = 0;

  try {
    while (true) {
      try {
        return factory();
      } catch (error) {
        if (!isSqliteBusyError(error) || Date.now() >= deadlineAtMs) {
          throw error;
        }

        const delayMs = startupDelayMs(attempt++);

        if (attempt === 1 || attempt % 5 === 0) {
          console.warn(
            `[solard:db] SQLite busy during schema/index initialization; retrying in ${delayMs}ms`,
          );
        }

        await sleep(delayMs);
      }
    }
  } finally {
    release();
  }
}

export const db = await openDatabaseWithRetry(
  () =>
    new Database(
      SOLARD_DB_PATH,
      {
        terminalTokensLive: TerminalTokenSchema,
        tokenTradesV2: TokenTradeSchema,
        watchedWalletsV1: WatchedWalletSchema,
        walletTransactionsV1: WalletTransactionSchema,
        walletSwapsV1: WalletSwapSchema,
        copyTradeProfilesV1: CopyTradeProfileSchema,
        copyTradeIntentsV1: CopyTradeIntentSchema,
        terminalTradesLive: TerminalTradeSchema,
        terminalIndicatorsLive: TerminalIndicatorSchema,
        processStatus: ProcessStatusSchema,
        workerCursors: WorkerCursorSchema,
        telegramSignals: TelegramSignalSchema,
        workerErrors: WorkerErrorSchema,
        terminalFeedState: TerminalFeedStateSchema,
        launchJobsV2: LaunchJobDbSchema,
        launchJobLogsV2: LaunchJobLogDbSchema,
        pumpLaunchSessionsV1: PumpLaunchSessionDbSchema,
        pumpLaunchBuyersV1: PumpLaunchBuyerDbSchema,
      },
      {
        timestamps: false,
        softDeletes: false,
        reactive: false,
        wal: true,

        unique: {
          terminalTokensLive: [["mint"]],
          tokenTradesV2: [["eventKey"]],
          watchedWalletsV1: [["address"]],
          walletTransactionsV1: [["walletTxKey"]],
          walletSwapsV1: [["eventKey"]],
          copyTradeProfilesV1: [["profileKey"]],
          copyTradeIntentsV1: [["intentKey"]],
          terminalTradesLive: [["tradeKey"]],
          terminalIndicatorsLive: [["indicatorKey"], ["mint", "intervalSec"]],
          processStatus: [["name"]],
          workerCursors: [["key"]],
          telegramSignals: [["signalKey"]],
          workerErrors: [["errorKey"]],
          terminalFeedState: [["scope"]],
          launchJobsV2: [["jobId"]],
          launchJobLogsV2: [["logId"]],
          pumpLaunchSessionsV1: [["sessionId"]],
          pumpLaunchBuyersV1: [["buyerKey"]],
        },

        indexes: {
          terminalTokensLive: [
            "mint",
            "updatedAtMs",
            "priceUpdatedAtMs",
            "observedAtMs",
            "mayhemCheckedAtMs",
            "marketCapUsd",
            "source",
            ["source", "updatedAtMs"],
            ["observedAtMs", "updatedAtMs"],
          ],

          tokenTradesV2: [
            ["mint", "tradedAtMs"],
            ["tradedAtMs"],
            ["source", "tradedAtMs"],
            ["signature"],
            ["eventKey"],
            ["mint", "marketCapUsd"],
            ["owner", "tradedAtMs"],
            ["signature", "mint"],
          ],

          watchedWalletsV1: [["enabled", "updatedAtMs"], ["lastBackfillAtMs"]],

          walletTransactionsV1: [
            ["wallet", "tradedAtMs"],
            ["signature"],
            ["parseStatus", "updatedAtMs"],
          ],

          walletSwapsV1: [
            ["wallet", "tradedAtMs"],
            ["subjectMint", "tradedAtMs"],
            ["inputMint", "tradedAtMs"],
            ["outputMint", "tradedAtMs"],
            ["signature"],
            ["copyable", "tradedAtMs"],
          ],

          copyTradeProfilesV1: [
            ["enabled", "updatedAtMs"],
            ["leaderWallet", "enabled"],
            ["followerRef", "enabled"],
          ],

          copyTradeIntentsV1: [
            ["profileKey", "createdAtMs"],
            ["leaderWallet", "sourceTradedAtMs"],
            ["status", "nextAttemptAtMs"],
            ["sourceSignature"],
            ["leaderEventKey"],
          ],

          terminalTradesLive: [
            ["mint", "createdAtMs"],
            ["signature"],
            ["source", "createdAtMs"],
            ["confidence", "updatedAtMs"],
          ],

          terminalIndicatorsLive: [["mint", "intervalSec"], ["updatedAtMs"]],

          processStatus: [["heartbeatAtMs"], ["updatedAtMs"]],

          workerCursors: [["updatedAtMs"]],
          telegramSignals: [["receivedAtMs"]],

          workerErrors: [["createdAtMs"], ["worker", "createdAtMs"]],

          terminalFeedState: [["resetAtMs"], ["updatedAtMs"]],

          launchJobsV2: [
            ["createdAtMs"],
            ["status", "createdAtMs"],
            ["updatedAtMs"],
          ],

          launchJobLogsV2: [["jobId", "atMs"], ["atMs"]],

          pumpLaunchSessionsV1: [
            ["status", "updatedAtMs"],
            ["buyerStatus", "heartbeatAtMs"],
            ["deploymentStatus", "updatedAtMs"],
            ["mint"],
          ],

          pumpLaunchBuyersV1: [
            ["sessionId", "status"],
            ["sessionId", "updatedAtMs"],
            ["address"],
          ],
        },

        views: {
          tokenPriceWindowsV9: defineView(
            TokenPriceWindowsSchema,
            `
        WITH ranked AS (
          SELECT
            trade.*,
            ROW_NUMBER() OVER (
              PARTITION BY
                signature,
                mint,
                side,
                ROUND(ABS(tokenDeltaUi), 8),
                ROUND(ABS(solDeltaUi), 9)
              ORDER BY
                CASE confidence
                  WHEN 'finalized' THEN 0
                  WHEN 'confirmed' THEN 1
                  WHEN 'processed' THEN 2
                  ELSE 3
                END,
                CASE WHEN marketCapUsd IS NULL THEN 1 ELSE 0 END,
                CASE WHEN priceUsd IS NULL THEN 1 ELSE 0 END,
                CASE WHEN priceSol IS NULL THEN 1 ELSE 0 END,
                CASE WHEN owner IS NULL OR owner = '' THEN 1 ELSE 0 END,
                updatedAtMs DESC,
                id DESC
            ) AS canonicalRank
          FROM tokenTradesV2 AS trade
          WHERE tradedAtMs >= unixepoch('subsec') * 1000 - 1800000
        ),

        recent AS (
          SELECT
            id,
            mint,
            priceSol,
            priceUsd,
            marketCapUsd,
            source,
            tokenDeltaUi,
            solDeltaUi,
            COALESCE(
              NULLIF(ABS(solDeltaUi), 0),
              ABS(priceSol * tokenDeltaUi),
              0
            ) AS effectiveVolumeSol,
            tradedAtMs,
            ROW_NUMBER() OVER (
              PARTITION BY mint
              ORDER BY
                CASE WHEN priceSol IS NULL THEN 1 ELSE 0 END,
                tradedAtMs DESC,
                id DESC
            ) AS latestPriceSolRank,
            ROW_NUMBER() OVER (
              PARTITION BY mint
              ORDER BY
                CASE WHEN priceUsd IS NULL THEN 1 ELSE 0 END,
                tradedAtMs DESC,
                id DESC
            ) AS latestPriceUsdRank,
            ROW_NUMBER() OVER (
              PARTITION BY mint
              ORDER BY
                CASE WHEN marketCapUsd IS NULL THEN 1 ELSE 0 END,
                tradedAtMs DESC,
                id DESC
            ) AS latestMarketCapUsdRank,
            ROW_NUMBER() OVER (
              PARTITION BY mint
              ORDER BY tradedAtMs DESC, id DESC
            ) AS latestTradeRank
          FROM ranked
          WHERE canonicalRank = 1
        )

        SELECT
          mint,
          AVG(CASE WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 60000 THEN priceUsd END) AS avgPriceUsd1m,
          AVG(CASE WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 300000 THEN priceUsd END) AS avgPriceUsd5m,
          AVG(CASE WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 900000 THEN priceUsd END) AS avgPriceUsd15m,
          AVG(CASE WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 60000 THEN marketCapUsd END) AS avgMarketCapUsd1m,
          AVG(CASE WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 300000 THEN marketCapUsd END) AS avgMarketCapUsd5m,
          AVG(CASE WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 900000 THEN marketCapUsd END) AS avgMarketCapUsd15m,
          AVG(CASE WHEN tradedAtMs < unixepoch('subsec') * 1000 - 60000 AND tradedAtMs >= unixepoch('subsec') * 1000 - 120000 THEN marketCapUsd END) AS previousAvgMarketCapUsd1m,
          AVG(CASE WHEN tradedAtMs < unixepoch('subsec') * 1000 - 300000 AND tradedAtMs >= unixepoch('subsec') * 1000 - 600000 THEN marketCapUsd END) AS previousAvgMarketCapUsd5m,
          AVG(CASE WHEN tradedAtMs < unixepoch('subsec') * 1000 - 900000 AND tradedAtMs >= unixepoch('subsec') * 1000 - 1800000 THEN marketCapUsd END) AS previousAvgMarketCapUsd15m,
          COUNT(CASE WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 60000 THEN 1 END) AS trades1m,
          COUNT(CASE WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 300000 THEN 1 END) AS trades5m,
          COUNT(CASE WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 900000 THEN 1 END) AS trades15m,
          COUNT(CASE WHEN tradedAtMs < unixepoch('subsec') * 1000 - 60000 AND tradedAtMs >= unixepoch('subsec') * 1000 - 120000 THEN 1 END) AS previousTrades1m,
          COUNT(CASE WHEN tradedAtMs < unixepoch('subsec') * 1000 - 300000 AND tradedAtMs >= unixepoch('subsec') * 1000 - 600000 THEN 1 END) AS previousTrades5m,
          COUNT(CASE WHEN tradedAtMs < unixepoch('subsec') * 1000 - 900000 AND tradedAtMs >= unixepoch('subsec') * 1000 - 1800000 THEN 1 END) AS previousTrades15m,
          SUM(CASE WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 60000 THEN effectiveVolumeSol ELSE 0 END) AS volumeSol1m,
          SUM(CASE WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 300000 THEN effectiveVolumeSol ELSE 0 END) AS volumeSol5m,
          SUM(CASE WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 900000 THEN effectiveVolumeSol ELSE 0 END) AS volumeSol15m,
          SUM(CASE WHEN tradedAtMs < unixepoch('subsec') * 1000 - 60000 AND tradedAtMs >= unixepoch('subsec') * 1000 - 120000 THEN effectiveVolumeSol ELSE 0 END) AS previousVolumeSol1m,
          SUM(CASE WHEN tradedAtMs < unixepoch('subsec') * 1000 - 300000 AND tradedAtMs >= unixepoch('subsec') * 1000 - 600000 THEN effectiveVolumeSol ELSE 0 END) AS previousVolumeSol5m,
          SUM(CASE WHEN tradedAtMs < unixepoch('subsec') * 1000 - 900000 AND tradedAtMs >= unixepoch('subsec') * 1000 - 1800000 THEN effectiveVolumeSol ELSE 0 END) AS previousVolumeSol15m,
          MAX(CASE WHEN latestPriceSolRank = 1 THEN priceSol END) AS latestPriceSol,
          MAX(CASE WHEN latestPriceUsdRank = 1 THEN priceUsd END) AS latestPriceUsd,
          MAX(CASE WHEN latestMarketCapUsdRank = 1 THEN marketCapUsd END) AS latestMarketCapUsd,
          MAX(CASE WHEN latestMarketCapUsdRank = 1 THEN marketCapUsd END) AS currentMarketCapUsd,
          MAX(tradedAtMs) AS latestTradeAtMs,
          MAX(CASE WHEN latestTradeRank = 1 THEN source END) AS latestTradeSource,
          MIN(tradedAtMs) AS firstRecordedTradeAtMs
        FROM recent
        GROUP BY mint
        `,
          ),

          tokenMarketExtremaV5: defineView(
            TokenMarketExtremaSchema,
            `
        WITH ranked AS (
          SELECT
            trade.*,
            ROW_NUMBER() OVER (
              PARTITION BY
                signature,
                mint,
                side,
                ROUND(ABS(tokenDeltaUi), 8),
                ROUND(ABS(solDeltaUi), 9)
              ORDER BY
                CASE confidence
                  WHEN 'finalized' THEN 0
                  WHEN 'confirmed' THEN 1
                  WHEN 'processed' THEN 2
                  ELSE 3
                END,
                CASE WHEN marketCapUsd IS NULL THEN 1 ELSE 0 END,
                CASE WHEN priceUsd IS NULL THEN 1 ELSE 0 END,
                CASE WHEN owner IS NULL OR owner = '' THEN 1 ELSE 0 END,
                updatedAtMs DESC,
                id DESC
            ) AS canonicalRank
          FROM tokenTradesV2 AS trade
        ),
        marketCaps AS (
          SELECT
            trade.mint AS mint,
            COALESCE(
              trade.marketCapUsd,
              CASE
                WHEN trade.priceUsd IS NOT NULL AND token.supplyUi > 0
                THEN trade.priceUsd * token.supplyUi
              END
            ) AS marketCapUsd
          FROM ranked AS trade
          LEFT JOIN terminalTokensLive AS token ON token.mint = trade.mint
          WHERE trade.canonicalRank = 1

          UNION ALL

          SELECT mint, marketCapUsd
          FROM terminalTokensLive
          WHERE marketCapUsd IS NOT NULL AND marketCapUsd > 0
        )
        SELECT
          mint,
          MAX(marketCapUsd) AS athMarketCapUsd,
          MIN(marketCapUsd) AS atlMarketCapUsd
        FROM marketCaps
        WHERE marketCapUsd IS NOT NULL AND marketCapUsd > 0
        GROUP BY mint
        `,
          ),

          tokenHolderWindowsV2: defineView(
            TokenHolderWindowsSchema,
            `
        WITH ranked AS (
          SELECT
            trade.*,
            ROW_NUMBER() OVER (
              PARTITION BY
                signature,
                mint,
                side,
                ROUND(ABS(tokenDeltaUi), 8),
                ROUND(ABS(solDeltaUi), 9)
              ORDER BY
                CASE confidence
                  WHEN 'finalized' THEN 0
                  WHEN 'confirmed' THEN 1
                  WHEN 'processed' THEN 2
                  ELSE 3
                END,
                CASE WHEN owner IS NULL OR owner = '' THEN 1 ELSE 0 END,
                updatedAtMs DESC,
                id DESC
            ) AS canonicalRank
          FROM tokenTradesV2 AS trade
          WHERE owner IS NOT NULL AND owner <> '' AND tokenDeltaUi <> 0
        ),
        ownerPositions AS (
          SELECT
            mint,
            owner,
            SUM(CASE WHEN side = 'buy' THEN ABS(tokenDeltaUi) WHEN side = 'sell' THEN -ABS(tokenDeltaUi) ELSE tokenDeltaUi END) AS balanceNow,
            SUM(CASE WHEN tradedAtMs <= unixepoch('subsec') * 1000 - 60000 THEN CASE WHEN side = 'buy' THEN ABS(tokenDeltaUi) WHEN side = 'sell' THEN -ABS(tokenDeltaUi) ELSE tokenDeltaUi END ELSE 0 END) AS balance1mAgo,
            SUM(CASE WHEN tradedAtMs <= unixepoch('subsec') * 1000 - 300000 THEN CASE WHEN side = 'buy' THEN ABS(tokenDeltaUi) WHEN side = 'sell' THEN -ABS(tokenDeltaUi) ELSE tokenDeltaUi END ELSE 0 END) AS balance5mAgo,
            SUM(CASE WHEN tradedAtMs <= unixepoch('subsec') * 1000 - 900000 THEN CASE WHEN side = 'buy' THEN ABS(tokenDeltaUi) WHEN side = 'sell' THEN -ABS(tokenDeltaUi) ELSE tokenDeltaUi END ELSE 0 END) AS balance15mAgo
          FROM ranked
          WHERE canonicalRank = 1
          GROUP BY mint, owner
        )
        SELECT
          mint,
          SUM(CASE WHEN balanceNow > 0.000000001 THEN 1 ELSE 0 END) AS holdersNow,
          SUM(CASE WHEN balance1mAgo > 0.000000001 THEN 1 ELSE 0 END) AS holders1mAgo,
          SUM(CASE WHEN balance5mAgo > 0.000000001 THEN 1 ELSE 0 END) AS holders5mAgo,
          SUM(CASE WHEN balance15mAgo > 0.000000001 THEN 1 ELSE 0 END) AS holders15mAgo
        FROM ownerPositions
        GROUP BY mint
        `,
          ),
        },
      },
    ),
);

export const terminalDb = db;

const PRICE_WINDOW_TTL_MS = 1_000;
const TERMINAL_FEED_SCOPE = "pump";
const TERMINAL_INDICATOR_INTERVALS = [
  60, 300, 900, 3600, 21600, 86400,
] as const;

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value: unknown, fallback = 0): number {
  const parsed = Math.trunc(Number(value));
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function positiveTime(value: unknown): number {
  const parsed = finite(value) ?? 0;
  return parsed > 0 ? parsed : 0;
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const parsed = String(value).trim();
  return parsed || null;
}

function displayText(value: unknown): string {
  const parsed = text(value);
  if (!parsed) return "";
  const lowered = parsed.toLowerCase();
  return ["-", "token", "new token", "unknown", "null", "undefined"].includes(
    lowered,
  )
    ? ""
    : parsed;
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
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

function normalizeMayhem(value: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  const parsed = finite(value);
  return parsed != null && parsed > 0 ? 1 : 0;
}

function cleanPinnedMints(
  values: Iterable<string> | null | undefined,
): string[] {
  return [
    ...new Set(
      [...(values ?? [])].map((value) => String(value).trim()).filter(Boolean),
    ),
  ].slice(0, 250);
}

function sourceMatches(
  requested: string | null | undefined,
  actual: unknown,
): boolean {
  const source = String(requested ?? "both")
    .trim()
    .toLowerCase();
  if (!source || source === "both") return true;

  const value = String(actual ?? "")
    .trim()
    .toLowerCase();
  if (source.includes("helius")) {
    return value.includes("helius") || value.startsWith("telegram");
  }
  if (source.includes("pump")) {
    return (
      value.includes("pumpportal") ||
      value === "pump" ||
      value.startsWith("telegram")
    );
  }
  return value === source;
}

function chunked<T>(values: readonly T[], size = 250): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function normalizeTerminalToken(
  row: Record<string, unknown> | null | undefined,
): TerminalToken | null {
  if (!row) return null;
  const mint = text(row.mint);
  if (!mint) return null;

  return TerminalTokenSchema.parse({
    ...row,
    mint,
    supplyUi: finite(row.supplyUi) ?? 1_000_000_000,
    priceSol: finite(row.priceSol),
    priceUsd: finite(row.priceUsd),
    marketCapSol: finite(row.marketCapSol),
    marketCapUsd: finite(row.marketCapUsd),
    initialMarketCapUsd: finite(row.initialMarketCapUsd),
    lastSlot: integer(row.lastSlot, 0),
    isMayhemMode: normalizeMayhem(row.isMayhemMode),
    mayhemCheckedAtMs: integer(row.mayhemCheckedAtMs, 0),
    createdAtMs: integer(row.createdAtMs, 0),
    observedAtMs: integer(row.observedAtMs, 0),
    priceUpdatedAtMs: integer(row.priceUpdatedAtMs, 0),
    updatedAtMs: integer(row.updatedAtMs, 0),
  });
}

export function isDuplicateTradeError(error: unknown): boolean {
  const message = sqliteErrorMessage(error);
  return (
    message.includes("unique constraint failed") &&
    (message.includes("tokentradesv2.eventkey") || message.includes("eventkey"))
  );
}

export function getTerminalToken(mint: string): TerminalToken | null {
  const key = mint.trim();
  if (!key) return null;
  return normalizeTerminalToken(
    db.terminalTokensLive.select().where({ mint: key }).get() as Record<
      string,
      unknown
    > | null,
  );
}

export function upsertTerminalToken(
  input: Partial<TerminalToken> & { mint: string },
): TerminalToken {
  const now = Date.now();
  const existing = getTerminalToken(input.mint);
  const source = text(input.source) ?? existing?.source ?? "unknown";
  const incomingHasPrice = [
    input.priceSol,
    input.priceUsd,
    input.marketCapSol,
    input.marketCapUsd,
  ].some((value) => finite(value) != null);
  const discoveryObservation =
    /(?:create|discovery|new-token|telegram-signal|probe)/i.test(source)
      ? now
      : 0;

  const row = TerminalTokenSchema.parse({
    mint: input.mint,
    symbol: displayText(input.symbol) || existing?.symbol || "",
    name: displayText(input.name) || existing?.name || "",
    image: text(input.image) ?? existing?.image ?? null,
    uri: text(input.uri) ?? existing?.uri ?? null,
    description: text(input.description) ?? existing?.description ?? null,
    website: text(input.website) ?? existing?.website ?? null,
    twitter: text(input.twitter) ?? existing?.twitter ?? null,
    telegram: text(input.telegram) ?? existing?.telegram ?? null,
    creator: text(input.creator) ?? existing?.creator ?? null,
    bondingCurveKey:
      text(input.bondingCurveKey) ?? existing?.bondingCurveKey ?? null,
    source,
    phase:
      input.phase && input.phase !== "unknown"
        ? input.phase
        : (existing?.phase ?? "unknown"),
    isMayhemMode:
      input.isMayhemMode == null
        ? (existing?.isMayhemMode ?? 0)
        : normalizeMayhem(input.isMayhemMode),
    mayhemCheckedAtMs: integer(
      input.mayhemCheckedAtMs,
      existing?.mayhemCheckedAtMs ?? 0,
    ),
    quoteAsset: text(input.quoteAsset) ?? existing?.quoteAsset ?? null,
    quoteMint: text(input.quoteMint) ?? existing?.quoteMint ?? null,
    supplyUi:
      finite(input.supplyUi) ?? finite(existing?.supplyUi) ?? 1_000_000_000,
    priceSol: finite(input.priceSol),
    priceUsd: finite(input.priceUsd),
    marketCapSol: finite(input.marketCapSol),
    marketCapUsd: finite(input.marketCapUsd),
    initialMarketCapUsd: finite(
      input.initialMarketCapUsd ?? input.marketCapUsd,
    ),
    lastSlot: integer(input.lastSlot, 0),
    signature: text(input.signature),
    createdAtMs:
      positiveTime(existing?.createdAtMs) || integer(input.createdAtMs, now),
    observedAtMs: Math.max(
      positiveTime(existing?.observedAtMs),
      integer(input.observedAtMs ?? discoveryObservation, 0),
    ),
    priceUpdatedAtMs: integer(
      input.priceUpdatedAtMs ??
        (incomingHasPrice ? (input.updatedAtMs ?? now) : 0),
      0,
    ),
    updatedAtMs: integer(input.updatedAtMs, now),
  });

  const saved = db.terminalTokensLive.upsert(row, {
    on: "mint",
    merge: (table) => ({
      symbol: table.excludedIfNotEmpty("symbol"),
      name: table.excludedIfNotEmpty("name"),
      image: table.excludedIfNotEmpty("image"),
      uri: table.excludedIfNotEmpty("uri"),
      description: table.excludedIfNotNull("description"),
      website: table.excludedIfNotNull("website"),
      twitter: table.excludedIfNotNull("twitter"),
      telegram: table.excludedIfNotNull("telegram"),
      creator: table.excludedIfNotNull("creator"),
      bondingCurveKey: table.excludedIfNotNull("bondingCurveKey"),
      source: table.excludedIfNotEmpty("source"),
      phase: table.excludedIfNotEmpty("phase"),
      isMayhemMode: table.max("isMayhemMode", 0),
      mayhemCheckedAtMs: table.max("mayhemCheckedAtMs", 0),
      quoteAsset: table.excludedIfNotNull("quoteAsset"),
      quoteMint: table.excludedIfNotNull("quoteMint"),
      supplyUi: table.max("supplyUi", 1_000_000_000),
      priceSol: table.excludedIfNotNull("priceSol"),
      priceUsd: table.excludedIfNotNull("priceUsd"),
      marketCapSol: table.excludedIfNotNull("marketCapSol"),
      marketCapUsd: table.excludedIfNotNull("marketCapUsd"),
      initialMarketCapUsd: table.keepFirst("initialMarketCapUsd"),
      lastSlot: table.max("lastSlot", 0),
      signature: table.excludedIfNotNull("signature"),
      createdAtMs: table.keepFirst("createdAtMs"),
      observedAtMs: table.max("observedAtMs", 0),
      priceUpdatedAtMs: table.max("priceUpdatedAtMs", 0),
      updatedAtMs: table.max("updatedAtMs", 0),
    }),
  });

  const normalized = normalizeTerminalToken(saved as Record<string, unknown>);
  if (!normalized) {
    throw new Error(
      `terminal token upsert returned an invalid row for ${row.mint}`,
    );
  }
  return normalized;
}

export function setTerminalTokenMayhem(input: {
  mint: string;
  isMayhemMode: boolean;
  checkedAtMs?: number;
}): TerminalToken | null {
  const existing = getTerminalToken(input.mint);
  if (!existing) return null;
  return upsertTerminalToken({
    ...existing,
    mint: input.mint,
    isMayhemMode: input.isMayhemMode ? 1 : 0,
    mayhemCheckedAtMs: input.checkedAtMs ?? Date.now(),
    updatedAtMs: Date.now(),
  });
}

export function listTokensNeedingMayhemCheck(
  limit = 250,
): Array<
  Pick<
    TerminalToken,
    | "mint"
    | "bondingCurveKey"
    | "phase"
    | "observedAtMs"
    | "updatedAtMs"
    | "mayhemCheckedAtMs"
  >
> {
  const capped = Math.max(1, Math.min(integer(limit, 250), 1_000));
  const now = Date.now();
  return (
    db.terminalTokensLive
      .select()
      .orderBy("updatedAtMs", "desc")
      .all() as Record<string, unknown>[]
  )
    .map(normalizeTerminalToken)
    .filter((token): token is TerminalToken => token != null)
    .filter((token) => {
      if (
        token.phase === "migrated" ||
        token.observedAtMs <= 0 ||
        token.isMayhemMode > 0
      ) {
        return false;
      }
      if (token.mayhemCheckedAtMs <= 0) return true;
      return (
        now - token.observedAtMs <= 15 * 60_000 &&
        now - token.mayhemCheckedAtMs >= 10_000
      );
    })
    .slice(0, capped)
    .map((token) => ({
      mint: token.mint,
      bondingCurveKey: token.bondingCurveKey,
      phase: token.phase,
      observedAtMs: token.observedAtMs,
      updatedAtMs: token.updatedAtMs,
      mayhemCheckedAtMs: token.mayhemCheckedAtMs,
    }));
}

export function listWatchedWallets(
  input: { enabledOnly?: boolean; limit?: number } = {},
): WatchedWallet[] {
  let query = db.watchedWalletsV1
    .select()
    .orderBy("updatedAtMs", "desc")
    .limit(Math.max(1, Math.min(integer(input.limit, 10_000), 50_000)));
  if (input.enabledOnly) query = query.where({ enabled: 1 });
  return query.all() as WatchedWallet[];
}

export function getWatchedWallet(address: string): WatchedWallet | null {
  const key = address.trim();
  if (!key) return null;
  return (
    (db.watchedWalletsV1
      .select()
      .where({ address: key })
      .get() as WatchedWallet | null) ?? null
  );
}

export function upsertWatchedWallet(
  input: Partial<WatchedWallet> & { address: string },
): WatchedWallet {
  const now = Date.now();
  const address = input.address.trim();
  if (!address) throw new Error("Wallet address is required");
  const existing = getWatchedWallet(address);
  const row = WatchedWalletSchema.parse({
    address,
    label:
      input.label === null
        ? null
        : (text(input.label) ?? existing?.label ?? null),
    enabled:
      input.enabled == null
        ? (existing?.enabled ?? 1)
        : Number(input.enabled) > 0
          ? 1
          : 0,
    backfillEnabled:
      input.backfillEnabled == null
        ? (existing?.backfillEnabled ?? 1)
        : Number(input.backfillEnabled) > 0
          ? 1
          : 0,
    lastBackfillSignature:
      input.lastBackfillSignature === null
        ? null
        : (text(input.lastBackfillSignature) ??
          existing?.lastBackfillSignature ??
          null),
    lastBackfillAtMs: integer(
      input.lastBackfillAtMs,
      existing?.lastBackfillAtMs ?? 0,
    ),
    lastSeenSlot: Math.max(
      integer(input.lastSeenSlot, 0),
      existing?.lastSeenSlot ?? 0,
    ),
    createdAtMs: existing?.createdAtMs ?? integer(input.createdAtMs, now),
    updatedAtMs: integer(input.updatedAtMs, now),
  });
  return db.watchedWalletsV1.upsert(row, {
    on: "address",
    merge: (table) => ({
      label: table.excluded("label"),
      enabled: table.excluded("enabled"),
      backfillEnabled: table.excluded("backfillEnabled"),
      lastBackfillSignature: table.excluded("lastBackfillSignature"),
      lastBackfillAtMs: table.max("lastBackfillAtMs", 0),
      lastSeenSlot: table.max("lastSeenSlot", 0),
      updatedAtMs: table.max("updatedAtMs", 0),
    }),
  }) as WatchedWallet;
}

export function updateWatchedWalletCursor(
  address: string,
  input: {
    signature?: string | null;
    slot?: number;
    backfilledAtMs?: number;
  },
): WatchedWallet {
  const existing = getWatchedWallet(address);
  if (!existing) throw new Error(`Unknown watched wallet: ${address}`);
  return upsertWatchedWallet({
    ...existing,
    lastBackfillSignature:
      input.signature === undefined
        ? existing.lastBackfillSignature
        : input.signature,
    lastBackfillAtMs: integer(input.backfilledAtMs, Date.now()),
    lastSeenSlot: Math.max(existing.lastSeenSlot, integer(input.slot, 0)),
    updatedAtMs: Date.now(),
  });
}

export function resetWatchedWalletBackfill(address: string): WatchedWallet {
  const key = address.trim();
  const existing = getWatchedWallet(key);
  if (!existing) throw new Error(`Unknown watched wallet: ${address}`);

  db.watchedWalletsV1
    .update({
      lastBackfillSignature: null,
      lastBackfillAtMs: 0,
      updatedAtMs: Date.now(),
    })
    .where({ address: key })
    .exec();

  return (
    getWatchedWallet(key) ?? {
      ...existing,
      lastBackfillSignature: null,
      lastBackfillAtMs: 0,
      updatedAtMs: Date.now(),
    }
  );
}

export function upsertWalletTransaction(
  input: Partial<WalletTransaction> & {
    wallet: string;
    signature: string;
  },
): WalletTransaction {
  const now = Date.now();
  const wallet = input.wallet.trim();
  const signature = input.signature.trim();
  if (!wallet || !signature) {
    throw new Error("Wallet transaction requires wallet and signature");
  }
  const walletTxKey = text(input.walletTxKey) ?? `${wallet}:${signature}`;
  const existing = db.walletTransactionsV1
    .select()
    .where({ walletTxKey })
    .get() as WalletTransaction | null;
  const row = WalletTransactionSchema.parse({
    walletTxKey,
    wallet,
    signature,
    slot: Math.max(integer(input.slot, 0), existing?.slot ?? 0),
    confidence: input.confidence ?? existing?.confidence ?? "confirmed",
    parseStatus: input.parseStatus ?? existing?.parseStatus ?? "pending",
    parserVersion:
      text(input.parserVersion) ?? existing?.parserVersion ?? "wallet-v1",
    rawJson:
      typeof input.rawJson === "string"
        ? input.rawJson
        : (existing?.rawJson ?? stringify(input.rawJson ?? {})),
    error:
      input.error === null
        ? null
        : (text(input.error) ?? existing?.error ?? null),
    tradedAtMs: integer(input.tradedAtMs, existing?.tradedAtMs ?? now),
    updatedAtMs: integer(input.updatedAtMs, now),
  });
  return db.walletTransactionsV1.upsert(row, {
    on: "walletTxKey",
    merge: (table) => ({
      slot: table.max("slot", 0),
      confidence: table.excluded("confidence"),
      parseStatus: table.excluded("parseStatus"),
      parserVersion: table.excluded("parserVersion"),
      rawJson: table.excludedIfNotEmpty("rawJson"),
      error: table.excluded("error"),
      tradedAtMs: table.max("tradedAtMs", 0),
      updatedAtMs: table.max("updatedAtMs", 0),
    }),
  }) as WalletTransaction;
}

export function listWalletTransactions(
  input: {
    wallet?: string | null;
    parseStatus?: WalletTransaction["parseStatus"] | null;
    sinceMs?: number;
    limit?: number;
  } = {},
): WalletTransaction[] {
  let query = db.walletTransactionsV1.select();
  if (input.wallet?.trim()) {
    query = query.where({ wallet: input.wallet.trim() });
  }
  if (input.parseStatus) {
    query = query.where({ parseStatus: input.parseStatus });
  }
  const sinceMs = positiveTime(input.sinceMs);
  if (sinceMs > 0) {
    query = query.where({ tradedAtMs: { $gte: sinceMs } });
  }
  return query
    .orderBy("tradedAtMs", "desc")
    .limit(Math.max(1, Math.min(integer(input.limit, 1_000), 50_000)))
    .all() as WalletTransaction[];
}

export function getWalletTransaction(
  wallet: string,
  signature: string,
): WalletTransaction | null {
  const cleanWallet = wallet.trim();
  const cleanSignature = signature.trim();
  if (!cleanWallet || !cleanSignature) return null;
  return (
    (db.walletTransactionsV1
      .select()
      .where({ wallet: cleanWallet, signature: cleanSignature })
      .get() as WalletTransaction | null) ?? null
  );
}

export type RequeueWalletTransactionsResult = {
  queued: number;
  deletedSwaps: number;
  transactions: WalletTransaction[];
};

export function requeueWalletTransactions(
  input: {
    wallet?: string | null;
    signature?: string | null;
    parseStatuses?: WalletTransaction["parseStatus"][];
    limit?: number;
    deleteSwaps?: boolean;
  } = {},
): RequeueWalletTransactionsResult {
  const wallet = input.wallet?.trim() ?? "";
  const signature = input.signature?.trim() ?? "";
  const statuses = new Set<WalletTransaction["parseStatus"]>(
    input.parseStatuses?.length ? input.parseStatuses : ["error"],
  );
  const limit = Math.max(1, Math.min(integer(input.limit, 250), 5_000));

  let query = db.walletTransactionsV1.select();
  if (wallet) query = query.where({ wallet });
  if (signature) query = query.where({ signature });
  const selected = (
    query
      .orderBy("tradedAtMs", "desc")
      .limit(Math.max(limit * 4, limit))
      .all() as WalletTransaction[]
  )
    .filter((row) => statuses.has(row.parseStatus))
    .slice(0, limit);

  let deletedSwaps = 0;
  const transactions: WalletTransaction[] = [];
  for (const row of selected) {
    if (input.deleteSwaps !== false) {
      deletedSwaps += db.walletSwapsV1
        .delete()
        .where({ wallet: row.wallet, signature: row.signature })
        .exec();
    }
    db.walletTransactionsV1
      .update({
        parseStatus: "pending",
        error: null,
        parserVersion: "wallet-v2-reparse",
        updatedAtMs: Date.now(),
      })
      .where({ walletTxKey: row.walletTxKey })
      .exec();
    const updated = getWalletTransaction(row.wallet, row.signature);
    if (updated) transactions.push(updated);
  }

  return { queued: transactions.length, deletedSwaps, transactions };
}

export function requeueWalletTransaction(input: {
  wallet: string;
  signature: string;
  deleteSwaps?: boolean;
}): WalletTransaction {
  const existing = getWalletTransaction(input.wallet, input.signature);
  if (!existing) {
    throw new Error(
      `Wallet transaction not found: ${input.wallet}:${input.signature}`,
    );
  }
  const result = requeueWalletTransactions({
    wallet: input.wallet,
    signature: input.signature,
    parseStatuses: ["pending", "parsed", "ignored", "error"],
    limit: 1,
    deleteSwaps: input.deleteSwaps,
  });
  if (!result.transactions[0]) {
    throw new Error("Failed to queue wallet transaction for reparse");
  }
  return result.transactions[0];
}

export type AppendWalletSwapResult = {
  row: WalletSwap;
  inserted: boolean;
};

function isDuplicateWalletSwapError(error: unknown): boolean {
  const message = sqliteErrorMessage(error);
  return (
    message.includes("unique constraint failed") &&
    (message.includes("walletswapsv1.eventkey") || message.includes("eventkey"))
  );
}

export function appendWalletSwapOnce(
  input: Partial<WalletSwap> & {
    eventKey: string;
    wallet: string;
    signature: string;
    inputMint: string;
    outputMint: string;
    subjectMint: string;
  },
): AppendWalletSwapResult {
  const now = Date.now();
  const row = WalletSwapSchema.parse({
    ...input,
    eventKey: input.eventKey,
    wallet: input.wallet.trim(),
    signature: input.signature.trim(),
    slot: integer(input.slot, 0),
    inputMint: input.inputMint.trim(),
    inputAmountUi: finite(input.inputAmountUi) ?? 0,
    outputMint: input.outputMint.trim(),
    outputAmountUi: finite(input.outputAmountUi) ?? 0,
    subjectMint: input.subjectMint.trim(),
    quoteMint: text(input.quoteMint),
    side:
      input.side === "buy" || input.side === "sell" || input.side === "swap"
        ? input.side
        : "unknown",
    venue: text(input.venue) ?? "unknown",
    programId: text(input.programId),
    parser: text(input.parser) ?? "unknown",
    classificationConfidence:
      input.classificationConfidence === "exact" ||
      input.classificationConfidence === "inferred"
        ? input.classificationConfidence
        : "ambiguous",
    copyable: Number(input.copyable) > 0 ? 1 : 0,
    priceSol: finite(input.priceSol),
    priceUsd: finite(input.priceUsd),
    marketCapUsd: finite(input.marketCapUsd),
    rawJson:
      typeof input.rawJson === "string"
        ? input.rawJson
        : stringify(input.rawJson ?? {}),
    tradedAtMs: integer(input.tradedAtMs, now),
    updatedAtMs: integer(input.updatedAtMs, now),
  });

  try {
    return {
      row: db.walletSwapsV1.insert(row) as WalletSwap,
      inserted: true,
    };
  } catch (error) {
    if (!isDuplicateWalletSwapError(error)) throw error;
    const existing = db.walletSwapsV1
      .select()
      .where({ eventKey: row.eventKey })
      .get() as WalletSwap | null;
    return { row: existing ?? row, inserted: false };
  }
}

export function listWalletSwaps(
  input: {
    wallet?: string | null;
    signature?: string | null;
    mint?: string | null;
    side?: "buy" | "sell" | "swap" | "unknown" | null;
    sinceMs?: number;
    copyableOnly?: boolean;
    limit?: number;
  } = {},
): WalletSwap[] {
  let query = db.walletSwapsV1.select();
  if (input.wallet?.trim())
    query = query.where({ wallet: input.wallet.trim() });
  if (input.signature?.trim()) {
    query = query.where({ signature: input.signature.trim() });
  }
  if (input.side) query = query.where({ side: input.side });
  if (positiveTime(input.sinceMs) > 0) {
    query = query.where({ tradedAtMs: { $gte: positiveTime(input.sinceMs) } });
  }
  if (input.copyableOnly) query = query.where({ copyable: 1 });

  const mint = input.mint?.trim();
  if (mint) query = query.where({ subjectMint: mint });
  const limit = Math.max(1, Math.min(integer(input.limit, 250), 100_000));
  return query.orderBy("tradedAtMs", "desc").limit(limit).all() as WalletSwap[];
}

function cleanJsonStringArray(value: unknown): string {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return JSON.stringify([
          ...new Set(parsed.map((item) => String(item).trim()).filter(Boolean)),
        ]);
      }
    } catch {}
  }
  if (Array.isArray(value)) {
    return JSON.stringify([
      ...new Set(value.map((item) => String(item).trim()).filter(Boolean)),
    ]);
  }
  return "[]";
}

export function listCopyTradeProfiles(
  input: {
    enabledOnly?: boolean;
    leaderWallet?: string | null;
    followerRef?: string | null;
    limit?: number;
  } = {},
): CopyTradeProfile[] {
  let query = db.copyTradeProfilesV1.select();
  if (input.enabledOnly) query = query.where({ enabled: 1 });
  if (input.leaderWallet?.trim()) {
    query = query.where({ leaderWallet: input.leaderWallet.trim() });
  }
  if (input.followerRef?.trim()) {
    query = query.where({ followerRef: input.followerRef.trim() });
  }
  return query
    .orderBy("updatedAtMs", "desc")
    .limit(Math.max(1, Math.min(integer(input.limit, 10_000), 50_000)))
    .all() as CopyTradeProfile[];
}

export function getCopyTradeProfile(
  profileKey: string,
): CopyTradeProfile | null {
  const key = profileKey.trim();
  if (!key) return null;
  return (
    (db.copyTradeProfilesV1
      .select()
      .where({ profileKey: key })
      .get() as CopyTradeProfile | null) ?? null
  );
}

export function upsertCopyTradeProfile(
  input: Partial<CopyTradeProfile> & {
    profileKey?: string;
    leaderWallet: string;
    followerRef: string;
  },
): CopyTradeProfile {
  const now = Date.now();
  const leaderWallet = input.leaderWallet.trim();
  const followerRef = input.followerRef.trim();
  if (!leaderWallet || !followerRef) {
    throw new Error("Copy profile requires leaderWallet and followerRef");
  }
  const profileKey = text(input.profileKey) ?? `${leaderWallet}:${followerRef}`;
  const existing = getCopyTradeProfile(profileKey);
  const row = CopyTradeProfileSchema.parse({
    profileKey,
    leaderWallet,
    followerRef,
    label:
      input.label === null
        ? null
        : (text(input.label) ?? existing?.label ?? null),
    enabled:
      input.enabled == null
        ? (existing?.enabled ?? 1)
        : Number(input.enabled) > 0
          ? 1
          : 0,
    mode:
      input.mode === "live"
        ? "live"
        : input.mode === "paper"
          ? "paper"
          : (existing?.mode ?? "paper"),
    copyBuys:
      input.copyBuys == null
        ? (existing?.copyBuys ?? 1)
        : Number(input.copyBuys) > 0
          ? 1
          : 0,
    copySells:
      input.copySells == null
        ? (existing?.copySells ?? 1)
        : Number(input.copySells) > 0
          ? 1
          : 0,
    buySizing:
      input.buySizing === "leader-ratio" || input.buySizing === "fixed"
        ? input.buySizing
        : (existing?.buySizing ?? "fixed"),
    fixedBuyAmountUi: Math.max(
      0,
      finite(input.fixedBuyAmountUi) ?? existing?.fixedBuyAmountUi ?? 0.05,
    ),
    leaderScaleBps: Math.max(
      1,
      Math.min(
        100_000,
        integer(input.leaderScaleBps, existing?.leaderScaleBps ?? 10_000),
      ),
    ),
    maxBuyAmountUi: Math.max(
      0,
      finite(input.maxBuyAmountUi) ?? existing?.maxBuyAmountUi ?? 1,
    ),
    sellBalanceBps: Math.max(
      1,
      Math.min(
        10_000,
        integer(input.sellBalanceBps, existing?.sellBalanceBps ?? 10_000),
      ),
    ),
    slippageBps: Math.max(
      1,
      Math.min(
        10_000,
        integer(input.slippageBps, existing?.slippageBps ?? 500),
      ),
    ),
    maxEventAgeMs: Math.max(
      1_000,
      integer(input.maxEventAgeMs, existing?.maxEventAgeMs ?? 30_000),
    ),
    requirePriceData:
      input.requirePriceData == null
        ? (existing?.requirePriceData ?? 1)
        : Number(input.requirePriceData) > 0
          ? 1
          : 0,
    allowMayhem:
      input.allowMayhem == null
        ? (existing?.allowMayhem ?? 0)
        : Number(input.allowMayhem) > 0
          ? 1
          : 0,
    minMarketCapUsd:
      input.minMarketCapUsd === null
        ? null
        : (finite(input.minMarketCapUsd) ?? existing?.minMarketCapUsd ?? null),
    maxMarketCapUsd:
      input.maxMarketCapUsd === null
        ? null
        : (finite(input.maxMarketCapUsd) ?? existing?.maxMarketCapUsd ?? null),
    maxPriceAgeMs:
      input.maxPriceAgeMs === null
        ? null
        : (finite(input.maxPriceAgeMs) ?? existing?.maxPriceAgeMs ?? null),
    minTokenAgeMs:
      input.minTokenAgeMs === null
        ? null
        : (finite(input.minTokenAgeMs) ?? existing?.minTokenAgeMs ?? null),
    maxTokenAgeMs:
      input.maxTokenAgeMs === null
        ? null
        : (finite(input.maxTokenAgeMs) ?? existing?.maxTokenAgeMs ?? null),
    minHolders:
      input.minHolders === null
        ? null
        : (finite(input.minHolders) ?? existing?.minHolders ?? null),
    minTrades1m:
      input.minTrades1m === null
        ? null
        : (finite(input.minTrades1m) ?? existing?.minTrades1m ?? null),
    minTrades5m:
      input.minTrades5m === null
        ? null
        : (finite(input.minTrades5m) ?? existing?.minTrades5m ?? null),
    minTrades15m:
      input.minTrades15m === null
        ? null
        : (finite(input.minTrades15m) ?? existing?.minTrades15m ?? null),
    minVolumeSol1m:
      input.minVolumeSol1m === null
        ? null
        : (finite(input.minVolumeSol1m) ?? existing?.minVolumeSol1m ?? null),
    minVolumeSol5m:
      input.minVolumeSol5m === null
        ? null
        : (finite(input.minVolumeSol5m) ?? existing?.minVolumeSol5m ?? null),
    minVolumeSol15m:
      input.minVolumeSol15m === null
        ? null
        : (finite(input.minVolumeSol15m) ?? existing?.minVolumeSol15m ?? null),
    minLeaderQuoteAmountUi:
      input.minLeaderQuoteAmountUi === null
        ? null
        : (finite(input.minLeaderQuoteAmountUi) ??
          existing?.minLeaderQuoteAmountUi ??
          null),
    maxLeaderQuoteAmountUi:
      input.maxLeaderQuoteAmountUi === null
        ? null
        : (finite(input.maxLeaderQuoteAmountUi) ??
          existing?.maxLeaderQuoteAmountUi ??
          null),
    allowedMintsJson:
      input.allowedMintsJson === undefined
        ? (existing?.allowedMintsJson ?? "[]")
        : cleanJsonStringArray(input.allowedMintsJson),
    blockedMintsJson:
      input.blockedMintsJson === undefined
        ? (existing?.blockedMintsJson ?? "[]")
        : cleanJsonStringArray(input.blockedMintsJson),
    allowedQuoteMintsJson:
      input.allowedQuoteMintsJson === undefined
        ? (existing?.allowedQuoteMintsJson ?? "[]")
        : cleanJsonStringArray(input.allowedQuoteMintsJson),
    allowedPhasesJson:
      input.allowedPhasesJson === undefined
        ? (existing?.allowedPhasesJson ?? "[]")
        : cleanJsonStringArray(input.allowedPhasesJson),
    allowedVenuesJson:
      input.allowedVenuesJson === undefined
        ? (existing?.allowedVenuesJson ?? "[]")
        : cleanJsonStringArray(input.allowedVenuesJson),
    allowedParsersJson:
      input.allowedParsersJson === undefined
        ? (existing?.allowedParsersJson ?? "[]")
        : cleanJsonStringArray(input.allowedParsersJson),
    createdAtMs: existing?.createdAtMs ?? integer(input.createdAtMs, now),
    updatedAtMs: integer(input.updatedAtMs, now),
  });
  return db.copyTradeProfilesV1.upsert(row, {
    on: "profileKey",
    merge: (table) => ({
      leaderWallet: table.excluded("leaderWallet"),
      followerRef: table.excluded("followerRef"),
      label: table.excluded("label"),
      enabled: table.excluded("enabled"),
      mode: table.excluded("mode"),
      copyBuys: table.excluded("copyBuys"),
      copySells: table.excluded("copySells"),
      buySizing: table.excluded("buySizing"),
      fixedBuyAmountUi: table.excluded("fixedBuyAmountUi"),
      leaderScaleBps: table.excluded("leaderScaleBps"),
      maxBuyAmountUi: table.excluded("maxBuyAmountUi"),
      sellBalanceBps: table.excluded("sellBalanceBps"),
      slippageBps: table.excluded("slippageBps"),
      maxEventAgeMs: table.excluded("maxEventAgeMs"),
      requirePriceData: table.excluded("requirePriceData"),
      allowMayhem: table.excluded("allowMayhem"),
      minMarketCapUsd: table.excluded("minMarketCapUsd"),
      maxMarketCapUsd: table.excluded("maxMarketCapUsd"),
      maxPriceAgeMs: table.excluded("maxPriceAgeMs"),
      minTokenAgeMs: table.excluded("minTokenAgeMs"),
      maxTokenAgeMs: table.excluded("maxTokenAgeMs"),
      minHolders: table.excluded("minHolders"),
      minTrades1m: table.excluded("minTrades1m"),
      minTrades5m: table.excluded("minTrades5m"),
      minTrades15m: table.excluded("minTrades15m"),
      minVolumeSol1m: table.excluded("minVolumeSol1m"),
      minVolumeSol5m: table.excluded("minVolumeSol5m"),
      minVolumeSol15m: table.excluded("minVolumeSol15m"),
      minLeaderQuoteAmountUi: table.excluded("minLeaderQuoteAmountUi"),
      maxLeaderQuoteAmountUi: table.excluded("maxLeaderQuoteAmountUi"),
      allowedMintsJson: table.excluded("allowedMintsJson"),
      blockedMintsJson: table.excluded("blockedMintsJson"),
      allowedQuoteMintsJson: table.excluded("allowedQuoteMintsJson"),
      allowedPhasesJson: table.excluded("allowedPhasesJson"),
      allowedVenuesJson: table.excluded("allowedVenuesJson"),
      allowedParsersJson: table.excluded("allowedParsersJson"),
      updatedAtMs: table.max("updatedAtMs", 0),
    }),
  }) as CopyTradeProfile;
}

export function getCopyTradeIntent(intentKey: string): CopyTradeIntent | null {
  const key = intentKey.trim();
  if (!key) return null;
  return (
    (db.copyTradeIntentsV1
      .select()
      .where({ intentKey: key })
      .get() as CopyTradeIntent | null) ?? null
  );
}

export type AppendCopyTradeIntentResult = {
  row: CopyTradeIntent;
  inserted: boolean;
};

function isDuplicateCopyTradeIntentError(error: unknown): boolean {
  const message = sqliteErrorMessage(error);
  return (
    message.includes("unique constraint failed") &&
    (message.includes("copytradeintentsv1.intentkey") ||
      message.includes("intentkey"))
  );
}

export function appendCopyTradeIntentOnce(
  input: Partial<CopyTradeIntent> & {
    intentKey: string;
    profileKey: string;
    leaderEventKey: string;
    leaderWallet: string;
    followerRef: string;
    sourceSignature: string;
    side: "buy" | "sell";
    inputMint: string;
    outputMint: string;
    subjectMint: string;
    amountKind: "exact-input-ui" | "balance-bps";
  },
): AppendCopyTradeIntentResult {
  const now = Date.now();
  const row = CopyTradeIntentSchema.parse({
    ...input,
    intentKey: input.intentKey.trim(),
    profileKey: input.profileKey.trim(),
    leaderEventKey: input.leaderEventKey.trim(),
    leaderWallet: input.leaderWallet.trim(),
    followerRef: input.followerRef.trim(),
    sourceSignature: input.sourceSignature.trim(),
    sourceSlot: integer(input.sourceSlot, 0),
    sourceTradedAtMs: integer(input.sourceTradedAtMs, 0),
    side: input.side,
    inputMint: input.inputMint.trim(),
    outputMint: input.outputMint.trim(),
    subjectMint: input.subjectMint.trim(),
    quoteMint: text(input.quoteMint),
    amountKind: input.amountKind,
    amountUi: finite(input.amountUi),
    balanceBps:
      input.balanceBps == null
        ? null
        : Math.max(1, Math.min(10_000, integer(input.balanceBps, 10_000))),
    slippageBps: Math.max(1, Math.min(10_000, integer(input.slippageBps, 500))),
    mode: input.mode === "live" ? "live" : "paper",
    status:
      input.status === "paper" ||
      input.status === "sending" ||
      input.status === "sent" ||
      input.status === "skipped" ||
      input.status === "failed"
        ? input.status
        : "queued",
    reason: text(input.reason),
    attempts: Math.max(0, integer(input.attempts, 0)),
    nextAttemptAtMs: Math.max(0, integer(input.nextAttemptAtMs, 0)),
    executionSignature: text(input.executionSignature),
    requestJson:
      typeof input.requestJson === "string"
        ? input.requestJson
        : stringify(input.requestJson ?? {}),
    resultJson:
      typeof input.resultJson === "string"
        ? input.resultJson
        : stringify(input.resultJson ?? {}),
    createdAtMs: integer(input.createdAtMs, now),
    updatedAtMs: integer(input.updatedAtMs, now),
  });
  try {
    return {
      row: db.copyTradeIntentsV1.insert(row) as CopyTradeIntent,
      inserted: true,
    };
  } catch (error) {
    if (!isDuplicateCopyTradeIntentError(error)) throw error;
    return {
      row: getCopyTradeIntent(row.intentKey) ?? row,
      inserted: false,
    };
  }
}

export function updateCopyTradeIntent(
  intentKey: string,
  patch: Partial<CopyTradeIntent>,
): CopyTradeIntent {
  const existing = getCopyTradeIntent(intentKey);
  if (!existing) throw new Error(`Unknown copy-trade intent: ${intentKey}`);
  const row = CopyTradeIntentSchema.parse({
    ...existing,
    ...patch,
    intentKey: existing.intentKey,
    updatedAtMs: integer(patch.updatedAtMs, Date.now()),
  });
  return db.copyTradeIntentsV1.upsert(row, {
    on: "intentKey",
    merge: (table) => ({
      status: table.excluded("status"),
      reason: table.excluded("reason"),
      attempts: table.excluded("attempts"),
      nextAttemptAtMs: table.excluded("nextAttemptAtMs"),
      executionSignature: table.excluded("executionSignature"),
      requestJson: table.excludedIfNotEmpty("requestJson"),
      resultJson: table.excludedIfNotEmpty("resultJson"),
      updatedAtMs: table.max("updatedAtMs", 0),
    }),
  }) as CopyTradeIntent;
}

export function listCopyTradeIntents(
  input: {
    profileKey?: string | null;
    leaderWallet?: string | null;
    status?: CopyTradeIntent["status"] | null;
    sinceMs?: number;
    dueAtMs?: number;
    limit?: number;
  } = {},
): CopyTradeIntent[] {
  let query = db.copyTradeIntentsV1.select();
  if (input.profileKey?.trim()) {
    query = query.where({ profileKey: input.profileKey.trim() });
  }
  if (input.leaderWallet?.trim()) {
    query = query.where({ leaderWallet: input.leaderWallet.trim() });
  }
  if (input.status) query = query.where({ status: input.status });
  if (positiveTime(input.sinceMs) > 0) {
    query = query.where({ createdAtMs: { $gte: positiveTime(input.sinceMs) } });
  }
  if (positiveTime(input.dueAtMs) > 0) {
    query = query.where({
      nextAttemptAtMs: { $lte: positiveTime(input.dueAtMs) },
    });
  }
  return query
    .orderBy("createdAtMs", "desc")
    .limit(Math.max(1, Math.min(integer(input.limit, 250), 100_000)))
    .all() as CopyTradeIntent[];
}

export type AppendTokenTradeResult = {
  row: TokenTrade;
  inserted: boolean;
};

function canonicalTradeAmount(value: unknown, digits: number): string {
  const amount = Math.abs(finite(value) ?? 0);
  return amount.toFixed(digits).replace(/\.?0+$/, "");
}

/**
 * Cross-source identity for the same on-chain fill. Source-specific event
 * ordinals remain in rawJson, but cannot create a second aggregate row.
 */
export function canonicalTokenTradeEventKey(input: {
  eventKey: string;
  mint: string;
  signature: string;
  owner?: string | null;
  side?: string | null;
  tokenDeltaUi?: number | null;
  solDeltaUi?: number | null;
}): string {
  const signature = input.signature.trim();
  const mint = input.mint.trim();
  if (!signature || !mint) return input.eventKey;
  const side =
    input.side === "buy" || input.side === "sell" ? input.side : "unknown";
  return [
    "trade-v2",
    signature,
    mint,
    side,
    canonicalTradeAmount(input.tokenDeltaUi, 8),
    canonicalTradeAmount(input.solDeltaUi, 9),
  ].join(":");
}

function confidenceRank(value: TokenTrade["confidence"]): number {
  return value === "finalized"
    ? 3
    : value === "confirmed"
      ? 2
      : value === "processed"
        ? 1
        : 0;
}

function mergeCanonicalTokenTrade(
  existing: TokenTrade,
  incoming: TokenTrade,
): TokenTrade {
  const incomingIsBetter =
    confidenceRank(incoming.confidence) > confidenceRank(existing.confidence) ||
    (incoming.marketCapUsd != null && existing.marketCapUsd == null) ||
    (incoming.priceUsd != null && existing.priceUsd == null) ||
    (incoming.priceSol != null && existing.priceSol == null);
  if (!incomingIsBetter) return existing;
  return db.tokenTradesV2.upsert(incoming, {
    on: "eventKey",
    merge: (table) => ({
      slot: table.max("slot", 0),
      owner: table.excludedIfNotNull("owner"),
      side: table.excludedIfNotEmpty("side"),
      tokenDeltaUi: table.excluded("tokenDeltaUi"),
      solDeltaUi: table.excluded("solDeltaUi"),
      priceSol: table.excludedIfNotNull("priceSol"),
      priceUsd: table.excludedIfNotNull("priceUsd"),
      marketCapUsd: table.excludedIfNotNull("marketCapUsd"),
      confidence: table.excluded("confidence"),
      source: table.excludedIfNotEmpty("source"),
      rawJson: table.excludedIfNotEmpty("rawJson"),
      tradedAtMs: table.max("tradedAtMs", 0),
      updatedAtMs: table.max("updatedAtMs", 0),
    }),
  }) as TokenTrade;
}

export function appendTokenTradeOnce(
  input: Partial<TokenTrade> & {
    eventKey: string;
    mint: string;
    signature: string;
    tradedAtMs: number;
  },
): AppendTokenTradeResult {
  const now = Date.now();
  const eventKey = canonicalTokenTradeEventKey(input);
  const row = TokenTradeSchema.parse({
    ...input,
    eventKey,
    mint: input.mint,
    signature: input.signature,
    slot: integer(input.slot, 0),
    owner: text(input.owner),
    side:
      input.side === "buy" || input.side === "sell" ? input.side : "unknown",
    tokenDeltaUi: finite(input.tokenDeltaUi) ?? 0,
    solDeltaUi: finite(input.solDeltaUi) ?? 0,
    priceSol: finite(input.priceSol),
    priceUsd: finite(input.priceUsd),
    marketCapUsd: finite(input.marketCapUsd),
    confidence: input.confidence ?? "processed",
    source: text(input.source) ?? "unknown",
    rawJson:
      typeof input.rawJson === "string"
        ? input.rawJson
        : stringify({
            sourceEventKey: input.eventKey,
            ...(input.rawJson ?? {}),
          }),
    tradedAtMs: integer(input.tradedAtMs, now),
    updatedAtMs: integer(input.updatedAtMs, now),
  });

  const existing = db.tokenTradesV2
    .select()
    .where({ eventKey })
    .get() as TokenTrade | null;
  if (existing) {
    return { row: mergeCanonicalTokenTrade(existing, row), inserted: false };
  }

  try {
    return {
      row: db.tokenTradesV2.insert(row) as TokenTrade,
      inserted: true,
    };
  } catch (error) {
    if (!isDuplicateTradeError(error)) throw error;
    const raced = db.tokenTradesV2
      .select()
      .where({ eventKey })
      .get() as TokenTrade | null;
    return {
      row: raced ? mergeCanonicalTokenTrade(raced, row) : row,
      inserted: false,
    };
  }
}

export function appendTokenTrade(
  input: Partial<TokenTrade> & {
    eventKey: string;
    mint: string;
    signature: string;
    tradedAtMs: number;
  },
): TokenTrade {
  return appendTokenTradeOnce(input).row;
}

export function getTokenPriceWindows(
  mint: string,
  ttlMs = PRICE_WINDOW_TTL_MS,
): TokenPriceWindows | null {
  const key = mint.trim();
  if (!key) return null;
  return (
    (db.tokenPriceWindowsV9
      .select()
      .where({ mint: key })
      .cache({ ttlMs: Math.max(0, integer(ttlMs, PRICE_WINDOW_TTL_MS)) })
      .get() as TokenPriceWindows | null) ?? null
  );
}

export function listTokenPriceWindows(
  ttlMs = PRICE_WINDOW_TTL_MS,
): TokenPriceWindows[] {
  return db.tokenPriceWindowsV9
    .select()
    .orderBy("latestTradeAtMs", "desc")
    .cache({ ttlMs: Math.max(0, integer(ttlMs, PRICE_WINDOW_TTL_MS)) })
    .all() as TokenPriceWindows[];
}

export function listTokenMarketExtrema(
  mintsOrTtl?: Iterable<string> | number,
  ttlMs = 2_000,
): TokenMarketExtrema[] {
  const loadAll = mintsOrTtl == null || typeof mintsOrTtl === "number";
  const legacyTtl = typeof mintsOrTtl === "number" ? mintsOrTtl : ttlMs;
  const keys = loadAll
    ? []
    : [
        ...new Set(
          [...mintsOrTtl].map((mint) => String(mint).trim()).filter(Boolean),
        ),
      ].slice(0, 5_000);
  const cacheTtlMs = Math.max(0, integer(legacyTtl, 2_000));
  if (!keys.length && !loadAll) return [];
  if (loadAll) {
    return db.tokenMarketExtremaV5
      .select()
      .cache({ ttlMs: cacheTtlMs })
      .all() as TokenMarketExtrema[];
  }
  const rows: TokenMarketExtrema[] = [];
  for (const chunk of chunked(keys, 200)) {
    rows.push(
      ...(db.tokenMarketExtremaV5
        .select()
        .whereIn("mint", chunk)
        .cache({ ttlMs: cacheTtlMs })
        .all() as TokenMarketExtrema[]),
    );
  }
  return rows;
}

export function listTokenHolderWindows(
  mints: Iterable<string>,
  ttlMs = 5_000,
): TokenHolderWindows[] {
  const keys = [
    ...new Set([...mints].map((mint) => String(mint).trim()).filter(Boolean)),
  ].slice(0, 5_000);
  if (!keys.length) return [];
  const rows: TokenHolderWindows[] = [];
  const cacheTtlMs = Math.max(0, integer(ttlMs, 5_000));
  for (const chunk of chunked(keys, 200)) {
    rows.push(
      ...(db.tokenHolderWindowsV2
        .select()
        .whereIn("mint", chunk)
        .cache({ ttlMs: cacheTtlMs })
        .all() as TokenHolderWindows[]),
    );
  }
  return rows;
}

export type CopyTradeTokenContext = {
  mint: string;
  token: TerminalToken | null;
  window: TokenPriceWindows | null;
  holders: TokenHolderWindows | null;
  phase: TerminalToken["phase"] | "unknown";
  source: string;
  isMayhemMode: boolean;
  observedAtMs: number;
  tokenAgeMs: number | null;
  priceUpdatedAtMs: number;
  priceAgeMs: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
};

export function getCopyTradeTokenContext(
  mint: string,
  now = Date.now(),
): CopyTradeTokenContext {
  const key = mint.trim();
  const token = key ? getTerminalToken(key) : null;
  const metrics = key
    ? computeScopedTerminalMetrics(
        [key],
        token ? [token] : [],
        now,
        PRICE_WINDOW_TTL_MS,
      )
    : null;
  const window = key ? (metrics?.windows.get(key) ?? null) : null;
  const holders = key ? (metrics?.holders.get(key) ?? null) : null;

  const observedAtMs = Math.max(
    positiveTime(token?.observedAtMs),
    positiveTime(token?.createdAtMs),
    positiveTime(window?.firstRecordedTradeAtMs),
  );
  const priceUpdatedAtMs = Math.max(
    positiveTime(token?.priceUpdatedAtMs),
    positiveTime(window?.latestTradeAtMs),
  );
  const priceUsd = finite(window?.latestPriceUsd) ?? finite(token?.priceUsd);
  const marketCapUsd =
    finite(window?.currentMarketCapUsd) ??
    finite(window?.latestMarketCapUsd) ??
    finite(token?.marketCapUsd) ??
    (priceUsd != null && finite(token?.supplyUi) != null
      ? priceUsd * Math.max(0, finite(token?.supplyUi) ?? 0)
      : null);

  return {
    mint: key,
    token,
    window,
    holders,
    phase: token?.phase ?? "unknown",
    source: token?.source ?? window?.latestTradeSource ?? "unknown",
    isMayhemMode: Number(token?.isMayhemMode ?? 0) > 0,
    observedAtMs,
    tokenAgeMs: observedAtMs > 0 ? Math.max(0, now - observedAtMs) : null,
    priceUpdatedAtMs,
    priceAgeMs:
      priceUpdatedAtMs > 0 ? Math.max(0, now - priceUpdatedAtMs) : null,
    priceUsd,
    marketCapUsd,
  };
}

export function getTerminalFeedState(
  scope = TERMINAL_FEED_SCOPE,
): TerminalFeedState {
  const existing = db.terminalFeedState
    .select()
    .where({ scope })
    .get() as TerminalFeedState | null;
  if (existing) return existing;
  const now = Date.now();
  return db.terminalFeedState.upsert(
    { scope, resetAtMs: 0, updatedAtMs: now },
    { on: "scope", doNothing: true },
  ) as TerminalFeedState;
}

export function resetTerminalFeed(
  input: {
    scope?: string;
    now?: number;
    pinnedMints?: Iterable<string>;
  } = {},
): {
  state: TerminalFeedState;
  pinnedMints: string[];
  deletedTokens: number;
  deletedTrades: number;
} {
  const scope = text(input.scope) ?? TERMINAL_FEED_SCOPE;
  const pinnedMints = cleanPinnedMints(input.pinnedMints);
  const result = clearTerminalLiveData({ source: "both", pinned: pinnedMints });
  const now = integer(input.now, Date.now());
  const state = db.terminalFeedState.upsert(
    { scope, resetAtMs: now, updatedAtMs: now },
    {
      on: "scope",
      merge: (table) => ({
        resetAtMs: table.excluded("resetAtMs"),
        updatedAtMs: table.excluded("updatedAtMs"),
      }),
    },
  ) as TerminalFeedState;
  return {
    state,
    pinnedMints,
    deletedTokens: result.deletedTokens,
    deletedTrades: result.deletedTrades,
  };
}

export type ObservedHolderPosition = {
  owner: string;
  buySol: number;
  sellSol: number;
  netSpentSol: number;
  boughtTokens: number;
  soldTokens: number;
  netTokens: number;
  buys: number;
  sells: number;
  trades: number;
  firstTradeAtMs: number | null;
  lastTradeAtMs: number | null;
};

type UnifiedTrade = {
  id: string;
  mint: string;
  signature: string;
  slot: number;
  owner: string | null;
  side: "buy" | "sell" | "unknown";
  tokenDeltaUi: number;
  solDeltaUi: number;
  priceSol: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  confidence: TerminalConfidence;
  source: string;
  rawJson: string;
  createdAtMs: number;
  updatedAtMs: number;
};

function normalizeUnifiedTrade(
  row: Record<string, unknown>,
): UnifiedTrade | null {
  const mint = text(row.mint);
  if (!mint) return null;
  const side = row.side === "buy" || row.side === "sell" ? row.side : "unknown";
  const parsedConfidence = ConfidenceSchema.safeParse(row.confidence);
  return {
    id: text(row.tradeKey ?? row.eventKey ?? row.id ?? row.signature) ?? "",
    mint,
    signature: text(row.signature) ?? "",
    slot: integer(row.slot, 0),
    owner: text(row.owner),
    side,
    tokenDeltaUi: finite(row.tokenDeltaUi) ?? 0,
    solDeltaUi: finite(row.solDeltaUi) ?? 0,
    priceSol: finite(row.priceSol),
    priceUsd: finite(row.priceUsd),
    marketCapUsd: finite(row.marketCapUsd),
    confidence: parsedConfidence.success ? parsedConfidence.data : "processed",
    source: text(row.source) ?? "unknown",
    rawJson: text(row.rawJson) ?? "{}",
    createdAtMs: integer(row.createdAtMs ?? row.tradedAtMs, 0),
    updatedAtMs: integer(row.updatedAtMs, 0),
  };
}

function tradeQuality(row: UnifiedTrade): number {
  return (
    (row.marketCapUsd != null ? 8 : 0) +
    (row.priceUsd != null ? 4 : 0) +
    (row.priceSol != null ? 2 : 0) +
    (row.owner ? 1 : 0)
  );
}

function tradeDedupeKey(row: UnifiedTrade): string {
  return [
    row.mint,
    row.signature,
    row.side,
    canonicalTradeAmount(row.tokenDeltaUi, 8),
    canonicalTradeAmount(row.solDeltaUi, 9),
  ].join("|");
}

function loadUnifiedTrades(
  input: {
    sinceMs?: number;
    mints?: string[];
    mint?: string | null;
    owners?: string[];
    source?: string | null;
  } = {},
): UnifiedTrade[] {
  const sinceMs = positiveTime(input.sinceMs);
  const mints = input.mint ? [input.mint] : (input.mints ?? []);
  const owners = input.owners ?? [];
  const combined: UnifiedTrade[] = [];
  const mintChunks = chunked(mints.length ? mints : [""], 200);

  for (const mintChunk of mintChunks) {
    let indexed = db.tokenTradesV2.select();
    let terminal = db.terminalTradesLive.select();
    if (sinceMs > 0) {
      indexed = indexed.where({ tradedAtMs: { $gte: sinceMs } });
      terminal = terminal.where({ createdAtMs: { $gte: sinceMs } });
    }
    if (mints.length) {
      indexed = indexed.whereIn("mint", mintChunk);
      terminal = terminal.whereIn("mint", mintChunk);
    }
    if (owners.length) {
      indexed = indexed.whereIn("owner", owners);
      terminal = terminal.whereIn("owner", owners);
    }

    for (const row of [
      ...indexed.orderBy("tradedAtMs", "desc").all(),
      ...terminal.orderBy("createdAtMs", "desc").all(),
    ]) {
      const normalized = normalizeUnifiedTrade(row as Record<string, unknown>);
      if (normalized && sourceMatches(input.source, normalized.source)) {
        combined.push(normalized);
      }
    }
    if (!mints.length) break;
  }

  const unique = new Map<string, UnifiedTrade>();
  for (const trade of combined) {
    const key = tradeDedupeKey(trade);
    const previous = unique.get(key);
    if (!previous || tradeQuality(trade) > tradeQuality(previous)) {
      unique.set(key, trade);
    }
  }
  return [...unique.values()].sort(
    (left, right) =>
      Math.max(right.createdAtMs, right.updatedAtMs) -
      Math.max(left.createdAtMs, left.updatedAtMs),
  );
}

type ScopedTerminalMetrics = {
  windows: Map<string, TokenPriceWindows>;
  holders: Map<string, TokenHolderWindows>;
  extrema: Map<string, TokenMarketExtrema>;
  latestTrades: Map<string, UnifiedTrade>;
};

const scopedMetricsCache = new Map<
  string,
  { expiresAtMs: number; value: ScopedTerminalMetrics }
>();

function averageFinite(values: Array<number | null>): number | null {
  const finiteValues = values.filter(
    (value): value is number => value != null && Number.isFinite(value),
  );
  return finiteValues.length
    ? finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length
    : null;
}

function scopedMetricCacheKey(mints: string[]): string {
  return [...mints].sort().join(",");
}

/**
 * Computes metrics from indexed, mint-scoped reads. This avoids evaluating the
 * compatibility SQL views across every retained trade on each feed refresh.
 */
function computeScopedTerminalMetrics(
  mints: string[],
  tokens: TerminalToken[],
  now = Date.now(),
  ttlMs = PRICE_WINDOW_TTL_MS,
): ScopedTerminalMetrics {
  const uniqueMints = [
    ...new Set(mints.map((mint) => mint.trim()).filter(Boolean)),
  ];
  const empty: ScopedTerminalMetrics = {
    windows: new Map(),
    holders: new Map(),
    extrema: new Map(),
    latestTrades: new Map(),
  };
  if (!uniqueMints.length) return empty;

  const cacheKey = scopedMetricCacheKey(uniqueMints);
  const cached = scopedMetricsCache.get(cacheKey);
  if (cached && cached.expiresAtMs >= now) return cached.value;

  const tokenByMint = new Map(tokens.map((token) => [token.mint, token]));
  const tradesByMint = new Map<string, UnifiedTrade[]>();
  for (const trade of loadUnifiedTrades({ mints: uniqueMints })) {
    const rows = tradesByMint.get(trade.mint) ?? [];
    rows.push(trade);
    tradesByMint.set(trade.mint, rows);
  }

  const result: ScopedTerminalMetrics = {
    windows: new Map(),
    holders: new Map(),
    extrema: new Map(),
    latestTrades: new Map(),
  };
  const oneMinute = 60_000;
  const fiveMinutes = 300_000;
  const fifteenMinutes = 900_000;
  const thirtyMinutes = 1_800_000;

  for (const mint of uniqueMints) {
    const history = (tradesByMint.get(mint) ?? []).sort(
      (left, right) => right.createdAtMs - left.createdAtMs,
    );
    const recent = history.filter(
      (trade) => trade.createdAtMs >= now - thirtyMinutes,
    );
    const latest = history[0] ?? null;
    if (latest) result.latestTrades.set(mint, latest);

    const inRange = (minimumAgeMs: number, maximumAgeMs = 0) =>
      recent.filter((trade) => {
        const ageMs = now - trade.createdAtMs;
        return ageMs >= maximumAgeMs && ageMs < minimumAgeMs;
      });
    const current1m = inRange(oneMinute);
    const current5m = inRange(fiveMinutes);
    const current15m = inRange(fifteenMinutes);
    const previous1m = inRange(2 * oneMinute, oneMinute);
    const previous5m = inRange(2 * fiveMinutes, fiveMinutes);
    const previous15m = inRange(2 * fifteenMinutes, fifteenMinutes);
    const effectiveVolume = (trade: UnifiedTrade) =>
      Math.abs(trade.solDeltaUi) ||
      Math.abs((trade.priceSol ?? 0) * trade.tokenDeltaUi) ||
      0;
    const sumVolume = (rows: UnifiedTrade[]) =>
      rows.reduce((sum, trade) => sum + effectiveVolume(trade), 0);
    const latestWith = (field: "priceSol" | "priceUsd" | "marketCapUsd") =>
      recent.find((trade) => trade[field] != null)?.[field] ?? null;

    result.windows.set(mint, {
      mint,
      avgPriceUsd1m: averageFinite(current1m.map((trade) => trade.priceUsd)),
      avgPriceUsd5m: averageFinite(current5m.map((trade) => trade.priceUsd)),
      avgPriceUsd15m: averageFinite(current15m.map((trade) => trade.priceUsd)),
      avgMarketCapUsd1m: averageFinite(
        current1m.map((trade) => trade.marketCapUsd),
      ),
      avgMarketCapUsd5m: averageFinite(
        current5m.map((trade) => trade.marketCapUsd),
      ),
      avgMarketCapUsd15m: averageFinite(
        current15m.map((trade) => trade.marketCapUsd),
      ),
      previousAvgMarketCapUsd1m: averageFinite(
        previous1m.map((trade) => trade.marketCapUsd),
      ),
      previousAvgMarketCapUsd5m: averageFinite(
        previous5m.map((trade) => trade.marketCapUsd),
      ),
      previousAvgMarketCapUsd15m: averageFinite(
        previous15m.map((trade) => trade.marketCapUsd),
      ),
      trades1m: current1m.length,
      trades5m: current5m.length,
      trades15m: current15m.length,
      previousTrades1m: previous1m.length,
      previousTrades5m: previous5m.length,
      previousTrades15m: previous15m.length,
      volumeSol1m: sumVolume(current1m),
      volumeSol5m: sumVolume(current5m),
      volumeSol15m: sumVolume(current15m),
      previousVolumeSol1m: sumVolume(previous1m),
      previousVolumeSol5m: sumVolume(previous5m),
      previousVolumeSol15m: sumVolume(previous15m),
      latestPriceSol: latestWith("priceSol"),
      latestPriceUsd: latestWith("priceUsd"),
      latestMarketCapUsd: latestWith("marketCapUsd"),
      currentMarketCapUsd: latestWith("marketCapUsd"),
      latestTradeAtMs: latest?.createdAtMs ?? null,
      latestTradeSource: latest?.source ?? null,
      firstRecordedTradeAtMs: history.reduce<number | null>(
        (earliest, trade) =>
          earliest == null
            ? trade.createdAtMs
            : Math.min(earliest, trade.createdAtMs),
        null,
      ),
    });

    const token = tokenByMint.get(mint);
    const supplyUi = finite(token?.supplyUi) ?? 0;
    const marketCaps = history
      .map(
        (trade) =>
          trade.marketCapUsd ??
          (trade.priceUsd != null && supplyUi > 0
            ? trade.priceUsd * supplyUi
            : null),
      )
      .filter((value): value is number => value != null && value > 0);
    if (token?.marketCapUsd != null && token.marketCapUsd > 0) {
      marketCaps.push(token.marketCapUsd);
    }
    result.extrema.set(mint, {
      mint,
      athMarketCapUsd: marketCaps.reduce<number | null>(
        (maximum, value) =>
          maximum == null ? value : Math.max(maximum, value),
        null,
      ),
      atlMarketCapUsd: marketCaps.reduce<number | null>(
        (minimum, value) =>
          minimum == null ? value : Math.min(minimum, value),
        null,
      ),
    });

    const ownerBalances = new Map<
      string,
      { now: number; one: number; five: number; fifteen: number }
    >();
    for (const trade of history) {
      if (!trade.owner || trade.tokenDeltaUi === 0) continue;
      const delta =
        trade.side === "buy"
          ? Math.abs(trade.tokenDeltaUi)
          : trade.side === "sell"
            ? -Math.abs(trade.tokenDeltaUi)
            : trade.tokenDeltaUi;
      const balances = ownerBalances.get(trade.owner) ?? {
        now: 0,
        one: 0,
        five: 0,
        fifteen: 0,
      };
      balances.now += delta;
      if (trade.createdAtMs <= now - oneMinute) balances.one += delta;
      if (trade.createdAtMs <= now - fiveMinutes) balances.five += delta;
      if (trade.createdAtMs <= now - fifteenMinutes) balances.fifteen += delta;
      ownerBalances.set(trade.owner, balances);
    }
    const balances = [...ownerBalances.values()];
    const countPositive = (field: "now" | "one" | "five" | "fifteen") =>
      balances.filter((row) => row[field] > 0.000000001).length;
    result.holders.set(mint, {
      mint,
      holdersNow: countPositive("now"),
      holders1mAgo: countPositive("one"),
      holders5mAgo: countPositive("five"),
      holders15mAgo: countPositive("fifteen"),
    });
  }

  const cacheTtlMs = Math.max(0, integer(ttlMs, PRICE_WINDOW_TTL_MS));
  scopedMetricsCache.set(cacheKey, {
    expiresAtMs: now + cacheTtlMs,
    value: result,
  });
  if (scopedMetricsCache.size > 32) {
    for (const [key, entry] of scopedMetricsCache) {
      if (entry.expiresAtMs < now || scopedMetricsCache.size > 32) {
        scopedMetricsCache.delete(key);
      }
    }
  }
  return result;
}

export function insertTerminalTrade(
  input: Partial<TerminalTrade> & {
    id: string;
    mint: string;
    signature: string;
  },
): TerminalTrade {
  const now = Date.now();
  const parsedConfidence = ConfidenceSchema.safeParse(input.confidence);
  const row = TerminalTradeSchema.parse({
    tradeKey: input.id,
    mint: input.mint,
    signature: input.signature,
    slot: integer(input.slot, 0),
    owner: text(input.owner),
    side:
      input.side === "buy" || input.side === "sell" ? input.side : "unknown",
    tokenDeltaUi: finite(input.tokenDeltaUi) ?? 0,
    solDeltaUi: finite(input.solDeltaUi) ?? 0,
    priceSol: finite(input.priceSol),
    priceUsd: finite(input.priceUsd),
    marketCapUsd: finite(input.marketCapUsd),
    confidence: parsedConfidence.success ? parsedConfidence.data : "processed",
    source: text(input.source) ?? "unknown",
    rawJson:
      typeof input.rawJson === "string"
        ? input.rawJson
        : stringify(input.rawJson ?? {}),
    createdAtMs: integer(input.createdAtMs, now),
    updatedAtMs: integer(input.updatedAtMs, now),
  });

  const saved = db.terminalTradesLive.upsert(row, {
    on: "tradeKey",
    merge: (table) => ({
      owner: table.excludedIfNotNull("owner"),
      side: table.excludedIfNotEmpty("side"),
      tokenDeltaUi: table.excluded("tokenDeltaUi"),
      solDeltaUi: table.excluded("solDeltaUi"),
      priceSol: table.excludedIfNotNull("priceSol"),
      priceUsd: table.excludedIfNotNull("priceUsd"),
      marketCapUsd: table.excludedIfNotNull("marketCapUsd"),
      confidence: table.excluded("confidence"),
      source: table.excludedIfNotEmpty("source"),
      rawJson: table.excludedIfNotEmpty("rawJson"),
      updatedAtMs: table.max("updatedAtMs", 0),
    }),
  }) as TerminalTradeDbRow;

  return { ...saved, id: saved.tradeKey };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function computeTerminalIndicatorsForMint(
  mint: string,
  now = Date.now(),
): TerminalIndicator[] {
  const token = getTerminalToken(mint);
  const maxIntervalSec = TERMINAL_INDICATOR_INTERVALS.at(-1) ?? 86_400;
  const trades = loadUnifiedTrades({
    mint,
    sinceMs: now - maxIntervalSec * 1_000,
  }).filter((trade) => trade.priceUsd != null);

  return TERMINAL_INDICATOR_INTERVALS.map((intervalSec) => {
    const since = now - intervalSec * 1_000;
    const rows = trades.filter((trade) => trade.createdAtMs >= since);
    const prices = rows
      .map((trade) => trade.priceUsd)
      .filter((value): value is number => value != null && value > 0);
    const volumeSol = rows.reduce(
      (sum, trade) => sum + Math.abs(trade.solDeltaUi),
      0,
    );
    const tokenVolume = rows.reduce(
      (sum, trade) => sum + Math.abs(trade.tokenDeltaUi),
      0,
    );
    const weighted = rows.reduce(
      (sum, trade) =>
        sum + (trade.priceUsd ?? 0) * Math.abs(trade.tokenDeltaUi),
      0,
    );
    const smaPriceUsd = prices.length
      ? prices.reduce((sum, value) => sum + value, 0) / prices.length
      : (token?.priceUsd ?? null);
    const indicatorKey = `${mint}:${intervalSec}`;
    return {
      id: indicatorKey,
      indicatorKey,
      mint,
      intervalSec,
      smaPriceUsd,
      smaMarketCapUsd:
        smaPriceUsd != null
          ? smaPriceUsd * Number(token?.supplyUi ?? 1_000_000_000)
          : (token?.marketCapUsd ?? null),
      vwmaPriceUsd:
        tokenVolume > 0 ? weighted / tokenVolume : (token?.priceUsd ?? null),
      medianPriceUsd: median(prices) ?? token?.priceUsd ?? null,
      tradeCount: rows.length,
      volumeSol,
      updatedAtMs: now,
    };
  });
}

function writeTerminalIndicators(
  indicators: readonly TerminalIndicator[],
): void {
  for (const indicator of indicators) {
    const row = TerminalIndicatorSchema.parse({
      ...indicator,
      indicatorKey: indicator.indicatorKey ?? indicator.id,
    });
    db.terminalIndicatorsLive.upsert(row, {
      on: ["mint", "intervalSec"],
      merge: (table) => ({
        smaPriceUsd: table.excluded("smaPriceUsd"),
        smaMarketCapUsd: table.excluded("smaMarketCapUsd"),
        vwmaPriceUsd: table.excluded("vwmaPriceUsd"),
        medianPriceUsd: table.excluded("medianPriceUsd"),
        tradeCount: table.excluded("tradeCount"),
        volumeSol: table.excluded("volumeSol"),
        updatedAtMs: table.excluded("updatedAtMs"),
      }),
    });
  }
}

export function recomputeTerminalIndicators(
  mint: string,
  now = Date.now(),
): TerminalIndicator[] {
  const indicators = computeTerminalIndicatorsForMint(mint, now);
  db.transaction(() => writeTerminalIndicators(indicators));
  return indicators;
}

export function recomputeTerminalIndicatorsBatch(
  mints: Iterable<string>,
  now = Date.now(),
): TerminalIndicator[] {
  const uniqueMints = [
    ...new Set([...mints].map((mint) => mint.trim()).filter(Boolean)),
  ];
  const indicators = uniqueMints.flatMap((mint) =>
    computeTerminalIndicatorsForMint(mint, now),
  );
  if (indicators.length)
    db.transaction(() => writeTerminalIndicators(indicators));
  return indicators;
}

export function listTerminalTrades(
  input: {
    limit?: number;
    sinceMs?: number;
    mint?: string | null;
    source?: string | null;
  } = {},
): TerminalTrade[] {
  const limit = Math.max(1, Math.min(integer(input.limit, 250), 100_000));
  return loadUnifiedTrades(input)
    .slice(0, limit)
    .map((trade) => ({ ...trade, id: trade.id }));
}

function newestTime(row: Record<string, unknown>): number {
  return Math.max(
    positiveTime(row.lastTradeAtMs),
    positiveTime(row.priceUpdatedAtMs),
    positiveTime(row.updatedAtMs),
    positiveTime(row.observedAtMs),
    positiveTime(row.createdAtMs),
  );
}

function isUsdc(token: TerminalToken): boolean {
  const value = [token.quoteAsset, token.quoteMint].join(" ").toLowerCase();
  return (
    value.includes("usdc") ||
    value.includes("epjfwdd5aufqssqem2qn1xzybapc8g4wegkgzwydt1v")
  );
}

function loadTerminalFeedCandidates(input: {
  minUpdatedAt: number;
  pinnedMints: string[];
  candidateLimit: number;
}): TerminalToken[] {
  const byMint = new Map<string, TerminalToken>();
  const add = (rows: Record<string, unknown>[]) => {
    for (const raw of rows) {
      const token = normalizeTerminalToken(raw);
      if (!token) continue;
      const previous = byMint.get(token.mint);
      if (!previous || newestTime(token) > newestTime(previous)) {
        byMint.set(token.mint, token);
      }
    }
  };
  const threshold = Math.max(0, input.minUpdatedAt);
  const limit = Math.max(1, input.candidateLimit);

  add(
    db.terminalTokensLive
      .select()
      .where({ updatedAtMs: { $gte: threshold } })
      .orderBy("updatedAtMs", "desc")
      .limit(limit)
      .all() as Record<string, unknown>[],
  );
  add(
    db.terminalTokensLive
      .select()
      .where({ priceUpdatedAtMs: { $gte: threshold } })
      .orderBy("priceUpdatedAtMs", "desc")
      .limit(limit)
      .all() as Record<string, unknown>[],
  );
  add(
    db.terminalTokensLive
      .select()
      .where({ observedAtMs: { $gte: threshold } })
      .orderBy("observedAtMs", "desc")
      .limit(limit)
      .all() as Record<string, unknown>[],
  );

  for (const chunk of chunked(input.pinnedMints, 200)) {
    if (!chunk.length) continue;
    add(
      db.terminalTokensLive.select().whereIn("mint", chunk).all() as Record<
        string,
        unknown
      >[],
    );
  }

  return [...byMint.values()]
    .sort((left, right) => newestTime(right) - newestTime(left))
    .slice(0, limit);
}

export function listTerminalFeed(
  input: {
    limit?: number;
    sinceMs?: number;
    activeWindowMs?: number;
    includeUnpriced?: boolean;
    source?: string | null;
    minMarketCapUsd?: number;
    maxMarketCapUsd?: number;
    priceWindowTtlMs?: number;
    pinnedMints?: Iterable<string>;
    pinned?: string[];
    hideMayhem?: boolean;
    hideUsdc?: boolean;
    includeMetrics?: boolean;
  } = {},
): TerminalFeedRow[] {
  const now = Date.now();
  const pinnedMints = cleanPinnedMints(input.pinnedMints ?? input.pinned);
  const pinnedSet = new Set(pinnedMints);
  const requestedLimit = Math.max(
    1,
    Math.min(integer(input.limit, 160), 5_000),
  );
  const minUpdatedAt = Math.max(
    positiveTime(input.sinceMs),
    positiveTime(input.activeWindowMs) > 0
      ? now - positiveTime(input.activeWindowMs)
      : 0,
  );
  const configuredCandidateLimit = Math.max(
    500,
    integer(process.env.SOLARD_TERMINAL_FEED_MAX_CANDIDATES, 5_000),
  );
  const candidateLimit = Math.min(
    configuredCandidateLimit,
    Math.max(requestedLimit * 8, 500, pinnedMints.length),
  );
  const includeMetrics = input.includeMetrics !== false;

  const tokens = loadTerminalFeedCandidates({
    minUpdatedAt,
    pinnedMints,
    candidateLimit,
  }).filter((token) => {
    if (pinnedSet.has(token.mint)) return true;
    if (minUpdatedAt > 0 && newestTime(token) < minUpdatedAt) return false;
    if (!sourceMatches(input.source, token.source)) return false;
    if (input.hideMayhem && token.isMayhemMode > 0) return false;
    if (input.hideUsdc && isUsdc(token)) return false;
    return true;
  });
  const mints = tokens.map((token) => token.mint);

  const metricTtlMs = Math.max(
    0,
    integer(input.priceWindowTtlMs, PRICE_WINDOW_TTL_MS),
  );
  const metrics = includeMetrics
    ? computeScopedTerminalMetrics(mints, tokens, now, metricTtlMs)
    : {
        windows: new Map<string, TokenPriceWindows>(),
        holders: new Map<string, TokenHolderWindows>(),
        extrema: new Map<string, TokenMarketExtrema>(),
        latestTrades: new Map<string, UnifiedTrade>(),
      };
  const windows = metrics.windows;
  const holders = metrics.holders;
  const extrema = metrics.extrema;
  const latestTrades = metrics.latestTrades;

  const minMcap = Math.max(0, finite(input.minMarketCapUsd) ?? 0);
  const maxMcap = Math.max(0, finite(input.maxMarketCapUsd) ?? 0);

  const rows = tokens
    .map((token) => {
      const window = windows.get(token.mint);
      const holder = holders.get(token.mint);
      const extremes = extrema.get(token.mint);
      const latest = latestTrades.get(token.mint);
      const supplyUi = finite(token.supplyUi) ?? 1_000_000_000;
      const priceSol = latest?.priceSol ?? token.priceSol;
      const priceUsd = latest?.priceUsd ?? token.priceUsd;
      const marketCapUsd =
        latest?.marketCapUsd ??
        token.marketCapUsd ??
        (priceUsd != null && supplyUi > 0 ? priceUsd * supplyUi : null);
      const marketCapSol =
        priceSol != null && supplyUi > 0
          ? priceSol * supplyUi
          : token.marketCapSol;
      const lastTradeAtMs =
        latest?.createdAtMs ?? window?.latestTradeAtMs ?? null;
      const priceUpdatedAtMs = Math.max(
        latest &&
          (latest.priceSol != null ||
            latest.priceUsd != null ||
            latest.marketCapUsd != null)
          ? latest.createdAtMs
          : 0,
        token.priceUpdatedAtMs,
      );
      const dataCoverageStartedAtMs = Math.max(
        token.createdAtMs,
        token.observedAtMs,
        window?.firstRecordedTradeAtMs ?? 0,
      );

      return {
        ...token,
        priceSol,
        priceUsd,
        marketCapSol,
        marketCapUsd,
        sma1m: window?.avgMarketCapUsd1m ?? marketCapUsd,
        sma5m: window?.avgMarketCapUsd5m ?? marketCapUsd,
        sma15m: window?.avgMarketCapUsd15m ?? marketCapUsd,
        previousSma1m: window?.previousAvgMarketCapUsd1m ?? null,
        previousSma5m: window?.previousAvgMarketCapUsd5m ?? null,
        previousSma15m: window?.previousAvgMarketCapUsd15m ?? null,
        avgPriceUsd1m: window?.avgPriceUsd1m ?? null,
        avgPriceUsd5m: window?.avgPriceUsd5m ?? null,
        avgPriceUsd15m: window?.avgPriceUsd15m ?? null,
        tradeCount: window?.trades15m ?? 0,
        trades1m: window?.trades1m ?? 0,
        trades5m: window?.trades5m ?? 0,
        trades15m: window?.trades15m ?? 0,
        previousTrades1m: window?.previousTrades1m ?? 0,
        previousTrades5m: window?.previousTrades5m ?? 0,
        previousTrades15m: window?.previousTrades15m ?? 0,
        volumeSol1m: window?.volumeSol1m ?? 0,
        volumeSol5m: window?.volumeSol5m ?? 0,
        volumeSol15m: window?.volumeSol15m ?? 0,
        previousVolumeSol1m: window?.previousVolumeSol1m ?? 0,
        previousVolumeSol5m: window?.previousVolumeSol5m ?? 0,
        previousVolumeSol15m: window?.previousVolumeSol15m ?? 0,
        holdersNow: holder?.holdersNow ?? 0,
        holders1mAgo: holder?.holders1mAgo ?? 0,
        holders5mAgo: holder?.holders5mAgo ?? 0,
        holders15mAgo: holder?.holders15mAgo ?? 0,
        athMarketCapUsd: extremes?.athMarketCapUsd ?? marketCapUsd,
        atlMarketCapUsd: extremes?.atlMarketCapUsd ?? marketCapUsd,
        lastTradeAtMs,
        latestTradeSource: latest?.source ?? window?.latestTradeSource ?? null,
        dataCoverageStartedAtMs: dataCoverageStartedAtMs || null,
        priceUpdatedAtMs: priceUpdatedAtMs || 0,
        priceAgeMs:
          priceUpdatedAtMs > 0 ? Math.max(0, now - priceUpdatedAtMs) : null,
        priceStatus:
          priceUpdatedAtMs <= 0
            ? "missing"
            : now - priceUpdatedAtMs > 30_000
              ? "stale"
              : "live",
        updatedAtMs: Math.max(
          token.updatedAtMs,
          latest?.createdAtMs ?? 0,
          latest?.updatedAtMs ?? 0,
        ),
        raw: token,
      } satisfies TerminalFeedRow;
    })
    .filter((row) => {
      if (pinnedSet.has(row.mint)) return true;
      if (minUpdatedAt > 0 && newestTime(row) < minUpdatedAt) return false;
      const mcap = finite(row.marketCapUsd);
      if (
        input.includeUnpriced === false &&
        mcap == null &&
        finite(row.priceSol) == null &&
        finite(row.priceUsd) == null
      ) {
        return false;
      }
      if (minMcap > 0 && (mcap == null || mcap < minMcap)) return false;
      if (maxMcap > 0 && (mcap == null || mcap > maxMcap)) return false;
      return true;
    })
    .sort((left, right) => {
      const leftPinned = pinnedSet.has(left.mint);
      const rightPinned = pinnedSet.has(right.mint);
      if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
      return newestTime(right) - newestTime(left);
    });

  return rows.slice(0, requestedLimit);
}

export function listObservedHolderPositions(input: {
  mint: string;
  owners: Iterable<string>;
}): ObservedHolderPosition[] {
  const mint = text(input.mint) ?? "";
  const owners = [
    ...new Set([...input.owners].map((owner) => owner.trim()).filter(Boolean)),
  ].slice(0, 100);
  if (!mint || !owners.length) return [];
  const trades = loadUnifiedTrades({ mint, owners }).sort(
    (left, right) => left.createdAtMs - right.createdAtMs,
  );
  const positions = new Map<string, ObservedHolderPosition>();

  for (const trade of trades) {
    if (!trade.owner) continue;
    const current = positions.get(trade.owner) ?? {
      owner: trade.owner,
      buySol: 0,
      sellSol: 0,
      netSpentSol: 0,
      boughtTokens: 0,
      soldTokens: 0,
      netTokens: 0,
      buys: 0,
      sells: 0,
      trades: 0,
      firstTradeAtMs: null,
      lastTradeAtMs: null,
    };
    const sol = Math.abs(trade.solDeltaUi);
    const tokens = Math.abs(trade.tokenDeltaUi);
    if (trade.side === "buy") {
      current.buySol += sol;
      current.boughtTokens += tokens;
      current.buys++;
    } else if (trade.side === "sell") {
      current.sellSol += sol;
      current.soldTokens += tokens;
      current.sells++;
    }
    current.trades++;
    current.firstTradeAtMs =
      current.firstTradeAtMs == null
        ? trade.createdAtMs
        : Math.min(current.firstTradeAtMs, trade.createdAtMs);
    current.lastTradeAtMs =
      current.lastTradeAtMs == null
        ? trade.createdAtMs
        : Math.max(current.lastTradeAtMs, trade.createdAtMs);
    current.netSpentSol = current.buySol - current.sellSol;
    current.netTokens = current.boughtTokens - current.soldTokens;
    positions.set(trade.owner, current);
  }
  return owners.map(
    (owner) =>
      positions.get(owner) ?? {
        owner,
        buySol: 0,
        sellSol: 0,
        netSpentSol: 0,
        boughtTokens: 0,
        soldTokens: 0,
        netTokens: 0,
        buys: 0,
        sells: 0,
        trades: 0,
        firstTradeAtMs: null,
        lastTradeAtMs: null,
      },
  );
}

export function upsertProcessStatus(
  input: Partial<ProcessStatus> & {
    name: string;
    kind: string;
    status: string;
    data?: Record<string, unknown>;
    error?: unknown;
  },
): ProcessStatus {
  const now = Date.now();
  const existing = db.processStatus
    .select()
    .where({ name: input.name })
    .get() as ProcessStatus | null;
  const mergedData = {
    ...parseJson(existing?.dataJson, {}),
    ...(input.data ?? {}),
  };
  const row = ProcessStatusSchema.parse({
    name: input.name,
    kind: input.kind,
    status: input.status,
    heartbeatAtMs: integer(input.heartbeatAtMs, now),
    pid: integer(input.pid, process.pid),
    buildId: text(input.buildId) ?? text((input.data ?? {}).buildId),
    error:
      input.error == null
        ? null
        : input.error instanceof Error
          ? input.error.message
          : String(input.error),
    dataJson:
      typeof input.dataJson === "string"
        ? input.dataJson
        : stringify(mergedData),
    updatedAtMs: integer(input.updatedAtMs, now),
  });
  return db.processStatus.upsert(row, {
    on: "name",
    merge: (table) => ({
      kind: table.excluded("kind"),
      status: table.excluded("status"),
      heartbeatAtMs: table.max("heartbeatAtMs", 0),
      pid: table.excluded("pid"),
      buildId: table.excludedIfNotNull("buildId"),
      error: table.excluded("error"),
      dataJson: table.excluded("dataJson"),
      updatedAtMs: table.max("updatedAtMs", 0),
    }),
  }) as ProcessStatus;
}

export function listProcessStatus(
  limit = 50,
): Array<ProcessStatus & { data: Record<string, unknown> }> {
  return (
    db.processStatus
      .select()
      .orderBy("heartbeatAtMs", "desc")
      .limit(Math.max(1, Math.min(integer(limit, 50), 250)))
      .all() as ProcessStatus[]
  ).map((row) => ({
    ...row,
    data: parseJson(row.dataJson, {}),
  }));
}

export function recordWorkerError(
  worker: string,
  error: unknown,
  data: Record<string, unknown> = {},
): WorkerError {
  const now = Date.now();
  const value = error instanceof Error ? error : new Error(String(error));
  const row = WorkerErrorSchema.parse({
    errorKey: `${worker}:${now}:${Math.random().toString(36).slice(2, 10)}`,
    worker,
    message: value.message,
    stack: value.stack ?? null,
    dataJson: stringify(data),
    createdAtMs: now,
  });
  try {
    return db.workerErrors.insert(row) as WorkerError;
  } catch (writeError) {
    if (isSqliteBusyError(writeError)) {
      console.error(`[solard:indexer] ${worker}: ${value.message}`);
      return row;
    }
    throw writeError;
  }
}

export function listWorkerErrors(
  input: { worker?: string | null; limit?: number } = {},
): WorkerError[] {
  let query = db.workerErrors
    .select()
    .orderBy("createdAtMs", "desc")
    .limit(Math.max(1, Math.min(integer(input.limit, 25), 250)));
  if (input.worker) query = query.where({ worker: input.worker });
  return query.all() as WorkerError[];
}

export function getCursor(key: string): string | null {
  const row = db.workerCursors.select().where({ key }).get() as z.infer<
    typeof WorkerCursorSchema
  > | null;
  return row?.value ?? null;
}

export function setCursor(key: string, value: string): void {
  db.workerCursors.upsert(
    { key, value, updatedAtMs: Date.now() },
    {
      on: "key",
      merge: (table) => ({
        value: table.excluded("value"),
        updatedAtMs: table.excluded("updatedAtMs"),
      }),
    },
  );
}

let writeQueue: Promise<unknown> = Promise.resolve();

export async function dbWrite<T>(label: string, fn: () => T): Promise<T> {
  const execute = async (): Promise<T> => {
    let attempt = 0;
    while (true) {
      try {
        return fn();
      } catch (error) {
        if (!isSqliteBusyError(error) || attempt >= 5) throw error;
        await sleep(Math.min(500, 20 * 2 ** attempt++));
      }
    }
  };
  const result = writeQueue.then(execute, execute);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function withTerminalDbTransaction<T>(fn: () => T): T {
  return db.transaction(fn);
}

export async function dbWriteBatch<T>(label: string, fn: () => T): Promise<T> {
  return dbWrite(label, () => db.transaction(fn));
}

export function initTerminalStore(): void {
  // Database construction owns table/view creation and migrations.
}

export type TerminalHistoryPruneResult = {
  cutoffMs: number;
  tokenCutoffMs: number;
  deletedIndexedTrades: number;
  deletedTerminalTrades: number;
  deletedIndicators: number;
  deletedTokens: number;
  deletedWorkerErrors: number;
  deletedSignals: number;
  staleTokenBatchFull: boolean;
};

/** Keeps terminal/indexer tables bounded without touching wallet/copy audit data. */
export function pruneTerminalHistory(
  input: {
    now?: number;
    tradeRetentionMs?: number;
    tokenRetentionMs?: number;
    workerErrorRetentionMs?: number;
    signalRetentionMs?: number;
    tokenBatchSize?: number;
  } = {},
): TerminalHistoryPruneResult {
  const now = positiveTime(input.now) || Date.now();
  const tradeRetentionMs = Math.max(
    60 * 60_000,
    integer(
      input.tradeRetentionMs ?? process.env.SOLARD_TRADE_RETENTION_MS,
      7 * 24 * 60 * 60_000,
    ),
  );
  const tokenRetentionMs = Math.max(
    tradeRetentionMs,
    integer(
      input.tokenRetentionMs ?? process.env.SOLARD_TOKEN_RETENTION_MS,
      14 * 24 * 60 * 60_000,
    ),
  );
  const workerErrorRetentionMs = Math.max(
    24 * 60 * 60_000,
    integer(
      input.workerErrorRetentionMs ??
        process.env.SOLARD_WORKER_ERROR_RETENTION_MS,
      14 * 24 * 60 * 60_000,
    ),
  );
  const signalRetentionMs = Math.max(
    24 * 60 * 60_000,
    integer(
      input.signalRetentionMs ?? process.env.SOLARD_SIGNAL_RETENTION_MS,
      30 * 24 * 60 * 60_000,
    ),
  );
  const cutoffMs = now - tradeRetentionMs;
  const tokenCutoffMs = now - tokenRetentionMs;
  const tokenBatchSize = Math.max(
    100,
    Math.min(integer(input.tokenBatchSize, 2_000), 10_000),
  );
  const staleTokens = db.terminalTokensLive
    .select("mint")
    .where({ updatedAtMs: { $lt: tokenCutoffMs } })
    .orderBy("updatedAtMs", "asc")
    .limit(tokenBatchSize)
    .all() as Array<{ mint: string }>;
  const staleMints = staleTokens.map((row) => row.mint).filter(Boolean);

  let deletedIndexedTrades = 0;
  let deletedTerminalTrades = 0;
  let deletedIndicators = 0;
  let deletedTokens = 0;
  let deletedWorkerErrors = 0;
  let deletedSignals = 0;

  db.transaction(() => {
    deletedIndexedTrades = db.tokenTradesV2
      .delete()
      .where({ tradedAtMs: { $lt: cutoffMs } })
      .exec();
    deletedTerminalTrades = db.terminalTradesLive
      .delete()
      .where({ createdAtMs: { $lt: cutoffMs } })
      .exec();
    deletedIndicators = db.terminalIndicatorsLive
      .delete()
      .where({ updatedAtMs: { $lt: cutoffMs } })
      .exec();
    deletedWorkerErrors = db.workerErrors
      .delete()
      .where({ createdAtMs: { $lt: now - workerErrorRetentionMs } })
      .exec();
    deletedSignals = db.telegramSignals
      .delete()
      .where({ receivedAtMs: { $lt: now - signalRetentionMs } })
      .exec();

    for (const chunk of chunked(staleMints, 200)) {
      deletedIndexedTrades += db.tokenTradesV2
        .delete()
        .where({ mint: { $in: chunk } })
        .exec();
      deletedTerminalTrades += db.terminalTradesLive
        .delete()
        .where({ mint: { $in: chunk } })
        .exec();
      deletedIndicators += db.terminalIndicatorsLive
        .delete()
        .where({ mint: { $in: chunk } })
        .exec();
      deletedTokens += db.terminalTokensLive
        .delete()
        .where({ mint: { $in: chunk } })
        .exec();
    }
  });

  return {
    cutoffMs,
    tokenCutoffMs,
    deletedIndexedTrades,
    deletedTerminalTrades,
    deletedIndicators,
    deletedTokens,
    deletedWorkerErrors,
    deletedSignals,
    staleTokenBatchFull: staleMints.length >= tokenBatchSize,
  };
}

export function clearTerminalLiveData(
  input: {
    source?: string | null;
    keepSignals?: boolean;
    pinned?: string[];
  } = {},
): {
  resetAtMs: number;
  deletedTokens: number;
  deletedTrades: number;
  deletedIndexedTrades: number;
  deletedTerminalTrades: number;
  deletedIndicators: number;
  pinned: string[];
} {
  const pinned = cleanPinnedMints(input.pinned);
  const pinnedSet = new Set(pinned);
  const tokens = (
    db.terminalTokensLive.select().all() as Record<string, unknown>[]
  )
    .map(normalizeTerminalToken)
    .filter((token): token is TerminalToken => token != null)
    .filter((token) => sourceMatches(input.source, token.source));
  const deletedMints = tokens
    .map((token) => token.mint)
    .filter((mint) => !pinnedSet.has(mint));
  const resetAtMs = Date.now();
  let deletedTokens = 0;
  let deletedIndexedTrades = 0;
  let deletedTerminalTrades = 0;
  let deletedIndicators = 0;

  db.transaction(() => {
    for (const mintChunk of chunked(deletedMints)) {
      deletedIndexedTrades += db.tokenTradesV2
        .delete()
        .where({ mint: { $in: mintChunk } })
        .exec();
      deletedTerminalTrades += db.terminalTradesLive
        .delete()
        .where({ mint: { $in: mintChunk } })
        .exec();
      deletedIndicators += db.terminalIndicatorsLive
        .delete()
        .where({ mint: { $in: mintChunk } })
        .exec();
      deletedTokens += db.terminalTokensLive
        .delete()
        .where({ mint: { $in: mintChunk } })
        .exec();
    }
    if (
      !input.keepSignals &&
      (!input.source || String(input.source).includes("both"))
    ) {
      db.telegramSignals
        .delete()
        .where({ receivedAtMs: { $gte: 0 } })
        .exec();
    }
    db.terminalFeedState.upsert(
      { scope: TERMINAL_FEED_SCOPE, resetAtMs, updatedAtMs: resetAtMs },
      {
        on: "scope",
        merge: (table) => ({
          resetAtMs: table.excluded("resetAtMs"),
          updatedAtMs: table.excluded("updatedAtMs"),
        }),
      },
    );
  });

  return {
    resetAtMs,
    deletedTokens,
    deletedTrades: deletedIndexedTrades + deletedTerminalTrades,
    deletedIndexedTrades,
    deletedTerminalTrades,
    deletedIndicators,
    pinned,
  };
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
  input: {
    limit?: number;
    source?: string | null;
    activeWindowMs?: number;
    includeMigrated?: boolean;
  } = {},
): TerminalCurveSnapshotCandidate[] {
  const limit = Math.max(1, Math.min(integer(input.limit, 80), 500));
  const activeWindowMs = Math.max(
    0,
    integer(
      input.activeWindowMs,
      Number(process.env.SOLARD_CURVE_SNAPSHOT_ACTIVE_WINDOW_MS ?? "0"),
    ),
  );
  const minUpdatedAt = activeWindowMs > 0 ? Date.now() - activeWindowMs : 0;
  return (
    db.terminalTokensLive
      .select()
      .orderBy("updatedAtMs", "asc")
      .all() as Record<string, unknown>[]
  )
    .map(normalizeTerminalToken)
    .filter((token): token is TerminalToken => token != null)
    .filter((token) => token.updatedAtMs >= minUpdatedAt)
    .filter((token) => sourceMatches(input.source, token.source))
    .filter((token) => input.includeMigrated || token.phase !== "migrated")
    .slice(0, limit)
    .map((token) => ({
      mint: token.mint,
      bondingCurveKey: token.bondingCurveKey,
      supplyUi: token.supplyUi,
      marketCapUsd: token.marketCapUsd,
      priceUsd: token.priceUsd,
      updatedAtMs: token.updatedAtMs,
      source: token.source,
      phase: token.phase,
    }));
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
  const source = text(input.source) ?? "curve-snapshot";
  const token = upsertTerminalToken({
    mint: input.mint,
    bondingCurveKey: input.bondingCurveKey,
    creator: input.creator,
    source,
    phase: input.complete ? "migrated" : "pump",
    priceSol: input.priceSol,
    priceUsd: input.priceUsd,
    marketCapSol: input.marketCapSol,
    marketCapUsd: input.marketCapUsd,
    lastSlot: input.slot,
    updatedAtMs: now,
  });
  upsertProcessStatus({
    name: "solard-curve-snapshot-last",
    kind: "snapshot",
    status: input.complete ? "complete" : "updated",
    data: { ...input, source },
  });
  return token;
}

export function pendingTradeSignatures(limit = 100): string[] {
  return [
    ...new Set(
      (
        db.terminalTradesLive
          .select()
          .orderBy("updatedAtMs", "asc")
          .all() as TerminalTradeDbRow[]
      )
        .filter(
          (trade) =>
            trade.confidence === "processed" ||
            trade.confidence === "confirmed",
        )
        .map((trade) => trade.signature)
        .filter(Boolean),
    ),
  ].slice(0, Math.max(1, integer(limit, 100)));
}

export function updateTradeConfidence(
  signature: string,
  confidence: TerminalConfidence,
): void {
  db.terminalTradesLive
    .update({ confidence, updatedAtMs: Date.now() })
    .where({ signature })
    .exec();
}

export function listTerminalTokensNeedingMetadata(
  limit = 20,
): Array<
  Pick<
    TerminalToken,
    "mint" | "uri" | "name" | "symbol" | "image" | "updatedAtMs"
  >
> {
  return (
    db.terminalTokensLive
      .select()
      .orderBy("updatedAtMs", "desc")
      .all() as Record<string, unknown>[]
  )
    .map(normalizeTerminalToken)
    .filter((token): token is TerminalToken => token != null)
    .filter(
      (token) =>
        !token.image || !displayText(token.name) || !displayText(token.symbol),
    )
    .slice(0, Math.max(1, Math.min(integer(limit, 20), 100)))
    .map(({ mint, uri, name, symbol, image, updatedAtMs }) => ({
      mint,
      uri,
      name,
      symbol,
      image,
      updatedAtMs,
    }));
}

export function insertTerminalProbeRow(
  input: { source?: string | null; now?: number } = {},
): Record<string, unknown> {
  const now = input.now ?? Date.now();
  const helius = String(input.source ?? "pumpportal")
    .toLowerCase()
    .includes("helius");
  const source = helius ? "helius-probe" : "pumpportal-probe";
  const mint = helius
    ? "So11111111111111111111111111111111111111112"
    : "11111111111111111111111111111111";
  const marketCapUsd = helius ? 43_210 : 32_100;
  const token = upsertTerminalToken({
    mint,
    symbol: helius ? "H-PROBE" : "P-PROBE",
    name: helius ? "Helius probe row" : "PumpPortal probe row",
    source,
    phase: "pump",
    priceUsd: marketCapUsd / 1_000_000_000,
    marketCapUsd,
    initialMarketCapUsd: marketCapUsd,
    signature: `probe-${source}-${now}`,
    createdAtMs: now,
    observedAtMs: now,
    updatedAtMs: now,
  });
  const trade = insertTerminalTrade({
    id: `probe:${source}:${now}`,
    mint,
    signature: `probe-${source}-${now}`,
    source,
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
  const row = TelegramSignalSchema.parse({
    signalKey: input.id,
    sourceId: input.sourceId ?? null,
    sourceName: input.sourceName ?? null,
    chatRef: input.chatRef ?? null,
    text: input.text,
    mintsJson: stringify(input.mints),
    symbolsJson: stringify(input.symbols ?? []),
    urlsJson: stringify(input.urls ?? []),
    status: "new",
    receivedAtMs: input.receivedAtMs ?? Date.now(),
    rawJson: stringify(input.raw ?? {}),
  });
  const saved = db.telegramSignals.upsert(row, {
    on: "signalKey",
    merge: (table) => ({
      status: table.excluded("status"),
      receivedAtMs: table.excluded("receivedAtMs"),
      rawJson: table.excluded("rawJson"),
    }),
  }) as TelegramSignalDbRow;
  for (const mint of input.mints) {
    upsertTerminalToken({
      mint,
      symbol: input.symbols?.[0] ?? "",
      name: input.symbols?.[0] ?? "telegram signal",
      source: "telegram-signal",
      observedAtMs: row.receivedAtMs,
      updatedAtMs: row.receivedAtMs,
    });
  }
  return { ...saved, id: saved.signalKey };
}

export function listTelegramSignals(
  limit = 100,
): Array<
  TelegramSignal & { mints: string[]; symbols: string[]; urls: string[] }
> {
  return (
    db.telegramSignals
      .select()
      .orderBy("receivedAtMs", "desc")
      .limit(Math.max(1, integer(limit, 100)))
      .all() as TelegramSignalDbRow[]
  ).map((row) => ({
    ...row,
    id: row.signalKey,
    mints: parseJson<string[]>(row.mintsJson, []),
    symbols: parseJson<string[]>(row.symbolsJson, []),
    urls: parseJson<string[]>(row.urlsJson, []),
  }));
}

export type TerminalLatestActivity = {
  token: Pick<
    TerminalToken,
    | "mint"
    | "symbol"
    | "name"
    | "image"
    | "marketCapUsd"
    | "priceUsd"
    | "source"
    | "updatedAtMs"
  > | null;
  pricedToken: Pick<
    TerminalToken,
    | "mint"
    | "symbol"
    | "name"
    | "image"
    | "marketCapUsd"
    | "priceUsd"
    | "source"
    | "updatedAtMs"
  > | null;
  imagedToken: Pick<
    TerminalToken,
    | "mint"
    | "symbol"
    | "name"
    | "image"
    | "marketCapUsd"
    | "priceUsd"
    | "source"
    | "updatedAtMs"
  > | null;
  trade: {
    mint: string;
    side: "buy" | "sell" | "unknown";
    marketCapUsd: number | null;
    priceUsd: number | null;
    createdAtMs: number;
  } | null;
  signal: {
    sourceName: string | null;
    text: string;
    receivedAtMs: number;
  } | null;
};

type TerminalLatestToken = NonNullable<TerminalLatestActivity["token"]>;

function terminalLatestTokenRow(token: TerminalToken): TerminalLatestToken {
  return {
    mint: token.mint,
    symbol: token.symbol,
    name: token.name,
    image: token.image,
    marketCapUsd: token.marketCapUsd,
    priceUsd: token.priceUsd,
    source: token.source,
    updatedAtMs: token.updatedAtMs,
  };
}

/**
 * ORM-only replacement for the old terminal-health raw SELECT statements.
 * This deliberately exposes a narrow, normalized snapshot rather than the
 * database object so callers cannot fall back to raw SQL.
 */
export function terminalLatestActivity(): TerminalLatestActivity {
  const tokens = (
    db.terminalTokensLive
      .select()
      .orderBy("updatedAtMs", "desc")
      .all() as Record<string, unknown>[]
  )
    .map(normalizeTerminalToken)
    .filter((token): token is TerminalToken => token != null);

  const latestTrade =
    (
      db.terminalTradesLive
        .select()
        .orderBy("createdAtMs", "desc")
        .limit(1)
        .all() as Record<string, unknown>[]
    )
      .map(normalizeUnifiedTrade)
      .find((trade): trade is UnifiedTrade => trade != null) ?? null;

  const latestSignal =
    (
      db.telegramSignals
        .select()
        .orderBy("receivedAtMs", "desc")
        .limit(1)
        .all() as Record<string, unknown>[]
    )[0] ?? null;

  const pricedToken = tokens.find(
    (token) => token.marketCapUsd != null || token.priceUsd != null,
  );
  const imagedToken = tokens.find((token) => Boolean(token.image?.trim()));

  return {
    token: tokens[0] ? terminalLatestTokenRow(tokens[0]) : null,
    pricedToken: pricedToken ? terminalLatestTokenRow(pricedToken) : null,
    imagedToken: imagedToken ? terminalLatestTokenRow(imagedToken) : null,
    trade: latestTrade
      ? {
          mint: latestTrade.mint,
          side: latestTrade.side,
          marketCapUsd: latestTrade.marketCapUsd,
          priceUsd: latestTrade.priceUsd,
          createdAtMs: latestTrade.createdAtMs,
        }
      : null,
    signal: latestSignal
      ? {
          sourceName: text(latestSignal.sourceName),
          text: text(latestSignal.text) ?? "",
          receivedAtMs: integer(latestSignal.receivedAtMs, 0),
        }
      : null,
  };
}

/** Database-only health payload for feed endpoints. Runtime/process health lives
 * on /api/terminal/health and must not be pulled into feed module evaluation. */
export function terminalDatabaseHealth(): Record<string, unknown> {
  return {
    ok: true,
    databaseOnly: true,
    store: terminalStoreStats(),
    latest: terminalLatestActivity(),
  };
}

export function terminalStoreStats(
  _input: { pinnedMints?: Iterable<string> } = {},
): Record<string, unknown> {
  const tokens = (
    db.terminalTokensLive.select().all() as Record<string, unknown>[]
  )
    .map(normalizeTerminalToken)
    .filter((token): token is TerminalToken => token != null);
  const bySource = new Map<
    string,
    {
      source: string;
      tokens: number;
      priced: number;
      images: number;
      latest: number | null;
    }
  >();
  for (const token of tokens) {
    const source = token.source || "unknown";
    const current = bySource.get(source) ?? {
      source,
      tokens: 0,
      priced: 0,
      images: 0,
      latest: null,
    };
    current.tokens++;
    if (
      token.marketCapUsd != null ||
      token.priceUsd != null ||
      token.priceSol != null
    ) {
      current.priced++;
    }
    if (token.image) current.images++;
    current.latest = Math.max(current.latest ?? 0, token.updatedAtMs) || null;
    bySource.set(source, current);
  }
  const feedState = getTerminalFeedState();
  return {
    dbPath: SOLARD_DB_PATH,
    tokens: tokens.length,
    storedTokens: tokens.length,
    pricedTokens: tokens.filter(
      (token) => token.marketCapUsd != null || token.priceUsd != null,
    ).length,
    imagedTokens: tokens.filter((token) => Boolean(token.image)).length,
    indexedTrades: db.tokenTradesV2.count(),
    watchedWallets: db.watchedWalletsV1.count(),
    enabledWatchedWallets: (
      db.watchedWalletsV1
        .select()
        .where({ enabled: 1 })
        .all() as WatchedWallet[]
    ).length,
    walletTransactions: db.walletTransactionsV1.count(),
    walletSwaps: db.walletSwapsV1.count(),
    copyTradeProfiles: db.copyTradeProfilesV1.count(),
    enabledCopyTradeProfiles: (
      db.copyTradeProfilesV1
        .select()
        .where({ enabled: 1 })
        .all() as CopyTradeProfile[]
    ).length,
    copyTradeIntents: db.copyTradeIntentsV1.count(),
    terminalTrades: db.terminalTradesLive.count(),
    trades: db.tokenTradesV2.count() + db.terminalTradesLive.count(),
    indicators: db.terminalIndicatorsLive.count(),
    signals: db.telegramSignals.count(),
    processes: db.processStatus.count(),
    workerErrors: db.workerErrors.count(),
    feedResetAtMs: feedState.resetAtMs,
    latestUpdatedAtMs:
      tokens.reduce(
        (latest, token) => Math.max(latest, token.updatedAtMs),
        0,
      ) || null,
    bySource: [...bySource.values()].sort(
      (left, right) => (right.latest ?? 0) - (left.latest ?? 0),
    ),
  };
}
