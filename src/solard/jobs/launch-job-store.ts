import { randomUUID } from "node:crypto";
import {
  launchPumpTokenAction,
  pumpLaunchArgsFromInput,
  type PumpLaunchInput,
} from "../actions/launches.js";
import type { PumpTokenLaunchCliResult } from "../../launches/pump/token-launch-cli.js";
import { terminalDb } from "../../../shared/db.js";
import { dbMeasure, summarizeForMeasure } from "../measure.js";

export type LaunchJobStatus = "queued" | "running" | "succeeded" | "failed";

export type LaunchJob = {
  id: string;
  kind: "launch:pump";
  status: LaunchJobStatus;
  createdAtMs: number;
  updatedAtMs: number;
  input: PumpLaunchInput;
  argv: string[];
  logs: Array<{ atMs: number; label: string; value: unknown }>;
  result?: PumpTokenLaunchCliResult;
  error?: string;
};

export type ListLaunchJobsOptions = {
  status?: LaunchJobStatus | null;
  limit?: number | null;
  includeLogs?: boolean | null;
};

type LaunchJobRow = {
  jobId: string;
  kind: "launch:pump";
  status: LaunchJobStatus;
  inputJson: string;
  argvJson: string;
  resultJson: string | null;
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};

type LaunchJobLogRow = {
  id?: number | string;
  jobId: string;
  atMs: number;
  label: string;
  valueJson: string;
};

type PragmaColumn = { name: string; type?: string | null; pk?: number | null };

const MAX_LOGS_PER_JOB = 500;
const DEFAULT_JOB_LIMIT = 100;
let initialized = false;

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function json(value: unknown): string {
  return JSON.stringify(value, jsonReplacer);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function clampLimit(
  value: number | null | undefined,
  fallback: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function tableColumns(table: string): PragmaColumn[] {
  return terminalDb.raw<PragmaColumn>(`PRAGMA table_info(${table})`);
}

function columnType(cols: PragmaColumn[], name: string): string {
  return String(
    cols.find((col) => col.name === name)?.type ?? "",
  ).toUpperCase();
}

function hasTextColumn(cols: PragmaColumn[], name: string): boolean {
  return columnType(cols, name).includes("TEXT");
}

function hasIntegerColumn(cols: PragmaColumn[], name: string): boolean {
  const type = columnType(cols, name);
  return type.includes("INT") || type === "";
}

function safeBackupName(table: string): string {
  return `${table}_bad_${Date.now()}`;
}

function recreateIfIncompatible(
  table: string,
  ddl: string,
  compatible: (columns: PragmaColumn[]) => boolean,
): void {
  const columns = tableColumns(table);
  if (!columns.length) {
    terminalDb.exec(ddl);
    return;
  }
  if (compatible(columns)) return;
  const backup = safeBackupName(table);
  terminalDb.exec(`ALTER TABLE ${table} RENAME TO ${backup}`);
  terminalDb.exec(ddl);
}

export function initLaunchJobStore(): void {
  if (initialized) return;
  initialized = true;
  dbMeasure.measureSync(
    {
      start: () => "init launch job sqlite tables",
      end: () => "ready",
    },
    () => {
      recreateIfIncompatible(
        "launchJobs",
        `CREATE TABLE IF NOT EXISTS launchJobs (
          jobId TEXT PRIMARY KEY,
          kind TEXT NOT NULL DEFAULT 'launch:pump',
          status TEXT NOT NULL DEFAULT 'queued',
          inputJson TEXT NOT NULL DEFAULT '{}',
          argvJson TEXT NOT NULL DEFAULT '[]',
          resultJson TEXT,
          error TEXT,
          createdAtMs INTEGER NOT NULL DEFAULT 0,
          updatedAtMs INTEGER NOT NULL DEFAULT 0
        )`,
        (cols) =>
          hasTextColumn(cols, "jobId") &&
          hasTextColumn(cols, "kind") &&
          hasTextColumn(cols, "status") &&
          hasTextColumn(cols, "inputJson") &&
          hasTextColumn(cols, "argvJson"),
      );

      recreateIfIncompatible(
        "launchJobLogs",
        `CREATE TABLE IF NOT EXISTS launchJobLogs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          jobId TEXT NOT NULL,
          atMs INTEGER NOT NULL,
          label TEXT NOT NULL,
          valueJson TEXT NOT NULL DEFAULT 'null'
        )`,
        (cols) =>
          hasIntegerColumn(cols, "id") &&
          hasTextColumn(cols, "jobId") &&
          hasTextColumn(cols, "label") &&
          hasTextColumn(cols, "valueJson"),
      );

      terminalDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_launch_jobs_created ON launchJobs(createdAtMs DESC)",
      );
      terminalDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_launch_jobs_status ON launchJobs(status, createdAtMs DESC)",
      );
      terminalDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_launch_job_logs_job_at ON launchJobLogs(jobId, atMs DESC)",
      );
    },
  );
}

initLaunchJobStore();

export function launchJobStatus(
  value: string | null | undefined,
): LaunchJobStatus | null {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed"
  ) {
    return value;
  }
  return null;
}

