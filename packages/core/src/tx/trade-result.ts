import type { SendReceipt } from "./types.ts";
export type TradeAttempt = { executionId: number; signature: string; priorityMicroLamports: number };
export type TradeResult = {
  tipLamports?: number;
  feeEstimate?: import("./fee-estimate.ts").TransactionFeeEstimate;
  feeLamports?: number;
  status: "confirmed" | "failed" | "unresolved";
  phase: "before-submission" | "on-chain" | "unknown";
  code: string; message: string; signature?: string; executionId?: number;
  sender?: string; slot: number | null; attempts: TradeAttempt[];
  solPrincipalDeltaLamports: bigint | null; targetTokenDeltaRaw: bigint | null; networkFeeLamports: bigint | null;
  quotedMinimum?: bigint; requiredMinimum?: bigint; programErrorNumber?: number; programErrorName?: string;
  /** Safe to request a fresh quote. Unresolved submissions always return false. */
  retryable: boolean;
};
const slippageNames = /\b(BuySlippageBelowMinTokensOut|SellSlippageBelowMinSolOut|BuySlippageBelowMinBaseAmountOut|SellSlippageBelowMinQuoteAmountOut|ExceededSlippage|TooLittleSolReceived|SlippageToleranceExceeded)\b/;
function errorText(error: unknown): string {
  const parts: string[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && current != null; depth++) {
    parts.push(current instanceof Error ? current.message : String(current));
    if (typeof current !== "object") break;
    const value = current as { logs?: unknown; cause?: unknown };
    if (Array.isArray(value.logs)) parts.push(...value.logs.filter((log): log is string => typeof log === "string"));
    current = value.cause;
  }
  return parts.join("\n");
}
function programDetails(message: string) {
  const custom = /"Custom"\s*:\s*(\d+)|custom program error:\s*(0x[\da-f]+|\d+)|Error Number:\s*(\d+)/i.exec(message);
  const named = /Error Code: ([A-Za-z0-9_]+)/.exec(message) ?? slippageNames.exec(message);
  return { ...(custom ? { programErrorNumber: Number(custom[1] ?? custom[2] ?? custom[3]) } : {}),
    ...(named ? { programErrorName: named[1] } : {}) };
}
export function tradeErrorCode(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === "UNSUPPORTED_TOKEN" || code === "JUPITER_ROUTE_ERROR") return "NO_ROUTE";
  if (code === "TRANSACTION_TOO_LARGE") return "TOO_LARGE";
  if (code && code !== "TRADE_NOT_SUBMITTED" && code !== "SIMULATION_FAILED") return code;
  const message = errorText(error);
  if (/InsufficientFundsForRent|insufficient.*rent/i.test(message)) return "INSUFFICIENT_SOL_FOR_RENT";
  if (/insufficient.*(?:fund|lamport|SOL)/i.test(message)) return "INSUFFICIENT_SOL";
  if (/AccountNotFound|account.*missing/i.test(message)) return "ACCOUNT_MISSING";
  // Bare numeric custom codes are program-specific and cannot establish slippage.
  if (slippageNames.test(message) || /slippage/i.test(message)) return "SLIPPAGE";
  if (/expired.*block height/i.test(message)) return "EXPIRED";
  if (/Custom|custom program error/i.test(message)) return "PROGRAM_ERROR";
  return "NO_ROUTE";
}
const empty = { slot: null, solPrincipalDeltaLamports: null, targetTokenDeltaRaw: null, networkFeeLamports: null };
export function failedTrade(error: unknown, attempts: TradeAttempt[] = []): TradeResult {
  const value = error as { quotedMinimum?: bigint; requiredMinimum?: bigint };
  const code = tradeErrorCode(error);
  return { ...empty, status: "failed", phase: "before-submission", code, retryable: code === "SLIPPAGE" || code === "PRICE_GUARD_REJECTED", message: error instanceof Error ? error.message : String(error), attempts,
    ...programDetails(errorText(error)),
    ...(value?.quotedMinimum != null ? { quotedMinimum: value.quotedMinimum, requiredMinimum: value.requiredMinimum } : {}) };
}
export function tradeResult(receipt: SendReceipt, attempts: TradeAttempt[] = [], executionId?: number): TradeResult {
  const status = receipt.status === "submitted" ? "unresolved" : receipt.status;
  const message = receipt.error ?? (status === "confirmed" ? "Trade confirmed" : status === "unresolved" ? "Outcome unresolved; reconcile before trading again" : "Trade failed");
  const code = status === "confirmed" ? "CONFIRMED" : status === "unresolved" ? "UNRESOLVED" : tradeErrorCode(new Error(message));
  return { ...empty, status, phase: status === "unresolved" ? "unknown" : receipt.retryable ? "before-submission" : "on-chain",
    code, retryable: status === "failed" && (code === "SLIPPAGE" || code === "PRICE_GUARD_REJECTED"), message,
    signature: receipt.signature, executionId, sender: receipt.sender, slot: receipt.slot, attempts,
    feeEstimate: receipt.feeEstimate, feeLamports: receipt.feeLamports, tipLamports: receipt.tipLamports,
    solPrincipalDeltaLamports: receipt.solPrincipalDeltaLamports ?? null,
    targetTokenDeltaRaw: receipt.targetTokenDeltaRaw ?? null, networkFeeLamports: receipt.networkFeeLamports ?? (receipt.feeLamports != null ? BigInt(receipt.feeLamports) : null),
    ...programDetails(message) };
}
