import { jsonResponse } from "../../../../src/web/http.js";
import {
  ensureProcessesAction,
  restartProcessesAction,
  stopProcessAction,
} from "../../../../src/solard/actions/processes.js";
import { withMeasuredApi } from "../../../../src/solard/api-response.js";

export async function POST(request: Request): Promise<Response> {
  return withMeasuredApi(request, "POST:/api/workers/ensure", async () => {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const worker = typeof body.worker === "string" ? body.worker : null;
    const action = String(body.action ?? "ensure");
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
  });
}
