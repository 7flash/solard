import type { TradeAsset, TradeRoute, TradeRouteResolution } from "@solard/sdk";

export type TradeRouteSummary = {
  route: TradeRoute;
  asset: TradeAsset;
  registered: boolean;
  venue: string | null;
};

export function summarizeTradeRoute(
  resolution: TradeRouteResolution,
): TradeRouteSummary {
  return {
    route: resolution.route,
    asset: resolution.asset,
    registered: resolution.token !== null,
    venue: resolution.token?.venueHint ?? null,
  };
}
