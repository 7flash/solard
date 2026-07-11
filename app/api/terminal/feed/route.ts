import { assertWebAuth } from "../../../../src/web/http.js";
import { terminalDb } from "../../../../shared/terminal-db.js";
import { terminalHealthAction } from "../../../../src/solard/actions/terminal-health.js";
import {
  errorResponse,
  intParam,
  m,
  resolveTerminalSource,
  summarizeError,
  type TerminalSource,
} from "../../../_server/measure.js";

type Row = Record<string, any>;

function terminalStoreStats(): Record<string, number> {
  const scalar = (sql: string): number =>
    Number(terminalDb.raw<{ count: number }>(sql)[0]?.count ?? 0);

  return {
    tokens: scalar("SELECT COUNT(*) as count FROM terminalTokensLive"),
    pricedTokens: scalar(
      "SELECT COUNT(*) as count FROM terminalTokensLive WHERE marketCapUsd IS NOT NULL OR priceUsd IS NOT NULL OR marketCapSol IS NOT NULL OR priceSol IS NOT NULL",
    ),
    trades: scalar("SELECT COUNT(*) as count FROM terminalTradesLive"),
    indicators: scalar("SELECT COUNT(*) as count FROM terminalIndicatorsLive"),
  };
}

function boolParam(url: URL, name: string): boolean {
  const value = url.searchParams.get(name);
  return value === "1" || value === "true" || value === "yes";
}

function priced(row: Row): boolean {
  return (
    row.marketCapUsd != null ||
    row.marketCapSol != null ||
    row.priceUsd != null ||
    row.priceSol != null
  );
}

function pricedCount(rows: Row[]): number {
  return rows.filter(priced).length;
}

function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function sourceWhere(source: TerminalSource): {
  sql: string;
  params: unknown[];
} {
  if (!source || source === "both") return { sql: "1=1", params: [] };
  if (source === "helius") {
    return {
      sql: "(LOWER(source) LIKE '%helius%' OR LOWER(source) LIKE '%telegram%')",
      params: [],
    };
  }
  return {
    sql: "(LOWER(source) LIKE '%pumpportal%' OR LOWER(source) = 'pump' OR LOWER(source) LIKE '%telegram%')",
    params: [],
  };
}

function latestPriceAgeMs(rows: Row[]): number | null {
  const latest = Math.max(
    0,
    ...rows
      .map((row) =>
        Math.max(
          Number(row.priceUpdatedAtMs ?? 0),
          Number(row.lastTradeAtMs ?? 0),
          Number(row.updatedAtMs ?? 0),
          Number(row.createdAtMs ?? 0),
        ),
      )
      .filter((value) => Number.isFinite(value)),
  );
  return latest > 0 ? Math.max(0, Date.now() - latest) : null;
}

function hideUsdcSql(): string {
  return `(
    LOWER(COALESCE(quoteAsset, '')) NOT LIKE '%usdc%' AND
    LOWER(COALESCE(quoteMint, '')) NOT LIKE '%epjfwdd5aufqssqem2qn1xzybapc8g4wegkgzwydt1v%'
  )`;
}

function normalizeTokenRow(row: Row, now: number): Row {
  const priceUpdatedAtMs =
    row.marketCapUsd != null || row.priceUsd != null || row.priceSol != null
      ? Number(row.updatedAtMs ?? 0)
      : null;
  const priceAgeMs =
    priceUpdatedAtMs == null ? null : Math.max(0, now - priceUpdatedAtMs);
  return {
    ...row,
    lastTradeAtMs: Number(row.updatedAtMs ?? row.createdAtMs ?? 0),
    priceUpdatedAtMs,
    priceAgeMs,
    priceStatus:
      priceUpdatedAtMs == null
        ? "missing"
        : priceAgeMs != null && priceAgeMs > 30_000
          ? "stale"
          : "live",
    sma1m: row.sma1m ?? row.marketCapUsd ?? null,
    sma5m: row.sma5m ?? row.marketCapUsd ?? null,
    sma15m: row.sma15m ?? row.marketCapUsd ?? null,
    tradeCount: Number(row.tradeCount ?? 0),
    raw: row,
  };
}

