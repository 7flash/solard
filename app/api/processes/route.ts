import { errorResponse, jsonResponse } from "../../../src/web/http.js";
import {
  ensureProcessesAction,
  listProcessesAction,
  restartProcessesAction,
  stopProcessAction,
} from "../../../src/solard/actions/processes.js";
import { withMeasuredApi } from "../../../src/solard/api-response.js";

function param(url: URL, name: string): string | null {
  const value = url.searchParams.get(name);
  return value && value.trim() ? value.trim() : null;
}

export function GET(request: Request): Promise<Response> {
  return withMeasuredApi(request, "GET:/api/processes", async () => {
    const url = new URL(request.url);
    return jsonResponse({
      ok: true,
      value: listProcessesAction({ telegram: param(url, "telegram") !== "0" }),
    });
  });
}

export async function POST(request: Request): Promise<Response> {
  return withMeasuredApi(request, "POST:/api/processes", async () => {
    try {
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const action = String(body.action ?? "ensure");
      const worker = typeof body.worker === "string" ? body.worker : null;
      const telegram = body.telegram !== false;
      if (action === "stop") {
        return jsonResponse({
          ok: true,
          value: stopProcessAction(worker ?? "all", { telegram }),
        });
      }
      if (action === "restart") {
        return jsonResponse({
          ok: true,
          value: await restartProcessesAction({
            worker: worker ?? "all",
            telegram,
          }),
        });
      }
      return jsonResponse({
        ok: true,
        value: await ensureProcessesAction({
          worker: worker ?? "all",
          telegram,
          restart: body.restart === true,
          restartStale: body.restartStale !== false,
        }),
      });
    } catch (error) {
      return errorResponse(error);
    }
  });
}
