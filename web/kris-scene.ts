/** Pure helpers for the Kris room (webapp/app/kris): fitting the terminal into the monitor, placing the cursor, working
 * out what is new in the feed, and what Kris looks at between events. */
export type Rect = { x: number; y: number; w: number; h: number };
export type SceneEvent = { id: string; atMs: number; kind: string; mint: string; symbol: string | null; title: string; thought?: string; reaction?: string };
export type ReviewBot = { mint: string; symbol?: string | null; capUsd?: number | null; range?: { buy: number; sell: number } | null; holdingSteps?: number | null; steps?: number | null };
export type TourStep = { kind: "review"; bot: ReviewBot } | { kind: "press"; target: string };

/** The terminal is laid out at this width and scaled down, so it looks the same in any size of monitor. */
export const VIRTUAL_W = 1500;

export function fitFrame(screenW: number, screenH: number) {
  const scale = screenW / VIRTUAL_W;
  return { scale, width: VIRTUAL_W, height: screenH / scale };
}

/** Centre of a rect inside the iframe, in the monitor's own pixels. */
export const toScreen = (r: Rect, scale: number) => ({ x: (r.x + r.w / 2) * scale, y: (r.y + r.h / 2) * scale });

/** A point inside a rect (fx, fy from 0 to 1), in the monitor's own pixels. */
export const spot = (r: Rect, fx: number, fy: number, scale: number) => ({ x: (r.x + r.w * fx) * scale, y: (r.y + r.h * fy) * scale });

/** Events not seen yet that Kris acts on, oldest first, so they play in the order they happened. */
export const newEvents = (list: SceneEvent[], seen: Set<string>) => list.filter(e => !seen.has(e.id) && e.kind !== "decision").sort((a, b) => a.atMs - b.atMs);

/** Only what Kris does moves the cursor. New coins stay in the history: there are too many to act out. */
export const keepEvent = (e: SceneEvent, queued: number) => e.kind !== "coin" && e.kind !== "migrated" && queued < 4;

/** Each animation and what it says, shown together so the two always match. */
export const REACTIONS: Record<string, { label: string; tone: string }> = {
  ape: { label: "Aping in", tone: "gold" }, profit: { label: "Taking profit", tone: "up" }, loss: { label: "Took a loss", tone: "dn" },
  dip: { label: "Buying the dip", tone: "acc" }, hold: { label: "Holding through it", tone: "acc" }, compare: { label: "Comparing", tone: "gold" } };
export const SPRITE = { frames: 8, width: 420, height: 567, frameMs: 240, loops: 1, holdMs: 2_600, version: 3 };

/** The animation for an event, or null to stay still: only a trade, a new position or leaving the range animates. */
export function reactionOf(e: SceneEvent) {
  const old: Record<string, string> = { stack: "profit", swap: "ape" }, r = e.reaction ? old[e.reaction] ?? e.reaction : null;
  if (r) return r;
  if (e.kind === "compare") return "compare";
  if (e.kind === "range") return /above|below/.test(e.title) ? "hold" : null;
  if (e.kind === "position" || /^Bought/.test(e.title)) return "ape";
  if (/^Sold/.test(e.title)) return "profit";
  return null;
}

/** What the speech bubble says: the newest event, still "thinking" for a minute while its thought may arrive. */
export function bubble(list: SceneEvent[], nowMs: number) {
  const e = list[0]; if (!e) return null;
  return { title: e.title, coin: e.symbol ?? e.mint.slice(0, 6), thought: e.thought ?? null, thinking: !e.thought && nowMs - e.atMs < 60_000 };
}

const k = (v: number) => v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${Math.round(v / 1000)}k`;
/** One plain line about a position: facts only, no model involved. */
export function reviewLine(b: ReviewBot) {
  const name = b.symbol ?? b.mint.slice(0, 6), cap = b.capUsd ?? 0, r = b.range;
  if (!r) return `${name}: no range set.`;
  const where = cap > r.sell ? `above its ${k(r.buy)}–${k(r.sell)} range` : cap < r.buy ? `below its ${k(r.buy)}–${k(r.sell)} range` : `inside ${k(r.buy)}–${k(r.sell)}`;
  return `${name} is at ${k(cap)}, ${where}, holding ${b.holdingSteps ?? 0} of ${b.steps ?? "?"} steps.`;
}

/** A round of looking around: every running position once, out-of-range ones first. */
export function tourSteps(bots: ReviewBot[], rand: () => number): TourStep[] {
  const out = (b: ReviewBot) => !!b.range && !!b.capUsd && (b.capUsd > b.range.sell || b.capUsd < b.range.buy);
  const list = [...bots].map(b => ({ b, r: rand() })).sort((x, y) => Number(out(y.b)) - Number(out(x.b)) || x.r - y.r).map(x => x.b);
  return list.map(bot => ({ kind: "review", bot }));
}
