import {
  listProcessStatus,
  listTerminalFeed,
  terminalStoreStats,
} from "../../../../shared/db.js";
import { assertWebAuth } from "../../../../src/web/http.js";
import {
  errorResponse,
  intParam,
  m,
  resolveTerminalSource,
  summarizeError,
} from "../../../_server/measure.js";

function enabled(url: URL, name: string): boolean {
  const value = url.searchParams.get(name);

  return value === "1" || value === "true" || value === "yes";
}

export async function GET(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);

    const url = new URL(request.url);

    const source =
      resolveTerminalSource(url.searchParams.get("source")) ?? "both";

    const limit = intParam(url, "limit", 160, 1, 500);

    const sinceMs = intParam(url, "sinceMs", 0, 0, Number.MAX_SAFE_INTEGER);

    const activeWindowMs = intParam(
      url,
      "activeWindowMs",
      300_000,
      1_000,
      24 * 60 * 60_000,
    );

    const rows = await m(
      {
        start: () =>
          `terminal_feed:shared_db source=${source} limit=${limit} activeWindowMs=${activeWindowMs}`,

        end: (value) => ({
          rows: Array.isArray(value) ? value.length : 0,
        }),

        catch: summarizeError,
      },
      async () =>
        listTerminalFeed({
          source,
          limit,
          sinceMs,
          activeWindowMs,

          includeUnpriced: enabled(url, "includeUnpriced"),

          hideMayhem: enabled(url, "hideMayhem"),

          hideUsdc: enabled(url, "hideUsdc"),

          priceWindowTtlMs: 1_000,
        }),
    );

    const stats = enabled(url, "stats") ? terminalStoreStats() : null;

    const health = enabled(url, "health")
      ? {
          ok: true,
          processes: listProcessStatus(),
          store: stats ?? terminalStoreStats(),
        }
      : null;

    const priced = rows.filter(
      (row) =>
        row.marketCapUsd != null ||
        row.marketCapSol != null ||
        row.priceUsd != null ||
        row.priceSol != null,
    ).length;

    return Response.json({
      rows,
      rawRows: rows,
      stats,
      health,

      meta: {
        source,
        limit,
        sinceMs,
        activeWindowMs,

        count: rows.length,
        mapped: rows.length,
        priced,

        priceWindowTtlMs: 1_000,

        reads: ["terminalTokensLive", "tokenPriceWindows"],

        writes: [],
        appendOnlyTrades: true,

        databaseModule: "shared/db.ts",

        pageRuntime: "app/terminal/page.client.tsx",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
