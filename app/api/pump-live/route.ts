import { assertWebAuth, readJson } from "../../../src/web/http.js";
import { ensureProcessesAction } from "../../../src/solard/actions/processes.js";
import {
  listTerminalFeed,
  terminalStoreStats,
} from "../../../src/solard/db/terminal-store.js";
import { terminalHealthAction } from "../../../src/solard/actions/terminal-health.js";
import { terminalFeedRowsToPumpRows } from "../../../src/solard/terminal/api-map.js";
import { listTokenWatchGroups } from "../../../src/pump/services/pump-live-store.js";
import {
  errorResponse,
  intParam,
  m,
  resolveTerminalSource,
  summarizeError,
  type TerminalSource,
} from "../../_server/measure.js";

function safeWatchGroups() {
  try {
    return listTokenWatchGroups();
  } catch {
    return [];
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);

    const url = new URL(request.url);
    const source = resolveTerminalSource(url.searchParams.get("source"));
    const limit = intParam(url, "limit", 250, 1, 500);
    const sinceMs = intParam(url, "sinceMs", 0, 0, Number.MAX_SAFE_INTEGER);
    const activeWindowMs = intParam(
      url,
      "activeWindowMs",
      Number(process.env.SOLARD_TERMINAL_ACTIVE_WINDOW_MS ?? "0"),
      0,
      24 * 60 * 60 * 1000,
    );
    const includeUnpriced =
      url.searchParams.get("includeUnpriced") === "1" ||
      source === "helius" ||
      source === "both";

    const payload = await m(
      {
        start: () =>
          `pump_live:get source=${source ?? "auto"} limit=${limit} activeWindowMs=${activeWindowMs}`,
        end: (value: any) => ({
          new: Array.isArray(value.newTokens) ? value.newTokens.length : 0,
          raw: Array.isArray(value.rawTokens) ? value.rawTokens.length : 0,
          groups: Array.isArray(value.watchGroups)
            ? value.watchGroups.length
            : 0,
          health: value.health?.ok === true ? "ok" : "bad",
          source: value.source ?? "auto",
        }),
        catch: summarizeError,
      },
      async () => {
        let ensure:
          | { requested: false }
          | { requested: true; mode: "background" | "awaited" } = {
          requested: false,
        };

        if (url.searchParams.get("ensure") === "1") {
          const ensureArgs = {
            all: true,
            telegram: url.searchParams.get("telegram") === "1",
            source,
            restartStale: true,
          };

          if (
            url.searchParams.get("awaitEnsure") === "1" ||
            process.env.SOLARD_PUMP_LIVE_AWAIT_GET_ENSURE === "1"
          ) {
            await ensureProcessesAction(ensureArgs);
            ensure = { requested: true, mode: "awaited" };
          } else {
            void ensureProcessesAction(ensureArgs).catch(() => undefined);
            ensure = { requested: true, mode: "background" };
          }
        }

        const rawTokens = listTerminalFeed({
          limit,
          sinceMs,
          activeWindowMs,
          includeUnpriced,
          source,
        });

        const newTokens = terminalFeedRowsToPumpRows(rawTokens);
        const watchGroups = safeWatchGroups();
        const db =
          url.searchParams.get("stats") === "0" ? null : terminalStoreStats();
        const health =
          url.searchParams.get("health") === "0"
            ? null
            : terminalHealthAction({ errors: 8, source });

        return {
          newTokens,
          rawTokens,
          watchGroups,
          watchedMints: [],
          db,
          health,
          source,
          ensure,
        };
      },
    );

    return Response.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}

function sourceFromBody(value: unknown): TerminalSource {
  return resolveTerminalSource(value);
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await readJson(request).catch(() => ({}))) as Record<
      string,
      unknown
    >;
    assertWebAuth(request);

    const action = String(body.action ?? "ensure-workers");
    const source = sourceFromBody(body.source);

    const payload = await m(
      {
        start: () =>
          `pump_live:post action=${action} source=${source ?? "auto"} worker=${typeof body.worker === "string" ? body.worker : "all"}`,
        end: (value: any) => ({
          ready: value?.ready,
          workers: value?.workers?.length ?? value?.name ?? null,
          status: value?.status,
          source: value?.source ?? source ?? "auto",
        }),
        catch: summarizeError,
      },
      async () => {
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
    );

    return Response.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}
