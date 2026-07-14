import { assertWebAuth } from "../../../../src/web/http.js";
import {
  listTerminalFeed,
  terminalDatabaseHealth,
  terminalStoreStats,
  db,
} from "../../../../shared/db.js";
import {
  apiMeasure as m,
  label,
  requestParams,
} from "../../../../src/solard/measure.js";

function compactError(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { message: String(error) };
}

function errorStatus(error: unknown): number {
  const value = error as any;
  return typeof value?.status === "number"
    ? value.status
    : typeof value?.statusCode === "number"
      ? value.statusCode
      : 500;
}

function errorResponse(error: unknown): Response {
  return Response.json(
    { ok: false, error: compactError(error) },
    { status: errorStatus(error) },
  );
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function enabled(url: URL, name: string): boolean {
  const value = String(url.searchParams.get(name) ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function resolveSource(value: unknown): "both" | "helius" | "pumpportal" {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("helius")) return "helius";
  if (text.includes("pump") && !text.includes("both")) return "pumpportal";
  return "both";
}

export async function GET(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const url = new URL(request.url);

    const payload = await m(
      label("terminal_feed_v9:get", requestParams(request)),
      async () => {
        const source = resolveSource(url.searchParams.get("source"));
        const limit = intParam(url, "limit", 0, 0, 50_000);
        const sinceMs = intParam(url, "sinceMs", 0, 0, Number.MAX_SAFE_INTEGER);
        const activeWindowMs = intParam(
          url,
          "activeWindowMs",
          0,
          0,
          24 * 60 * 60_000,
        );
        const minMarketCapUsd = Math.max(
          0,
          finite(url.searchParams.get("minMarketCapUsd")) ?? 0,
        );
        const maxMarketCapUsd = Math.max(
          0,
          finite(url.searchParams.get("maxMarketCapUsd")) ?? 0,
        );
        const pinned = String(url.searchParams.get("pinned") ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
          .slice(0, 250);

        const tokens = m(
          "get tokens",
          () =>
            db.terminalTokensLive
              .select()
              .orderBy("updatedAtMs", "desc")
              .all() as Record<string, unknown>[],
        );

        const rows = listTerminalFeed({
          source,
          limit,
          sinceMs,
          activeWindowMs,
          includeUnpriced:
            !url.searchParams.has("includeUnpriced") ||
            enabled(url, "includeUnpriced"),
          minMarketCapUsd,
          maxMarketCapUsd,
          pinned,
        });

        const stats = enabled(url, "stats") ? terminalStoreStats() : null;
        const health = enabled(url, "health") ? terminalDatabaseHealth() : null;
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
          stats,
          health,
          meta: {
            buildId: "terminal-feed-v10-orm-health-boundary",
            source,
            limit,
            activeWindowMs,
            count: rows.length,
            priced,
            reads: [
              "terminalTokensLive",
              "terminalTradesLive",
              "tokenTradesV2",
              "terminalHolderSnapshotsLive",
            ],
          },
        };
      },
    );

    return Response.json(payload, {
      headers: {
        "cache-control": "no-store, no-cache, must-revalidate",
        pragma: "no-cache",
      },
    });
  } catch (error) {
    m.sync("terminal_feed_v9:get_error", () => error);
    return errorResponse(error);
  }
}
