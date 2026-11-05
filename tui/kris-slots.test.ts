import { expect, test } from "bun:test";
import { bundleShare, earlyBoughtPct } from "./bundles.ts";
import { planSlots, slotKeepsRange, slotQualifies, slotRange, slotScore, type Slot, type SlotCoin } from "./kris-slots.ts";

const now = 10_000_000_000;
const coin = (mint: string, extra: Partial<SlotCoin> = {}): SlotCoin => ({ mint, symbol: mint, capUsd: 10_000, trades: 300, traders: 150, smart: 0, volSol: 30, ageMs: 60_000, migrated: false, ...extra });
const slot = (mint: string, extra: Partial<Slot> = {}): Slot => ({ mint, symbol: mint, kind: "new", openedAtMs: now - 600_000, score: 100, buy: 8_000, sell: 13_000, ...extra });
const plan = (o: Partial<Parameters<typeof planSlots>[0]>) => planSlots({ coins: [], slots: [], heldMints: new Set(), closedAt: new Map(), migratedAt: new Map(), freeSol: 0.2, nowMs: now, lastActionMs: 0, lastSwapMs: 0, ...o, config: { maxNew: 2, maxMigrated: 2, budgetSol: 0.05, gasSol: 0.02, minHoldMs: 120_000, swapRatio: 1.2, newMinAgeMs: 0, newAgeMs: 180_000, ...o.config } });

