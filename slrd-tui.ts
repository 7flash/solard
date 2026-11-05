/**
 * Solard trading terminal.
 *
 *   bun run slrd-tui.ts
 *
 * Wallets (SOL balances) · positions/bots (range-term bots, with live mcap, range, PnL) ·
 * live SQD trade stream for the selected position, each row annotated with the trader's
 * session activity, net SOL, wallet balance and tags (DEV / one of ours / ACTIVE).
 * Bots run in their own terminals (range-term.ts); this UI edits their range files and
 * sends resume/stop through ranges/<wallet>-<mint>.cmd.
 */
import { emitKeypressEvents } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { configure } from "measure-fn";
import { activateRpc } from "./packages/cli/src/rpc-management.ts";
import { SolardConnection } from "./packages/core/src/chain/connection.ts";
import { subscribeTrades, getSolUsdPrice, type TradeEvent, type TradeSubscription } from "./packages/core/src/market/launch-trades.ts";
import { fetchTokenMetadata } from "./packages/core/src/market/token-metadata.ts";
import { parseRangeFile, parseRangeSteps } from "./packages/core/src/runtime/range-file.ts";
import { parseRangeCommand, rangeBounds, rangeFileBody } from "./packages/core/src/runtime/range-commands.ts";
import { stepRungs } from "./packages/core/src/runtime/range-steps.ts";
import { createSolard } from "./packages/sdk/src/index";
import { filteredBots, recordTrade, render, renderDiscovery, scanBots, type DiscoveryData, tradeRows, type Screen, type TradeRow, type TraderStats } from "./tui/screen.ts";
import { readTrades } from "./tui/trade-log.ts";
import { updateBot } from "./tui/bot-registry.ts";

const root = import.meta.dir;
const configToml = resolve(root, ".config.toml");
if (existsSync(configToml)) {
  const slrd = (Bun.TOML.parse(readFileSync(configToml, "utf8")) as Record<string, Record<string, unknown>>).slrd ?? {};
  for (const [key, value] of Object.entries(slrd)) {
    const name = `SLRD_${key}`.toUpperCase();
    if (process.env[name] === undefined && value != null && typeof value !== "object") process.env[name] = String(value);
  }
}
activateRpc(new Map());
const rpcUrl = process.env.RPC_ENDPOINT;
if (!rpcUrl) throw Error("No RPC configured: `slrd rpc add http <url>`");

// Keep library logs off the screen.
const logPath = resolve(root, ".range-bots", "slrd-tui.log");
mkdirSync(resolve(root, ".range-bots"), { recursive: true });
const toLog = (text: string) => { try { appendFileSync(logPath, `${new Date().toISOString()} ${text}\n`); } catch {} };
configure({ logger: ((event: { type: string; label: string }) => { if (event.type === "error" || event.type === "annotation") toLog(`${event.type} ${event.label}`); }) as never });
for (const name of ["log", "info", "warn", "error", "debug"] as const) console[name] = (...xs: unknown[]) => toLog(xs.map(String).join(" "));

const slrd = createSolard({ rpcUrl });
const connection = new SolardConnection(rpcUrl).get();
const sqd = { portalUrl: "https://portal.sqd.dev/datasets/solana-mainnet" };

const screen: Screen = {
  width: process.stdout.columns ?? 120, height: process.stdout.rows ?? 40, focus: "bots",
  wallets: [], walletIndex: 0, bots: [], botIndex: 0, symbols: new Map(),
  trades: [], traders: new Map(), mine: new Map(), streamStatus: "idle", solUsd: null,
  prompt: null, message: "",
};
const say = (text: string) => { screen.message = text; toLog(`msg ${text}`); };

