#!/usr/bin/env bun
import {
  SOLARD_DB_PATH,
  listProcessStatus,
  listTerminalFeed,
  listWorkerErrors,
  pruneTerminalHistory,
  terminalStoreStats,
} from "../shared/db.js";
import { loadConfig } from "./config.js";
import { refreshSolUsd } from "./sol-usd.js";

const command = process.argv[2] ?? "status";

const config = loadConfig();

if (command === "status") {
  console.log(
    JSON.stringify(
      {
        dbPath: SOLARD_DB_PATH,

        stats: terminalStoreStats(),

        processes: listProcessStatus(),
      },
      null,
      2,
    ),
  );
} else if (command === "latest") {
  const limit = Math.max(1, Math.min(Number(process.argv[3] ?? 20), 100));

  console.log(
    JSON.stringify(
      listTerminalFeed({
        limit,

        activeWindowMs: 24 * 60 * 60_000,

        includeUnpriced: true,

        source: "both",

        priceWindowTtlMs: 0,
      }),
      null,
      2,
    ),
  );
} else if (command === "errors") {
  console.log(
    JSON.stringify(
      listWorkerErrors({
        limit: Number(process.argv[3] ?? 20),
      }),
      null,
      2,
    ),
  );
} else if (command === "prune") {
  console.log(JSON.stringify(pruneTerminalHistory(), null, 2));
} else if (command === "sol-usd") {
  console.log(
    JSON.stringify(
      await refreshSolUsd({
        fallback: config.solUsd,

        force: true,
      }),
      null,
      2,
    ),
  );
} else {
  console.log(
    "Usage: bun indexer/cli.ts status|latest [limit]|errors [limit]|prune|sol-usd",
  );

  process.exitCode = 1;
}
