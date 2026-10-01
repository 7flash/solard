import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const client = readFileSync(join(import.meta.dir, "client.ts"), "utf8");
const live = readFileSync(join(import.meta.dir, "live.ts"), "utf8");
const index = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
const core = readFileSync(
  join(import.meta.dir, "../../core/src/core/solard.ts"),
  "utf8",
);

describe("operator api", () => {
  test("uses one object-form trade api", () => {
    expect(client).toContain("input: SolardBuyInput");
    expect(client).toContain("input: SolardSellInput");
    expect(client).toContain("SolardTradeExecutionOptions = TradeExecutionOptions");
    expect(client).toContain("exportPrivateKey");
    expect(client).toContain("getTransaction(");
  });

  test("uses one dynamic live trade listener api", () => {
    expect(index).toContain("listenTrades");
    expect(index).not.toContain("subscribeTrades");
    expect(live).toContain("onTrade(callback)");
    expect(live).toContain("add: (tokens)");
    expect(live).toContain("remove: (tokens)");
  });

  test("persists the signed signature before safe rebroadcast", () => {
    expect(core).toContain("const signature = signedPlanSignature(plan)");
    expect(core).toContain(
      "waitForSignatureSeen(this.connection(), signature)",
    );
    expect(core).toContain("await broadcast(true)");
    expect(core).toContain("cacheParsedTransaction");
  });

  test("default trades settle inside Solard rather than leaking submitted state", () => {
    expect(client).toContain("core.buy(");
    expect(client).toContain("core.sell(");
    expect(core).toContain("async settleSubmission(");
    expect(core).toContain("submission.plan.lastValidBlockHeight");
  });
});
