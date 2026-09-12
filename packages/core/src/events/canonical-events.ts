import type { SolardTokenTransferEvent } from "./token-events.ts";

export type SolardClaimAttribution =
  "exact-token" | "creator-aggregate-ambiguous";

export type SolardClaimEvent = {
  id: string;
  type: "claim";
  program: string;
  tokenMint: string | null;
  signature: string;
  slot: number;
  transactionIndex: number | null;
  instructionIndex: number | null;
  innerInstructionIndex: number | null;
  blockTimeMs: number | null;
  observedAtMs: number;
  confidence: "confirmed" | "finalized";
  attribution: SolardClaimAttribution;
  payout: {
    assetMint: string;
    recipient: string;
    amountRaw: bigint;
  };
  claimKinds: string[];
  exactTokenInstruction: boolean;
  payoutEvidence:
    | "claim-instruction-transfer"
    | "source-vault-delta"
    | "transaction-delta-fallback";
};

export type SolardCanonicalEvent = SolardTokenTransferEvent | SolardClaimEvent;

export function chainEffectId(args: {
  signature: string;
  instructionIndex: number | null;
  innerInstructionIndex: number | null;
  effectOrdinal?: number;
}): string {
  return `${args.signature}:${args.instructionIndex == null ? "transaction" : args.instructionIndex}:${args.innerInstructionIndex == null ? "outer" : args.innerInstructionIndex}:${args.effectOrdinal ?? 0}`;
}

export function claimPhysicalId(args: {
  signature: string;
  positions: ReadonlyArray<{
    instructionIndex: number;
    innerInstructionIndex: number | null;
  }>;
}): string {
  const coordinates = [...args.positions]
    .sort(
      (a, b) =>
        a.instructionIndex - b.instructionIndex ||
        (a.innerInstructionIndex ?? -1) - (b.innerInstructionIndex ?? -1),
    )
    .map(
      (position) =>
        `${position.instructionIndex}.${position.innerInstructionIndex == null ? "outer" : position.innerInstructionIndex}`,
    )
    .join("+");
  return `${args.signature}:claim:${coordinates || "transaction"}`;
}
