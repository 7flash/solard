import type { SolardDatabase } from "./schema.ts";

type RawDb = {
  pragma?: (sql: string) => unknown;
  exec?: (sql: string) => unknown;
};

export function ensureSolardDatabaseRuntimeObjects(db: SolardDatabase): void {
  const raw = db as unknown as RawDb;
  try {
    raw.pragma?.("journal_mode = WAL");
    raw.pragma?.("synchronous = NORMAL");
  } catch {}
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
