import { describe, expect, test } from "bun:test";
import { pumpLaunchInputFromRecord } from "./launches.ts";

describe("pumpLaunchInputFromRecord defaults", () => {
  test("defaults live to false and skipSimulation to false", () => {
    const input = pumpLaunchInputFromRecord({
      creator: "creator-wallet",
    });
    expect(input.live).toBe(false);
    expect(input.skipSimulation).toBe(false);
  });

  test("honors explicit skipSimulation true", () => {
    const input = pumpLaunchInputFromRecord({
      creator: "creator-wallet",
      skipSimulation: true,
    });
    expect(input.skipSimulation).toBe(true);
  });
});
