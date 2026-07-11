import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database, defineView, z } from "sqlite-zod-orm";
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
  priceUpdatedAtMs: z.number().default(0),
  updatedAtMs: z.number().default(0),
});

/**
 * Append-only trade storage.
 *
 * sqlite-zod-orm owns the numeric SQLite `id`. Pump/Helius event identity is
 * stored in `eventKey` and protected by a unique constraint.
 */
export const TerminalTradeStorageSchema = z.object({
  eventKey: z.string(),
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

/**
 * Compatibility schema/type for callers that still import TerminalIndicator.
 * Indicators are no longer materialized or written.
 */
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

export const TokenPriceWindowsSchema = z.object({
  mint: z.string(),

  avgPriceUsd1m: z.number().nullable(),
  avgPriceUsd5m: z.number().nullable(),
  avgPriceUsd15m: z.number().nullable(),

  avgMarketCapUsd1m: z.number().nullable(),
  avgMarketCapUsd5m: z.number().nullable(),
  avgMarketCapUsd15m: z.number().nullable(),

  trades1m: z.number(),
  trades5m: z.number(),
  trades15m: z.number(),

  latestTradeAtMs: z.number().nullable(),
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
  signalKey: z.string(),
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

export type StoredTerminalTrade = z.infer<typeof TerminalTradeStorageSchema>;

export type TerminalTrade = Omit<StoredTerminalTrade, "eventKey"> & {
  id: string;
  eventKey: string;
};

export type TerminalIndicator = z.infer<typeof TerminalIndicatorSchema>;

export type TokenPriceWindows = z.infer<typeof TokenPriceWindowsSchema>;

export type ProcessStatus = z.infer<typeof ProcessStatusSchema>;

export type TelegramSignal = Omit<
  z.infer<typeof TelegramSignalSchema>,
  "signalKey"
> & {
  id: string;
  signalKey: string;
};

export const terminalDb = new Database(
  SOLARD_DB_PATH,
  {
    terminalTokensLive: TerminalTokenSchema,
    tokenTrades: TerminalTradeStorageSchema,
    processStatus: ProcessStatusSchema,
    workerCursors: WorkerCursorSchema,
    telegramSignals: TelegramSignalSchema,
  },
  {
    timestamps: false,
    softDeletes: false,
    reactive: false,
    wal: true,

    unique: {
      terminalTokensLive: [["mint"]],
      tokenTrades: [["eventKey"]],
      processStatus: [["name"]],
      workerCursors: [["key"]],
      telegramSignals: [["signalKey"]],
    },

    indexes: {
      terminalTokensLive: [
        "mint",
        "updatedAtMs",
        "priceUpdatedAtMs",
        "marketCapUsd",
        "source",
        ["source", "updatedAtMs"],
        ["isMayhemMode", "updatedAtMs"],
      ],

      tokenTrades: [
        "eventKey",
        "signature",
        "createdAtMs",
        "updatedAtMs",
        ["mint", "createdAtMs"],
        ["mint", "updatedAtMs"],
        ["source", "createdAtMs"],
      ],

      processStatus: ["heartbeatAtMs"],
      workerCursors: ["key", "updatedAtMs"],
      telegramSignals: ["signalKey", "receivedAtMs"],
    },

    views: {
      tokenPriceWindows: defineView(
        TokenPriceWindowsSchema,
        `
        SELECT
          mint,

          AVG(
            CASE
              WHEN createdAtMs >= unixepoch('subsec') * 1000 - 60000
              THEN priceUsd
            END
          ) AS avgPriceUsd1m,

          AVG(
            CASE
              WHEN createdAtMs >= unixepoch('subsec') * 1000 - 300000
              THEN priceUsd
            END
          ) AS avgPriceUsd5m,

          AVG(
            CASE
              WHEN createdAtMs >= unixepoch('subsec') * 1000 - 900000
              THEN priceUsd
            END
          ) AS avgPriceUsd15m,

          AVG(
            CASE
              WHEN createdAtMs >= unixepoch('subsec') * 1000 - 60000
              THEN marketCapUsd
            END
          ) AS avgMarketCapUsd1m,

          AVG(
            CASE
              WHEN createdAtMs >= unixepoch('subsec') * 1000 - 300000
              THEN marketCapUsd
            END
          ) AS avgMarketCapUsd5m,

          AVG(
            CASE
              WHEN createdAtMs >= unixepoch('subsec') * 1000 - 900000
              THEN marketCapUsd
            END
          ) AS avgMarketCapUsd15m,

          COUNT(
            CASE
              WHEN createdAtMs >= unixepoch('subsec') * 1000 - 60000
              THEN 1
            END
          ) AS trades1m,

          COUNT(
            CASE
              WHEN createdAtMs >= unixepoch('subsec') * 1000 - 300000
              THEN 1
            END
          ) AS trades5m,

          COUNT(
            CASE
              WHEN createdAtMs >= unixepoch('subsec') * 1000 - 900000
              THEN 1
            END
          ) AS trades15m,

          MAX(createdAtMs) AS latestTradeAtMs

        FROM tokenTrades

        WHERE
          createdAtMs >= unixepoch('subsec') * 1000 - 900000
          AND (
            priceUsd IS NOT NULL
            OR marketCapUsd IS NOT NULL
          )

        GROUP BY mint
        `,
      ),
    },
  },
);

let initialized = false;

function finiteNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableFiniteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteInteger(value: unknown, fallback = 0): number {
  const number = Math.trunc(finiteNumber(value, fallback));
  return Number.isSafeInteger(number) ? number : fallback;
}

function nullableText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function requiredText(value: unknown, fallback = ""): string {
  return nullableText(value) ?? fallback;
}

function cleanDisplayText(value: unknown): string | null {
  const text = nullableText(value);
  if (!text) return null;

  const lowered = text.toLowerCase();

  if (
    lowered === "-" ||
    lowered === "new token" ||
    lowered === "token" ||
    lowered === "unknown" ||
    lowered === "null" ||
    lowered === "undefined"
  ) {
    return null;
  }

  return text;
}

function json(value: unknown): string {
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

function sourceMatches(sourceValue: unknown, source: string): boolean {
  if (!source || source.includes("both")) {
    return true;
  }

  const value = String(sourceValue ?? "").toLowerCase();

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

  return true;
}

function tokenPassesFeedFilters(
  token: TerminalToken,
  input: {
    includeUnpriced: boolean;
    hideMayhem?: boolean;
    hideUsdc?: boolean;
  },
): boolean {
  if (
    !input.includeUnpriced &&
    !String(token.source).toLowerCase().startsWith("telegram") &&
    token.marketCapUsd == null &&
    token.priceUsd == null &&
    !token.image
  ) {
    return false;
  }

  if (input.hideMayhem && Number(token.isMayhemMode) !== 0) {
    return false;
  }

  if (input.hideUsdc) {
    const quote = [token.quoteAsset, token.quoteMint].join(" ").toLowerCase();

    if (
      quote.includes("usdc") ||
      quote.includes("epjfwdd5aufqssqem2qn1xzybapc8g4wegkgzwydt1v")
    ) {
      return false;
    }
  }

  return true;
}

function toTerminalTrade(value: StoredTerminalTrade): TerminalTrade {
  return {
    ...value,
    id: value.eventKey,
    eventKey: value.eventKey,
  };
}

function toTelegramSignal(
  value: z.infer<typeof TelegramSignalSchema>,
): TelegramSignal {
  return {
    ...value,
    id: value.signalKey,
    signalKey: value.signalKey,
  };
}

export function initTerminalStore(): void {
  if (initialized) return;
  initialized = true;

  dbMeasure.measureSync(
    {
      start: () => `init terminal sqlite ${SOLARD_DB_PATH}`,
      end: () => ({
        status: "ready",
        views: terminalDb.views(),
      }),
    },
    () => ({
      status: "ready",
      views: terminalDb.views(),
    }),
  );
}

initTerminalStore();

export async function dbWrite<T>(label: string, fn: () => T): Promise<T> {
  return await measureRetry(
    `db.${label}`,
    {
      attempts: 5,
      delay: 20,
      backoff: 2,
    },
    async () => fn(),
  );
}

export function withTerminalDbTransaction<T>(fn: () => T): T {
  return terminalDb.transaction(fn);
}

export async function dbWriteBatch<T>(label: string, fn: () => T): Promise<T> {
  return await dbWrite(label, () => terminalDb.transaction(fn));
}

export function upsertProcessStatus(input: {
  name: string;
  kind: string;
  status: string;
  data?: Record<string, unknown>;
  error?: unknown;
  heartbeatAtMs?: number;
}): void {
  const existing = terminalDb.processStatus
    .select()
    .where({ name: input.name })
    .get() as
    | (ProcessStatus & {
        id?: number;
      })
    | null;

  const row: ProcessStatus = {
    name: input.name,
    kind: input.kind,
    status: input.status,
    heartbeatAtMs: input.heartbeatAtMs ?? Date.now(),
    dataJson: json({
      ...parseJson(existing?.dataJson, {}),
      ...(input.data ?? {}),
    }),
    error:
      input.error == null
        ? null
        : input.error instanceof Error
          ? input.error.message
          : String(input.error),
  };

  terminalDb.processStatus.upsertOnConflict(row, "name", (t) => ({
    kind: t.excluded("kind"),
    status: t.excluded("status"),
    heartbeatAtMs: t.excluded("heartbeatAtMs"),
    dataJson: t.excluded("dataJson"),
    error: t.excluded("error"),
  }));
}

export function listProcessStatus(): Array<
  ProcessStatus & {
    data: Record<string, unknown>;
  }
> {
  return (
    terminalDb.processStatus
      .select()
      .orderBy("heartbeatAtMs", "DESC")
      .all() as ProcessStatus[]
  ).map((row) => ({
    ...row,
    data: parseJson(row.dataJson, {}),
  }));
}

export function getCursor(key: string): string | null {
  const row = terminalDb.workerCursors.select().where({ key }).get() as z.infer<
    typeof WorkerCursorSchema
  > | null;

  return row?.value ?? null;
}

export function setCursor(key: string, value: string): void {
  terminalDb.workerCursors.upsertOnConflict(
    {
      key,
      value,
      updatedAtMs: Date.now(),
    },
    "key",
    (t) => ({
      value: t.excluded("value"),
      updatedAtMs: t.excluded("updatedAtMs"),
    }),
  );
}

export function clearTerminalLiveData(
  input: {
    source?: string | null;
    keepSignals?: boolean;
  } = {},
): Record<string, unknown> {
  const source = String(input.source ?? "").toLowerCase();

  const before = terminalStoreStats();

  const tokens = terminalDb.terminalTokensLive.select().all() as Array<
    TerminalToken & {
      id: number;
    }
  >;

  for (const token of tokens) {
    if (sourceMatches(token.source, source)) {
      terminalDb.terminalTokensLive.delete(token.id);
    }
  }

  const trades = terminalDb.tokenTrades.select().all() as Array<
    StoredTerminalTrade & {
      id: number;
    }
  >;

  for (const trade of trades) {
    if (sourceMatches(trade.source, source)) {
      terminalDb.tokenTrades.delete(trade.id);
    }
  }

  if (!input.keepSignals) {
    for (const signal of terminalDb.telegramSignals.select().all() as Array<
      z.infer<typeof TelegramSignalSchema> & {
        id: number;
      }
    >) {
      terminalDb.telegramSignals.delete(signal.id);
    }
  }

  priceWindowCache.clear();

  return {
    source: source || "all",
    before,
    after: terminalStoreStats(),
  };
}

export function upsertTerminalToken(
  input: Partial<TerminalToken> & {
    mint: string;
  },
): TerminalToken {
  const now = Date.now();

  const hasPrice =
    nullableFiniteNumber(input.priceSol) != null ||
    nullableFiniteNumber(input.priceUsd) != null ||
    nullableFiniteNumber(input.marketCapSol) != null ||
    nullableFiniteNumber(input.marketCapUsd) != null;

  const row: TerminalToken = {
    mint: requiredText(input.mint),

    symbol: cleanDisplayText(input.symbol) ?? "",
    name: cleanDisplayText(input.name) ?? "",
    image: cleanDisplayText(input.image),
    uri: cleanDisplayText(input.uri),

    description: nullableText(input.description),
    website: nullableText(input.website),
    twitter: nullableText(input.twitter),
    telegram: nullableText(input.telegram),

    creator: nullableText(input.creator),
    bondingCurveKey: nullableText(input.bondingCurveKey),

    source: requiredText(input.source, "unknown"),
    phase: input.phase ?? "unknown",

    isMayhemMode: finiteInteger(input.isMayhemMode ?? 0, 0),

    quoteAsset: nullableText(input.quoteAsset),
    quoteMint: nullableText(input.quoteMint),

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

    priceUpdatedAtMs: finiteInteger(
      input.priceUpdatedAtMs ?? (hasPrice ? (input.updatedAtMs ?? now) : 0),
      0,
    ),

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
    priceUpdatedAtMs: t.max("priceUpdatedAtMs"),
    updatedAtMs: t.excluded("updatedAtMs"),
  })) as TerminalToken;
}

/**
 * Append-only write path.
 *
 * A reconnect can deliver the same event again, so the unique `eventKey`
 * conflict is ignored. No aggregate calculation occurs here.
 */
export function insertTerminalTrade(
  input: Partial<TerminalTrade> & {
    id: string;
    mint: string;
    signature: string;
  },
): TerminalTrade {
  const now = Date.now();

  const parsedConfidence = ConfidenceSchema.safeParse(input.confidence);

  const row: StoredTerminalTrade = {
    eventKey: requiredText(input.id),
    mint: requiredText(input.mint),
    signature: requiredText(input.signature),
    slot: finiteInteger(input.slot, 0),
    owner: nullableText(input.owner),

    side:
      input.side === "buy" || input.side === "sell" ? input.side : "unknown",

    tokenDeltaUi: finiteNumber(input.tokenDeltaUi, 0),

    solDeltaUi: finiteNumber(input.solDeltaUi, 0),

    priceSol: nullableFiniteNumber(input.priceSol),

    priceUsd: nullableFiniteNumber(input.priceUsd),

    marketCapUsd: nullableFiniteNumber(input.marketCapUsd),

    confidence: parsedConfidence.success ? parsedConfidence.data : "processed",

    source: requiredText(input.source, "unknown"),

    rawJson:
      typeof input.rawJson === "string"
        ? input.rawJson
        : json(input.rawJson ?? {}),

    createdAtMs: finiteInteger(input.createdAtMs ?? now, now),

    updatedAtMs: finiteInteger(input.updatedAtMs ?? now, now),
  };

  const inserted = terminalDb.tokenTrades
    .insert(row)
    .onConflict("eventKey")
    .doNothing() as StoredTerminalTrade | null;

  return toTerminalTrade(inserted ?? row);
}

const PRICE_WINDOW_TTL_MS = 1_000;

const priceWindowCache = new Map<
  string,
  {
    expiresAtMs: number;
    value: TokenPriceWindows | null;
  }
>();

export function getTokenPriceWindows(mint: string): TokenPriceWindows | null {
  const key = mint.trim();
  if (!key) return null;

  const now = Date.now();
  const cached = priceWindowCache.get(key);

  if (cached && cached.expiresAtMs > now) {
    return cached.value;
  }

  const value =
    (terminalDb.tokenPriceWindows
      .select()
      .where({ mint: key })
      .get() as TokenPriceWindows | null) ?? null;

  priceWindowCache.set(key, {
    expiresAtMs: now + PRICE_WINDOW_TTL_MS,
    value,
  });

  return value;
}

/**
 * Batch form used by the Terminal feed. Cache misses are resolved with one
 * pushed-down view query, while each mint keeps its own 1-second TTL.
 */
export function getTokenPriceWindowsBatch(
  mints: Iterable<string>,
): Map<string, TokenPriceWindows | null> {
  const now = Date.now();

  const keys = [
    ...new Set([...mints].map((mint) => mint.trim()).filter(Boolean)),
  ];

  const result = new Map<string, TokenPriceWindows | null>();

  const misses: string[] = [];

  for (const mint of keys) {
    const cached = priceWindowCache.get(mint);

    if (cached && cached.expiresAtMs > now) {
      result.set(mint, cached.value);
    } else {
      misses.push(mint);
    }
  }

  if (misses.length) {
    const rows = terminalDb.tokenPriceWindows
      .select()
      .whereIn("mint", misses)
      .all() as TokenPriceWindows[];

    const byMint = new Map(rows.map((row) => [row.mint, row]));

    for (const mint of misses) {
      const value = byMint.get(mint) ?? null;

      priceWindowCache.set(mint, {
        expiresAtMs: now + PRICE_WINDOW_TTL_MS,
        value,
      });

      result.set(mint, value);
    }
  }

  return result;
}

/**
 * Compatibility exports for existing workers.
 *
 * Dynamic views moved aggregation to the read path, so these functions must
 * never query or write during trade ingestion.
 */
export function recomputeTerminalIndicators(
  _mint: string,
  _now = Date.now(),
): TerminalIndicator[] {
  return [];
}

export function recomputeTerminalIndicatorsBatch(
  _mints: Iterable<string>,
  _now = Date.now(),
): TerminalIndicator[] {
  return [];
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
  priceStatus?: "live" | "stale" | "missing";
};

export function listTerminalFeed(
  input: {
    limit?: number;
    sinceMs?: number;
    activeWindowMs?: number;
    includeUnpriced?: boolean;
    source?: string | null;
    hideMayhem?: boolean;
    hideUsdc?: boolean;
  } = {},
): TerminalFeedRow[] {
  const now = Date.now();

  const limit = Math.max(1, Math.min(input.limit ?? 250, 1_000));

  const activeWindowMs = Math.max(
    1_000,
    input.activeWindowMs ??
      Number(process.env.SOLARD_TERMINAL_ACTIVE_WINDOW_MS ?? "300000"),
  );

  const minUpdatedAt = Math.max(input.sinceMs ?? 0, now - activeWindowMs);

  const includeUnpriced =
    input.includeUnpriced === true ||
    process.env.SOLARD_TERMINAL_INCLUDE_UNPRICED === "1";

  const source = String(input.source ?? "").toLowerCase();

  const candidateLimit = Math.min(5_000, Math.max(limit * 4, limit + 64));

  const tokens = (
    terminalDb.terminalTokensLive
      .select()
      .where({
        updatedAtMs: {
          $gte: minUpdatedAt,
        },
      })
      .orderBy("updatedAtMs", "DESC")
      .limit(candidateLimit)
      .all() as TerminalToken[]
  )
    .filter((token) => sourceMatches(token.source, source))
    .filter((token) =>
      tokenPassesFeedFilters(token, {
        includeUnpriced,
        hideMayhem: input.hideMayhem,
        hideUsdc: input.hideUsdc,
      }),
    )
    .slice(0, limit);

  const windows = getTokenPriceWindowsBatch(tokens.map((token) => token.mint));

  return tokens
    .map((token) => {
      const window = windows.get(token.mint) ?? null;

      const priceUpdatedAtMs =
        token.priceUpdatedAtMs > 0
          ? token.priceUpdatedAtMs
          : token.priceUsd != null ||
              token.priceSol != null ||
              token.marketCapUsd != null ||
              token.marketCapSol != null
            ? token.updatedAtMs
            : null;

      const priceAgeMs =
        priceUpdatedAtMs == null ? null : Math.max(0, now - priceUpdatedAtMs);

      const lastTradeAtMs = window?.latestTradeAtMs ?? priceUpdatedAtMs;

      return {
        ...token,

        kind: token.source.startsWith("telegram") ? "signal" : "pump",

        sma1m: window?.avgMarketCapUsd1m ?? token.marketCapUsd,

        sma5m: window?.avgMarketCapUsd5m ?? token.marketCapUsd,

        sma15m: window?.avgMarketCapUsd15m ?? token.marketCapUsd,

        tradeCount: window?.trades15m ?? 0,

        lastTradeAtMs,
        latestTradeUpdatedAtMs: lastTradeAtMs,

        priceUpdatedAtMs,
        priceAgeMs,

        priceStatus:
          priceUpdatedAtMs == null
            ? "missing"
            : priceAgeMs != null && priceAgeMs > 30_000
              ? "stale"
              : "live",
      } satisfies TerminalFeedRow;
    })
    .sort(
      (left, right) =>
        Math.max(right.updatedAtMs, right.lastTradeAtMs ?? 0) -
        Math.max(left.updatedAtMs, left.lastTradeAtMs ?? 0),
    )
    .slice(0, limit);
}

export function listTerminalTrades(
  input: {
    limit?: number;
    sinceMs?: number;
    mint?: string | null;
    source?: string | null;
  } = {},
): TerminalTrade[] {
  const limit = Math.max(1, Math.min(input.limit ?? 250, 1_000));

  const sinceMs = input.sinceMs ?? 0;

  const query = terminalDb.tokenTrades
    .select()
    .where({
      createdAtMs: {
        $gte: sinceMs,
      },
    })
    .orderBy("createdAtMs", "DESC")
    .limit(Math.min(5_000, Math.max(limit * 4, limit)));

  const rows = input.mint
    ? (query
        .where({
          mint: input.mint,
        })
        .all() as StoredTerminalTrade[])
    : (query.all() as StoredTerminalTrade[]);

  const source = String(input.source ?? "").toLowerCase();

  return rows
    .filter((row) => sourceMatches(row.source, source))
    .slice(0, limit)
    .map(toTerminalTrade);
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
  const limit = Math.max(1, Math.min(input.limit ?? 80, 500));

  const activeWindowMs = Math.max(
    1_000,
    input.activeWindowMs ??
      Number(process.env.SOLARD_CURVE_SNAPSHOT_ACTIVE_WINDOW_MS ?? "900000"),
  );

  const minUpdatedAt = Date.now() - activeWindowMs;

  const source = String(input.source ?? "").toLowerCase();

  return (
    terminalDb.terminalTokensLive
      .select()
      .where({
        updatedAtMs: {
          $gte: minUpdatedAt,
        },
      })
      .orderBy("updatedAtMs", "DESC")
      .limit(Math.max(limit * 4, limit))
      .all() as TerminalToken[]
  )
    .filter((token) => sourceMatches(token.source, source))
    .filter((token) => input.includeMigrated || token.phase !== "migrated")
    .filter((token) => Boolean(token.mint))
    .slice(0, limit);
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

  const source = input.source ?? "curve-snapshot";

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
    lastSlot: input.slot ?? 0,
    priceUpdatedAtMs: now,
    updatedAtMs: now,
  });

  upsertProcessStatus({
    name: "solard-curve-snapshot-last",
    kind: "snapshot",
    status: input.complete ? "complete" : "updated",
    data: {
      mint: input.mint,
      source,
      marketCapUsd: input.marketCapUsd,
      priceUsd: input.priceUsd,
      progressPct: input.progressPct ?? null,
      complete: input.complete ?? null,
    },
  });

  return token;
}

export function pendingTradeSignatures(limit = 100): string[] {
  const rows = terminalDb.tokenTrades
    .select()
    .where({
      confidence: {
        $in: ["processed", "confirmed"],
      },
    })
    .orderBy("updatedAtMs", "ASC")
    .limit(Math.max(limit * 4, limit))
    .all() as StoredTerminalTrade[];

  return [...new Set(rows.map((row) => row.signature))].slice(0, limit);
}

export function updateTradeConfidence(
  signature: string,
  confidence: TerminalConfidence,
): void {
  terminalDb.tokenTrades.select().where({ signature }).updateAll({
    confidence,
    updatedAtMs: Date.now(),
  });
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

  return (
    terminalDb.terminalTokensLive
      .select()
      .orderBy("updatedAtMs", "DESC")
      .limit(capped * 8)
      .all() as TerminalToken[]
  )
    .filter((token) => {
      return (
        !cleanDisplayText(token.image) ||
        !cleanDisplayText(token.name) ||
        !cleanDisplayText(token.symbol)
      );
    })
    .slice(0, capped)
    .map((token) => ({
      mint: token.mint,
      uri: token.uri,
      name: token.name,
      symbol: token.symbol,
      image: token.image,
      updatedAtMs: token.updatedAtMs,
    }));
}

export function insertTerminalProbeRow(
  input: {
    source?: string | null;
    now?: number;
  } = {},
): Record<string, unknown> {
  const now = input.now ?? Date.now();

  const source = String(input.source ?? "pumpportal")
    .toLowerCase()
    .includes("helius")
    ? "helius-probe"
    : "pumpportal-probe";

  const mint = source.includes("helius")
    ? "So11111111111111111111111111111111111111112"
    : "11111111111111111111111111111111";

  const marketCapUsd = source.includes("helius") ? 43_210 : 32_100;

  const token = upsertTerminalToken({
    mint,
    symbol: source.includes("helius") ? "H-PROBE" : "P-PROBE",
    name: source.includes("helius")
      ? "Helius probe row"
      : "PumpPortal probe row",
    source,
    phase: "pump",
    priceUsd: marketCapUsd / 1_000_000_000,
    marketCapUsd,
    initialMarketCapUsd: marketCapUsd,
    signature: `probe-${source}-${now}`,
    createdAtMs: now,
    priceUpdatedAtMs: now,
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

  return {
    token,
    trade,
  };
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
  const row: z.infer<typeof TelegramSignalSchema> = {
    signalKey: input.id,
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

  const saved = terminalDb.telegramSignals.upsertOnConflict(
    row,
    "signalKey",
    (t) => ({
      sourceId: t.excludedIfNotNull("sourceId"),
      sourceName: t.excludedIfNotNull("sourceName"),
      chatRef: t.excludedIfNotNull("chatRef"),
      text: t.excludedIfNotEmpty("text"),
      mintsJson: t.excluded("mintsJson"),
      symbolsJson: t.excluded("symbolsJson"),
      urlsJson: t.excluded("urlsJson"),
      status: t.excluded("status"),
      receivedAtMs: t.max("receivedAtMs"),
      rawJson: t.excludedIfNotEmpty("rawJson"),
    }),
  ) as z.infer<typeof TelegramSignalSchema>;

  for (const mint of input.mints) {
    upsertTerminalToken({
      mint,
      symbol: input.symbols?.[0] ?? "",
      name: input.symbols?.[0] ?? "telegram signal",
      source: "telegram-signal",
      updatedAtMs: row.receivedAtMs,
    });
  }

  return toTelegramSignal(saved);
}

export function listTelegramSignals(limit = 100): Array<
  TelegramSignal & {
    mints: string[];
    symbols: string[];
    urls: string[];
  }
> {
  return (
    terminalDb.telegramSignals
      .select()
      .orderBy("receivedAtMs", "DESC")
      .limit(limit)
      .all() as Array<z.infer<typeof TelegramSignalSchema>>
  ).map((row) => ({
    ...toTelegramSignal(row),
    mints: parseJson(row.mintsJson, []),
    symbols: parseJson(row.symbolsJson, []),
    urls: parseJson(row.urlsJson, []),
  }));
}

export function terminalStoreStats(): Record<string, unknown> {
  return dbMeasure.measureSync(
    {
      start: () => "terminal store stats",
      end: (result) => ({
        result: summarizeForMeasure(result),
      }),
    },
    () => {
      const tokens = terminalDb.terminalTokensLive
        .select()
        .all() as TerminalToken[];

      const activeSince =
        Date.now() -
        Number(process.env.SOLARD_TERMINAL_ACTIVE_WINDOW_MS ?? "300000");

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

        const group = bySource.get(source) ?? {
          source,
          tokens: 0,
          priced: 0,
          images: 0,
          latest: null,
        };

        group.tokens++;

        if (token.marketCapUsd != null || token.priceUsd != null) {
          group.priced++;
        }

        if (token.image) {
          group.images++;
        }

        group.latest = Math.max(group.latest ?? 0, token.updatedAtMs);

        bySource.set(source, group);
      }

      return {
        dbPath: SOLARD_DB_PATH,

        tokens: tokens.length,

        activeTokens: tokens.filter((token) => token.updatedAtMs >= activeSince)
          .length,

        pricedTokens: tokens.filter(
          (token) => token.marketCapUsd != null || token.priceUsd != null,
        ).length,

        imagedTokens: tokens.filter((token) => Boolean(token.image)).length,

        trades: terminalDb.tokenTrades.count(),

        indicators: 0,

        priceWindows: priceWindowCache.size,

        signals: terminalDb.telegramSignals.count(),

        processes: terminalDb.processStatus.count(),

        latestUpdatedAtMs:
          tokens.reduce(
            (latest, token) => Math.max(latest, token.updatedAtMs),
            0,
          ) || null,

        bySource: [...bySource.values()]
          .sort(
            (left, right) =>
              Number(right.latest ?? 0) - Number(left.latest ?? 0),
          )
          .slice(0, 20),
      };
    },
  );
}
