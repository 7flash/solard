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
  apiMeasure as m,
  label,
  requestParams,
} from "../../../src/solard/measure.js";

type Source = "both" | "helius" | "pumpportal" | undefined;

function safeWatchGroups() {
  try {
    return listTokenWatchGroups();
  } catch {
    return [];
  }
}

function resolveSource(value: unknown): Source {
  const text = String(value ?? "").toLowerCase();

  if (text.includes("both")) return "both";
  if (text.includes("helius")) return "helius";
  if (text.includes("pump")) return "pumpportal";

  return undefined;
}

function compactError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    message: String(error),
  };
}

function errorStatus(error: unknown): number {
  const maybe = error as any;

  if (typeof maybe?.status === "number") return maybe.status;
  if (typeof maybe?.statusCode === "number") return maybe.statusCode;

  return 500;
}

function errorResponse(error: unknown): Response {
  return Response.json(
    {
      ok: false,
      error: compactError(error),
    },
    { status: errorStatus(error) },
  );
}

function numericParam(
  url: URL,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(url.searchParams.get(name) ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

export async function GET(request: Request): Promise<Response> {
  const routeParams = requestParams(request);

  try {
    const payload = await m(label("pump_live:get", routeParams), async () => {
      m.sync("pump_live:auth", () => {
        assertWebAuth(request);
        return "ok";
      });

      const url = new URL(request.url);
      const source = resolveSource(url.searchParams.get("source"));

      const limit = numericParam(url, "limit", 250, 1, 500);
      const sinceMs = numericParam(
        url,
        "sinceMs",
        0,
        0,
        Number.MAX_SAFE_INTEGER,
      );
      const activeWindowMs = numericParam(
        url,
        "activeWindowMs",
        Number(process.env.SOLARD_TERMINAL_ACTIVE_WINDOW_MS ?? "300000"),
        1,
        24 * 60 * 60 * 1000,
      );
      const includeUnpriced =
        url.searchParams.get("includeUnpriced") === "1" || source === "helius";

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

        const ensureLabel = label("pump_live:ensure_processes", {
          source,
          telegram: ensureArgs.telegram ? 1 : undefined,
        });

        if (
          url.searchParams.get("awaitEnsure") === "1" ||
          process.env.SOLARD_PUMP_LIVE_AWAIT_GET_ENSURE === "1"
        ) {
          await m(ensureLabel, () => ensureProcessesAction(ensureArgs));
          ensure = { requested: true, mode: "awaited" };
        } else {
          void m(ensureLabel, () => ensureProcessesAction(ensureArgs)).catch(
            (error) => {
              m.sync("pump_live:ensure_background_error", () => error);
            },
          );
          ensure = { requested: true, mode: "background" };
        }
      }

      const rawTokens = m.sync(
        label("pump_live:list_feed", {
          limit,
          sinceMs,
          activeWindowMs,
          includeUnpriced: includeUnpriced ? 1 : undefined,
          source,
        }),
        () =>
          listTerminalFeed({
            limit,
            sinceMs,
            activeWindowMs,
            includeUnpriced,
            source,
          }),
      );

      const newTokens = m.sync(
        label("pump_live:map_rows", {
          rows: rawTokens.length,
        }),
        () => terminalFeedRowsToPumpRows(rawTokens),
      );

      const watchGroups = m.sync("pump_live:watch_groups", () =>
        safeWatchGroups(),
      );

      const db =
        url.searchParams.get("stats") === "0"
          ? null
          : m.sync("pump_live:stats", () => terminalStoreStats());

      const health =
        url.searchParams.get("health") === "0"
          ? null
          : m.sync("pump_live:health", () =>
              terminalHealthAction({ errors: 8 }),
            );

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
    });

    return Response.json(payload);
  } catch (error) {
    m.sync("pump_live:get_error", () => error);
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: any;

  try {
    body = await m("pump_live:read_body", () => readJson(request));

    const action = String(body.action ?? "ensure-workers");
    const source = resolveSource(body.source);

    const payload = await m(
      label(`pump_live:${action}`, {
        source,
        worker: typeof body.worker === "string" ? body.worker : undefined,
        telegram: body.telegram === true ? 1 : undefined,
        restart: body.restart === true ? 1 : undefined,
        restartStale: body.restartStale !== false ? 1 : undefined,
      }),
      async () => {
        m.sync("pump_live:auth", () => {
          assertWebAuth(request);
          return "ok";
        });

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
    m.sync("pump_live:post_error", () => error);
    return errorResponse(error);
  }
}
