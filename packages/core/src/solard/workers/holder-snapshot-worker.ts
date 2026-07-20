#!/usr/bin/env bun
import { terminalStoreStats, upsertProcessStatus } from "@solard/core/db.js";
import { refreshRecentHolderSnapshots } from "../db/terminal-holders.ts";
import { workerMeasure, summarizeForMeasure } from "../measure.ts";

const WORKER = process.env.SOLARD_WORKER_NAME || "solard-holder-snapshots";
const BUILD_ID = "holder-snapshots-v1-largest-accounts";
const EXPECTED = process.env.SOLARD_EXPECTED_BUILD_ID || BUILD_ID;
const SOURCE =
  process.env.SOLARD_STREAM_SOURCE ||
  process.env.SOLARD_HOLDER_SOURCE ||
  "both";
const INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.SOLARD_HOLDER_SNAPSHOT_INTERVAL_MS ?? "15000"),
);
const LIMIT = Math.max(
  1,
  Math.min(Number(process.env.SOLARD_HOLDER_SNAPSHOT_CANDIDATES ?? "15"), 75),
);
let stopping = false;

function heartbeat(
  status: string,
  data: Record<string, unknown> = {},
  error?: unknown,
): void {
  upsertProcessStatus({
    name: WORKER,
    kind: "snapshot",
    status,
    error,
    data: {
      buildId: BUILD_ID,
      expectedBuildId: EXPECTED,
      supervisor: process.env.SOLARD_WORKER_SUPERVISOR || "standalone",
      parent: process.env.BGR_PARENT_NAME || null,
      source: SOURCE,
      intervalMs: INTERVAL_MS,
      limit: LIMIT,
      ...data,
    },
  });
}

process.once("SIGINT", () => {
  stopping = true;
  heartbeat("stopping", { signal: "SIGINT" });
});
process.once("SIGTERM", () => {
  stopping = true;
  heartbeat("stopping", { signal: "SIGTERM" });
});

heartbeat("starting");

while (!stopping) {
  await workerMeasure.measure(
    {
      start: () => "holder snapshot tick",
      end: (value) => ({ result: summarizeForMeasure(value) }),
      catch: (error) => {
        heartbeat("error", { stats: terminalStoreStats() }, error);
        return null;
      },
    },
    async () => {
      const result = await refreshRecentHolderSnapshots({
        source: SOURCE,
        limit: LIMIT,
      });
      heartbeat("ok", { result, stats: terminalStoreStats() });
      return result;
    },
  );
  await Bun.sleep(INTERVAL_MS);
}

heartbeat("stopped");
