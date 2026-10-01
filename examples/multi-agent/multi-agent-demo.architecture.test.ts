import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const launcher = readFileSync(
  join(import.meta.dir, "multi-agent-demo.ts"),
  "utf8",
);
const agent = readFileSync(
  join(import.meta.dir, "multi-agent-agent.ts"),
  "utf8",
);
const feed = readFileSync(
  join(import.meta.dir, "../packages/cli/src/price-feed-server.ts"),
  "utf8",
);

describe("multi-agent demo", () => {
  test("runs three independent strategies as bgrun processes", () => {
    expect(launcher).toContain(
      'const STRATEGIES: StrategyName[] = ["dip", "momentum", "range"]',
    );
    expect(launcher).toContain(
      'command: "bun run examples/multi-agent-agent.ts"',
    );
    expect(launcher).toContain("handleRun");
  });

  test("agents consume the shared price feed rather than opening market subscriptions", () => {
    expect(agent).toContain("connectPriceFeed");
    expect(agent).not.toContain("listenTrades");
    expect(agent).not.toContain("subscribeTrades");
  });

  test("agents execute through the public Solard trade API", () => {
    expect(agent).toContain("await slrd.buy({");
    expect(agent).toContain("await slrd.sell({");
    expect(agent).toContain("await slrd.position({");
    expect(agent).toContain("await slrd.trades({");
    expect(agent).not.toContain("pendingSignature");
    expect(agent).not.toContain("reconcilePending");
    expect(agent).not.toContain("slrd.getTransaction");
  });

  test("one upstream feed ref-counts all downstream agent subscriptions", () => {
    expect(feed).toContain("const refs = new Map<string, number>()");
    expect(feed).toContain("await tradeSubscription.add(mint)");
    expect(feed).toContain("await tradeSubscription?.remove(mint)");
  });
});
