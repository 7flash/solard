import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, renameSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseRangeCsv } from "./range-csv.ts";
import { watchRangeFile } from "./range-file.ts";

const { rmSync } = require("fs") as { rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void };
const header = "wallet,mint,buy_mcap_usd,sell_mcap_usd\n";
test("CSV selects one exact wallet/mint and rejects missing or duplicate identity", () => {
  const text = '\uFEFFsell_mcap_usd,wallet,mint,buy_mcap_usd\r\n"73000",ddm6,a,44000\r\n50000,ddm6,b,40000\r\n';
  expect(parseRangeCsv(text, "ddm6", "a")).toEqual({ kind: "market-cap", buyMarketCapUsd: "44000", sellMarketCapUsd: "73000" });
  expect(() => parseRangeCsv(text, "other", "a")).toThrow("exactly one");
  expect(() => parseRangeCsv(header + "w,a,1,2\nw,a,3,4", "w", "a")).toThrow("exactly one");
  expect(() => parseRangeCsv(header + 'w,a,"1,000",2000', "w", "a")).toThrow();
  expect(() => parseRangeCsv(header + 'w,a,"1,2', "w", "a")).toThrow("Unterminated");
  expect(parseRangeCsv(header + "w,a,2,1", "w", "a")).toMatchObject({entryPaused:true,sellMarketCapUsd:'1'});
  expect(() => parseRangeCsv(header + "w,a,-2,1", "w", "a")).toThrow();
});

test("shared watcher isolates invalid rows and reloads atomic saves without mutating captured limits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranges-csv-")), path = join(dir, "ranges.csv");
  writeFileSync(path, header + "w,a,1,2\nw,b,3,4");
  const a = watchRangeFile(path, () => {}, text => parseRangeCsv(text, "w", "a"));
  const b = watchRangeFile(path, () => {}, text => parseRangeCsv(text, "w", "b"));
  try {
    const captured = a.current;
    writeFileSync(path + ".tmp", header + "w,a,5,6\nw,b,bad,4"); renameSync(path + ".tmp", path);
    await Bun.sleep(200);
    expect(a.valid).toBe(true); expect((a.current.kind === "market-cap" && a.current.buyMarketCapUsd)).toBe("5");
    expect(b.valid).toBe(false); expect((captured.kind === "market-cap" && captured.buyMarketCapUsd)).toBe("1");
    writeFileSync(path, header + "w,a,5,6\nw,b,3,7"); b.refresh();
    expect(b.valid).toBe(true); expect((b.current.kind === "market-cap" && b.current.sellMarketCapUsd)).toBe("7");
    writeFileSync(path, header + "w,b,3,7"); a.refresh(); b.refresh();
    expect(a.valid).toBe(false); expect(b.valid).toBe(true);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});
