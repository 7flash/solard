/** Quick-add target bots: `bun slrd-add.ts <mint...> [--wallet <name>|$SLRD_BOT_WALLET] [--budget 0.1] [--steps 3] [--low 0.7] [--high 1.6]`
 * Range = current market cap × [low, high] (from DexScreener); the daemon registers the token and starts trading. */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { addBot, readRegistry } from "./tui/bot-registry.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1]! : fallback; };
const wallet = flag("wallet", process.env.SLRD_BOT_WALLET ?? ""), budget = flag("budget", "0.1"), steps = Number(flag("steps", "3"));
const low = Number(flag("low", "0.7")), high = Number(flag("high", "1.6"));
const mints = [...new Set(args.filter(a => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)))];
if (!wallet) { console.error("set --wallet <name> or SLRD_BOT_WALLET"); process.exit(1); }
if (!mints.length) { console.error("usage: bun slrd-add.ts <mint...> [--budget 0.1] [--steps 3] [--low 0.7] [--high 1.6]"); process.exit(1); }

const root = import.meta.dir;
const round = (v: number) => { const p = 10 ** Math.max(0, Math.floor(Math.log10(v)) - 1); return Math.round(v / p) * p; };
for (const mint of mints) {
  if (readRegistry(root).some(b => b.wallet === wallet && b.mint === mint)) { console.log(`${mint.slice(0, 6)}: already trading`); continue; }
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(10_000) });
    const pairs = ((await r.json()) as { pairs?: any[] }).pairs ?? [];
    const sol = pairs.filter(p => p.quoteToken?.symbol === "SOL" && p.chainId === "solana");
    const best = (sol.length ? sol : pairs).sort((a, b) => (b.volume?.h1 ?? 0) - (a.volume?.h1 ?? 0))[0];
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
