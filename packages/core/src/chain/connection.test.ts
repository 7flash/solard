import { expect, spyOn, test } from "bun:test";
import {
  SolardConnection,
  SolardRpcEndpointPool,
  solardRpcFetch,
} from "./connection.ts";

test("oversized history batches split within the request window and preserve RPC IDs", async () => {
  const names = [
    "SLRD_RPC_MAX_RPS",
    "SLRD_RPC_MAX_REQUESTS",
    "SLRD_RPC_WINDOW_MS",
  ] as const;
  const previous = names.map((name) => process.env[name]);
  process.env.SLRD_RPC_MAX_RPS = "10000";
  process.env.SLRD_RPC_MAX_REQUESTS = "2";
  process.env.SLRD_RPC_WINDOW_MS = "1";
  const batches: number[][] = [];
  const mock = spyOn(globalThis, "fetch").mockImplementation(
    async (_input, init) => {
      const rows = JSON.parse(String(init?.body)) as Array<{ id: number }>;
      batches.push(rows.map((row) => row.id));
      return new Response(
        JSON.stringify(
          rows.map((row) => ({ jsonrpc: "2.0", id: row.id, result: null })),
        ),
      );
    },
  );
  try {
    const rows = Array.from({ length: 5 }, (_, id) => ({
      jsonrpc: "2.0",
      id,
      method: "getTransaction",
      params: [`fixture-${id}`],
    }));
    const response = await solardRpcFetch("https://batch.example/", {
      method: "POST",
      body: JSON.stringify(rows),
    });
    expect(batches).toEqual([[0, 1], [2, 3], [4]]);
    expect(
      (await response.json()).map((row: { id: number }) => row.id),
    ).toEqual([0, 1, 2, 3, 4]);
  } finally {
    mock.mockRestore();
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});

test("RPC pool rotates on quota/auth/transport failures and sticks to the working endpoint", async () => {
  const previousRps = process.env.SLRD_RPC_MAX_RPS;
  const previousSendWindow = process.env.SLRD_RPC_SEND_WINDOW_MS;
  process.env.SLRD_RPC_MAX_RPS = "10000";
  process.env.SLRD_RPC_SEND_WINDOW_MS = "1";
  const calls: string[] = [];
  const bodies: unknown[] = [];
  let unavailable = new Response("", { status: 429 });
  const mock = spyOn(globalThis, "fetch").mockImplementation(
    async (input, init) => {
      calls.push(String(input));
      bodies.push(init?.body);
      if (String(input) === "https://first.example/")
        return unavailable.clone();
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }),
      );
    },
  );
  try {
    const body = JSON.stringify({
      method: "sendTransaction",
      params: ["SAME_SIGNED_BYTES"],
    });
    for (const failure of [
      new Response("", { status: 429 }),
      new Response("", { status: 401 }),
      new Response("", { status: 403 }),
      new Response(JSON.stringify({ error: { message: "max usage reached" } })),
    ]) {
      calls.length = 0;
      unavailable = failure;
      const pool = new SolardRpcEndpointPool([
        "https://first.example/",
        "https://second.example/",
      ]);
      expect(
        (await pool.fetch("https://first.example/", { method: "POST", body }))
          .ok,
      ).toBe(true);
      await pool.fetch("https://first.example/", { method: "POST", body });
      expect(calls).toEqual([
        "https://first.example/",
        "https://second.example/",
        "https://second.example/",
      ]);
      expect(pool.activeRpcUrl).toBe("https://second.example/");
    }
    expect(bodies.every((value) => value === body)).toBe(true);
    mock.mockImplementation(async (input) => {
      if (String(input) === "https://first.example/")
        throw new Error("connection reset");
      return new Response(JSON.stringify({ result: "ok" }));
    });
    const pool = new SolardRpcEndpointPool([
      "https://first.example/",
      "https://second.example/",
    ]);
    expect((await pool.fetch("unused", { body })).ok).toBe(true);
    expect(pool.activeRpcUrl).toBe("https://second.example/");
  } finally {
    mock.mockRestore();
    if (previousRps === undefined) delete process.env.SLRD_RPC_MAX_RPS;
    else process.env.SLRD_RPC_MAX_RPS = previousRps;
    if (previousSendWindow === undefined)
      delete process.env.SLRD_RPC_SEND_WINDOW_MS;
    else process.env.SLRD_RPC_SEND_WINDOW_MS = previousSendWindow;
  }
});

test("program errors and aborted requests do not rotate endpoints", async () => {
  const calls: string[] = [];
  const mock = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    calls.push(String(input));
    return new Response(
      JSON.stringify({
        error: { message: "Transaction simulation failed: Custom 6042" },
      }),
    );
  });
  try {
    const pool = new SolardRpcEndpointPool([
      "https://first.example/",
      "https://second.example/",
    ]);
    const response = await pool.fetch("unused", { body: "{}" });
    expect((await response.json()).error.message).toContain("Custom 6042");
    expect(calls).toHaveLength(1);
    mock.mockImplementation(async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    await expect(pool.fetch("unused", { body: "{}" })).rejects.toThrow(
      "cancelled",
    );
    expect(pool.activeRpcUrl).toBe("https://first.example/");
  } finally {
    mock.mockRestore();
  }
});

test("connection accepts an endpoint list while preserving the old constructor", () => {
  const connection = new SolardConnection(undefined, "confirmed", {
    rpcUrls: ["https://first.example/", "https://second.example/"],
  });
  expect(connection.get().rpcEndpoint).toBe("https://first.example/");
  expect(connection.activeRpcUrl).toBe("https://first.example/");
  expect(
    new SolardConnection("https://legacy.example/").get().rpcEndpoint,
  ).toBe("https://legacy.example/");
});
