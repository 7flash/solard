import { withMeasuredApi } from "../../../../src/solard/api-response.js";
import { terminalHealthAction } from "../../../../src/solard/actions/terminal-health.js";

export function GET(request: Request): Promise<Response> {
  return withMeasuredApi({
    request,
    route: "/api/terminal/health",
    label: "terminal health",
    fn: () => {
      const url = new URL(request.url);
      return terminalHealthAction({
        staleMs: Number(
          url.searchParams.get("staleMs") ??
            process.env.SOLARD_WORKER_STALE_MS ??
            "15000",
        ),
        errors: Number(url.searchParams.get("errors") ?? "20"),
        source: url.searchParams.get("source"),
        allErrors: url.searchParams.get("allErrors") === "1",
      });
    },
  });
}
