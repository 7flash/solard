import { chainEffectId } from "./canonical-events.ts";
import type {
  SolardTokenTransferEvent,
  SolardTokenTransferSource,
} from "./token-events.ts";

export type CanonicalTokenEventSource = SolardTokenTransferSource;

export type CanonicalTokenBalanceEvent = SolardTokenTransferEvent & {
  effectOrdinal: number;
};

export function physicalChainEventId(
  signature: string,
  instructionIndex: number | null,
  innerInstructionIndex: number | null,
  effectOrdinal = 0,
): string {
  return chainEffectId({
    signature,
    instructionIndex,
    innerInstructionIndex,
    effectOrdinal,
  });
}
