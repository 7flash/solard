/**
 * Range trader in its own terminal.
 *
 *   bun run range-term.ts <MINT> <BUY> <SELL> [--sol] [--wallet ddm6] [--amount 0.1] [--rpc-url URL]
 *
 * BUY/SELL are USD market caps by default (540k, 1.2m, 75000); pass --sol for SOL-per-token prices.
 * Writes ranges/<wallet>-<mint>.json and opens a new terminal running the range engine
 * (range-trade.ts) with that file. In the new terminal type `b 550k`, `s 620k`, `r 550k 620k`,
 * `st` or `q`. If the bot is already running, the launcher only updates its range file.
 */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { inspect } from "node:util";
import { resolve } from "node:path";
import { configure } from "measure-fn";
import { activateRpc } from "./packages/cli/src/rpc-management.ts";
import { configureSolardMeasure } from "./packages/core/src/core/log.ts";
import { parseRangeFile, parseRangeSteps } from "./packages/core/src/runtime/range-file.ts";
import { stepRungs } from "./packages/core/src/runtime/range-steps.ts";
import {
  formatUsd, humanizeEngineEvent, parseRangeLevel, parseRangeCommand, rangeBounds, rangeFileBody, type RangeUnit,
} from "./packages/core/src/runtime/range-commands.ts";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    wallet: { type: "string", default: "ddm6" },
    amount: { type: "string", default: "0.1" },
    sol: { type: "boolean", default: false },
    "rpc-url": { type: "string" },
    interval: { type: "string", default: "1000" },
    "hold-ms": { type: "string", default: "0" },
    here: { type: "boolean", default: false },
    tab: { type: "boolean", default: false },
    /** Bid-ask steps in the range (1 = plain range). Needs slrd-bots; terminal mode runs 1 step. */
    steps: { type: "string" },
    verbose: { type: "boolean", default: false },
  },
});

// Wallet DB + signing key: the [slrd] section of .config.toml, as bgrun --config provides it.
// RPC endpoints come from solard's own config (~/.solard/rpc.json, `slrd rpc list`).
const configToml = resolve(import.meta.dir, ".config.toml");
if (existsSync(configToml)) {
  const slrd = (Bun.TOML.parse(readFileSync(configToml, "utf8")) as Record<string, Record<string, unknown>>).slrd ?? {};
  for (const [key, value] of Object.entries(slrd)) {
    const name = `SLRD_${key}`.toUpperCase();
    if (process.env[name] === undefined && value != null && typeof value !== "object") process.env[name] = String(value);
  }
}
activateRpc(new Map(args["rpc-url"] ? [["rpc-url", args["rpc-url"]]] : []));

const [mint, buyArg, sellArg] = positionals;
if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint))
  throw Error("Usage: bun run range-term.ts <MINT> <BUY> <SELL> [--sol] [--wallet ddm6] [--amount 0.1]");
const wallet = args.wallet!;
const cwd = import.meta.dir;
const rangePath = resolve(cwd, "ranges", `${wallet}-${mint}.json`);
const statePath = resolve(cwd, ".range-bots", `bot-${wallet}-${mint}.json`);
const lockPath = resolve(cwd, `bot-${wallet}-${mint}.json.lock`);
const short = `${mint.slice(0, 4)}…${mint.slice(-4)}`;

/** Keeps the saved step count unless a new one is given. */
const writeRange = (unit: RangeUnit, buy: string, sell: string, steps?: number) => {
  const keep = existsSync(rangePath) ? parseRangeSteps(readFileSync(rangePath, "utf8")) : 1;
  const { text, spec } = rangeFileBody(unit, buy, sell, steps ?? keep);
  mkdirSync(resolve(cwd, "ranges"), { recursive: true });
  writeFileSync(`${rangePath}.tmp`, text);
  renameSync(`${rangePath}.tmp`, rangePath);
  return spec;
};
const readRange = () => parseRangeFile(readFileSync(rangePath, "utf8"));
const describe = (unit: RangeUnit, buy: string, sell: string) => unit === "usd"
  ? `buy <= ${formatUsd(Number(buy))}  sell >= ${formatUsd(Number(sell))}${Number(sell) <= Number(buy) ? "  (exit-only: new buys paused)" : ""}`
  : `buy <= ${buy}  sell >= ${sell} SOL/token`;
const runningPid = () => {
  if (!existsSync(lockPath)) return null;
  const pid = Number(readFileSync(lockPath, "utf8"));
  try { process.kill(pid, 0); return pid; } catch { return null; }
};

