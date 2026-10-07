/** Pure policy shared by buy and sell; no RPC or signing side effects. */
export type TradeLandingPolicy = {
  route?: "helius-swqos" | "helius-max" | "rpc";
  cuLimit?: number | "auto";
  /** Automatic simulation sizing margin. Default 1.3; range 1.2–1.7. */
  computeUnitMultiplier?: number;
  priorityMicroLamports?: number;
  /** Escalate an initial fixed bid after proven expiry. The legacy microLamports option stays fixed by default. */
  escalateFixedFees?: boolean;
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
  /** Automatic bid floor in micro-lamports/CU. Default 100_000; zero permits low bids. */
  minMicroLamports?: number;
  maxFeeBpsOfNotional?: number;
};

export function normalizeLandingPolicy(input: TradeLandingPolicy = {}) {
  const value = {
    route: input.route,
    cuLimit: input.cuLimit,
    computeUnitMultiplier: input.computeUnitMultiplier ?? 1.3,
    maxAttempts: input.maxAttempts ?? 3,
    feeMultiplier: input.feeMultiplier ?? 2,
    maxPriorityFeeLamports: input.maxPriorityFeeLamports ?? 1_000_000,
    microLamports: input.microLamports ?? input.priorityMicroLamports,
    escalateFixedFees: input.escalateFixedFees ?? (input.microLamports == null && input.priorityMicroLamports != null),
    feePercentile: input.feePercentile ?? 75,
    minMicroLamports: input.minMicroLamports ?? 100_000,
    maxFeeBpsOfNotional: input.maxFeeBpsOfNotional,
  };
  if (value.route != null && !["helius-swqos", "helius-max", "rpc"].includes(value.route))
    throw new Error("landing.route must be helius-swqos, helius-max or rpc");
  if (value.cuLimit != null && value.cuLimit !== "auto" &&
      (!Number.isInteger(value.cuLimit) || value.cuLimit < 1 || value.cuLimit > 1_400_000))
    throw new Error("landing.cuLimit must be auto or an integer between 1 and 1400000");
  if (!Number.isFinite(value.computeUnitMultiplier) || value.computeUnitMultiplier < 1.2 || value.computeUnitMultiplier > 1.7)
    throw new Error("landing.computeUnitMultiplier must be between 1.2 and 1.7");
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
  if (!Number.isSafeInteger(value.minMicroLamports) || value.minMicroLamports < 0)
    throw new Error("landing.minMicroLamports must be a non-negative safe integer");
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
    return policy.escalateFixedFees && previous != null
      ? Math.min(cap, Math.max(policy.microLamports, Math.ceil(previous * policy.feeMultiplier)))
      : policy.microLamports;
  }
  const sorted = samples.filter((n) => Number.isSafeInteger(n) && n >= 0).sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * policy.feePercentile / 100) - 1);
  const market = sorted[index] ?? 0;
  const escalated = previous == null ? 0 : Math.ceil(previous * policy.feeMultiplier);
  return Math.min(cap, Math.max(policy.minMicroLamports, market, escalated));
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
