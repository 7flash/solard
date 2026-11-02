import type { TokenRow } from "../db/schema.ts";

/** Fast native proofs precede aggregator fallback; transport errors are never absence. */
export async function discoverConversionToken(options: {
  existing: () => TokenRow | null;
  curve: () => Promise<Partial<TokenRow> | null>;
  solPool: () => Promise<Partial<TokenRow> | null>;
  register: (metadata: Partial<TokenRow>) => Promise<TokenRow>;
  fallback: () => Promise<TokenRow>;
  jupiterAvailable: boolean;
}): Promise<TokenRow> {
  const existing = options.existing();
  if (existing && existing.venueHint && existing.venueHint !== "unknown") return existing;
  const curve = await options.curve();
  if (curve) return options.register(curve);
  const pool = await options.solPool();
  if (pool) return options.register(pool);
  if (options.jupiterAvailable) return options.register({ venueHint: "jupiter" });
  return options.fallback();
}
