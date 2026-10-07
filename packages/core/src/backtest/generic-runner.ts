import type { BacktestTapeEvent } from "./strategy-sim.ts";

export type HistoricalStrategySignal = { side: "buy"; sol: number } | { side: "sell"; bps: number } | null;
export type HistoricalPortfolio = { cashSol: number; tokens: number; equitySol: number };
export type HistoricalStrategy = (context: { event: Readonly<BacktestTapeEvent>; index: number; portfolio: Readonly<HistoricalPortfolio>; pending: boolean }) => HistoricalStrategySignal;
export type HistoricalExecutionOptions = {
  startingSol: number;
  latencyMs?: number;
  slippageBps?: number;
  venueFeeBps?: number;
  networkFeeSol?: number;
  tipSol?: number;
};
export type HistoricalFill = {
  side: "buy" | "sell"; triggerEventId: string; fillEventId: string | null; triggerAtMs: number; fillAtMs: number | null;
  status: "filled" | "rejected" | "unfilled"; reason: string | null; observedPriceSol: number | null; fillPriceSol: number | null;
  quantity: number; principalSol: number; venueFeeSol: number; networkFeeSol: number; tipSol: number;
};
export type HistoricalStrategyResult = {
  fills: HistoricalFill[];
  capitalCurve: Array<HistoricalPortfolio & { atMs: number; eventId: string }>;
  summary: HistoricalPortfolio & { startingSol: number; netPnlSol: number; returnPct: number; maxDrawdownPct: number; networkFeeSol: number; tipSol: number; venueFeeSol: number };
};

