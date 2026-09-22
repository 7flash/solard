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

describe("native RPC preflight handling", () => {
  test("recognizes RPC simulation rejection as pre-submission", () => {
    expect(source).toContain("function isRpcPreflightSimulationRejection");
    expect(source).toContain("/Transaction simulation failed/i");
  });

  test("known Pump slippage races get one fresh native retry", () => {
    const body = section(
      "async function executeRoutedSwap",
      'if (args.quote.venue === "jupiter")',
    );
    expect(body).toContain("const maxNativeAttempts = 2");
    expect(body).toContain("isNativeSlippageRejection(simulationError)");
    expect(body).toContain("isNativeSlippageRejection(error)");
    expect(body).toContain("continue;");
    expect(source).toContain("/TooLittleSolReceived/i");
    expect(source).toContain("/Error Number:\\\\s*6003\\\\b/i");
    expect(source).toContain("/Error Number:\\\\s*6040\\\\b/i");
  });

  test("preflight simulation failure is checked before ambiguous tagging", () => {
    const body = section(
      "async function executeRoutedSwap",
      'if (args.quote.venue === "jupiter")',
    );
    const preflight = body.indexOf("isRpcPreflightSimulationRejection(error)");
    const ambiguous = body.indexOf("markSubmissionAmbiguous(");
    expect(preflight).toBeGreaterThan(0);
    expect(ambiguous).toBeGreaterThan(preflight);
  });

  test("strategy output guard remains fail-before-submit", () => {
    const body = section(
      "async function executeRoutedSwap",
      'if (args.quote.venue === "jupiter")',
    );
    const guard = body.indexOf("protectedOutput < args.minAcceptableOutputRaw");
    const submit = body.indexOf("args.slrd.submitPlan(");
    expect(guard).toBeGreaterThan(0);
    expect(submit).toBeGreaterThan(guard);
  });

  test("pre-execution log is no longer mislabeled submission", () => {
    expect(source).not.toContain('note("trade.submission.begin"');
    expect(source).toContain('note("trade.execution.prepare"');
  });

  test("actual ambiguous fail-stop path remains for sender/transport uncertainty", () => {
    expect(source).toContain("markSubmissionAmbiguous(");
    expect(source).toContain("cycle.fail-stop.execution-ambiguous");
  });
});
