export type StrategyTargetState = {
  strategy?: { kind: "fixed"; buyPriceSol: string; sellPriceSol: string } | { kind: "sma" };
  running?: boolean;
  sellAtLoss?: boolean;
  phase: "buy" | "sell";
  position: { amountRaw: string; costLamports: string } | null;
  pending: { key: string; side: string } | null;
  prices: { time: number; price: number }[];
};
export type TargetMetadata = {
  supplyRaw: bigint;
  decimals: number;
  verifiedAtMs: number;
};
export function strategyTargetRow(input: {
  mint: string; wallet: string; state: StrategyTargetState; now: number;
  windowMs: number; intervalMs: number; range: number; profit: number;
  metadata?: TargetMetadata; solUsd?: { price: number; atMs: number; source: string };
}) {
  const { state, now, metadata, solUsd } = input;
  const prices = state.prices.filter(p => Number.isFinite(p.time) && Number.isFinite(p.price) &&
    p.price > 0 && p.time <= now && p.time >= now - input.windowMs).sort((a, b) => a.time - b.time);
  const last = prices.at(-1);
  const coverage = prices.length ? now - prices[0]!.time : 0;
  const maxGap = prices.reduce((gap, p, i) => i ? Math.max(gap, p.time - prices[i - 1]!.time) : gap, 0);
  const fresh = !!last && now - last.time <= input.intervalMs * 3;
  const fixed = state.strategy?.kind === "fixed" ? state.strategy : null;
  const ready = fresh && (!!fixed || (coverage >= input.windowMs - input.intervalMs * 2 &&
    maxGap <= input.intervalMs * 3 && prices.length >= Math.floor(input.windowMs / input.intervalMs * 0.8)));
  const sma = prices.length ? prices.reduce((sum, p) => sum + p.price, 0) / prices.length : null;
  const buy = ready ? fixed ? Number(fixed.buyPriceSol) : sma! * (1 - input.range) : null;
  const sell = ready ? fixed ? Number(fixed.sellPriceSol) : sma! * (1 + input.range) : null;
  const supplyFresh = !!metadata && now - metadata.verifiedAtMs <= 300_000 &&
    metadata.verifiedAtMs <= now && metadata.supplyRaw > 0n &&
    Number.isInteger(metadata.decimals) && metadata.decimals >= 0 && metadata.decimals <= 255;
  const supply = supplyFresh ? Number(metadata!.supplyRaw) / 10 ** metadata!.decimals : null;
  const usdFresh = !!solUsd && Number.isFinite(solUsd.price) && solUsd.price > 0 &&
    solUsd.atMs <= now && now - solUsd.atMs <= 120_000;
  const usd = usdFresh ? solUsd!.price : null;
  const cap = (price: number | null) => price != null && supply != null && usd != null &&
    Number.isFinite(price * supply * usd) ? price * supply * usd : null;
  const positionTokens = state.position && metadata
    ? Number(BigInt(state.position.amountRaw)) / 10 ** metadata.decimals : null;
  let profitMinimum: number | null = null;
  if (state.position && !state.sellAtLoss && !fixed) {
    const cost = BigInt(state.position.costLamports);
    const ppm = BigInt(Math.ceil(input.profit * 1_000_000));
    profitMinimum = Number(cost + (cost * ppm + 999_999n) / 1_000_000n) / 1e9;
  }
  const effectiveSell = sell != null && positionTokens != null && positionTokens > 0 && profitMinimum != null
    ? Math.max(sell, profitMinimum / positionTokens) : sell;
  const status = state.running === false ? "STOPPED" : state.pending ? "PENDING" : !fresh ? "STALE_PRICE" : !ready ? "WARMING_UP"
    : !supplyFresh ? "SUPPLY_UNAVAILABLE" : !usdFresh ? "USD_UNAVAILABLE" : "READY";
  const targetPrice = state.phase === "buy" ? buy : effectiveSell;
  const currentCap = fresh ? cap(last?.price ?? null) : null;
  const targetCap = cap(targetPrice);
  const nextAction = status === "READY" ? (state.phase === "buy" ? "WAIT TO BUY" : "WAIT TO SELL") : status;
  const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
  const waitingFor = status !== "READY" ? status.replaceAll("_", " ")
    : targetCap == null ? "Market-cap target unavailable"
    : `${state.phase === "buy" ? "Buy at or below" : "Sell at or above"} ${money(targetCap)} market cap`;
  return {
    token: input.mint.slice(0, 8), next_action: nextAction,
    current_mcap_usd: currentCap == null ? null : Math.round(currentCap),
    next_target_mcap_usd: status === "READY" && targetCap != null ? Math.round(targetCap) : null,
    waiting_for: waitingFor,
    move_to_target_pct: status === "READY" && last && targetPrice != null
      ? Number(((targetPrice / last.price - 1) * 100).toFixed(2)) : null,
    updated_at: new Date(now).toISOString(), token_mint: input.mint, wallet: input.wallet,
    phase: state.phase.toUpperCase(), status,
    price_at: last ? new Date(last.time).toISOString() : null,
    price_sol: last?.price ?? null, price_usd: fresh && usd != null && last ? last.price * usd : null,
    market_cap_usd: fresh ? cap(last?.price ?? null) : null,
    sma_price_sol: sma, buy_price_sol: buy, buy_market_cap_usd: cap(buy),
    sell_price_sol: sell, sell_market_cap_usd: cap(sell),
    effective_sell_price_sol: effectiveSell, effective_sell_market_cap_usd: cap(effectiveSell),
    profit_floor_sol: profitMinimum, position_tokens: positionTokens,
    supply_raw: metadata?.supplyRaw.toString() ?? null, decimals: metadata?.decimals ?? null,
    supply_verified_at: metadata ? new Date(metadata.verifiedAtMs).toISOString() : null,
    sol_usd: usd, sol_usd_source: usdFresh ? solUsd!.source : null,
    sol_usd_at: solUsd ? new Date(solUsd.atMs).toISOString() : null,
    sample_count: prices.length, sma_coverage_seconds: coverage / 1000,
    pending_intent: state.pending?.key ?? null,
  };
}

export function targetsCsv(rows: ReturnType<typeof strategyTargetRow>[]): string {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]!) as (keyof typeof rows[number])[];
  const cell = (value: unknown) => {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [columns.join(","), ...rows.map(row => columns.map(key => cell(row[key])).join(","))].join("\r\n") + "\r\n";
}
