import { fileURLToPath } from "url";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
const mockFetch = (implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) =>
  spyOn(globalThis, "fetch").mockImplementation(implementation as typeof fetch);
import * as fs from "fs";
import { mkdtempSync, readFileSync } from "fs";
const rmSync = Reflect.get(fs, "rmSync") as (path: string, options: {force?: boolean; recursive?: boolean}) => void;
import { tmpdir } from "os";
import { join } from "path";
import { activateRpc, effectiveRpc, loadRpcConfig, saveRpcConfig, probeHttp, safeUrl } from "./rpc-management.ts";
const dir = mkdtempSync(join(tmpdir(), "slrd-rpc-r8-"));
const keys = ["SLRD_RPC_CONFIG_PATH", "RPC_ENDPOINT", "SLRD_RPC_URLS", "SLRD_WS_URLS", "SLRD_RPC_PROVIDER_LIMITS", "SLRD_RPC_AGGREGATE_RPS", "SLRD_RPC_VERIFY_MAINNET"] as const;
const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
process.env.SLRD_RPC_CONFIG_PATH = join(dir, "rpc.json");
afterEach(() => { rmSync(process.env.SLRD_RPC_CONFIG_PATH!, { force: true }); for (const key of keys) {
  const value = before[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value;
} process.env.SLRD_RPC_CONFIG_PATH = join(dir, "rpc.json"); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); for (const key of keys) {
  const value = before[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value;
} });

test("environment-only configuration appears in effective probes", () => {
  process.env.RPC_ENDPOINT = "https://env-only.example/?api-key=secret";
  const state = effectiveRpc();
  expect(state.http).toHaveLength(1);
  expect(state.source).toBe("environment");
  expect(safeUrl(state.http[0]!)).not.toContain("secret");
});
test("flags outrank environment but preserve saved read fallbacks", () => {
  const config = loadRpcConfig();
  config.http = [{ url: "https://saved.example/", group: "saved", rps: 12, concurrency: 2 }];
  saveRpcConfig(config);
  process.env.RPC_ENDPOINT = "https://env.example/";
  const effective = effectiveRpc(new Map([["rpc-url", "https://explicit.example/"]]));
  expect(effective.http[0]).toContain("explicit.example");
  expect(effective.http).toContain("https://saved.example/");
  activateRpc(new Map([["rpc-url", "https://explicit.example/"]]));
  expect(JSON.parse(process.env.SLRD_RPC_URLS!)).toEqual(effective.http);
  const limits = JSON.parse(process.env.SLRD_RPC_PROVIDER_LIMITS!) as Record<string, {rps:number}>;
  expect(Object.values(limits).some(value => value.rps === 12)).toBe(true);
  expect(Object.keys(limits).every(key => /^[a-f0-9]{64}$/.test(key))).toBe(true);
});
test("credentials never appear in redacted display; stored file keeps supplied URL", () => {
  const config = loadRpcConfig(); config.http = [{ url: "https://secured.example/?api-key=private", group: "one", rps: 5, concurrency: 1 }];
  saveRpcConfig(config);
  expect(readFileSync(process.env.SLRD_RPC_CONFIG_PATH!, "utf8")).toContain("private");
  expect(safeUrl(config.http[0]!.url)).not.toContain("private");
});
test("mainnet readiness rejects quota-exhausted account reads", async () => {
  const calls: string[] = [];
  const mock = mockFetch(async (_url, init) => {
    const method = JSON.parse(String(init?.body)).method;
    calls.push(method);
    return new Response(JSON.stringify(method === "getGenesisHash"
      ? { result: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" }
      : { error: { code: -32005, message: "max usage reached" } }));
  });
  try { expect((await probeHttp("https://testing.example/?api-key=private")).state).toBe("unavailable");
    expect(calls).toEqual(["getGenesisHash", "getBalance"]);
  } finally { mock.mockRestore(); }
});
test("mainnet readiness accepts zero balance and null account with valid context", async () => {
  const mock = mockFetch(async (_url, init) => {
    const method = JSON.parse(String(init?.body)).method;
    const result = method === "getGenesisHash" ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
      : { context: { slot: 44 }, value: method === "getBalance" ? 0 : null };
    return new Response(JSON.stringify({ result }));
  });
  try { expect((await probeHttp("https://healthy.example/")).state).toBe("healthy"); }
  finally { mock.mockRestore(); }
});


test("CLI add/status/test honor effective endpoints and redact credentials without wallet access", async () => {
  const calls: string[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as { id: number; method: string };
    calls.push(body.method);
    const result = body.method === "getGenesisHash"
      ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
      : { context: { slot: 123 }, value: body.method === "getBalance" ? 0 : null };
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  } });
  const endpoint = `http://127.0.0.1:${server.port}/?api-key=cli-fixture-secret`;
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./index.ts", import.meta.url)), ...args], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        SLRD_RPC_CONFIG_PATH: join(dir, "rpc-cli.json"),
        RPC_ENDPOINT: endpoint, SLRD_RPC_URLS: "[]", SLRD_WS_URLS: "[]" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout + stderr).not.toContain("cli-fixture-secret");
    return stdout;
  };
  try {
    await run("rpc", "add", "http", endpoint, "--group", "cli-fixture");
    const status = JSON.parse(await run("rpc", "status"));
    expect(status.source).toBe("environment");
    expect(status.health[0].state).toBe("healthy");
    expect(status.active).toContain("127.0.0.1");
    await run("rpc", "test", "--rpc-url", endpoint);
    expect(calls.filter(method => method === "getAccountInfo")).toHaveLength(2);
  } finally { server.stop(true); }
}, 30000); // Three CLI subprocesses exceed Bun's 5s default on a cold Windows start.
