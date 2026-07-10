import { withMeasuredApi } from "../../../src/web/http.js";
import { getTerminalHoldersAction } from "../../../src/solard/actions/terminal-holders.js";

export function GET(request: Request): Promise<Response> {
  return withMeasuredApi({
    request,
    route: "/api/token-holders",
    method: "GET",
    label: "token holders",
    summarize: (value: any) => ({
      mint: value?.mint,
      holders: value?.holders?.length ?? 0,
      ok: value?.ok,
      stale: value?.stale,
    }),
    fn: async () => {
      const url = new URL(request.url);
      const mint = (url.searchParams.get("mint") ?? "").trim();
      const limit = Math.max(
        1,
        Math.min(Number(url.searchParams.get("limit") ?? "20"), 50),
      );
      const value = await getTerminalHoldersAction({
        mint,
        limit,
        refresh: url.searchParams.get("refresh") !== "0",
        source: url.searchParams.get("source") ?? "token-holders-api",
      });
      return {
        ...value,
        // Compatibility aliases for the older terminal UI.
        supply: value.supply,
        distribution: value.distribution,
        holders: value.holders.map((holder: any) => ({
          ...holder,
          amount: holder.amountRaw,
          uiAmount: String(holder.amountUi ?? ""),
          balanceUi: holder.amountUi,
          percent: holder.pctSupply,
          pctSupply: holder.pctSupply,
          label: holder.rank === 1 ? "largest" : null,
        })),
      };
    },
  });
}
