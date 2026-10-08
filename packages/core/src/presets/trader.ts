import { Solard, type SolardOptions } from "../core/solard.ts";
import { installPump } from "../venues/pump/index.ts";
import { MeteoraDbcVenue } from "../venues/meteora/dbc.ts";
import { MeteoraDammV2Venue } from "../venues/meteora/damm-v2.ts";
import { trace } from "../core/trace.ts";
import { JupiterVenue } from "../venues/jupiter-venue.ts";
import { LaunchLabTokenLaunchpad } from "../launches/launchlab/launchlab-launchpad.ts";
import { LaunchLabVenue } from "../venues/raydium/launchlab-venue.ts";
import { RaydiumCreatorFeesSource } from "../claims/raydium-creator-fees-source.ts";
import { MeteoraDbcCreatorFeesSource } from "../claims/meteora-dbc-creator-fees-source.ts";
import { MeteoraDammV2CreatorFeesSource } from "../claims/meteora-damm-v2-creator-fees-source.ts";

/** Standard venue/source preset. It installs capabilities only; scripts remain outside the kernel. */
export function createTraderSolard(options: SolardOptions = {}): Solard {
  trace("preset: creating Solard kernel");
  const slrd = new Solard(options);
  trace("preset: installing Pump capabilities");
  installPump(slrd);
  slrd.registerLaunchpad(new LaunchLabTokenLaunchpad());
  slrd.registerClaimSource(new RaydiumCreatorFeesSource());
  slrd.registerClaimSource(new MeteoraDbcCreatorFeesSource());
  slrd.registerClaimSource(new MeteoraDammV2CreatorFeesSource());
  slrd.registerVenue(new MeteoraDbcVenue());
  slrd.registerVenue(new MeteoraDammV2Venue());
  slrd.registerVenue(new LaunchLabVenue());
  slrd.registerVenue(new JupiterVenue());
  trace("preset: ready");
  return slrd;
}
