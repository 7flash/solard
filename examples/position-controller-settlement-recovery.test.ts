import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(import.meta.dir, "position-controller.ts"),
  "utf8",
);

function section(startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end < 0) {
    throw new Error(`Could not extract ${startNeedle}..${endNeedle}`);
  }
  return source.slice(start, end);
}

describe("position-controller settlement recovery", () => {
  test("checks signature status independently of transaction metadata", () => {
    const body = section(
      "const reconcilePendingSettlement",
      "const settleWithRetries",
    );
    expect(body).toContain("getSignatureStatuses(");
    expect(body).toContain("searchTransactionHistory: true");
    expect(body).toContain("getSignaturesForAddress(");
    expect(body).toContain("getParsedTransaction(");
  });

  test("recovers confirmed legacy PumpSwap exact-input buys without tx metadata", () => {
    const body = section(
      "const reconcilePendingSettlement",
      "const settleWithRetries",
    );
    expect(body).toContain(
      'pending.side === "buy" && pending.venue === "pumpswap"',
    );
    expect(body).toContain("BigInt(pending.requestedInputRaw)");
    expect(body).toContain(
      "confirmed-signature+latest-wallet/token-history+pumpswap-exact-input",
    );
  });

  test("persists expiry and pre-submit accounting for new native submissions", () => {
    expect(source).toContain("lastValidBlockHeight?: number | null");
    expect(source).toContain("preWalletLamports?: string | null");
    expect(source).toContain("preOwnedTokenAccountLamports?: string | null");
    expect(source).toContain("estimatedNetworkFeeLamports?: string | null");
    expect(source).toContain("getFeeForMessage(plan.transaction.message");
    expect(source).toContain(
      "lastValidBlockHeight: submission.plan.lastValidBlockHeight",
    );
  });

  test("clears genuinely expired unseen submissions instead of blocking forever", () => {
    const body = section(
      "const reconcilePendingSettlement",
      "const settleWithRetries",
    );
    expect(body).toContain("settlement.expired-unseen");
    expect(body).toContain("settlement.legacy-expired-unseen");
    expect(body).toContain("currentBlockHeight > pending.lastValidBlockHeight");
    expect(body).toContain("const legacyExpiryMs = 180_000");
  });

  test("balance fallback refuses attribution after newer wallet/token activity", () => {
    const body = section(
      "const reconcilePendingSettlement",
      "const settleWithRetries",
    );
    expect(body).toContain("!history.latest");
    expect(body).toContain("!tokenHistory.latest");
    expect(body).toContain("newer/unattributed wallet activity");
  });

  test("both to-base call sites pass slrd and walletRef", () => {
    const body = section("const planBuy = async", "const executeBuy = async");
    const calls = [...body.matchAll(/sizeToBase\(\{([\s\S]*?)\n\s*\}\);/g)];
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call[1]).toContain("slrd,");
      expect(call[1]).toContain("walletRef,");
    }
  });
});
