import { listTerminalHoldersAction } from "../../../../src/solard/actions/index.js";
import { withMeasuredApi } from "../../../../src/web/http.js";

export function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const mint = url.searchParams.get("mint") ?? "";
  return withMeasuredApi(
    request,
    "listTerminalHolders",
    () =>
      listTerminalHoldersAction({
        mint,
        limit: url.searchParams.get("limit"),
      }),
    {
      meta: { mint, limit: url.searchParams.get("limit") },
      result: (rows) => ({ count: rows.length, mint }),
    },
  );
}
