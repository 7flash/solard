import { withSolard } from "../../../src/web/http.js";
import { loadSolardPortfolio } from "../../../src/solard/portfolio-service.js";

export function GET(request: Request): Promise<Response> {
  return withSolard(request, async (slrd) => {
    const url = new URL(request.url);
    return await loadSolardPortfolio(slrd, {
      includeZero:
        url.searchParams.get("includeZero") === "1" ||
        url.searchParams.get("includeZero") === "true",
      commitment:
        (url.searchParams.get("commitment") as
          "processed" | "confirmed" | "finalized" | null) ?? "confirmed",
    });
  });
}