function rowToJob(row: LaunchJobRow, logs?: LaunchJob["logs"]): LaunchJob {
  const result = parseJson<PumpTokenLaunchCliResult | null>(
    row.resultJson,
    null,
  );
  return {
    id: row.jobId,
    kind: "launch:pump",
    status: launchJobStatus(row.status) ?? "queued",
    createdAtMs: Number(row.createdAtMs) || 0,
    updatedAtMs: Number(row.updatedAtMs) || 0,
    input: parseJson<PumpLaunchInput>(row.inputJson, { creator: "" }),
    argv: parseJson<string[]>(row.argvJson, []),
    logs: logs ?? [],
    ...(result ? { result } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

export function listLaunchJobLogs(
  jobId: string,
  limit = MAX_LOGS_PER_JOB,
): LaunchJob["logs"] {
  initLaunchJobStore();
  const rows = terminalDb.raw<LaunchJobLogRow>(
    `SELECT id, jobId, atMs, label, valueJson
     FROM launchJobLogs
     WHERE jobId = ?
     ORDER BY atMs DESC, id DESC
     LIMIT ?`,
    jobId,
    clampLimit(limit, MAX_LOGS_PER_JOB),
  );
  return rows.reverse().map((row) => ({
    atMs: Number(row.atMs) || 0,
    label: row.label,
    value: parseJson(row.valueJson, null),
  }));
}

function createJobRow(input: PumpLaunchInput): LaunchJobRow {
  initLaunchJobStore();
  const now = Date.now();
  const row: LaunchJobRow = {
    jobId: randomUUID(),
    kind: "launch:pump",
    status: "queued",
    inputJson: json(input),
    argvJson: json(pumpLaunchArgsFromInput(input)),
    resultJson: null,
    error: null,
    createdAtMs: now,
    updatedAtMs: now,
  };
  terminalDb.exec(
    `INSERT INTO launchJobs (jobId, kind, status, inputJson, argvJson, resultJson, error, createdAtMs, updatedAtMs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.jobId,
    row.kind,
    row.status,
    row.inputJson,
    row.argvJson,
    row.resultJson,
    row.error,
    row.createdAtMs,
    row.updatedAtMs,
  );
  return row;
}

function getJobRow(jobId: string): LaunchJobRow | null {
  initLaunchJobStore();
  return (
    terminalDb.raw<LaunchJobRow>(
      `SELECT jobId, kind, status, inputJson, argvJson, resultJson, error, createdAtMs, updatedAtMs
       FROM launchJobs
       WHERE jobId = ?
       LIMIT 1`,
      jobId,
    )[0] ?? null
  );
}

function updateJob(
  jobId: string,
  patch: Partial<Omit<LaunchJobRow, "jobId" | "createdAtMs">>,
): LaunchJobRow | null {
  initLaunchJobStore();
  const existing = getJobRow(jobId);
  if (!existing) return null;
  const row: LaunchJobRow = {
    ...existing,
    ...patch,
    kind: "launch:pump",
    updatedAtMs: Date.now(),
  };
  terminalDb.exec(
    `UPDATE launchJobs
     SET kind = ?, status = ?, inputJson = ?, argvJson = ?, resultJson = ?, error = ?, updatedAtMs = ?
     WHERE jobId = ?`,
    row.kind,
    row.status,
    row.inputJson,
    row.argvJson,
    row.resultJson,
    row.error,
    row.updatedAtMs,
    row.jobId,
  );
  return row;
}

function pushLog(jobId: string, label: string, value: unknown): void {
  initLaunchJobStore();
  const atMs = Date.now();
  terminalDb.exec(
    `INSERT INTO launchJobLogs (jobId, atMs, label, valueJson)
     VALUES (?, ?, ?, ?)`,
    jobId,
    atMs,
    label,
    json(value),
  );
  updateJob(jobId, { updatedAtMs: atMs });
}

export function startPumpLaunchJob(input: PumpLaunchInput): LaunchJob {
  const row = createJobRow(input);
  queueMicrotask(() => {
    void (async () => {
      try {
        updateJob(row.jobId, { status: "running", error: null });
        pushLog(row.jobId, "launch input", summarizeForMeasure(input));
        pushLog(row.jobId, "launch argv", pumpLaunchArgsFromInput(input));
        const result = await launchPumpTokenAction(input, {
          report: (label, value) =>
            pushLog(row.jobId, label, summarizeForMeasure(value)),
        });
        updateJob(row.jobId, {
          status: "succeeded",
          resultJson: json(result),
          error: null,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);
        pushLog(row.jobId, "fatal", message);
        updateJob(row.jobId, { status: "failed", error: message });
      }
    })();
  });
  return rowToJob(row, []);
}

export function listLaunchJobs(
  options: ListLaunchJobsOptions = {},
): LaunchJob[] {
  initLaunchJobStore();
  const limit = clampLimit(options.limit, DEFAULT_JOB_LIMIT);
  const status = launchJobStatus(options.status ?? null);
  const rows = status
    ? terminalDb.raw<LaunchJobRow>(
        `SELECT jobId, kind, status, inputJson, argvJson, resultJson, error, createdAtMs, updatedAtMs
         FROM launchJobs
         WHERE status = ?
         ORDER BY createdAtMs DESC
         LIMIT ?`,
        status,
        limit,
      )
    : terminalDb.raw<LaunchJobRow>(
        `SELECT jobId, kind, status, inputJson, argvJson, resultJson, error, createdAtMs, updatedAtMs
         FROM launchJobs
         ORDER BY createdAtMs DESC
         LIMIT ?`,
        limit,
      );
  return rows.map((row) =>
    rowToJob(row, options.includeLogs ? listLaunchJobLogs(row.jobId) : []),
  );
}

export function getLaunchJob(id: string): LaunchJob | undefined {
  const row = getJobRow(id);
  return row ? rowToJob(row, listLaunchJobLogs(row.jobId)) : undefined;
}
