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
import { planSlots, readPick, slotQualifies, slotScore, slotSize, SLOT_CONFIG, type Slot, type SlotCoin, type SlotKind } from "./tui/kris-slots.ts";
import { coinVerdict, lastFill, rangeSide, rangeTitle, scrubReason, tradeReaction, tradeTitle, type KrisEvent } from "./webapp/public/kris-events.ts";

process.env.JSX_AI_RUNTIME ??= "codex";
process.env.JSX_AI_MODEL ??= "gpt-5.6-sol"; // the local codex default is rejected by the API
const dot = resolve(import.meta.dir, ".range-bots"), token = readFileSync(resolve(dot, "bridge-token"), "utf8").trim(), out = resolve(dot, "kris-events.json");
const { streamLLM } = await import(process.env.JSX_AI_PATH ?? resolve(import.meta.dir, "..", "jsx-ai", "src", "index.ts")) as { streamLLM: (m: { role: string; content: string }[], o: { timeoutMs: number }) => AsyncIterable<string> };
const KEEP = 300, KEEP_COINS = 100, THOUGHT_GAP_MS = 4_000;
const SYSTEM = "You are Kris, a young trader running small Solana memecoin positions through the Solard terminal, and you feel every trade. You are thinking out loud as it happens, sharp and sceptical, but never flat: a win makes you buzz, a loss stings, a rug makes you angry, a pass can feel like relief or regret. Open with how this moment feels in your own plain words, then give your read. Match the feeling to this event alone: a buy is nerve or excitement, a sale in profit is pride, a strong coin is real excitement, a dump you dodged is smug satisfaction, and you can be funny or cocky. Never mention past losses, being burned, bruised or stung unless this event is itself a loss. Never reuse a phrase from your earlier thoughts. "
  + "Never restate the event: the reader already sees it. Give your read: what the move means given the trend, the flow, who holds and where the price sits in the range; "
  + "what you expect next and the one thing that would prove you wrong. Disagree with the position when the facts say so, including saying the range looks wrong or the coin looks like it is being dumped. "
  + "Earlier thoughts are given so you can follow up on them; never repeat one or copy their mood. At most three sentences, first person, plain words. "
  + "Your feelings are yours, but the facts are not: use only the facts given and never invent a number. Talk about the coin and the market only: never mention data, missing information, context, tools, bugs or what you cannot see. A fact that is absent is simply not discussed. "
  + "Every trade is your own plan working: the range buys its levels and sells its levels, so never call a trade a mistake or say it should not have happened. No hashtags, no emojis, no advice to the reader.";

type Bot = { wallet: string; mint: string; symbol?: string | null; capUsd?: number | null; range?: { buy: number; sell: number } | null; steps?: number; holdingSteps?: number; vol1hSol?: number | null; pnl?: number; lastTradeAtMs?: number | null };
type Decision = { atMs: number; mint: string; name: string; symbol?: string | null; decision: string; reason: string };

let events: KrisEvent[] = []; try { events = JSON.parse(readFileSync(out, "utf8")); } catch {}
const isCoin = (e: KrisEvent) => e.kind === "coin" || e.kind === "migrated";
const save = () => { const kept = [...events.filter(isCoin).slice(0, KEEP_COINS), ...events.filter(e => !isCoin(e)).slice(0, KEEP)].sort((a, b) => b.atMs - a.atMs); writeFileSync(`${out}.tmp`, JSON.stringify(kept)); try { renameSync(`${out}.tmp`, out); } catch { /* Windows: a reader has it open; the next save writes it */ } };
const add = (e: Omit<KrisEvent, "id">) => { const ev = { ...e, id: `${e.atMs}-${e.kind}-${e.mint}` }; if (events.some(x => x.id === ev.id)) return null; events.unshift(ev); events = events.slice(0, KEEP); save(); return ev; };

