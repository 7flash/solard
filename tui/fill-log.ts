/** Our confirmed fills from a bot's log (.range-bots/term-<wallet>-<mint>.log). */
export type LogFill = { atMs: number; side: "buy" | "sell"; sol: number };

export function fillsFromLog(text: string): LogFill[] {
  const out: LogFill[] = [];
  for (const m of text.matchAll(/^(\S+Z) .*(BUY|SELL) confirmed CONFIRMED [+-]?(\d+(?:\.\d+)?) SOL/gm)) {
    const atMs = Date.parse(m[1]!); if (Number.isFinite(atMs)) out.push({ atMs, side: m[2] === "BUY" ? "buy" : "sell", sol: Number(m[3]) });
  }
  return out;
}
