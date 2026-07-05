import type { ClaimSourcePlugin } from "../../claims/claim-source.js";
import type { LaunchSourcePlugin } from "../../launches/launch-source.js";
import type { TokenLaunchpadPlugin } from "../../launches/launchpad.js";
import type { TradeVenuePlugin } from "../venue-plugin.js";
import { PumpCurveVenue } from "./pump-curve-venue.js";
import { PumpSwapVenue } from "./pumpswap-venue.js";
import { PumpCreatorFeesSource } from "./pump-creator-fees-source.js";
import { PumpLaunchSource } from "./pump-launch-source.js";
import { PumpTokenLaunchpad } from "./pump-launchpad.js";

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
export { PumpCurveVenue, PumpSwapVenue, PumpCreatorFeesSource, PumpLaunchSource, PumpTokenLaunchpad };
