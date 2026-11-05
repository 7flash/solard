/** Pure helpers for Kris events: reading a bot's last fill and cleaning decision text for the public view. */
export type KrisEvent = { id: string; atMs: number; kind: "trade" | "position" | "decision" | "range" | "coin" | "migrated" | "result" | "review"; mint: string; symbol: string | null; title: string; thought?: string; reaction?: string };

/** The last confirmed BUY or SELL in a bot log. */
export function lastFill(log: string) {
  const hits = [...log.matchAll(/^(\S+Z) .*(BUY|SELL) confirmed CONFIRMED ([+-]?[\d.]+) SOL/gm)], m = hits[hits.length - 1];
  return m ? { atMs: Date.parse(m[1]!), side: m[2] as "BUY" | "SELL", sol: Math.abs(Number(m[3])) } : null;
}
export const tradeTitle = (f: { side: string; sol: number } | null) => f ? `${f.side === "BUY" ? "Bought" : "Sold"} ${f.sol.toFixed(4)} SOL` : "Traded";

/** Drops balances, links and anything that looks like an address from a decision reason. */
export function scrubReason(text: string) {
  return text.replace(/\d+(\.\d+)? SOL free \(reserve [\d.]+\)/g, "too low").replace(/https?:\/\/\S+/g, "").replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, "").slice(0, 120);
}

/** Where a cap sits against a range. */
export const rangeSide = (cap: number, r: { buy: number; sell: number }) => cap > r.sell ? "above" : cap < r.buy ? "below" : "inside";

const usd = (v: number) => v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${(v / 1000).toFixed(1)}k`;
export const rangeTitle = (side: string, cap: number, r: { buy: number; sell: number }) =>
  side === "inside" ? `Back in range at ${usd(cap)}` : `Went ${side} range at ${usd(cap)} (${usd(r.buy)}–${usd(r.sell)})`;

/** Kris's call on a coin from the terminal's own numbers. A call only: nothing is bought from it. The limits are the ones
 * the daemon uses for automatic entries. */
export function coinVerdict(c: { capUsd?: number | null; trades?: number | null; traders?: number | null; smart?: number | null; migrated?: boolean | null }) {
  const cap = c.capUsd ?? 0, wallets = c.traders ?? 0, min = 150;
  if (cap < 6_000) return { verdict: "skip", reason: `cap ${usd(cap)} is under $6k` };
  if (cap > 2_000_000) return { verdict: "skip", reason: `cap ${usd(cap)} is over $2M` };
  if (wallets && wallets < min) return { verdict: (c.smart ?? 0) > 0 ? "watch" : "skip", reason: `only ${wallets} wallets so far` };
  if ((c.smart ?? 0) > 0) return { verdict: "like", reason: `${c.smart} smart wallets in, ${wallets} wallets, cap ${usd(cap)}` };
  return { verdict: "watch", reason: `${wallets || "few"} wallets, cap ${usd(cap)}` };
}

/** The animation a trade earns: a first buy apes in, a later buy is a level bought on the way down, a sell is judged by the coin's P&L. */
export function tradeReaction(side: string | null, stepsHeld: number, pnlSol: number) {
  if (side === "BUY") return stepsHeld <= 1 ? "ape" : "dip";
  if (side === "SELL") return pnlSol < 0 ? "loss" : "profit";
  return null;
}
