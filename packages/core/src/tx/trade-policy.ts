/** Pure policy shared by buy and sell; no RPC or signing side effects. */
export type TradeLandingPolicy = {
  /** Total signed generations, including the first. Default 3; maximum 5. */
  maxAttempts?: number;
  /** Multiplier applied only after a proven, unobserved expiry. Default 2. */
  feeMultiplier?: number;
  /** Maximum compute priority fee per transaction (excludes base fee/tips). Default 1_000_000 lamports. */
  maxPriorityFeeLamports?: number;
  /** Fixed CU price; disables market estimation and fee escalation. */
  microLamports?: number;
  /** Percentile of recent writable-account fee samples. Default 75. */
  feePercentile?: number;
  maxFeeBpsOfNotional?: number;
};

export function normalizeLandingPolicy(input: TradeLandingPolicy = {}) {
  const value = {
    maxAttempts: input.maxAttempts ?? 3,
    feeMultiplier: input.feeMultiplier ?? 2,
    maxPriorityFeeLamports: input.maxPriorityFeeLamports ?? 1_000_000,
    microLamports: input.microLamports,
    feePercentile: input.feePercentile ?? 75,
    maxFeeBpsOfNotional: input.maxFeeBpsOfNotional,
  };
  if (!Number.isInteger(value.maxAttempts) || value.maxAttempts < 1 || value.maxAttempts > 5)
    throw new Error("landing.maxAttempts must be an integer between 1 and 5");
  if (!Number.isFinite(value.feeMultiplier) || value.feeMultiplier < 1 || value.feeMultiplier > 10)
    throw new Error("landing.feeMultiplier must be between 1 and 10");
  if (!Number.isSafeInteger(value.maxPriorityFeeLamports) || value.maxPriorityFeeLamports < 0)
    throw new Error("landing.maxPriorityFeeLamports must be a non-negative safe integer");
  if (value.microLamports != null && (!Number.isSafeInteger(value.microLamports) || value.microLamports < 0))
    throw new Error("landing.microLamports must be a non-negative safe integer");
  if (!Number.isFinite(value.feePercentile) || value.feePercentile < 0 || value.feePercentile > 100)
    throw new Error("landing.feePercentile must be between 0 and 100");
  if (value.maxFeeBpsOfNotional != null && (!Number.isInteger(value.maxFeeBpsOfNotional) || value.maxFeeBpsOfNotional < 0 || value.maxFeeBpsOfNotional > 10_000))
    throw new Error("landing.maxFeeBpsOfNotional must be between 0 and 10000");
  return value;
}

export function chooseTradeFee(
  policy: ReturnType<typeof normalizeLandingPolicy>,
  cuLimit: number,
  samples: readonly number[],
  previous?: number,
): number {
  if (!Number.isInteger(cuLimit) || cuLimit < 1 || cuLimit > 1_400_000)
    throw new Error("Invalid trade compute unit limit");
  // Integer division avoids floating-point rounding above the spending cap.
  const cap = Number((BigInt(policy.maxPriorityFeeLamports) * 1_000_000n) / BigInt(cuLimit));
  if (!Number.isSafeInteger(cap)) throw new Error("Priority fee cap is too large");
  if (policy.microLamports != null) {
    if (policy.microLamports > cap) throw new Error("Fixed priority fee exceeds landing.maxPriorityFeeLamports");
    return policy.microLamports;
  }
  const sorted = samples.filter((n) => Number.isSafeInteger(n) && n >= 0).sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * policy.feePercentile / 100) - 1);
  const market = sorted[index] ?? 0;
  const escalated = previous == null ? 0 : Math.ceil(previous * policy.feeMultiplier);
  return Math.min(cap, Math.max(100_000, market, escalated));
}

type LandingReceipt = {
  status: "submitted" | "confirmed" | "failed";
  retryable?: boolean;
};

/** An ambiguous submission or a program failure must never trigger a new trade. */
export async function runTradeAttempts<S, R extends LandingReceipt>(
  maxAttempts: number,
  submit: (attempt: number) => Promise<S>,
  settle: (submission: S) => Promise<R>,
): Promise<{ submission: S; receipt: R; submissions: S[] }> {
  const submissions: S[] = [];
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const submission = await submit(attempt);
    submissions.push(submission);
    const receipt = await settle(submission);
    if (receipt.status !== "failed" || receipt.retryable !== true || attempt + 1 === maxAttempts)
      return { submission, receipt, submissions };
  }
  throw new Error("No trade attempts configured");
}
