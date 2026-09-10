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

  test("fresh zero position still bootstraps", () => {
    const decision = planValueBandDecision({
      policy,
      liquidationValueSol: 0,
      state: {
        lowerArmed: true,
        lowerSide: null,
        cumulativeBuySol: 0,
        cumulativeSellSol: 0,
      },
    });
    expect(decision.action).toBe("buy");
    expect(decision.reason).toContain("bootstrap");
  });

  test("lower buy requires a real above-to-below crossing", () => {
    const crossed = planValueBandDecision({
      policy,
      liquidationValueSol: 0.049,
      state: { lowerArmed: true, lowerSide: "above" },
    });
    expect(crossed.action).toBe("buy");
    expect(crossed.lowerCrossed).toBe(true);

    const alreadyBelow = planValueBandDecision({
      policy,
      liquidationValueSol: 0.04,
      state: { lowerArmed: true, lowerSide: "below" },
    });
    expect(alreadyBelow.action).toBe("hold");
    expect(alreadyBelow.lowerCrossed).toBe(false);
  });

  test("sell-caused low state cannot buy until market recovers and crosses again", () => {
    const afterSell = planValueBandDecision({
      policy,
      liquidationValueSol: 0.039,
      state: {
        lowerArmed: false,
        lowerSide: "above",
        cumulativeBuySol: 0.1,
        cumulativeSellSol: 0.09,
      },
    });
    expect(afterSell.action).toBe("hold");
    expect(afterSell.rearmLower).toBe(false);

    const recovered = planValueBandDecision({
      policy,
      liquidationValueSol: 0.051,
      state: {
        lowerArmed: false,
        lowerSide: "below",
        cumulativeBuySol: 0.1,
        cumulativeSellSol: 0.09,
      },
    });
    expect(recovered.action).toBe("hold");
    expect(recovered.rearmLower).toBe(true);
    expect(recovered.lowerArmed).toBe(true);

    const crossedAgain = planValueBandDecision({
      policy,
      liquidationValueSol: 0.049,
      state: {
        lowerArmed: true,
        lowerSide: "above",
        cumulativeBuySol: 0.1,
        cumulativeSellSol: 0.09,
      },
    });
    expect(crossedAgain.action).toBe("buy");
  });

  test("restart below lower with used capital does not invent a crossing", () => {
    const decision = planValueBandDecision({
      policy,
      liquidationValueSol: 0.04,
      state: {
        lowerArmed: true,
        lowerSide: null,
        cumulativeBuySol: 0.1,
        cumulativeSellSol: 0,
      },
    });
    expect(decision.action).toBe("hold");
    expect(decision.reason).toContain("no prior above-edge observation");
  });

  test("hard net-capital budget blocks averaging down", () => {
    const decision = planValueBandDecision({
      policy,
      liquidationValueSol: 0.02,
      state: {
        lowerArmed: true,
        lowerSide: "above",
        cumulativeBuySol: 0.3,
        cumulativeSellSol: 0.1,
      },
    });
    expect(decision.action).toBe("hold");
    expect(decision.reason).toContain("budget exhausted");
  });
});
