/**
 * slrd-bots: every range bot in ONE process.
 *
 *   bunx bgrun --name slrd-bots --directory C:/Code/solwal "bun run slrd-bots.ts"
 *
 * - follows .range-bots/bots.json (slrd-tui `n` / range-term add entries)
 * - one SQD trade subscription prices every bot (RPC fallback + 30s cross-check)
 * - one shared client: one blockhash refresher, one RPC budget, one dead-key view
 * - per-bot control files ranges/<wallet>-<mint>.cmd: resume | stop (sell 100% + close) | kill (keep)
 * - per-bot engine log: .range-bots/term-<wallet>-<mint>.log (same files the terminal bots used)
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspect } from "node:util";
import { configure } from "measure-fn";
import { activateRpc } from "./packages/cli/src/rpc-management.ts";
import { SolardConnection } from "./packages/core/src/chain/connection.ts";
import { createSolard } from "./packages/sdk/src/index";
import { daemonPid, daemonPidPath, readRegistry, removeBot, updateBot, type BotEntry } from "./tui/bot-registry.ts";
import { exitPosition } from "./tui/exit-position.ts";
import { parseRangeFile, parseRangeSteps } from "./packages/core/src/runtime/range-file.ts";
import { rangeBounds, rangeFileBody } from "./packages/core/src/runtime/range-commands.ts";
import { splitAmount, stepRungs } from "./packages/core/src/runtime/range-steps.ts";
import { SqdPriceFeed } from "./tui/sqd-price-feed.ts";
import { observeSolardRpc } from "./packages/core/src/chain/rpc-observer.ts";
import { TargetBot, type TargetRange } from "./tui/target-bot.ts";

const root = import.meta.dir;
process.chdir(root); // the engine keeps locks relative to cwd
const configToml = resolve(root, ".config.toml");
if (existsSync(configToml)) {
  const slrd = (Bun.TOML.parse(readFileSync(configToml, "utf8")) as Record<string, Record<string, unknown>>).slrd ?? {};
  for (const [key, value] of Object.entries(slrd)) {
    const name = `SLRD_${key}`.toUpperCase();
    if (process.env[name] === undefined && value != null && typeof value !== "object") process.env[name] = String(value);
  }
}
activateRpc(new Map());
process.env.SLRD_RPC_TRADE_PRIORITY = "1";
// Our endpoints are configured mainnet URLs. The readiness probe queues behind normal traffic, times out
// under load and benches healthy endpoints until every read fails; real failures are still classified per request.
process.env.SLRD_RPC_VERIFY_MAINNET = "0";
const rpcUrl = process.env.RPC_ENDPOINT;
if (!rpcUrl) throw Error("No RPC configured: `slrd rpc add http <url>`");

mkdirSync(resolve(root, ".range-bots"), { recursive: true });
const other = daemonPid(root);
if (other && other !== process.pid) throw Error(`slrd-bots already running (pid ${other})`);
writeFileSync(daemonPidPath(root), String(process.pid));

// ---- logging: daemon log + one engine log per bot, routed by measure scope ----
const daemonLog = resolve(root, ".range-bots", "slrd-bots.log");
const write = (path: string, text: string) => { try { appendFileSync(path, `${new Date().toISOString()} ${text}\n`); } catch {} };
const log = (text: string) => { write(daemonLog, text); process.stdout.write(`${new Date().toLocaleTimeString()} ${text}\n`); };
const scopeLog = new Map<string, string>(); // "range-<mint8>" -> log path
const botLogPath = (b: { wallet: string; mint: string }) => resolve(root, ".range-bots", `term-${b.wallet}-${b.mint}.log`);
configure({ logger: ((event: { type: string; label: string; scope?: string; duration?: number; error?: unknown }) => {
  const path = (event.scope && scopeLog.get(event.scope.split(/[ >/]/)[0]!)) ?? daemonLog;
  write(path, `${event.type} ${event.scope ?? ""} ${event.label}${event.duration != null ? ` ${Math.round(event.duration)}ms` : ""}${event.type === "error" ? ` ${String((event.error as Error)?.message ?? event.error)}` : ""}`);
  if (event.type === "annotation" && /^(BUY|SELL) (signal|confirmed|failed)|^Broadcast submitted|^POSITION GONE|^NEW BUYS PAUSED|^Range updated/.test(event.label))
    log(`${event.scope ?? ""} ${event.label.slice(0, 200)}`);
}) as never });
for (const name of ["log", "info", "warn", "error", "debug"] as const)
  console[name] = (...xs: unknown[]) => write(daemonLog, xs.map(x => typeof x === "string" ? x : inspect(x, { depth: 3 })).join(" "));

// ---- shared infrastructure ----
const client = createSolard({ transactionVersion: 1, rpcUrl });
const connection = new SolardConnection(rpcUrl).get();
// What the daemon asks the RPC for: one line a minute, per method, HTTP requests actually sent.
const rpcCounts = new Map<string, number>();
observeSolardRpc(event => { if (event.kind === "http" && (event.phase === "completed" || event.phase === "failed")) {
  const k = `${event.method}${event.phase === "failed" ? "!" : ""}`; rpcCounts.set(k, (rpcCounts.get(k) ?? 0) + Math.max(1, event.requestCount)); } });
setInterval(() => { const rows = [...rpcCounts].sort((a, b) => b[1] - a[1]); const total = rows.reduce((a, [, n]) => a + n, 0);
  log(`rpc/min ${total} (${(total / 60).toFixed(1)}/s): ${rows.slice(0, 12).map(([m, n]) => `${m}=${n}`).join(" ")}`); rpcCounts.clear(); }, 60_000).unref?.();
const feed = new SqdPriceFeed({ connection, rpcSample: mint => client.samplePrice(mint), log,
  // Every trade on a coin wakes its target bots at once, so short wicks are acted on within ~0.5s of SQD.
  onTrade: event => { for (const r of running.values()) if (r.entry.mint === event.mint) r.target?.wake(); } });
const warmer = client.warmBlockhash({ intervalMs: 5000 }); // a blockhash is valid ~60s
const { runRangeBot } = await import("./range-trade.ts");

// Bid-ask steps: one coin runs 1 engine ("main", steps = 1) or N slice engines (s0..sN-1),
// each owning 1/N of the amount and one rung of the range. A steps change waits until flat.
type Engine = { id: string; abort: AbortController; control: { resumeEntries?: () => boolean }; done: Promise<void> };
type Running = { entry: BotEntry; layout: number; engines: Map<string, Engine>; exit: "keep" | "sell" | null;
  startedAt: number; switching: boolean; warnedLayout?: number; target?: TargetBot };
const targetStatusPath = (b: { wallet: string; mint: string }) => resolve(root, ".range-bots", `target-${b.wallet}-${b.mint}.json`);
function targetRange(b: BotEntry): TargetRange {
  const text = readFileSync(rangePath(b), "utf8"), bounds = rangeBounds(parseRangeFile(text));
  return { unit: bounds.unit, buy: Number(bounds.buy), sell: Number(bounds.sell), steps: parseRangeSteps(text) };
}
/** Target mode: one balance-driven bot per coin instead of per-step engines. */
/** A bot can be added for any mint: register it with solard (venue, pool) the first time it is seen. */
const registering = new Map<string, Promise<void>>();
function ensureToken(mint: string): Promise<void> {
  // reconcile() can call this again while a registration is still running: share it.
  let p = registering.get(mint);
  if (!p) { p = registerToken(mint).finally(() => registering.delete(mint)); registering.set(mint, p); }
  return p;
}
async function registerToken(mint: string) {
  try { await client.samplePrice(mint); return; }
  catch (error) { if (!String(error instanceof Error ? error.message : error).startsWith("Unknown token")) return; }
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { const t = await client.addToken(mint); log(`${mint.slice(0, 6)}: registered token ${t.symbol ?? t.name ?? ""} venue=${t.venueHint}`); return; }
    catch (error) { log(`${mint.slice(0, 6)}: token registration failed (attempt ${attempt}): ${error instanceof Error ? error.message : error}`); await Bun.sleep(5_000 * attempt); }
  }
}
const startingTargets = new Set<string>();
/** reconcile() runs on a timer and can call this again while an earlier start is still awaiting
 * (token registration, feed subscribe): a second start would run two bots on one coin. */
