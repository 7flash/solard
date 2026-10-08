import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as live from "./live.ts";
import { createSolard } from "./client.ts";

test("client listener inherits its configured database and endpoint pool", async () => {
  const folder = mkdtempSync(join(tmpdir(), "solard-sdk-listener-"));
  const dbPath = join(folder, "test.sqlite");
  const seen: Array<live.ListenTradesOptions> = [];
  const fixture = {} as live.TradeListener;
  const listen = spyOn(live, "listenTrades").mockImplementation(
    async (options) => {
      seen.push(options);
      return fixture;
    },
  );
  const sdk = createSolard({
    dbPath,
    rpcUrls: ["https://first.example.com", "https://second.example.com"],
  });
  try {
    expect(await sdk.listenTrades({ tokens: ["mint"] })).toBe(fixture);
    expect(seen[0]).toMatchObject({
      dbPath,
      rpcUrls: ["https://first.example.com", "https://second.example.com"],
      tokens: ["mint"],
    });
    await sdk.listenTrades();
    expect(seen[1]?.tokens).toEqual([]);
  } finally {
    sdk.close();
    listen.mockRestore();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("single RPC configuration is forwarded and absent URLs preserve live environment fallback", async () => {
  const folder = mkdtempSync(join(tmpdir(), "solard-sdk-listener-url-"));
  const seen: Array<live.ListenTradesOptions> = [];
  const listen = spyOn(live, "listenTrades").mockImplementation(
    async (options) => {
      seen.push(options);
      return {} as live.TradeListener;
    },
  );
  const first = createSolard({
    dbPath: join(folder, "first.sqlite"),
    rpcUrl: "https://configured.example.com",
  });
  const second = createSolard({ dbPath: join(folder, "second.sqlite") });
  try {
    await first.listenTrades();
    await second.listenTrades();
    expect(seen[0]?.rpcUrls).toEqual(["https://configured.example.com"]);
    expect(seen[1]?.rpcUrls).toBeUndefined();
  } finally {
    first.close();
    second.close();
    listen.mockRestore();
    rmSync(folder, { recursive: true, force: true });
  }
});
