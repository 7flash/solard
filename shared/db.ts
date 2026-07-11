import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database, defineView, z } from "sqlite-zod-orm";

const DEFAULT_DB_PATH = join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".sowl",
  "sowl.sqlite",
);

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

  isMayhemMode: z.number().default(0),

  /**
   * Zero means unknown. A positive timestamp means the Pump bonding-curve
   * account was decoded (or the upstream source explicitly supplied the flag).
   */
  mayhemCheckedAtMs: z.number().default(0),

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

  /**
   * Feed membership timestamp.
   *
   * This is set only by a token create/discovery path. A trade by itself does
   * not make an arbitrary historical token eligible for the Terminal feed.
   */
  observedAtMs: z.number().default(0),

  priceUpdatedAtMs: z.number().default(0),
  updatedAtMs: z.number().default(0),
});

export const TokenTradeSchema = z.object({
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

  confidence: z
    .enum(["processed", "confirmed", "finalized", "dropped"])
    .default("processed"),

  source: z.string().default("unknown"),
  rawJson: z.string().default("{}"),

  tradedAtMs: z.number(),
  updatedAtMs: z.number(),
});

export const ProcessStatusSchema = z.object({
  name: z.string(),
  kind: z.string(),
  status: z.string(),

  heartbeatAtMs: z.number(),
  pid: z.number().default(0),
  buildId: z.string().nullable().default(null),

  error: z.string().nullable().default(null),
  dataJson: z.string().default("{}"),

  updatedAtMs: z.number(),
});

export const WorkerErrorSchema = z.object({
  errorKey: z.string(),
  worker: z.string(),
  message: z.string(),
  stack: z.string().nullable().default(null),
  dataJson: z.string().default("{}"),
  createdAtMs: z.number(),
});

export const TerminalFeedStateSchema = z.object({
  scope: z.string(),
  resetAtMs: z.number(),
  updatedAtMs: z.number(),
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

  volumeSol1m: z.number(),
  volumeSol5m: z.number(),
  volumeSol15m: z.number(),

  latestPriceSol: z.number().nullable(),
  latestPriceUsd: z.number().nullable(),
  latestMarketCapUsd: z.number().nullable(),

  /**
   * Best current market-cap value available from the same 15-minute scan.
   * Falls back through recent averages when the newest trade omitted MCAP.
   */
  currentMarketCapUsd: z.number().nullable(),

  latestTradeAtMs: z.number().nullable(),
});

export type TerminalToken = z.infer<typeof TerminalTokenSchema>;

export type TokenTrade = z.infer<typeof TokenTradeSchema>;

export type ProcessStatus = z.infer<typeof ProcessStatusSchema>;

export type TokenPriceWindows = z.infer<typeof TokenPriceWindowsSchema>;

export type WorkerError = z.infer<typeof WorkerErrorSchema>;

export type TerminalFeedState = z.infer<typeof TerminalFeedStateSchema>;

export type TerminalFeedRow = TerminalToken & {
  sma1m: number | null;
  sma5m: number | null;
  sma15m: number | null;

  avgPriceUsd1m: number | null;
  avgPriceUsd5m: number | null;
  avgPriceUsd15m: number | null;

  tradeCount: number;
  trades1m: number;
  trades5m: number;
  trades15m: number;

  volumeSol1m: number;
  volumeSol5m: number;
  volumeSol15m: number;

  lastTradeAtMs: number | null;
  priceAgeMs: number | null;
  priceStatus: "live" | "stale" | "missing";

  raw: TerminalToken;
};

