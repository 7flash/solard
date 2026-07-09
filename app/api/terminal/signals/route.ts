import { assertWebAuth, readJson } from "../../../../src/web/http.js";
import { withMeasuredApi } from "../../../../src/solard/api-response.js";
import {
  listTerminalSignalsAction,
  projectTerminalSignalAction,
} from "../../../../src/solard/actions/terminal-signals.js";

export function GET(request: Request): Promise<Response> {
  return withMeasuredApi({
    request,
    route: "/api/terminal/signals",
    method: "GET",
    label: "terminal signals",
    fn: () => {
      assertWebAuth(request);
      const url = new URL(request.url);
      return listTerminalSignalsAction({
        limit: Number(url.searchParams.get("limit") ?? "100"),
      });
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withMeasuredApi({
    request,
    route: "/api/terminal/signals",
    method: "POST",
    label: "project terminal signal",
    fn: async () => {
      assertWebAuth(request);
      return await projectTerminalSignalAction({
        id: typeof body.id === "string" ? body.id : null,
        sourceId: typeof body.sourceId === "string" ? body.sourceId : null,
        sourceName:
          typeof body.sourceName === "string" ? body.sourceName : "manual",
        chatRef: typeof body.chatRef === "string" ? body.chatRef : null,
        text: typeof body.text === "string" ? body.text : "",
        raw:
          body.raw && typeof body.raw === "object"
            ? (body.raw as Record<string, unknown>)
            : null,
        receivedAtMs:
          typeof body.receivedAtMs === "number"
            ? body.receivedAtMs
            : Date.now(),
      });
    },
  });
}
