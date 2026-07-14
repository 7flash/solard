import { readJson } from "../../../../src/web/http.js";
import { withMeasuredApi } from "../../../../src/solard/api-response.js";

function sourceFrom(value: unknown): "helius" | "pumpportal" | "both" | null {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (text.includes("both")) return "both";
  if (text.includes("helius")) return "helius";
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
      return { ready: true, workers: 1, source: "helius" };
    },
  });
}
