import type { TradeLandingPolicy } from "@solard/core";

/** Validate fee flags before constructing or signing a trade. */
export function tradeFeeOptions(flags: ReadonlyMap<string, string>) {
  const number = (name: string): number | undefined => {
    if (!flags.has(name)) return undefined;
    const value = Number(flags.get(name));
    if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
    return value;
  };
  const cuLimit = number("cu-limit");
  const microLamports = number("priority-micro-lamports");
  if (cuLimit != null && (!Number.isInteger(cuLimit) || cuLimit < 1 || cuLimit > 1_400_000))
    throw new Error("--cu-limit must be an integer between 1 and 1400000");
  if (microLamports != null && (!Number.isSafeInteger(microLamports) || microLamports < 0))
    throw new Error("--priority-micro-lamports must be a non-negative integer");
  const landing: TradeLandingPolicy = {
    maxAttempts: number("trade-attempts"),
    feeMultiplier: number("fee-multiplier"),
    feePercentile: number("fee-percentile"),
    maxPriorityFeeLamports: number("max-priority-fee-lamports"),
  };
  return { priorityFee: { cuLimit, microLamports }, landing };
}
