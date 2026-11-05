/** Smart-wallet entries: buy any coin, at any stage (bonding curve or after migration), when enough
 * followable wallets buy it within a short window. The firehose sees every pump.fun + PumpSwap trade with
 * its wallet; traderStats holds every wallet's per-coin history, rebuilt into a follow list every 10 min.
 *
 * Followable = a wallet that looks like a profitable discretionary trader, not a bot, dev or bundle:
 * only coins it actually bought count (sell-only rows are creator/bundle/transfer tokens), enough of them,
 * net profit, most sold coins in profit, holds minutes (not seconds: arb/snipe bots), few trades per coin,
 * real size.
 *
 * Entry: a 2-step target bot with range [cap/2, cap*2.5]: one step bought at market right away, the second on
 * a 50% dip; each step sells at 2.5x its buy level.
 * Env: SLRD_SMART=0 disables; SLRD_SMART_MIN_WALLETS (2), SLRD_SMART_WINDOW_MIN (30), SLRD_SMART_BUDGET (0.02),
 * SLRD_SMART_MAX (15 open), SLRD_SMART_MIN_CAP (6000), SLRD_SMART_MAX_CAP (2000000), SLRD_SMART_MIN_BUY_SOL (0.1). */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { addBot, readRegistry } from "./bot-registry.ts";
import { decide } from "./migration-watcher.ts";
import type { CoinState } from "./firehose.ts";
import { bundledWallets } from "./bundles.ts";
import { smartEntrySize, staleRange } from "./recenter.ts";
import type { TradeRow } from "./screen.ts";

type StatRow = { trader: string; mint: string; buys: number; sells: number; solIn: number; solOut: number; firstAtMs: number; lastAtMs: number;
  entryCapUsd?: number | null; exitCapUsd?: number | null; tokensBought?: number; tokensSold?: number; lastPriceSol?: number | null };
export type WalletStyle = "holder" | "swing" | "scalper";
export type Followed = { trader: string; coins: number; realizedSol: number; winRate: number; medHoldMin: number; medBuySol: number;
  /** Median exit cap / entry cap over sold coins (2 = sells at twice the cap it bought). */
  medMultiple: number | null; medEntryCapUsd: number | null; medExitCapUsd: number | null;
  /** Median buy/sell round trips per coin (1 = in once, out once). */
  medRoundTrips: number; style: WalletStyle;
  /** Return per coin, open bags marked at the coin's last price: median, worst quarter (p25); p75 of the hold time. */
  medRet: number; p25Ret: number; p75HoldMin: number };

/** How a wallet trades, from its per-coin rows: scalpers flip (many round trips per coin, or exits within a few
 * % of the entry cap), holders ride (one round trip, exits at a multiple), swing in between. */
export function walletStyle(medRoundTrips: number, medMultiple: number | null): WalletStyle {
  // Big-size traders sell at small multiples (CAPn1y: +199 SOL at a median x0.99): the multiple alone does not mark
  // a scalper; flipping (3+ round trips per coin) or consistently exiting under the entry does.
  if (medRoundTrips >= 3 || (medMultiple != null && medMultiple < 0.9)) return "scalper";
  return medRoundTrips <= 1 && medMultiple != null && medMultiple >= 2 ? "holder" : "swing";
}

const env = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)]! : 0; };

/** Relay / router accounts of trading services (e.g. abcdEvo...: 349 coins, 7766 buys, 393 sells, 11.5k SOL in
 * from a 70 SOL wallet): they buy for many users and move the tokens out to them, which the trade stream never
 * shows. Counted as holders they top every coin and inflate top-10 concentration. */
type RelayTotals = { coins: number; buys: number; sells: number; solIn: number; solOut: number };
const isRelay = (a: RelayTotals) => (a.coins >= 50 && a.buys >= 500 && a.sells < a.buys * 0.15) || (a.coins >= 200 && a.solIn >= 1_000 && a.solOut < a.solIn * 0.6);
export function relayWallets(rows: Iterable<StatRow>): Set<string> {
  const agg = new Map<string, RelayTotals>();
  for (const r of rows) { const a = agg.get(r.trader) ?? { coins: 0, buys: 0, sells: 0, solIn: 0, solOut: 0 }; a.coins++; a.buys += r.buys; a.sells += r.sells; a.solIn += r.solIn; a.solOut += r.solOut; agg.set(r.trader, a); }
  const out = new Set<string>();
  // Second shape: routers that also sell a lot (8L2y55: 1034 coins, 16.5k buys, 13.3k sells, 82.8k SOL in, 21.6k out).
  // Most of what they buy leaves by transfer, so their "bought minus sold" is tokens they no longer hold.
  for (const [t, a] of agg) if (isRelay(a)) out.add(t);
  return out;
}

