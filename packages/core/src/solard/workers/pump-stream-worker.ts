#!/usr/bin/env bun
import { setTimeout as delay } from "node:timers/promises";
import {
  getPumpFeedWorkerStatus,
  startPumpFeedWorker,
  stopPumpFeedWorker,
} from "../../pump/services/pump-live-api.ts";
import { getPumpFeedDbStats } from "../feed/feed-repo.ts";

process.env.SOLARD_PUMP_STREAM_WORKER = "1";
process.env.SOLARD_MEASURE_QUIET ??= "1";
process.env.SOLWAL_MEASURE_QUIET ??= "1";
process.env.SOLARD_MEASURE_UI = "0";
process.env.SOLWAL_MEASURE_UI = "0";
process.env.SOLARD_MEASURE_HOT_RPC ??= "0";
process.env.SOLWAL_MEASURE_HOT_RPC ??= "0";

const source =
  process.env.SOLARD_PUMP_STREAM_SOURCE === "pumpportal"
    ? "pumpportal"
    : "helius";
const resetSession = process.env.SOLARD_PUMP_STREAM_RESET_SESSION !== "0";
let stopping = false;

function write(event: string, value: unknown): void {
  const payload = JSON.stringify({ event, value, atMs: Date.now() });
  if (typeof Bun !== "undefined" && Bun.stdout)
    Bun.stdout.write(payload + "\n");
  else process.stdout.write(payload + "\n");
}

function stop(): void {
  if (stopping) return;
  stopping = true;
  try {
    stopPumpFeedWorker();
  } catch {}
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("beforeExit", stop);

try {
  startPumpFeedWorker({ source, resetSession });
  write("started", getPumpFeedWorkerStatus());
  while (!stopping) {
    await delay(10_000);
    write("heartbeat", {
      worker: getPumpFeedWorkerStatus(),
      db: getPumpFeedDbStats(),
    });
  }
  write("stopped", getPumpFeedWorkerStatus());
} catch (error) {
  write("error", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
  });
  process.exitCode = 1;
} finally {
  stop();
}
