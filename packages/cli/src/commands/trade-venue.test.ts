import { describe, expect, test } from "bun:test";
import { parseVenuePreference } from "./trade-venue.ts";

function flags(input: Record<string, string>): ReadonlyMap<string, string> {
  return new Map(Object.entries(input));
}

describe("parseVenuePreference", () => {
  test("defaults to auto", () => {
    expect(parseVenuePreference(flags({}))).toBe("auto");
  });

  test("parses --venue", () => {
    expect(parseVenuePreference(flags({ venue: "native" }))).toBe("native");
    expect(parseVenuePreference(flags({ venue: "JUPITER" }))).toBe("jupiter");
  });

  test("legacy shortcut flags override --venue", () => {
    expect(
      parseVenuePreference(flags({ venue: "native", jupiter: "true" })),
    ).toBe("jupiter");
    expect(
      parseVenuePreference(flags({ venue: "jupiter", native: "true" })),
    ).toBe("native");
  });

  test("rejects invalid venue", () => {
    expect(() => parseVenuePreference(flags({ venue: "raydium" }))).toThrow(
      "--venue must be auto, native, or jupiter",
    );
  });
});
