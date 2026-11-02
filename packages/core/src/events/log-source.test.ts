import { expect, test } from "bun:test";
import type { Connection, Logs } from "@solana/web3.js";
import { createEventLogSource } from "./log-source.ts";
import { address, portalBlock, portalFixture, until } from "./fixtures/portal.ts";

const noRpc = { onLogs() { throw new Error("Unexpected WebSocket subscription"); } } as unknown as Connection;
const mint = address(30), other = address(31), program = address(32).toBase58();

test("SQD is default: coalesced query, explicit indices, failed transaction filtering and ordered base64 logs", async () => {
  const block = portalBlock(10, [mint.toBase58(), program], [{ program, bytes: Buffer.from([1, 2, 3]) }]);
  block.transactions.push({ transactionIndex: 9, accountKeys: [other.toBase58()], signatures: ["failed"], err: { Custom: 1 } } as any);
  const fixture = portalFixture([block, block]);
  const source = createEventLogSource(noRpc, { sqd: { fetch: fixture.fetcher, pollIntervalMs: 5 } });
  const logs: Logs[] = [], others: Logs[] = [];
  source.onLogs(mint, event => logs.push(event));
  source.onLogs(other, event => others.push(event));
  try {
    await source.ready(); await until(() => fixture.requests.length >= 3);
    expect(source.source).toBe("sqd"); expect(source.commitment).toBe("processed");
    expect(logs).toHaveLength(1); expect(others).toHaveLength(0);
    expect(logs[0]!.logs).toEqual([`Program ${program} invoke [1]`, "Program data: AQID", `Program ${program} success`]);
    const query = fixture.requests.find(row => row.query)!.query!;
    expect(query.instructions[0].mentionsAccount).toEqual([mint.toBase58(), other.toBase58()]);
    expect(query.fields.log.logIndex).toBe(true);
    expect(query.fields.transaction.transactionIndex).toBe(true);
    expect(fixture.requests.filter(row => row.query)[1]!.query!.fromBlock).toBe(11);
  } finally { await source.close(); }
  await source.closed;
});

test("dynamic watches abort the old query and resume from the last delivered block without skipping unread slots", async () => {
  const requests: Record<string, any>[] = [];
  let aborted = 0;
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init!.body)));
    return await new Promise<Response>((_resolve, reject) => {
      const abort = () => { aborted++; reject(new DOMException("Aborted", "AbortError")); };
      init!.signal!.addEventListener("abort", abort, { once: true });
      if (init!.signal!.aborted) abort();
    });
  }) as unknown as typeof fetch;
  const source = createEventLogSource(noRpc, { sqd: { fromSlot: 50, fetch: fetcher } });
  const first = source.onLogs(mint, () => {});
  await until(() => requests.length === 1);
  const second = source.onLogs(other, () => {});
  await until(() => requests.length === 2);
  await source.removeOnLogsListener(first);
  await until(() => requests.length === 3);
  expect(requests.map(row => row.fromBlock)).toEqual([50, 50, 50]);
  expect(requests[2]!.instructions[0].mentionsAccount).toEqual([other.toBase58()]);
  await source.removeOnLogsListener(second); await source.close();
  expect(aborted).toBe(3);
});

test("watched addresses are split into Portal filters of at most 10 values", async () => {
  const requests: Record<string, any>[] = [];
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init!.body)));
    return await new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  }) as unknown as typeof fetch;
  const source = createEventLogSource(noRpc, { sqd: { fromSlot: 50, fetch: fetcher } });
  const watched = Array.from({ length: 23 }, (_, i) => address(100 + i));
  for (const key of watched) source.onLogs(key, () => {});
  await until(() => requests.at(-1)?.instructions.length === 6);
  const filters = requests.at(-1)!.instructions as Record<string, string[]>[];
  for (const filter of filters) expect((filter.mentionsAccount ?? filter.programId)!.length).toBeLessThanOrEqual(10);
  expect(filters.flatMap(filter => filter.mentionsAccount ?? [])).toEqual(watched.map(key => key.toBase58()));
  expect(filters.flatMap(filter => filter.programId ?? [])).toEqual(watched.map(key => key.toBase58()));
  await source.close();
});

test("programScope restricts watched-address filters to the given programs' instructions", async () => {
  const requests: Record<string, any>[] = [];
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init!.body)));
    return await new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  }) as unknown as typeof fetch;
  const source = createEventLogSource(noRpc, { sqd: { fromSlot: 50, fetch: fetcher }, programScope: [program] });
  const watched = Array.from({ length: 12 }, (_, i) => address(200 + i));
  for (const key of watched) source.onLogs(key, () => {});
  await until(() => requests.at(-1)?.instructions.length === 2);
  const filters = requests.at(-1)!.instructions as Record<string, string[]>[];
  for (const filter of filters) expect(filter.programId).toEqual([program]);
  expect(filters.flatMap(filter => filter.mentionsAccount)).toEqual(watched.map(key => key.toBase58()));
  await source.close();
});

