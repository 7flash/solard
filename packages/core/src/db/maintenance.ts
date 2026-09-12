import type { SolardDatabase } from "./schema.ts";

type RawDb = {
  pragma?: (sql: string) => unknown;
  exec?: (sql: string) => unknown;
};

/** Runtime tuning only. No web/indexer views or tables are created here. */
export function ensureSolardDatabaseRuntimeObjects(db: SolardDatabase): void {
  const raw = db as unknown as RawDb;
  try {
    raw.pragma?.("journal_mode = WAL");
    raw.pragma?.("synchronous = NORMAL");
  } catch {}
  try {
    raw.exec?.(
      "ALTER TABLE historyReplayCoverage ADD COLUMN attemptedThroughSlot INTEGER NOT NULL DEFAULT 0",
    );
  } catch {}
  try {
    raw.exec?.(
      "UPDATE historyReplayCoverage SET attemptedThroughSlot = finalizedThroughSlot WHERE attemptedThroughSlot < finalizedThroughSlot",
    );
  } catch {}
  normalizeTransactionLifecycleRows(db);
}

export function normalizeTransactionLifecycleRows(db: SolardDatabase): void {
  const raw = db as unknown as RawDb;
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
