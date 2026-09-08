import { describe, expect, test } from "bun:test";
import {
  planValueBandDecision,
  valueBandThresholds,
  type ValueBandPolicy,
} from "./value-band.ts";

const policy: ValueBandPolicy = {
  version: 1,
  kind: "value-band",
  baseSol: 0.1,
  maxCapitalDeployedSol: 0.2,
};

describe("value-band strategy", () => {
  test("defaults to 0.05 / 0.10 / 0.18", () => {
    expect(valueBandThresholds(policy)).toEqual({
      baseSol: 0.1,
      lowerSol: 0.05,
      upperSol: 0.18,
    });
  });

  test("sells at upper edge", () => {
    expect(
      planValueBandDecision({ policy, liquidationValueSol: 0.18 }).action,
    ).toBe("sell");
  });

  test("lower edge fires once until rearmed", () => {
    expect(
      planValueBandDecision({
        policy,
        liquidationValueSol: 0.049,
        state: { lowerArmed: true },
      }).action,
    ).toBe("buy");
    expect(
      planValueBandDecision({
        policy,
        liquidationValueSol: 0.04,
        state: { lowerArmed: false },
      }).action,
    ).toBe("hold");
    const recovered = planValueBandDecision({
      policy,
      liquidationValueSol: 0.051,
      state: { lowerArmed: false },
    });
    expect(recovered.rearmLower).toBe(true);
    expect(recovered.lowerArmed).toBe(true);
  });

  test("hard net-capital budget blocks averaging down", () => {
    const decision = planValueBandDecision({
      policy,
      liquidationValueSol: 0.02,
      state: {
        lowerArmed: true,
        cumulativeBuySol: 0.3,
        cumulativeSellSol: 0.1,
      },
    });
    expect(decision.action).toBe("hold");
    expect(decision.reason).toContain("budget exhausted");
  });
});