/** Deterministic replay. Every fill uses an observed event strictly after its trigger. */
export function runHistoricalStrategy(tape: readonly BacktestTapeEvent[], strategy: HistoricalStrategy, options: HistoricalExecutionOptions): HistoricalStrategyResult {
  const values = { latencyMs: options.latencyMs ?? 0, slippageBps: options.slippageBps ?? 0, venueFeeBps: options.venueFeeBps ?? 0, networkFeeSol: options.networkFeeSol ?? 0, tipSol: options.tipSol ?? 0 };
  if (!Number.isFinite(options.startingSol) || options.startingSol <= 0) throw new Error("startingSol must be positive");
  for (const [name, value] of Object.entries(values)) if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and nonnegative`);
  if (values.slippageBps >= 10000 || values.venueFeeBps >= 10000) throw new Error("Execution bps must be less than 10000");
  const events = [...tape].filter((event) => event.confidence !== "dropped" && Number.isFinite(event.priceSol) && event.priceSol > 0 && Number.isFinite(event.tradedAtMs)).sort((a, b) => a.tradedAtMs - b.tradedAtMs || a.slot - b.slot);
  let cashSol = options.startingSol; let tokens = 0; let peak = cashSol; let maxDrawdownPct = 0;
  let networkFeeSol = 0; let tipSol = 0; let venueFeeSol = 0;
  const fills: HistoricalFill[] = []; const capitalCurve: HistoricalStrategyResult["capitalCurve"] = [];
  let pending: { signal: NonNullable<HistoricalStrategySignal>; event: BacktestTapeEvent; index: number } | null = null;
  const record = (event: BacktestTapeEvent, current: NonNullable<typeof pending>): HistoricalFill => ({ side: current.signal.side, triggerEventId: current.event.id, fillEventId: event.id, triggerAtMs: current.event.tradedAtMs, fillAtMs: event.tradedAtMs, status: "rejected", reason: null, observedPriceSol: event.priceSol, fillPriceSol: null, quantity: 0, principalSol: 0, venueFeeSol: 0, networkFeeSol: 0, tipSol: 0 });
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (pending && index > pending.index && event.tradedAtMs >= pending.event.tradedAtMs + values.latencyMs) {
      const current = pending; pending = null;
      const fill = record(event, current); const costs = values.networkFeeSol + values.tipSol;
      const price = event.priceSol * (current.signal.side === "buy" ? 1 + values.slippageBps / 10000 : 1 - values.slippageBps / 10000);
      if (current.signal.side === "buy") {
        const principal = current.signal.sol; const venue = principal * values.venueFeeBps / 10000;
        if (cashSol < principal + venue + costs) fill.reason = "INSUFFICIENT_SOL";
        else { fill.status = "filled"; fill.quantity = principal / price; fill.principalSol = principal; fill.venueFeeSol = venue; cashSol -= principal + venue + costs; tokens += fill.quantity; }
      } else {
        const quantity = tokens * current.signal.bps / 10000; const principal = quantity * price; const venue = principal * values.venueFeeBps / 10000;
        if (quantity <= 0) fill.reason = "NO_TOKENS";
        else if (cashSol + principal - venue < costs) fill.reason = "INSUFFICIENT_SOL_FOR_FEES";
        else { fill.status = "filled"; fill.quantity = quantity; fill.principalSol = principal; fill.venueFeeSol = venue; cashSol += principal - venue - costs; tokens -= quantity; }
      }
      if (fill.status === "filled") {
        fill.fillPriceSol = price; fill.networkFeeSol = values.networkFeeSol; fill.tipSol = values.tipSol;
        networkFeeSol += fill.networkFeeSol; tipSol += fill.tipSol; venueFeeSol += fill.venueFeeSol;
      }
      fills.push(fill);
    }
    const portfolio = { cashSol, tokens, equitySol: cashSol + tokens * event.priceSol };
    peak = Math.max(peak, portfolio.equitySol); maxDrawdownPct = Math.max(maxDrawdownPct, (peak - portfolio.equitySol) / peak * 100);
    capitalCurve.push({ ...portfolio, atMs: event.tradedAtMs, eventId: event.id });
    const signal = strategy({ event: Object.freeze({ ...event }), index, portfolio: Object.freeze(portfolio), pending: pending !== null });
    if (!signal || pending) continue;
    if (signal.side !== "buy" && signal.side !== "sell") throw new Error("Strategy signal side must be buy or sell");
    if (signal.side === "buy" && (!Number.isFinite(signal.sol) || signal.sol <= 0)) throw new Error("Strategy buy sol must be positive");
    if (signal.side === "sell" && (!Number.isInteger(signal.bps) || signal.bps <= 0 || signal.bps > 10000)) throw new Error("Strategy sell bps must be an integer in 1..10000");
    pending = { signal: { ...signal }, event, index };
  }
  if (pending) fills.push({ side: pending.signal.side, triggerEventId: pending.event.id, fillEventId: null, triggerAtMs: pending.event.tradedAtMs, fillAtMs: null, status: "unfilled", reason: "NO_LATER_PRICE", observedPriceSol: null, fillPriceSol: null, quantity: 0, principalSol: 0, venueFeeSol: 0, networkFeeSol: 0, tipSol: 0 });
  const equitySol = capitalCurve.at(-1)?.equitySol ?? cashSol;
  return { fills, capitalCurve, summary: { startingSol: options.startingSol, cashSol, tokens, equitySol, netPnlSol: equitySol - options.startingSol, returnPct: (equitySol / options.startingSol - 1) * 100, maxDrawdownPct, networkFeeSol, tipSol, venueFeeSol } };
}

/** Each parameter set gets a fresh strategy closure; the tape is loaded only once. */
export function sweepHistoricalStrategies<Parameters>(tape: readonly BacktestTapeEvent[], parameters: readonly Parameters[], createStrategy: (parameters: Parameters) => HistoricalStrategy, options: HistoricalExecutionOptions): Array<{ parameters: Parameters; result: HistoricalStrategyResult }> {
  return parameters.map((value) => ({ parameters: value, result: runHistoricalStrategy(tape, createStrategy(value), options) }));
}
