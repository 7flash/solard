import { describe, expect, spyOn, test } from "bun:test";
const mockFetch = (implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) =>
  spyOn(globalThis, "fetch").mockImplementation(implementation as typeof fetch);
import { Connection } from "@solana/web3.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, closeDatabase } from "../../core/src/db/database.ts";
import { SqliteTokenHistoryRepository } from "../../core/src/chain/token-history/repository.ts";
import {
  deriveWebSocketEndpoint,
  LiveEndpointPool,
  redactRpcEndpoint,
  subscribeTrades,
} from "./live.ts";

describe("sdk live endpoint", () => {
  test("derives websocket from the one RPC endpoint", () => {
    expect(
      deriveWebSocketEndpoint(
        "https://mainnet.helius-rpc.com/?api-key=secret-value",
      ),
    ).toBe("wss://mainnet.helius-rpc.com/?api-key=secret-value");
  });

  test("redacts API credentials in diagnostics", () => {
    expect(
      redactRpcEndpoint(
        "https://mainnet.helius-rpc.com/?api-key=secret-value&foo=bar",
      ),
    ).toBe("https://mainnet.helius-rpc.com/***");
  });
});
test("live endpoint selection requires readiness, sticks, and rotates after later failures", async () => {
  const calls: string[] = [];
  const unavailable = new Set(["https://first.example/"]);
  const pool = new LiveEndpointPool(
    [
      "https://first.example/",
      "https://second.example/",
      "https://public.example/",
    ],
    async (endpoint) => {
      calls.push(endpoint);
      if (unavailable.has(endpoint)) throw new Error("probe failed");
    },
  );
  expect(await pool.select()).toBe("https://second.example/");
  calls.length = 0;
  expect(await pool.select()).toBe("https://second.example/");
  expect(calls).toEqual(["https://second.example/"]);
  unavailable.add("https://second.example/");
  expect(await pool.check()).toBe("https://public.example/");
  unavailable.add("https://public.example/");
  await expect(pool.check()).rejects.toThrow("probe failed");
});

test("pooled trade stream preserves dynamic watched tokens when it rotates and closes", async () => {
  const originalSocket = globalThis.WebSocket;
  let firstHealthy = true;
  let nextId = 0;
  const registrations: Array<{ endpoint: string; ws: string; token: string }> = [];
  const first = "https://live-primary.example/";
  const second = "https://live-fallback.example/";
  const mint = "So11111111111111111111111111111111111111112";
  globalThis.WebSocket = class extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(payload: string) {
      const request = JSON.parse(payload) as { method?: string; id?: number };
      if (request.method === "slotSubscribe") queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
          jsonrpc: "2.0", id: request.id, result: 42,
        }) })));
    }
    close() {}
  } as any;
  const fetchMock = mockFetch(
    async (input, init) => {
      if (String(input) === first && !firstHealthy)
        return new Response("", { status: 401 });
      const method = JSON.parse(String(init?.body)).method;
      return new Response(JSON.stringify({ result: method === "getGenesisHash"
        ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
        : { context: { slot: 50 }, value: 0 } }));
    },
  );
  const logsMock = spyOn(Connection.prototype, "onLogs").mockImplementation(
    function (token) {
      registrations.push({ endpoint: this.rpcEndpoint,
        ws: (this as any)._rpcWsEndpoint, token: String(token) });
      return ++nextId;
    },
  );
  const removeMock = spyOn(
    Connection.prototype,
    "removeOnLogsListener",
  ).mockResolvedValue(undefined);
  let subscription: Awaited<ReturnType<typeof subscribeTrades>> | undefined;
  try {
    subscription = await subscribeTrades({ source: "rpc",
      tokens: [],
      rpcUrls: [first, second],
      healthCheckIntervalMs: 1000,
      onTrade() {},
    });
    await subscription.addTokens(mint);
    firstHealthy = false;
    const deadline = Date.now() + 3000;
    while (
      !registrations.some((row) => row.endpoint === second) &&
      Date.now() < deadline
    )
      await Bun.sleep(25);
    expect(registrations).toEqual([
      { endpoint: first, ws: "wss://live-primary.example/", token: mint },
      { endpoint: second, ws: "wss://live-fallback.example/", token: mint },
    ]);
    expect(subscription.listTokens()).toEqual([mint]);
    expect(subscription.hasToken(mint)).toBe(true);
    // A provider change must be explicitly reconciled by the application;
    // a rejected snapshot cannot re-enable trading callbacks.
    expect(subscription.feedVerified).toBe(false);
    const rejected = await subscription.verifyAndResume(async ({tokens}) => {
      expect(tokens).toEqual([mint]); return false;
    });
    expect(rejected).toBe(false);
    expect(subscription.feedVerified).toBe(false);
    const recovery = await subscription.verifyAndResume(async ({connection, tokens, signal}) => {
      expect(connection.rpcEndpoint).toBe(second);
      expect(tokens).toEqual([mint]);
      expect(signal.aborted).toBe(false);
      return true; // fixture represents successfully checked fresh pool/mint state
    });
    expect(recovery).toBe(true);
    expect(subscription.feedVerified).toBe(true);
    await expect(subscription.verifyAndResume(async () => new Promise<boolean>(() => {}), 5))
      .rejects.toThrow("Feed verification cancelled or timed out");
    await subscription.close();
    await subscription.closed;
    expect(subscription.listTokens()).toEqual([]);
    expect(removeMock).toHaveBeenCalledTimes(2);
  } finally {
    await subscription?.close();
    logsMock.mockRestore();
    removeMock.mockRestore();
    fetchMock.mockRestore();
    globalThis.WebSocket = originalSocket;
  }
});

