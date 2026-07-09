import { readJson } from "../../../src/web/http.js";
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
  return withMeasuredApi({
    request,
    route: "/api/processes",
    method: "GET",
    label: "list processes",
    summarize: (value: any) => ({
      ready: value?.ready,
      workers: value?.workers?.length ?? 0,
    }),
    fn: () => {
      const url = new URL(request.url);
      return listProcessesAction({ telegram: param(url, "telegram") !== "0" });
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
      if (action === "stop")
        return stopProcessAction(worker ?? "all", { telegram });
      if (action === "restart")
        return await restartProcessesAction({
          worker: worker ?? "all",
          telegram,
        });
      return await ensureProcessesAction({
        worker: worker ?? "all",
        telegram,
        restart: body.restart === true,
        restartStale: body.restartStale !== false,
      });
    },
  });
}