// ---- wallets ----
try {
  screen.wallets = slrd.listWallets().map(w => ({ name: w.name, address: w.address, sol: null }));
  for (const w of screen.wallets) screen.mine.set(w.address, w.name);
} catch (error) { say(`Wallets unavailable: ${error instanceof Error ? error.message : error}`); }
// Only wallets that have bots, plus the selected one: balances share the RPC budget with trading.
async function refreshWalletBalances() {
  const used = new Set(scanBots(root).map(b => b.wallet));
  const selected = screen.walletIndex > 0 ? screen.wallets[screen.walletIndex - 1]?.name : null;
  screen.wallets.sort((a, b) => Number(used.has(b.name)) - Number(used.has(a.name)));
  for (const w of screen.wallets) {
    if (!used.has(w.name) && w.name !== selected) continue;
    try { w.sol = (await connection.getBalance(new PublicKey(w.address), "confirmed")) / 1e9; } catch (e) { toLog(`balance ${w.name} ${e}`); }
  }
}
void refreshWalletBalances();
setInterval(refreshWalletBalances, 120_000);
async function refreshSolUsd() { try { screen.solUsd = (await getSolUsdPrice()).price; } catch {} }
void refreshSolUsd(); setInterval(refreshSolUsd, 60_000);

// ---- trade stream for the selected position ----
let streamMint: string | null = null;
let subscription: TradeSubscription | null = null;
const MAX_TRADES = 2000;
function toRow(e: TradeEvent): TradeRow {
  const quoteIsSol = e.market.quoteMint === "So11111111111111111111111111111111111111112";
  const quote = e.quoteRaw == null ? null : Number(e.quoteRaw) / 10 ** e.market.quoteDecimals;
  return {
    signature: e.signature, atMs: e.atMs, side: e.side,
    sol: quote == null ? null : quoteIsSol ? quote : e.market.priceSol != null && e.baseRaw != null ? Number(e.baseRaw) / 10 ** e.market.baseDecimals * e.market.priceSol : null,
    tokens: e.baseRaw == null ? null : Number(e.baseRaw) / 10 ** e.market.baseDecimals,
    capUsd: e.market.marketCapUsd, trader: e.trader ?? null, creator: e.creator ?? null,
  };
}
const seen = new Set<string>();
async function openStream(tokens: string[]) {
  subscription = await subscribeTrades({
    source: "sqd", sqd, connection, tokens, venues: ["pump", "pumpswap"],
    solUsd: async () => screen.solUsd ?? (screen.solUsd = (await getSolUsdPrice()).price), solUsdRefreshMs: 60_000,
    onTrade: e => {
      if (e.mint !== streamMint) return;
      const key = `${e.signature}:${e.logIndex ?? e.eventIndex ?? 0}`;
      if (seen.has(key)) return; seen.add(key);
      if (e.metadata?.symbol && !screen.symbols.has(e.mint)) { screen.symbols.set(e.mint, e.metadata.symbol.slice(0, 10)); saveSymbols(); }
      const row = toRow(e);
      recordTrade(screen.traders, row);
      screen.trades.unshift(row);
      if ((screen.tradeOffset ?? 0) > 0) screen.tradeOffset!++; // keep a scrolled view still
      if (screen.trades.length > MAX_TRADES) screen.trades.length = MAX_TRADES;
      screen.streamStatus = `live · ${screen.trades.length} trades this session`;
    },
    onStatus: (event, data) => {
      if (event === "listening" || event === "source-ready") screen.streamStatus = "live (sqd)";
      else if (!/progress|tokens-changed/.test(event)) toLog(`stream ${event} ${JSON.stringify(data ?? {}).slice(0, 300)}`);
    },
  });
  const current = subscription;
  void current.closed.then(async () => {
    if (subscription !== current) return;
    screen.streamStatus = "feed gap; reconnecting…";
    await Bun.sleep(2_000);
    try { await openStream(streamMint ? [streamMint] : []); } catch (e) { screen.streamStatus = `reconnect failed: ${e}`; }
  });
}
/** Trades come from the slrd-bots daemon (.range-bots/trades/<mint>.json): it already streams every coin,
 * so the TUI no longer opens a second SQD stream and RPC pool of its own. */
async function follow(mint: string | null) {
  if (mint === streamMint) return;
  streamMint = mint;
  screen.trades = []; screen.traders = new Map(); seen.clear(); screen.tradeOffset = 0;
  screen.streamStatus = mint ? "waiting for trades (from daemon)" : "idle";
  pullTrades();
}
function pullTrades() {
  if (!streamMint) return;
  const rows = readTrades(root, streamMint);
  const fresh = rows.filter(r => !seen.has(r.signature));
  for (const r of fresh.reverse()) { seen.add(r.signature); recordTrade(screen.traders, r); }
  if (fresh.length && (screen.tradeOffset ?? 0) > 0) screen.tradeOffset! += fresh.length; // keep a scrolled view still
  screen.trades = rows;
  if (rows.length) screen.streamStatus = `live · ${rows.length} trades · last ${Math.max(0, Math.round((Date.now() - rows[0]!.atMs) / 1000))}s ago`;
}

