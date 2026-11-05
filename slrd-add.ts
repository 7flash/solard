/** Quick-add target bots: `bun slrd-add.ts <mint...> [--wallet <name>|$SLRD_BOT_WALLET] [--budget 0.1] [--steps 3] [--low 0.7] [--high 1.6] [--force]`
 * Range = current market cap × [low, high] (from DexScreener); the daemon registers the token and starts trading.
 * Coins we have no trade history on (the firehose did not see them: fewer than 20 wallets recorded, e.g. non-pump
 * venues or pairs not quoted in SOL) are refused unless --force: no wallet data means no bundle/★ checks. */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { addBot, readRegistry } from "./tui/bot-registry.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1]! : fallback; };
const wallet = flag("wallet", process.env.SLRD_BOT_WALLET ?? ""), budget = flag("budget", "0.1"), steps = Number(flag("steps", "3"));
const low = Number(flag("low", "0.7")), high = Number(flag("high", "1.6"));
const force = args.includes("--force"); if (force) args.splice(args.indexOf("--force"), 1);
/** Wallets the firehose recorded for this coin (local bridge); null when the bridge is not reachable. */
type Seen = { wallets: number; top10Pct: number; earlyPct: number };
/** Wallets the firehose recorded for this coin and how concentrated it is (local bridge); null when unreachable. */
async function walletsSeen(mint: string): Promise<Seen | null> {
  try {
    const token = (await Bun.file(resolve(import.meta.dir, ".range-bots", "bridge-token")).text()).trim();
    const r = await fetch(`http://127.0.0.1:${process.env.SLRD_BRIDGE_PORT ?? 5174}/api/coin-wallets?mint=${mint}`, { headers: { "x-slrd-token": token }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const d = (await r.json()) as { walletCount?: number; launchedAtMs?: number | null; wallets?: Array<{ pct: number; firstAtMs: number }> };
    const ws = d.wallets ?? [], t0 = d.launchedAtMs ?? Math.min(...ws.map(w => w.firstAtMs));
    return { wallets: Number(d.walletCount ?? 0), top10Pct: ws.slice(0, 10).reduce((a, w) => a + w.pct, 0),
      earlyPct: ws.filter(w => w.firstAtMs - t0 <= 3_000).reduce((a, w) => a + w.pct, 0) };
  } catch { return null; }
}
const mints = [...new Set(args.filter(a => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)))];
if (!wallet) { console.error("set --wallet <name> or SLRD_BOT_WALLET"); process.exit(1); }
if (!mints.length) { console.error("usage: bun slrd-add.ts <mint...> [--budget 0.1] [--steps 3] [--low 0.7] [--high 1.6]"); process.exit(1); }

const root = import.meta.dir;
const round = (v: number) => { const p = 10 ** Math.max(0, Math.floor(Math.log10(v)) - 1); return Math.round(v / p) * p; };
for (const mint of mints) {
  if (readRegistry(root).some(b => b.wallet === wallet && b.mint === mint)) { console.log(`${mint.slice(0, 6)}: already trading`); continue; }
  if (!force) {
    const seen = await walletsSeen(mint);
    if (seen == null) { console.log(`${mint.slice(0, 6)}: skipped, cannot check our trade history (bridge not running); --force to add anyway`); continue; }
    if (seen.wallets < 20) { console.log(`${mint.slice(0, 6)}: skipped, no trade history (${seen.wallets} wallets seen: we did not watch it from the start, so no bundle/★ data); --force to add anyway`); continue; }
    // Same concentration checks as automatic entries (tui/entry-guard.ts).
    if (seen.earlyPct > 25) { console.log(`${mint.slice(0, 6)}: skipped, first-3s buyers (dev/bundle) hold ${seen.earlyPct.toFixed(0)}% of supply; --force to add anyway`); continue; }
    if (seen.top10Pct > 70) { console.log(`${mint.slice(0, 6)}: skipped, top 10 wallets hold ${seen.top10Pct.toFixed(0)}% of supply; --force to add anyway`); continue; }
  }
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(10_000) });
    const pairs = ((await r.json()) as { pairs?: any[] }).pairs ?? [];
    // Market cap from the deepest live pool, whatever its quote token (solard routes SOL -> XMR/DJT/... -> coin
    // itself): preferring SOL pairs took a $125 Meteora dust pool over the $16.7k PumpSwap XMR pool. A migrated
    // coin keeps its old curve pair frozen at the migration cap, so curve pairs are only the fallback.
    const solana = pairs.filter(p => p.chainId === "solana");
    const live = solana.filter(p => (p.liquidity?.usd ?? 0) > 0).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const best = live[0] ?? solana.sort((a, b) => (b.volume?.h1 ?? 0) - (a.volume?.h1 ?? 0))[0];
    let cap = Number(best?.marketCap || best?.fdv);
    if (!(cap > 0)) { // DexScreener has no cap for some curves (e.g. non-SOL quotes): ask GeckoTerminal
      const g = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools`, { signal: AbortSignal.timeout(10_000) }).then(r => r.json()).catch(() => null) as any;
      const a = g?.data?.[0]?.attributes;
      cap = Number(a?.market_cap_usd || a?.fdv_usd);
    }
    if (!(cap > 0)) { console.log(`${mint.slice(0, 6)}: no market cap on DexScreener, skipped`); continue; }
    if (best && best.quoteToken?.symbol !== "SOL") console.log(`${mint.slice(0, 6)}: warning, main pair is quoted in ${best.quoteToken?.symbol}`);
    const buy = round(cap * low), sell = round(cap * high);
    const path = resolve(root, "ranges", `${wallet}-${mint}.json`);
    if (!existsSync(path)) writeFileSync(path, JSON.stringify({ buyMarketCapUsd: String(buy), sellMarketCapUsd: String(sell), steps }, null, 2) + "\n");
    addBot(root, { wallet, mint, amount: budget, mode: "target" });
    console.log(`${best?.baseToken?.symbol ?? mint.slice(0, 6)} ${mint}: ${best?.dexId ?? "gecko"} cap $${(cap / 1000).toFixed(1)}k -> range ${buy / 1000}-${sell / 1000}k ×${steps}, ${budget} SOL`);
  } catch (error) { console.log(`${mint.slice(0, 6)}: ${error instanceof Error ? error.message : error}`); }
}
