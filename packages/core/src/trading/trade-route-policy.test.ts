import { describe, expect, test } from "bun:test";

import {
  nativePumpTradeAvailable,
  selectTradeRoute,
  type VenuePreference,
} from "./trade-route-policy.ts";
function token(venueHint: string | null): { venueHint: string | null } {
  return { venueHint };
}

describe("trade route policy", () => {
  test("auto prefers native for Pump curve", () => {
    const row = token("pump-curve");
    expect(nativePumpTradeAvailable(row)).toBe(true);
    expect(selectTradeRoute(row, "auto")).toBe("native");
  });

  test("auto prefers native for PumpSwap", () => {
    expect(selectTradeRoute(token("pumpswap"), "auto")).toBe("native");
  });

  test("auto falls back to Jupiter for ordinary or unknown tokens", () => {
    expect(selectTradeRoute(token("unknown"), "auto")).toBe("jupiter");
    expect(selectTradeRoute(null, "auto")).toBe("jupiter");
  });

  test.each<[VenuePreference, "native" | "jupiter"]>([
    ["native", "native"],
    ["jupiter", "jupiter"],
  ])("explicit %s overrides auto policy", (preference, expected) => {
    expect(selectTradeRoute(null, preference)).toBe(expected);
  });
});