test("listenTrades refreshes migrated identities without changing the watched token list", async () => {
  const core = await import("@solard/core");
  const { listenTrades } = await import("./live.ts");
  const mint = "So11111111111111111111111111111111111111112";
  const endpoint = "https://migration-listener.example/";
  const dir = mkdtempSync(join(tmpdir(), "slrd-sdk-listener-"));
  const dbPath = join(dir, "history.sqlite");
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(payload: string) {
      const request = JSON.parse(payload) as { method?: string; id?: number };
      if (request.method === "slotSubscribe") queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
          jsonrpc: "2.0", id: request.id, result: 42,
        }) })));
    }
    close() {}
  } as any;
  const fetchMock = mockFetch(
    async (_input, init) => {
      const method = JSON.parse(String(init?.body)).method;
      return new Response(JSON.stringify({ result: method === "getGenesisHash"
        ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
        : { context: { slot: 50 }, value: 0 } }));
    },
  );
  let onMigration: any;
  let onTrade: any;
  const tokens = new Set<string>();
  const changes: string[] = [];
  let closeTrade!: () => void;
  const tradeClosed = new Promise<void>((resolve) => {
    closeTrade = resolve;
  });
  const tradeMock = spyOn(core, "subscribeTrades").mockImplementation(
    async (options: any) => {
      options.tokens.forEach((t: string) => tokens.add(t));
      onTrade = options.onTrade;
      return {
        addTokens: async (value: any) => {
          changes.push("add");
          (typeof value === "string" ? [value] : value).forEach((t: string) =>
            tokens.add(t),
          );
        },
        removeTokens: async (value: any) => {
          changes.push("remove");
          (typeof value === "string" ? [value] : value).forEach((t: string) =>
            tokens.delete(t),
          );
        },
        hasToken: (t: string) => tokens.has(t),
        listTokens: () => [...tokens],
        close: async () => closeTrade(),
        closed: tradeClosed,
      };
    },
  );
  const migrationMock = spyOn(core, "subscribeMigrations").mockImplementation(
    async (options: any) => {
      onMigration = options.onMigration;
      let settle!: () => void;
      const closed = new Promise<void>(resolve => { settle = resolve; });
      return {
        mode: "selected",
        addTokens: async () => {},
        removeTokens: async () => {},
        hasToken: () => true,
        listTokens: () => options.tokens,
        close: async () => { settle(); },
        closed,
      } as any;
    },
  );
  let listener: Awaited<ReturnType<typeof listenTrades>> | undefined;
  try {
    listener = await listenTrades({ source: "rpc",
      tokens: [mint],
      rpcUrls: [endpoint],
      dbPath,
    });
    const received: any[] = [];
    listener.onMigration((event) => {
      received.push(event);
    });
    const event = {
      signature: "trade",
      mint,
      pool: "old-pool",
      venue: "pumpswap",
      side: "buy",
      eventIndex: 0,
      slot: 11,
      atMs: Date.now(),
      baseRaw: 1000000n,
      quoteRaw: 10000000n,
      market: {
        quoteMint: mint,
        baseDecimals: 6,
        quoteDecimals: 9,
        supplyRaw: 1000000000000000n,
        baseReserveRaw: 100000000n,
        quoteReserveRaw: 1000000000n,
        priceQuotePerToken: 0.01,
        priceSol: 0.01,
        priceUsd: 1,
        marketCapSol: 10000000,
        marketCapUsd: 1000000000,
      },
    };
    await onTrade(event);
    await onTrade(event);
    await onMigration({
      type: "migration",
      mint,
      pool: "new-pool",
      signature: "migration",
      slot: 12,
      venue: "pump",
      destination: "pumpswap",
      quoteMint: mint,
      atMs: Date.now(),
      isMayhemMode: false,
      metadata: null,
    });
    expect(changes).toEqual(["remove", "add"]);
    expect(listener.list()).toEqual([mint]);
    expect(received[0]).toMatchObject({
      oldPool: "old-pool",
      newPool: "new-pool",
      slot: 12,
    });
    await listener.close();
    await listener.closed;
    const repository = new SqliteTokenHistoryRepository(openDatabase(dbPath));
    expect(repository.loadTrades(mint)).toHaveLength(1);
    expect(repository.loadCandles1s(mint)).toHaveLength(1);
    closeDatabase(dbPath);
  } finally {
    await listener?.close();
    closeDatabase(dbPath);
    tradeMock.mockRestore();
    migrationMock.mockRestore();
    fetchMock.mockRestore();
    globalThis.WebSocket = originalSocket;
    rmSync(dir, { recursive: true, force: true });
  }
});
