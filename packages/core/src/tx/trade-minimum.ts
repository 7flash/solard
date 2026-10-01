export class BelowMinimumError extends Error {
  readonly code = "BELOW_MINIMUM";
  readonly phase = "before-submission";
  constructor(readonly quotedMinimum: bigint, readonly requiredMinimum: bigint) {
    super(`Guaranteed output ${quotedMinimum} is below required ${requiredMinimum}`);
    this.name = "BelowMinimumError";
  }
}
export function assertTradeMinimum(quoted: bigint, required?: bigint | string): void {
  if (required == null) return;
  const minimum = BigInt(required);
  if (minimum < 0n) throw new Error("Minimum output must be non-negative");
  if (quoted < minimum) throw new BelowMinimumError(quoted, minimum);
}