export const db = new Database(
  SOLARD_DB_PATH,
  {
    terminalTokensLive: TerminalTokenSchema,
    tokenTrades: TokenTradeSchema,
    processStatus: ProcessStatusSchema,
    workerErrors: WorkerErrorSchema,
    terminalFeedState: TerminalFeedStateSchema,
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
      workerErrors: [["errorKey"]],
      terminalFeedState: [["scope"]],
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

      tokenTrades: [
        ["mint", "tradedAtMs"],
        ["tradedAtMs"],
        ["source", "tradedAtMs"],
        ["signature"],
        ["eventKey"],
      ],

      processStatus: [["heartbeatAtMs"], ["updatedAtMs"]],

      workerErrors: [["createdAtMs"], ["worker", "createdAtMs"]],

      terminalFeedState: [["resetAtMs"], ["updatedAtMs"]],
    },

    views: {
      tokenPriceWindowsV4: defineView(
        TokenPriceWindowsSchema,
        `
        WITH recent AS (
          SELECT
            id,
            mint,
            priceSol,
            priceUsd,
            marketCapUsd,
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
            ) AS latestMarketCapUsdRank

          FROM tokenTrades

          WHERE
            tradedAtMs >= unixepoch('subsec') * 1000 - 900000
        ),

        aggregated AS (
        SELECT
          mint,

          AVG(CASE
            WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 60000
            THEN priceUsd
          END) AS avgPriceUsd1m,

          AVG(CASE
            WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 300000
            THEN priceUsd
          END) AS avgPriceUsd5m,

          AVG(CASE
            WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 900000
            THEN priceUsd
          END) AS avgPriceUsd15m,

          AVG(CASE
            WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 60000
            THEN marketCapUsd
          END) AS avgMarketCapUsd1m,

          AVG(CASE
            WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 300000
            THEN marketCapUsd
          END) AS avgMarketCapUsd5m,

          AVG(CASE
            WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 900000
            THEN marketCapUsd
          END) AS avgMarketCapUsd15m,

          COUNT(CASE
            WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 60000
            THEN 1
          END) AS trades1m,

          COUNT(CASE
            WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 300000
            THEN 1
          END) AS trades5m,

          COUNT(CASE
            WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 900000
            THEN 1
          END) AS trades15m,

          SUM(CASE
            WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 60000
            THEN effectiveVolumeSol
            ELSE 0
          END) AS volumeSol1m,

          SUM(CASE
            WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 300000
            THEN effectiveVolumeSol
            ELSE 0
          END) AS volumeSol5m,

          SUM(CASE
            WHEN tradedAtMs >= unixepoch('subsec') * 1000 - 900000
            THEN effectiveVolumeSol
            ELSE 0
          END) AS volumeSol15m,

          MAX(CASE
            WHEN latestPriceSolRank = 1
            THEN priceSol
          END) AS latestPriceSol,

          MAX(CASE
            WHEN latestPriceUsdRank = 1
            THEN priceUsd
          END) AS latestPriceUsd,

          MAX(CASE
            WHEN latestMarketCapUsdRank = 1
            THEN marketCapUsd
          END) AS latestMarketCapUsd,

          MAX(tradedAtMs) AS latestTradeAtMs

        FROM recent

        GROUP BY mint
        ),

        resolved AS (
          SELECT
            *,

            latestMarketCapUsd AS currentMarketCapUsd

          FROM aggregated
        )

        SELECT *
        FROM resolved
        `,
      ),
    },
  },
);

const PRICE_WINDOW_TTL_MS = 1_000;

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

export function isDuplicateTradeError(error: unknown): boolean {
  const message = sqliteErrorMessage(error);

  return (
    message.includes("unique constraint failed") &&
    (message.includes("tokentrades.eventkey") || message.includes("eventkey"))
  );
}

function finite(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }

  const result = Number(value);

  return Number.isFinite(result) ? result : null;
}

function integer(value: unknown, fallback = 0): number {
  const result = Math.trunc(Number(value));

  return Number.isSafeInteger(result) ? result : fallback;
}

function text(value: unknown): string | null {
  if (value == null) return null;

  const result = String(value).trim();

  return result || null;
}