test("churn scores below real spread", () => {
  expect(slotScore(coin("a", { traders: 17, trades: 165 }))).toBeLessThan(slotScore(coin("b")));
  expect(slotScore(coin("a", { smart: 2 }))).toBeGreaterThan(slotScore(coin("b")));
});
test("a new pair needs wallets, trades and a sane cap", () => {
  expect(slotQualifies(coin("a"), "new")).toBe(true);
  expect(slotQualifies(coin("a", { traders: 17, trades: 165 }), "new")).toBe(false);
  expect(slotQualifies(coin("a", { capUsd: 500 }), "new")).toBe(false);
  expect(slotQualifies(coin("a", { capUsd: 100_000 }), "new")).toBe(false);
});
test("the range is wide on both sides of the cap", () => { expect(slotRange(10_000)).toEqual({ buy: 6_000, sell: 19_000 }); });
test("an empty side opens its best coin", () => {
  const a = plan({ coins: [coin("weak", { traders: 60 }), coin("strong")] });
  expect(a).toMatchObject({ type: "open", kind: "new", coin: { mint: "strong" }, swap: false });
});
test("coins older than three minutes are not new pairs", () => {
  expect(plan({ coins: [coin("old", { ageMs: 200_000 })] })).toBeNull();
  expect(plan({ coins: [coin("unknown", { ageMs: null })] })).toBeNull();
});
test("no SOL for the budget and fees, no open", () => { expect(plan({ coins: [coin("a")], freeSol: 0.02 })).toBeNull(); });
test("one action every 30 seconds at most", () => { expect(plan({ coins: [coin("a")], lastActionMs: now - 10_000 })).toBeNull(); });
test("a coin already held, or just closed, is not opened", () => {
  expect(plan({ coins: [coin("a")], heldMints: new Set(["a"]) })).toBeNull();
  expect(plan({ coins: [coin("a")], closedAt: new Map([["a", now - 60_000]]) })).toBeNull();
});
test("falling under its range does not close a slot: the range decides", () => {
  expect(plan({ slots: [slot("a")], coins: [coin("a", { capUsd: 3_000 })], heldMints: new Set(["a"]) })).toBeNull();
});
test("a coin not seen trading for half an hour is closed", () => {
  expect(plan({ slots: [slot("a")], lastSeen: new Map([["a", now - 2_000_000]]) })).toMatchObject({ type: "close", reason: "went quiet" });
});
test("an empty list alone closes nothing: a daemon restart empties it", () => {
  expect(plan({ slots: [slot("a", { openedAtMs: now - 9_000_000 })], lastSeen: new Map([["a", now - 60_000]]) })).toBeNull();
  expect(plan({ slots: [slot("a", { openedAtMs: now - 9_000_000 })] })).toBeNull();
});
test("a slot opened seconds ago is not swapped just because it holds nothing yet", () => {
  const coins = [coin("a"), coin("b", { traders: 60 })];
  expect(plan({ slots: [slot("a", { openedAtMs: now - 30_000 })], heldMints: new Set(["a"]), coins, config: { maxNew: 1 }, emptyMints: new Set(["a"]) })).toBeNull();
});
test("a slot that sold out moves on after the minimum hold", () => {
  const coins = [coin("a"), coin("b"), coin("c", { traders: 60 })], slots = [slot("a", { openedAtMs: now - 150_000 }), slot("b", { openedAtMs: now - 150_000 })], heldMints = new Set(["a", "b"]);
  expect(plan({ slots, heldMints, coins, config: { maxNew: 2, swapRatio: 99 }, emptyMints: new Set(["a"]) })).toMatchObject({ type: "close", slot: { mint: "a" }, forSwap: true });
});
test("a swap waits for the minimum hold and the swap gap", () => {
  const held = new Set(["a", "b"]), weak = [coin("a", { traders: 60, trades: 120, volSol: 5 }), coin("b"), coin("c")];
  const young = { openedAtMs: now - 150_000 };
  expect(plan({ slots: [slot("a", { openedAtMs: now - 30_000 }), slot("b", young)], heldMints: held, coins: weak })).toBeNull();
  expect(plan({ slots: [slot("a", young), slot("b", young)], heldMints: held, coins: weak, lastSwapMs: now - 10_000 })).toBeNull();
});
test("the open after a swap close is marked as the swap", () => {
  expect(plan({ coins: [coin("c")], pendingKind: "new" })).toMatchObject({ type: "open", swap: true });
});
test("a migration counts only soon after it migrated", () => {
  const m = coin("m", { migrated: true, capUsd: 80_000, traders: 400, trades: 900, ageMs: null });
  expect(plan({ coins: [m], migratedAt: new Map([["m", now - 60_000]]) })).toMatchObject({ type: "open", kind: "migrated" });
  expect(plan({ coins: [m], migratedAt: new Map([["m", now - 900_000]]) })).toBeNull();
  expect(plan({ coins: [m] })).toBeNull();
});
test("early bought share counts the first 3 seconds, sold since or not", () => {
  expect(earlyBoughtPct([{ firstAtMs: 1_000, tokensBought: 300 }, { firstAtMs: 4_000, tokensBought: 100 }, { firstAtMs: 4_001, tokensBought: 500 }], 1_000)).toBe(40);
  expect(earlyBoughtPct([])).toBeNull();
});
test("bundle share counts wallets buying the same size within a second", () => {
  const same = ["a", "b", "c"].map((trader, i) => ({ atMs: 1_000 + i * 100, side: "buy", sol: 1, trader }));
  const rest = Array.from({ length: 7 }, (_, i) => ({ atMs: 9_000 + i * 5_000, side: "buy", sol: 0.1 + i / 10, trader: `w${i}` }));
  expect(bundleShare([...same, ...rest])).toBeCloseTo(0.3);
  expect(bundleShare(rest)).toBe(0);
  expect(bundleShare([])).toBe(0);
});
test("the live settings keep swaps rare: a slot holds 5 minutes and needs a coin twice as strong", () => {
  const full = planSlots({ coins: [coin("a", { ageMs: 300_000 }), coin("c", { traders: 200, trades: 400, ageMs: 300_000 })], slots: [slot("a", { openedAtMs: now - 200_000 })], heldMints: new Set(["a"]), closedAt: new Map(), migratedAt: new Map(), freeSol: 5, nowMs: now, lastActionMs: 0, lastSwapMs: 0, config: { maxNew: 1 } });
  expect(full).toBeNull();
});
test("with room left a coin opens without any swap", () => {
  expect(planSlots({ coins: [coin("c", { ageMs: 300_000 })], slots: [slot("a"), slot("b")], heldMints: new Set(["a", "b"]), closedAt: new Map(), migratedAt: new Map(), freeSol: 5, nowMs: now, lastActionMs: 0, lastSwapMs: 0 })).toMatchObject({ type: "open", swap: false });
});
test("a new pair waits out its first four minutes", () => {
  const at = (ageMs: number) => planSlots({ coins: [coin("c", { ageMs })], slots: [], heldMints: new Set(), closedAt: new Map(), migratedAt: new Map(), freeSol: 5, nowMs: now, lastActionMs: 0, lastSwapMs: 0 });
  expect(at(120_000)).toBeNull(); expect(at(300_000)).toMatchObject({ type: "open" }); expect(at(700_000)).toBeNull();
});
test("a slot ending never sells held tokens", () => {
  expect(slotKeepsRange(4)).toBe(true); expect(slotKeepsRange(1)).toBe(true);
  expect(slotKeepsRange(0)).toBe(false); expect(slotKeepsRange(undefined)).toBe(false);
});
test("new pairs trade the fixed $5k to $60k range, migrations stay around their cap", () => {
  expect(slotRange(9_000, "new")).toEqual({ buy: 5_000, sell: 60_000 });
  expect(slotRange(40_000, "new")).toEqual({ buy: 5_000, sell: 60_000 });
  expect(slotRange(50_000, "migrated")).toEqual({ buy: 30_000, sell: 95_000 });
});
test("a coin still held keeps its slot, however old", () => {
  const coins = [coin("old"), coin("fresh", { traders: 6000 })];
  expect(plan({ slots: [slot("old", { openedAtMs: now - 9_000_000 })], heldMints: new Set(["old"]), coins, config: { maxNew: 1, swapRatio: 1 } })).toBeNull();
});
