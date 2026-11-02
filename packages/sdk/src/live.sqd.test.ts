import { expect, spyOn, test } from "bun:test";
import { Connection } from "@solana/web3.js";
import { listenTrades, subscribeLaunches } from "./live.ts";
import { address, portalBlock, portalFixture, until } from "../../core/src/events/fixtures/portal.ts";
import { subscribeTrades } from "./live.ts";

test("SDK defaults to SQD without RPC/WebSocket probes and retains dynamic listener lifecycle", async () => {
  const portal = portalFixture();
  const rpcCalls = spyOn(Connection.prototype, "onLogs").mockImplementation(() => { throw new Error("Unexpected RPC WebSocket"); });
  const statuses: string[] = [];
  const listener = await listenTrades({ tokens: [], history: false, rpcUrls: ["https://unused-rpc.example"],
    sqd: { fetch: portal.fetcher, pollIntervalMs: 5 }, onStatus: event => statuses.push(event) });
  try {
    expect(rpcCalls).not.toHaveBeenCalled(); expect(statuses).toContain("source-ready");
    expect(statuses).not.toContain("rpc-ready");
    const mint = address(55).toBase58();
    await listener.add(mint); expect(listener.has(mint)).toBe(true); expect(listener.list()).toEqual([mint]);
    await until(() => portal.requests.some(row => row.query?.instructions?.some((filter: { mentionsAccount?: string[] }) => filter.mentionsAccount?.includes(mint))));
    await listener.remove(mint); expect(listener.has(mint)).toBe(false);
    expect(listener.list()).toEqual([]);
  } finally { await listener.close(); rpcCalls.mockRestore(); }
  await listener.closed;
  expect(listener.feedVerified).toBe(false);
});

test("SQD launch startup errors reach SDK callers instead of claiming WebSocket readiness", async () => {
  let calls = 0;
  await expect(subscribeLaunches({ venues: ["pump"], rpcUrls: ["https://unused-rpc.example"],
    sqd: { fromSlot: 10, fetch: (async () => { calls++; return new Response(null, { status: 400 }); }) as unknown as typeof fetch },
    onLaunch() {},
  })).rejects.toThrow("SQD_FATAL_HTTP_400");
  expect(calls).toBe(1);
});

test("a quiet SQD token remains verified while fresh header-only blocks keep arriving", async () => {
  const clock = spyOn(Date, "now");
  let now = 1_790_000_000_000;
  clock.mockImplementation(() => now);
  const mint = address(60).toBase58();
  const portal = portalFixture([portalBlock(10, [], [])]);
  let progress = 0;
  const subscription = await subscribeTrades({ tokens: [mint], rpcUrls: ["https://unused-rpc.example"],
    sqd: { fromSlot: 10, fetch: portal.fetcher, pollIntervalMs: 5 },
    onStatus(event) { if (event === "source-progress") progress++; }, onTrade() {},
  });
  try {
    await until(() => progress === 1);
    expect(subscription.feedVerified).toBe(true);
    now += 61_000;
    expect(subscription.feedVerified).toBe(false);
    portal.enqueue(portalBlock(11, [], []));
    await until(() => progress === 2);
    expect(subscription.feedVerified).toBe(true);
  } finally { await subscription.close(); clock.mockRestore(); }
});
