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
    throw new Error(`missing ${startNeedle}..${endNeedle}`);
  }
  return source.slice(start, end);
}

describe("Raydium pre-submission failure classification", () => {
  test("explicit Raydium swap simulation failure is pre-submission", () => {
    expect(source).toContain("function isRaydiumPreSubmissionFailure");
    expect(source).toContain(
      "/^Raydium\\\\s+swap\\\\s+simulation\\\\s+failed:/i",
    );
  });

  test("RPC preflight simulation rejection is also pre-submission", () => {
    const classifier = section(
      "function isRaydiumPreSubmissionFailure",
      "function markSubmissionAmbiguous",
    );
    expect(classifier).toContain("isRpcPreflightSimulationRejection(error)");
  });

  test("Raydium execute catch checks pre-submission before ambiguity", () => {
    const body = section(
      "const prepared = await args.raydium.buildSwapExactIn({",
      'return {\n    venue: "raydium"',
    );
    const pre = body.indexOf("isRaydiumPreSubmissionFailure(error)");
    const ambiguous = body.indexOf('markSubmissionAmbiguous(error, "raydium")');
    expect(pre).toBeGreaterThan(0);
    expect(ambiguous).toBeGreaterThan(pre);
  });

  test("Raydium simulation remains enabled", () => {
    const body = section(
      "const prepared = await args.raydium.buildSwapExactIn({",
      'return {\n    venue: "raydium"',
    );
    expect(body).toContain("simulate: true");
  });

  test("ordinary loop retry path remains intact", () => {
    expect(source).toContain('note("cycle.retry"');
    expect(source).toContain("if (isSubmissionAmbiguous(error))");
  });

  test("scale-now settlement-aware retry remains intact", () => {
    expect(source).toContain("scale.armed");
    expect(source).toContain(
      "scale-to-base intent remains armed while buy settlement is unresolved",
    );
  });
});
