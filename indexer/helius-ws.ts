import type { IndexerConfig } from "./config.js";
import type { Counters } from "./types.js";

/**
 * Intentionally disabled. The primary indexer must never subscribe to the
 * entire Pump program. Discovery comes from PumpPortal and Helius is used only
 * for exact bonding-curve log subscriptions and batched account polling managed by pump-curve-ws.ts.
 */
export async function runHeliusWsSession(_input: {
  config: IndexerConfig;
  counters: Counters;
  attempt: number;
  signal: AbortSignal;
}): Promise<never> {
  throw new Error("Global Pump program subscription is disabled");
}
