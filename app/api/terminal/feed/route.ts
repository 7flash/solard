import { assertWebAuth } from "../../../../src/web/http.js";
import { withMeasuredApi } from "../../../../src/solard/api-response.js";
import {
  listTerminalFeed,
  terminalStoreStats,
} from "../../../../src/solard/db/terminal-store.js";
import { ensureProcessesAction } from "../../../../src/solard/actions/processes.js";
import { terminalHealthAction } from "../../../../src/solard/actions/terminal-health.js";
import { terminalFeedRowsToPumpRows } from "../../../../src/solard/terminal/api-map.js";

function sourceFrom(
  value: string | null,
): "helius" | "pumpportal" | "both" | undefined {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("helius")) return "helius";
  if (text.includes("both")) return "both";
  if (text.includes("pump")) return "pumpportal";
  return undefined;
}

export function GET(request: Request): Promise<Response> {
  return withMeasuredApi({
    request,
    route: "/api/terminal/feed",
    method: "GET",
    label: "terminal feed",
    summarize: (value: any) => ({
      rows: Array.isArray(value?.rows) ? value.rows.length : 0,
      rawRows: Array.isArray(value?.rawRows) ? value.rawRows.length : 0,
      stats: value?.stats,
      source: value?.source,
      healthOk: value?.health?.ok,
    }),
    fn: async () => {
      assertWebAuth(request);
      const url = new URL(request.url);
      const source = sourceFrom(url.searchParams.get("source"));
      if (url.searchParams.get("ensure") === "1") {
        await ensureProcessesAction({
          all: true,
          telegram: url.searchParams.get("telegram") === "1",
          source,
          restartStale: true,
        });
      }
      const rawRows = listTerminalFeed({
        limit: Number(url.searchParams.get("limit") ?? "250"),
        sinceMs: Number(url.searchParams.get("sinceMs") ?? "0"),
        activeWindowMs: Number(
          url.searchParams.get("activeWindowMs") ??
            process.env.SOLARD_TERMINAL_ACTIVE_WINDOW_MS ??
            "300000",
        ),
        includeUnpriced:
          url.searchParams.get("includeUnpriced") === "1" ||
          (source === "helius" && url.searchParams.get("pricedOnly") !== "1"),
      });
      const rows = terminalFeedRowsToPumpRows(rawRows);
      const stats = terminalStoreStats();
      const health = terminalHealthAction({ errors: 8 });
      return {
        source,
        rows,
        rawRows,
        stats,
        health,
        debug: {
          source,
          activeWindowMs: Number(
            url.searchParams.get("activeWindowMs") ??
              process.env.SOLARD_TERMINAL_ACTIVE_WINDOW_MS ??
              "300000",
          ),
          includeUnpriced: url.searchParams.get("includeUnpriced") === "1",
          returnedRows: rows.length,
          rawRows: rawRows.length,
          stats,
        },
      };
    },
  });
}
