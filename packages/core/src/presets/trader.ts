import { Solard, type SolardOptions } from "../core/solard.ts";
import { installPump } from "../venues/pump/index.ts";
import { MeteoraDbcVenue } from "../venues/meteora/dbc.ts";
import { MeteoraDammV2Venue } from "../venues/meteora/damm-v2.ts";
import { trace } from "../core/trace.ts";
import { JupiterVenue } from "../venues/jupiter-venue.ts";

/** Standard venue/source preset. It installs capabilities only; scripts remain outside the kernel. */
export function createTraderSolard(options: SolardOptions = {}): Solard {
  trace("preset: creating Solard kernel");
  const slrd = new Solard(options);
  trace("preset: installing Pump capabilities");
  installPump(slrd);
  slrd.registerVenue(new MeteoraDbcVenue());
  slrd.registerVenue(new MeteoraDammV2Venue());
  slrd.registerVenue(new JupiterVenue());
  trace("preset: ready");
  return slrd;
}
