#!/usr/bin/env bun
import { hydrateMissingTerminalMetadata } from "../actions/terminal-metadata.js";
import { terminalStoreStats, upsertProcessStatus } from "../../../shared/db.js";
import { workerMeasure, summarizeForMeasure } from "../measure.js";

const WORKER = process.env.SOLARD_WORKER_NAME || "solard-metadata-repair";
const BUILD_ID = "metadata-repair-v1-das-uri-loop";
const EXPECTED = process.env.SOLARD_EXPECTED_BUILD_ID || BUILD_ID;
const INTERVAL_MS = Math.max(
  3_000,
  Number(process.env.SOLARD_METADATA_REPAIR_INTERVAL_MS ?? "8000"),
);
const LIMIT = Math.max(
  1,
  Math.min(Number(process.env.SOLARD_METADATA_REPAIR_LIMIT ?? "12"), 100),
);
let stopping = false;

function heartbeat(
  status: string,
  data: Record<string, unknown> = {},
  error?: unknown,
): void {
  upsertProcessStatus({
    name: WORKER,
    kind: "metadata",
    status,
    error,
    data: {
      buildId: BUILD_ID,
      expectedBuildId: EXPECTED,
      supervisor: process.env.SOLARD_WORKER_SUPERVISOR || "standalone",
      parent: process.env.BGR_PARENT_NAME || null,
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
      start: () => "metadata repair tick",
      end: (value) => ({ result: summarizeForMeasure(value) }),
      catch: (error) => {
        heartbeat("error", { stats: terminalStoreStats() }, error);
        return null;
      },
    },
    async () => {
      const result = await hydrateMissingTerminalMetadata({ limit: LIMIT });
      heartbeat("ok", { result, stats: terminalStoreStats() });
      return result;
    },
  );
  await Bun.sleep(INTERVAL_MS);
}

heartbeat("stopped");
