#!/usr/bin/env bun
import {
  listProcessStatus,
  listTerminalFeed,
  listWorkerErrors,
  terminalStoreStats,
} from "../shared/terminal-repo.js";
import { loadConfig } from "./config.js";
import { openIndexerDb } from "./db.js";
import { refreshSolUsd } from "./sol-usd.js";

const command = process.argv[2] ?? "status";
const config = loadConfig();
const store = openIndexerDb();

try {
  if (command === "status") {
    console.log(
      JSON.stringify(
        {
          path: store.path,
          stats: terminalStoreStats(store.db),
          processes: listProcessStatus(50, store.db),
        },
        null,
        2,
      ),
    );
  } else if (command === "latest") {
    const limit = Math.max(1, Math.min(100, Number(process.argv[3] ?? 20)));

    console.log(
      JSON.stringify(
        listTerminalFeed({
          limit,
          activeWindowMs: 24 * 60 * 60_000,
          includeUnpriced: true,
          source: "both",
        }),
        null,
        2,
      ),
    );
  } else if (command === "errors") {
    console.log(
      JSON.stringify(
        listWorkerErrors(Number(process.argv[3] ?? 20), null, store.db),
        null,
        2,
      ),
    );
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
    console.log("Usage: bun indexer/cli.ts status|latest|errors|sol-usd");
    process.exitCode = 1;
  }
} finally {
  store.close();
}
