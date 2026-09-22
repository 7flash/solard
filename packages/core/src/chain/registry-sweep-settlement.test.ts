import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "registry-sweep.ts"), "utf8");

describe("registry SOL sweep settlement contract", () => {
  test("does not use sendPlan as proof of sweep success", () => {
    const execute = source.slice(
      source.indexOf("export async function executeRegistrySolSweep"),
    );
    expect(execute).not.toContain("await slrd.sendPlan(");
    expect(execute).toContain("await slrd.submitPlan(");
    expect(execute).toContain("waitForSweepSubmissionToSettle");
  });

  test("requires confirmation plus post-state convergence before success", () => {
    expect(source).toContain('receipt.status === "confirmed"');
    expect(source).toContain("remainingLamports <= plannedRow.keepLamports");
    expect(source).toContain("lastValidBlockHeight");
  });

  test("re-enforces the balance ceiling at execution time", () => {
    expect(source).toContain("freshBalance >= maxBalanceLamports");
    expect(source).toContain("refusing stale planned sweep");
  });
});
