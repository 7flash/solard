import { assertWebAuth } from "../../../../src/web/http.js";
import {
  listProcessStatus,
  listTerminalFeed,
  terminalStoreStats,
} from "../../../../shared/terminal-repo.js";
import {
  errorResponse,
  intParam,
  m,
  resolveTerminalSource,
  summarizeError,
} from "../../../_server/measure.js";

function boolParam(url: URL, name: string): boolean {
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

    const payload = await m(
      {
        start: () =>
          `terminal_feed:orm source=${source} limit=${limit} activeWindowMs=${activeWindowMs}`,
        end: (value: any) => ({
          rows: value.rows?.length ?? 0,
          priced: value.meta?.priced ?? 0,
          reads: value.meta?.reads,
        }),
        catch: summarizeError,
      },
      async () => {
        const rows = listTerminalFeed({
          source,
          limit,
          sinceMs,
          activeWindowMs,
          includeUnpriced: boolParam(url, "includeUnpriced"),
          hideMayhem: boolParam(url, "hideMayhem"),
          hideUsdc: boolParam(url, "hideUsdc"),
        });

        const priced = rows.filter(
          (row) =>
            row.marketCapUsd != null ||
            row.marketCapSol != null ||
            row.priceUsd != null ||
            row.priceSol != null,
        ).length;

        return {
          rows,
          rawRows: rows,
          stats:
            url.searchParams.get("stats") === "1" ? terminalStoreStats() : null,
          health:
            url.searchParams.get("health") === "1"
              ? {
                  ok: true,
                  processes: listProcessStatus(50),
                  store: terminalStoreStats(),
                }
              : null,
          meta: {
            source,
            limit,
            sinceMs,
            activeWindowMs,
            count: rows.length,
            mapped: rows.length,
            priced,
            reads: ["terminalTokens", "terminalIndicators"],
            orm: "sqlite-zod-orm",
            rawSql: false,
          },
        };
      },
    );

    return Response.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}