/** Pure: the follow list from per-(wallet, coin) rows. A wallet is judged by how it does per coin, not by lifetime
 * profit (one lucky coin): median return, its worst quarter of coins, and how long it stays. Returns mark open bags at
 * the coin's last price, or a wallet that never sells its losers would look perfect. In a holdout (wallets picked
 * before a cutoff, measured on later coins) the median alone did not beat lifetime profit; requiring the worst
 * quarter to be flat or better did: median wallet +5% (old rule 0%, everyone -9%). */
export function followable(rows: Iterable<StatRow>, now = Date.now()): Map<string, Followed> {
  const byWallet = new Map<string, StatRow[]>(), mark = new Map<string, { price: number; at: number }>();
  let earliest = now;
  for (const r of rows) {
    if (r.lastPriceSol != null && (mark.get(r.mint)?.at ?? 0) < r.lastAtMs) mark.set(r.mint, { price: r.lastPriceSol, at: r.lastAtMs });
    if (r.firstAtMs && r.firstAtMs < earliest) earliest = r.firstAtMs;
    if (countable(r)) (byWallet.get(r.trader) ?? byWallet.set(r.trader, []).get(r.trader)!).push(r);
  }
  const days = Math.max(1, (now - earliest) / 86_400_000), out = new Map<string, Followed>();
  for (const [trader, list] of byWallet) { const f = judge(trader, list, m => mark.get(m)?.price ?? 0, days, now); if (f) out.set(trader, f); }
  return out;
}

/** Sold more than we saw it buy: its entry was before we watched (or a transfer), so its return is meaningless. */
const countable = (r: StatRow) => r.buys > 0 && r.solIn > 0 && !(r.tokensBought != null && r.tokensSold != null && r.tokensSold > r.tokensBought * 1.02);

/** followable and relayWallets without holding the table: `marks` gives each coin's last price and the earliest row
 * (one short pass), `byTrader` is the rows walked one wallet at a time through the index. */
export function followStream(marks: { prices: Map<string, number>; earliest: number }, byTrader: Iterable<StatRow>, now = Date.now()) {
  const list = new Map<string, Followed>(), relays = new Set<string>(), days = Math.max(1, (now - marks.earliest) / 86_400_000);
  let group: StatRow[] = [];
  const close = () => {
    if (!group.length) return;
    const t = group[0]!.trader, a: RelayTotals = { coins: 0, buys: 0, sells: 0, solIn: 0, solOut: 0 };
    for (const r of group) { a.coins++; a.buys += r.buys; a.sells += r.sells; a.solIn += r.solIn; a.solOut += r.solOut; }
    if (isRelay(a)) { relays.add(t); return; }
    const f = judge(t, group.filter(countable), m => marks.prices.get(m) ?? 0, days, now); if (f) list.set(t, f);
  };
  for (const r of byTrader) { if (group.length && group[0]!.trader !== r.trader) { close(); group = []; } group.push(r); }
  close();
  return { list, relays };
}

