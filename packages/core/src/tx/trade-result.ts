import type { SendReceipt } from "./types.ts";
export type TradeAttempt = { executionId: number; signature: string; priorityMicroLamports: number };
export type TradeResult = {
  feeEstimate?: import("./fee-estimate.ts").TransactionFeeEstimate;
  feeLamports?: number;
  status: "confirmed" | "failed" | "unresolved";
  phase: "before-submission" | "on-chain" | "unknown";
  code: string; message: string; signature?: string; executionId?: number;
  sender?: string; slot: number | null; attempts: TradeAttempt[];
  solPrincipalDeltaLamports: bigint | null; targetTokenDeltaRaw: bigint | null; networkFeeLamports: bigint | null;
  quotedMinimum?: bigint; requiredMinimum?: bigint; programErrorNumber?: number; programErrorName?: string;
};
export function tradeErrorCode(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === "UNSUPPORTED_TOKEN" || code === "JUPITER_ROUTE_ERROR") return "NO_ROUTE";
  if (code === "TRANSACTION_TOO_LARGE") return "TOO_LARGE";
  if (code && code !== "TRADE_NOT_SUBMITTED" && code !== "SIMULATION_FAILED") return code;
  const message = error instanceof Error ? error.message : String(error);
  if (/InsufficientFundsForRent|insufficient.*rent/i.test(message)) return "INSUFFICIENT_SOL_FOR_RENT";
  if (/insufficient.*(?:fund|lamport|SOL)/i.test(message)) return "INSUFFICIENT_SOL";
  if (/AccountNotFound|account.*missing/i.test(message)) return "ACCOUNT_MISSING";
  if (/slippage|SlippageToleranceExceeded/i.test(message)) return "SLIPPAGE";
  if (/expired.*block height/i.test(message)) return "EXPIRED";
  if (/Custom|custom program error/i.test(message)) return "PROGRAM_ERROR";
  return "NO_ROUTE";
}
const empty = { slot: null, solPrincipalDeltaLamports: null, targetTokenDeltaRaw: null, networkFeeLamports: null };
export function failedTrade(error: unknown, attempts: TradeAttempt[] = []): TradeResult {
  const value = error as { quotedMinimum?: bigint; requiredMinimum?: bigint };
  return { ...empty, status: "failed", phase: "before-submission", code: tradeErrorCode(error), message: error instanceof Error ? error.message : String(error), attempts,
    ...(value?.quotedMinimum != null ? { quotedMinimum: value.quotedMinimum, requiredMinimum: value.requiredMinimum } : {}) };
}
export function tradeResult(receipt: SendReceipt, attempts: TradeAttempt[] = [], executionId?: number): TradeResult {
  const status = receipt.status === "submitted" ? "unresolved" : receipt.status;
  const message = receipt.error ?? (status === "confirmed" ? "Trade confirmed" : status === "unresolved" ? "Outcome unresolved; reconcile before trading again" : "Trade failed");
  const custom = /"Custom"\s*:\s*(\d+)/.exec(message);
  const named = /Error Code: ([A-Za-z0-9_]+)/.exec(message);
  return { ...empty, status, phase: status === "unresolved" ? "unknown" : receipt.retryable ? "before-submission" : "on-chain",
    code: status === "confirmed" ? "CONFIRMED" : status === "unresolved" ? "UNRESOLVED" : tradeErrorCode(new Error(message)), message,
    signature: receipt.signature, executionId, sender: receipt.sender, slot: receipt.slot, attempts,
    feeEstimate: receipt.feeEstimate, feeLamports: receipt.feeLamports,
    solPrincipalDeltaLamports: receipt.solPrincipalDeltaLamports ?? null,
    targetTokenDeltaRaw: receipt.targetTokenDeltaRaw ?? null, networkFeeLamports: receipt.networkFeeLamports ?? (receipt.feeLamports != null ? BigInt(receipt.feeLamports) : null),
    ...(custom ? { programErrorNumber: Number(custom[1]) } : {}), ...(named ? { programErrorName: named[1] } : {}) };
}
