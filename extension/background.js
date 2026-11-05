importScripts("chart-math.js");
// All bridge access lives here: pages never see the token. Only the range of the coin being viewed leaves this worker.
const BRIDGE = "http://127.0.0.1:5174";
let cache = { at: 0, bots: [], solUsd: null };
async function state() {
  if (Date.now() - cache.at < 5000) return cache;
  const { token } = await chrome.storage.local.get("token");
  if (!token) throw new Error("no-token");
  const r = await fetch(`${BRIDGE}/api/state`, { headers: { "x-slrd-token": token } });
  if (!r.ok) throw new Error(`bridge-${r.status}`);
  const s = await r.json();
  cache = { at: Date.now(), solUsd: s.solUsd, only: s.only ?? null, wallet: s.bots[0]?.wallet ?? s.inactive?.[0]?.wallet ?? null, bots: [...s.bots, ...(s.inactive ?? [])].filter(b => b.range?.unit === "usd" && b.capUsd > 0) };
  return cache;
}
// Many sites put the pair in the URL, and DexScreener lowercases it. Only found answers are cached.
const pairs = new Map();
async function coinOfPair(address) {
  if (pairs.has(address)) return pairs.get(address);
  for (const url of [`https://api.dexscreener.com/latest/dex/pairs/solana/${address}`, `https://api.dexscreener.com/latest/dex/search?q=${address}`]) {
    const j = await (await fetch(url)).json().catch(() => null), p = j?.pair ?? j?.pairs?.[0], mint = p?.baseToken?.address;
    if (mint) { pairs.set(address, mint); return mint; }
  }
  return null;
}
// A coin with no bot: what the panel needs to open a position.
const coins = new Map();
async function coinInfo(address) {
  const seen = coins.get(address); if (seen && Date.now() - seen.at < 30_000) return seen.coin;
  const mint = await coinOfPair(address).catch(() => null) ?? address;
  const j = await (await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`)).json().catch(() => null);
  const p = (j?.pairs ?? []).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const coin = { mint, symbol: p?.baseToken?.symbol ?? null, capUsd: p?.marketCap ?? null };
  coins.set(address, { at: Date.now(), coin }); return coin;
}
// Actions the panel may ask for; anything else is refused here, before the bridge.
const ACTIONS = new Set(["range", "budget", "pause", "resume", "lock", "unlock", "stop", "add", "enable", "disable"]);
async function act(body) {
  if (!ACTIONS.has(body.action)) throw new Error("action not allowed");
  const { token } = await chrome.storage.local.get("token");
  const r = await fetch(`${BRIDGE}/api/bot`, { method: "POST", headers: { "x-slrd-token": token, "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `bridge ${r.status}`);
  cache.at = 0;
  return j.message ?? "done";
}
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (m.type === "act") { act(m.body).then(message => reply({ ok: true, message })).catch(e => reply({ ok: false, error: e.message })); return true; }
  if (m.type !== "range") return;
  (async () => {
    const s = await state(), bot = await globalThis.solardChartMath.findBot(m.addresses, s.bots, coinOfPair);
    reply({ ok: true, bot: bot ? { wallet: bot.wallet, mint: bot.mint, budgetSol: bot.budgetSol ?? null, symbol: bot.symbol, buy: bot.range.buy, sell: bot.range.sell, capUsd: bot.capUsd,
      priceUsd: bot.priceSol && s.solUsd ? bot.priceSol * s.solUsd : null, steps: bot.steps, held: bot.holdingSteps, target: bot.target ?? null,
      valueSol: bot.valueSol ?? null, nextBuy: bot.nextBuy ?? null, nextSell: bot.nextSell ?? null, paused: !!bot.paused, locked: !!bot.rangeLocked, inactive: !!bot.inactive, isolated: !!s.only } : null,
      coin: bot ? null : await coinInfo(m.addresses[0]).catch(() => null), wallet: s.wallet, bots: s.bots.length });
  })().catch(e => reply({ ok: false, error: e.message }));
  return true;
});
