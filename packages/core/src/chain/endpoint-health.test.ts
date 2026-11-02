import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { classifyEndpointResponse, endpointDead, markEndpointDead, rateCooldownMs, resetEndpointMarks } from "./endpoint-health.ts";

afterEach(() => { delete process.env.SLRD_RPC_HEALTH_FILE; resetEndpointMarks(); });

test("429 'max usage reached' is credits exhausted, plain 429 is rate", async () => {
  expect(await classifyEndpointResponse(new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32429, message: "max usage reached" } }), { status: 429 }))).toBe("exhausted");
  expect(await classifyEndpointResponse(new Response("Too Many Requests", { status: 429 }))).toBe("rate");
  expect(await classifyEndpointResponse(new Response("", { status: 401 }))).toBe("auth");
  expect(await classifyEndpointResponse(new Response("", { status: 503 }))).toBe("server");
  expect(await classifyEndpointResponse(new Response(JSON.stringify({ result: 1 }), { headers: { "content-type": "application/json" } }))).toBe("ok");
});

test("dead marks are shared through the health file and expire", () => {
  const path = join(mkdtempSync(join(tmpdir(), "health-")), "rpc-health.json");
  process.env.SLRD_RPC_HEALTH_FILE = path;
  const url = "https://mainnet.example/?api-key=secret";
  markEndpointDead(url, "exhausted", "https://mainnet.example/***", "HTTP 429 exhausted", 1_000);
  expect(readFileSync(path, "utf8")).not.toContain("secret");
  resetEndpointMarks(); // a different process would read the file fresh
  expect(endpointDead(url, 1_000 + 23 * 3_600_000)?.state).toBe("exhausted");
  expect(endpointDead(url, 1_000 + 25 * 3_600_000)).toBeNull();
});

test("rate cooldown is short and bounded", () => {
  expect(rateCooldownMs(1)).toBe(1_000);
  expect(rateCooldownMs(10)).toBe(8_000);
  expect(rateCooldownMs(1, 3_000)).toBe(3_000);
});
