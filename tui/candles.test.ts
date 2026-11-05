import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Candles } from "./candles.ts";

const fresh = () => { const r = mkdtempSync(join(tmpdir(), "slrd-candles-")); mkdirSync(join(r, ".range-bots")); return new Candles(r); };
test("band is the prices touched repeatedly, not one wick", () => {
  const c = fresh(), t0 = 1_000 * 60_000;
  for (let i = 0; i < 50; i++) c.add("m", t0 + i * 60_000, i % 2 ? 100 : 130, 5);
  c.add("m", t0 + 50 * 60_000, 900, 0.01); // touched once
  const b = c.band("m", 60, 30, t0 + 51 * 60_000)!;
  expect(b.lo).toBeLessThanOrEqual(100); expect(b.lo).toBeGreaterThan(90);
  expect(b.hi).toBeGreaterThanOrEqual(130); expect(b.hi).toBeLessThan(140);
});
test("no band without enough history", () => {
  const c = fresh(); c.add("m", 60_000_000, 100, 1);
  expect(c.band("m", 60, 30, 60_000_000)).toBeNull();
});
