import { jsonResponse, withSowl } from "../../../src/web/http.js";
import { loadTokenHolders } from "../../../src/solard/token-holder-service.js";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const mint = url.searchParams.get("mint") ?? "";
  const limit = Number(url.searchParams.get("limit") ?? "12");
  try {
    return await withSowl(request, async (sowl) => {
      return await loadTokenHolders(sowl, {
        mint,
        limit,
        commitment: "confirmed",
      });
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      mint,
      holders: [],
      unavailableReason: error instanceof Error ? error.message : String(error),
    });
  }
}
