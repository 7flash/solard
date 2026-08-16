import type { SolardDatabase } from "./schema.ts";

type RawDb = { pragma?: (sql: string) => unknown };

/** Runtime tuning only. No web/indexer views or tables are created here. */
export function ensureSolardDatabaseRuntimeObjects(db: SolardDatabase): void {
  const raw = db as unknown as RawDb;
  try {
    raw.pragma?.("journal_mode = WAL");
    raw.pragma?.("synchronous = NORMAL");
  } catch {
    // sqlite-zod-orm runtimes vary in PRAGMA support.
  }
}
