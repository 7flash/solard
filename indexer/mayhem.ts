import type { IndexerConfig } from "./config.ts";
import type { Counters } from "./types.ts";

type MayhemQueueItem = {
  mint: string;
  bondingCurveKey: string | null;
  attempt: number;
};

/** Mayhem is decoded from every tracked bonding-curve account update. */
export function enqueueMayhemCheck(
  _config: IndexerConfig,
  _counters: Counters,
  _input: MayhemQueueItem,
): void {}

/** No sweep: prevents permanent-failure rechecks from consuming RPC credits. */
export function startMayhemHydrator(
  _config: IndexerConfig,
  _counters: Counters,
): () => void {
  return () => {};
}
