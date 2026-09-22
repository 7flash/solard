import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

describe("tx stream CLI", () => {
  test("exposes direct terminal wallet streaming", () => {
    expect(source).toContain('command === "tx" && values[0] === "stream"');
    expect(source).toContain("connection.onLogs(");
    expect(source).toContain("connection.getTransaction(");
    expect(source).toContain("Ctrl+C to stop");
  });

  test("supports one wallet, csv wallets, finalized, and jsonl", () => {
    expect(source).toContain('flags.get("wallet")');
    expect(source).toContain('csv(flags.get("wallets"))');
    expect(source).toContain('flags.has("finalized")');
    expect(source).toContain('flags.has("jsonl")');
  });

  test("stream path does not register a persistent watch", () => {
    const start = source.indexOf('command === "tx" && values[0] === "stream"');
    const end = source.indexOf(
      'command === "sol-flow" || (command === "tx" && values[0] === "flow")',
      start,
    );
    const stream = source.slice(start, end);
    expect(stream).not.toContain("watchWallet(");
    expect(stream).not.toContain("watcher.");
  });

  test("deduplicates signatures across watched wallets", () => {
    expect(source).toContain("seen.has(signature)");
    expect(source).toContain("queued.has(signature)");
    expect(source).toContain("rememberSeen(item.signature)");
  });
});
