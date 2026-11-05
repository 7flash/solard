/** @jsxImportSource tradjs/client */
/** Kris's hands. New events play first: the cursor goes to the coin, clicks it, then checks the chart. Between events
 * Kris reviews the running positions and presses around the terminal (tabs, sort headers, coin lists), using the
 * terminal's embed messages. All of this is looking around: Kris never touches a trading control. Polls /api/kris every
 * 2s and /api/overview every 6s; stops touring while someone's mouse is on the monitor. */
import { render } from "tradjs/client";
import { bubble, fitFrame, keepEvent, newEvents, REACTIONS, reactionOf, reviewLine, spot, SPRITE, tourSteps, type Rect, type ReviewBot, type SceneEvent, type TourStep } from "../../../web/kris-scene.ts";

const $ = (id: string) => document.getElementById(id)!;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const short = (m: string) => m.slice(0, 6);
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });

let events: SceneEvent[] = [], seen: Set<string> | null = null, scale = 1, playing = false, ready = false;
let acting: string | null = null, current: string | null = null, note: string | null = null, bots: ReviewBot[] = [], tour: TourStep[] = [], handsOffUntil = 0;
const queue: SceneEvent[] = [];

function fit() {
  const s = $("screen").getBoundingClientRect(), f = fitFrame(s.width, s.height), term = $("term");
  scale = f.scale; term.style.width = `${f.width}px`; term.style.height = `${f.height}px`; term.style.transform = `scale(${f.scale})`;
}

type Reply = { row: Rect | null; range: Rect | null; chart: Rect | null; target: Rect | null };
const replies = new Map<number, (r: Reply | null) => void>();
let asked = 0;
/** Ask the terminal to do something and where things are now; null if it does not answer. */
function ask(type: string, body: Record<string, string>) {
  const id = ++asked, term = $("term") as HTMLIFrameElement;
  return new Promise<Reply | null>(resolve => {
    replies.set(id, resolve); term.contentWindow?.postMessage({ type, id, ...body }, termOrigin());
    setTimeout(() => { if (replies.delete(id)) resolve(null); }, 2_500);
  });
}
const termOrigin = () => new URL(($("term") as HTMLIFrameElement).src, location.href).origin;
const moveTo = (x: number, y: number) => { $("cursor").style.transform = `translate(${x}px, ${y}px)`; };
function click(x: number, y: number) {
  const r = $("ripple"); r.style.left = `${x}px`; r.style.top = `${y}px`; r.classList.remove("go"); void r.offsetWidth; r.classList.add("go");
}
/** Kris is drawn frame by frame from sprite sheets; the same event drives the frames and the bubble. */
const art = new Map<string, ImageBitmap>(); let playId = 0;
function drawFrame(name: string, i: number) {
  const img = art.get(name), c = $("kris-figure") as HTMLCanvasElement; if (!img) return;
  const g = c.getContext("2d")!; const w = img.width / SPRITE.frames; g.clearRect(0, 0, c.width, c.height); g.drawImage(img, i * w, 0, w, img.height, 0, 0, c.width, c.height);
}
async function loadArt() {
  await Promise.all(Object.keys(REACTIONS).filter(n => n !== "compare").map(async n => { const r = await fetch(`api/kris/art?name=${n}&v=${SPRITE.version}`); if (r.ok) art.set(n, await createImageBitmap(await r.blob())); }));
  drawFrame("ape", 0);
}
/** Plays once through the loops, then settles on the still. Resolves when it is done. */
async function react(name: string | null) {
  if (!name || !REACTIONS[name]) return;
  const id = ++playId; acting = name; paint();
  // Holding faces the viewer, a different body from the other four: Kris stays still and the label says it.
  if (name === "hold" || !art.has(name)) await sleep(SPRITE.holdMs);
  else for (let i = 0; i < SPRITE.frames * SPRITE.loops && id === playId; i++) { drawFrame(name, i % SPRITE.frames); await sleep(SPRITE.frameMs); }
  if (id === playId) { acting = null; drawFrame("ape", 0); paint(); }
}
/** Go to a random point in a rect, not its middle: rows and panels would otherwise look like one fixed spot. */
async function goTo(r: Rect | null | undefined, press = false, fx = 0.15 + Math.random() * 0.7, fy = 0.15 + Math.random() * 0.7) {
  if (!r) return; const p = spot(r, fx, fy, scale); moveTo(p.x, p.y); await sleep(1_400); if (press) { click(p.x, p.y); await sleep(200); }
}
/** The eye path over a position: its name, its range bar, across the chart, then one of the side panels. */
async function inspect(mint: string, long: boolean) {
  const at = await ask("solard:locate", { mint });
  await goTo(at?.row, true, 0.08, 0.5);
  const opened = await ask("solard:open", { mint });
  await sleep(350); await goTo(at?.range ?? opened?.range, false, 0.5, 0.5);
  await goTo(opened?.chart, false, 0.35, 0.3 + Math.random() * 0.4); await goTo(opened?.chart, false, 0.85, 0.3 + Math.random() * 0.4);
  if (long) await goTo((await ask("solard:locate-target", { target: Math.random() < 0.5 ? "panel:trades" : "panel:wallets" }))?.target);
}

