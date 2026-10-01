import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(import.meta.dir, "multi-agent-demo.ts"),
  "utf8",
);

describe("multi-agent demo", () => {
  test("keeps the demo in one main function", () => {
    expect(source.match(/\bfunction\s+\w+\s*\(/g)).toEqual(["function main("]);
  });

  test("keeps token and transaction ownership in Solard", () => {
    expect(source).not.toContain("slrd.addToken");
    expect(source).not.toContain("getTransaction(");
    expect(source).not.toContain("slrd.position(");
    expect(source).not.toContain("slrd.trades(");
  });

  test("uses one shared feed and three bgrun strategy agents", () => {
    expect(source).toContain('name: "solard-price-feed"');
    expect(source).toContain("connectPriceFeed({");
    expect(source).toContain("mints: token");
    expect(source).toContain('["dip", "momentum", "range"]');
  });

  test("agents trade only through public Solard buy and sell", () => {
    expect(source).toContain(
      "await slrd.buy({ wallet, token, amount: buySol, slippageBps })",
    );
    expect(source).toContain(
      'await slrd.sell({ wallet, token, amount: "all", slippageBps })',
    );
  });
});
