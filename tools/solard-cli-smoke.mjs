#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const bin = process.env.SOLARD_SMOKE_BIN ?? "bun";
const entry = process.env.SOLARD_SMOKE_ENTRY ?? "bin/solard.ts";
const commands = [
  ["health", "--json"],
  ["wallets", "--json"],
  ["tokens", "--json"],
  ["groups", "--json"],
  ["watch", "list", "--json"],
  ["watch", "group", "list", "--json"],
  ["terminal", "stats", "--json"],
  ["terminal", "feed", "--limit", "5", "--json"],
  ["sma", "--latest", "--limit", "5", "--json"],
  ["jobs", "--limit", "5", "--json"],
];

let failures = 0;
for (const args of commands) {
  const label = `solard ${args.join(" ")}`;
  const started = Date.now();
  const result = spawnSync(bin, [entry, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SOLARD_ENABLE_LIVE_TRADES: process.env.SOLARD_ENABLE_LIVE_TRADES ?? "0",
    },
  });
  const tookMs = Date.now() - started;
  if (result.status !== 0) {
    failures += 1;
    process.stderr.write(`FAIL ${label} (${tookMs}ms)\n${result.stderr || result.stdout}\n`);
    continue;
  }
  try {
    JSON.parse(result.stdout);
  } catch (error) {
    failures += 1;
    process.stderr.write(`FAIL ${label} emitted invalid JSON (${tookMs}ms)\n${result.stdout}\n${result.stderr}\n`);
    continue;
  }
  process.stdout.write(`ok ${label} (${tookMs}ms)\n`);
}

if (failures > 0) {
  process.stderr.write(`${failures} smoke check(s) failed\n`);
  process.exitCode = 1;
}