if (!args.here) {
  // ---- Launcher ----
  if (buyArg && sellArg) {
    const unit: RangeUnit = args.sol ? "sol" : "usd";
    const steps = args.steps ? Number(args.steps) : undefined;
    if (steps !== undefined && (!Number.isInteger(steps) || steps < 1 || steps > 20)) throw Error("--steps must be 1..20");
    const buy = parseRangeLevel(buyArg, unit), sell = parseRangeLevel(sellArg, unit);
    if ((steps ?? 1) > 1) stepRungs(buy, sell, steps!, args.amount!); // validates levels and amount per step
    const spec = writeRange(unit, buy, sell, steps);
    const b = rangeBounds(spec);
    console.log(`Range saved ${rangePath}\n  ${describe(b.unit, b.buy, b.sell)}${(steps ?? 1) > 1 ? `  in ${steps} steps` : ""}`);
  } else if (!existsSync(rangePath)) throw Error("Give BUY and SELL (no saved range for this wallet/mint yet)");
  const { daemonPid, addBot } = await import("./tui/bot-registry.ts");
  if (!daemonPid(cwd) && parseRangeSteps(readFileSync(rangePath, "utf8")) > 1)
    console.log("Note: steps run only in slrd-bots (not running), so this terminal bot runs the range as 1 step.");
  if (daemonPid(cwd) && !args.tab) {
    addBot(cwd, { wallet, mint, amount: args.amount! });
    console.log(`Handed to slrd-bots (pid ${daemonPid(cwd)}): ${wallet} ${short}, ${args.amount} SOL per buy. Watch/adjust in slrd-tui.`);
    process.exit(0);
  }
  const pid = runningPid();
  if (pid) {
    console.log(`Bot for ${wallet}/${short} already running (pid ${pid}); it will pick up the new range.`);
    process.exit(0);
  }
  const rpcUrl = args["rpc-url"] ?? process.env.RPC_ENDPOINT;
  if (!rpcUrl) throw Error("No RPC configured: add one with `slrd rpc add http <url>` or pass --rpc-url");
  const explicitRpc = args["rpc-url"] ? ["--rpc-url", rpcUrl] : []; // otherwise the child loads solard rpc.json itself
  const child = [process.execPath, "run", resolve(cwd, "range-term.ts"), mint, "--here",
    "--wallet", wallet, "--amount", args.amount!, "--interval", args.interval!, "--hold-ms", args["hold-ms"]!,
    ...explicitRpc, ...(args.verbose ? ["--verbose"] : [])];
  const title = `range ${wallet} ${short}`;
  const wt = Bun.which("wt.exe");
  const command = process.platform !== "win32" ? null
    : wt ? [wt, "-w", args.tab ? "0" : "new", "new-tab", "--title", title, "-d", cwd, ...child]
    : /[&|<>^%"]/.test(explicitRpc.join(" ")) ? null
    : ["cmd.exe", "/c", "start", title, "/d", cwd, ...child];
  if (!command) { console.log(`Run in a new terminal:\n  ${child.join(" ")}`); process.exit(0); }
  Bun.spawn(command, { cwd, stdio: ["ignore", "ignore", "ignore"], env: process.env }).unref();
  console.log(`Opened terminal "${title}" (${args.amount} SOL per buy). Adjust the range there.`);
  process.exit(0);
}

// ---- Interactive console (runs inside the spawned terminal) ----
process.env.SLRD_RPC_TRADE_PRIORITY = "1";
if (!existsSync(rangePath)) throw Error(`Missing ${rangePath}`);
mkdirSync(resolve(cwd, ".range-bots"), { recursive: true });
const logPath = resolve(cwd, ".range-bots", `term-${wallet}-${mint}.log`);
const toLog = (text: string) => { try { appendFileSync(logPath, text.endsWith("\n") ? text : text + "\n"); } catch {} };
const fmtArgs = (xs: unknown[]) => xs.map(x => typeof x === "string" ? x : x instanceof Error ? (x.stack ?? x.message) : inspect(x, { depth: 4 })).join(" ");

// Engine output goes to the log file; only trade events reach the window.
const rawLog = console.log.bind(console);
for (const name of ["log", "info", "warn", "error", "debug"] as const)
  console[name] = (...xs: unknown[]) => { toLog(`${new Date().toISOString()} ${fmtArgs(xs)}`); if (args.verbose) rawLog(...xs); };
const rawErr = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  toLog(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
  if (args.verbose) return (rawErr as (...a: unknown[]) => boolean)(chunk, ...rest);
  const cb = rest.find(r => typeof r === "function") as (() => void) | undefined; cb?.(); return true;
}) as typeof process.stderr.write;

