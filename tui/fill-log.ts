/** Our confirmed fills from a bot's log (.range-bots/term-<wallet>-<mint>.log). */
export type LogFill = { atMs: number; side: "buy" | "sell"; sol: number };

export function fillsFromLog(text: string): LogFill[] {
  const out: LogFill[] = [];
  for (const m of text.matchAll(/^(\S+Z) .*(BUY|SELL) confirmed CONFIRMED [+-]?(\d+(?:\.\d+)?) SOL/gm)) {
    const atMs = Date.parse(m[1]!); if (Number.isFinite(atMs)) out.push({ atMs, side: m[2] === "BUY" ? "buy" : "sell", sol: Number(m[3]) });
  }
  return out;
}

/** SOL traded in one bot log, counting the final sell-all a stop makes, which `fillsFromLog` leaves out. */
export function tradedFromLog(text: string) {
  let sol = 0, trades = 0;
  for (const m of text.matchAll(/(?:(?:BUY|SELL) confirmed|sell all attempt \d+: confirmed) CONFIRMED [+-]?(\d+(?:\.\d+)?) SOL/g)) { sol += Number(m[1]); trades++; }
  return { sol, trades };
}