// ---- token symbols: on-chain metadata, cached on disk (one read per mint, ever) ----
const symbolsPath = resolve(root, ".range-bots", "symbols.json");
try { for (const [mint, symbol] of Object.entries(JSON.parse(readFileSync(symbolsPath, "utf8")) as Record<string, string>)) screen.symbols.set(mint, symbol); } catch {}
const symbolTried = new Map<string, number>(); // mint -> last attempt; retried every minute
const saveSymbols = () => { try { let disk: Record<string, string> = {}; try { disk = JSON.parse(readFileSync(symbolsPath, "utf8")); } catch {} for (const [m, v] of Object.entries(disk)) if (!screen.symbols.has(m)) screen.symbols.set(m, v); writeFileSync(symbolsPath, JSON.stringify(Object.fromEntries(screen.symbols), null, 1)); } catch {} };
async function symbolWorker() {
  while (true) {
    const mint = screen.bots.map(b => b.mint).find(m => !screen.symbols.has(m) && Date.now() - (symbolTried.get(m) ?? 0) > 60_000);
    if (mint) {
      symbolTried.set(mint, Date.now());
      try {
        const meta = await fetchTokenMetadata(connection, mint, { mode: "chain", timeoutMs: 8_000 });
        const symbol = meta?.symbol?.replace(/[^ -~]/g, "").trim();
        if (symbol) { screen.symbols.set(mint, symbol.slice(0, 10)); saveSymbols(); }
      } catch (e) { toLog(`symbol ${mint} ${e}`); }
    }
    await Bun.sleep(mint ? 1_000 : 5_000);
  }
}
void symbolWorker();

// ---- trader wallet balances: one lookup at a time, visible rows first ----
const balanceAt = new Map<string, number>();
async function balanceWorker() {
  while (true) {
    const visible = screen.trades.slice(0, Math.max(5, screen.height - 20)).map(t => t.trader).filter((t): t is string => !!t);
    const next = visible.find(t => Date.now() - (balanceAt.get(t) ?? 0) > 300_000);
    if (next) {
      balanceAt.set(next, Date.now());
      try {
        const lamports = await connection.getBalance(new PublicKey(next), "confirmed");
        const stats = screen.traders.get(next) as TraderStats | undefined;
        if (stats) stats.balanceSol = lamports / 1e9;
      } catch (e) { toLog(`trader balance ${next} ${e}`); }
    }
    await Bun.sleep(3_000);
  }
}
void balanceWorker();

