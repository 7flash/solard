import { assertWebAuth, readJson } from "../../../src/web/http.js";
import { withMeasuredApi } from "../../../src/solard/api-response.js";
import {
  ensureProcessesAction,
  listProcessesAction,
  stopProcessAction,
} from "../../../src/solard/actions/processes.js";

export function GET(request: Request): Promise<Response> {
  return withMeasuredApi({
    request,
    route: "/api/processes",
    method: "GET",
    label: "list processes",
    fn: () => {
      assertWebAuth(request);
      return listProcessesAction();
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withMeasuredApi({
    request,
    route: "/api/processes",
    method: "POST",
    label: String(body.action ?? "ensure"),
    fn: async () => {
      assertWebAuth(request);
      const action = String(body.action ?? "ensure");
      if (action === "stop")
        return stopProcessAction(String(body.worker ?? ""));
      return await ensureProcessesAction({
        worker: typeof body.worker === "string" ? body.worker : null,
        all: body.all !== false,
        telegram: body.telegram === true,
        restart: body.restart === true,
      });
    },
  });
}
