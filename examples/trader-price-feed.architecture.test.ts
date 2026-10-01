import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const manager = readFileSync(
  join(import.meta.dir, "trader-manager-server.ts"),
  "utf8",
);
const engine = readFileSync(
  join(import.meta.dir, "lib", "interactive-trader-engine.ts"),
  "utf8",
);

describe("shared trader price feed", () => {
  test("manager starts one shared feed and passes it to spawned traders", () => {
    expect(manager).toContain('const PRICE_FEED_PROCESS = "solard-price-feed"');
    expect(manager).toContain("await ensurePriceFeed()");
    expect(manager).toContain("SOLARD_PRICE_FEED_URL: priceFeedUrl");
  });

  test("records direct Raydium executions in the Solard trade ledger", () => {
    expect(engine).toContain("recordConfirmedTrade");
    expect(engine).toContain(
      'recordConfirmedTrade(signature, "buy", "raydium")',
    );
    expect(engine).toContain(
      'recordConfirmedTrade(signature, "buy", "raydium-launchlab")',
    );
    expect(engine).toContain(
      'recordConfirmedTrade(signature, "sell", "raydium")',
    );
    expect(engine).toContain(
      'recordConfirmedTrade(signature, "sell", "raydium-launchlab")',
    );
  });

  test("traders consume feed ticks instead of polling market prices while watching", () => {
    expect(engine).toContain("connectPriceFeed");
    expect(engine).toContain("waitForFeedPrice");
    const start = engine.indexOf("private async watch(");
    const end = engine.indexOf("private async reportTrigger(", start);
    const watch = engine.slice(start, end);
    expect(watch).toContain("waitForFeedPrice");
    expect(watch).not.toContain("sampleMarket()");
    expect(engine).not.toContain("subscribeTrades");
  });
});
