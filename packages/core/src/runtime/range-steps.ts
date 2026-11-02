/** Bid-ask steps inside one range. steps = 1 is the plain range bot (buy <= low, sell >= high).
 * steps = N splits [low, high] into N equal rungs; rung i buys at <= its lower edge and sells at
 * >= its upper edge with amount / N, re-arming after every round trip. */
export type StepRung = { slice: string; buy: string; sell: string; amount: string };

const decimal = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) throw new Error("Step levels must be positive");
  return Number(value.toPrecision(12)).toString();
};
/** SOL amounts keep at most nine decimals (lamports). */
export function splitAmount(amount: string, steps: number): string {
  const lamports = Math.floor(Number(amount) * 1e9 / steps);
  if (!Number.isFinite(lamports) || lamports < 1_000_000) throw new Error(`Amount per step too small (${amount} SOL / ${steps}); minimum 0.001 SOL`);
  return (lamports / 1e9).toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
}
export function stepRungs(buy: string, sell: string, steps: number, amount: string): StepRung[] {
  if (!Number.isInteger(steps) || steps < 1 || steps > 20) throw new Error("steps must be an integer 1..20");
  const low = Number(buy), high = Number(sell);
  if (!(high > low)) throw new Error("Sell level must be above buy level for steps");
  const width = (high - low) / steps, each = splitAmount(amount, steps);
  return Array.from({ length: steps }, (_, i) => ({
    slice: `s${i}`, amount: each,
    buy: i === 0 ? buy : decimal(low + width * i),
    sell: i === steps - 1 ? sell : decimal(low + width * (i + 1)),
  }));
}
