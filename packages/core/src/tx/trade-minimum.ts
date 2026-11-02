export class BelowMinimumError extends Error {
  readonly code = "BELOW_MINIMUM";
  readonly phase = "before-submission";
  constructor(
    readonly quotedMinimum: bigint,
    readonly requiredMinimum: bigint,
  ) {
    super(
      `Guaranteed output ${quotedMinimum} is below required ${requiredMinimum}`,
    );
    this.name = "BelowMinimumError";
  }
}
export function assertTradeMinimum(
  quoted: bigint,
  required?: bigint | string,
): void {
  if (required == null) return;
  const minimum = BigInt(required);
  if (minimum < 0n) throw new Error("Minimum output must be non-negative");
  if (quoted < minimum) throw new BelowMinimumError(quoted, minimum);
}

/** Absolute on-chain floor, distinct from a guard on a slippage-derived quote. */
export function setOutputMinimum(
  quote: import("../venues/venue-plugin.ts").QuoteResult,
  required?: bigint | string,
  allowUnmarketable = false,
): void {
  if (required == null) return;
  const minimum = BigInt(required);
  if (minimum <= 0n || minimum > 0xffffffffffffffffn)
    throw new Error("Output minimum must be a positive u64");
  if (!allowUnmarketable) assertTradeMinimum(quote.expectedOutputRaw, minimum);
  quote.minimumOutputRaw = minimum;
  quote.meta = { ...quote.meta, absoluteMinimumOutputRaw: minimum.toString(), ...(allowUnmarketable ? { preparedLimitOrder: true } : {}) };
}
