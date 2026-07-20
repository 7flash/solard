import type { ClaimSourcePlugin } from "../../claims/claim-source.ts";
import type { LaunchSourcePlugin } from "../../launches/launch-source.ts";
import type { TokenLaunchpadPlugin } from "../../launches/launchpad.ts";
import type { TradeVenuePlugin } from "../venue-plugin.ts";
import { PumpCurveVenue } from "./pump-curve-venue.ts";
import { PumpSwapVenue } from "./pumpswap-venue.ts";
import { PumpCreatorFeesSource } from "./pump-creator-fees-source.ts";
import { PumpLaunchSource } from "./pump-launch-source.ts";
import { PumpTokenLaunchpad } from "./pump-launchpad.ts";

export type PumpInstallTarget = {
  registerVenue(plugin: TradeVenuePlugin): unknown;
  registerClaimSource(plugin: ClaimSourcePlugin): unknown;
  registerLaunchSource(plugin: LaunchSourcePlugin): unknown;
  registerLaunchpad(plugin: TokenLaunchpadPlugin): unknown;
};
export function installPump(target: PumpInstallTarget): void {
  target.registerVenue(new PumpCurveVenue());
  target.registerVenue(new PumpSwapVenue());
  target.registerClaimSource(new PumpCreatorFeesSource());
  target.registerLaunchSource(new PumpLaunchSource());
  target.registerLaunchpad(new PumpTokenLaunchpad());
}
export {
  PumpCurveVenue,
  PumpSwapVenue,
  PumpCreatorFeesSource,
  PumpLaunchSource,
  PumpTokenLaunchpad,
};
