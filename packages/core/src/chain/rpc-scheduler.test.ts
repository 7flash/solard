import { afterEach, expect, test } from "bun:test";
import { RpcScheduler, providerBudget } from "./rpc-scheduler.ts";
const keys = ["SLRD_RPC_PROVIDER_LIMITS", "SLRD_RPC_AGGREGATE_RPS", "SLRD_RPC_GATE_DB"] as const;
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
afterEach(() => { for (const key of keys) {
  if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
} });

test("sequential reads use spare rate capacity and permits release only once", async () => {
  delete process.env.SLRD_RPC_AGGREGATE_RPS;
  process.env.SLRD_RPC_PROVIDER_LIMITS = JSON.stringify({
    "rate-a.example": { group: "rate-a-r9", rps: 1, concurrency: 1 },
    "rate-b.example": { group: "rate-b-r9", rps: 1, concurrency: 1 },
  });
  const scheduler = new RpcScheduler();
  const urls = ["https://rate-a.example/", "https://rate-b.example/"];
  const first = await scheduler.acquireAny(urls, 1, 0);
  first.permit.release(); first.permit.release();
  expect(scheduler.capacity(urls[0]!).active).toBe(0);
  const second = await scheduler.acquireAny(urls, 1, 0, undefined, Date.now() + 100);
  expect(first.url).toBe(urls[0]!);
  expect(second.url).toBe(urls[1]!);
  second.permit.release();
});

test("queued admissions keep FIFO order and cancellation removes a waiter", async () => {
  delete process.env.SLRD_RPC_AGGREGATE_RPS;
  process.env.SLRD_RPC_PROVIDER_LIMITS = JSON.stringify({
    "fifo.example": { group: "fifo-r9", rps: 20, concurrency: 1 },
  });
  const scheduler = new RpcScheduler(), url = "https://fifo.example/";
  const held = await scheduler.acquire(url, 1, 0);
  const abort = new AbortController();
  const cancelled = scheduler.acquire(url, 1, 0, abort.signal)
    .then(() => false, error => error.name === "AbortError");
  const order: number[] = [];
  const first = scheduler.acquire(url, 1, 0).then(permit => { order.push(1); permit.release(); });
  const second = scheduler.acquire(url, 1, 0).then(permit => { order.push(2); permit.release(); });
  abort.abort();
  expect(await cancelled).toBe(true);
  held.release();
  await Promise.all([first, second]);
  expect(order).toEqual([1, 2]);
  expect(scheduler.capacity(url).waiting).toBe(0);
});
test("separate quota groups admit requests independently", async () => {
  process.env.SLRD_RPC_PROVIDER_LIMITS = JSON.stringify({
    "a.example": { group: "a-test", rps: 2, concurrency: 1 },
    "b.example": { group: "b-test", rps: 2, concurrency: 1 },
  });
  const scheduler = new RpcScheduler();
  const a = await scheduler.acquire("https://a.example/",1,0);
  const b = await scheduler.acquire("https://b.example/",1,0);
  expect(a).toBeDefined(); expect(b).toBeDefined(); a.release(); b.release();
});
test("one quota group enforces shared concurrency across endpoint aliases", async () => {
  process.env.SLRD_RPC_PROVIDER_LIMITS = JSON.stringify({
    "alias-a.example": { group: "shared-fixture", rps: 20, concurrency: 1 },
    "alias-b.example": { group: "shared-fixture", rps: 20, concurrency: 1 },
  });
  const scheduler = new RpcScheduler();
  const held = await scheduler.acquire("https://alias-a.example/",1,0);
  const abort = new AbortController();
  const next = scheduler.acquire("https://alias-b.example/",1,0,abort.signal,Date.now()+2500);
  abort.abort();
  await expect(next).rejects.toMatchObject({ name: "AbortError" });
  held.release();
});
test("aggregate cap blocks a second independent provider within the deadline", async () => {
  process.env.SLRD_RPC_AGGREGATE_RPS = "1";
  process.env.SLRD_RPC_PROVIDER_LIMITS = JSON.stringify({
    "aggregate-a.example": { group: "aggregate-a-fixture", rps: 10, concurrency: 2 },
    "aggregate-b.example": { group: "aggregate-b-fixture", rps: 10, concurrency: 2 },
  });
  const scheduler = new RpcScheduler();
  const first = await scheduler.acquire("https://aggregate-a.example/", 1, 0);
  first.release();
  await expect(scheduler.acquire("https://aggregate-b.example/", 1, 0,
    undefined, Date.now() + 30)).rejects.toMatchObject({ code: "RPC_QUEUE_TIMEOUT" });
});

test("endpoint hashes distinguish distinct plans on the same hostname", async () => {
  const { rpcEndpointIdentity } = await import("./rpc-scheduler.ts");
  const first = "https://same.example/?api-key=first";
  const second = "https://same.example/?api-key=second";
  expect(rpcEndpointIdentity(first)).not.toBe(rpcEndpointIdentity(second));
  process.env.SLRD_RPC_PROVIDER_LIMITS = JSON.stringify({
    [rpcEndpointIdentity(first)]: { group: "plan-one-r9", rps: 1, concurrency: 1 },
    [rpcEndpointIdentity(second)]: { group: "plan-two-r9", rps: 3, concurrency: 2 },
  });
  expect(providerBudget(first)).toMatchObject({ group: "plan-one-r9", rps: 1 });
  expect(providerBudget(second)).toMatchObject({ group: "plan-two-r9", rps: 3 });
});
