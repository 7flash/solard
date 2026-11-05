import { expect, test } from "bun:test";
import "./chart-math.js";

const m = (globalThis as unknown as { solardChartMath: any }).solardChartMath;
test("reads the chart's unit from its axis", () => {
  expect(m.unit({ from: 80_000, to: 130_000 }, 100_000, 0.0001)).toBe("cap");
  expect(m.unit({ from: 0.00008, to: 0.00013 }, 100_000, 0.0001)).toBe("price");
  expect(m.unit({ from: 1, to: 2 }, 100_000, 0.0001)).toBeNull();
});
test("levels convert to price charts", () => {
  const bot = { buy: 50_000, sell: 150_000, capUsd: 100_000, priceUsd: 0.0001 };
  expect(m.levels(bot, "cap")).toEqual({ buy: 50_000, sell: 150_000 });
  const p = m.levels(bot, "price");
  expect(p.buy).toBeCloseTo(0.00005, 10); expect(p.sell).toBeCloseTo(0.00015, 10);
});
test("steps match the bot's levels", () => {
  const s = m.stepLevels(76_000, 140_000, 8);
  expect(s.length).toBe(8);
  expect(s[0]).toEqual({ buy: 76_000, sell: 84_000 });
  expect(s[7]).toEqual({ buy: 132_000, sell: 140_000 });
});
test("a saved panel stays on screen and usable", () => {
  expect(m.panelBox({ left: 100, top: 50, width: 300, height: 200 }, 1200, 800)).toEqual({ left: 100, top: 50, width: 300, height: 200 });
  expect(m.panelBox({ left: 5000, top: 5000, width: 300, height: null }, 1200, 800)).toEqual({ left: 900, top: 770, width: 300, height: null });
  expect(m.panelBox({ left: -50, top: -50, width: 20, height: 10 }, 1200, 800)).toEqual({ left: 0, top: 0, width: 180, height: 90 });
});
const MINT = "6VMScJ8VKeiKe4JcCXigEe1k3WycMhVaCoPKArQGpump", bots = [{ mint: MINT }];
test("finds addresses in site URLs", () => {
  expect(m.addressesIn(`https://gmgn.ai/sol/token/abc_${MINT}?x=1`)).toContain(MINT);
});
test("finds the bot from a mint, a lowercased mint, or a pair", async () => {
  const none = async () => null;
  expect(await m.findBot([MINT], bots, none)).toBe(bots[0]);
  expect(await m.findBot([MINT.toLowerCase()], bots, none)).toBe(bots[0]);
  expect(await m.findBot(["cckxrpdvsczlraayxesgdu8jpawpkaluturnvmjppmmt"], bots, async () => MINT)).toBe(bots[0]);
  expect(await m.findBot(["cckxrpdvsczlraayxesgdu8jpawpkaluturnvmjppmmt"], bots, none)).toBeNull();
});
