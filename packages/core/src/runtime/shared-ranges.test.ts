import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, renameSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SharedRanges, sharedTimedPrice } from "./shared-ranges.ts";
const { rmSync } = require("fs") as { rmSync: (path: string, opts: { recursive: boolean; force: boolean }) => void };

test("one shared feed discovers new rows, isolates edits/removal and preserves captured limits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shared-ranges-")), path = join(dir, "ranges.csv");
  const header = "wallet,mint,buy_mcap_usd,sell_mcap_usd\n";
  writeFileSync(path, header + "w,a,1,2\nw,b,3,4\n");
  let changes = 0;
  const feed = new SharedRanges(path, () => changes++);
  const a = feed.subscribe("w", "a", () => {}), b = feed.subscribe("w", "b", () => {});
  try {
    const captured = a.current;
    writeFileSync(path + ".tmp", header + "w,a,5,6\nw,b,bad,4\nw,c,7,8\n"); renameSync(path + ".tmp", path);
    await Bun.sleep(200);
    expect(feed.identities()).toHaveLength(3); expect(a.valid).toBe(true); expect(b.valid).toBe(false);
    expect(captured.kind === "market-cap" && captured.buyMarketCapUsd).toBe("1");
    expect(feed.read("w", "c").kind).toBe("market-cap");
    writeFileSync(path, header + "w,a,5,6\nw,b,9,4\n"); feed.refresh();
    expect(b.valid).toBe(true); expect(b.current).toMatchObject({entryPaused:true,sellMarketCapUsd:'4'});
    writeFileSync(path, header + "w,b,3,4\n"); feed.refresh();
    expect(a.valid).toBe(false); expect(b.valid).toBe(true);
    writeFileSync(path, 'broken,"'); feed.refresh();
    expect(b.valid).toBe(false); expect(() => feed.identities()).toThrow();
    writeFileSync(path, header + "w,a,1,2\nw,b,3,4\n"); feed.refresh();
    expect(a.valid).toBe(true); expect(b.valid).toBe(true); expect(changes).toBeGreaterThan(1);
  } finally { a.close(); b.close(); feed.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("shared price coalesces concurrent loads and backs off without inventing fresh timestamps", async () => {
  let now = 1000, calls = 0, fail = false;
  const price = sharedTimedPrice(async () => { calls++; await Promise.resolve(); if (fail) throw Error("HTTP 429"); return { price: 100, atMs: now }; }, () => now);
  const first = await Promise.all([price(), price(), price()]);
  expect(calls).toBe(1); expect(first.every(x => x.atMs === 1000)).toBe(true);
  now = 62000; fail = true;
  expect((await price()).atMs).toBe(1000); expect(calls).toBe(2);
  await price(); expect(calls).toBe(2);
  now = 123000; await expect(price()).rejects.toThrow("429");
  await expect(price()).rejects.toThrow("cooling down"); expect(calls).toBe(3);
  now += 30001; fail = false; expect((await price()).atMs).toBe(now);
});

test("a loader returning stale cached data cannot bypass backoff", async () => {
  let calls = 0;
  const price = sharedTimedPrice(async () => { calls++; return { atMs: 1000 }; }, () => 62000);
  await price(); await price(); expect(calls).toBe(1);
});
