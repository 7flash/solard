import { terminalDb } from "./terminal-store.js";
import { dbMeasure, summarizeForMeasure } from "../measure.js";

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

function json(value: unknown): string {
  return JSON.stringify(value, (_, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

export function rememberIngestionKey(
  key: string,
  kind: string,
  now = Date.now(),
): boolean {
  initTerminalIngestionTables();
  const before = Number(
    terminalDb.raw<{ count: number }>(
      "SELECT COUNT(*) as count FROM terminalIngestionKeys WHERE key = ?",
      key,
    )[0]?.count ?? 0,
  );
  if (before > 0) return false;
  terminalDb.exec(
    "INSERT OR IGNORE INTO terminalIngestionKeys (key, kind, seenAtMs) VALUES (?, ?, ?)",
    key,
    kind,
    now,
  );
  return true;
}

export function hasIngestionKey(key: string): boolean {
  initTerminalIngestionTables();
  return (
    Number(
      terminalDb.raw<{ count: number }>(
        "SELECT COUNT(*) as count FROM terminalIngestionKeys WHERE key = ?",
        key,
      )[0]?.count ?? 0,
    ) > 0
  );
}

export function pruneIngestionKeys(
  kind: string,
  maxAgeMs: number,
  now = Date.now(),
): number {
  initTerminalIngestionTables();
  const cutoff = now - Math.max(60_000, maxAgeMs);
  const rows = terminalDb.raw<{ key: string }>(
    "SELECT key FROM terminalIngestionKeys WHERE kind = ? AND seenAtMs < ? LIMIT 5000",
    kind,
    cutoff,
  );
  if (!rows.length) return 0;
  for (const row of rows)
    terminalDb.exec("DELETE FROM terminalIngestionKeys WHERE key = ?", row.key);
  return rows.length;
}

export function recordWorkerError(
  worker: string,
  error: unknown,
  data: Record<string, unknown> = {},
): void {
  initTerminalIngestionTables();
  const err = error instanceof Error ? error : new Error(String(error));
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
}

export function listWorkerErrors(
  worker?: string | null,
  limit = 50,
): Array<Record<string, unknown>> {
  initTerminalIngestionTablesSafe();
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

function initTerminalIngestionTablesSafe(): void {
  initTerminalIngestionTables();
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
  if (!workers || workers.length === 0) {
    const count = Number(
      terminalDb.raw<{ count: number }>(
        "SELECT COUNT(*) as count FROM terminalWorkerErrors",
      )[0]?.count ?? 0,
    );
    terminalDb.exec("DELETE FROM terminalWorkerErrors");
    return count;
  }
  let count = 0;
  for (const worker of workers) {
    count += Number(
      terminalDb.raw<{ count: number }>(
        "SELECT COUNT(*) as count FROM terminalWorkerErrors WHERE worker = ?",
        worker,
      )[0]?.count ?? 0,
    );
    terminalDb.exec(
      "DELETE FROM terminalWorkerErrors WHERE worker = ?",
      worker,
    );
  }
  return count;
}
