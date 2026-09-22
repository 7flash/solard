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

describe("position controller native routing", () => {
  test("auto is native-first and never implicitly calls Jupiter", () => {
    const quoteRouter = section(
      "async function quoteBestRoute(",
      "async function executeRoutedSwap(",
    );

    expect(quoteRouter).toContain('if (args.mode === "native")');
    expect(quoteRouter).toContain("const native = await quoteNative()");
    expect(quoteRouter).toContain("const raydium = await quoteRaydium()");
    expect(quoteRouter).toContain("Jupiter is explicit-only");
    expect(quoteRouter).not.toContain(
      "Promise.allSettled([quoteJupiter(), quoteRaydium()])",
    );
  });

  test("native Pump/PumpSwap quote and execution use Solard venue plugins", () => {
    expect(source).toContain("args.slrd.route(token, user)");
    expect(source).toContain("route.plugin.quoteBuy(");
    expect(source).toContain("route.plugin.quoteSell(");
    expect(source).toContain("route.plugin.buildBuy(");
    expect(source).toContain("route.plugin.buildSell(");
    expect(source).toContain('value === "pump-curve" || value === "pumpswap"');
  });

  test("fresh native build must still satisfy strategy output guard", () => {
    expect(source).toContain(
      "const protectedOutput = built.minOutputRaw ?? freshQuote.minimumOutputRaw",
    );
    expect(source).toContain("protectedOutput < args.minAcceptableOutputRaw");
  });

  test("Jupiter /order failure is pre-submission, not ambiguous", () => {
    expect(source).toContain('if (endpoint === "/order") throw error;');
  });

  test("actual sender failures are marked ambiguous", () => {
    expect(source).toContain(
      "throw markSubmissionAmbiguous(error, nativeVenue(route.market.venue))",
    );
    expect(source).toContain("if (isSubmissionAmbiguous(error))");
    expect(source).toContain("cycle.fail-stop.execution-ambiguous");
  });

  test("pending settlement accepts native venue identities", () => {
    expect(source).toContain('parsed.pendingSettlement.venue === "pump-curve"');
    expect(source).toContain('parsed.pendingSettlement.venue === "pumpswap"');
  });
});