/** Trades and range moves wait their turn; a new coin gets a thought only when nothing else is waiting. */
type Closed = { symbol: string | null; mint: string; pnlSol: number; pct: number | null; closedAt: number; openedAt: number | null };
/** How the last positions really ended, so a read can be checked against results. */
let results: unknown = null;
function trackRecord(rows: Closed[]) {
  const last = rows.slice(0, 12), wins = last.filter(r => r.pnlSol > 0).length;
  return last.length ? { lastClosed: last.length, won: wins, solResult: Math.round(last.reduce((a, r) => a + r.pnlSol, 0) * 1000) / 1000, worst: [...last].sort((a, b) => a.pnlSol - b.pnlSol).slice(0, 3).map(r => ({ coin: r.symbol ?? r.mint.slice(0, 6), pct: r.pct == null ? null : Math.round(r.pct), heldMin: r.openedAt ? Math.round((r.closedAt - r.openedAt) / 60_000) : null })) } : null;
}
const waiting: { ev: KrisEvent; facts: Record<string, unknown> }[] = []; let thinking = false, compareWaiting = false;
function think(ev: KrisEvent, facts: Record<string, unknown>) {
  const minor = ev.kind === "coin" || ev.kind === "migrated";
  if (minor ? thinking || compareWaiting || waiting.length > 0 : waiting.length >= 4) return;
  waiting.push({ ev, facts }); void drainThoughts();
}
async function drainThoughts() {
  if (thinking) return; thinking = true;
  for (let job = waiting.shift(); job; job = waiting.shift()) {
    const gloomy = /burned|bruis|sting|bites|bitter|licking/i, earlier = events.filter(e => e.thought && e.id !== job.ev.id && e.kind !== "coin" && e.kind !== "migrated" && !gloomy.test(e.thought)).slice(0, 4).map(e => ({ coin: e.symbol ?? e.mint.slice(0, 6), event: e.title, thought: e.thought }));
    try {
      const context = job.ev.kind === "coin" || job.ev.kind === "migrated" ? null : await coinContext(job.ev.mint);
      let text = "";
      for await (const chunk of streamLLM([{ role: "system", content: SYSTEM }, { role: "user", content: JSON.stringify({ ...job.facts, context, ...(job.ev.reaction === "loss" ? { myRecentResults: results } : {}), earlierThoughts: earlier }) }], { timeoutMs: 60_000 })) {
        text += chunk; job.ev.thought = text; save();
      }
    } catch (e) { console.log(`${new Date().toISOString()} thought failed: ${String(e).slice(0, 160)}`); }
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
const COMPARE_RULE = "You are comparing new pairs to decide if any deserves a position right now. Let your gut reaction show. Name the coins, compare them on what differs (wallets against trades, buy and sell flow, volume, smart wallets, cap), and say which is strongest and why the others lose. Passing is fine when nothing leads. "
  + "You trade aggressively and rotate often: when one coin clearly leads, take it, and size it by conviction from " + SLOT_CONFIG.minSizeSol + " to " + SLOT_CONFIG.maxSizeSol + " SOL. At most four sentences. Your very last line must be exactly PICK: followed by one coin name as written and your size in SOL, like PICK: NAME 0.2, or PICK: NONE.";
const COMPARE_EVERY_MS = 45_000, PICK_LIFE_MS = 90_000; let comparedAt = 0, picked: { mint: string; at: number; size: number } | null = null;
const passes = new Map<string, { coin: string; cap: number; at: number }>();
/** Coins Kris passed on in the last 20 minutes and where they are now: real proof of its calls. */
function passResults(coins: Coin[]) {
  const caps = new Map(coins.map(c => [c.mint, c.capUsd ?? null])), now = Date.now(), out: { coin: string; capWhenPassed: number; capNow: number; pct: number }[] = [];
  for (const [mint, p] of passes) { if (now - p.at > 1_200_000) { passes.delete(mint); continue; } const cap = caps.get(mint); if (cap) out.push({ coin: p.coin, capWhenPassed: Math.round(p.cap), capNow: Math.round(cap), pct: Math.round((cap / p.cap - 1) * 100) }); }
  return out.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 3);
}
/** The best new pairs side by side. Kris's answer decides which one may open: no pick, no new pair. */
async function compareNewPairs(bots: Bot[], coins: Coin[]) {
  const now = Date.now(); if (now - comparedAt < COMPARE_EVERY_MS || existsSync(offPath)) return;
  const held = new Set(bots.map(b => b.mint)), closed = new Map(book.closedAt);
  const fresh = coins.filter(c => !c.migrated && c.ageMs != null && c.ageMs <= SLOT_CONFIG.newAgeMs && !held.has(c.mint) && now - (closed.get(c.mint) ?? 0) > SLOT_CONFIG.reopenAfterMs && slotQualifies(c, "new")).sort((a, b) => slotScore(b) - slotScore(a)).slice(0, 4);
  if (!fresh.length) return;
  if (thinking) { compareWaiting = true; return; } // a one-line coin thought must not hold up a real comparison
  compareWaiting = false; comparedAt = now; thinking = true;
  try {
    const rows = (await Promise.all(fresh.map(async c => {
      const r = await fetch(`http://127.0.0.1:5176/api/coin?mint=${c.mint}&watch=0`, { headers: { cookie: `slrd_web=${token}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
      if (!r?.ok) return null;
      const recent = ((await r.json()) as { recent?: (BuyRow & { sol: number | null })[] }).recent ?? [], share = bundleShare(recent), sum = (side: string) => Math.round(recent.slice(0, 100).filter(t => t.side === side).reduce((a, t) => a + (t.sol ?? 0), 0) * 10) / 10;
      return share >= SLOT_CONFIG.maxBundleShare ? null : { c, name: c.symbol || c.mint.slice(0, 6), ageSec: Math.round((c.ageMs ?? 0) / 1000), capUsd: c.capUsd ? Math.round(c.capUsd) : null, wallets: c.traders ?? 0, trades: c.trades ?? 0, smartWallets: c.smart ?? 0, solVolume: c.volSol ? Math.round(c.volSol) : 0, bundledWalletPct: Math.round(share * 100), last100Trades: { buySol: sum("buy"), sellSol: sum("sell") } };
    }))).filter(x => x != null);
    if (!rows.length) return;
    const names = rows.map(r => r.name), ev = add({ atMs: Date.now(), kind: "compare", mint: rows[0]!.c.mint, symbol: names.length > 1 ? "New pairs" : names[0]!, title: `Comparing ${names.join(", ")}` });
    if (!ev) return;
    const earlier = events.filter(e => e.kind === "compare" && e.thought && e.id !== ev.id && !/burned|bruis|sting|bites|bitter/i.test(e.thought)).slice(0, 3).map(e => ({ title: e.title, thought: e.thought }));
    let text = "";
    for await (const chunk of streamLLM([{ role: "system", content: `${SYSTEM} ${COMPARE_RULE}` }, { role: "user", content: JSON.stringify({ candidates: rows.map(({ c: _c, ...r }) => r), openNewPairs: book.slots.filter(s => s.kind === "new").map(s => s.symbol), coinsYouPassedOn: passResults(coins), earlierComparisons: earlier }) }], { timeoutMs: 60_000 })) {
      text += chunk; ev.thought = readPick(text, names).thought; save();
    }
    const { thought, pick, size } = readPick(text, names), chosen = rows.find(r => r.name === pick), sol = slotSize(size);
    ev.thought = thought; ev.title = chosen ? `Picked ${chosen.name} at ${sol} SOL${names.length > 1 ? ` over ${names.filter(n => n !== chosen.name).join(", ")}` : ""}` : `Passed on ${names.join(", ")}`;
    if (chosen) { ev.mint = chosen.c.mint; picked = { mint: chosen.c.mint, at: Date.now(), size: sol }; }
    for (const r of rows) if (r !== chosen && r.c.capUsd && !passes.has(r.c.mint)) passes.set(r.c.mint, { coin: r.name, cap: r.c.capUsd, at: Date.now() });
    save();
  } catch (e) { console.log(`${new Date().toISOString()} compare: ${String(e).slice(0, 160)}`); }
  finally { thinking = false; void drainThoughts(); }
}
const missingSince = new Map<string, number>(), lastSeen = new Map<string, number>(), pendingSide = new Map<string, { side: string; at: number }>(), reportedAt = new Map<string, number>();
async function runSlots(bots: Bot[], coins: Coin[]) {
  if (existsSync(offPath)) return;
  const held = new Set(bots.map(b => b.mint));
  // A position closed from anywhere else leaves its slot.
  if (!bots.length) return; // the daemon is restarting
  for (const s of book.slots) if (held.has(s.mint)) missingSince.delete(s.mint); else if (!missingSince.has(s.mint)) missingSince.set(s.mint, Date.now());
  const gone = book.slots.filter(s => Date.now() - (missingSince.get(s.mint) ?? Infinity) > 180_000);
  if (gone.length) { book.slots = book.slots.filter(s => !gone.includes(s)); saveBook(); }
  const w = await myWallet(), now = Date.now(), listed = new Set(coins.map(c => c.mint));
  for (const s of book.slots) if (listed.has(s.mint) || !lastSeen.has(s.mint)) lastSeen.set(s.mint, now);
  const a = planSlots({ coins, slots: book.slots, heldMints: held, closedAt: new Map(book.closedAt), migratedAt, freeSol: w.sol, nowMs: now, lastActionMs: book.lastActionMs, lastSwapMs: book.lastSwapMs, pendingKind: book.pendingKind, lastSeen, allowNew: new Set(picked && now - picked.at < PICK_LIFE_MS ? [picked.mint] : []) });
  if (!a) return;
  if (a.type === "close") {
    await act({ action: "stop", mint: a.slot.mint });
    book.slots = book.slots.filter(s => s.mint !== a.slot.mint); book.closedAt = [...book.closedAt.filter(([, at]) => now - at < SLOT_CONFIG.reopenAfterMs), [a.slot.mint, now]];
    book.lastActionMs = now; if (a.forSwap) { book.lastSwapMs = now; book.pendingKind = a.slot.kind; } saveBook();
    const ev = add({ atMs: now, kind: "decision", mint: a.slot.mint, symbol: a.slot.symbol, title: `Closing: ${a.reason}` });
    if (ev) think(ev, { event: `closing this ${a.slot.kind} position`, reason: a.reason });
    return;
  }
  const c = a.coin, budget = picked?.mint === c.mint ? picked.size : SLOT_CONFIG.budgetSol;
  // The terminal's bundle filter. No answer means no buy.
  const r = await fetch(`http://127.0.0.1:5176/api/coin?mint=${c.mint}&watch=0`, { headers: { cookie: `slrd_web=${token}` }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`coin read: ${r.status}`);
  const share = bundleShare(((await r.json()) as { recent?: BuyRow[] }).recent ?? []);
  if (share >= SLOT_CONFIG.maxBundleShare) {
    book.closedAt = [...book.closedAt.filter(([, at]) => now - at < SLOT_CONFIG.reopenAfterMs), [c.mint, now]]; saveBook();
    add({ atMs: now, kind: "coin", mint: c.mint, symbol: c.symbol ?? null, title: `Bundle: skip, ${Math.round(share * 100)}% of wallets bought together` });
    return;
  }
  await act({ action: "add", mint: c.mint, buy: a.buy, sell: a.sell, steps: SLOT_CONFIG.steps, budget });
  book.slots = book.slots.filter(s => s.mint !== c.mint); if (picked?.mint === c.mint) picked = null;
  book.slots.push({ mint: c.mint, symbol: c.symbol ?? null, kind: a.kind, openedAtMs: now, score: a.score, buy: a.buy, sell: a.sell });
  book.lastActionMs = now; if (book.pendingKind === a.kind) book.pendingKind = null; saveBook(); seenBots.add(c.mint); walletAt = 0;
  const ev = add({ atMs: now, kind: "position", mint: c.mint, symbol: c.symbol ?? null, title: `${a.swap ? "Swapped into" : "Opened"} ${a.kind === "new" ? "new pair" : "migration"}, ${budget} SOL`, reaction: "ape" });
  if (ev) think(ev, { event: `opening a ${a.kind} position`, coin: c.symbol ?? c.mint.slice(0, 6), capUsd: c.capUsd ? Math.round(c.capUsd) : null, wallets: c.traders ?? null, trades: c.trades ?? null, smartWallets: c.smart ?? 0, solVolume: c.volSol ?? null, rangeUsd: [a.buy, a.sell], budgetSol: budget });
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
  if (ev) void think(ev, { event: migrated ? "coin migrated, deciding whether it is worth a position" : "new coin appeared, deciding whether it is worth a position", call: v.verdict, reason: v.reason, coin: c.symbol ?? c.mint.slice(0, 6), capUsd: c.capUsd ? Math.round(c.capUsd) : null, wallets: c.traders ?? null, trades: c.trades ?? null, smartWallets: c.smart ?? 0 });
}
for (;;) {
  try {
    const r = await fetch("http://127.0.0.1:5176/api/overview", { headers: { cookie: `slrd_web=${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`overview ${r.status}`);
    const ov = await r.json() as { bots: Bot[]; decisions?: Decision[]; coins?: Coin[]; young?: Coin[]; closedRows?: Closed[] }, decisions = ov.decisions ?? [];
    results = trackRecord(ov.closedRows ?? []);
    for (const b of ov.bots.filter(x => !(x as { inactive?: boolean }).inactive)) {
      const at = b.lastTradeAtMs ?? 0, prev = seenTrade.get(b.mint);
      if (seeded && !seenBots.has(b.mint)) { const ev = add({ atMs: Date.now(), kind: "position", mint: b.mint, symbol: b.symbol ?? null, title: "New position", reaction: "ape" }); if (ev) void think(ev, { event: "opened a new position", ...facts(b) }); }
      seenBots.add(b.mint);
      if (seeded && at && at > (prev ?? 0)) {
        const path = resolve(dot, `term-${b.wallet}-${b.mint}.log`), fill = existsSync(path) ? lastFill(readFileSync(path, "utf8")) : null;
        const ev = add({ atMs: at, kind: "trade", mint: b.mint, symbol: b.symbol ?? null, title: tradeTitle(fill), reaction: tradeReaction(fill?.side ?? null, b.holdingSteps ?? 0, b.pnl ?? 0) ?? undefined });
        if (ev) void think(ev, { event: fill?.side === "BUY" ? "bought" : fill?.side === "SELL" ? "sold" : "traded", sol: fill?.sol ?? null, ...facts(b) });
      }
      if (at) seenTrade.set(b.mint, Math.max(at, prev ?? 0));
      if (b.capUsd && b.range) {
        // A price sitting on a range edge crosses it every few seconds: it counts once it has stayed 20s, and at most every 2 min.
        const side = rangeSide(b.capUsd, b.range), was = sides.get(b.mint), now = Date.now();
        if (side === was) pendingSide.delete(b.mint); else if (pendingSide.get(b.mint)?.side !== side) pendingSide.set(b.mint, { side, at: now });
        const settled = (pendingSide.get(b.mint)?.at ?? now) <= now - 20_000 && now - (reportedAt.get(b.mint) ?? 0) >= 120_000;
        if (seeded && was && was !== side && settled) {
          reportedAt.set(b.mint, now); pendingSide.delete(b.mint); const ev = add({ atMs: Date.now(), kind: "range", mint: b.mint, symbol: b.symbol ?? null, title: rangeTitle(side, b.capUsd, b.range), reaction: side === "inside" ? undefined : "hold" }); if (ev) void think(ev, { event: side === "inside" ? "price came back into the range" : `price went ${side} the range`, ...facts(b) }); }
        if (!was || settled) sides.set(b.mint, side);
      }
    }
    for (const c of ov.coins ?? []) {
      const was = seenCoins.get(c.mint), migrated = !!c.migrated;
      if (seeded && (was === undefined || (migrated && !was))) { coinEvent(c, migrated); if (migrated) migratedAt.set(c.mint, Date.now()); }
      seenCoins.set(c.mint, migrated);
    }
    const known = [...new Map([...(ov.coins ?? []), ...(ov.young ?? [])].map(c => [c.mint, c])).values()]; // the main lists miss coins minutes old
    followCoins(known);
    if (seeded) void compareNewPairs(ov.bots, known);
    if (seeded) await runSlots(ov.bots, known).catch(e => console.log(`${new Date().toISOString()} slots: ${String(e).slice(0, 160)}`));
    const fresh = decisions.filter(d => d.atMs > lastDecision).sort((a, b) => a.atMs - b.atMs);
    if (seeded) for (const d of fresh) add({ atMs: d.atMs, kind: "decision", mint: d.mint, symbol: d.symbol ?? d.name, title: `${d.decision}: ${scrubReason(d.reason)}` });
    lastDecision = Math.max(lastDecision, ...decisions.map(d => d.atMs), 0); seeded = true;
  } catch (e) { console.log(`${new Date().toISOString()} ${String(e).slice(0, 160)}`); }
  await Bun.sleep(3_000);
}
