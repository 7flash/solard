import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "solard.ts"), "utf8");
const repo = readFileSync(
  join(import.meta.dir, "../db/execution-repo.ts"),
  "utf8",
);

describe("trade execution ledger", () => {
  test("persists confirmed fill metadata", () => {
    expect(source).toContain("captureExecutionTradeFill(execution)");
    expect(source).toContain("tradeFill: fill");
    expect(source).toContain("tokenDeltaRaw");
    expect(source).toContain("economicLamports");
    expect(source).toContain("networkFeeLamports");
  });

  test("refreshes submitted status before trade filtering", () => {
    expect(source).toContain("refreshExecutionTradeStatus(row)");
    expect(source).toContain("getSignatureStatuses(");
    expect(source).toContain('status: "confirmed"');
    expect(source).toContain('status: "failed"');
  });

  test("exposes wallet and mint execution queries", () => {
    expect(source).toContain("async trades(options: SolardTradeQuery = {})");
    expect(repo).toContain("query(input: ExecutionQuery = {})");
    expect(repo).toContain("row.walletAddress === input.walletAddress");
    expect(repo).toContain("row.mint === input.mint");
  });

  test("exposes current wallet token position without another ledger", () => {
    expect(source).toContain("async position(options: SolardPositionQuery)");
    expect(source).toContain("readTokenAmount(");
    expect(source).toContain(
      'getBalance(new PublicKey(walletAddress), "confirmed")',
    );
  });
});
