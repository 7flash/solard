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
  if (start < 0 || end < 0)
    throw new Error(`missing ${startNeedle}..${endNeedle}`);
  return source.slice(start, end);
}

describe("merged position-controller regressions", () => {
  test("keeps Pump/PumpSwap as first-class venues", () => {
    expect(source).toContain(
      'type NativeSwapVenue = "pump-curve" | "pumpswap"',
    );
    expect(source).toContain(
      'type SwapVenue = NativeSwapVenue | "jupiter" | "raydium"',
    );
    expect(source).toContain(
      'type VenueMode = "auto" | "native" | "jupiter" | "raydium"',
    );
    expect(source).toContain("type QuoteResult");
    expect(source).toContain("type TradeVenuePlugin");
    expect(source).toContain("type VenueMarket");
  });

  test("auto remains native-first and Jupiter explicit-only", () => {
    const body = section(
      "async function quoteBestRoute",
      "async function executeRoutedSwap",
    );
    expect(body).toContain(
      'if (args.mode === "native") return await quoteNative()',
    );
    expect(body).toContain(
      'if (args.mode === "jupiter") return await quoteJupiter()',
    );
    expect(body).toContain('errorCode(nativeError) !== "UNSUPPORTED_TOKEN"');
    expect(body).toContain("Jupiter is explicit-only");
    expect(body).not.toContain("Promise.allSettled([");
  });

  test("native execution remains freshly quoted, built, simulated, then submitted", () => {
    const body = section(
      "async function executeRoutedSwap",
      "function ownerTokenRaw",
    );
    expect(body).toContain("resolveNativeRoute({");
    expect(body).toContain("route.plugin.quoteBuy(");
    expect(body).toContain("route.plugin.quoteSell(");
    expect(body).toContain("route.plugin.buildBuy(");
    expect(body).toContain("route.plugin.buildSell(");
    expect(body).toContain("simulatePlan(plan)");
    expect(body).toContain("submitPlan(");
    expect(body).toContain("markSubmissionAmbiguous(error");
  });

  test("does not reintroduce broad pre-submit ambiguity window", () => {
    expect(source).not.toContain("tradeSubmissionInProgress");
    expect(source).toContain("isSubmissionAmbiguous(error)");
    expect(source).toContain(
      "sender/execution call failed after submission may have begun but before a signature was durably journaled",
    );
  });

  test("pending settlement accepts native Pump venues", () => {
    expect(source).toContain('parsed.pendingSettlement.venue === "pump-curve"');
    expect(source).toContain('parsed.pendingSettlement.venue === "pumpswap"');
  });

  test("keeps strong settlement recovery instead of quote-guess sell fallback", () => {
    const body = section(
      "const reconcilePendingSettlement",
      "const settleWithRetries",
    );
    expect(body).toContain("getSignatureStatuses(");
    expect(body).toContain("searchTransactionHistory: true");
    expect(body).toContain("getSignaturesForAddress(");
    expect(body).toContain("getParsedTransaction(");
    expect(body).toContain("settlement.expired-unseen");
    expect(body).toContain("settlement.legacy-expired-unseen");
    expect(body).toContain(
      "confirmed-signature+latest-wallet/token-history+pumpswap-exact-input",
    );
    expect(body).not.toContain("conservativeOutputRaw");
  });

  test("all sizing quote calls retain slrd + walletRef", () => {
    for (const fn of [
      "sizeSameTokens",
      "futureLiquidationForBuy",
      "sizeToBase",
    ]) {
      const start = source.indexOf(`async function ${fn}`);
      expect(start).toBeGreaterThanOrEqual(0);
    }
    const planBuy = section(
      "const planBuy = async",
      "const executeBuy = async",
    );
    const toBaseCalls = [
      ...planBuy.matchAll(/sizeToBase\(\{([\s\S]*?)\n\s*\}\);/g),
    ];
    expect(toBaseCalls.length).toBe(2);
    for (const call of toBaseCalls) {
      expect(call[1]).toContain("slrd,");
      expect(call[1]).toContain("walletRef,");
    }
  });
});
