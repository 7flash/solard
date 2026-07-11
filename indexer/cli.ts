#!/usr/bin/env bun
import { loadConfig } from "./config.js";
import { openIndexerDb } from "./db.js";
import { refreshSolUsd, solUsdState } from "./sol-usd.js";

function usage(): never {
  console.log(`Usage:
  bun indexer/cli.ts status
  bun indexer/cli.ts latest [limit]
  bun indexer/cli.ts errors [limit]
  bun indexer/cli.ts sol-usd
`);
  process.exit(1);
}

const command = process.argv[2] ?? "status";
const config = loadConfig();

if (command === "sol-usd") {
  const refreshed = await refreshSolUsd({
    fallback: config.solUsd,
    force: true,
    timeoutMs: 3000,
  });
  console.log(JSON.stringify(refreshed, null, 2));
  process.exit(0);
}

const store = openIndexerDb();

try {
  if (command === "status") {
    const status = store.db.raw(
      "SELECT * FROM processStatus ORDER BY heartbeatAtMs DESC",
    );
    const stats = {
      path: store.path,
      tokens:
        store.db.raw<{ count: number }>(
          "SELECT COUNT(*) as count FROM terminalTokensLive",
        )[0]?.count ?? 0,
      priced:
        store.db.raw<{ count: number }>(
          "SELECT COUNT(*) as count FROM terminalTokensLive WHERE marketCapUsd IS NOT NULL OR priceUsd IS NOT NULL",
        )[0]?.count ?? 0,
      trades:
        store.db.raw<{ count: number }>(
          "SELECT COUNT(*) as count FROM terminalTradesLive",
        )[0]?.count ?? 0,
      indicators:
        store.db.raw<{ count: number }>(
          "SELECT COUNT(*) as count FROM terminalIndicatorsLive",
        )[0]?.count ?? 0,
      solUsd: solUsdState(),
    };
    console.log(JSON.stringify({ stats, status }, null, 2));
  } else if (command === "latest") {
    const limit = Math.max(1, Math.min(100, Number(process.argv[3] ?? "20")));
    const rows = store.db.raw(
      `SELECT mint, symbol, name, image, marketCapUsd, priceUsd, source, updatedAtMs
       FROM terminalTokensLive
       ORDER BY updatedAtMs DESC
       LIMIT ?`,
      limit,
    );
    console.log(JSON.stringify(rows, null, 2));
  } else if (command === "errors") {
    const limit = Math.max(1, Math.min(100, Number(process.argv[3] ?? "20")));
    const rows = store.db.raw(
      `SELECT worker, message, stack, dataJson, createdAtMs
       FROM terminalWorkerErrors
       ORDER BY createdAtMs DESC
       LIMIT ?`,
      limit,
    );
    console.log(JSON.stringify(rows, null, 2));
  } else {
    usage();
  }
} finally {
  store.close();
}
