import {
  createSolardActionContext,
  listSmaAggregatesAction,
} from "../../../../src/solard/actions/index.js";
import { withMeasuredApi } from "../../../../src/web/http.js";

export function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  return withMeasuredApi(
    request,
    "listSmaAggregates",
    async () => {
      const ctx = createSolardActionContext({ installSenders: false });
      try {
        return await listSmaAggregatesAction(ctx, {
          mint: url.searchParams.get("mint"),
          intervalSeconds: url.searchParams.get("intervalSeconds")
            ? Number(url.searchParams.get("intervalSeconds"))
            : null,
          limit: Number(url.searchParams.get("limit") ?? "100"),
        });
      } finally {
        ctx.close();
      }
    },
    {
      meta: {
        mint: url.searchParams.get("mint"),
        intervalSeconds: url.searchParams.get("intervalSeconds"),
      },
    },
  );
}