test("SQD 429 pauses retries and preserves its cursor", async () => {
  const starts: number[] = [];
  let count = 0;
  const fetcher = (async () => {
    starts.push(performance.now()); count++;
    return count === 1 ? new Response(null, { status: 429, headers: { "Retry-After": "1.05" } }) : new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const statuses: string[] = [];
  const source = createEventLogSource(noRpc, { sqd: { fromSlot: 10, fetch: fetcher }, onStatus: event => statuses.push(event) });
  source.onLogs(mint, () => {});
  try {
    await source.ready();
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1040);
    expect(statuses).toContain("source-retrying");
  } finally { await source.close(); }
});

test("a hot fork closes delivery and surfaces an unverified gap rather than silently replaying effects", async () => {
  let count = 0;
  const statuses: string[] = [];
  const fetcher = (async () => ++count === 1
    ? new Response(JSON.stringify(portalBlock(10, [mint.toBase58()], [])) + "\n")
    : new Response(null, { status: 409 })) as unknown as typeof fetch;
  const source = createEventLogSource(noRpc, { sqd: { fromSlot: 10, fetch: fetcher }, onStatus: event => statuses.push(event) });
  source.onLogs(mint, () => {});
  await source.ready(); await source.closed;
  expect(count).toBe(2); expect(statuses).toContain("feed-gap-unverified");
  expect(() => source.onLogs(mint, () => {})).toThrow("closed");
});

test("confirmed SQD subscriptions use finalized delivery and handle split NDJSON", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(portalBlock(10, [mint.toBase58()], [{ program, bytes: Buffer.from("payload") }])));
  const urls: string[] = [];
  let count = 0, delivered = 0;
  const fetcher = (async (input: RequestInfo | URL) => {
    urls.push(String(input)); count++;
    return count === 1 ? new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, 17)); controller.enqueue(bytes.slice(17)); controller.close();
    } })) : new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const source = createEventLogSource(noRpc, { commitment: "confirmed", sqd: { fromSlot: 10, fetch: fetcher } });
  source.onLogs(mint, () => { delivered++; });
  try { await source.ready(); await until(() => delivered === 1);
    expect(source.commitment).toBe("finalized"); expect(urls[0]).toEndWith("/finalized-stream");
  } finally { await source.close(); }
});

test("invalid SQD queries fail startup without falling back to RPC", async () => {
  const source = createEventLogSource(noRpc, { sqd: { fromSlot: 10,
    fetch: (async () => new Response(null, { status: 400 })) as unknown as typeof fetch } });
  source.onLogs(mint, () => {});
  await expect(source.ready()).rejects.toThrow("SQD_FATAL_HTTP_400");
  await source.close();
});

test("SQD head throttling honors Retry-After too", async () => {
  const starts: number[] = [];
  const source = createEventLogSource(noRpc, { sqd: { fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body) return new Response(null, { status: 204 });
    starts.push(performance.now());
    return starts.length === 1 ? new Response(null, { status: 429, headers: { "Retry-After": "1.05" } }) : Response.json({ number: 10 });
  }) as unknown as typeof fetch } });
  source.onLogs(mint, () => {});
  try { await source.ready(); expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1040); }
  finally { await source.close(); }
});

test("an application callback failure does not replay the block or prevent other listeners", async () => {
  const portal = portalFixture([portalBlock(10, [mint.toBase58()], [{ program, bytes: Buffer.from("event") }])]);
  const statuses: string[] = [];
  const source = createEventLogSource(noRpc, { sqd: { fromSlot: 10, fetch: portal.fetcher, pollIntervalMs: 5 }, onStatus: event => statuses.push(event) });
  let failed = 0, delivered = 0;
  source.onLogs(mint, () => { failed++; throw Error("Application failure"); });
  source.onLogs(mint, () => { delivered++; });
  try {
    await source.ready(); await until(() => portal.requests.length >= 2);
    expect(failed).toBe(1); expect(delivered).toBe(1);
    expect(statuses).toContain("source-callback-error");
    expect(portal.requests[1]!.query!.fromBlock).toBe(11);
  } finally { await source.close(); }
});

test("closing SQD cancels a pending head request and settles readiness", async () => {
  let entered = false;
  const source = createEventLogSource(noRpc, { sqd: { fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
    entered = true;
    return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  }) as unknown as typeof fetch } });
  source.onLogs(mint, () => {});
  await until(() => entered);
  await source.close();
  await expect(source.ready()).rejects.toThrow();
});

test("explicit RPC uses the same source interface and removes owned subscriptions once", async () => {
  const removed: number[] = []; let registrations = 0;
  const source = createEventLogSource({ onLogs() { return ++registrations; }, async removeOnLogsListener(id: number) { removed.push(id); } } as unknown as Connection,
    { source: "rpc", commitment: "confirmed" });
  const id = source.onLogs(mint, () => {});
  source.onLogs(other, () => {}); await source.ready();
  await source.removeOnLogsListener(id); await source.close(); await source.close();
  expect(source.source).toBe("rpc"); expect(source.commitment).toBe("confirmed"); expect(removed).toEqual([1, 2]);
});
