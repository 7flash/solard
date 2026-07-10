import { withMeasuredApi } from "../../../../src/web/http.js";
import {
  getTerminalHoldersAction,
  refreshTerminalHoldersAction,
  refreshTerminalHolderCandidatesAction,
} from "../../../../src/solard/actions/terminal-holders.js";

function limitFrom(url: URL): number {
  return Math.max(
    1,
    Math.min(Number(url.searchParams.get("limit") ?? "20"), 50),
  );
}

export function GET(request: Request): Promise<Response> {
  return withMeasuredApi({
    request,
    route: "/api/terminal/holders",
    method: "GET",
    label: "terminal holders",
    summarize: (value: any) => ({
      mint: value?.mint,
      holders: value?.holders?.length ?? 0,
      ok: value?.ok,
      stale: value?.stale,
    }),
    fn: async () => {
      const url = new URL(request.url);
      const mint = (url.searchParams.get("mint") ?? "").trim();
      if (!mint) {
        return await refreshTerminalHolderCandidatesAction({
          source: url.searchParams.get("source"),
          limit: Math.max(
            1,
            Math.min(Number(url.searchParams.get("candidates") ?? "8"), 50),
          ),
        });
      }
      return await getTerminalHoldersAction({
        mint,
        limit: limitFrom(url),
        refresh: url.searchParams.get("refresh") === "1",
        source: url.searchParams.get("source") ?? "terminal",
      });
    },
  });
}

export function POST(request: Request): Promise<Response> {
  return withMeasuredApi({
    request,
    route: "/api/terminal/holders",
    method: "POST",
    label: "refresh terminal holders",
    summarize: (value: any) => ({
      mint: value?.mint,
      holders: value?.holders?.length ?? 0,
      ok: value?.ok,
    }),
    fn: async () => {
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const mint = typeof body.mint === "string" ? body.mint.trim() : "";
      if (!mint) {
        return await refreshTerminalHolderCandidatesAction({
          source: typeof body.source === "string" ? body.source : null,
          limit: Math.max(1, Math.min(Number(body.limit ?? 10), 50)),
        });
      }
      return await refreshTerminalHoldersAction({
        mint,
        limit: Math.max(1, Math.min(Number(body.limit ?? 20), 50)),
        source: typeof body.source === "string" ? body.source : "terminal",
      });
    },
  });
}
