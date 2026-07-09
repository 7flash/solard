import { assertWebAuth, readJson } from "../../../src/web/http.js";
import { withMeasuredApi } from "../../../src/solard/api-response.js";
import { ensureProcessesAction } from "../../../src/solard/actions/processes.js";
import {
  listTerminalFeed,
  terminalStoreStats,
} from "../../../src/solard/db/terminal-store.js";
import { terminalHealthAction } from "../../../src/solard/actions/terminal-health.js";
import { terminalFeedRowsToPumpRows } from "../../../src/solard/terminal/api-map.js";
import { listTokenWatchGroups } from "../../../src/pump/services/pump-live-store.js";

function safeWatchGroups() {
  try {
    return listTokenWatchGroups();
  } catch {
    return [];
  }
}

export function GET(request: Request): Promise<Response> {
  return withMeasuredApi({
    request,
    route: "/api/pump-live",
    method: "GET",
    label: "terminal-db-snapshot",
    summarize: (value: any) => ({
      newTokens: Array.isArray(value?.newTokens) ? value.newTokens.length : 0,
      rawTokens: Array.isArray(value?.rawTokens) ? value.rawTokens.length : 0,
      db: value?.db,
      healthOk: value?.health?.ok,
    }),
    fn: async () => {
      assertWebAuth(request);
      const url = new URL(request.url);
      const source = (() => {
        const text = String(url.searchParams.get("source") ?? "").toLowerCase();
        if (text.includes("helius")) return "helius";
        if (text.includes("both")) return "both";
        if (text.includes("pump")) return "pumpportal";
        return undefined;
      })();
      if (url.searchParams.get("ensure") === "1") {
        await ensureProcessesAction({
          all: true,
          telegram: url.searchParams.get("telegram") === "1",
          source,
          restartStale: true,
        });
      }
      const rawTokens = listTerminalFeed({
        limit: Number(url.searchParams.get("limit") ?? "250"),
        sinceMs: Number(url.searchParams.get("sinceMs") ?? "0"),
        activeWindowMs: Number(
          url.searchParams.get("activeWindowMs") ??
            process.env.SOLARD_TERMINAL_ACTIVE_WINDOW_MS ??
            "300000",
        ),
        includeUnpriced:
          url.searchParams.get("includeUnpriced") === "1" ||
          source === "helius",
      });
      return {
        newTokens: terminalFeedRowsToPumpRows(rawTokens),
        rawTokens,
        watchGroups: safeWatchGroups(),
        watchedMints: [],
        db: terminalStoreStats(),
        health: terminalHealthAction({ errors: 8 }),
        source,
      };
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withMeasuredApi({
    request,
    route: "/api/pump-live",
    method: "POST",
    label: String(body.action ?? "ensure-workers"),
    summarize: (value: any) => ({
      ready: value?.ready,
      workers: value?.workers,
    }),
    fn: async () => {
      assertWebAuth(request);
      const action = String(body.action ?? "ensure-workers");
      const source = (() => {
        const text = String((body as any).source ?? "").toLowerCase();
        if (text.includes("helius")) return "helius";
        if (text.includes("both")) return "both";
        if (text.includes("pump")) return "pumpportal";
        return undefined;
      })();
      if (action === "stop") {
        return {
          status: "ignored",
          reason:
            "browser stop only stops polling; worker lifecycle is managed by bgrun / api/processes",
        };
      }
      return await ensureProcessesAction({
        worker: typeof body.worker === "string" ? body.worker : null,
        all: true,
        telegram: body.telegram === true,
        source,
        restart: body.restart === true,
        restartStale: body.restartStale !== false,
      });
    },
  });
}
