import { expect, test } from "bun:test";
import { curveRange, curveSignal } from "./curve-entry.ts";

const now = 1_000_000_000, coin = (o = {}) => ({ mint: "m", migrated: false, capUsd: 25_000, launchedAtMs: now - 5 * 60_000, traders: { size: 40 }, ...o });
test("fires on a fast climb with enough wallets", () => expect(curveSignal(coin(), now)).toBe(true));
test("not too early, too late, too thin, or already migrated", () => {
  expect(curveSignal(coin({ capUsd: 12_000 }), now)).toBe(false);
  expect(curveSignal(coin({ capUsd: 50_000 }), now)).toBe(false);
  expect(curveSignal(coin({ traders: { size: 10 } }), now)).toBe(false);
  expect(curveSignal(coin({ launchedAtMs: now - 3_600_000 }), now)).toBe(false);
  expect(curveSignal(coin({ launchedAtMs: null }), now)).toBe(false);
  expect(curveSignal(coin({ migrated: true }), now)).toBe(false);
});
test("range sits around the entry", () => expect(curveRange(25_000)).toEqual({ buy: 17_500, sell: 50_000, steps: 3 }));