// ---- actions ----
const rangePath = (wallet: string, mint: string) => resolve(root, "ranges", `${wallet}-${mint}.json`);
/** Copy the selected coin's contract address (Windows clip / macOS pbcopy / Linux xclip). */
function copyMint() {
  const bot = selectedBot(); if (!bot) throw Error("No position selected");
  const cmd = process.platform === "win32" ? ["clip"] : process.platform === "darwin" ? ["pbcopy"] : ["xclip", "-selection", "clipboard"];
  try { const p = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore", windowsHide: true }); p.stdin.write(bot.mint); p.stdin.end(); say(`Copied ${bot.mint}`); }
  catch (error) { say(`Copy failed (${error instanceof Error ? error.message : error}): ${bot.mint}`); }
}
/** Position size = SOL the bot holds when every step is filled; changes apply live (buys up / sells down). */
function editSize(input: string) {
  const bot = selectedBot(); if (!bot) throw Error("No position selected");
  const sol = Number(input.trim()); if (!(sol > 0 && sol <= 5)) throw Error("Size must be a SOL amount between 0 and 5");
  updateBot(root, bot.wallet, bot.mint, { amount: String(sol) }); say(`Size ${bot.mint.slice(0, 6)} -> ${sol} SOL (applies within a few seconds)`);
}
function selectedBot() { return filteredBots(screen)[screen.botIndex] ?? null; }
function editRange(input: string) {
  const bot = selectedBot();
  if (!bot) throw Error("No position selected");
  const path = rangePath(bot.wallet, bot.mint);
  const old = existsSync(path) ? readFileSync(path, "utf8") : null;
  const current = old ? rangeBounds(parseRangeFile(old)) : { unit: "usd" as const, buy: "", sell: "" };
  const cmd = parseRangeCommand(/^\s*(n|steps)\b/i.test(input) ? input : `r ${input}`, current.unit);
  if (cmd.kind !== "set") throw Error("Enter: BUY SELL [STEPS]   e.g. 7 11 4 = $7k-$11k in 4 steps; or: steps 4");
  const buy = cmd.buy ?? current.buy, sell = cmd.sell ?? current.sell;
  if (!buy || !sell) throw Error("Enter BUY SELL first");
  const steps = cmd.steps ?? (old ? parseRangeSteps(old) : 1);
  if (steps > 1) stepRungs(buy, sell, steps, "1"); // validates levels before saving
  const { text, spec } = rangeFileBody(current.unit, buy, sell, steps);
  writeFileSync(`${path}.tmp`, text); renameSync(`${path}.tmp`, path);
  const b = rangeBounds(spec);
  say(`${bot.wallet} ${bot.mint.slice(0, 6)}: range saved ${b.buy} → ${b.sell}${steps > 1 ? ` in ${steps} steps` : ""}${bot.alive ? " (bot reloads it; a steps change waits until flat)" : " (bot not running: press o to relaunch)"}`);
}
function sendCommand(cmd: "resume" | "stop") {
  const bot = selectedBot();
  if (!bot) throw Error("No position selected");
  if (!bot.alive) throw Error("Bot is not running");
  writeFileSync(rangePath(bot.wallet, bot.mint).replace(/\.json$/, ".cmd"), cmd);
  say(`${cmd} sent to ${bot.wallet} ${bot.mint.slice(0, 6)} (applies within ~2s; bots started before this update need a restart)`);
}
async function launch(args: string[]) {
  // range-term hands the bot to slrd-bots when the daemon runs, else opens a terminal.
  const proc = Bun.spawn([process.execPath, "run", resolve(root, "range-term.ts"), ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: process.env });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  say((out.trim().split("\n").at(-1) || err.trim().split("\n").at(-1) || "launched").slice(0, 200));
}
function newBot(input: string) {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  const mint = parts.find(p => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p));
  const nums = parts.filter(p => p !== mint && /^[\d.$,]+[kmb]?$/i.test(p));
  const walletName = parts.find(p => screen.wallets.some(w => w.name === p))
    ?? (screen.walletIndex > 0 ? screen.wallets[screen.walletIndex - 1]!.name : null);
  const stepsToken = parts.find(p => /^x\d{1,2}$/i.test(p));
  if (!mint || nums.length < 2) throw Error("Enter: MINT BUY SELL [xSTEPS] [wallet] [SOL]   e.g. Guv…pump 7 11 x4 main 0.1");
  if (!walletName) throw Error("Name a wallet (or select one on the left)");
  const amount = nums[2] ?? "0.1";
  const steps = stepsToken ? stepsToken.slice(1) : "1";
  say(`launching ${walletName} ${mint.slice(0, 6)} ${nums[0]} → ${nums[1]}${steps !== "1" ? ` in ${steps} steps` : ""} (${amount} SOL)…`);
  void launch([mint, nums[0]!, nums[1]!, "--wallet", walletName, "--amount", amount, "--steps", steps]);
}
/** Hide a stopped bot: archive its state file. Never sells; tokens stay in the wallet. */
function archive() {
  const bot = selectedBot();
  if (!bot) throw Error("No position selected");
  if (bot.alive) throw Error("Bot is running: stop it first (x x)");
  const dir = resolve(root, ".range-bots", "archive");
  mkdirSync(dir, { recursive: true });
  const name = `bot-${bot.wallet}-${bot.mint}.json`;
  renameSync(resolve(root, ".range-bots", name), resolve(dir, name.replace(/\.json$/, `-${Date.now()}.json`)));
  const label = screen.symbols.get(bot.mint) ?? bot.mint.slice(0, 6);
  say(`Removed ${bot.wallet} ${label} from the list${bot.amountRaw ? " (its tokens are still in the wallet; nothing was sold)" : ""}. Archived in .range-bots/archive`);
}
function relaunch() {
  const bot = selectedBot();
  if (!bot) throw Error("No position selected");
  if (bot.alive) throw Error("Already running");
  if (!existsSync(rangePath(bot.wallet, bot.mint))) throw Error("No saved range; press e first");
  say(`relaunching ${bot.wallet} ${bot.mint.slice(0, 6)}…`);
  void launch([bot.mint, "--wallet", bot.wallet]);
}

