import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(import.meta.dir, "price-feed-server.ts"),
  "utf8",
);

describe("price feed application boundary", () => {
  test("consumes sdk subscriptions instead of protocol internals", () => {
    expect(source).toContain("subscribeLaunches");
    expect(source).toContain("subscribeTrades");
    expect(source).toContain('from "@solard/sdk"');
    expect(source).not.toContain('from "@solard/core"');
    expect(source).not.toMatch(
      /PUMP_(?:CREATE|TRADE)_EVENT|PUMPSWAP_(?:BUY|SELL|CREATE)_EVENT|LAUNCHLAB_(?:CREATE|TRADE)_EVENT/,
    );
    expect(source).not.toMatch(/logsSubscribe|onLogs\(/);
  });
});
