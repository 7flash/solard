import { expect, test } from "bun:test";
import { bundleShare } from "./bundles.ts";
import { planSlots, readPick, slotQualifies, slotRange, slotScore, type Slot, type SlotCoin } from "./kris-slots.ts";

const now = 10_000_000_000;
const coin = (mint: string, extra: Partial<SlotCoin> = {}): SlotCoin => ({ mint, symbol: mint, capUsd: 10_000, trades: 300, traders: 150, smart: 0, volSol: 30, ageMs: 60_000, migrated: false, ...extra });
const slot = (mint: string, extra: Partial<Slot> = {}): Slot => ({ mint, symbol: mint, kind: "new", openedAtMs: now - 600_000, score: 100, buy: 8_000, sell: 13_000, ...extra });
const plan = (o: Partial<Parameters<typeof planSlots>[0]>) => planSlots({ coins: [], slots: [], heldMints: new Set(), closedAt: new Map(), migratedAt: new Map(), freeSol: 0.2, nowMs: now, lastActionMs: 0, lastSwapMs: 0, config: { maxNew: 2, maxMigrated: 2, budgetSol: 0.05, gasSol: 0.02 }, ...o });

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
test("the range sits around the cap", () => { expect(slotRange(10_000)).toEqual({ buy: 8_000, sell: 13_000 }); });
test("an empty side opens its best coin", () => {
  const a = plan({ coins: [coin("weak", { traders: 60 }), coin("strong")] });
  expect(a).toMatchObject({ type: "open", kind: "new", coin: { mint: "strong" }, swap: false });
});
test("coins older than three minutes are not new pairs", () => {
  expect(plan({ coins: [coin("old", { ageMs: 200_000 })] })).toBeNull();
  expect(plan({ coins: [coin("unknown", { ageMs: null })] })).toBeNull();
});
test("no SOL for the budget and fees, no open", () => { expect(plan({ coins: [coin("a")], freeSol: 0.02 })).toBeNull(); });
test("one action a minute at most", () => { expect(plan({ coins: [coin("a")], lastActionMs: now - 30_000 })).toBeNull(); });
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
test("a full side swaps its weakest only for a clearly better coin", () => {
  const slots = [slot("a"), slot("b")], held = new Set(["a", "b"]);
  const weak = [coin("a", { traders: 60, trades: 120, volSol: 5 }), coin("b")];
  expect(plan({ slots, heldMints: held, coins: [...weak, coin("c")] })).toMatchObject({ type: "close", slot: { mint: "a" }, forSwap: true });
  expect(plan({ slots, heldMints: held, coins: [coin("a"), coin("b"), coin("c")] })).toBeNull();
});
test("a swap waits for the minimum hold and the swap gap", () => {
  const held = new Set(["a", "b"]), weak = [coin("a", { traders: 60, trades: 120, volSol: 5 }), coin("b"), coin("c")];
  expect(plan({ slots: [slot("a", { openedAtMs: now - 60_000 }), slot("b")], heldMints: held, coins: weak })).toBeNull();
  expect(plan({ slots: [slot("a"), slot("b")], heldMints: held, coins: weak, lastSwapMs: now - 60_000 })).toBeNull();
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
test("bundle share counts wallets buying the same size within a second", () => {
  const same = ["a", "b", "c"].map((trader, i) => ({ atMs: 1_000 + i * 100, side: "buy", sol: 1, trader }));
  const rest = Array.from({ length: 7 }, (_, i) => ({ atMs: 9_000 + i * 5_000, side: "buy", sol: 0.1 + i / 10, trader: `w${i}` }));
  expect(bundleShare([...same, ...rest])).toBeCloseTo(0.3);
  expect(bundleShare(rest)).toBe(0);
  expect(bundleShare([])).toBe(0);
});
test("only the new pair Kris picked can open", () => {
  const coins = [coin("strong"), coin("picked", { traders: 80 })];
  expect(plan({ coins, allowNew: new Set(["picked"]) })).toMatchObject({ type: "open", coin: { mint: "picked" } });
  expect(plan({ coins, allowNew: new Set() })).toBeNull();
});
test("a migration does not need a pick", () => {
  const m = coin("m", { migrated: true, capUsd: 80_000, traders: 400, trades: 900, ageMs: null });
  expect(plan({ coins: [m], migratedAt: new Map([["m", now - 60_000]]), allowNew: new Set() })).toMatchObject({ type: "open", kind: "migrated" });
});
test("the pick is read from the last line and must be a candidate", () => {
  expect(readPick("A has more wallets than B.\nPICK: A", ["A", "B"])).toEqual({ thought: "A has more wallets than B.", pick: "A" });
  expect(readPick("Neither.\nPICK: NONE", ["A", "B"]).pick).toBeNull();
  expect(readPick("I like Z.\nPICK: Z", ["A", "B"]).pick).toBeNull();
  expect(readPick("No final line here", ["A"])).toEqual({ thought: "No final line here", pick: null });
  expect(readPick("Fine.\nPICK: **dogwif**.", ["DogWif"]).pick).toBe("DogWif");
});
