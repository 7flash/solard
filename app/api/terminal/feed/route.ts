import { listTerminalFeedAction } from "../../../../src/solard/actions/index.js";
import { withMeasuredApi } from "../../../../src/web/http.js";

export function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  return withMeasuredApi(
    request,
    "listTerminalFeed",
    () =>
      listTerminalFeedAction({
        sinceMs: url.searchParams.get("sinceMs"),
        pinnedMints: url.searchParams.get("pinnedMints"),
        limit: url.searchParams.get("limit"),
      }),
    {
      meta: {
        sinceMs: url.searchParams.get("sinceMs"),
        hasPinnedMints: Boolean(url.searchParams.get("pinnedMints")),
        limit: url.searchParams.get("limit"),
      },
      result: (rows) => ({
        count: rows.length,
        latestUpdatedAtMs: rows[0]?.updatedAtMs ?? null,
      }),
    },
  );
}