async function startTarget(entry: BotEntry): Promise<boolean> {
  const k = key(entry);
  if (startingTargets.has(k) || running.get(k)?.target) return false;
  startingTargets.add(k);
  try { return await startTargetOnce(entry); } finally { startingTargets.delete(k); }
}
async function startTargetOnce(entry: BotEntry): Promise<boolean> {
  const k = key(entry);
  // Engine state from an earlier mode: never switch over a transaction still in flight.
  if (existingIds(entry).some(id => readJson(statePathOf(entry, id))?.pending)) { log(`${k}: pending engine trade; target mode starts after it settles`); return false; }
  const archive = resolve(root, ".range-bots", "archive"); mkdirSync(archive, { recursive: true });
  for (const id of existingIds(entry)) renameSync(statePathOf(entry, id), resolve(archive, `bot-${entry.wallet}-${botId(entry, id)}-${Date.now()}.json`));
  targetRange(entry); // validate before starting
  await ensureToken(entry.mint);
  await feed.add(entry.mint);
  const bot = new TargetBot({ client, connection, wallet: entry.wallet, walletAddress: client.walletAddress(entry.wallet), mint: entry.mint,
    budgetSol: Number(entry.amount), range: () => targetRange(entry), samplePrice: () => feed.samplePrice(entry.mint),
    statusPath: targetStatusPath(entry), buysPaused: entry.buysPaused,
    log: text => { log(text); write(botLogPath(entry), `annotation target ${text}`); } }).start();
  running.set(k, { entry, layout: 0, engines: new Map(), exit: null, startedAt: Date.now(), switching: false, target: bot });
  log(`${k}: start TARGET mode, budget ${entry.amount} SOL${entry.buysPaused ? " (buys paused)" : ""}`);
  return true;
}
/** Sell the whole balance with retries (target-mode stop). */
async function sellAll(b: BotEntry): Promise<boolean> {
  for (let i = 1; i <= 8; i++) {
    const r = await client.sell({ wallet: b.wallet, token: b.mint, amount: "all", closeTokenAccount: true, slippageBps: 500 })
      .catch(error => ({ status: "failed", code: "ERROR", message: String(error), phase: "before-submission" } as never as Awaited<ReturnType<typeof client.sell>>));
    log(`${key(b)}: sell all attempt ${i}: ${r.status} ${r.code}${r.solPrincipalDeltaLamports != null ? ` +${(Number(r.solPrincipalDeltaLamports) / 1e9).toFixed(4)} SOL` : ""} ${r.signature ?? r.message.slice(0, 100)}`);
    if (r.status === "confirmed") return true;
    if (r.status === "unresolved" || r.phase !== "before-submission") return false; // never risk a double sell
    if (/no .*balance|zero|nothing to sell|0 tokens/i.test(r.message)) return true;
    await Bun.sleep(4_000);
  }
  return false;
}
const running = new Map<string, Running>();
const key = (b: { wallet: string; mint: string }) => `${b.wallet}:${b.mint}`;
const rangePath = (b: { wallet: string; mint: string }) => resolve(root, "ranges", `${b.wallet}-${b.mint}.json`);
const engineIds = (steps: number) => steps === 1 ? ["main"] : Array.from({ length: steps }, (_, i) => `s${i}`);
const botId = (b: { mint: string }, id: string) => id === "main" ? b.mint : `${b.mint}.${id}`;
const statePathOf = (b: { wallet: string; mint: string }, id: string) => resolve(root, ".range-bots", `bot-${b.wallet}-${botId(b, id)}.json`);
const lockPathOf = (b: { wallet: string; mint: string }, id: string) => resolve(root, `bot-${b.wallet}-${botId(b, id)}.json.lock`);
const engineRangePath = (b: { wallet: string; mint: string }, id: string) => id === "main" ? rangePath(b) : resolve(root, "ranges", `${b.wallet}-${b.mint}.${id}.json`);
const failedAt = new Map<string, number>();
const readJson = (path: string) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
/** Engine ids that have a state file for this coin (any layout). */
function existingIds(b: BotEntry): string[] {
  const prefix = `bot-${b.wallet}-${b.mint}`;
  return readdirSync(resolve(root, ".range-bots")).filter(n => n.startsWith(prefix) && n.endsWith(".json"))
    .map(n => n.slice(prefix.length, -5)).filter(rest => rest === "" || /^\.s\d+$/.test(rest)).map(rest => rest === "" ? "main" : rest.slice(1));
}
const busy = (b: BotEntry, id: string) => { const s = readJson(statePathOf(b, id)); return !!(s?.position || s?.pending); };
function desiredSteps(b: BotEntry): number { try { return parseRangeSteps(readFileSync(rangePath(b), "utf8")); } catch { return 1; } }
/** Layout already holding tokens wins over a new steps value until it is flat. */
function heldLayout(b: BotEntry): number | null {
  const held = existingIds(b).filter(id => busy(b, id));
  if (!held.length) return null;
  if (held.includes("main")) return 1;
  return Math.max(...existingIds(b).filter(id => id !== "main").map(id => Number(id.slice(1)) + 1));
}
/** Write each rung's range file from the parent range (only when changed; engines hot-reload). */
function writeRungs(b: BotEntry, steps: number) {
  if (steps === 1) return;
  const parent = readFileSync(rangePath(b), "utf8");
  const bounds = rangeBounds(parseRangeFile(parent));
  for (const rung of stepRungs(bounds.buy, bounds.sell, steps, b.amount)) {
    const path = engineRangePath(b, rung.slice), text = rangeFileBody(bounds.unit, rung.buy, rung.sell).text;
    if (readFileSync(path, { flag: "a+" }).toString() !== text) { writeFileSync(`${path}.tmp`, text); renameSync(`${path}.tmp`, path); }
  }
}

