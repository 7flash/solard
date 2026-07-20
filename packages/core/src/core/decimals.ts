/** Normalize decimals read from old SQLite rows or RPC responses. Earlier databases may contain TEXT decimals. */
export function optionalDecimals(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
    throw new Error(`Invalid token decimals value: ${String(value)}`);
  }
  return parsed;
}

export function decimalsOr(value: unknown, fallback: number): number {
  return optionalDecimals(value) ?? fallback;
}
