import { afterEach, expect, spyOn, test } from "bun:test";
const mockFetch = (implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) =>
  spyOn(globalThis, "fetch").mockImplementation(implementation as typeof fetch);
import { SolardRpcEndpointPool } from "./connection.ts";
const keys = ["SLRD_RPC_PROVIDER_LIMITS", "SLRD_RPC_AGGREGATE_RPS", "SLRD_RPC_VERIFY_MAINNET", "SLRD_RPC_QUEUE_TIMEOUT_MS"] as const;
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
afterEach(() => { for (const key of keys) {
  if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
} });
test("six getBalance calls split before five-call admission and return in caller order", async () => {
  process.env.SLRD_RPC_PROVIDER_LIMITS = JSON.stringify({ "batch-fixture.example": {
    group: "batch-r8", rps: 5, concurrency: 1 } });
  delete process.env.SLRD_RPC_VERIFY_MAINNET;
  let calls = 0;
  const spy = mockFetch(async (_url,init) => {
    calls++; const requests = JSON.parse(String(init?.body));
    expect(requests.length).toBeLessThanOrEqual(5);
    return new Response(JSON.stringify(requests.map((item: {id:number}) =>
      ({jsonrpc:"2.0",id:item.id,result:{value:item.id}}))));
  });
  try {
    const pool = new SolardRpcEndpointPool(["https://batch-fixture.example/"]);
    const body = JSON.stringify(Array.from({length:6},(_,i) => ({ jsonrpc:"2.0", id:i+1,
      method:"getBalance",params:["11111111111111111111111111111111"] })));
    const response = await pool.fetch("ignored", {body});
    const result = await response.json() as Array<{id:number}>;
    expect(result.map(row => row.id)).toEqual([1,2,3,4,5,6]);
    expect(calls).toBe(2);
  } finally { spy.mockRestore(); }
});
test("ambiguous signed send never tries backup provider", async () => {
  delete process.env.SLRD_RPC_VERIFY_MAINNET;
  const paths: string[] = [];
  const spy = mockFetch(async input => {
    paths.push(String(input)); throw new Error("connection lost after send");
  });
  try {
    const pool = new SolardRpcEndpointPool(["https://sign-a.example/", "https://sign-b.example/"]);
    await expect(pool.fetch("ignored", {body:JSON.stringify({method:"sendTransaction",params:["signed"]})})).rejects.toThrow();
    expect(paths).toEqual(["https://sign-a.example/"]);
  } finally { spy.mockRestore(); }
});

test("single pool dispatches simultaneous reads to distinct independent quota groups", async () => {
  const before = process.env.SLRD_RPC_PROVIDER_LIMITS;
  process.env.SLRD_RPC_PROVIDER_LIMITS = JSON.stringify({
    "spread-a.example": { group: "spread-a-r9", rps: 5, concurrency: 1 },
    "spread-b.example": { group: "spread-b-r9", rps: 5, concurrency: 1 },
  });
  delete process.env.SLRD_RPC_VERIFY_MAINNET;
  const starts: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const mock = mockFetch(async input => {
    starts.push(String(input));
    await gate;
    return Response.json({ jsonrpc: "2.0", result: { value: 0 } });
  });
  try {
    const pool = new SolardRpcEndpointPool([
      "https://spread-a.example/", "https://spread-b.example/",
    ]);
    const one = pool.fetch("unused", { body: '{"method":"getBalance","id":1}' });
    const two = pool.fetch("unused", { body: '{"method":"getBalance","id":2}' });
    const deadline = Date.now() + 1000;
    while (starts.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(starts).toContain("https://spread-a.example/");
    expect(starts).toContain("https://spread-b.example/");
    release();
    await Promise.all([one,two]);
  } finally {
    release(); mock.mockRestore();
    if (before === undefined) delete process.env.SLRD_RPC_PROVIDER_LIMITS;
    else process.env.SLRD_RPC_PROVIDER_LIMITS = before;
  }
});
