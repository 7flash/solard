import { terminalDb } from "@solard/core/db.js";
import { dbMeasure, summarizeForMeasure } from "../measure.ts";

let initialized = false;

export function initTerminalIngestionTables(): void {
  if (initialized) return;
  initialized = true;
  dbMeasure.measureSync(
    {
      start: () => "init terminal ingestion tables",
      end: () => "ready",
    },
    () => {
      terminalDb.exec(
        `CREATE TABLE IF NOT EXISTS terminalIngestionKeys (
          key TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          seenAtMs INTEGER NOT NULL
        )`,
      );
      terminalDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_terminal_ingestion_kind_seen ON terminalIngestionKeys(kind, seenAtMs DESC)",
      );
      terminalDb.exec(
        `CREATE TABLE IF NOT EXISTS terminalWorkerErrors (
          id TEXT PRIMARY KEY,
          worker TEXT NOT NULL,
          message TEXT NOT NULL,
          stack TEXT,
          dataJson TEXT NOT NULL DEFAULT '{}',
          createdAtMs INTEGER NOT NULL
        )`,
      );
      terminalDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_terminal_worker_errors_worker_created ON terminalWorkerErrors(worker, createdAtMs DESC)",
      );
      terminalDb.exec("PRAGMA wal_checkpoint(PASSIVE)");
    },
  );
}

initTerminalIngestionTables();

function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(
    message,
  );
}

function json(value: unknown): string {
  return JSON.stringify(value, (_, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function lastStatementChanges(): number {
  return Number(
    terminalDb.raw<{ changes: number }>("SELECT changes() as changes")[0]
      ?.changes ?? 0,
  );
}

function withIngestionTransaction<T>(fn: () => T): T {
  terminalDb.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    terminalDb.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      terminalDb.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors so the original error remains visible.
    }
    throw error;
  }
}

export function rememberIngestionKey(
  key: string,
  kind: string,
  now = Date.now(),
): boolean {
  initTerminalIngestionTables();
  terminalDb.exec(
    "INSERT OR IGNORE INTO terminalIngestionKeys (key, kind, seenAtMs) VALUES (?, ?, ?)",
    key,
    kind,
    now,
  );
  return lastStatementChanges() > 0;
}

export function hasIngestionKey(key: string): boolean {
  initTerminalIngestionTables();
  return Boolean(
    terminalDb.raw<{ found: number }>(
      "SELECT 1 as found FROM terminalIngestionKeys WHERE key = ? LIMIT 1",
      key,
    )[0],
  );
}

export function pruneIngestionKeys(
  kind: string,
  maxAgeMs: number,
  now = Date.now(),
): number {
  initTerminalIngestionTables();
  const cutoff = now - Math.max(60_000, maxAgeMs);
  const configuredLimit = Number(
    process.env.SOLARD_INGESTION_PRUNE_LIMIT ?? "50000",
  );
  const limit = Math.max(
    100,
    Math.min(
      Number.isFinite(configuredLimit) ? configuredLimit : 50_000,
      500_000,
    ),
  );

  return withIngestionTransaction(() => {
    terminalDb.exec(
      `DELETE FROM terminalIngestionKeys
       WHERE key IN (
         SELECT key FROM terminalIngestionKeys
         WHERE kind = ? AND seenAtMs < ?
         ORDER BY seenAtMs ASC
         LIMIT ?
       )`,
      kind,
      cutoff,
      limit,
    );
    return lastStatementChanges();
  });
}

export function recordWorkerError(
  worker: string,
  error: unknown,
  data: Record<string, unknown> = {},
): void {
  const err = error instanceof Error ? error : new Error(String(error));
  try {
    initTerminalIngestionTables();
    const id = `${worker}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    terminalDb.exec(
      `INSERT INTO terminalWorkerErrors (id, worker, message, stack, dataJson, createdAtMs)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      worker,
      err.message,
      err.stack ?? null,
      json(data),
      Date.now(),
    );
  } catch (writeError) {
    // Error telemetry must never terminate the worker already handling another
    // SQLite collision. The original error remains visible on stderr.
    if (isSqliteBusyError(writeError)) {
      console.error(`[solard:${worker}] ${err.message}`);
      return;
    }
    throw writeError;
  }
}

export function listWorkerErrors(
  worker?: string | null,
  limit = 50,
): Array<Record<string, unknown>> {
  initTerminalIngestionTables();
  const n = Math.max(1, Math.min(limit, 250));
  const rows = worker
    ? terminalDb.raw<any>(
        "SELECT * FROM terminalWorkerErrors WHERE worker = ? ORDER BY createdAtMs DESC LIMIT ?",
        worker,
        n,
      )
    : terminalDb.raw<any>(
        "SELECT * FROM terminalWorkerErrors ORDER BY createdAtMs DESC LIMIT ?",
        n,
      );
  return rows.map((row: any) => ({
    ...row,
    data: (() => {
      try {
        return JSON.parse(row.dataJson || "{}");
      } catch {
        return {};
      }
    })(),
  }));
}

export function terminalIngestionStats(): Record<string, unknown> {
  initTerminalIngestionTables();
  return dbMeasure.measureSync(
    {
      start: () => "terminal ingestion stats",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    () => ({
      keys: terminalDb.raw<{
        kind: string;
        count: number;
        latest: number | null;
      }>(
        "SELECT kind, COUNT(*) as count, MAX(seenAtMs) as latest FROM terminalIngestionKeys GROUP BY kind ORDER BY count DESC",
      ),
      errors:
        terminalDb.raw<{ count: number }>(
          "SELECT COUNT(*) as count FROM terminalWorkerErrors",
        )[0]?.count ?? 0,
      latestError:
        terminalDb.raw<any>(
          "SELECT worker, message, createdAtMs FROM terminalWorkerErrors ORDER BY createdAtMs DESC LIMIT 1",
        )[0] ?? null,
    }),
  );
}

export function clearWorkerErrors(workers?: string[] | null): number {
  initTerminalIngestionTables();
  const selected = [
    ...new Set((workers ?? []).map((worker) => worker.trim())),
  ].filter(Boolean);

  return withIngestionTransaction(() => {
    if (selected.length === 0) {
      const count = Number(
        terminalDb.raw<{ count: number }>(
          "SELECT COUNT(*) as count FROM terminalWorkerErrors",
        )[0]?.count ?? 0,
      );
      terminalDb.exec("DELETE FROM terminalWorkerErrors");
      return count;
    }

    const placeholders = selected.map(() => "?").join(", ");
    const count = Number(
      terminalDb.raw<{ count: number }>(
        `SELECT COUNT(*) as count FROM terminalWorkerErrors WHERE worker IN (${placeholders})`,
        ...selected,
      )[0]?.count ?? 0,
    );
    terminalDb.exec(
      `DELETE FROM terminalWorkerErrors WHERE worker IN (${placeholders})`,
      ...selected,
    );
    return count;
  });
}
