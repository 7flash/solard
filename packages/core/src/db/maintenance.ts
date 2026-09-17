import type { SolardDatabase } from "./schema.ts";

type RawDb = {
  pragma?: (sql: string) => unknown;
  exec?: (sql: string) => unknown;
};

const replayCoverageColumns = [
  "attemptedThroughSlot INTEGER NOT NULL DEFAULT 0",
  "fromCreation INTEGER NOT NULL DEFAULT 0",
  "discoveryComplete INTEGER NOT NULL DEFAULT 0",
  "fetchComplete INTEGER NOT NULL DEFAULT 0",
  "parsingComplete INTEGER NOT NULL DEFAULT 0",
  "orderingComplete INTEGER NOT NULL DEFAULT 0",
  "attributionComplete INTEGER NOT NULL DEFAULT 0",
  'contextJson TEXT NOT NULL DEFAULT \'{"recipient":null,"originalCreator":null}\'',
];

const historyTokenAccountColumns = [
  "incarnationsJson TEXT NOT NULL DEFAULT '[]'",
];

const replayItemColumns = [
  "eventId TEXT NOT NULL DEFAULT ''",
  "effectOrdinal INTEGER NOT NULL DEFAULT 0",
  "payoutAssetMint TEXT",
  "payoutAttribution TEXT",
];

export function ensureSolardDatabaseRuntimeObjects(db: SolardDatabase): void {
  const raw = db as unknown as RawDb;
  try {
    raw.pragma?.("journal_mode = WAL");
    raw.pragma?.("synchronous = NORMAL");
  } catch {}
  for (const column of replayCoverageColumns) {
    try {
      raw.exec?.(`ALTER TABLE historyReplayCoverage ADD COLUMN ${column}`);
    } catch {}
  }
  for (const column of replayItemColumns) {
    try {
      raw.exec?.(`ALTER TABLE historyReplayItems ADD COLUMN ${column}`);
    } catch {}
  }
  for (const column of historyTokenAccountColumns) {
    try {
      raw.exec?.(`ALTER TABLE historyTokenAccounts ADD COLUMN ${column}`);
    } catch {}
  }
  try {
    raw.exec?.(
      "UPDATE historyReplayCoverage SET attemptedThroughSlot = finalizedThroughSlot WHERE attemptedThroughSlot < finalizedThroughSlot",
    );
  } catch {}
  try {
    raw.exec?.(
      "UPDATE executions SET status = 'submitted' WHERE status = 'broadcast'",
    );
  } catch {}
  try {
    raw.exec?.(
      "UPDATE claims SET status = 'submitted' WHERE status = 'broadcast'",
    );
  } catch {}
}
