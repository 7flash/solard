import { afterEach, expect, test } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { SharedRpcWindow, rpcGateDbPath } from "./shared-rpc-window.ts";

const saved = { gate: process.env.SLRD_RPC_GATE_DB, env: process.env.NODE_ENV };
afterEach(() => {
  if (saved.gate === undefined) delete process.env.SLRD_RPC_GATE_DB; else process.env.SLRD_RPC_GATE_DB = saved.gate;
  process.env.NODE_ENV = saved.env;
});

test("cross-process RPC gate is on by default outside tests", () => {
  delete process.env.SLRD_RPC_GATE_DB;
  process.env.NODE_ENV = "production";
  expect(rpcGateDbPath()).toBe(join(homedir(), ".solard", "rpc-gate.sqlite"));
  process.env.NODE_ENV = "test";
  expect(rpcGateDbPath()).toBeUndefined();
});

test("explicit path and opt-out", () => {
  process.env.SLRD_RPC_GATE_DB = "/x/gate.sqlite";
  expect(rpcGateDbPath()).toBe("/x/gate.sqlite");
  for (const off of ["", "off", "0", "memory"]) { process.env.SLRD_RPC_GATE_DB = off; expect(rpcGateDbPath()).toBeUndefined(); }
});

test("two windows on one file share a single budget", () => {
  const path = join(mkdtempSync(join(tmpdir(), "rpc-gate-")), "gate.sqlite");
  const a = new SharedRpcWindow(path), b = new SharedRpcWindow(path);
  const opts = { maxRequests: 5, windowMs: 1000 };
  const now = Date.now();
  for (let i = 0; i < 3; i++) expect(a.reserve(opts, 1, 0, now)).toBe(0);
  for (let i = 0; i < 2; i++) expect(b.reserve(opts, 1, 0, now)).toBe(0);
  expect(a.reserve(opts, 1, 0, now)).toBeGreaterThan(0);
  expect(b.reserve(opts, 1, 0, now)).toBeGreaterThan(0);
  a.close(); b.close();
});
