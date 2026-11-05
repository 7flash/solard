import { expect, test } from "bun:test";
import { assertClean, publicCoin, publicOverview } from "./sanitize.ts";

const s = { addresses: ["OURwa11etAddressOURwa11etAddress11"] };
test("the overview keeps only public fields", () => {
  const o = publicOverview({ wallets: [{ name: "alpha7", address: s.addresses[0] }], solUsd: 90,
    bots: [{ wallet: "alpha7", pid: 4, mint: "M", pnl: 1, last: "x", error: "fail https://rpc/?api-key=abc" }],
    decisions: [{ mint: "M", name: "N", decision: "skipped", reason: "alpha7 wallet SOL low: 0.0407 SOL free (reserve 0.05)" }] });
  const json = JSON.stringify(o);
  expect(json).not.toContain("alpha7"); expect(json).not.toContain("api-key"); expect(json).not.toContain("0.0407"); expect(json).not.toContain("pid"); expect(json).not.toContain("decisions");
  expect(() => assertClean(json, s)).not.toThrow();
});
test("our wallets leave coin data", () => {
  const c = publicCoin({ mint: "M", creator: s.addresses[0], wallets: [{ trader: s.addresses[0], held: 9, ours: "alpha7" }, { trader: "other", held: 1, ours: null }],
    recent: [{ atMs: 1, trader: s.addresses[0], ours: "alpha7", creator: "x" }], clusters: [{ source: s.addresses[0] }], transfers: [{ from: [s.addresses[0]] }] }, s);
  const json = JSON.stringify(c);
  expect(json).not.toContain(s.addresses[0]); expect(json).not.toContain("alpha7"); expect(c.wallets.length).toBe(1);
  expect(() => assertClean(json, s)).not.toThrow();
});
test("a leak is refused", () => {
  expect(() => assertClean(`{"wallet":"x"}`, s)).toThrow();
  expect(() => assertClean(`{"a":"${s.addresses[0]}"}`, s)).toThrow();
  expect(() => assertClean(`{"a":"alpha7"}`, s)).not.toThrow(); // a coin may share a wallet's name
  expect(() => assertClean(`{"u":"?api-key=1"}`, s)).toThrow();
  expect(() => assertClean(`{"dev":true}`, s)).not.toThrow();
});

test("a coin carries its candles and fills, and only their known fields", async () => {
  const { publicCoin } = await import("./sanitize.ts");
  const c = publicCoin({ mint: "m", candles: [{ m: 1, o: 2, h: 3, l: 1, c: 2, v: 5, secret: "x" }], fills: [{ atMs: 1, side: "buy", sol: 0.1, wallet: "x" }] }, { addresses: [] }) as unknown as { candles: object[]; fills: object[] };
  expect(c.candles[0]).toEqual({ m: 1, o: 2, h: 3, l: 1, c: 2, v: 5 });
  expect(c.fills[0]).toEqual({ atMs: 1, side: "buy", sol: 0.1 });
});