async function play(e: SceneEvent) {
  current = e.id; note = null; paint();
  // The bubble stays on this event until both the animation and the cursor have finished with it.
  await Promise.all([react(reactionOf(e)), inspect(e.mint, false)]);
  await sleep(2_500);
}

/** One step of looking around. */
async function step(s: TourStep) {
  if (s.kind === "review") {
    note = reviewLine(s.bot); current = null; paint();
    await inspect(s.bot.mint, false); await sleep(5_000);
  } else {
    await goTo((await ask("solard:locate-target", { target: s.target }))?.target, true);
    await ask("solard:press", { target: s.target }); await sleep(1_000);
  }
}

async function drain() {
  if (playing || !ready) return;
  playing = true;
  try {
    for (;;) {
      const e = queue.shift();
      if (e) { await play(e); continue; }
      if (Date.now() < handsOffUntil) break;
      if (!tour.length) tour = tourSteps(bots, Math.random);
      const s = tour.shift(); if (!s) break;
      await step(s);
    }
  } finally { playing = false; }
}

/** ?demo=1: plays each reaction in turn with made-up text. On this page only: nothing is read from or sent to the bots. */
const DEMO = new URLSearchParams(location.search).get("demo") === "1";
const DEMO_STEPS: [string, string, string, string][] = [
  ["position", "ape", "Opened new pair, 0.05 SOL", "Demo: 200 wallets in two minutes, so this one gets a slot."],
  ["trade", "dip", "Bought 0.0100 SOL", "Demo: the next level down filled, as the range planned."],
  ["range", "hold", "Went below range at $6.2k ($7.0k–$11.0k)", "Demo: under the range now, holding what I have."],
  ["trade", "profit", "Sold 0.0300 SOL", "Demo: top level reached, taking this step off."],
  ["trade", "loss", "Sold 0.0200 SOL", "Demo: this one closed under what it cost."],
];
async function demo() {
  for (let i = 0; ; i++) {
    const [kind, reaction, title, thought] = DEMO_STEPS[i % DEMO_STEPS.length]!;
    const e: SceneEvent = { id: `demo-${i}`, atMs: Date.now(), kind, mint: bots[i % Math.max(1, bots.length)]?.mint ?? "demo", symbol: "DEMO", title, thought, reaction };
    events = [e, ...events].slice(0, 20); await play(e); await sleep(1_000);
  }
}