function pidAlive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
/** A lock owned by a dead process is stale; one owned by a live terminal bot means "not ours". */
function claimLock(b: BotEntry, id: string): boolean {
  const path = lockPathOf(b, id);
  if (!existsSync(path)) return true;
  const pid = Number(readFileSync(path, "utf8").trim());
  // Our own pid: called only when this engine is not running here, so the lock is a leftover.
  if (pid === process.pid) { rmSync(path, { force: true }); return true; }
  if (Number.isInteger(pid) && pidAlive(pid)) return false;
  mkdirSync(resolve(root, ".range-bots", "recovery"), { recursive: true });
  renameSync(path, resolve(root, ".range-bots", "recovery", `bot-${b.wallet}-${botId(b, id).slice(0, 8)}-${pid}-${Date.now()}.lock`));
  return true;
}

function startEngine(r: Running, id: string) {
  const b = r.entry, k = key(b);
  if (!claimLock(b, id)) { log(`${k}/${id}: locked by another live process; skipped`); return; }
  const amount = id === "main" ? b.amount : splitAmount(b.amount, r.layout);
  const abort = new AbortController(), control: Engine["control"] = {};
  scopeLog.set(`range-${b.mint.slice(0, 8)}${id === "main" ? "" : `.${id}`}`, botLogPath(b));
  const engine: Engine = { id, abort, control, done: Promise.resolve() };
  r.engines.set(id, engine);
  engine.done = runRangeBot(["--mint", b.mint, "--wallet", b.wallet, "--amount", amount, "--interval", "1500",
    "--hold-ms", "0", "--range-file", engineRangePath(b, id), "--rpc-url", rpcUrl!, ...(id === "main" ? [] : ["--slice", id])],
    // Pre-signed orders refresh every 6s (not 2s): with many engines that refresh was most of the RPC load.
    { signal: abort.signal, control, client, sharedBlockhashWarmer: true, preparationIntervalMs: 6_000, samplePrice: () => feed.samplePrice(b.mint) })
    .catch(error => { log(`${k}/${id}: engine error ${error instanceof Error ? error.message : error}`); failedAt.set(k, Date.now()); })
    .finally(() => { r.engines.delete(id); });
}

