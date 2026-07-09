import { assertWebAuth, readJson } from "../../../src/web/http.js";
import { withMeasuredApi } from "../../../src/solard/api-response.js";
import { ensureProcessesAction } from "../../../src/solard/actions/processes.js";
import {
  listTerminalFeed,
  terminalStoreStats,
} from "../../../src/solard/db/terminal-store.js";
import { listTokenWatchGroups } from "../../../src/pump/services/pump-live-store.js";

export function GET(request: Request): Promise<Response> {
  return withMeasuredApi({
    request,
    route: "/api/pump-live",
    method: "GET",
    label: "terminal-db-snapshot",
    fn: async () => {
      assertWebAuth(request);
      const url = new URL(request.url);
      if (url.searchParams.get("ensure") === "1") {
        await ensureProcessesAction({
          telegram: url.searchParams.get("telegram") === "1",
        });
      }
      return {
        newTokens: listTerminalFeed({
          limit: Number(url.searchParams.get("limit") ?? "250"),
          sinceMs: Number(url.searchParams.get("sinceMs") ?? "0"),
        }),
        watchGroups: listTokenWatchGroups(),
        watchedMints: [],
        db: terminalStoreStats(),
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
    label: String(body.action ?? "start-worker"),
    fn: async () => {
      assertWebAuth(request);
      const action = String(body.action ?? "start-worker");
      if (action === "stop") {
        return {
          status: "ignored",
          reason:
            "streams are managed by bgrun workers; use /api/processes stop",
        };
      }
      return await ensureProcessesAction({
        worker: typeof body.worker === "string" ? body.worker : null,
        all: true,
        telegram: body.telegram === true,
        restart: body.restart === true,
      });
    },
  });
}
