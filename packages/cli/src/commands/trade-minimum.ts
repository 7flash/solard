import type { TradeCommandFlags } from "./trade-venue.ts";

export function hasOutputMinimum(flags: TradeCommandFlags): boolean {
  return flags.has("min-out") || flags.has("min-out-raw");
}

export function parseOutputMinimum(flags: TradeCommandFlags, decimals: number): bigint | undefined {
  if (!hasOutputMinimum(flags)) return undefined;
  if (flags.has("slippage-bps")) throw new Error("Use --min-out or --min-out-raw instead of --slippage-bps");
  if (flags.has("min-out") && flags.has("min-out-raw")) throw new Error("Choose --min-out or --min-out-raw");
  const raw = flags.has("min-out-raw");
  const value = flags.get(raw ? "min-out-raw" : "min-out") ?? "";
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255)
    throw new Error("Output mint decimals unavailable");
  if (!(raw ? /^\d+$/ : /^\d+(?:\.\d+)?$/).test(value))
    throw new Error("Minimum output must be a positive decimal amount (integer for --min-out-raw)");
  const [whole, fraction = ""] = value.split(".");
  if (!raw && fraction.length > decimals) throw new Error(`Minimum output supports at most ${decimals} decimal places`);
  const amount = raw ? BigInt(value)
    : BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (amount <= 0n || amount > 0xffffffffffffffffn) throw new Error("Minimum output must be a positive u64");
  return amount;
}
