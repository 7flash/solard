import {
  terminalDb,
  type ProcessStatusRow,
  type TerminalDatabase,
  type TerminalIndicatorData,
  type TerminalIndicatorRow,
  type TerminalTokenData,
  type TerminalTokenRow,
  type TerminalTradeData,
  type TerminalTradeRow,
} from "./terminal-db.js";

export type TerminalFeedSource =
  "helius" | "pumpportal" | "both" | null | undefined;

export type TerminalFeedRow = TerminalTokenRow & {
  sma1m: number | null;
  sma5m: number | null;
  sma15m: number | null;
  tradeCount: number;
  lastTradeAtMs: number | null;
  priceAgeMs: number | null;
  priceStatus: "live" | "stale" | "missing";
  raw: TerminalTokenRow;
};

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function parseObject(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const result = String(value).trim();
  return result || null;
}

function sourceMatches(source: TerminalFeedSource, rowSource: string): boolean {
  if (!source || source === "both") return true;
  const value = rowSource.toLowerCase();

  if (source === "helius") {
    return value.includes("helius") || value.includes("telegram");
  }

  return (
    value.includes("pumpportal") ||
    value === "pump" ||
    value.includes("telegram")
  );
}

function isUsdc(row: TerminalTokenRow): boolean {
  return (
    `${row.quoteAsset ?? ""} ${row.quoteMint ?? ""}`
      .toLowerCase()
      .match(/usdc|epjfwdd5aufqssqem2qn1xzybapc8g4wegkgzwydt1v/) != null
  );
}

function isPriced(row: TerminalTokenRow): boolean {
  return (
    row.marketCapUsd != null ||
    row.marketCapSol != null ||
    row.priceUsd != null ||
    row.priceSol != null
  );
}

function latestIndicatorMap(
  db: TerminalDatabase,
  mints: string[],
): Map<string, Map<number, TerminalIndicatorRow>> {
  const result = new Map<string, Map<number, TerminalIndicatorRow>>();
  if (!mints.length) return result;

  const rows = db.terminalIndicators
    .select()
    .whereIn("mint", mints)
    .whereIn("intervalSec", [60, 300, 900])
    .orderBy("updatedAtMs", "desc")
    .all() as TerminalIndicatorRow[];

  for (const row of rows) {
    let byInterval = result.get(row.mint);
    if (!byInterval) {
      byInterval = new Map();
      result.set(row.mint, byInterval);
    }
    if (!byInterval.has(row.intervalSec)) {
      byInterval.set(row.intervalSec, row);
    }
  }

  return result;
}

export function listTerminalFeed(
  input: {
    limit?: number;
    sinceMs?: number;
    activeWindowMs?: number;
    includeUnpriced?: boolean;
    source?: TerminalFeedSource;
    hideMayhem?: boolean;
    hideUsdc?: boolean;
    nowMs?: number;
  } = {},
): TerminalFeedRow[] {
  const now = input.nowMs ?? Date.now();
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 160)));
  const activeWindowMs = Math.max(
    1_000,
    Math.trunc(input.activeWindowMs ?? 5 * 60_000),
  );
  const minUpdatedAt = Math.max(
    Number(input.sinceMs ?? 0),
    now - activeWindowMs,
  );

  const candidateLimit = Math.max(limit * 4, 500);

  const candidates = terminalDb.terminalTokens
    .select()
    .where({
      updatedAtMs: { $gte: minUpdatedAt },
    } as any)
    .orderBy("updatedAtMs", "desc")
    .limit(candidateLimit)
    .all() as TerminalTokenRow[];

  const filtered = candidates
    .filter((row) => sourceMatches(input.source, row.source))
    .filter((row) => !input.hideMayhem || !row.isMayhemMode)
    .filter((row) => !input.hideUsdc || !isUsdc(row))
    .filter((row) => input.includeUnpriced || isPriced(row))
    .slice(0, limit);

  const indicators = latestIndicatorMap(
    terminalDb,
    filtered.map((row) => row.mint),
  );

  return filtered.map((row) => {
    const byInterval = indicators.get(row.mint);
    const sma1m =
      finite(byInterval?.get(60)?.smaMarketCapUsd) ?? finite(row.marketCapUsd);
    const sma5m =
      finite(byInterval?.get(300)?.smaMarketCapUsd) ?? finite(row.marketCapUsd);
    const sma15m =
      finite(byInterval?.get(900)?.smaMarketCapUsd) ?? finite(row.marketCapUsd);

    const priceUpdatedAtMs =
      row.priceUpdatedAtMs > 0
        ? row.priceUpdatedAtMs
        : isPriced(row)
          ? row.updatedAtMs
          : 0;

    const priceAgeMs =
      priceUpdatedAtMs > 0 ? Math.max(0, now - priceUpdatedAtMs) : null;

    return {
      ...row,
      sma1m,
      sma5m,
      sma15m,
      tradeCount: Math.max(
        byInterval?.get(60)?.tradeCount ?? 0,
        byInterval?.get(300)?.tradeCount ?? 0,
        byInterval?.get(900)?.tradeCount ?? 0,
      ),
      lastTradeAtMs: priceUpdatedAtMs || null,
      priceAgeMs,
      priceStatus:
        priceUpdatedAtMs <= 0
          ? "missing"
          : priceAgeMs != null && priceAgeMs > 30_000
            ? "stale"
            : "live",
      raw: row,
    };
  });
}

