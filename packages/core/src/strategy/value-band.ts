export type ValueBandBuyMode = "same-value" | "same-tokens" | "to-base";
export type ValueBandLowerSide = "above" | "below";

export type ValueBandPolicy = {
  version: 1;
  kind: "value-band";
  name?: string;
  baseSol: number;
  lowerMultiple?: number;
  upperMultiple?: number;
  sellFraction?: number;
  buyMode?: ValueBandBuyMode;
  minTradeSol?: number;
  /** Hard ceiling on net SOL principal currently deployed by this strategy. */
  maxCapitalDeployedSol?: number;
};

export type ValueBandRuntimeState = {
  lowerArmed: boolean;
  /** Side of the lower boundary after the previous observed/control-cycle state. */
  lowerSide?: ValueBandLowerSide | null;
  cumulativeBuySol: number;
  cumulativeSellSol: number;
  peakNetCapitalDeployedSol?: number;
};

export type ValueBandDecision = {
  action: "buy" | "sell" | "hold";
  reason: string;
  liquidationValueSol: number;
  baseSol: number;
  lowerSol: number;
  upperSol: number;
  sellFraction: number;
  buyMode: ValueBandBuyMode;
  lowerArmed: boolean;
  rearmLower: boolean;
  lowerCrossed: boolean;
  lowerSide: ValueBandLowerSide;
  currentNetCapitalDeployedSol: number;
  remainingBuyBudgetSol: number;
};

function positive(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`${label} must be > 0`);
  return parsed;
}

function nonNegative(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`${label} must be >= 0`);
  return parsed;
}

export function normalizeValueBandPolicy(
  input: ValueBandPolicy,
): Required<Omit<ValueBandPolicy, "name">> & { name?: string } {
  if (!input || input.kind !== "value-band")
    throw new Error('Strategy kind must be "value-band"');
  const baseSol = positive(input.baseSol, "baseSol");
  const lowerMultiple = positive(input.lowerMultiple ?? 0.5, "lowerMultiple");
  const upperMultiple = positive(input.upperMultiple ?? 1.8, "upperMultiple");
  if (lowerMultiple >= 1) throw new Error("lowerMultiple must be < 1");
  if (upperMultiple <= 1) throw new Error("upperMultiple must be > 1");
  const sellFraction = positive(input.sellFraction ?? 0.5, "sellFraction");
  if (sellFraction >= 1) throw new Error("sellFraction must be < 1");
  const buyMode = input.buyMode ?? "same-value";
  if (
    buyMode !== "same-value" &&
    buyMode !== "same-tokens" &&
    buyMode !== "to-base"
  ) {
    throw new Error("buyMode must be same-value, same-tokens, or to-base");
  }
  const minTradeSol = nonNegative(input.minTradeSol ?? 0.001, "minTradeSol");
  const maxCapitalDeployedSol = positive(
    input.maxCapitalDeployedSol ?? baseSol * 5,
    "maxCapitalDeployedSol",
  );
  return {
    version: 1,
    kind: "value-band",
    ...(input.name ? { name: input.name } : {}),
    baseSol,
    lowerMultiple,
    upperMultiple,
    sellFraction,
    buyMode,
    minTradeSol,
    maxCapitalDeployedSol,
  };
}

export function valueBandThresholds(input: ValueBandPolicy): {
  baseSol: number;
  lowerSol: number;
  upperSol: number;
} {
  const policy = normalizeValueBandPolicy(input);
  return {
    baseSol: policy.baseSol,
    lowerSol: policy.baseSol * policy.lowerMultiple,
    upperSol: policy.baseSol * policy.upperMultiple,
  };
}

export function planValueBandDecision(args: {
  policy: ValueBandPolicy;
  liquidationValueSol: number;
  state?: Partial<ValueBandRuntimeState>;
}): ValueBandDecision {
  const policy = normalizeValueBandPolicy(args.policy);
  const liquidationValueSol = nonNegative(
    args.liquidationValueSol,
    "liquidationValueSol",
  );
  const lowerSol = policy.baseSol * policy.lowerMultiple;
  const upperSol = policy.baseSol * policy.upperMultiple;
  const lowerArmed = args.state?.lowerArmed !== false;
  const previousLowerSide = args.state?.lowerSide ?? null;
  const cumulativeBuySol = nonNegative(
    args.state?.cumulativeBuySol ?? 0,
    "cumulativeBuySol",
  );
  const cumulativeSellSol = nonNegative(
    args.state?.cumulativeSellSol ?? 0,
    "cumulativeSellSol",
  );
  const currentNetCapitalDeployedSol = Math.max(
    0,
    cumulativeBuySol - cumulativeSellSol,
  );
  const remainingBuyBudgetSol = Math.max(
    0,
    policy.maxCapitalDeployedSol - currentNetCapitalDeployedSol,
  );
  const epsilon = Math.max(1e-12, policy.baseSol * 1e-9);

  // The lower edge is a transition, not a level.  Treat the exact boundary as
  // below so rearming requires a real recovery *above* it.  This prevents our
  // own upper-band sale (which reduces position value) from manufacturing the
  // next lower-band buy.
  const lowerSide: ValueBandLowerSide =
    liquidationValueSol > lowerSol + epsilon ? "above" : "below";
  const rearmLower = !lowerArmed && lowerSide === "above";
  const effectiveArmed = lowerArmed || rearmLower;
  const lowerCrossed =
    effectiveArmed && previousLowerSide === "above" && lowerSide === "below";

  // Preserve automatic zero-inventory bootstrap for a brand-new controller.
  // A migrated/previously-used strategy with no edge observation does not buy
  // merely because it happened to restart below the lower boundary.
  const freshZeroBootstrap =
    previousLowerSide == null &&
    cumulativeBuySol === 0 &&
    cumulativeSellSol === 0 &&
    liquidationValueSol <= epsilon;

  const base = {
    liquidationValueSol,
    baseSol: policy.baseSol,
    lowerSol,
    upperSol,
    sellFraction: policy.sellFraction,
    buyMode: policy.buyMode,
    lowerArmed: effectiveArmed,
    rearmLower,
    lowerCrossed,
    lowerSide,
    currentNetCapitalDeployedSol,
    remainingBuyBudgetSol,
  };

  if (liquidationValueSol + epsilon >= upperSol) {
    return {
      ...base,
      action: "sell",
      reason: `liquidation value ${liquidationValueSol.toFixed(6)} >= upper ${upperSol.toFixed(6)}`,
    };
  }

  if (lowerSide === "below") {
    if (!effectiveArmed) {
      return {
        ...base,
        action: "hold",
        reason:
          "lower edge disarmed; waiting for market value to recover above lower threshold",
      };
    }
    if (remainingBuyBudgetSol < policy.minTradeSol) {
      return {
        ...base,
        action: "hold",
        reason: "net capital deployment budget exhausted",
      };
    }
    if (freshZeroBootstrap) {
      return { ...base, action: "buy", reason: "zero-position bootstrap" };
    }
    if (lowerCrossed) {
      return {
        ...base,
        action: "buy",
        reason: `market crossed lower edge: > ${lowerSol.toFixed(6)} to ${liquidationValueSol.toFixed(6)} SOL`,
      };
    }
    return {
      ...base,
      action: "hold",
      reason:
        previousLowerSide == null
          ? "below lower threshold but no prior above-edge observation; waiting for a real recovery/crossing"
          : "below lower threshold without a new downward market crossing",
    };
  }

  return {
    ...base,
    action: "hold",
    reason: rearmLower
      ? "lower edge rearmed above threshold"
      : "inside value band",
  };
}
