import {
  createSolardActionContext,
  listSmaAggregatesAction,
} from "../../../../src/solard/actions/index.js";
import { withMeasuredApi } from "../../../../src/web/http.js";

export function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const mint = url.searchParams.get("mint");
  const intervalSeconds = url.searchParams.get("intervalSeconds");
  const latestOnly =
    url.searchParams.get("latest") === "1" ||
    url.searchParams.get("latestOnly") === "1" ||
    url.searchParams.get("latestOnly") === "true";
  return withMeasuredApi(
    request,
    "listSmaAggregates",
    async () => {
      const ctx = createSolardActionContext({ installSenders: false });
      try {
        return await listSmaAggregatesAction(ctx, {
          mint,
          intervalSeconds: intervalSeconds ? Number(intervalSeconds) : null,
          limit: Number(url.searchParams.get("limit") ?? "100"),
          latestOnly,
        });
      } finally {
        ctx.close();
      }
    },
    {
      meta: { mint, intervalSeconds, latestOnly },
      result: (rows) => ({ count: rows.length, latestOnly }),
    },
  );
}
