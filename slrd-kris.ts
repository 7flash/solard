/** Kris: watches what happens on its wallet (fills, new positions, entry decisions) and writes each one down with a
 * short thought from the Codex runtime in jsx-ai. Output: .range-bots/kris-events.json, newest first, read by the Kris
 * view. Only coin facts go to Codex: no wallet names, addresses or keys. Thoughts run one at a time; an event that
 * finds Kris busy simply has no thought.
 *   bun run slrd-kris.ts   (JSX_AI_PATH: jsx-ai entry, default ../jsx-ai/src/index.ts) */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { appendFileSync } from "node:fs";
import { bundleShare, type BuyRow } from "./tui/bundles.ts";
import { startOutcome, stepOutcome, type Outcome } from "./tui/kris-outcomes.ts";
import { freshMigration, planSlots, slotKeepsRange, slotQualifies, SLOT_CONFIG, type Slot, type SlotCoin, type SlotKind } from "./tui/kris-slots.ts";
import { coinVerdict, lastFill, rangeSide, rangeTitle, scrubReason, tradeReaction, tradeTitle, type KrisEvent } from "./webapp/public/kris-events.ts";

process.env.JSX_AI_RUNTIME ??= "codex";
process.env.JSX_AI_MODEL ??= "gpt-5.6-sol"; // the local codex default is rejected by the API
const dot = resolve(import.meta.dir, ".range-bots"), token = readFileSync(resolve(dot, "bridge-token"), "utf8").trim(), out = resolve(dot, "kris-events.json");
const { streamLLM } = await import(process.env.JSX_AI_PATH ?? resolve(import.meta.dir, "..", "jsx-ai", "src", "index.ts")) as { streamLLM: (m: { role: string; content: string }[], o: { timeoutMs: number }) => AsyncIterable<string> };
const KEEP = 100, KEEP_COINS = 100, KEEP_THOUGHTS = 500, THOUGHT_GAP_MS = 4_000;
const SYSTEM = "You are Kris, a young trader whose memecoin positions on Solana are run by rules on the Solard terminal. You do not choose trades: the rules do. Your job is to look back honestly at how they went, thinking out loud, and you feel every result: a win makes you buzz, a loss stings, a rug makes you angry. "
  + "Open with how this result feels in your own plain words, then say why it worked or failed, using the facts given: how long it was held, what the range caught, what the flow and holders did, and what that says about this kind of coin. End with the one lesson you take from it. "
  + "Never recommend a trade or say what you will do next: you are reviewing, not deciding. Earlier thoughts are given so you can spot patterns across results; never repeat one or copy their mood. At most three sentences, first person, plain words. "
  + "Your feelings are yours, but the facts are not: use only the facts given and never invent a number. Talk about the coin and the market only: never mention data, missing information, context, tools or bugs. A fact that is absent is simply not discussed. No hashtags, no emojis, no advice to the reader.";

type Bot = { wallet: string; mint: string; symbol?: string | null; capUsd?: number | null; range?: { buy: number; sell: number } | null; steps?: number; holdingSteps?: number; vol1hSol?: number | null; pnl?: number; lastTradeAtMs?: number | null };
type Decision = { atMs: number; mint: string; name: string; symbol?: string | null; decision: string; reason: string };

let events: KrisEvent[] = []; try { events = JSON.parse(readFileSync(out, "utf8")); } catch {}
const isCoin = (e: KrisEvent) => e.kind === "coin" || e.kind === "migrated";
/** Thoughts are the history: they are kept apart from the flood of events that carry none. */
const trimmed = () => [...events.filter(e => e.thought).slice(0, KEEP_THOUGHTS), ...events.filter(e => !e.thought && isCoin(e)).slice(0, KEEP_COINS), ...events.filter(e => !e.thought && !isCoin(e)).slice(0, KEEP)].sort((a, b) => b.atMs - a.atMs);
const save = () => { const kept = trimmed(); writeFileSync(`${out}.tmp`, JSON.stringify(kept)); try { renameSync(`${out}.tmp`, out); } catch { /* Windows: a reader has it open; the next save writes it */ } };
const add = (e: Omit<KrisEvent, "id">) => { const ev = { ...e, id: `${e.atMs}-${e.kind}-${e.mint}` }; if (events.some(x => x.id === ev.id)) return null; events.unshift(ev); events = trimmed(); save(); return ev; };