let rl: ReturnType<typeof createInterface> | undefined;
/** Print above the prompt without losing what the user is typing. */
const say = (text: string) => { process.stdout.write("\r\x1b[2K"); rawLog(text); rl?.prompt(true); };

const lastShown = new Map<string, number>();
const eventLogger = (event: { type: string; label: string; scope?: string; duration?: number; error?: unknown }, next: () => void) => {
  toLog(`${new Date().toISOString()} ${event.type} ${event.scope ?? ""} ${event.label}${event.duration != null ? ` ${Math.round(event.duration)}ms` : ""}${event.type === "error" ? ` ${String((event.error as Error)?.message ?? event.error)}` : ""}`);
  if (args.verbose) return next();
  if (event.type !== "annotation") return;
  const shown = humanizeEngineEvent(event.label);
  if (!shown) return;
  // Trade events always show; repeated warnings at most once a minute.
  const isTrade = /^(BUY|SELL|Broadcast|Trade |POSITION GONE|Range|Entries|Started)/.test(shown.text);
  const now = Date.now();
  if (!isTrade && now - (lastShown.get(shown.key) ?? 0) < 60_000) return;
  lastShown.set(shown.key, now);
  say(`${new Date().toLocaleTimeString()}  ${isTrade ? "" : "! "}${shown.text}`);
};
configureSolardMeasure({ silent: false, timestamps: true });

type BotState = {
  phase?: "buy" | "sell"; health?: string;
  position?: { amountRaw: string; costLamports: string } | null;
  pending?: { side: string } | null;
  marketObservation?: { capUsd: number; at: number };
  prices?: { time: number; price: number }[];
};
const readState = (): BotState | null => { try { return JSON.parse(readFileSync(statePath, "utf8")); } catch { return null; } };
const snapshot = () => {
  const s = readState(), r = rangeBounds(readRange());
  const cap = s?.marketObservation && Date.now() - s.marketObservation.at < 15_000 ? formatUsd(s.marketObservation.capUsd) : "?";
  return { s, r, cap };
};
const statusLine = () => {
  const { s, r, cap } = snapshot();
  const last = s?.prices?.at(-1);
  const pos = s?.position ? `holding ${s.position.amountRaw} raw, cost ${Number(s.position.costLamports) / 1e9} SOL` : "flat";
  return `${short} ${(s?.phase ?? "buy").toUpperCase()} | mcap ${cap}`
    + `${last ? ` | px ${last.price.toPrecision(6)} SOL (${Math.round((Date.now() - last.time) / 1000)}s ago)` : ""} | ${pos}${s?.pending ? ` | PENDING ${s.pending.side}` : ""}`
    + ` | ${describe(r.unit, r.buy, r.sell)}${s?.health && s.health !== "running" ? ` | ${s.health}` : ""}`;
};
const setTitle = () => {
  try {
    const { s, r, cap } = snapshot();
    const lv = r.unit === "usd" ? `${formatUsd(Number(r.buy))}-${formatUsd(Number(r.sell))}` : `${r.buy}-${r.sell}`;
    process.stdout.write(`\x1b]0;${wallet} ${short} ${(s?.phase ?? "buy").toUpperCase()}${s?.pending ? "*" : ""} ${cap} [${lv}]\x07`);
  } catch {}
};
const help = () => rawLog([
  "Commands:",
  "  b 550k        set buy level        s 620k       set sell level",
  "  r 550k 620k   set both (or just: 550k 620k)",
  "  st            status now",
  "  q             SELL everything, close the token account, stop",
  "  q!            stop WITHOUT selling (keep the position)",
  "  resume        allow new buys again after a pause (e.g. position sold outside the bot)",
  (rangeBounds(readRange()).unit === "usd" ? "  Values are USD market cap in thousands: 7 = $7k, 7.5 = $7.5k (75k, 1.2m also work)" : "  Values are SOL per token"),
  `  Live status is in the window title. Full engine log: ${logPath}`,
].join("\n"));

