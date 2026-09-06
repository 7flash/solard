export type TradeRoute = "native" | "jupiter";
export type VenuePreference = "auto" | TradeRoute;

export type NativeVenueToken = {
  venueHint: string | null;
};

export function nativePumpTradeAvailable(
  token: NativeVenueToken | null,
): boolean {
  return token?.venueHint === "pump-curve" || token?.venueHint === "pumpswap";
}

export function selectTradeRoute(
  token: NativeVenueToken | null,
  preference: VenuePreference = "auto",
): TradeRoute {
  if (preference === "native") return "native";
  if (preference === "jupiter") return "jupiter";
  return nativePumpTradeAvailable(token) ? "native" : "jupiter";
}
