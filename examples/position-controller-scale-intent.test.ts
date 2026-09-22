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

describe("scale-now settlement intent", () => {
  test("does not consume scale-now before buy settlement", () => {
    const cycle = section(
      "if (scaleNow) {",
      "if (journal.pendingSettlement) {",
    );
    expect(cycle).not.toContain("scaleNow = false;\n              if");
    expect(cycle).toContain("if (!journal.pendingSettlement)");
    expect(cycle).toContain("scale.armed");
  });

  test("dropped/expired submission can retry while scale-now stays armed", () => {
    const cycle = section(
      "if (scaleNow) {",
      "if (journal.pendingSettlement) {",
    );
    expect(cycle).toContain(
      "scale-to-base intent remains armed while buy settlement is unresolved",
    );
    expect(cycle).toContain(
      "scale-to-base intent remains armed; no confirmed fill yet",
    );
  });

  test("scale-now ends only when base reached or executable budget is exhausted", () => {
    const cycle = section(
      "if (scaleNow) {",
      "if (journal.pendingSettlement) {",
    );
    expect(cycle).toContain("latest.liquidationSol >= p.baseSol");
    expect(cycle).toContain("await availableBuyBudget(p, latest)");
    expect(cycle).toContain("executableBudgetSol < p.minTradeSol");
    expect(cycle).toContain("scale.complete");
    expect(cycle).toContain("scale.hold");
  });

  test("net-capital risk accounting is preserved", () => {
    const body = section("function netCapital", "function recordBuy");
    expect(body).toContain(
      "journal.cumulativeBuySol - journal.cumulativeSellSol",
    );
    expect(source).not.toContain("cumulativeCapitalReleasedSol");
  });

  test("expiry recovery remains present", () => {
    expect(source).toContain("settlement.expired-unseen");
    expect(source).toContain(
      "currentBlockHeight > pending.lastValidBlockHeight",
    );
  });

  test("native preflight retry fix remains present", () => {
    expect(source).toContain("isRpcPreflightSimulationRejection");
    expect(source).toContain("const maxNativeAttempts = 2");
  });
});
