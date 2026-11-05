import { expect, test } from "bun:test";
import { fillsFromLog } from "./fill-log.ts";
import { axisWithRange, capAt, liveCandles, mapSpan, rangeLines } from "../web/trade-map-math.ts";

test("reads buys and sells, skips everything else", () => {
  const log = ["2026-11-05T03:46:17.000Z annotation target main X: BUY confirmed CONFIRMED -0.0200 SOL abc",
    "2026-11-05T03:46:20.000Z annotation target main X: BUY 0.02 SOL to reach 1/5 steps",
    "2026-11-05T03:46:34.000Z annotation target main X: SELL confirmed CONFIRMED +0.0230 SOL def"].join("\n");
  expect(fillsFromLog(log)).toEqual([{ atMs: Date.parse("2026-11-05T03:46:17.000Z"), side: "buy", sol: 0.02 }, { atMs: Date.parse("2026-11-05T03:46:34.000Z"), side: "sell", sol: 0.023 }]);
});
const candles = [{ m: 100, h: 12, l: 8, c: 10 }, { m: 300, h: 40, l: 20, c: 30 }];
test("the chart spans every candle, not just the live trades", () => {
  const s = mapSpan([{ atMs: 300 * 60_000, capUsd: 35 }], candles);
  expect(s.t0).toBe(100 * 60_000); expect(s.lo).toBe(8); expect(s.hi).toBe(40);
});
test("works with candles and no live trades, or the reverse", () => {
  expect(mapSpan([], candles).hi).toBe(40); expect(mapSpan([{ atMs: 5, capUsd: 7 }], []).lo).toBe(7);
});
test("a fill takes the cap of its minute, or a closer live trade", () => {
  expect(capAt(100 * 60_000 + 10_000, candles, [])).toBe(10);
  expect(capAt(305 * 60_000, candles, [{ atMs: 305 * 60_000, capUsd: 33 }])).toBe(33);
  expect(capAt(1, [], [])).toBeNull();
});
test("minutes not saved yet are built from live trades", () => {
  const out = liveCandles([{ m: 10, o: 5, h: 6, l: 4, c: 5 }], [{ atMs: 10 * 60_000 + 1, capUsd: 99 }, { atMs: 11 * 60_000, capUsd: 7 }, { atMs: 11 * 60_000 + 5, capUsd: 9 }, { atMs: 11 * 60_000 + 9, capUsd: 8 }]);
  expect(out).toHaveLength(2); expect(out[1]).toEqual({ m: 11, o: 7, h: 9, l: 7, c: 8 });
});
test("range lines run bottom to top", () => { expect(rangeLines({ buy: 100, sell: 200, steps: 2 })).toEqual([100, 150, 200]); });
test("a range near the price stretches the axis, a far one does not", () => {
  expect(axisWithRange(100, 200, { buy: 80, sell: 260, steps: 3 })).toEqual({ lo: 80, hi: 260 });
  expect(axisWithRange(100, 200, { buy: 10, sell: 900, steps: 3 })).toEqual({ lo: 100, hi: 200 });
  expect(axisWithRange(100, 200, null)).toEqual({ lo: 100, hi: 200 });
});
