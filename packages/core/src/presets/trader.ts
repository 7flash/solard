import { Solard, type SolardOptions } from "../core/solard.ts";
import { installPump } from "../venues/pump/index.ts";
import { trace } from "../core/trace.ts";

/** Standard venue/source preset. It installs capabilities only; scripts remain outside the kernel. */
export function createTraderSolard(options: SolardOptions = {}): Solard {
  trace("preset: creating Solard kernel");
  const slrd = new Solard(options);
  trace("preset: installing Pump capabilities");
  installPump(slrd);
  trace("preset: ready");
  return slrd;
}