function judge(trader: string, list: StatRow[], priceOf: (mint: string) => number, days: number, now: number): Followed | null {
  const minMedRet = Number(process.env.SLRD_FOLLOW_MED_RET ?? 0.3), minP25Ret = Number(process.env.SLRD_FOLLOW_P25_RET ?? 0), minP75Hold = Number(process.env.SLRD_FOLLOW_P75_HOLD_MIN ?? 30), minRealized = Number(process.env.SLRD_FOLLOW_MIN_REALIZED_SOL ?? -10);
  const quantile = (xs: number[], p: number) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))]! : 0; };
  const held = (r: StatRow) => Math.max(0, (r.tokensBought ?? 0) - (r.tokensSold ?? 0));
  const coinReturn = (r: StatRow) => (r.solOut + held(r) * priceOf(r.mint)) / r.solIn - 1;
  {
    // Hundreds of coins is a bot sweeping everything (omeg 784, 4oN1 472, Eb3Z 338), not a trader to follow;
    // the traders whose entries held up today trade 10-100.
    if (list.length < 5 || list.length > 200 || list.length / days > 40) return null;
    const sold = list.filter(r => r.sells > 0);
    if (sold.length < 3) return null;
    const realized = sold.reduce((a, r) => a + r.solOut - r.solIn, 0);
    const winRate = sold.filter(r => r.solOut > r.solIn).length / sold.length;
    const medHoldMin = median(sold.map(r => (r.lastAtMs - r.firstAtMs) / 60_000));
    const tradesPerCoin = list.reduce((a, r) => a + r.buys + r.sells, 0) / list.length;
    const medBuySol = median(list.map(r => r.solIn));
    const active = list.some(r => now - r.lastAtMs < 14 * 86_400_000);
    const multiples = sold.filter(r => r.entryCapUsd && r.exitCapUsd).map(r => r.exitCapUsd! / r.entryCapUsd!);
    const medMultiple = multiples.length >= 3 ? median(multiples) : null;
    const medRoundTrips = median(list.map(r => Math.max(1, Math.min(r.buys, r.sells))));
    const style = walletStyle(medRoundTrips, medMultiple);
    const caps = (xs: (number | null | undefined)[]) => { const v = xs.filter((x): x is number => !!x && x > 0); return v.length ? median(v) : null; };
    const returns = list.map(coinReturn), medRet = median(returns), p25Ret = quantile(returns, 0.25);
    const holds = list.map(r => ((r.sells > 0 && (r.tokensSold ?? 0) >= (r.tokensBought ?? 0) * 0.9 ? r.lastAtMs : now) - r.firstAtMs) / 60_000), p75HoldMin = quantile(holds, 0.75);
    // Lifetime profit does not qualify a wallet, but a deep lifetime loss does disqualify it (5YRg: -727 SOL, median +50%).
    if (realized >= minRealized && medRet >= minMedRet && p25Ret >= minP25Ret && p75HoldMin >= minP75Hold && tradesPerCoin <= 15 && medBuySol >= 0.1 && active && style !== "scalper")
      return { trader, coins: list.length, realizedSol: realized, winRate, medHoldMin, medBuySol, medMultiple, medRet, p25Ret, p75HoldMin,
        medEntryCapUsd: caps(list.map(r => r.entryCapUsd)), medExitCapUsd: caps(sold.map(r => r.exitCapUsd)), medRoundTrips, style };
  }
  return null;
}

