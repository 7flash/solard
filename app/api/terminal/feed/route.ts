import { assertWebAuth } from "../../../../src/web/http.js";
import {
  terminalDb,
  terminalStoreStats,
} from "../../../../src/solard/db/terminal-store.js";
import { terminalHealthAction } from "../../../../src/solard/actions/terminal-health.js";
import { terminalFeedRowsToPumpRows } from "../../../../src/solard/terminal/api-map.js";
import {
  apiMeasure as m,
  label,
  requestParams,
} from "../../../../src/solard/measure.js";

type Source = "both" | "helius" | "pumpportal" | undefined;
type Row = Record<string, any>;
function resolveSource(value: unknown): Source {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("both")) return "both";
  if (text.includes("helius")) return "helius";
  if (text.includes("pump")) return "pumpportal";
  return undefined;
}
function compactError(error: unknown) {
  if (error instanceof Error)
    return { name: error.name, message: error.message };
  return { message: String(error) };
}
function errorStatus(error: unknown): number {
  const maybe = error as any;
  if (typeof maybe?.status === "number") return maybe.status;
  if (typeof maybe?.statusCode === "number") return maybe.statusCode;
  return 500;
}
function errorResponse(error: unknown): Response {
  return Response.json(
    { ok: false, error: compactError(error) },
    { status: errorStatus(error) },
  );
}
function intParam(
  url: URL,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(url.searchParams.get(name) ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
function matchesSource(row: Row, source: Source): boolean {
  if (!source || source === "both") return true;
  const text = String(row.source ?? "").toLowerCase();
  if (source === "helius")
    return text.includes("helius") || text.includes("telegram");
  return (
    text.includes("pumpportal") || text === "pump" || text.includes("telegram")
  );
}
function hasPrice(row: Row): boolean {
  return (
    row.marketCapUsd != null || row.priceUsd != null || row.priceSol != null
  );
}
function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}
function latestTime(row: Row): number {
  return Math.max(
    Number(row.lastTradeAtMs ?? 0),
    Number(row.priceUpdatedAtMs ?? 0),
    Number(row.updatedAtMs ?? 0),
    Number(row.createdAtMs ?? 0),
  );
}

function listFastTerminalRows(args: {
  limit: number;
  sinceMs: number;
  activeWindowMs: number;
  includeUnpriced: boolean;
  source: Source;
  hideMayhem: boolean;
  hideUsdc: boolean;
}): Row[] {
  const now = Date.now();
  const minUpdatedAt = Math.max(
    args.sinceMs,
    args.activeWindowMs > 0 ? now - args.activeWindowMs : 0,
  );
  const candidateLimit = Math.max(args.limit * 4, 80);
  const tokens = m.sync(
    label("terminal_feed:tokens", { minUpdatedAt, candidateLimit }),
    () =>
      terminalDb.raw<Row>(
        `SELECT * FROM terminalTokensLive WHERE updatedAtMs >= ? ORDER BY updatedAtMs DESC LIMIT ?`,
        minUpdatedAt,
        candidateLimit,
      ),
  );
  const trades = m.sync(
    label("terminal_feed:trades", { minUpdatedAt, candidateLimit }),
    () =>
      terminalDb.raw<Row>(
        `SELECT mint, source, priceSol, priceUsd, marketCapUsd, createdAtMs, updatedAtMs FROM terminalTradesLive WHERE createdAtMs >= ? ORDER BY createdAtMs DESC LIMIT ?`,
        minUpdatedAt,
        candidateLimit * 3,
      ),
  );
  const byMint = new Map<string, Row>();
  for (const token of tokens) {
    if (!token.mint || !matchesSource(token, args.source)) continue;
    if (args.hideMayhem && Number(token.isMayhemMode ?? 0) !== 0) continue;
    const quoteText =
      `${token.quoteAsset ?? ""} ${token.quoteMint ?? ""}`.toLowerCase();
    if (
      args.hideUsdc &&
      (quoteText.includes("usdc") ||
        quoteText.includes("epjfwdd5aufqssqem2qn1xzybapc8g4wegkgzwydt1v"))
    )
      continue;
    if (!args.includeUnpriced && !hasPrice(token) && !token.image) continue;
    byMint.set(String(token.mint), {
      ...token,
      kind: String(token.source ?? "").startsWith("telegram")
        ? "signal"
        : "pump",
      priceUpdatedAtMs: hasPrice(token) ? Number(token.updatedAtMs ?? 0) : null,
      priceSource: hasPrice(token) ? token.source : null,
    });
  }
  for (const trade of trades) {
    if (!trade.mint || !matchesSource(trade, args.source)) continue;
    const mint = String(trade.mint);
    const existing = byMint.get(mint);
    const tradeAt = Math.max(
      Number(trade.createdAtMs ?? 0),
      Number(trade.updatedAtMs ?? 0),
    );
    const base = existing ?? {
      mint,
      symbol: "",
      name: "",
      image: null,
      uri: null,
      description: null,
      website: null,
      twitter: null,
      telegram: null,
      creator: null,
      bondingCurveKey: null,
      source: trade.source ?? "helius-trade",
      phase: "pump",
      isMayhemMode: 0,
      quoteAsset: null,
      quoteMint: null,
      supplyUi: 1_000_000_000,
      initialMarketCapUsd: trade.marketCapUsd ?? null,
      lastSlot: 0,
      signature: null,
      createdAtMs: tradeAt,
      updatedAtMs: tradeAt,
      kind: "pump",
    };
    byMint.set(mint, {
      ...base,
      priceSol: trade.priceSol ?? base.priceSol ?? null,
      priceUsd: trade.priceUsd ?? base.priceUsd ?? null,
      marketCapUsd: trade.marketCapUsd ?? base.marketCapUsd ?? null,
      updatedAtMs: Math.max(Number(base.updatedAtMs ?? 0), tradeAt),
      lastTradeAtMs: Math.max(Number(base.lastTradeAtMs ?? 0), tradeAt),
      priceUpdatedAtMs: hasPrice(trade)
        ? tradeAt
        : (base.priceUpdatedAtMs ?? null),
      priceSource: hasPrice(trade) ? trade.source : (base.priceSource ?? null),
    });
  }
  const mints = Array.from(byMint.keys()).slice(
    0,
    Math.min(500, Math.max(args.limit * 2, args.limit)),
  );
  if (mints.length) {
    const params = placeholders(mints.length);
    const indicators = m.sync("terminal_feed:indicators", () =>
      terminalDb.raw<Row>(
        `SELECT * FROM terminalIndicatorsLive WHERE mint IN (${params}) AND intervalSec IN (60,300,900)`,
        ...mints,
      ),
    );
    for (const indicator of indicators) {
      const row = byMint.get(String(indicator.mint));
      if (!row) continue;
      if (Number(indicator.intervalSec) === 60)
        row.sma1m = indicator.smaMarketCapUsd;
      if (Number(indicator.intervalSec) === 300)
        row.sma5m = indicator.smaMarketCapUsd;
      if (Number(indicator.intervalSec) === 900)
        row.sma15m = indicator.smaMarketCapUsd;
      row.tradeCount = Math.max(
        Number(row.tradeCount ?? 0),
        Number(indicator.tradeCount ?? 0),
      );
    }
    const counts = m.sync("terminal_feed:counts", () =>
      terminalDb.raw<Row>(
        `SELECT mint, COUNT(*) as tradeCount FROM terminalTradesLive WHERE createdAtMs >= ? AND mint IN (${params}) GROUP BY mint`,
        minUpdatedAt,
        ...mints,
      ),
    );
    for (const count of counts) {
      const row = byMint.get(String(count.mint));
      if (row) row.tradeCount = Number(count.tradeCount ?? row.tradeCount ?? 0);
    }
  }
  return Array.from(byMint.values())
    .filter((row) => args.includeUnpriced || hasPrice(row) || row.image)
    .map((row) => {
      const priceUpdatedAtMs =
        row.priceUpdatedAtMs == null ? null : Number(row.priceUpdatedAtMs);
      const priceAgeMs =
        priceUpdatedAtMs == null ? null : Math.max(0, now - priceUpdatedAtMs);
      return {
        ...row,
        sma1m: row.sma1m ?? row.marketCapUsd ?? null,
        sma5m: row.sma5m ?? row.marketCapUsd ?? null,
        sma15m: row.sma15m ?? row.marketCapUsd ?? null,
        tradeCount: Number(row.tradeCount ?? 0),
        priceUpdatedAtMs,
        priceAgeMs,
        priceStatus:
          priceUpdatedAtMs == null
            ? "missing"
            : priceAgeMs != null && priceAgeMs > 30_000
              ? "stale"
              : String(row.priceSource ?? row.source ?? "").includes("snapshot")
                ? "snapshot"
                : "live",
      };
    })
    .sort((a, b) => latestTime(b) - latestTime(a))
    .slice(0, args.limit);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const payload = await m(
      label("terminal_feed:get", requestParams(request)),
      async () => {
        m.sync("terminal_feed:auth", () => {
          assertWebAuth(request);
          return "ok";
        });
        const url = new URL(request.url);
        const source = resolveSource(url.searchParams.get("source"));
        const limit = intParam(url, "limit", 300, 1, 500);
        const sinceMs = intParam(url, "sinceMs", 0, 0, Number.MAX_SAFE_INTEGER);
        const activeWindowMs = intParam(
          url,
          "activeWindowMs",
          Number(process.env.SOLARD_TERMINAL_ACTIVE_WINDOW_MS ?? "300000"),
          0,
          24 * 60 * 60 * 1000,
        );
        const includeUnpriced =
          url.searchParams.get("includeUnpriced") === "1" ||
          source === "helius";
        const rawRows = listFastTerminalRows({
          limit,
          sinceMs,
          activeWindowMs,
          includeUnpriced,
          source,
          hideMayhem: url.searchParams.get("hideMayhem") === "1",
          hideUsdc: url.searchParams.get("hideUsdc") === "1",
        });
        return {
          rows: terminalFeedRowsToPumpRows(rawRows),
          rawRows,
          stats:
            url.searchParams.get("stats") === "1" ? terminalStoreStats() : null,
          health:
            url.searchParams.get("health") === "1"
              ? terminalHealthAction({ errors: 8, source })
              : null,
          meta: {
            source,
            limit,
            activeWindowMs,
            includeUnpriced,
            count: rawRows.length,
          },
        };
      },
    );
    return Response.json(payload);
  } catch (error) {
    m.sync("terminal_feed:get_error", () => error);
    return errorResponse(error);
  }
}