const shutdown = new AbortController();
let exitMode: "sell" | "keep" = "keep";
/** After the engine has fully stopped: sell 100% and close the token account in one transaction. */
async function exitPositionNow() {
  const { createSolard } = await import("./packages/sdk/src/index");
  const { exitPosition } = await import("./tui/exit-position.ts");
  const client = createSolard({ transactionVersion: 1, ...(process.env.RPC_ENDPOINT ? { rpcUrl: process.env.RPC_ENDPOINT } : {}) });
  await exitPosition({ client, wallet, mint, statePath, say: rawLog, log: toLog });
}
const control: { resumeEntries?: () => boolean } = {};
const { runRangeBot } = await import("./range-trade.ts");
configure({ logger: eventLogger as never }); // after imports, so nothing re-installs a console logger
rawLog(`Range bot ${wallet} / ${mint}  (${args.amount} SOL per buy)`);
help();
rawLog(statusLine());
rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "range> " });
rl.prompt();
rl.on("line", line => {
  try {
    const cmd = parseRangeCommand(line, rangeBounds(readRange()).unit);
    if (cmd.kind === "help") help();
    else if (cmd.kind === "status") rawLog(statusLine());
    else if (cmd.kind === "resume") rawLog(control.resumeEntries?.() ? "New buys resumed." : "Not paused.");
    else if (cmd.kind === "quit") {
      exitMode = "sell";
      rawLog(readState()?.position ? "Stopping, then selling everything and closing the token account…" : "Stopping (flat)…");
      shutdown.abort(); rl?.close(); return;
    } else if (cmd.kind === "kill") {
      exitMode = "keep";
      const s = readState();
      if (s?.position) rawLog("Stopping with an OPEN position (not sold). Relaunch to resume managing it.");
      if (s?.pending) rawLog("A transaction is pending; it will reconcile on next start.");
      rawLog("Stopping…"); shutdown.abort(); rl?.close(); return;
    } else if (cmd.kind === "set") {
      const current = rangeBounds(readRange());
      if (cmd.steps && cmd.steps > 1) rawLog("Steps need slrd-bots (this terminal bot runs 1 step); saved for when it moves there.");
      const spec = writeRange(current.unit, cmd.buy ?? current.buy, cmd.sell ?? current.sell, cmd.steps);
      const b = rangeBounds(spec);
      rawLog(`Saved: ${describe(b.unit, b.buy, b.sell)}`);
    }
  } catch (error) { rawLog(`! ${error instanceof Error ? error.message : String(error)}`); }
  rl?.prompt();
});
rl.on("SIGINT", () => { rawLog("\nStopping (position, if any, is kept)…"); exitMode = "keep"; shutdown.abort(); rl?.close(); });
// Remote control from slrd-tui: ranges/<wallet>-<mint>.cmd containing "resume" or "stop".
const cmdPath = rangePath.replace(/\.json$/, ".cmd");
const pollCommand = () => {
  if (!existsSync(cmdPath)) return;
  let cmd = "";
  try { cmd = readFileSync(cmdPath, "utf8").trim().toLowerCase(); rmSync(cmdPath, { force: true }); } catch { return; }
  if (cmd === "resume") say(control.resumeEntries?.() ? "New buys resumed (from TUI)." : "Resume requested from TUI: not paused.");
  else if (cmd === "stop") { exitMode = "sell"; say("Stop requested from TUI: stopping, then selling everything and closing the token account…"); shutdown.abort(); rl?.close(); }
  else if (cmd === "kill") { exitMode = "keep"; say("Stop (keep position) requested from TUI…"); shutdown.abort(); rl?.close(); }
};
setTitle();
const ticker = setInterval(() => { setTitle(); pollCommand(); }, 2_000);
const statusTicker = setInterval(() => { try { say(`${new Date().toLocaleTimeString()}  ${statusLine()}`); } catch {} }, 30_000);

try {
  await runRangeBot(["--mint", mint, "--wallet", wallet, "--amount", args.amount!, "--interval", args.interval!,
    "--hold-ms", args["hold-ms"]!, "--range-file", rangePath, "--rpc-url", args["rpc-url"] ?? process.env.RPC_ENDPOINT ?? ""], { signal: shutdown.signal, control });
} catch (error) {
  rawLog(`Bot stopped with error: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  clearInterval(ticker); clearInterval(statusTicker); rl.close();
  if (exitMode === "sell") { try { await exitPositionNow(); } catch (error) { rawLog(`Exit sell error: ${error instanceof Error ? error.message : String(error)}`); } }
  rawLog(`Bot stopped. Log: ${logPath}`);
  prompt("Press Enter to close this window");
}
