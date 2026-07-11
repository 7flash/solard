import { assertWebAuth } from "../../../../src/web/http.js";
import {
  listTerminalFeed,
  terminalStoreStats,
} from "../../../../src/solard/db/terminal-store.js";
import { terminalHealthAction } from "../../../../src/solard/actions/terminal-health.js";
import { terminalFeedRowsToPumpRows } from "../../../../src/solard/terminal/api-map.js";
import {
  errorResponse,
  intParam,
  m,
  resolveTerminalSource,
  summarizeError,
} from "../../../_server/measure.js";

function pricedCount(rows: any[]): number {
  return rows.filter(
    (row) =>
      row?.marketCapUsd != null ||
      row?.marketCapSol != null ||
      row?.priceUsd != null ||
      row?.priceSol != null,
  ).length;
}

function latestPriceAgeMs(rows: any[]): number | null {
  const latest = Math.max(
    0,
    ...rows
      .map((row) =>
        Math.max(
          Number(row?.priceUpdatedAtMs ?? 0),
          Number(row?.lastTradeAtMs ?? 0),
          Number(row?.updatedAtMs ?? 0),
        ),
      )
      .filter((value) => Number.isFinite(value)),
  );
  return latest > 0 ? Math.max(0, Date.now() - latest) : null;
}

function boolParam(url: URL, name: string): boolean {
  const value = url.searchParams.get(name);
  return value === "1" || value === "true" || value === "yes";
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
      Number(process.env.SOLARD_TERMINAL_FEED_WINDOW_MS ?? "180000"),
      0,
      24 * 60 * 60 * 1000,
    );

    /**
     * Defensive fix:
     * activeWindowMs=0 used to mean "scan all live tables". On a DB with ~1.8M
     * terminalTradesLive rows this can look like a hang. The UI should poll a
     * recent live window. Use archive=1 only for explicit full-history reads.
     */
    const archive = boolParam(url, "archive") || boolParam(url, "full");
    const activeWindowMs =
      requestedActiveWindowMs === 0 && !archive
        ? Number(process.env.SOLARD_TERMINAL_FEED_WINDOW_MS ?? "180000")
        : requestedActiveWindowMs;

    const includeUnpriced =
      url.searchParams.get("includeUnpriced") === "1" ||
      source === "helius" ||
      source === "both";

    const payload = await m(
      {
        start: () =>
          `terminal_feed:get source=${source ?? "auto"} limit=${limit} activeWindowMs=${activeWindowMs}${archive ? " archive=1" : ""}`,
        end: (value: any) => ({
          rows: Array.isArray(value.rows) ? value.rows.length : 0,
          raw: Array.isArray(value.rawRows) ? value.rawRows.length : 0,
          priced: Array.isArray(value.rows) ? pricedCount(value.rows) : 0,
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
          source: value.meta?.source ?? "auto",
          requestedActiveWindowMs,
          effectiveActiveWindowMs: activeWindowMs,
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

        const rawRows = await m(
          {
            start: () =>
              `terminal_feed:list_rows source=${source ?? "auto"} limit=${limit} activeWindowMs=${activeWindowMs}`,
            end: (rows: any[]) => ({
              rows: Array.isArray(rows) ? rows.length : 0,
              priced: Array.isArray(rows) ? pricedCount(rows) : 0,
              latestPriceAgeMs: Array.isArray(rows)
                ? latestPriceAgeMs(rows)
                : null,
            }),
            catch: summarizeError,
          },
          async () =>
            listTerminalFeed({
              limit,
              sinceMs,
              activeWindowMs,
              includeUnpriced,
              source,
              hideMayhem: url.searchParams.get("hideMayhem") === "1",
              hideUsdc: url.searchParams.get("hideUsdc") === "1",
            }),
        );

        const rows = await m(
          {
            start: () => `terminal_feed:map_rows raw=${rawRows.length}`,
            end: (rows: any[]) => ({
              rows: Array.isArray(rows) ? rows.length : 0,
              priced: Array.isArray(rows) ? pricedCount(rows) : 0,
            }),
            catch: summarizeError,
          },
          async () => terminalFeedRowsToPumpRows(rawRows),
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
          rows,
          rawRows,
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
            count: rawRows.length,
            mapped: rows.length,
            priced: pricedCount(rows),
            latestPriceAgeMs: latestPriceAgeMs(rows),
          },
        };
      },
    );

    return Response.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}
