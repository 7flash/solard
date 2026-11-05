/** Target-inventory bid-ask: the bot owns the wallet's whole balance of a coin and trades it toward
 * the amount its budget and the price's position in the range call for.
 *
 * Range levels L0 < L1 < ... < LN (SOL per token) make N steps; step i spans [Li, Li+1] and owns
 * (budget / N) worth of tokens priced at its buy level Li. Steps fill from the top: as the price falls
 * through L(N-1), L(N-2), ... one more step is held each time; as it rises through L1, L2, ... one fewer.
 * Between levels the current holding is kept (hysteresis). N = 1 is the plain range bot.
 * Tokens are counted at the steps' buy levels, so the bot never averages down below the range, and
 * anything above the budget (external buys) is sold. External sells are re-bought only when the price
 * says those steps must be held. */
export type TargetInput = {
  levels: number[];        // N+1 ascending prices, SOL per token
  budgetSol: number;
  balanceRaw: bigint;      // whole wallet balance of the coin
  decimals: number;
  priceSol: number;        // current price, SOL per token
  buysPaused?: boolean;
};
export type TargetPlan = {
  steps: number; held: number; target: number;
  stepTokensRaw: bigint[]; // per step, index 0 = lowest step
  targetRaw: bigint;
  action: { side: "buy"; amountSol: number; tokensRaw: bigint } | { side: "sell"; amountRaw: bigint } | null;
  nextBuy: number | null; nextSell: number | null;
};

export function targetPlan(input: TargetInput): TargetPlan {
  const { levels, budgetSol, balanceRaw, decimals, priceSol } = input;
  const n = levels.length - 1;
  if (n < 1 || levels.some((l, i) => !(l > 0) || (i > 0 && !(l > levels[i - 1]!)))) throw new Error("levels must be ascending and positive");
  if (!(budgetSol > 0) || !(priceSol > 0)) throw new Error("budget and price must be positive");
  const scale = 10 ** decimals;
  // Step i owns (budget/N) SOL worth of tokens at its buy level Li.
  const stepTokensRaw = Array.from({ length: n }, (_, i) => BigInt(Math.floor(budgetSol / n / levels[i]! * scale)));
  // Held steps are the top `h`: indices n-h .. n-1.
  const heldRaw = (h: number) => stepTokensRaw.slice(n - h).reduce((a, b) => a + b, 0n);
  // Current holding in steps: the h whose token total is closest to the balance.
  let held = 0, best = -1n;
  for (let h = 0; h <= n; h++) {
    const diff = heldRaw(h) > balanceRaw ? heldRaw(h) - balanceRaw : balanceRaw - heldRaw(h);
    if (best < 0n || diff < best) { best = diff; held = h; }
  }
  // Price at/below a step's buy level -> must hold it; at/above its sell level -> must not.
  const mustHold = levels.slice(0, n).filter(l => priceSol <= l).length;
  const mayHold = levels.slice(1).filter(l => priceSol < l).length;
  let target = Math.min(Math.max(held, mustHold), mayHold);
  if (input.buysPaused && target > held) target = held;
  const targetRaw = heldRaw(target);
  // Act only on a real gap: 40% of the smallest step (the top one) avoids churn from rounding and drift.
  const tolerance = stepTokensRaw[n - 1]! * 4n / 10n;
  let action: TargetPlan["action"] = null;
  if (targetRaw > balanceRaw + tolerance && !input.buysPaused) {
    const tokensRaw = targetRaw - balanceRaw;
    action = { side: "buy", tokensRaw, amountSol: Number(tokensRaw) / scale * priceSol };
  } else if (balanceRaw > targetRaw + tolerance && priceSol >= levels[0]!) {
    // Below the range nothing is sold, not even tokens above the budget: excess bought cheap (or outside
    // the bot) is held until the price is back in the range instead of being dumped at the bottom.
    action = { side: "sell", amountRaw: balanceRaw - targetRaw };
  }
  return {
    steps: n, held, target, stepTokensRaw, targetRaw, action,
    nextBuy: target < n ? levels[n - target - 1]! : null,
    nextSell: target > 0 ? levels[n - target + 1]! : null,
  };
}

/** Range levels for N steps between buy and sell (inclusive), as numbers in the range's unit. */
/** `percent` spaces steps by an equal percentage instead of an equal dollar amount. */
export function rangeLevels(buy: number, sell: number, steps: number, percent = false): number[] {
  if (!(sell > buy) || !Number.isInteger(steps) || steps < 1) throw new Error("need buy < sell and steps >= 1");
  return Array.from({ length: steps + 1 }, (_, i) => percent ? buy * (sell / buy) ** (i / steps) : buy + (sell - buy) * i / steps);
}