function Bubble() {
  const shown = current ? events.filter(e => e.id === current && e.thought) : [];
  if (!shown.length && note) return <div><div className="act off">Reviewing</div><div className="thought">{note}</div></div>;
  const b = bubble(shown.length ? shown : thoughts(), Date.now());
  if (!b) return <div className="thought idle">Watching the terminal. Nothing to report yet.</div>;
  const r = acting ? REACTIONS[acting] : null;
  return <div><div className={`act ${r ? r.tone : "off"}`}>{r?.label ?? "Watching"}</div><div className="bubble-head"><b>{b.coin}</b> {b.title}</div><div className="thought">{b.thought ?? (b.thinking ? "Thinking…" : "")}</div></div>;
}
const thoughts = () => events.filter(e => e.thought);
const History = () => <div>{thoughts().length ? thoughts().slice(0, 80).map(e => <button key={e.id} className={`entry ${e.kind}`} data-mint={e.mint}>
  <span className="entry-top"><b>{e.symbol ?? short(e.mint)}</b><span className="dim num">{clock(e.atMs)}</span></span>
  <span className="entry-thought">{e.thought}</span></button>) : <div className="dim empty">Nothing yet.</div>}</div>;

function paint() { render(<Bubble />, $("bubble")); render(<History />, $("history")); $("history-n").textContent = `${thoughts().length}`; }

async function pull() {
  try {
    const feed = await (await fetch("api/kris")).json() as { events: SceneEvent[]; ca?: string };
    events = feed.events; $("ca").textContent = feed.ca ?? "";
    if (!seen) { seen = new Set(events.map(e => e.id)); if (events[0]) queue.push(events[0]); } // on load, show the latest
    else for (const e of newEvents(events, seen)) { seen.add(e.id); if (keepEvent(e, queue.length)) queue.push(e); }
    paint(); void drain();
  } catch {}
}
async function pullBots() {
  try {
    const ov = await (await fetch("api/overview")).json() as { bots: (ReviewBot & { inactive?: boolean })[] };
    bots = ov.bots.filter(b => !b.inactive && b.range && b.capUsd); void drain();
  } catch {}
}

export default function mount() {
  fit(); moveTo(40, 40); void loadArt();
  const onMessage = (m: MessageEvent) => {
    if (m.origin !== termOrigin() || m.source !== ($("term") as HTMLIFrameElement).contentWindow) return;
    const d = m.data as { type?: string; id?: number; row?: Rect | null; range?: Rect | null; chart?: Rect | null; target?: Rect | null };
    if (d?.type === "solard:ready") { ready = true; void drain(); }
    if (d?.type === "solard:at" && d.id != null) { replies.get(d.id)?.({ row: d.row ?? null, range: d.range ?? null, chart: d.chart ?? null, target: d.target ?? null }); replies.delete(d.id); }
  };
  const onClick = (e: Event) => { const b = (e.target as HTMLElement).closest("[data-mint]") as HTMLElement | null; if (b) { handsOffUntil = Date.now() + 30_000; void ask("solard:open", { mint: b.dataset.mint! }); } };
  const hands = () => { handsOffUntil = Date.now() + 30_000; };
  new ResizeObserver(fit).observe($("screen")); window.addEventListener("message", onMessage); window.addEventListener("resize", fit); $("history").addEventListener("click", onClick);
  $("ca-row").addEventListener("click", () => void navigator.clipboard?.writeText($("ca").textContent ?? ""));
  $("screen").addEventListener("mouseenter", hands); $("screen").addEventListener("mouseleave", hands);
  void pullBots();
  if (DEMO) void loadArt().then(() => sleep(2_500)).then(demo); else void pull();
  const a = setInterval(() => { if (!DEMO) void pull(); }, 2_000), b = setInterval(() => void pullBots(), 6_000), c = setInterval(() => { if (!DEMO) void drain(); }, 5_000);
  return () => { clearInterval(a); clearInterval(b); clearInterval(c); window.removeEventListener("message", onMessage); window.removeEventListener("resize", fit); };
}