export function getTerminalToken(
  mint: string,
  db: TerminalDatabase = terminalDb,
): TerminalTokenRow | null {
  return (
    (db.terminalTokens
      .select()
      .where({ mint })
      .first() as TerminalTokenRow | null) ?? null
  );
}

export function upsertTerminalToken(
  patch: Partial<TerminalTokenData> & { mint: string },
  db: TerminalDatabase = terminalDb,
): TerminalTokenRow {
  const existing = getTerminalToken(patch.mint, db);
  const now = Date.now();

  const hasPricePatch = [
    patch.priceSol,
    patch.priceUsd,
    patch.marketCapSol,
    patch.marketCapUsd,
  ].some((value) => finite(value) != null);

  const row: TerminalTokenData = {
    mint: patch.mint,
    symbol: text(patch.symbol) ?? existing?.symbol ?? "",
    name: text(patch.name) ?? existing?.name ?? "",
    image: text(patch.image) ?? existing?.image ?? null,
    uri: text(patch.uri) ?? existing?.uri ?? null,
    description: text(patch.description) ?? existing?.description ?? null,
    website: text(patch.website) ?? existing?.website ?? null,
    twitter: text(patch.twitter) ?? existing?.twitter ?? null,
    telegram: text(patch.telegram) ?? existing?.telegram ?? null,
    creator: text(patch.creator) ?? existing?.creator ?? null,
    bondingCurveKey:
      text(patch.bondingCurveKey) ?? existing?.bondingCurveKey ?? null,

    source: text(patch.source) ?? existing?.source ?? "unknown",
    phase:
      patch.phase && patch.phase !== "unknown"
        ? patch.phase
        : (existing?.phase ?? patch.phase ?? "unknown"),
    isMayhemMode: patch.isMayhemMode ?? existing?.isMayhemMode ?? false,
    quoteAsset: text(patch.quoteAsset) ?? existing?.quoteAsset ?? null,
    quoteMint: text(patch.quoteMint) ?? existing?.quoteMint ?? null,

    supplyUi: finite(patch.supplyUi) ?? existing?.supplyUi ?? 1_000_000_000,
    priceSol: finite(patch.priceSol) ?? existing?.priceSol ?? null,
    priceUsd: finite(patch.priceUsd) ?? existing?.priceUsd ?? null,
    marketCapSol: finite(patch.marketCapSol) ?? existing?.marketCapSol ?? null,
    marketCapUsd: finite(patch.marketCapUsd) ?? existing?.marketCapUsd ?? null,
    initialMarketCapUsd:
      existing?.initialMarketCapUsd ??
      finite(patch.initialMarketCapUsd) ??
      finite(patch.marketCapUsd),

    lastSlot: finite(patch.lastSlot) ?? existing?.lastSlot ?? 0,
    signature: text(patch.signature) ?? existing?.signature ?? null,
    rawJson: text(patch.rawJson) ?? existing?.rawJson ?? "{}",

    createdAtMs: existing?.createdAtMs ?? finite(patch.createdAtMs) ?? now,
    priceUpdatedAtMs: hasPricePatch
      ? (finite(patch.priceUpdatedAtMs) ?? finite(patch.updatedAtMs) ?? now)
      : (existing?.priceUpdatedAtMs ?? finite(patch.priceUpdatedAtMs) ?? 0),
    updatedAtMs: finite(patch.updatedAtMs) ?? now,
  };

  return db.terminalTokens.upsert(
    { mint: patch.mint },
    row,
  ) as TerminalTokenRow;
}

export function upsertTerminalTrade(
  trade: TerminalTradeData,
  db: TerminalDatabase = terminalDb,
): TerminalTradeRow {
  return db.terminalTrades.upsert(
    { eventKey: trade.eventKey },
    trade,
  ) as TerminalTradeRow;
}

export function upsertTerminalIndicator(
  indicator: TerminalIndicatorData,
  db: TerminalDatabase = terminalDb,
): TerminalIndicatorRow {
  return db.terminalIndicators.upsert(
    {
      mint: indicator.mint,
      intervalSec: indicator.intervalSec,
    },
    indicator,
  ) as TerminalIndicatorRow;
}

export function rememberIngestionKey(
  ingestionKey: string,
  kind: string,
  db: TerminalDatabase = terminalDb,
): boolean {
  const result = db.terminalIndexerKeys.findOrCreate(
    { ingestionKey },
    {
      ingestionKey,
      kind,
      seenAtMs: Date.now(),
    },
  );
  return result.created;
}

