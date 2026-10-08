import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedRpcWindow, rpcRequestCost } from "./shared-rpc-window.ts";

test("sliding window allows an immediate burst and releases its exact oldest reservations", () => {
  const gate = new SharedRpcWindow();
  const options = { maxRequests: 3, windowMs: 1100 };
  expect(gate.reserve(options, 1, 0, 1000)).toBe(0);
  expect(gate.reserve(options, 1, 0, 1000)).toBe(0);
  expect(gate.reserve(options, 1, 0, 1050)).toBe(0);
  expect(gate.reserve(options, 1, 0, 1100)).toBe(1000);
  expect(gate.reserve(options, 2, 0, 2100)).toBe(0);
  expect(gate.reserve(options, 1, 0, 2100)).toBe(50);
});

test("send budget is independent, while batch operation counts cannot bypass the limit", () => {
  const gate = new SharedRpcWindow();
  const options = { maxRequests: 10, windowMs: 1100 };
  expect(gate.reserve(options, 1, 1, 1000)).toBe(0);
  expect(gate.reserve(options, 1, 1, 1001)).toBe(999);
  expect(gate.reserve(options, 1, 0, 1001)).toBe(0);
  expect(gate.reserve(options, 1, 1, 2000)).toBe(0);
  expect(
    rpcRequestCost(
      JSON.stringify([{ method: "getBalance" }, { method: "sendTransaction" }]),
    ),
  ).toEqual({ requests: 2, sends: 1 });
  expect(() => gate.reserve(options, 11, 0, 2000)).toThrow("budget");
});

test("SQLite reservation persists across handles without overwriting existing data", () => {
  const path = mkdtempSync(join(tmpdir(), "solard-rpc-window-"));
  const first = new SharedRpcWindow(join(path, "gate.sqlite"));
  const second = new SharedRpcWindow(join(path, "gate.sqlite"));
  try {
    const options = { maxRequests: 1, windowMs: 1100 };
    expect(first.reserve(options, 1, 0, 1000)).toBe(0);
    expect(second.reserve(options, 1, 0, 1000)).toBe(1100);
    expect(second.reserve(options, 1, 0, 2100)).toBe(0);
  } finally {
    first.close();
    second.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test("independent Bun processes atomically share one send/request budget", async () => {
  const path = mkdtempSync(join(tmpdir(), "solard-rpc-process-window-"));
  const dbPath = join(path, "gate.sqlite");
  const seed = new SharedRpcWindow(dbPath);
  seed.close();
  const moduleUrl = new URL("./shared-rpc-window.ts", import.meta.url).href;
  const source = `import {SharedRpcWindow} from ${JSON.stringify(moduleUrl)};const gate=new SharedRpcWindow(${JSON.stringify(dbPath)});console.log(gate.reserve({maxRequests:1,windowMs:1100},1,1,1000));gate.close();`;
  try {
    const children = [0, 1].map(() =>
      Bun.spawn([process.execPath, "-e", source], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const values = await Promise.all(
      children.map(async (child) => {
        const output = await new Response(child.stdout).text();
        const error = await new Response(child.stderr).text();
        expect(await child.exited).toBe(0);
        expect(error).toBe("");
        return Number(output.trim());
      }),
    );
    expect(values.sort((a, b) => a - b)).toEqual([0, 1100]);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
