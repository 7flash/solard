import type { Connection } from "@solana/web3.js";
import type { PlannedTransaction } from "./types.ts";
export type TransactionFeeEstimate = {
  cuLimit: number;
  priorityMicroLamports: number;
  /** Selected maximum compute-priority charge; not evidence of a fee paid. */
  priorityFeeLamports: number;
  estimatedNetworkFeeLamports: number | null;
  estimatedBaseFeeLamports: number | null;
};
export async function estimatePlanFee(
  connection: Pick<Connection, "getFeeForMessage">,
  plan: PlannedTransaction,
  verifiedMessageFee?: number,
): Promise<TransactionFeeEstimate> {
  const cuLimit = plan.draft.cuLimit ?? 600_000;
  const priorityMicroLamports = plan.draft.cuPriceMicroLamports ?? 100_000;
  const priorityFeeLamports = Number(
    (BigInt(cuLimit) * BigInt(priorityMicroLamports) + 999_999n) / 1_000_000n,
  );
  if (verifiedMessageFee != null && (!Number.isSafeInteger(verifiedMessageFee) || verifiedMessageFee < 0))
    throw new Error("Verified message fee must be non-negative lamports");
  let total: number | null = verifiedMessageFee ?? null;
  if (verifiedMessageFee == null) try {
    total = (
      await connection.getFeeForMessage(plan.transaction.message, "confirmed")
    ).value;
  } catch {}
  return {
    cuLimit,
    priorityMicroLamports,
    priorityFeeLamports,
    estimatedNetworkFeeLamports: total,
    estimatedBaseFeeLamports:
      total == null ? null : Math.max(0, total - priorityFeeLamports),
  };
}
