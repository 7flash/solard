import { withMeasuredApi } from "../../../../src/solard/api-response.js";
import { assertWebAuth } from "../../../../src/web/http.js";
import { refreshTerminalCurvesAction } from "../../../../src/solard/actions/terminal-curve.js";

export function POST(request: Request): Promise<Response> {
  return withMeasuredApi({
    request,
    route: "/api/terminal/curve",
    method: "POST",
    label: "terminal curve refresh",
    summarize: (value: any) => ({
      checked: value?.value?.checked,
      updated: value?.value?.updated,
      errors: value?.value?.errors,
    }),
    fn: async () => {
      assertWebAuth(request);
      const body = (await request.json().catch(() => ({}))) as any;
      return await refreshTerminalCurvesAction({
        source: typeof body.source === "string" ? body.source : null,
        limit: Number.isFinite(Number(body.limit))
          ? Number(body.limit)
          : undefined,
        activeWindowMs: Number.isFinite(Number(body.activeWindowMs))
          ? Number(body.activeWindowMs)
          : undefined,
      });
    },
  });
}

export function GET(request: Request): Promise<Response> {
  return withMeasuredApi({
    request,
    route: "/api/terminal/curve",
    method: "GET",
    label: "terminal curve refresh",
    summarize: (value: any) => ({
      checked: value?.value?.checked,
      updated: value?.value?.updated,
      errors: value?.value?.errors,
    }),
    fn: async () => {
      assertWebAuth(request);
      const url = new URL(request.url);
      return await refreshTerminalCurvesAction({
        source: url.searchParams.get("source"),
        limit: Number(url.searchParams.get("limit") || "50"),
      });
    },
  });
}
