import { readJson } from "../../../src/web/http.js";
import {
  ensureProcessesAction,
  listProcessesAction,
  restartProcessesAction,
  stopProcessAction,
} from "../../../src/solard/actions/processes.js";
import { withMeasuredApi } from "../../../src/solard/api-response.js";

function sourceFrom(
  value: unknown,
): "helius" | "pumpportal" | "both" | undefined {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (text.includes("helius")) return "helius";
  if (text.includes("both")) return "both";
  if (text.includes("pump")) return "pumpportal";
  return undefined;
}

export function GET(request: Request): Promise<Response> {
  return withMeasuredApi({
    request,
    route: "/api/processes",
    method: "GET",
    label: "list",
    summarize: (value: any) => ({
      ready: value?.ready,
      workers: value?.workers?.length,
      source: value?.source,
    }),
    fn: async () => {
      const url = new URL(request.url);
      const source = sourceFrom(url.searchParams.get("source"));
      return {
        source,
        ...listProcessesAction({
          telegram: url.searchParams.get("telegram") !== "0",
          source,
        }),
      };
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  const body = (await readJson(request).catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return withMeasuredApi({
    request,
    route: "/api/processes",
    method: "POST",
    label: String(body.action ?? "ensure"),
    summarize: (value: any) => ({
      ready: value?.ready,
      workers: value?.workers?.length ?? value?.name ?? null,
    }),
    fn: async () => {
      const action = String(body.action ?? "ensure");
      const worker = typeof body.worker === "string" ? body.worker : null;
      const telegram = body.telegram !== false;
      const source = sourceFrom(body.source);
      if (action === "stop")
        return stopProcessAction(worker ?? "all", { telegram, source });
      if (action === "restart")
        return await restartProcessesAction({
          worker: worker ?? "all",
          telegram,
          source,
        });
      return await ensureProcessesAction({
        worker: worker ?? "all",
        telegram,
        source,
        restart: body.restart === true,
        restartStale: body.restartStale !== false,
      });
    },
  });
}
