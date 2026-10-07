/** SOL per whole target token. Strings preserve precision for small prices. */
export type SolPrice = string | number;

export class PriceGuardRejected extends Error {
  readonly code = "PRICE_GUARD_REJECTED";
  readonly phase = "before-submission";
  readonly retryable = true;
  constructor(readonly side: "buy" | "sell", readonly limitPriceSol: SolPrice) {
    super(`${side} worst-case quote violates ${side === "buy" ? "maximum" : "minimum"} SOL price ${limitPriceSol}`);
    this.name = "PriceGuardRejected";
  }
}

function fraction(price: SolPrice): { numerator: bigint; denominator: bigint } {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(price).trim());
  if (!match) throw new Error("SOL price must be a positive decimal");
  const digits = match[2] ?? "";
  const exponent = Number(match[3] ?? 0) - digits.length;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 300 || match[1]!.length + digits.length > 300)
    throw new Error("SOL price precision is too large");
  const numerator = BigInt(match[1]! + digits);
  if (numerator <= 0n) throw new Error("SOL price must be positive");
  return exponent >= 0
    ? { numerator: numerator * 10n ** BigInt(exponent), denominator: 1n }
    : { numerator, denominator: 10n ** BigInt(-exponent) };
}

/** Compare worst-case principal price with integer arithmetic, excluding fees/rent. */
export function assertTradePrice(side: "buy" | "sell", inputRaw: bigint, minimumOutputRaw: bigint,
  tokenDecimals: number | null, limit?: SolPrice): void {
  if (limit == null) return;
  if (tokenDecimals == null || !Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 255)
    throw new Error("Verified target token decimals are required for a SOL price guard");
  if (inputRaw <= 0n || minimumOutputRaw <= 0n) throw new PriceGuardRejected(side, limit);
  const { numerator, denominator } = fraction(limit);
  const tokenScale = 10n ** BigInt(tokenDecimals);
  const solScale = 1_000_000_000n;
  const allowed = side === "buy"
    ? inputRaw * tokenScale * denominator <= minimumOutputRaw * numerator * solScale
    : minimumOutputRaw * tokenScale * denominator >= inputRaw * numerator * solScale;
  if (!allowed) throw new PriceGuardRejected(side, limit);
}
