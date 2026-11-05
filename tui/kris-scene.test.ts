import { expect, test } from "bun:test";
import { bubble, fitFrame, keepEvent, newEvents, REACTIONS, reactionOf, reviewLine, toScreen, tourSteps, VIRTUAL_W, type SceneEvent } from "../web/kris-scene.ts";
import { coinVerdict, rangeSide, rangeTitle, tradeReaction } from "../webapp/public/kris-events.ts";

const ev = (id: string, atMs: number, extra: Partial<SceneEvent> = {}): SceneEvent => ({ id, atMs, kind: "trade", mint: "Mint1234abc", symbol: null, title: "Bought", ...extra });

test("the terminal is scaled to fill the monitor exactly", () => {
  const f = fitFrame(750, 500);
  expect(f.scale).toBe(0.5); expect(f.width).toBe(VIRTUAL_W); expect(f.height).toBe(1000);
  expect(f.width * f.scale).toBe(750); expect(f.height * f.scale).toBe(500);
});
test("the cursor lands on the middle of a scaled row", () => {
  expect(toScreen({ x: 100, y: 200, w: 40, h: 20 }, 0.5)).toEqual({ x: 60, y: 105 });
});
test("new events play oldest first and skip decisions and seen ones", () => {
  const out = newEvents([ev("c", 3), ev("d", 4, { kind: "decision" }), ev("b", 2), ev("a", 1)], new Set(["a"]));
  expect(out.map(e => e.id)).toEqual(["b", "c"]);
});
test("the bubble shows the newest event, thinking only while a thought can still arrive", () => {
  expect(bubble([], 0)).toBeNull();
  expect(bubble([ev("a", 1000)], 2000)).toMatchObject({ coin: "Mint12", thinking: true, thought: null });
  expect(bubble([ev("a", 1000)], 90_000)).toMatchObject({ thinking: false });
  expect(bubble([ev("a", 1000, { thought: "Sold it." })], 2000)).toMatchObject({ thinking: false, thought: "Sold it." });
});

const r = { buy: 100_000, sell: 200_000 };
test("positions that left their range are reviewed first", () => {
  const bots = [{ mint: "in", capUsd: 150_000, range: r }, { mint: "out", capUsd: 300_000, range: r }];
  const s = tourSteps(bots, () => 0.5);
  expect(s[0]).toMatchObject({ kind: "review", bot: { mint: "out" } });
  expect(s).toHaveLength(2);
});
test("the tour never presses anything", () => {
  const bots = Array.from({ length: 30 }, (_, i) => ({ mint: `m${i}`, capUsd: 150_000, range: r }));
  expect(tourSteps(bots, Math.random).every(s => s.kind === "review")).toBe(true);
});
test("the review line states where the price is", () => {
  expect(reviewLine({ mint: "abcdefgh", symbol: "X", capUsd: 250_000, range: r, holdingSteps: 1, steps: 3 })).toBe("X is at $250k, above its $100k–$200k range, holding 1 of 3 steps.");
  expect(reviewLine({ mint: "abcdefgh", symbol: "X", capUsd: 150_000, range: r, holdingSteps: 2, steps: 3 })).toContain("inside");
});
test("trades play, a backlog is dropped, and new coins never move the cursor", () => {
  expect(keepEvent(ev("a", 1), 2)).toBe(true);
  expect(keepEvent(ev("a", 1), 9)).toBe(false);
  expect(keepEvent(ev("a", 1, { kind: "coin" }), 0)).toBe(false);
  expect(keepEvent(ev("a", 1, { kind: "migrated" }), 0)).toBe(false);
});
test("each event picks its animation", () => {
  expect(reactionOf(ev("a", 1, { reaction: "loss", title: "Sold 0.02 SOL" }))).toBe("loss");
  expect(reactionOf(ev("a", 1, { title: "Bought 0.02 SOL" }))).toBe("ape");
  expect(reactionOf(ev("a", 1, { kind: "range", title: "Went below range at $9k" }))).toBe("hold");
  expect(reactionOf(ev("a", 1, { kind: "range", title: "Went above range at $9k" }))).toBe("hold");
  expect(reactionOf(ev("a", 1, { reaction: "stack" }))).toBe("profit");
  expect(reactionOf(ev("a", 1, { kind: "range", title: "Back in range at $9k" }))).toBeNull();
  expect(reactionOf(ev("a", 1, { kind: "coin", title: "New coin: skip" }))).toBeNull();
});
test("coins Kris only looks at do not animate, and every animation has a label", () => {
  expect(reactionOf(ev("a", 1, { kind: "coin", title: "New coin: watch, 200 wallets" }))).toBeNull();
  expect(reactionOf(ev("a", 1, { kind: "coin", title: "Bundle: skip, 31% of wallets" }))).toBeNull();
  for (const n of ["ape", "profit", "loss", "dip", "hold"]) expect(REACTIONS[n]?.label).toBeTruthy();
});
test("a trade earns its animation from the side, what is left and the coin's P&L", () => {
  expect(tradeReaction("BUY", 1, -0.1)).toBe("ape");
  expect(tradeReaction("BUY", 3, 0.02)).toBe("dip");
  expect(tradeReaction("BUY", 3, -0.02)).toBe("dip");
  expect(tradeReaction("SELL", 0, 0.02)).toBe("profit");
  expect(tradeReaction("SELL", 2, 0.02)).toBe("profit");
  expect(tradeReaction("SELL", 0, -0.02)).toBe("loss");
  expect(tradeReaction(null, 1, 0)).toBeNull();
});
test("a range side and its title", () => {
  expect(rangeSide(250, { buy: 100, sell: 200 })).toBe("above");
  expect(rangeSide(150, { buy: 100, sell: 200 })).toBe("inside");
  expect(rangeTitle("below", 90_000, r)).toBe("Went below range at $90.0k ($100.0k–$200.0k)");
});
test("the coin call follows the entry limits", () => {
  expect(coinVerdict({ capUsd: 3_000, traders: 500 }).verdict).toBe("skip");
  expect(coinVerdict({ capUsd: 3_000_000, traders: 500 }).verdict).toBe("skip");
  expect(coinVerdict({ capUsd: 50_000, traders: 40 }).verdict).toBe("skip");
  expect(coinVerdict({ capUsd: 50_000, traders: 40, smart: 1 }).verdict).toBe("watch");
  expect(coinVerdict({ capUsd: 50_000, traders: 500 }).verdict).toBe("watch");
  expect(coinVerdict({ capUsd: 50_000, traders: 500, smart: 2 }).verdict).toBe("like");
});
