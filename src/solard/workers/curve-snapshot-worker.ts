#!/usr/bin/env bun
import { terminalStoreStats, upsertProcessStatus } from "../../../shared/db.js";
import { workerMeasure, summarizeForMeasure } from "../measure.js";
import { refreshTerminalCurveSnapshots } from "../helius/curve-snapshot.js";

const WORKER = process.env.SOLARD_WORKER_NAME || "solard-curve-snapshots";
const BUILD_ID = "curve-snapshots-v1-bonding-account";
const EXPECTED = process.env.SOLARD_EXPECTED_BUILD_ID || BUILD_ID;
const SOURCE =
  process.env.SOLARD_STREAM_SOURCE ||
  process.env.SOLARD_CURVE_SNAPSHOT_SOURCE ||
  "both";
const INTERVAL_MS = Math.max(
  750,
  Number(process.env.SOLARD_CURVE_SNAPSHOT_INTERVAL_MS ?? "2500"),
);
const LIMIT = Math.max(
  1,
  Math.min(Number(process.env.SOLARD_CURVE_SNAPSHOT_LIMIT ?? "80"), 500),
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
      start: () => "curve snapshot tick",
      end: (value) => ({ result: summarizeForMeasure(value) }),
      catch: (error) => {
        heartbeat("error", { stats: terminalStoreStats() }, error);
        return null;
      },
    },
    async () => {
      const result = await refreshTerminalCurveSnapshots({
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
