import type { PlannedTransaction } from "./types.ts";
import type { TradeExecutionOptions } from "./trade-options.ts";
import type { TradeResult } from "./trade-result.ts";

export type PreparedFastTrade = {
  readonly expiresAt: number;
  readonly review: Readonly<{side:"buy"|"sell";inputRaw:string;minimumOutputRaw:string;
    modeledOutputRaw:string|null;triggerPriceSol:string;priceKind:"average"|"spot";additionalSlippageBps:number}>;
  /** Refresh blockhash/signatures and balance preflight, reusing instructions for at most 15 seconds. */
  refresh(): Promise<PreparedFastTrade>;
  execute(options?: Pick<TradeExecutionOptions, "intentKey" | "onStage" | "onSubmitted" | "confirm"> & { signal?: AbortSignal }): Promise<TradeResult>;
};

/** Internal, exact-byte preflight lease. Never accepted from caller metadata. */
const leases = new WeakMap<PlannedTransaction, { bytes: string; fee: number; expiresAt: number }>();
export const PREPARED_ORDER_MAX_AGE_MS = 5_000;
export function leasePreparedSubmission(plan: PlannedTransaction, fee: number, checkedAt: number) {
  const expiresAt = Math.min(checkedAt, plan.assembledAtMs ?? 0) + PREPARED_ORDER_MAX_AGE_MS;
  leases.set(plan, { bytes: Buffer.from(plan.transaction.serialize()).toString("base64"), fee, expiresAt });
  return expiresAt;
}
export function takePreparedSubmission(plan: PlannedTransaction): number | undefined {
  const lease = leases.get(plan);
  if (!lease) return;
  leases.delete(plan);
  if (Date.now() >= lease.expiresAt || Buffer.from(plan.transaction.serialize()).toString("base64") !== lease.bytes)
    throw Object.assign(new Error("Prepared order expired or changed; prepare again before submission"), { code: "PREPARATION_EXPIRED" });
  return lease.fee;
}