async function start(entry: BotEntry) {
  const k = key(entry);
  if (running.has(k)) return;
  if (!existsSync(rangePath(entry))) { log(`${k}: no range file; skipped`); return; }
  if (entry.mode === "target") { await startTarget(entry); return; }
  const layout = heldLayout(entry) ?? desiredSteps(entry);
  writeRungs(entry, layout);
  await feed.add(entry.mint);
  const r: Running = { entry, layout, engines: new Map(), exit: null, startedAt: Date.now(), switching: false };
  running.set(k, r);
  log(`${k}: start ${layout === 1 ? "" : `${layout} steps, `}${entry.amount} SOL`);
  for (const id of engineIds(layout)) startEngine(r, id);
}

async function stopAll(r: Running) {
  for (const e of r.engines.values()) e.abort.abort();
  await Promise.all([...r.engines.values()].map(e => e.done).concat(r.target ? [r.target.stop()] : []));
}
async function finish(r: Running) {
  const b = r.entry, k = key(b);
  await stopAll(r);
  if (r.target) {
    if (r.exit === "sell" && !(await sellAll(b))) {
      log(`${k}: SELL DID NOT HAPPEN; target bot keeps running. Press x x again or sell manually.`);
      r.exit = null; running.delete(k); await startTarget(b); return;
    }
    running.delete(k); removeBot(root, b.wallet, b.mint); await feed.remove(b.mint);
    log(`${k}: stopped (${r.exit === "sell" ? "sold all + closed" : "position kept"})`);
    return;
  }
  if (r.exit === "sell") {
    let outcome: Awaited<ReturnType<typeof exitPosition>> | "error" = "error";
    // Keep trying: a stop+sell must not give up after a short RPC outage.
    for (let round = 1; round <= 5; round++) {
      outcome = await exitPosition({ client, wallet: b.wallet, mint: b.mint, statePath: existingIds(b).map(id => statePathOf(b, id)),
        say: text => { log(`${k}: ${text}`); write(botLogPath(b), `annotation exit ${text}`); }, log: text => write(botLogPath(b), text) })
        .catch(error => { log(`${k}: exit sell error ${error}`); return "error" as const; });
      if (outcome !== "failed" && outcome !== "error") break;
      await Bun.sleep(5_000);
    }
    if (outcome !== "sold" && outcome !== "flat") {
      // NOT sold: keep managing the position instead of dropping it.
      log(`${k}: SELL DID NOT HAPPEN (${outcome}); bot keeps running with the position. Press x x again or sell manually.`);
      r.exit = null;
      for (const id of engineIds(r.layout)) startEngine(r, id);
      return;
    }
  }
  running.delete(k);
  removeBot(root, b.wallet, b.mint); await feed.remove(b.mint);
  log(`${k}: stopped (${r.exit === "sell" ? "sold+closed" : "position kept"})`);
}

