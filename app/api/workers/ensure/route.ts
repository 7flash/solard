import { readJson } from "../../../../src/web/http.js";
import {
  ensureProcessesAction,
  restartProcessesAction,
  stopProcessAction,
} from "../../../../src/solard/actions/processes.js";
import { withMeasuredApi } from "../../../../src/solard/api-response.js";

function sourceFrom(value: unknown): "helius" | "pumpportal" | "both" | null {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (text.includes("helius")) return "helius";
  if (text.includes("both")) return "both";
  if (text.includes("pump")) return "pumpportal";
  return null;
}

export async function POST(request: Request): Promise<Response> {
  const body = (await readJson(request).catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const source =
    sourceFrom(body.source) ??
    sourceFrom(new URL(request.url).searchParams.get("source")) ??
    undefined;
  return withMeasuredApi({
    request,
    route: "/api/workers/ensure",
    method: "POST",
    label: `${String(body.action ?? "ensure")}:${source ?? "default"}`,
    summarize: (value: any) => ({
      ready: value?.ready,
      workers: value?.workers?.length ?? value?.name ?? null,
      source,
    }),
    fn: async () => {
      const worker = typeof body.worker === "string" ? body.worker : null;
      const action = String(body.action ?? "ensure");
      const telegram = body.telegram !== false;
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
