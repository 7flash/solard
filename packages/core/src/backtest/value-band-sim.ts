import {
  normalizeValueBandPolicy,
  planValueBandDecision,
  type ValueBandPolicy,
  type ValueBandRuntimeState,
} from "../strategy/value-band.ts";

export type ValueBandTapeEvent = {
  atMs: number;
  priceSol: number;
  id?: string;
};
export type ValueBandBacktestExecution = {
  atMs: number;
  side: "buy" | "sell";
  priceSol: number;
  sol: number;
  tokens: number;
  liquidationBeforeSol: number;
  capitalDeployedAfterSol: number;
};
export type ValueBandBacktestResult = {
  policy: ReturnType<typeof normalizeValueBandPolicy>;
  summary: {
    startingSol: number;
    endingSol: number;
    endingTokens: number;
    finalEquitySol: number;
    netPnlSol: number;
    returnPct: number;
    maxDrawdownPct: number;
    buys: number;
    sells: number;
    cumulativeBuySol: number;
    cumulativeSellSol: number;
    peakNetCapitalDeployedSol: number;
    maxCapitalDeployedSol: number;
  };
  executions: ValueBandBacktestExecution[];
};

function finitePositive(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be > 0`);
  return n;
}

export function simulateValueBandStrategy(
  inputTape: readonly ValueBandTapeEvent[],
  inputPolicy: ValueBandPolicy,
  options: {
    startingSol?: number;
    initialBuy?: boolean;
    executionBps?: number;
    networkFeeSol?: number;
  } = {},
): ValueBandBacktestResult {
  const policy = normalizeValueBandPolicy(inputPolicy);
  const startingSol = finitePositive(
    options.startingSol ??
      Math.max(policy.maxCapitalDeployedSol, policy.baseSol),
    "startingSol",
  );
  const degradation = Math.max(0, Number(options.executionBps ?? 0)) / 10_000;
  const networkFee = Math.max(0, Number(options.networkFeeSol ?? 0));
  const tape = [...inputTape]
    .filter(
      (e) =>
        Number.isFinite(e.atMs) &&
        Number.isFinite(e.priceSol) &&
        e.priceSol > 0,
    )
    .sort((a, b) => a.atMs - b.atMs);
  if (!tape.length)
    throw new Error("value-band backtest requires price events");

  let sol = startingSol;
  let tokens = 0;
  let cumulativeBuySol = 0;
  let cumulativeSellSol = 0;
  let peakNet = 0;
  let peakEquity = startingSol;
  let maxDrawdownPct = 0;
  let state: ValueBandRuntimeState = {
    lowerArmed: true,
    cumulativeBuySol: 0,
    cumulativeSellSol: 0,
    peakNetCapitalDeployedSol: 0,
  };
  const executions: ValueBandBacktestExecution[] = [];

  const buy = (
    event: ValueBandTapeEvent,
    requestedSol: number,
    liquidationBeforeSol: number,
  ) => {
    const budget = Math.max(
      0,
      policy.maxCapitalDeployedSol -
        Math.max(0, cumulativeBuySol - cumulativeSellSol),
    );
    const spend = Math.min(requestedSol, budget, Math.max(0, sol - networkFee));
    if (spend < policy.minTradeSol) return false;
    const acquired = (spend * (1 - degradation)) / event.priceSol;
    if (!(acquired > 0)) return false;
    sol -= spend + networkFee;
    tokens += acquired;
    cumulativeBuySol += spend + networkFee;
    peakNet = Math.max(peakNet, cumulativeBuySol - cumulativeSellSol);
    executions.push({
      atMs: event.atMs,
      side: "buy",
      priceSol: event.priceSol,
      sol: spend,
      tokens: acquired,
      liquidationBeforeSol,
      capitalDeployedAfterSol: Math.max(
        0,
        cumulativeBuySol - cumulativeSellSol,
      ),
    });
    return true;
  };
  const sell = (
    event: ValueBandTapeEvent,
    fraction: number,
    liquidationBeforeSol: number,
  ) => {
    const sold = tokens * fraction;
    if (!(sold > 0)) return false;
    const proceeds = sold * event.priceSol * (1 - degradation);
    if (proceeds < policy.minTradeSol) return false;
    tokens -= sold;
    const received = Math.max(0, proceeds - networkFee);
    sol += received;
    cumulativeSellSol += received;
    executions.push({
      atMs: event.atMs,
      side: "sell",
      priceSol: event.priceSol,
      sol: received,
      tokens: sold,
      liquidationBeforeSol,
      capitalDeployedAfterSol: Math.max(
        0,
        cumulativeBuySol - cumulativeSellSol,
      ),
    });
    return true;
  };

  if (options.initialBuy !== false) buy(tape[0]!, policy.baseSol, 0);

  for (const event of tape) {
    const liquidation = tokens * event.priceSol * (1 - degradation);
    state = {
      lowerArmed: state.lowerArmed,
      cumulativeBuySol,
      cumulativeSellSol,
      peakNetCapitalDeployedSol: peakNet,
    };
    const decision = planValueBandDecision({
      policy,
      state,
      liquidationValueSol: liquidation,
    });
    state.lowerArmed = decision.lowerArmed;
    if (decision.action === "sell") {
      sell(event, policy.sellFraction, liquidation);
    } else if (decision.action === "buy") {
      let requested = liquidation;
      if (policy.buyMode === "to-base")
        requested = Math.max(0, policy.baseSol - liquidation);
      else if (policy.buyMode === "same-tokens")
        requested = tokens * event.priceSol;
      if (buy(event, requested, liquidation)) state.lowerArmed = false;
    }
    const equity = sol + tokens * event.priceSol * (1 - degradation);
    peakEquity = Math.max(peakEquity, equity);
    if (peakEquity > 0)
      maxDrawdownPct = Math.min(
        maxDrawdownPct,
        ((equity - peakEquity) / peakEquity) * 100,
      );
  }

  const last = tape.at(-1)!;
  const finalEquitySol = sol + tokens * last.priceSol * (1 - degradation);
  return {
    policy,
    summary: {
      startingSol,
      endingSol: sol,
      endingTokens: tokens,
      finalEquitySol,
      netPnlSol: finalEquitySol - startingSol,
      returnPct: (finalEquitySol / startingSol - 1) * 100,
      maxDrawdownPct,
      buys: executions.filter((e) => e.side === "buy").length,
      sells: executions.filter((e) => e.side === "sell").length,
      cumulativeBuySol,
      cumulativeSellSol,
      peakNetCapitalDeployedSol: peakNet,
      maxCapitalDeployedSol: policy.maxCapitalDeployedSol,
    },
    executions,
  };
}
