export type ValueBandBuyMode = "same-value" | "same-tokens" | "to-base";

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
  const rearmLower = !lowerArmed && liquidationValueSol >= lowerSol;
  const effectiveArmed = lowerArmed || rearmLower;
  const base = {
    liquidationValueSol,
    baseSol: policy.baseSol,
    lowerSol,
    upperSol,
    sellFraction: policy.sellFraction,
    buyMode: policy.buyMode,
    lowerArmed: effectiveArmed,
    rearmLower,
    currentNetCapitalDeployedSol,
    remainingBuyBudgetSol,
  };

  const epsilon = Math.max(1e-12, policy.baseSol * 1e-9);

  if (liquidationValueSol + epsilon >= upperSol) {
    return {
      ...base,
      action: "sell",
      reason: `liquidation value ${liquidationValueSol.toFixed(6)} >= upper ${upperSol.toFixed(6)}`,
    };
  }
  if (liquidationValueSol <= lowerSol + epsilon) {
    if (!effectiveArmed)
      return {
        ...base,
        action: "hold",
        reason:
          "lower edge already consumed; waiting for value to recover above lower threshold before rearming",
      };
    if (remainingBuyBudgetSol < policy.minTradeSol)
      return {
        ...base,
        action: "hold",
        reason: "net capital deployment budget exhausted",
      };
    return {
      ...base,
      action: "buy",
      reason: `liquidation value ${liquidationValueSol.toFixed(6)} <= lower ${lowerSol.toFixed(6)}`,
    };
  }
  return { ...base, action: "hold", reason: "inside value band" };
}