// ---- loop ----
let stopArmed = 0, deleteArmed = 0;
let view: "bots" | "discovery" = "bots";
/** Wallets panel data: the same /api/coin-wallets the web coin page uses (local bridge, token from .range-bots). */
let walletsBusy = false;
async function pullWallets() {
  const mint = selectedBot()?.mint;
  if (screen.bottom !== "wallets" || !mint || walletsBusy) return;
  walletsBusy = true;
  try {
    const token = readFileSync(resolve(root, ".range-bots", "bridge-token"), "utf8").trim();
    const r = await fetch(`http://127.0.0.1:${process.env.SLRD_BRIDGE_PORT ?? 5174}/api/coin-wallets?mint=${mint}`, { headers: { "x-slrd-token": token }, signal: AbortSignal.timeout(8_000) });
    if (r.ok) { screen.coinWallets = await r.json(); draw(); }
  } catch {} finally { walletsBusy = false; }
}
setInterval(() => void pullWallets(), 2_000).unref?.();
const readDiscovery = (): DiscoveryData | null => { try { return JSON.parse(readFileSync(resolve(root, ".range-bots", "discovery.json"), "utf8")); } catch { return null; } };
function draw() {
  try {
    if (view === "discovery") {
      screen.width = process.stdout.columns ?? screen.width; screen.height = process.stdout.rows ?? screen.height;
      const lines = renderDiscovery(screen, readDiscovery()).split("
");
      const full = lines.length !== lastFrame.length;
      let out = full ? "[H[J" : "";
      lines.forEach((line, i) => { if (full || line !== lastFrame[i]) out += `[${i + 1};1H${line}[K`; });
      if (out) process.stdout.write(out);
      lastFrame = lines; return;
    }
    const keep = selectedBot()?.mint; // keep the cursor on the same coin when bots are added/removed
    screen.bots = scanBots(root);
    pullTrades();
    const bots = filteredBots(screen);
    const at = keep ? bots.findIndex(b => b.mint === keep) : -1;
    screen.botIndex = at >= 0 ? at : Math.max(0, Math.min(screen.botIndex, bots.length - 1));
    void follow(bots[screen.botIndex]?.mint ?? null);
    screen.width = process.stdout.columns ?? screen.width; screen.height = process.stdout.rows ?? screen.height;
    // Only rewrite lines that changed: full-screen repaints twice a second kept Windows Terminal at 100% of a core.
    const lines = render(screen).split("\n");
    const full = lines.length !== lastFrame.length;
    let out = full ? "\u001b[H\u001b[J" : "";
    lines.forEach((line, i) => { if (full || line !== lastFrame[i]) out += `\u001b[${i + 1};1H${line}\u001b[K`; });
    if (out) process.stdout.write(out);
    lastFrame = lines;
  } catch (e) { toLog(`draw ${e instanceof Error ? e.stack : e}`); }
}
let lastFrame: string[] = [];
if (process.argv.includes("--snapshot")) { screen.bots = scanBots(root); { const i = Math.max(0, filteredBots(screen).findIndex(b => b.mint === process.env.SNAPSHOT_MINT)); screen.botIndex = i; void follow(filteredBots(screen)[i]?.mint ?? null); } await Bun.sleep(Number(process.env.SNAPSHOT_MS ?? 3000)); draw(); process.stdout.write("\n"); process.exit(0); }
if (!process.stdin.isTTY) throw Error("Run slrd-tui in an interactive terminal");
process.stdout.write("\u001b[?1049h\u001b[?25l");
emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
const timer = setInterval(draw, 1000);
const quit = () => {
  clearInterval(timer); process.stdin.setRawMode(false);
  process.stdout.write("\u001b[?25h\u001b[?1049l");
  process.stdout.write("slrd-tui closed; bots keep running in their own terminals.\n");
  process.exit(0);
};
process.on("SIGINT", quit);
process.stdout.on("resize", () => { lastFrame = []; draw(); });

process.stdin.on("keypress", (text: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
  if (key?.ctrl && key.name === "c") return quit();
  try {
    if (screen.prompt) {
      const p = screen.prompt;
      if (key?.name === "escape") screen.prompt = null;
      else if (key?.name === "backspace") p.text = p.text.slice(0, -1);
      else if (key?.name === "return") {
        screen.prompt = null;
        if (p.label.startsWith("Range")) editRange(p.text); else if (p.label.startsWith("Size")) editSize(p.text); else newBot(p.text);
      } else if (text && text >= " " && p.text.length < 120) p.text += text;
      return draw();
    }
    const name = key?.name ?? text;
    if (name !== "x") stopArmed = 0;
    if (name !== "d") deleteArmed = 0;
    if (name === "q") return quit();
    if (name === "v") { view = view === "bots" ? "discovery" : "bots"; lastFrame = []; return draw(); }
    if (view === "discovery") return;
    if (name === "w") { screen.bottom = screen.bottom === "wallets" ? "trades" : "wallets"; screen.tradeOffset = 0; void pullWallets(); return draw(); }
    if (name === "tab") screen.focus = screen.focus === "bots" ? "wallets" : "bots";
    else if (name === "h" || name === "left") screen.focus = "wallets";
    else if (name === "l" || name === "right") screen.focus = "bots";
    else if (name === "up" || name === "down" || name === "k" || name === "j") {
      const step = name === "up" || name === "k" ? -1 : 1;
      if (screen.focus === "wallets") { screen.walletIndex = Math.max(0, Math.min(screen.wallets.length, screen.walletIndex + step)); screen.botIndex = 0; }
      else screen.botIndex = Math.max(0, Math.min(filteredBots(screen).length - 1, screen.botIndex + step));
    } else if (name === "e") {
      const bot = selectedBot();
      if (!bot) throw Error("No position selected");
      screen.prompt = { label: `Range ${bot.wallet} ${bot.mint.slice(0, 6)} (BUY SELL [STEPS] in $k, e.g. 7 11 4)`, text: "" };
    } else if (name === "n") screen.prompt = { label: "New bot (MINT BUY SELL [xSTEPS] [wallet] [SOL]; $k, e.g. 7 11 x4)", text: "" };
    else if (name === "pageup" || name === "pagedown" || name === "[" || name === "]") {
      const page = Math.max(1, tradeRows(screen) - 2), back = name === "pageup" || name === "[";
      screen.tradeOffset = Math.max(0, Math.min(Math.max(0, screen.trades.length - page), (screen.tradeOffset ?? 0) + (back ? page : -page)));
    } else if (name === "end" || name === "home") screen.tradeOffset = 0;
    else if (name === "c") copyMint();
    else if (name === "s") {
      const bot = selectedBot(); if (!bot) throw Error("No position selected");
      screen.prompt = { label: `Size ${bot.mint.slice(0, 6)}: SOL at full inventory (now ${bot.budgetSol ?? "?"})`, text: "" };
    }
    else if (name === "r") sendCommand("resume");
    else if (name === "o") relaunch();
    else if (name === "d") {
      const bot = selectedBot();
      if (bot?.alive) throw Error("Bot is running: stop it first (x x)");
      if (Date.now() - deleteArmed < 3_000) { deleteArmed = 0; archive(); }
      else { deleteArmed = Date.now(); say(`Press d again within 3s to remove this stopped bot from the list${bot?.amountRaw ? " (it still holds tokens; they stay in the wallet)" : ""}`); }
    }
    else if (name === "x") {
      if (Date.now() - stopArmed < 3_000) { stopArmed = 0; sendCommand("stop"); }
      else { stopArmed = Date.now(); say("Press x again within 3s: stop this bot, SELL everything and close the token account"); }
    }
  } catch (e) { say(`! ${e instanceof Error ? e.message : e}`); }
  draw();
});
draw();
