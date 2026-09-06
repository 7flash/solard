import type { VenuePreference } from "@solard/sdk";

export type TradeCommandFlags = ReadonlyMap<string, string>;

export function parseVenuePreference(
  flags: TradeCommandFlags,
): VenuePreference {
  const value = flags.has("jupiter")
    ? "jupiter"
    : flags.has("native")
      ? "native"
      : (flags.get("venue") ?? "auto").toLowerCase();

  if (value !== "auto" && value !== "native" && value !== "jupiter") {
    throw new Error("--venue must be auto, native, or jupiter");
  }

  return value;
}
