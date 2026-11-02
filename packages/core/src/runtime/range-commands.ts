import { parseRangeFile } from "./range-file.ts";
import type { RangeSpec } from "./market-cap-band.ts";

export type RangeUnit = "usd" | "sol";

/** Parse "540k", "1.2m", "$75,000", "0.0000012" into a plain positive decimal string. */
export function parseRangeAmount(input: string): string {
  const text = input.trim().replace(/^\$/, "").replace(/,/g, "").toLowerCase();
  const match = /^(\d+(?:\.\d+)?(?:e-?\d+)?)([kmb])?$/.exec(text);
  if (!match) throw new Error(`Invalid amount: ${input}`);
  const scale = match[2] === "k" ? 1e3 : match[2] === "m" ? 1e6 : match[2] === "b" ? 1e9 : 1;
  const value = Number(match[1]) * scale;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Amount must be positive: ${input}`);
  return match[2] ? String(value) : match[1];
}

/** USD market caps are typed in thousands: "7" = $7k, "7.5" = $7.5k. Suffixes (k/m/b) and values >= 1000 are taken as-is.
 * SOL-per-token prices are always literal. */
export function parseRangeLevel(input: string, unit: RangeUnit): string {
  const value = parseRangeAmount(input);
  if (unit !== "usd" || /[kmb]\s*$/i.test(input.trim()) || Number(value) >= 1000) return value;
  return String(Number(value) * 1000);
}

export function rangeFileBody(unit: RangeUnit, buy: string, sell: string, steps = 1) {
  const body = {
    ...(unit === "usd" ? { buyMarketCapUsd: buy, sellMarketCapUsd: sell } : { buyPriceSol: buy, sellPriceSol: sell }),
    ...(steps > 1 ? { steps } : {}),
  };
  const text = JSON.stringify(body, null, 2) + "\n";
  return { text, spec: parseRangeFile(text) };
}

export function rangeBounds(spec: RangeSpec): { unit: RangeUnit; buy: string; sell: string } {
  return spec.kind === "market-cap"
    ? { unit: "usd", buy: spec.buyMarketCapUsd, sell: spec.sellMarketCapUsd }
    : { unit: "sol", buy: spec.buyPriceSol, sell: spec.sellPriceSol };
}

export type RangeCommand =
  | { kind: "set"; buy?: string; sell?: string; steps?: number }
  | { kind: "status" } | { kind: "help" } | { kind: "quit" } | { kind: "kill" } | { kind: "resume" } | { kind: "noop" };

/** Console commands: `b 540k`, `s 600k`, `r 540k 600k`, `st`, `help`, `q`. */
export function parseRangeCommand(line: string, unit: RangeUnit = "usd"): RangeCommand {
  const parse = (x: string) => parseRangeLevel(x, unit);
  const parseSteps = (x: string) => { const n = Number(x); if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error("steps must be 1..20"); return n; };
  const [head = "", ...rest] = line.trim().split(/\s+/).filter(Boolean);
  const cmd = head.toLowerCase();
  if (!cmd) return { kind: "noop" };
  if (["q!", "kill", "detach"].includes(cmd)) return { kind: "kill" };
  if (["q", "quit", "exit", "stop"].includes(cmd)) return { kind: "quit" };
  if (["st", "status", "?"].includes(cmd)) return { kind: "status" };
  if (["h", "help"].includes(cmd)) return { kind: "help" };
  if (["resume", "go"].includes(cmd)) return { kind: "resume" };
  const need = (n: number) => { if (rest.length !== n) throw new Error(`${cmd} expects ${n} value${n > 1 ? "s" : ""}`); };
  if (["b", "buy"].includes(cmd)) { need(1); return { kind: "set", buy: parse(rest[0]!) }; }
  if (["s", "sell"].includes(cmd)) { need(1); return { kind: "set", sell: parse(rest[0]!) }; }
  if (["n", "steps"].includes(cmd)) { need(1); return { kind: "set", steps: parseSteps(rest[0]!) }; }
  if (["r", "range"].includes(cmd)) {
    if (rest.length !== 2 && rest.length !== 3) throw new Error("r expects BUY SELL [STEPS]");
    return { kind: "set", buy: parse(rest[0]!), sell: parse(rest[1]!), ...(rest[2] ? { steps: parseSteps(rest[2]) } : {}) };
  }
  // Bare "7 11" sets both; "7 11 4" also sets 4 steps.
  if (rest.length === 1) return { kind: "set", buy: parse(head), sell: parse(rest[0]!) };
  if (rest.length === 2) return { kind: "set", buy: parse(head), sell: parse(rest[0]!), steps: parseSteps(rest[1]!) };
  throw new Error(`Unknown command: ${head} (type help)`);
}

/** One short operator line for an engine event, or null to keep it in the log file only. */
export function humanizeEngineEvent(label: string): { key: string; text: string } | null {
  if (/^(BUY|SELL) (signal|confirmed|failed)|^Broadcast submitted|^POSITION GONE|^Range updated|^Range file invalid|^Entries resumed|^Started|mismatch/.test(label))
    return { key: label, text: label.replace(/ \| submitted attempts=\d+/, "") };
  if (/^Trade request .*\| (confirmed|failed)/.test(label))
    return { key: label, text: label.replace(/^Trade request \S+ \| /, "Trade ") };
  if (/RPC_PROVIDER_UNAVAILABLE|429|Too Many Requests|failed to get (info about account|recent blockhash)|fetch failed|timeout/i.test(label))
    return { key: "rpc", text: "RPC busy or rate-limited; retrying (details in log)" };
  if (/^Order preparation unavailable/.test(label))
    return { key: "prep:" + label.slice(0, 120), text: "Can't prepare order: " + label.replace(/^Order preparation unavailable; no slow trigger fallback: (\w*Error: )?/, "").slice(0, 160) };
  if (/^NEW BUYS PAUSED/.test(label)) return { key: "paused", text: label.slice(0, 160) + " (type resume)" };
  if (/^Tick error|^Price sampling error|^Metadata refresh failed/.test(label))
    return { key: label.slice(0, 40), text: label.slice(0, 160) };
  return null;
}

export function formatUsd(value: number) {
  return value >= 1e6 ? `$${(value / 1e6).toFixed(3)}M` : value >= 1e3 ? `$${(value / 1e3).toFixed(1)}k` : `$${value.toFixed(2)}`;
}
