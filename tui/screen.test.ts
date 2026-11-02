import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fit, recordTrade, render, scanBots, type Screen, type TraderStats } from "./screen.ts";

const MINT_A = "GuvRLfGP4CMJfF9VyHv85vih9yqxhNB5R8zgRcD9pump";
const MINT_B = "ERXoTjSZ58XdAdeinR4Mp9b3aQr375FvHdE9W5L2pump";
const MINT_C = "FkRUMUutcSp6rgu7fWmXf6fMzjHuyqrDtWDEvYYJpump";

test("scanBots keeps running, holding and pending bots and reads their range file", () => {
  const root = mkdtempSync(join(tmpdir(), "tui-"));
  mkdirSync(join(root, ".range-bots")); mkdirSync(join(root, "ranges"));
  writeFileSync(join(root, ".range-bots", `bot-demo-${MINT_A}.json`), JSON.stringify({ phase: "buy", position: null, pending: null, marketObservation: { capUsd: 60000, at: Date.now() } }));
  writeFileSync(join(root, `bot-demo-${MINT_A}.json.lock`), String(process.pid));
  writeFileSync(join(root, "ranges", `demo-${MINT_A}.json`), JSON.stringify({ buyMarketCapUsd: "50000", sellMarketCapUsd: "72000" }));
  writeFileSync(join(root, ".range-bots", `bot-cat-${MINT_B}.json`), JSON.stringify({ phase: "sell", position: { amountRaw: "1000000000", costLamports: "100000000" }, prices: [{ time: 1, price: 0.00012 }] }));
  writeFileSync(join(root, ".range-bots", `bot-cat-${MINT_C}.json`), JSON.stringify({ phase: "buy", position: null, pending: null })); // idle + stopped: hidden
  const bots = scanBots(root);
  expect(bots.map(b => b.mint)).toEqual([MINT_A, MINT_B]);
  expect(bots[0]).toMatchObject({ alive: true, range: { unit: "usd", buy: 50000, sell: 72000 }, capUsd: 60000 });
  expect(bots[1]).toMatchObject({ alive: false, phase: "sell", costSol: 0.1, priceSol: 0.00012 });
});

test("recordTrade accumulates per-trader session stats", () => {
  const stats = new Map<string, TraderStats>();
  const base = { signature: "s", atMs: 1, tokens: 1, capUsd: 1, creator: null, trader: "W" };
  recordTrade(stats, { ...base, side: "buy", sol: 0.5 });
  recordTrade(stats, { ...base, side: "sell", sol: 0.7 });
  recordTrade(stats, { ...base, side: "buy", sol: 0.1, trader: null });
  expect(stats.get("W")).toMatchObject({ buys: 1, sells: 1 });
  expect(stats.get("W")!.netSol).toBeCloseTo(0.2);
  expect(stats.size).toBe(1);
});

test("fit pads and truncates by visible width", () => {
  expect(fit("\u001b[32mab\u001b[0m", 4)).toBe("\u001b[32mab\u001b[0m  ");
  expect(fit("abcdef", 4)).toBe("abc…");
});

test("render fills the screen and tags our wallets and the dev", () => {
  const screen: Screen = {
    width: 120, height: 30, focus: "bots", wallets: [{ name: "demo", address: "OURS", sol: 3.1 }], walletIndex: 0,
    bots: [{ wallet: "demo", mint: MINT_A, alive: true, pid: 1, phase: "buy", health: null, paused: null, amountRaw: null, costSol: null,
      pending: null, capUsd: 60000, capAgeMs: 1000, priceSol: null, range: { unit: "usd", buy: 50000, sell: 72000 }, updatedAt: 0 }],
    botIndex: 0, symbols: new Map([[MINT_A, "GUV"]]),
    trades: [
      { signature: "a", atMs: 0, side: "buy", sol: 0.5, tokens: 1, capUsd: 61000, trader: "OURS", creator: "DEVX" },
      { signature: "b", atMs: 0, side: "sell", sol: 0.2, tokens: 1, capUsd: 60000, trader: "DEVX", creator: "DEVX" },
    ],
    traders: new Map(), mine: new Map([["OURS", "demo"]]), streamStatus: "live", solUsd: 95, prompt: null, message: "",
  };
  const plain = render(screen).replace(/\u001b\[[0-9;]*m/g, "");
  expect(plain.split("\n")).toHaveLength(30);
  expect(plain).toContain("$50.0k → $72.0k");
  expect(plain).toMatch(/BUY .*demo/);
  expect(plain).toMatch(/SELL .*DEV/);
});
