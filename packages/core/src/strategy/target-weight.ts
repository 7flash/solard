export type TargetWeightGapMode = "fixed" | "previous-5m-vol";

export type TargetWeightGapPolicy = {
  mode: TargetWeightGapMode;
  /** Outer no-trade band in percentage points of portfolio weight. */
  outerPct: number;
  /** Hysteresis destination band in percentage points. */
  innerPct: number;
  /** Used by previous-5m-vol: outerPct = clamp(multiplier * candleRangePct, minPct, maxPct). */
  volatilityMultiplier?: number;
  minPct?: number;
  maxPct?: number;
};

export type TargetWeightPolicy = {
  version: 1;
  kind: "target-weight";
  name?: string;
  /** Desired mark-to-market token share of X+SOL NAV, as 0..100. */
  targetWeightPct: number;
  gap: TargetWeightGapPolicy;
  /** Ignore smaller rebalances. Expressed in SOL mark value. */
  minTradeSol?: number;
  execution?: {
    slippageBps?: number;
    venueFeeBps?: number;
    networkFeeSol?: number;
    latencyMs?: number;
  };
};

export type TargetWeightCandle = {
  startMs?: number;
  endMs?: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type TargetWeightRebalancePlan = {
  action: "buy" | "sell" | "hold";
  reason: string;
  targetWeightPct: number;
  currentWeightPct: number;
  desiredWeightPct: number;
  outerGapPct: number;
  innerGapPct: number;
  lowerTriggerWeightPct: number;
  upperTriggerWeightPct: number;
  navSol: number;
  tokenValueSol: number;
  solValueSol: number;
  /** Buy-side SOL principal before fixed network fee. */
  buySol: number;
  /** Sell-side token amount. */
  sellTokens: number;
  /** Sell amount as bps of current token inventory. */
  sellBps: number;
  tradeMarkValueSol: number;
  degradationBps: number;
  networkFeeSol: number;
  previousCandleRangePct: number | null;
};

function finite(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be finite`);
  return parsed;
}

function nonNegative(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (parsed < 0) throw new Error(`${label} must be >= 0`);
  return parsed;
}

function positive(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (parsed <= 0) throw new Error(`${label} must be > 0`);
  return parsed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeTargetWeightPolicy(
  input: TargetWeightPolicy,
): TargetWeightPolicy {
  if (!input || input.kind !== "target-weight") {
    throw new Error('Strategy kind must be "target-weight"');
  }
  const targetWeightPct = positive(input.targetWeightPct, "targetWeightPct");
  if (targetWeightPct >= 100) throw new Error("targetWeightPct must be < 100");
  const mode = input.gap?.mode ?? "fixed";
  if (mode !== "fixed" && mode !== "previous-5m-vol") {
    throw new Error('gap.mode must be "fixed" or "previous-5m-vol"');
  }
  const outerPct = positive(input.gap?.outerPct, "gap.outerPct");
  const innerPct = nonNegative(input.gap?.innerPct ?? 0, "gap.innerPct");
  if (innerPct >= outerPct && mode === "fixed") {
    throw new Error("gap.innerPct must be smaller than gap.outerPct");
  }
  const volatilityMultiplier = positive(
    input.gap?.volatilityMultiplier ?? 2,
    "gap.volatilityMultiplier",
  );
  const minPct = positive(input.gap?.minPct ?? outerPct, "gap.minPct");
  const maxPct = positive(
    input.gap?.maxPct ?? Math.max(outerPct, minPct),
    "gap.maxPct",
  );
  if (maxPct < minPct) throw new Error("gap.maxPct must be >= gap.minPct");
  const slippageBps = nonNegative(
    input.execution?.slippageBps ?? 0,
    "execution.slippageBps",
  );
  const venueFeeBps = nonNegative(
    input.execution?.venueFeeBps ?? 0,
    "execution.venueFeeBps",
  );
  if (slippageBps + venueFeeBps >= 10_000) {
    throw new Error("slippageBps + venueFeeBps must be < 10000");
  }
  return {
    version: 1,
    kind: "target-weight",
    ...(input.name ? { name: String(input.name) } : {}),
    targetWeightPct,
    gap: {
      mode,
      outerPct,
      innerPct,
      volatilityMultiplier,
      minPct,
      maxPct,
    },
    minTradeSol: nonNegative(input.minTradeSol ?? 0, "minTradeSol"),
    execution: {
      slippageBps,
      venueFeeBps,
      networkFeeSol: nonNegative(
        input.execution?.networkFeeSol ?? 0,
        "execution.networkFeeSol",
      ),
      latencyMs: nonNegative(
        input.execution?.latencyMs ?? 0,
        "execution.latencyMs",
      ),
    },
  };
}

export function targetWeightGapPct(
  policyInput: TargetWeightPolicy,
  candle?: TargetWeightCandle | null,
): { outerPct: number; innerPct: number; candleRangePct: number | null } {
  const policy = normalizeTargetWeightPolicy(policyInput);
  if (policy.gap.mode === "fixed") {
    return {
      outerPct: policy.gap.outerPct,
      innerPct: policy.gap.innerPct,
      candleRangePct:
        candle && candle.close > 0
          ? ((candle.high - candle.low) / candle.close) * 100
          : null,
    };
  }
  if (!candle || !(candle.close > 0) || !(candle.high >= candle.low)) {
    throw new Error("previous-5m-vol gap requires a completed previous candle");
  }
  const candleRangePct = ((candle.high - candle.low) / candle.close) * 100;
  const outerPct = clamp(
    candleRangePct * (policy.gap.volatilityMultiplier ?? 2),
    policy.gap.minPct ?? policy.gap.outerPct,
    policy.gap.maxPct ?? policy.gap.outerPct,
  );
  // Guarantee real hysteresis even when the adaptive outer band contracts below
  // a configured inner band.
  const innerPct = Math.min(policy.gap.innerPct, outerPct * 0.5);
  return { outerPct, innerPct, candleRangePct };
}

export function planTargetWeightRebalance(args: {
  policy: TargetWeightPolicy;
  tokenAmount: number;
  solAmount: number;
  priceSol: number;
  previousCandle?: TargetWeightCandle | null;
}): TargetWeightRebalancePlan {
  const policy = normalizeTargetWeightPolicy(args.policy);
  const tokenAmount = nonNegative(args.tokenAmount, "tokenAmount");
  const solAmount = nonNegative(args.solAmount, "solAmount");
  const priceSol = positive(args.priceSol, "priceSol");
  const tokenValueSol = tokenAmount * priceSol;
  const navSol = tokenValueSol + solAmount;
  if (!(navSol > 0)) throw new Error("portfolio NAV must be > 0");

  const currentWeight = tokenValueSol / navSol;
  const targetWeight = policy.targetWeightPct / 100;
  const gap = targetWeightGapPct(policy, args.previousCandle);
  const outer = gap.outerPct / 100;
  const inner = gap.innerPct / 100;
  const lowerTrigger = Math.max(0, targetWeight - outer);
  const upperTrigger = Math.min(1, targetWeight + outer);
  const degradationBps =
    (policy.execution?.slippageBps ?? 0) + (policy.execution?.venueFeeBps ?? 0);
  const degradation = degradationBps / 10_000;
  const networkFeeSol = policy.execution?.networkFeeSol ?? 0;
  const minTradeSol = policy.minTradeSol ?? 0;

  const base = {
    targetWeightPct: targetWeight * 100,
    currentWeightPct: currentWeight * 100,
    outerGapPct: gap.outerPct,
    innerGapPct: gap.innerPct,
    lowerTriggerWeightPct: lowerTrigger * 100,
    upperTriggerWeightPct: upperTrigger * 100,
    navSol,
    tokenValueSol,
    solValueSol: solAmount,
    degradationBps,
    networkFeeSol,
    previousCandleRangePct: gap.candleRangePct,
  };

  if (currentWeight < lowerTrigger) {
    const desiredWeight = Math.max(0, targetWeight - inner);
    // Exact buy principal solving mark-to-market post-cost weight:
    // (X + a/(1+d)) / (N - a*d/(1+d) - fee) = desiredWeight.
    const numerator =
      (1 + degradation) *
      (desiredWeight * (navSol - networkFeeSol) - tokenValueSol);
    const denominator = 1 + desiredWeight * degradation;
    let buySol = Math.max(0, numerator / denominator);
    buySol = Math.min(buySol, Math.max(0, solAmount - networkFeeSol));
    const markValue = buySol / (1 + degradation);
    if (!(buySol > 0) || markValue < minTradeSol) {
      return {
        action: "hold",
        reason:
          buySol <= 0
            ? "insufficient SOL after network reserve"
            : "rebalance below minimum trade size",
        desiredWeightPct: desiredWeight * 100,
        buySol: 0,
        sellTokens: 0,
        sellBps: 0,
        tradeMarkValueSol: markValue,
        ...base,
      };
    }
    return {
      action: "buy",
      reason: "token weight below outer band",
      desiredWeightPct: desiredWeight * 100,
      buySol,
      sellTokens: 0,
      sellBps: 0,
      tradeMarkValueSol: markValue,
      ...base,
    };
  }

  if (currentWeight > upperTrigger) {
    const desiredWeight = Math.min(1, targetWeight + inner);
    // Exact sell mark value solving post-cost weight:
    // (X-z) / (N-z*d-fee) = desiredWeight.
    const denominator = 1 - desiredWeight * degradation;
    let sellMarkValueSol = Math.max(
      0,
      (tokenValueSol - desiredWeight * (navSol - networkFeeSol)) / denominator,
    );
    sellMarkValueSol = Math.min(sellMarkValueSol, tokenValueSol);
    const sellTokens = sellMarkValueSol / priceSol;
    const sellBps =
      tokenAmount > 0
        ? Math.max(
            1,
            Math.min(10_000, Math.ceil((sellTokens / tokenAmount) * 10_000)),
          )
        : 0;
    if (!(sellTokens > 0) || sellMarkValueSol < minTradeSol) {
      return {
        action: "hold",
        reason:
          sellTokens <= 0
            ? "no token inventory available"
            : "rebalance below minimum trade size",
        desiredWeightPct: desiredWeight * 100,
        buySol: 0,
        sellTokens: 0,
        sellBps: 0,
        tradeMarkValueSol: sellMarkValueSol,
        ...base,
      };
    }
    return {
      action: "sell",
      reason: "token weight above outer band",
      desiredWeightPct: desiredWeight * 100,
      buySol: 0,
      sellTokens,
      sellBps,
      tradeMarkValueSol: sellMarkValueSol,
      ...base,
    };
  }

  return {
    action: "hold",
    reason: "token weight inside outer band",
    desiredWeightPct: targetWeight * 100,
    buySol: 0,
    sellTokens: 0,
    sellBps: 0,
    tradeMarkValueSol: 0,
    ...base,
  };
}
