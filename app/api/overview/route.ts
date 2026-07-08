import { withSowl } from "../../../src/web/http.js";
import { loadSolardOverview } from "../../../src/solard/overview-service.js";

export function GET(request: Request): Promise<Response> {
  return withSowl(request, async (sowl) => {
    const url = new URL(request.url);
    const fast =
      url.searchParams.get("fast") === "1" ||
      url.searchParams.get("fast") === "true";
    const balances =
      url.searchParams.get("balances") ?? (fast ? "none" : "sol");
    return await loadSolardOverview(sowl, {
      fast,
      includeBalances: balances !== "none",
      balanceKind: balances === "none" ? "none" : "sol",
      tokenLimit: Number(url.searchParams.get("tokenLimit") ?? "500"),
      executionLimit: Number(url.searchParams.get("executionLimit") ?? "100"),
    });
  });
}