/** Steps changed and everything is flat: retire the old engines and start the new layout. */
async function maybeSwitchLayout(r: Running) {
  const b = r.entry, want = desiredSteps(b);
  if (want === r.layout || r.switching || r.exit) return;
  const states = existingIds(b).map(id => ({ id, s: readJson(statePathOf(b, id)) }));
  // 1 step holding -> N steps: split the position evenly so each step sells at its own level.
  const main = states.find(x => x.id === "main")?.s;
  const splitHolding = r.layout === 1 && want > 1 && main?.position && !states.some(x => x.s?.pending)
    && states.every(x => x.id === "main" || !x.s?.position);
  if (!splitHolding && states.some(x => x.s?.position || x.s?.pending)) {
    if (r.warnedLayout !== want) { r.warnedLayout = want; log(`${key(b)}: steps ${r.layout} → ${want} waits until all steps are flat`); }
    return;
  }
  r.switching = true;
  log(`${key(b)}: switching to ${want} step${want === 1 ? "" : "s"}${splitHolding ? " (splitting the held position across steps)" : ""}`);
  await stopAll(r);
  // Re-read after the engines stopped: a trade may have settled while stopping.
  const held = splitHolding ? readJson(statePathOf(b, "main")) : null;
  if (splitHolding && (!held?.position || held.pending)) { r.switching = false; log(`${key(b)}: position changed while stopping; switch retried later`); for (const id of engineIds(r.layout)) startEngine(r, id); return; }
  const archive = resolve(root, ".range-bots", "archive");
  mkdirSync(archive, { recursive: true });
  // A buy pause (external exit, operator exit) carries over to the new steps: switching must not start buying.
  const pause = states.map(x => x.s?.entryPause).find(Boolean);
  for (const id of existingIds(b)) renameSync(statePathOf(b, id), resolve(archive, `bot-${b.wallet}-${botId(b, id)}-${Date.now()}.json`));
  const ids = engineIds(want);
  const amount = held ? BigInt(held.position.amountRaw) : 0n, cost = held ? BigInt(held.position.costLamports) : 0n;
  ids.forEach((id, i) => {
    const last = i === ids.length - 1, n = BigInt(ids.length);
    const position = held ? { amountRaw: (last ? amount - amount / n * (n - 1n) : amount / n).toString(),
      costLamports: (last ? cost - cost / n * (n - 1n) : cost / n).toString() } : null;
    if (!position && !pause) return;
    writeFileSync(statePathOf(b, id), JSON.stringify({ phase: position ? "sell" : "buy", position, pending: null, prices: [], sequence: 0,
      ...(pause ? { entryPause: pause } : {}) }));
  });
  r.layout = want; r.switching = false; r.warnedLayout = undefined;
  if (held) log(`${key(b)}: split ${held.position.amountRaw} raw across ${want} steps; each sells at its own level`);
  if (pause) log(`${key(b)}: new buys stay paused (${pause.reason}); press r to resume`);
  writeRungs(b, want);
  for (const id of engineIds(want)) startEngine(r, id);
}