export function pruneIngestionKeys(
  kind: string,
  maxAgeMs: number,
  db: TerminalDatabase = terminalDb,
): number {
  return db.terminalIndexerKeys
    .delete()
    .where({
      kind,
      seenAtMs: {
        $lt: Date.now() - Math.max(60_000, maxAgeMs),
      },
    } as any)
    .exec();
}

export function recordWorkerError(
  worker: string,
  error: unknown,
  data: Record<string, unknown> = {},
  db: TerminalDatabase = terminalDb,
): void {
  const err = error instanceof Error ? error : new Error(String(error));

  db.terminalIndexerErrors.insert({
    errorKey: `${worker}:${Date.now()}:${Math.random()
      .toString(36)
      .slice(2, 10)}`,
    worker,
    message: err.message,
    stack: err.stack ?? null,
    dataJson: json(data),
    createdAtMs: Date.now(),
  });
}

export function upsertProcessStatus(
  input: {
    name: string;
    kind: string;
    status: string;
    buildId?: string | null;
    error?: unknown;
    data?: Record<string, unknown>;
    heartbeatAtMs?: number;
  },
  db: TerminalDatabase = terminalDb,
): ProcessStatusRow {
  const existing = db.processStatus
    .select()
    .where({ name: input.name })
    .first() as ProcessStatusRow | null;

  return db.processStatus.upsert(
    { name: input.name },
    {
      name: input.name,
      kind: input.kind,
      status: input.status,
      heartbeatAtMs: input.heartbeatAtMs ?? Date.now(),
      dataJson: json({
        ...parseObject(existing?.dataJson),
        pid: process.pid,
        buildId: input.buildId ?? null,
        ...(input.data ?? {}),
      }),
      error:
        input.error == null
          ? null
          : input.error instanceof Error
            ? input.error.message
            : String(input.error),
    },
  ) as ProcessStatusRow;
}

export function listProcessStatus(
  limit = 50,
  db: TerminalDatabase = terminalDb,
): ProcessStatusRow[] {
  return db.processStatus
    .select()
    .orderBy("heartbeatAtMs", "desc")
    .limit(Math.max(1, Math.min(250, limit)))
    .all() as ProcessStatusRow[];
}

export function listWorkerErrors(
  limit = 50,
  worker?: string | null,
  db: TerminalDatabase = terminalDb,
) {
  const query = db.terminalIndexerErrors
    .select()
    .orderBy("createdAtMs", "desc")
    .limit(Math.max(1, Math.min(250, limit)));

  return worker ? query.where({ worker }).all() : query.all();
}

export function terminalStoreStats(
  db: TerminalDatabase = terminalDb,
): Record<string, number> {
  const tokens = db.terminalTokens.count();
  const trades = db.terminalTrades.count();
  const indicators = db.terminalIndicators.count();

  const pricedTokens = (
    db.terminalTokens
      .select("priceSol", "priceUsd", "marketCapSol", "marketCapUsd")
      .all() as Array<
      Pick<
        TerminalTokenRow,
        "priceSol" | "priceUsd" | "marketCapSol" | "marketCapUsd"
      >
    >
  ).filter(
    (row) =>
      row.priceSol != null ||
      row.priceUsd != null ||
      row.marketCapSol != null ||
      row.marketCapUsd != null,
  ).length;

  return {
    tokens,
    pricedTokens,
    trades,
    indicators,
  };
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
  mint: string,
  now = Date.now(),
  db: TerminalDatabase = terminalDb,
): void {
  const intervals = [60, 300, 900] as const;
  const oldestSince = now - 900_000;

  const trades = db.terminalTrades
    .select()
    .where({
      mint,
      createdAtMs: { $gte: oldestSince },
    } as any)
    .orderBy("createdAtMs", "desc")
    .limit(20_000)
    .all() as TerminalTradeRow[];

  for (const intervalSec of intervals) {
    const since = now - intervalSec * 1000;
    const sample = trades.filter((row) => row.createdAtMs >= since);

    const prices = sample
      .map((row) => finite(row.priceUsd))
      .filter((value): value is number => value != null);

    const marketCaps = sample
      .map((row) => finite(row.marketCapUsd))
      .filter((value): value is number => value != null);

    upsertTerminalIndicator(
      {
        indicatorKey: `${mint}:${intervalSec}`,
        mint,
        intervalSec,
        smaPriceUsd: prices.length
          ? prices.reduce((sum, value) => sum + value, 0) / prices.length
          : null,
        smaMarketCapUsd: marketCaps.length
          ? marketCaps.reduce((sum, value) => sum + value, 0) /
            marketCaps.length
          : null,
        medianPriceUsd: median(prices),
        tradeCount: sample.length,
        buyCount: sample.filter((row) => row.side === "buy").length,
        sellCount: sample.filter((row) => row.side === "sell").length,
        volumeSol: sample.reduce(
          (sum, row) => sum + Math.abs(row.solDeltaUi),
          0,
        ),
        updatedAtMs: now,
      },
      db,
    );
  }
}