function listFastRows(args: {
  source: TerminalSource;
  limit: number;
  sinceMs: number;
  activeWindowMs: number;
  includeUnpriced: boolean;
  hideMayhem: boolean;
  hideUsdc: boolean;
}): {
  rows: Row[];
  tokenRows: number;
  indicatorRows: number;
  minUpdatedAt: number;
} {
  const now = Date.now();
  const minUpdatedAt = Math.max(
    args.sinceMs,
    args.activeWindowMs > 0 ? now - args.activeWindowMs : 0,
  );

  const source = sourceWhere(args.source);
  const where: string[] = ["updatedAtMs >= ?", source.sql];
  const params: unknown[] = [minUpdatedAt, ...source.params];

  if (args.hideMayhem) where.push("COALESCE(isMayhemMode, 0) = 0");
  if (args.hideUsdc) where.push(hideUsdcSql());
  if (!args.includeUnpriced) {
    where.push(
      "(marketCapUsd IS NOT NULL OR marketCapSol IS NOT NULL OR priceUsd IS NOT NULL OR priceSol IS NOT NULL OR image IS NOT NULL)",
    );
  }

  const candidateLimit = Math.max(args.limit * 2, args.limit, 120);
  const tokens = terminalDb.raw<Row>(
    `SELECT *
       FROM terminalTokensLive
      WHERE ${where.join(" AND ")}
      ORDER BY updatedAtMs DESC
      LIMIT ?`,
    ...params,
    candidateLimit,
  );

  const rowsByMint = new Map<string, Row>();
  for (const token of tokens) {
    if (!token.mint) continue;
    rowsByMint.set(String(token.mint), token);
    if (rowsByMint.size >= args.limit) break;
  }

  const mints = [...rowsByMint.keys()];
  let indicatorCount = 0;

  if (mints.length) {
    const indicators = terminalDb.raw<Row>(
      `SELECT mint, intervalSec, smaMarketCapUsd, smaPriceUsd, tradeCount, updatedAtMs
         FROM terminalIndicatorsLive
        WHERE mint IN (${sqlPlaceholders(mints.length)})
          AND intervalSec IN (60, 300, 900)`,
      ...mints,
    );
    indicatorCount = indicators.length;

    for (const indicator of indicators) {
      const row = rowsByMint.get(String(indicator.mint));
      if (!row) continue;
      if (Number(indicator.intervalSec) === 60) {
        row.sma1m =
          indicator.smaMarketCapUsd ?? row.sma1m ?? row.marketCapUsd ?? null;
      }
      if (Number(indicator.intervalSec) === 300) {
        row.sma5m =
          indicator.smaMarketCapUsd ?? row.sma5m ?? row.marketCapUsd ?? null;
      }
      if (Number(indicator.intervalSec) === 900) {
        row.sma15m =
          indicator.smaMarketCapUsd ?? row.sma15m ?? row.marketCapUsd ?? null;
      }
      row.tradeCount = Math.max(
        Number(row.tradeCount ?? 0),
        Number(indicator.tradeCount ?? 0),
      );
    }
  }

  return {
    rows: [...rowsByMint.values()].map((row) => normalizeTokenRow(row, now)),
    tokenRows: tokens.length,
    indicatorRows: indicatorCount,
    minUpdatedAt,
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const source = resolveTerminalSource(url.searchParams.get("source"));
    const limit = intParam(url, "limit", 160, 1, 500);
    const sinceMs = intParam(url, "sinceMs", 0, 0, Number.MAX_SAFE_INTEGER);
    const requestedActiveWindowMs = intParam(
      url,
      "activeWindowMs",
      Number(process.env.SOLARD_TERMINAL_FEED_WINDOW_MS ?? "300000"),
      0,
      24 * 60 * 60 * 1000,
    );
    const archive = boolParam(url, "archive") || boolParam(url, "full");
    const activeWindowMs =
      requestedActiveWindowMs === 0 && !archive
        ? Number(process.env.SOLARD_TERMINAL_FEED_WINDOW_MS ?? "300000")
        : requestedActiveWindowMs;

    const includeUnpriced =
      url.searchParams.get("includeUnpriced") === "1" ||
      source === "helius" ||
      source === "both";

    const payload = await m(
      {
        start: () =>
          `terminal_feed:get_fast source=${source ?? "both"} limit=${limit} activeWindowMs=${activeWindowMs}`,
        end: (value: any) => ({
          rows: Array.isArray(value.rows) ? value.rows.length : 0,
          priced: Array.isArray(value.rows) ? pricedCount(value.rows) : 0,
          tokenRows: value.meta?.tokenRows,
          indicatorRows: value.meta?.indicatorRows,
          latestPriceAgeMs: Array.isArray(value.rows)
            ? latestPriceAgeMs(value.rows)
            : null,
          stats: value.stats ? "yes" : "no",
          health:
            value.health == null
              ? "none"
              : value.health?.ok === true
                ? "ok"
                : "bad",
          source: value.meta?.source ?? "both",
        }),
        catch: summarizeError,
      },
      async () => {
        await m(
          {
            start: () => "terminal_feed:auth",
            end: () => ({ ok: true }),
            catch: summarizeError,
          },
          async () => {
            assertWebAuth(request);
            return true;
          },
        );

        const listed = await m(
          {
            start: () =>
              `terminal_feed:list_tokens_and_sma source=${source ?? "both"} limit=${limit} activeWindowMs=${activeWindowMs}`,
            end: (value: ReturnType<typeof listFastRows>) => ({
              rows: value.rows.length,
              tokenRows: value.tokenRows,
              indicatorRows: value.indicatorRows,
              priced: pricedCount(value.rows),
              latestPriceAgeMs: latestPriceAgeMs(value.rows),
            }),
            catch: summarizeError,
          },
          async () =>
            listFastRows({
              source,
              limit,
              sinceMs,
              activeWindowMs,
              includeUnpriced,
              hideMayhem: url.searchParams.get("hideMayhem") === "1",
              hideUsdc: url.searchParams.get("hideUsdc") === "1",
            }),
        );

        const stats =
          url.searchParams.get("stats") === "1"
            ? await m(
                {
                  start: () => "terminal_feed:stats",
                  end: (value: any) => ({
                    tokens: value?.tokens,
                    pricedTokens: value?.pricedTokens,
                    trades: value?.trades,
                    indicators: value?.indicators,
                  }),
                  catch: summarizeError,
                },
                async () => terminalStoreStats(),
              )
            : null;

        const health =
          url.searchParams.get("health") === "1"
            ? await m(
                {
                  start: () => "terminal_feed:health",
                  end: (value: any) => ({
                    ok: value?.ok,
                    workers: Array.isArray(value?.processes)
                      ? value.processes.length
                      : 0,
                    errors: Array.isArray(value?.errors)
                      ? value.errors.length
                      : 0,
                  }),
                  catch: summarizeError,
                },
                async () => terminalHealthAction({ errors: 8, source }),
              )
            : null;

        return {
          rows: listed.rows,
          rawRows: listed.rows,
          stats,
          health,
          meta: {
            source,
            limit,
            sinceMs,
            requestedActiveWindowMs,
            activeWindowMs,
            archive,
            includeUnpriced,
            count: listed.rows.length,
            mapped: listed.rows.length,
            tokenRows: listed.tokenRows,
            indicatorRows: listed.indicatorRows,
            priced: pricedCount(listed.rows),
            latestPriceAgeMs: latestPriceAgeMs(listed.rows),
            minUpdatedAt: listed.minUpdatedAt,
            reads: ["terminalTokensLive", "terminalIndicatorsLive"],
            skips: ["terminalTradesLive"],
          },
        };
      },
    );

    return Response.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}
