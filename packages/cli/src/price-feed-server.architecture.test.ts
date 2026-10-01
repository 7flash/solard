import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(import.meta.dir, "price-feed-server.ts"),
  "utf8",
);

describe("price feed application boundary", () => {
  test("owns one sdk trade subscription and changes its token set dynamically", () => {
    expect(source).toContain("slrd.listenTrades");
    expect(source).toContain("tradeSubscription.add");
    expect(source).toContain("tradeSubscription?.remove");
    expect(source).toContain("const refs = new Map<string, number>()");
    expect(source).not.toContain("subscribeLaunches");
    expect(source).not.toContain('from "@solard/core"');
    expect(source).not.toMatch(/logsSubscribe|onLogs\(/);
  });
});
