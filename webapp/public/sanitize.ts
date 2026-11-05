/** What may leave this machine for the public page. Whitelists only: a new field stays private until it is added here.
 * Our wallets are removed from every list, and assertClean refuses a payload that still holds one of their addresses or a key. */
export type Secrets = { addresses: string[] };
type Row = Record<string, unknown>;
const pick = (o: Row, keys: string[]) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));

const BOT = ["mint", "symbol", "capUsd", "range", "steps", "holdingSteps", "target", "budgetSol", "base", "mult", "valueSol", "pnl", "flowSol", "costSol", "source",
  "buysPaused", "rangeLocked", "stale", "inactive", "nextBuy", "nextSell", "addedAt", "lastTradeAtMs", "vol1hSol", "volCoveredMin", "priceSol", "amountRaw"];
const COIN = ["mint", "symbol", "ageMs", "capUsd", "ammCapUsd", "trades", "traders", "smart", "lastTradeMs", "status", "migrated"];
const WALLET = ["trader", "held", "pct", "buys", "sells", "solIn", "solOut", "pnlSol", "firstAtMs", "lastAtMs", "entryCapUsd", "delta5", "smart", "dev", "profile", "from", "viaTransfer"];
const TRADE = ["signature", "atMs", "side", "sol", "tokens", "capUsd", "trader", "smart"];
const COIN_DETAIL = ["mint", "symbol", "capUsd", "exact", "migrated", "launchedAtMs", "trades", "priceSol", "walletCount", "holders", "transferCount"];
const CLOSED = ["mint", "symbol", "closedAt", "openedAt", "boughtSol", "buys", "sells", "pnlSol", "pct"];
const CANDLE = ["m", "o", "h", "l", "c", "v"], FILL = ["atMs", "side", "sol"];

export function publicOverview(o: Row) {
  return {
    at: o.at, public: true, solUsd: o.solUsd, closed: o.closed, feedLagMs: o.feedLagMs,
    firehose: o.firehose ? pick(o.firehose as Row, ["liveCoins", "perSec", "lagMs"]) : null,
    bots: ((o.bots ?? []) as Row[]).map(b => ({ ...pick(b, BOT), error: b.error ? "feed issue" : null })),
    coins: ((o.coins ?? []) as Row[]).map(c => pick(c, COIN)),
    closedRows: ((o.closedRows ?? []) as Row[]).map(c => pick(c, CLOSED)),
  };
}

export function publicCoin(c: Row, s: Secrets, maxWallets = 150, maxTrades = 300) {
  const mine = new Set(s.addresses);
  const wallets = ((c.wallets ?? []) as Row[]).filter(w => !mine.has(String(w.trader))).sort((a, b) => Number(b.held ?? 0) - Number(a.held ?? 0)).slice(0, maxWallets);
  const recent = ((c.recent ?? []) as Row[]).slice(0, maxTrades).map(t => { const r = pick(t, TRADE); if (mine.has(String(t.trader))) r.trader = null; return { ...r, ours: null }; });
  return { ...pick(c, COIN_DETAIL), creator: mine.has(String(c.creator)) ? null : c.creator ?? null, wallets: wallets.map(w => ({ ...pick(w, WALLET), ours: null })), recent,
    candles: ((c.candles ?? []) as Row[]).slice(-720).map(k => pick(k, CANDLE)), fills: ((c.fills ?? []) as Row[]).slice(-200).map(f => pick(f, FILL)) };
}

const KRIS = ["id", "atMs", "kind", "mint", "symbol", "title", "thought", "reaction"];
/** Kris's feed for krisagent.xyz. */
export const publicKris = (events: Row[], max = 120) => [...events.filter(e => e.thought).slice(0, max), ...events.filter(e => !e.thought).slice(0, 30)].map(e => pick(e, KRIS)).sort((a, b) => Number(b.atMs) - Number(a.atMs)); // new coins must not push his thoughts out

const LEAK = /api[-_]?key|helius|x-slrd|bridge-token|privateKey|secretKey/i;
export function assertClean(json: string, s: Secrets) {
  const hit = LEAK.exec(json); if (hit) throw new Error(`refusing to publish: matched ${hit[0]}`);
  if (/"wallet"\s*:/.test(json)) throw new Error("refusing to publish: wallet field");
  for (const a of s.addresses) if (json.includes(a)) throw new Error("refusing to publish: our wallet address");
}
