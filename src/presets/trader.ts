import { Sowl, type SowlOptions } from "../sdk/sowl.js";
import { installPump } from "../venues/pump/index.js";
import { trace } from "../core/trace.js";

/** Standard venue/source preset. It installs capabilities only; scripts remain outside the kernel. */
export function createTraderSowl(options: SowlOptions = {}): Sowl {
  trace("preset: creating Sowl kernel");
  const sowl = new Sowl(options);
  trace("preset: installing Pump capabilities");
  installPump(sowl);
  trace("preset: ready");
  return sowl;
}
