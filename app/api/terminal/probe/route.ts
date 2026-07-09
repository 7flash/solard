import { readJson } from "../../../../src/web/http.js";
import { withMeasuredApi } from "../../../../src/solard/api-response.js";
import { terminalProbeAction } from "../../../../src/solard/actions/terminal-probe.js";

function sourceFrom(
  value: unknown,
): "helius" | "pumpportal" | "both" | undefined {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("both")) return "both";
  if (text.includes("helius")) return "helius";
  if (text.includes("pump")) return "pumpportal";
  return undefined;
}

export async function GET(request: Request): Promise<Response> {
  return withMeasuredApi({
    request,
    route: "/api/terminal/probe",
    method: "GET",
    label: "terminal probe",
    summarize: (value: any) => ({
      ok: value?.ok,
      source: value?.source,
      rows: value?.rows?.length,
      injected: value?.injected,
    }),
    fn: () => {
      const url = new URL(request.url);
      return terminalProbeAction({
        source: sourceFrom(url.searchParams.get("source")),
        inject: url.searchParams.get("inject") === "1",
        ensure: url.searchParams.get("ensure") !== "0",
        restartStale: url.searchParams.get("restartStale") !== "0",
        limit: Number(url.searchParams.get("limit") ?? "20"),
      });
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
    route: "/api/terminal/probe",
    method: "POST",
    label: "terminal probe",
    summarize: (value: any) => ({
      ok: value?.ok,
      source: value?.source,
      rows: value?.rows?.length,
      injected: value?.injected,
    }),
    fn: () =>
      terminalProbeAction({
        source: sourceFrom(body.source),
        inject: body.inject === true,
        ensure: body.ensure !== false,
        restartStale: body.restartStale !== false,
        limit: Number(body.limit ?? 20),
      }),
  });
}
