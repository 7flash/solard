/** Pushes the cleaned view to the public page: overview every 5s, a few held coins each round. One way only: nothing
 * comes back, and the server never gets the bridge token. Token: .range-bots/public-token. */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tradedFromLog } from "./tui/fill-log.ts";
import { assertClean, publicCoin, publicKris, publicOverview, type Secrets } from "./webapp/public/sanitize.ts";

const dot = resolve(import.meta.dir, ".range-bots");
const bridgeToken = readFileSync(resolve(dot, "bridge-token"), "utf8").trim(), publicToken = readFileSync(resolve(dot, "public-token"), "utf8").trim();
/** All SOL Kris has traded, from the bot logs. Read at most every 5 minutes. */
let traded = { volumeSol: 0, trades: 0, coins: 0 }, tradedAt = 0;
function totals() {
  if (Date.now() - tradedAt < 300_000) return traded;
  tradedAt = Date.now();
  const dir = resolve(import.meta.dir, ".range-bots"), sum = { volumeSol: 0, trades: 0, coins: 0 };
  for (const f of readdirSync(dir)) {
    if (!/^term-bgr-.*\.log$/.test(f)) continue;
    const t = tradedFromLog(readFileSync(resolve(dir, f), "utf8"));
    if (t.trades) { sum.volumeSol += t.sol; sum.trades += t.trades; sum.coins++; }
  }
  return traded = { ...sum, volumeSol: Math.round(sum.volumeSol * 100) / 100 };
}
const target = process.env.SLRD_PUBLIC_URL ?? "https://solard.xyz/live/api/ingest", bridge = "http://127.0.0.1:5174", view = "http://127.0.0.1:5176";

async function get(url: string, headers: Record<string, string>) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${url.split("?")[0]}: ${r.status}`);
  return await r.json() as Record<string, any>;
}
async function push(body: unknown, s: Secrets) {
  const text = JSON.stringify(body); assertClean(text, s);
  const r = await fetch(target, { method: "POST", headers: { authorization: `Bearer ${publicToken}`, "content-type": "application/json" }, body: text, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`push: ${r.status}`);
}

let next = 0, lastError = "";
for (;;) {
  try {
    const state = await get(`${bridge}/api/state`, { "x-slrd-token": bridgeToken }), ov = await get(`${view}/api/overview`, { cookie: `slrd_web=${bridgeToken}` });
    const wallets = (state.wallets ?? []) as { name?: string; address?: string }[];
    const s: Secrets = { addresses: wallets.flatMap(w => w.address ? [w.address] : []) };
    if (!s.addresses.length) throw new Error("no wallet list, nothing published");
    await push({ overview: publicOverview(ov) }, s);
    const mints = ((ov.bots ?? []) as { mint: string; inactive?: boolean }[]).filter(b => !b.inactive).map(b => b.mint);
    // watch=0: reading a coin here must never start its holder history download.
    for (let i = 0; i < 2 && mints.length; i++)
      await push({ coin: publicCoin(await get(`${bridge}/api/coin-wallets?mint=${mints[next++ % mints.length]}&watch=0`, { "x-slrd-token": bridgeToken }), s) }, s);
    await push({ kris: publicKris(await get(`${view}/api/kris`, { cookie: `slrd_web=${bridgeToken}` }).then(r => r.events ?? [])), ca: process.env.KRIS_CA ?? "", stats: totals() }, s);
    if (lastError) console.log("publishing again");
    lastError = "";
  } catch (e) {
    const m = String(e instanceof Error ? e.message : e).slice(0, 160);
    if (m !== lastError) console.log(`${new Date().toISOString()} ${m}`);
    lastError = m;
  }
  await Bun.sleep(5_000);
}
