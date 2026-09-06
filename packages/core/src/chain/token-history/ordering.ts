import type { TokenHistoryTrade } from "./types.ts";

export function compareTokenHistoryTrades(
  left: TokenHistoryTrade,
  right: TokenHistoryTrade,
): number {
  return (
    left.tradedAtMs - right.tradedAtMs ||
    left.slot - right.slot ||
    left.history.historyOrder - right.history.historyOrder ||
    left.history.instructionIndex - right.history.instructionIndex ||
    left.eventKey.localeCompare(right.eventKey)
  );
}

export function chronologicalTokenHistoryTrades(
  rows: readonly TokenHistoryTrade[],
): TokenHistoryTrade[] {
  return [...rows].sort(compareTokenHistoryTrades);
}