export function startSmartEntry(o: { /** True while entries are off: skips the full table read. */ paused?: () => boolean; root: string; guard?: (mint: string, stepSol: number) => Promise<string | null>;
  /** Tokens a wallet holds in a coin right now (TraderBook): the signal wallets must still be in when we buy. */
  holding?: (trader: string, mint: string) => number; log: (t: string) => void; symbolFor: (mint: string) => string | null | undefined }) {
  if (process.env.SLRD_SMART === "0") { o.log("smart-wallet entries disabled (SLRD_SMART=0)"); return null; }
  const minWallets = env("SLRD_SMART_MIN_WALLETS", 2), windowMs = env("SLRD_SMART_WINDOW_MIN", 30) * 60_000;
  const budget = process.env.SLRD_SMART_BUDGET ?? process.env.SLRD_AUTO_BUDGET ?? "0.05", max = env("SLRD_MAX_POSITIONS", 100); // one limit for every position; SOL is the real one (reserve check)
  const minCap = env("SLRD_SMART_MIN_CAP", 6_000), maxCap = env("SLRD_SMART_MAX_CAP", 2_000_000), minBuy = env("SLRD_SMART_MIN_BUY_SOL", 0.1);
  let follow = new Map<string, Followed>();
  let relays = new Set<string>();
  // Off the event loop: reading 1.8M rows blocks for ~17s, which would freeze every bot meanwhile.
  let building = false;
  const rebuild = () => {
    // Reads all of traderStats into memory (12-30 GB, enough to kill everything on this machine): only when entries can use it.
    if (building || o.paused?.()) return; building = true;
    const t0 = Date.now(), worker = new Worker(new URL("./smart-follow-worker.ts", import.meta.url).href);
    worker.onmessage = (m: MessageEvent<{ ok: boolean; list?: Followed[]; relays?: string[]; error?: string }>) => {
      building = false; worker.terminate();
      if (!m.data.ok) { o.log(`smart wallets: rebuild failed: ${m.data.error?.slice(0, 120)}`); return; }
      follow = new Map(m.data.list!.map(w => [w.trader, w]));
      relays = new Set(m.data.relays ?? []);
      try { const p = resolve(o.root, ".range-bots", "relay-wallets.json"); writeFileSync(p + ".tmp", JSON.stringify([...relays])); renameSync(p + ".tmp", p); } catch {}
      // For the web/CLI coin view: tag followable wallets.
      try { const p = resolve(o.root, ".range-bots", "smart-wallets.json"); writeFileSync(p + ".tmp", JSON.stringify(m.data.list)); renameSync(p + ".tmp", p); } catch {}
      o.log(`smart wallets: ${follow.size} followable (rebuilt in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    };
    worker.onerror = e => { building = false; worker.terminate(); o.log(`smart wallets: worker failed: ${e.message}`); };
    worker.postMessage(null);
  };
  setTimeout(rebuild, 20_000).unref?.();
  setInterval(rebuild, 10 * 60_000).unref?.();

  /** mint -> followable wallet -> time of its buy (within the window). */
  const entries = new Map<string, Map<string, number>>();
  const done = new Set<string>(); // decided (opened, or rejected for good) once per coin per run
  const retryAt = new Map<string, number>(); // temporarily skipped: earliest re-check
  const groups = new Map<string, number>(); // wallet group -> last time it triggered an entry
  const used = new Map<string, number[]>();  // wallet -> times it triggered an entry
  const nameOf = (mint: string) => o.symbolFor(mint) || mint.slice(0, 6);

  const onTrade = (mint: string, row: TradeRow, coin: CoinState) => {
    if (row.side !== "buy" || !row.trader || !(Number(row.sol) >= minBuy) || done.has(mint) || (retryAt.get(mint) ?? 0) > Date.now()) return;
    const f = follow.get(row.trader); if (!f) return;
    // Part of a same-second, same-size buy group: one operator's bundle, not an independent smart wallet.
    const bundled = bundledWallets(coin.recent ?? []);
    if (bundled.has(row.trader)) { o.log(`SMART ${nameOf(mint)} ${mint.slice(0, 6)}: ${row.trader.slice(0, 4)} not counted, part of a same-second same-size buy bundle (${bundled.size} wallets)`); return; }
    const now = Date.now(), seen = entries.get(mint) ?? entries.set(mint, new Map()).get(mint)!;
    seen.set(row.trader, now);
    for (const [w, at] of seen) if (now - at > windowMs) seen.delete(w);
    if (seen.size < minWallets) return;
    // Independent wallets only: buys within 5s of each other are one block / one bundle, i.e. one operator.
    const byTime = [...seen].sort((x, y) => x[1] - y[1]), independent: string[] = [];
    for (const [w, at] of byTime) if (!independent.length || at - seen.get(independent[independent.length - 1]!)! >= 5_000) independent.push(w);
    if (independent.length < minWallets) return;
    // The same group of wallets entering coin after coin is a copy-trade group or one operator: count it once an hour.
    const group = [...seen.keys()].sort().join(",");
    if (now - (groups.get(group) ?? 0) < 3_600_000) { done.add(mint); return void o.log(`SMART ${nameOf(mint)} ${mint.slice(0, 6)}: ignored, same wallet group (${[...seen.keys()].map(w => w.slice(0, 4)).join("+")}) already entered another coin this hour`); }
    // A wallet that apes into everything is not a signal: each wallet counts for at most 2 entries an hour.
    const busy = [...seen.keys()].filter(w => (used.get(w) ?? []).filter(t => now - t < 3_600_000).length >= 2);
    if (seen.size - busy.length < minWallets) { if (busy.length) o.log(`SMART ${nameOf(mint)} ${mint.slice(0, 6)}: not counted, ${busy.map(w => w.slice(0, 4)).join("+")} already triggered 2 entries this hour`); return; }
    groups.set(group, now);
    for (const w of seen.keys()) used.set(w, [...(used.get(w) ?? []).filter(t => now - t < 3_600_000), now]);
    done.add(mint);
    const wallets = [...seen.keys()].map(w => follow.get(w)!);
    const who = wallets.map(w => `${w.trader.slice(0, 4)} (+${w.realizedSol.toFixed(0)} SOL, ${(w.winRate * 100).toFixed(0)}%)`).join(", ");
    const cap = (coin.ammTrades ? coin.ammCapUsd : coin.capUsd) ?? 0;
    const stage = coin.migrated ? "migrated" : "curve";
    const registry = readRegistry(o.root), name = nameOf(mint);
    // A skip for something that can change (slots, cap, our RPC, signal wallets) is not final: the next followable
    // buy re-checks the coin (at most every 2 min). Bundles, top-10 concentration and honeypots stay final.
    const skip = (reason: string) => {
      const final = /first-3s buyers|top 10 wallets|honeypot:/.test(reason);
      if (!final) { done.delete(mint); retryAt.set(mint, Date.now() + 120_000); }
      decide({ mint, name, decision: "skipped", reason: `smart: ${reason}${final ? "" : " (re-checked on the next followable buy)"}; ${who}` });
      o.log(`SMART ${name} ${mint.slice(0, 6)}: skipped, ${reason}${final ? "" : " (will re-check)"}`);
    };
    if (registry.some(b => b.mint === mint)) return; // already ours
    // Bonding-curve coins under $10k: a dev bundle dump takes them under the dead-coin line before any rebound.
    if (!coin.migrated && cap < env("SLRD_SMART_MIN_CURVE_CAP", 10_000)) return skip(`curve cap ${(cap / 1000).toFixed(1)}k under ${env("SLRD_SMART_MIN_CURVE_CAP", 10_000) / 1000}k`);
    if (!(cap >= minCap && cap <= maxCap)) return skip(`cap $${(cap / 1000).toFixed(1)}k outside $${minCap / 1000}k-${maxCap / 1000}k`);
    const wallet = process.env.SLRD_AUTO_WALLET ?? registry[0]?.wallet;
    if (!wallet) return skip("no wallet");
    // A slot is taken by a smart bot that holds tokens or was opened in the last 30 min. Bots that never got a
    // fill (signal missed, coin ran away) used to keep their slot forever: 15/15 "open" while holding nothing.
    // Holding = tokens on the wallet, or a confirmed trade (flow). A bot that hit errors before its first read saves
    // balanceRaw null: that is not a position (counting it kept 15/15 "open" with nothing held and skipped GOAT, BWAH).
    const holds = (b: { wallet: string; mint: string; amount?: string }) => { try { const st = JSON.parse(readFileSync(resolve(o.root, ".range-bots", `target-${b.wallet}-${b.mint}.json`), "utf8")); // Sized down to a quarter (its followable wallets all left: winding down) -> it no longer takes a slot.
      if (typeof st.budgetSol === "number" && st.budgetSol < Number((b as { amount?: string }).amount ?? 0) * 0.5) return false;
      return (st.balanceRaw != null && st.balanceRaw !== "0") || Math.abs(st.flowSol ?? 0) > 0; } catch { return false; } };
    const open = registry.length; // one limit: bots and positions are the same thing
    if (open >= max) return skip(`${open}/${max} positions open`);
    const round = (v: number) => Math.round(v / 100) * 100;
    // 4 steps of 25% of the signal cap: the 2 steps above the price are bought at once, the first sells at +35%,
    // the next at +60%; dips add at -15% and -40%. (2 steps over 0.5x-2.5x put the first sale at 2.3x the entry.)
    const buy = round(cap * 0.6), sell = round(cap * 1.6);
    void (async () => {
    const size = String(smartEntrySize(Number(budget), wallets.length));
    const veto = await o.guard?.(mint, Number(size) / 4).catch(e => `entry check failed: ${e instanceof Error ? e.message : e}`);
    if (veto) return skip(veto);
    // Scalpers flip in seconds (Kira: omeg bought and sold 8s later, before our buy). Enter only if enough of the
    // signal wallets still hold after the checks above.
    if (o.holding) {
      const still = wallets.filter(w => o.holding!(w.trader, mint) > 0).length;
      if (still < minWallets) return skip(`signal wallets already sold (${still}/${wallets.length} still holding)`);
    }
    const path = resolve(o.root, "ranges", `${wallet}-${mint}.json`);
    if (staleRange(path, cap)) writeFileSync(path, JSON.stringify({ buyMarketCapUsd: String(buy), sellMarketCapUsd: String(sell), steps: 4 }, null, 2) + "\n");
    addBot(o.root, { wallet, mint, amount: size, mode: "target", auto: true, smart: true, signal: wallets.map(w => w.trader) });
    o.log(`SMART ${name} ${mint} (${stage}): ${wallets.length} followable wallets bought: ${who}; cap $${(cap / 1000).toFixed(1)}k, range ${buy / 1000}-${sell / 1000}k x4, ${size} SOL`);
    decide({ mint, name, decision: "opened", reason: `smart wallets (${stage}, cap ${(cap / 1000).toFixed(1)}k): ${who}` });
    })();
  };
  o.log(`smart-wallet entries on: ${minWallets}+ followable wallets within ${windowMs / 60_000} min, cap $${minCap / 1000}k-${maxCap / 1000}k, ${budget} SOL, max ${max} open`);
  return { onTrade, followed: () => follow, relays: () => relays, watching: () => entries };
}
