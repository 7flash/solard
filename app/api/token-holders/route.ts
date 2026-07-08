import { withSowl } from "../../../src/web/http.js";
import { loadTokenHolders } from "../../../src/solard/token-holder-service.js";

export function GET(request: Request): Promise<Response> {
  return withSowl(request, async (sowl) => {
    const url = new URL(request.url);
    const mint = url.searchParams.get("mint") ?? "";
    const limit = Number(url.searchParams.get("limit") ?? "12");
    return await loadTokenHolders(sowl, {
      mint,
      limit,
      commitment: "confirmed",
    });
  });
}