function displayText(value: unknown): string {
  const result = text(value);

  if (!result) return "";

  const lowered = result.toLowerCase();

  if (
    lowered === "unknown" ||
    lowered === "undefined" ||
    lowered === "null" ||
    lowered === "new token" ||
    lowered === "-"
  ) {
    return "";
  }

  return result;
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function sourceMatches(
  requested: string | null | undefined,
  actual: string,
): boolean {
  const source = String(requested ?? "both")
    .trim()
    .toLowerCase();

  if (!source || source === "both") {
    return true;
  }

  const value = String(actual ?? "")
    .trim()
    .toLowerCase();

  if (source === "helius" || source.includes("helius")) {
    return value.includes("helius");
  }

  if (source === "pumpportal" || source.includes("pumpportal")) {
    return value.includes("pumpportal") || value === "pump";
  }

  return value === source;
}

function isUsdc(token: TerminalToken): boolean {
  const value = [token.quoteAsset, token.quoteMint].join(" ").toLowerCase();

  return (
    value.includes("usdc") ||
    value.includes("epjfwdd5aufqssqem2qn1xzybapc8g4wegkgzwydt1v")
  );
}

function hasPrice(token: TerminalToken): boolean {
  return (
    token.priceSol != null ||
    token.priceUsd != null ||
    token.marketCapSol != null ||
    token.marketCapUsd != null
  );
}

export function upsertTerminalToken(
  input: Partial<TerminalToken> & {
    mint: string;
  },
): TerminalToken {
  const now = Date.now();

  const incomingHasPrice = [
    input.priceSol,
    input.priceUsd,
    input.marketCapSol,
    input.marketCapUsd,
  ].some((value) => finite(value) != null);

  const incomingSource = text(input.source) ?? "unknown";

  const hasExplicitMayhemFlag =
    Object.prototype.hasOwnProperty.call(input, "isMayhemMode") &&
    input.isMayhemMode != null;

  const discoveryObservation =
    /(?:create|discovery|new-token|telegram-signal|probe)/i.test(incomingSource)
      ? now
      : 0;

  const row: TerminalToken = {
    mint: text(input.mint) ?? "",

    symbol: displayText(input.symbol),
    name: displayText(input.name),
    image: text(input.image),
    uri: text(input.uri),

    description: text(input.description),
    website: text(input.website),
    twitter: text(input.twitter),
    telegram: text(input.telegram),

    creator: text(input.creator),
    bondingCurveKey: text(input.bondingCurveKey),

    source: incomingSource,

    phase: input.phase ?? "unknown",

    isMayhemMode: integer(input.isMayhemMode, 0),

    mayhemCheckedAtMs: integer(
      input.mayhemCheckedAtMs ?? (hasExplicitMayhemFlag ? now : 0),
      0,
    ),

    quoteAsset: text(input.quoteAsset),

    quoteMint: text(input.quoteMint),

    supplyUi: finite(input.supplyUi) ?? 1_000_000_000,

    priceSol: finite(input.priceSol),

    priceUsd: finite(input.priceUsd),

    marketCapSol: finite(input.marketCapSol),

    marketCapUsd: finite(input.marketCapUsd),

    initialMarketCapUsd: finite(
      input.initialMarketCapUsd ?? input.marketCapUsd,
    ),

    lastSlot: integer(input.lastSlot, 0),

    signature: text(input.signature),

    createdAtMs: integer(input.createdAtMs, now),

    observedAtMs: integer(input.observedAtMs ?? discoveryObservation, 0),

    priceUpdatedAtMs: integer(
      input.priceUpdatedAtMs ??
        (incomingHasPrice ? (input.updatedAtMs ?? now) : 0),
      0,
    ),

    updatedAtMs: integer(input.updatedAtMs, now),
  };

  return db.terminalTokensLive.upsertOnConflict(row, "mint", (t) => ({
    symbol: t.excludedIfNotEmpty("symbol"),

    name: t.excludedIfNotEmpty("name"),

    image: t.excludedIfNotEmpty("image"),

    uri: t.excludedIfNotEmpty("uri"),

    description: t.excludedIfNotNull("description"),

    website: t.excludedIfNotNull("website"),

    twitter: t.excludedIfNotNull("twitter"),

    telegram: t.excludedIfNotNull("telegram"),

    creator: t.excludedIfNotNull("creator"),

    bondingCurveKey: t.excludedIfNotNull("bondingCurveKey"),

    source: t.excluded("source"),

    phase: t.excluded("phase"),

    isMayhemMode: t.max("isMayhemMode"),

    mayhemCheckedAtMs: t.max("mayhemCheckedAtMs"),

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

    observedAtMs: t.max("observedAtMs"),

    priceUpdatedAtMs: t.max("priceUpdatedAtMs"),

    updatedAtMs: t.excluded("updatedAtMs"),
  })) as TerminalToken;
}

/**
 * Append-only trade write.
 *
 * Duplicate websocket delivery is ignored by the unique eventKey. No SMA or
 * other aggregation runs in this write transaction.
 */
export type AppendTokenTradeResult = {
  row: TokenTrade;
  inserted: boolean;
};

/**
 * Append-only trade write with explicit duplicate result.
 *
 * Duplicate websocket delivery is ignored by the unique eventKey. No SMA,
 * cache invalidation, token lookup, or aggregation runs in this transaction.
 */
export function appendTokenTradeOnce(
  input: Partial<TokenTrade> & {
    eventKey: string;
    mint: string;
    signature: string;
    tradedAtMs: number;
  },
): AppendTokenTradeResult {
  const now = Date.now();

  const row: TokenTrade = {
    eventKey: text(input.eventKey) ?? "",

    mint: text(input.mint) ?? "",

    signature: text(input.signature) ?? "",

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
        : stringify(input.rawJson ?? {}),

    tradedAtMs: integer(input.tradedAtMs, now),

    updatedAtMs: integer(input.updatedAtMs, now),
  };

  try {
    /**
     * sqlite-zod-orm insert() executes synchronously.
     *
     * tokenTrades is append-only. A duplicate eventKey is normal websocket
     * redelivery and is handled by the UNIQUE exception below.
     */
    const inserted = db.tokenTrades.insert(row) as TokenTrade;

    return {
      row: inserted,
      inserted: true,
    };
  } catch (error) {
    if (isDuplicateTradeError(error)) {
      return {
        row,
        inserted: false,
      };
    }

    throw error;
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
    (db.tokenPriceWindowsV4
      .select()
      .where({ mint: key })
      .cache({
        ttlMs: Math.max(0, integer(ttlMs, PRICE_WINDOW_TTL_MS)),
      })
      .get() as TokenPriceWindows | null) ?? null
  );
}

export function listTokenPriceWindows(
  ttlMs = PRICE_WINDOW_TTL_MS,
): TokenPriceWindows[] {
  return db.tokenPriceWindowsV4
    .select()
    .orderBy("latestTradeAtMs", "DESC")
    .cache({
      ttlMs: Math.max(0, integer(ttlMs, PRICE_WINDOW_TTL_MS)),
    })
    .all() as TokenPriceWindows[];
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

  return (
    db.terminalTokensLive
      .select()
      .orderBy("updatedAtMs", "DESC")
      .limit(capped * 8)
      .all() as TerminalToken[]
  )
    .filter(
      (token) =>
        token.phase !== "migrated" &&
        Number(token.observedAtMs ?? 0) > 0 &&
        Number(token.mayhemCheckedAtMs ?? 0) <= 0,
    )
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

/**
 * Update only the authoritative Mayhem fields. This intentionally preserves
 * source, phase, metadata timestamps, and feed-observation timestamps.
 */
export function setTerminalTokenMayhem(input: {
  mint: string;
  isMayhemMode: boolean;
  checkedAtMs?: number;
}): TerminalToken | null {
  const existing = db.terminalTokensLive
    .select()
    .where({
      mint: input.mint,
    })
    .get() as TerminalToken | null;

  if (!existing) {
    return null;
  }

  const row: TerminalToken = {
    ...existing,

    isMayhemMode: input.isMayhemMode ? 1 : 0,

    mayhemCheckedAtMs: integer(input.checkedAtMs, Date.now()),
  };

  return db.terminalTokensLive.upsertOnConflict(row, "mint", (t) => ({
    isMayhemMode: t.max("isMayhemMode"),

    mayhemCheckedAtMs: t.max("mayhemCheckedAtMs"),
  })) as TerminalToken;
}

function terminalTokenIsMayhem(token: TerminalToken): boolean {
  return Number(token.isMayhemMode ?? 0) > 0;
}

function terminalTokenMayhemKnown(token: TerminalToken): boolean {
  return Number(token.mayhemCheckedAtMs ?? 0) > 0;
}

const TERMINAL_FEED_SCOPE = "pump";

function cleanPinnedMints(
  values: Iterable<string> | null | undefined,
): string[] {
  return [
    ...new Set(
      [...(values ?? [])].map((value) => String(value).trim()).filter(Boolean),
    ),
  ].slice(0, 250);
}

/**
 * First deployment starts with only tokens observed during the current active
 * window. Historical rows have observedAtMs=0 and are therefore excluded.
 */
export function getTerminalFeedState(
  scope = TERMINAL_FEED_SCOPE,
): TerminalFeedState {
  const existing = db.terminalFeedState
    .select()
    .where({ scope })
    .get() as TerminalFeedState | null;

  if (existing) {
    return existing;
  }

  const now = Date.now();

  const row: TerminalFeedState = {
    scope,
    resetAtMs:
      now -
      Math.max(
        1_000,
        integer(process.env.SOLARD_TERMINAL_ACTIVE_WINDOW_MS, 300_000),
      ),
    updatedAtMs: now,
  };

  try {
    /**
     * Initialization is a plain synchronous insert.
     * If another process wins the race, return the row it inserted.
     */
    return db.terminalFeedState.insert(row) as TerminalFeedState;
  } catch (error) {
    const existingAfterRace = db.terminalFeedState
      .select()
      .where({ scope })
      .get() as TerminalFeedState | null;

    if (existingAfterRace) {
      return existingAfterRace;
    }

    throw error;
  }
}

/**
 * Logical reset only. Append-only trades and historical token metadata remain
 * available for audit/debugging, but cease to be feed members.
 */
export function resetTerminalFeed(
  input: {
    scope?: string;
    now?: number;
    pinnedMints?: Iterable<string>;
  } = {},
): {
  state: TerminalFeedState;
  pinnedMints: string[];
} {
  const scope = text(input.scope) ?? TERMINAL_FEED_SCOPE;

  const now = integer(input.now, Date.now());

  const pinnedMints = cleanPinnedMints(input.pinnedMints);

  const state = db.terminalFeedState.upsertOnConflict(
    {
      scope,
      resetAtMs: now,
      updatedAtMs: now,
    },
    "scope",
    (t) => ({
      resetAtMs: t.excluded("resetAtMs"),
      updatedAtMs: t.excluded("updatedAtMs"),
    }),
  ) as TerminalFeedState;

  return {
    state,
    pinnedMints,
  };
}

function isTerminalFeedMember(
  token: TerminalToken,
  resetAtMs: number,
  pinnedMints: ReadonlySet<string>,
): boolean {
  return (
    pinnedMints.has(token.mint) || Number(token.observedAtMs ?? 0) >= resetAtMs
  );
}

export function listTerminalFeed(
  input: {
    limit?: number;
    sinceMs?: number;
    activeWindowMs?: number;
    includeUnpriced?: boolean;
    source?: string | null;
    hideMayhem?: boolean;
    hideUsdc?: boolean;
    priceWindowTtlMs?: number;
    pinnedMints?: Iterable<string>;
  } = {},
): TerminalFeedRow[] {
  const now = Date.now();

  const limit = Math.max(1, Math.min(integer(input.limit, 160), 500));

  const activeWindowMs = Math.max(
    1_000,
    integer(input.activeWindowMs, 300_000),
  );

  const minUpdatedAt = Math.max(
    integer(input.sinceMs, 0),
    now - activeWindowMs,
  );

  const feedState = getTerminalFeedState();

  const pinnedMints = cleanPinnedMints(input.pinnedMints);

  const pinnedSet = new Set(pinnedMints);

  const candidateLimit = Math.min(2_000, Math.max(limit * 4, 300));

  /**
   * One cached view query scans the 15-minute trade candidate set once,
   * groups once, and supplies both latest prices and all SMA windows.
   */
  const allWindows = listTokenPriceWindows(
    input.priceWindowTtlMs ?? PRICE_WINDOW_TTL_MS,
  );

  const activeWindows = allWindows
    .filter((window) => Number(window.latestTradeAtMs ?? 0) >= minUpdatedAt)
    .slice(0, candidateLimit);

  const windowsByMint = new Map(
    allWindows.map((window) => [window.mint, window]),
  );

  const recentTokens = db.terminalTokensLive
    .select()
    .where({
      updatedAtMs: {
        $gte: minUpdatedAt,
      },
    } as any)
    .orderBy("updatedAtMs", "DESC")
    .limit(candidateLimit)
    .all() as TerminalToken[];

  const activeTradeMints = activeWindows.map((window) => window.mint);

  const tradedTokens = activeTradeMints.length
    ? (db.terminalTokensLive
        .select()
        .whereIn("mint", activeTradeMints)
        .all() as TerminalToken[])
    : [];

  const pinnedTokens = pinnedMints.length
    ? (db.terminalTokensLive
        .select()
        .whereIn("mint", pinnedMints)
        .all() as TerminalToken[])
    : [];

  const tokensByMint = new Map<string, TerminalToken>();

  for (const token of [...recentTokens, ...tradedTokens, ...pinnedTokens]) {
    tokensByMint.set(token.mint, token);
  }

  const rows = [...tokensByMint.values()]
    .filter((token) =>
      isTerminalFeedMember(token, feedState.resetAtMs, pinnedSet),
    )
    .filter((token) => sourceMatches(input.source, token.source))
    .filter(
      (token) =>
        !input.hideMayhem ||
        !(terminalTokenMayhemKnown(token) && terminalTokenIsMayhem(token)),
    )
    .filter((token) => !input.hideUsdc || !isUsdc(token))
    .map((token) => {
      const windows = windowsByMint.get(token.mint) ?? null;

      const priceSol = windows?.latestPriceSol ?? token.priceSol;

      const priceUsd = windows?.latestPriceUsd ?? token.priceUsd;

      const marketCapUsd =
        windows?.latestMarketCapUsd ??
        (priceUsd != null ? priceUsd * token.supplyUi : token.marketCapUsd) ??
        null;

      const marketCapSol =
        priceSol != null ? priceSol * token.supplyUi : token.marketCapSol;

      const latestTradeAtMs = windows?.latestTradeAtMs ?? null;

      const priceUpdatedAtMs =
        latestTradeAtMs ??
        (token.priceUpdatedAtMs > 0
          ? token.priceUpdatedAtMs
          : priceSol != null ||
              priceUsd != null ||
              marketCapSol != null ||
              marketCapUsd != null
            ? token.updatedAtMs
            : 0);

      const priceAgeMs =
        priceUpdatedAtMs > 0 ? Math.max(0, now - priceUpdatedAtMs) : null;

      return {
        ...token,

        priceSol,
        priceUsd,
        marketCapSol,
        marketCapUsd,

        sma1m: windows?.avgMarketCapUsd1m ?? null,

        sma5m: windows?.avgMarketCapUsd5m ?? null,

        sma15m: windows?.avgMarketCapUsd15m ?? null,

        avgPriceUsd1m: windows?.avgPriceUsd1m ?? null,

        avgPriceUsd5m: windows?.avgPriceUsd5m ?? null,

        avgPriceUsd15m: windows?.avgPriceUsd15m ?? null,

        tradeCount: windows?.trades15m ?? 0,

        trades1m: windows?.trades1m ?? 0,

        trades5m: windows?.trades5m ?? 0,

        trades15m: windows?.trades15m ?? 0,

        volumeSol1m: windows?.volumeSol1m ?? 0,

        volumeSol5m: windows?.volumeSol5m ?? 0,

        volumeSol15m: windows?.volumeSol15m ?? 0,

        lastTradeAtMs: latestTradeAtMs,

        priceAgeMs,

        priceStatus:
          priceUpdatedAtMs <= 0
            ? "missing"
            : priceAgeMs != null && priceAgeMs > 30_000
              ? "stale"
              : "live",

        raw: token,
      } satisfies TerminalFeedRow;
    })
    .filter(
      (row) => input.includeUnpriced || hasPrice(row) || Boolean(row.image),
    )
    .sort(
      (left, right) =>
        Math.max(right.updatedAtMs, right.lastTradeAtMs ?? 0) -
        Math.max(left.updatedAtMs, left.lastTradeAtMs ?? 0),
    )
    .slice(0, limit);

  return rows;
}

export function upsertProcessStatus(
  input: Partial<ProcessStatus> & {
    name: string;
    kind: string;
    status: string;
  },
): ProcessStatus {
  const now = Date.now();

  const row: ProcessStatus = {
    name: text(input.name) ?? "",

    kind: text(input.kind) ?? "worker",

    status: text(input.status) ?? "unknown",

    heartbeatAtMs: integer(input.heartbeatAtMs, now),

    pid: integer(input.pid, process.pid),

    buildId: text(input.buildId),

    error: text(input.error),

    dataJson:
      typeof input.dataJson === "string"
        ? input.dataJson
        : stringify(input.dataJson ?? {}),

    updatedAtMs: integer(input.updatedAtMs, now),
  };

  try {
    return db.processStatus.upsertOnConflict(row, "name", (t) => ({
      kind: t.excluded("kind"),

      status: t.excluded("status"),

      heartbeatAtMs: t.excluded("heartbeatAtMs"),

      pid: t.excluded("pid"),

      buildId: t.excludedIfNotNull("buildId"),

      error: t.excluded("error"),

      dataJson: t.excluded("dataJson"),

      updatedAtMs: t.excluded("updatedAtMs"),
    })) as ProcessStatus;
  } catch (error) {
    if (isSqliteBusyError(error)) {
      console.warn(
        `[solard:db] skipped process heartbeat while SQLite was busy: ${row.name}`,
      );

      return row;
    }

    throw error;
  }
}

export function listProcessStatus(limit = 50): ProcessStatus[] {
  return db.processStatus
    .select()
    .orderBy("heartbeatAtMs", "DESC")
    .limit(Math.max(1, Math.min(integer(limit, 50), 250)))
    .all() as ProcessStatus[];
}

export function recordWorkerError(
  worker: string,
  error: unknown,
  data: Record<string, unknown> = {},
): WorkerError {
  const now = Date.now();

  const value = error instanceof Error ? error : new Error(String(error));

  const row: WorkerError = {
    errorKey: [worker, now, Math.random().toString(36).slice(2, 10)].join(":"),

    worker,

    message: value.message,

    stack: value.stack ?? null,

    dataJson: stringify(data),

    createdAtMs: now,
  };

  try {
    return db.workerErrors.insert(row) as WorkerError;
  } catch (writeError) {
    /**
     * Error telemetry must never crash the worker that is already handling a
     * database problem. Keep the original error visible on stderr and skip the
     * telemetry row during a transient lock.
     */
    if (isSqliteBusyError(writeError)) {
      console.error(`[solard:indexer] ${worker}: ${value.message}`);

      return row;
    }

    throw writeError;
  }
}

export function listWorkerErrors(
  input: {
    worker?: string | null;
    limit?: number;
  } = {},
): WorkerError[] {
  const limit = Math.max(1, Math.min(integer(input.limit, 25), 250));

  const query = db.workerErrors
    .select()
    .orderBy("createdAtMs", "DESC")
    .limit(limit);

  return (
    input.worker
      ? query
          .where({
            worker: input.worker,
          })
          .all()
      : query.all()
  ) as WorkerError[];
}

export function terminalStoreStats(
  input: {
    pinnedMints?: Iterable<string>;
  } = {},
): {
  tokens: number;
  storedTokens: number;
  pricedTokens: number;
  trades: number;
  storedTrades: number;
  workerErrors: number;
  feedResetAtMs: number;
} {
  const feedState = getTerminalFeedState();

  const pinnedSet = new Set(cleanPinnedMints(input.pinnedMints));

  const storedTokens = db.terminalTokensLive.select().all() as TerminalToken[];

  const memberTokens = storedTokens.filter((token) =>
    isTerminalFeedMember(token, feedState.resetAtMs, pinnedSet),
  );

  const memberMints = new Set(memberTokens.map((token) => token.mint));

  const windows = listTokenPriceWindows(PRICE_WINDOW_TTL_MS).filter((window) =>
    memberMints.has(window.mint),
  );

  const pricedMints = new Set(
    windows
      .filter(
        (window) =>
          window.latestPriceSol != null ||
          window.latestPriceUsd != null ||
          window.latestMarketCapUsd != null,
      )
      .map((window) => window.mint),
  );

  for (const token of memberTokens) {
    if (hasPrice(token)) {
      pricedMints.add(token.mint);
    }
  }

  return {
    tokens: memberTokens.length,

    storedTokens: storedTokens.length,

    pricedTokens: pricedMints.size,

    trades: windows.reduce(
      (total, window) => total + Number(window.trades15m ?? 0),
      0,
    ),

    storedTrades: db.tokenTrades.count(),

    workerErrors: db.workerErrors.count(),

    feedResetAtMs: feedState.resetAtMs,
  };
}
