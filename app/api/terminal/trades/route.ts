import { assertWebAuth } from "../../../../src/web/http.js";
import { withMeasuredApi } from "../../../../src/solard/api-response.js";
import { listTerminalTrades } from "../../../../shared/db.js";
import { ensureProcessesAction } from "../../../../src/solard/actions/processes.js";

export function GET(request: Request): Promise<Response> {
  return withMeasuredApi({
    request,
    route: "/api/terminal/trades",
    method: "GET",
    label: "terminal trades",
    fn: async () => {
      assertWebAuth(request);
      const url = new URL(request.url);
      if (url.searchParams.get("ensure") === "1") {
        await ensureProcessesAction({ worker: "solard-pump-trades" });
      }
      return {
        rows: listTerminalTrades({
          limit: Number(url.searchParams.get("limit") ?? "250"),
          sinceMs: Number(url.searchParams.get("sinceMs") ?? "0"),
          mint: url.searchParams.get("mint"),
        }),
      };
    },
  });
}