function pollCommands() {
  for (const r of running.values()) {
    const path = rangePath(r.entry).replace(/\.json$/, ".cmd");
    if (!existsSync(path)) continue;
    let cmd = "";
    try { cmd = readFileSync(path, "utf8").trim().toLowerCase(); rmSync(path, { force: true }); } catch { continue; }
    const k = key(r.entry);
    if ((cmd === "resume" || cmd === "pause") && r.target) {
      r.target.setBuysPaused(cmd === "pause"); updateBot(root, r.entry.wallet, r.entry.mint, { buysPaused: cmd === "pause" });
      log(`${k}: buys ${cmd === "pause" ? "paused (sells continue)" : "resumed"}`);
    }
    else if (cmd === "resume") { const n = [...r.engines.values()].filter(e => e.control.resumeEntries?.()).length; log(`${k}: ${n ? `new buys resumed (${n} step${n === 1 ? "" : "s"})` : "resume: not paused"}`); }
    else if ((cmd === "stop" || cmd === "kill") && !r.exit) { r.exit = cmd === "stop" ? "sell" : "keep"; log(`${k}: ${cmd === "stop" ? "stop + sell" : "stop (keep position)"} requested`); void finish(r); }
  }
}

let reconciling = false;
async function reconcile() {
  if (reconciling) return; // one pass at a time
  reconciling = true;
  try { await reconcileOnce(); } finally { reconciling = false; }
}
async function reconcileOnce() {
  const wanted = readRegistry(root);
  for (const entry of wanted) {
    const k = key(entry), r = running.get(k);
    if (r) {
      if (r.exit || r.switching) continue;
      if (r.target) continue; // target mode reads its range every tick
      if (entry.mode === "target") {
        // Switched to target mode: stop the step engines (positions stay in the wallet) and hand over.
        if (existingIds(entry).some(id => readJson(statePathOf(entry, id))?.pending)) continue;
        r.switching = true; log(`${k}: switching to TARGET mode`);
        await stopAll(r); running.delete(k);
        await startTarget(entry).catch(error => log(`${k}: target start failed ${error}`));
        continue;
      }
      try { if (r.layout > 1) writeRungs(entry, r.layout); } catch (error) { log(`${k}: range not applied: ${error instanceof Error ? error.message : error}`); }
      await maybeSwitchLayout(r).catch(error => { r.switching = false; log(`${k}: steps switch failed ${error}`); });
      // Restart engines that died (crash), after a pause.
      if (!r.switching && Date.now() - (failedAt.get(k) ?? 0) > 30_000)
        for (const id of engineIds(r.layout)) if (!r.engines.has(id)) { log(`${k}/${id}: restarting engine`); startEngine(r, id); }
      continue;
    }
    if (Date.now() - (failedAt.get(k) ?? 0) < 30_000) continue;
    // Start in the background: one slow token registration must not hold up every other new bot.
    void start(entry).catch(error => { log(`${k}: start failed ${error}`); failedAt.set(k, Date.now()); });
  }
  // Removed from the registry without a stop command: stop, keep the position. Re-read the registry:
  // the loop above can take a minute (token registration) and bots added meanwhile are not in `wanted`.
  const current = readRegistry(root);
  for (const r of running.values())
    if (!current.some(b => key(b) === key(r.entry)) && !r.exit) { r.exit = "keep"; log(`${key(r.entry)}: removed from registry; stopping (position kept)`); void finish(r); }
}