/** Trades and range moves wait their turn; a new coin gets a thought only when nothing else is waiting. */
type Closed = { symbol: string | null; mint: string; pnlSol: number; pct: number | null; closedAt: number; openedAt: number | null };
/** How the last positions really ended, so a read can be checked against results. */
let results: unknown = null;
function trackRecord(rows: Closed[]) {
  const last = rows.slice(0, 12), wins = last.filter(r => r.pnlSol > 0).length;
  return last.length ? { lastClosed: last.length, won: wins, solResult: Math.round(last.reduce((a, r) => a + r.pnlSol, 0) * 1000) / 1000, worst: [...last].sort((a, b) => a.pnlSol - b.pnlSol).slice(0, 3).map(r => ({ coin: r.symbol ?? r.mint.slice(0, 6), pct: r.pct == null ? null : Math.round(r.pct), heldMin: r.openedAt ? Math.round((r.closedAt - r.openedAt) / 60_000) : null })) } : null;
}
const waiting: { ev: KrisEvent; facts: Record<string, unknown> }[] = []; let thinking = false;
const thoughtAt = new Map<string, number>();
function think(ev: KrisEvent, facts: Record<string, unknown>) {
  if (ev.kind === "trade" && Date.now() - (thoughtAt.get(ev.mint) ?? 0) < 60_000) return; // one thought a minute per coin keeps Codex within its limit
  thoughtAt.set(ev.mint, Date.now());
  const minor = ev.kind === "coin" || ev.kind === "migrated";
  if (minor ? thinking || waiting.length > 0 : waiting.length >= 4) return;
  waiting.push({ ev, facts }); void drainThoughts();
}
async function drainThoughts() {
  if (thinking) return; thinking = true;
  for (let job = waiting.shift(); job; job = waiting.shift()) {
    const gloomy = /burned|bruis|sting|bites|bitter|licking/i, earlier = events.filter(e => e.thought && e.id !== job.ev.id && e.kind !== "coin" && e.kind !== "migrated" && !gloomy.test(e.thought)).slice(0, 4).map(e => ({ coin: e.symbol ?? e.mint.slice(0, 6), event: e.title, thought: e.thought }));
    try {
      const context = job.ev.kind === "coin" || job.ev.kind === "migrated" ? null : await coinContext(job.ev.mint);
      for (let attempt = 1; attempt <= 2; attempt++) try { // the Codex runtime sometimes exits mid-turn: one more try
        let text = "";
        for await (const chunk of streamLLM([{ role: "system", content: SYSTEM }, { role: "user", content: JSON.stringify({ ...job.facts, context, myRecentResults: results, oddsForCoinsLikeThese: newPairOdds(), earlierThoughts: earlier }) }], { timeoutMs: 60_000 })) {
          text += chunk; job.ev.thought = text; save();
        }
        break;
      } catch (e) { if (attempt === 2) throw e; await Bun.sleep(1_500); }
    } catch (e) { console.log(`${new Date().toISOString()} thought failed: ${String(e).slice(0, 160)}`); if (job.ev.kind === "result" || job.ev.kind === "review" || job.ev.kind === "trade") { job.ev.thought ??= job.ev.title; save(); } } // no Codex: results still reach the history
    await Bun.sleep(THOUGHT_GAP_MS);
  }
  thinking = false;
}
/** What a trader would look at before forming a view, from the terminal's own coin API. */
async function coinContext(mint: string) {
  const r = await fetch(`http://127.0.0.1:5176/api/coin?mint=${mint}`, { headers: { cookie: `slrd_web=${token}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!r?.ok) return null;
  const c = await r.json() as { candles?: { m: number; h: number; l: number; c: number; v: number }[]; recent?: { side: string; sol: number | null; ours?: unknown; smart?: boolean }[]; wallets?: { pct: number; held: number; smart?: boolean | null; ours?: unknown; delta5?: { tokens: number } | null }[]; holders?: number; walletCount?: number; exact?: boolean };
  const k = c.candles ?? [], now = k[k.length - 1]?.c, ago = (n: number) => k[k.length - 1 - n]?.c, move = (n: number) => now && ago(n) ? Math.round((now / ago(n)! - 1) * 1000) / 10 : null;
  const hour = k.slice(-60), flow = (c.recent ?? []).slice(0, 100), sum = (side: string) => Math.round(flow.filter(t => t.side === side).reduce((a, t) => a + (t.sol ?? 0), 0) * 10) / 10;
  // Holdings are only true when they are exact; the estimate from trades can add up to over 100%.
  const top = (c.wallets ?? []).filter(w => w.pct > 0 && !w.ours).sort((a, b) => b.pct - a.pct).slice(0, 10), selling = top.filter(w => (w.delta5?.tokens ?? 0) < 0).length, buying = top.filter(w => (w.delta5?.tokens ?? 0) > 0).length;
  const holders = c.exact ? { holders: c.holders ?? null, top10HolderPct: Math.round(top.reduce((a, w) => a + w.pct, 0) * 10) / 10, smartHolders: (c.wallets ?? []).filter(w => w.smart && w.held > 0).length } : {};
  return { ...holders, pctChange: { m5: move(5), m15: move(15), h1: move(60) }, hourHighUsd: hour.length ? Math.round(Math.max(...hour.map(x => x.h))) : null, hourLowUsd: hour.length ? Math.round(Math.min(...hour.map(x => x.l))) : null, solVolumeLast30Candles: Math.round(k.slice(-30).reduce((a, x) => a + x.v, 0)),
    last100Trades: { buySol: sum("buy"), sellSol: sum("sell"), smartTrades: flow.filter(t => t.smart).length }, wallets: c.walletCount ?? null,
    ...(selling || buying ? { topHoldersSellingLast5Min: selling, topHoldersBuyingLast5Min: buying } : {}) };
}

const facts = (b: Bot) => ({ coin: b.symbol ?? b.mint.slice(0, 6), capUsd: b.capUsd ? Math.round(b.capUsd) : null, rangeUsd: b.range ? [b.range.buy, b.range.sell] : null,
  steps: b.steps, stepsHeld: b.holdingSteps, volumeSolPerHour: b.vol1hSol ? Math.round(b.vol1hSol) : null, coinPnlSol: b.pnl != null ? Number(b.pnl.toFixed(4)) : null });

if (process.argv[2] === "--test") {
  const ev: KrisEvent = { id: "test", atMs: Date.now(), kind: "trade", mint: "test", symbol: "TEST", title: "Bought 0.01 SOL" };
  think(ev, { event: "bought", sol: 0.01, coin: "TEST", capUsd: 42000, rangeUsd: [36000, 50000], stepsHeld: 2, steps: 3 });
  while (thinking || waiting.length) await Bun.sleep(200);
  console.log(ev.thought ?? "no thought"); process.exit(0);
}

type Coin = SlotCoin;
// Kris's positions, through the terminal API only. An empty file named kris-slots-off stops all opening and closing.
const slotsPath = resolve(dot, "kris-slots.json"), offPath = resolve(dot, "kris-slots-off"), BRIDGE = "http://127.0.0.1:5174";
type SlotBook = { slots: Slot[]; closedAt: [string, number][]; lastActionMs: number; lastSwapMs: number; pendingKind: SlotKind | null };
let book: SlotBook = { slots: [], closedAt: [], lastActionMs: 0, lastSwapMs: 0, pendingKind: null };
try { book = { ...book, ...JSON.parse(readFileSync(slotsPath, "utf8")) }; } catch {}
book.slots = [...new Map(book.slots.map(s => [s.mint, s])).values()];
const saveBook = () => { writeFileSync(`${slotsPath}.tmp`, JSON.stringify(book)); renameSync(`${slotsPath}.tmp`, slotsPath); };
const migratedAt = new Map<string, number>(); let wallet: { name: string; sol: number } | null = null, walletAt = 0;
async function myWallet() {
  if (wallet && Date.now() - walletAt < 15_000) return wallet;
  const s = await (await fetch(`${BRIDGE}/api/state`, { headers: { "x-slrd-token": token }, signal: AbortSignal.timeout(10_000) })).json() as { bots?: { wallet: string }[]; wallets?: { name: string; sol?: number }[] };
  const name = process.env.KRIS_WALLET ?? s.bots?.[0]?.wallet; if (!name) throw new Error("no wallet to trade from");
  wallet = { name, sol: s.wallets?.find(w => w.name === name)?.sol ?? 0 }; walletAt = Date.now(); return wallet;
}
async function act(body: Record<string, unknown>) {
  const w = await myWallet(), r = await fetch(`${BRIDGE}/api/bot`, { method: "POST", headers: { "x-slrd-token": token, "content-type": "application/json" }, body: JSON.stringify({ wallet: w.name, ...body }), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`${body.action}: ${r.status} ${(await r.text()).slice(0, 100)}`);
}
/** What really happened to coins like these, from the tracker. Read once every few minutes. */
let odds: unknown = null, oddsAt = 0;
function newPairOdds() {
  if (Date.now() - oddsAt < 300_000) return odds; oddsAt = Date.now();
  try {
    const rows = readFileSync(resolve(dot, "kris-outcomes.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l) as Outcome).filter(o => o.kind === "coin" && slotQualifies({ capUsd: o.cap, traders: o.wallets, trades: o.trades }, "new"));
    const share = (n: number) => Math.round(n / rows.length * 100), timed = rows.filter(o => o.upMin != null || o.downMin != null);
    odds = rows.length < 20 ? null : { similarCoinsTracked: rows.length, reachedPlus30Pct: share(rows.filter(o => o.high >= o.cap * 1.3).length), fellMinus30Pct: share(rows.filter(o => o.low <= o.cap * 0.7).length), ...(timed.length >= 20 ? { wentUpBeforeDownPct: Math.round(timed.filter(o => o.upMin != null && (o.downMin == null || o.upMin < o.downMin)).length / timed.length * 100) } : {}) };
  } catch { odds = null; }
  return odds;
}
/** Thoughts come from results: every closed position, and a look over the last ones every 15 minutes. */
const seenClosed = new Set<string>(); let reviewedAt = Date.now();
function reviewClosed(rows: Closed[], live: boolean) {
  for (const r of [...rows].reverse()) {
    const key = `${r.mint}${r.closedAt}`; if (seenClosed.has(key)) continue; seenClosed.add(key); if (!live) continue;
    const coin = r.symbol ?? r.mint.slice(0, 6), heldMin = r.openedAt ? Math.round((r.closedAt - r.openedAt) / 60_000) : null, sign = r.pnlSol >= 0 ? "+" : "";
    const ev = add({ atMs: r.closedAt, kind: "result", mint: r.mint, symbol: r.symbol, title: `Closed ${coin}: ${sign}${r.pnlSol.toFixed(4)} SOL${r.pct == null ? "" : ` (${sign}${Math.round(r.pct)}%)`}`, reaction: r.pnlSol >= 0 ? "profit" : "loss" });
    if (ev) think(ev, { event: "position closed", coin, solResult: Number(r.pnlSol.toFixed(4)), pct: r.pct == null ? null : Math.round(r.pct), heldMinutes: heldMin });
  }
  if (!live || Date.now() - reviewedAt < 900_000 || !rows.length) return;
  reviewedAt = Date.now();
  const last = rows.slice(0, 12), won = last.filter(r => r.pnlSol > 0).length, sum = last.reduce((a, r) => a + r.pnlSol, 0), worst = [...last].sort((a, b) => a.pnlSol - b.pnlSol)[0]!;
  const ev = add({ atMs: Date.now(), kind: "review", mint: worst.mint, symbol: "Review", title: `Last ${last.length} closed: ${won} won, ${sum >= 0 ? "+" : ""}${sum.toFixed(3)} SOL` });
  if (ev) think(ev, { event: "looking back over the last closed positions for a pattern" });
}
const closing = new Map<string, number>(), missingSince = new Map<string, number>(), lastSeen = new Map<string, number>(), pendingSide = new Map<string, { side: string; at: number }>(), reportedAt = new Map<string, number>();
async function runSlots(bots: Bot[], coins: Coin[]) {
  if (existsSync(offPath)) return;
  const held = new Set(bots.map(b => b.mint));
  try { const keep = new Set(JSON.parse(readFileSync(resolve(dot, "kris-keep.json"), "utf8")) as string[]), left = book.slots.filter(s => !keep.has(s.mint)); if (left.length !== book.slots.length) { book.slots = left; saveBook(); } } catch {}
  // A position closed from anywhere else leaves its slot.
  if (!bots.length) return; // the daemon is restarting
  for (const s of book.slots) if (held.has(s.mint)) missingSince.delete(s.mint); else if (!missingSince.has(s.mint)) missingSince.set(s.mint, Date.now());
  const gone = book.slots.filter(s => Date.now() - (missingSince.get(s.mint) ?? Infinity) > 180_000);
  if (gone.length) { book.slots = book.slots.filter(s => !gone.includes(s)); saveBook(); }
  const w = await myWallet(), now = Date.now(), listed = new Set(coins.map(c => c.mint));
  for (const s of book.slots) if (listed.has(s.mint) || !lastSeen.has(s.mint)) lastSeen.set(s.mint, now);
  for (const [mint, at] of closing) { if (!held.has(mint)) closing.delete(mint); else if (now - at > 60_000) { closing.set(mint, now); await act({ action: "stop", mint }); } } // the sale failed: again
  const a = planSlots({ coins, slots: book.slots, heldMints: held, closedAt: new Map(book.closedAt), migratedAt, freeSol: w.sol, nowMs: now, lastActionMs: book.lastActionMs, lastSwapMs: book.lastSwapMs, pendingKind: book.pendingKind, lastSeen, emptyMints: new Set(bots.filter(b => (b.holdingSteps ?? 0) === 0).map(b => b.mint)) });
  if (!a) return;
  if (a.type === "close") {
    // Buys off first: a sale that fails must not leave the bot buying with no slot watching it.
    const keepOnRange = slotKeepsRange(bots.find(b => b.mint === a.slot.mint)?.holdingSteps);
    if (!keepOnRange) { await act({ action: "pause", mint: a.slot.mint }); await act({ action: "remove", mint: a.slot.mint }); } // nothing to sell: a stop would fail and restart the bot
    book.slots = book.slots.filter(s => s.mint !== a.slot.mint); book.closedAt = [...book.closedAt.filter(([, at]) => now - at < SLOT_CONFIG.reopenAfterMs), [a.slot.mint, now]];
    book.lastActionMs = now; if (a.forSwap) { book.lastSwapMs = now; book.pendingKind = a.slot.kind; } saveBook();
    const ev = add({ atMs: now, kind: "decision", mint: a.slot.mint, symbol: a.slot.symbol, title: keepOnRange ? `Slot freed, range keeps it: ${a.reason}` : `Closing: ${a.reason}` });
    return;
  }
  const c = a.coin; let budget = a.kind === "migrated" ? SLOT_CONFIG.migratedBudgetSol : SLOT_CONFIG.budgetSol;
  // The terminal's bundle filter. No answer means no buy.
  const r = await fetch(`http://127.0.0.1:5176/api/coin?mint=${c.mint}&watch=0`, { headers: { cookie: `slrd_web=${token}` }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`coin read: ${r.status}`);
  const info = await r.json() as { recent?: BuyRow[]; earlyBoughtPct?: number | null; wallets?: { pct: number; ours?: boolean }[] }, tops = (info.wallets ?? []).filter(w => w.pct > 0 && !w.ours).map(w => w.pct).sort((x, y) => y - x), share = bundleShare(info.recent ?? []), early = info.earlyBoughtPct ?? 100; // unknown counts as bundled
  if (share >= SLOT_CONFIG.maxBundleShare || early >= SLOT_CONFIG.maxEarlyPct) {
    book.closedAt = [...book.closedAt.filter(([, at]) => now - at < SLOT_CONFIG.reopenAfterMs), [c.mint, now]]; saveBook();
    add({ atMs: now, kind: "coin", mint: c.mint, symbol: c.symbol ?? null, title: `Bundle: skip, ${Math.round(share * 100)}% of wallets bought together, ${Math.round(early)}% of supply bought in the first 3s` });
    return;
  }
  if (early >= SLOT_CONFIG.smallEarlyPct || share >= SLOT_CONFIG.smallBundleShare) budget = SLOT_CONFIG.minSizeSol; // signs of a bundle: still plays, at the smallest size
  await act({ action: "add", mint: c.mint, buy: a.buy, sell: a.sell, steps: SLOT_CONFIG.steps, budget });
  // Every open with what was known at entry: joined with closed-pnl.jsonl, this shows which entries really pay. Events age out; this does not.
  appendFileSync(resolve(dot, "kris-slots-log.jsonl"), JSON.stringify({ at: now, mint: c.mint, symbol: c.symbol ?? null, kind: a.kind, sol: budget, cap: c.capUsd ?? null, ageMs: c.ageMs ?? null, wallets: c.traders ?? 0, trades: c.trades ?? 0, volSol: c.volSol ?? 0, smart: c.smart ?? 0, score: a.score, early, share, topHolderPct: tops[0] ?? null, top3HolderPct: tops.slice(0, 3).reduce((x, y) => x + y, 0), buy: a.buy, sell: a.sell, swap: a.swap }) + String.fromCharCode(10));
  book.slots = book.slots.filter(s => s.mint !== c.mint);
  book.slots.push({ mint: c.mint, symbol: c.symbol ?? null, kind: a.kind, openedAtMs: now, score: a.score, buy: a.buy, sell: a.sell });
  book.lastActionMs = now; if (book.pendingKind === a.kind) book.pendingKind = null; saveBook(); seenBots.add(c.mint); walletAt = 0;
  const ev = add({ atMs: now, kind: "position", mint: c.mint, symbol: c.symbol ?? null, title: `${a.swap ? "Swapped into" : "Opened"} ${a.kind === "new" ? "new pair" : "migration"}, ${budget} SOL`, reaction: "ape" });
}
const seenTrade = new Map<string, number>(), seenBots = new Set<string>(), sides = new Map<string, string>(), seenCoins = new Map<string, boolean>(); let lastDecision = 0, seeded = false;
/** Every judged coin, followed for 30 minutes through the terminal's coin list. */
const followPath = resolve(dot, "kris-following.json"); let following: Outcome[] = [], followedAt = 0;
try { following = JSON.parse(readFileSync(followPath, "utf8")); } catch {}
function followCoins(coins: Coin[]) {
  if (Date.now() - followedAt < 10_000) return; followedAt = Date.now();
  const caps = new Map(coins.map(c => [c.mint, c.capUsd ?? null]));
  following = following.filter(o => { if (!stepOutcome(o, caps.get(o.mint) ?? null, Date.now())) return true; appendFileSync(resolve(dot, "kris-outcomes.jsonl"), JSON.stringify(o) + "\n"); return false; });
  writeFileSync(`${followPath}.tmp`, JSON.stringify(following)); renameSync(`${followPath}.tmp`, followPath);
}
/** Trades come first: a coin gets a thought only when Kris is free. Its call is in the title either way. */
function coinEvent(c: Coin, migrated: boolean) {
  const v = coinVerdict(c), started = startOutcome(c, migrated ? "migrated" : "coin", v.verdict, Date.now()); if (started) following.push(started);
  const ev = add({ atMs: Date.now(), kind: migrated ? "migrated" : "coin", mint: c.mint, symbol: c.symbol ?? null, title: `${migrated ? "Migrated" : "New coin"}: ${v.verdict}, ${v.reason}` });
}
for (;;) {
  try {
    const r = await fetch("http://127.0.0.1:5176/api/overview", { headers: { cookie: `slrd_web=${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`overview ${r.status}`);
    const ov = await r.json() as { bots: Bot[]; decisions?: Decision[]; coins?: Coin[]; young?: Coin[]; closedRows?: Closed[] }, decisions = ov.decisions ?? [];
    results = trackRecord(ov.closedRows ?? []);
    reviewClosed(ov.closedRows ?? [], seeded);
    for (const b of ov.bots.filter(x => !(x as { inactive?: boolean }).inactive)) {
      const at = b.lastTradeAtMs ?? 0, prev = seenTrade.get(b.mint);
      if (seeded && !seenBots.has(b.mint)) { const ev = add({ atMs: Date.now(), kind: "position", mint: b.mint, symbol: b.symbol ?? null, title: "New position", reaction: "ape" }); }
      seenBots.add(b.mint);
      if (seeded && at && at > (prev ?? 0)) {
        const path = resolve(dot, `term-${b.wallet}-${b.mint}.log`), fill = existsSync(path) ? lastFill(readFileSync(path, "utf8")) : null;
        const ev = add({ atMs: at, kind: "trade", mint: b.mint, symbol: b.symbol ?? null, title: tradeTitle(fill), reaction: tradeReaction(fill?.side ?? null, b.holdingSteps ?? 0, b.pnl ?? 0) ?? undefined });
        if (ev && fill?.side === "SELL") void think(ev, { event: "sold", sol: fill?.sol ?? null, ...facts(b) });
      }
      if (at) seenTrade.set(b.mint, Math.max(at, prev ?? 0));
      if (b.capUsd && b.range) {
        // A price sitting on a range edge crosses it every few seconds: it counts once it has stayed 20s, and at most every 2 min.
        const side = rangeSide(b.capUsd, b.range), was = sides.get(b.mint), now = Date.now();
        if (side === was) pendingSide.delete(b.mint); else if (pendingSide.get(b.mint)?.side !== side) pendingSide.set(b.mint, { side, at: now });
        const settled = (pendingSide.get(b.mint)?.at ?? now) <= now - 20_000 && now - (reportedAt.get(b.mint) ?? 0) >= 120_000;
        if (seeded && was && was !== side && settled) {
          reportedAt.set(b.mint, now); pendingSide.delete(b.mint); const ev = add({ atMs: Date.now(), kind: "range", mint: b.mint, symbol: b.symbol ?? null, title: rangeTitle(side, b.capUsd, b.range), reaction: side === "inside" ? undefined : "hold" }); }
        if (!was || settled) sides.set(b.mint, side);
      }
    }
    for (const c of ov.coins ?? []) {
      const was = seenCoins.get(c.mint), migrated = !!c.migrated;
      const fresh = freshMigration(was, migrated);
      if (seeded && (fresh || (was === undefined && !migrated))) { coinEvent(c, migrated); if (fresh) migratedAt.set(c.mint, Date.now()); }
      seenCoins.set(c.mint, migrated);
    }
    const known = [...new Map([...(ov.coins ?? []), ...(ov.young ?? [])].map(c => [c.mint, c])).values()]; // the main lists miss coins minutes old
    followCoins(known);
    if (seeded) await runSlots(ov.bots, known).catch(e => console.log(`${new Date().toISOString()} slots: ${String(e).slice(0, 160)}`));
    const fresh = decisions.filter(d => d.atMs > lastDecision).sort((a, b) => a.atMs - b.atMs);
    if (seeded) for (const d of fresh) add({ atMs: d.atMs, kind: "decision", mint: d.mint, symbol: d.symbol ?? d.name, title: `${d.decision}: ${scrubReason(d.reason)}` });
    lastDecision = Math.max(lastDecision, ...decisions.map(d => d.atMs), 0); seeded = true;
  } catch (e) { console.log(`${new Date().toISOString()} ${String(e).slice(0, 160)}`); }
  await Bun.sleep(3_000);
}
