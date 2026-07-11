#!/usr/bin/env bun
import {
  SOLARD_DB_PATH,
  listProcessStatus,
  listTerminalFeed,
  listWorkerErrors,
  terminalStoreStats,
} from "../shared/db.js";
import {
  KNOWN_BAD_PUMP_PROGRAM_ID,
  OFFICIAL_PUMP_PROGRAM_ID,
  loadConfig,
} from "./config.js";
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
} else if (command === "doctor") {
  const processes = listProcessStatus();

  const indexer = processes.find((row: any) => row.name === config.name) as any;

  let data: Record<string, unknown> = {};

  try {
    data = JSON.parse(String(indexer?.dataJson ?? "{}"));
  } catch {}

  console.log(
    JSON.stringify(
      {
        ok: config.programId === OFFICIAL_PUMP_PROGRAM_ID,

        dbPath: SOLARD_DB_PATH,

        officialProgramId: OFFICIAL_PUMP_PROGRAM_ID,

        configuredProgramId: config.programId,

        knownBadProgramId: KNOWN_BAD_PUMP_PROGRAM_ID,

        programIdSource: config.programIdSource,

        programIdCorrected: config.programIdCorrected,

        indexerStatus: indexer ?? null,

        counters: {
          messages: data.messages ?? 0,

          programDataLines: data.programDataLines ?? 0,

          recognizedEventLines: data.recognizedEventLines ?? 0,

          parsedCreates: data.parsedCreates ?? 0,

          parsedTrades: data.parsedTrades ?? 0,

          parsedCompletes: data.parsedCompletes ?? 0,

          unknownEventLines: data.unknownEventLines ?? 0,

          eventParseErrors: data.eventParseErrors ?? 0,

          lastUnknownDiscriminator: data.lastUnknownDiscriminator ?? null,
        },

        store: terminalStoreStats(),
      },
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
  console.log(
    "Usage: bun indexer/cli.ts status|doctor|latest [limit]|errors [limit]|sol-usd",
  );

  process.exitCode = 1;
}
