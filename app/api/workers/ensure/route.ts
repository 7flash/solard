import { assertWebAuth, readJson } from "../../../../src/web/http.js";
import { withMeasuredApi } from "../../../../src/solard/api-response.js";
import { ensureProcessesAction } from "../../../../src/solard/actions/processes.js";

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withMeasuredApi({
    request,
    route: "/api/workers/ensure",
    method: "POST",
    label: "ensure workers",
    fn: async () => {
      assertWebAuth(request);
      return await ensureProcessesAction({
        worker: typeof body.worker === "string" ? body.worker : null,
        all: body.all !== false,
        telegram: body.telegram === true,
        restart: body.restart === true,
      });
    },
  });
}