function writeStatus() {
  const status = { pid: process.pid, at: Date.now(), feed: { status: feed.status, lastBlockMs: feed.lastBlockMs, lagMs: feed.lastBlockMs ? Date.now() - feed.lastBlockMs : null },
    bots: [...running.values()].map(r => ({ wallet: r.entry.wallet, mint: r.entry.mint, startedAt: r.startedAt, stopping: r.exit, steps: r.layout, engines: [...r.engines.keys()], mode: r.target ? "target" : "engine" })), prices: feed.stats() };
  try { const p = resolve(root, ".range-bots", "daemon-status.json"); writeFileSync(`${p}.tmp`, JSON.stringify(status)); renameSync(`${p}.tmp`, p); } catch {}
}

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return; stopping = true;
  log(`${signal}: stopping all bots (positions kept)`);
  await Promise.race([Promise.all([...running.values()].map(r => stopAll(r))), Bun.sleep(15_000)]);
  warmer.stop(); await feed.close();
  try { if (Number(readFileSync(daemonPidPath(root), "utf8")) === process.pid) rmSync(daemonPidPath(root)); } catch {}
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

log(`slrd-bots started (pid ${process.pid}); ${readRegistry(root).length} bots in registry`);
await reconcile();
setInterval(() => { if (!stopping) { pollCommands(); void reconcile(); writeStatus(); } }, 2_000);
