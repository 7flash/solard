import { randomUUID } from "node:crypto";
import {
  launchPumpTokenAction,
  pumpLaunchArgsFromInput,
  type PumpLaunchInput,
} from "../actions/launches.js";
import type { PumpTokenLaunchCliResult } from "../../launches/pump/token-launch-cli.js";
import { openDatabase } from "../../db/database.js";
import type { LaunchJobLogRow, LaunchJobRow } from "../../db/schema.js";
import { measureSolard, summarizeForMeasure } from "../api-response.js";

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

const MAX_LOGS_PER_JOB = 500;
const DEFAULT_JOB_LIMIT = 100;

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

function db() {
  return openDatabase();
}

function clampLimit(
  value: number | null | undefined,
  fallback: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

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
    kind: row.kind,
    status: row.status,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
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
  const rows = db()
    .launchJobLogs.select()
    .where({ jobId })
    .orderBy("atMs", "desc")
    .limit(clampLimit(limit, MAX_LOGS_PER_JOB))
    .all() as LaunchJobLogRow[];
  return rows.reverse().map((row) => ({
    atMs: row.atMs,
    label: row.label,
    value: parseJson(row.valueJson, null),
  }));
}

function createJobRow(input: PumpLaunchInput): LaunchJobRow {
  const now = Date.now();
  return db().launchJobs.insert({
    jobId: randomUUID(),
    kind: "launch:pump",
    status: "queued",
    inputJson: json(input),
    argvJson: json(pumpLaunchArgsFromInput(input)),
    resultJson: null,
    error: null,
    createdAtMs: now,
    updatedAtMs: now,
  }) as LaunchJobRow;
}

function updateJob(
  jobId: string,
  patch: Partial<Omit<LaunchJobRow, "id" | "jobId" | "createdAtMs">>,
): LaunchJobRow | null {
  const row = db().launchJobs.select().where({ jobId }).first() as
    LaunchJobRow | undefined;
  if (!row) return null;
  Object.assign(row, patch, { updatedAtMs: Date.now() });
  return row;
}

function pushLog(jobId: string, label: string, value: unknown): void {
  const atMs = Date.now();
  db().launchJobLogs.insert({
    jobId,
    atMs,
    label,
    valueJson: json(value),
  });
  updateJob(jobId, { updatedAtMs: atMs });
}

export function startPumpLaunchJob(input: PumpLaunchInput): LaunchJob {
  const row = createJobRow(input);
  queueMicrotask(() => {
    void (async () => {
      const scope = `solard:job:launch:pump:${row.jobId}`;
      try {
        updateJob(row.jobId, { status: "running" });
        pushLog(row.jobId, "launch input", summarizeForMeasure(input));
        pushLog(row.jobId, "launch argv", pumpLaunchArgsFromInput(input));
        const measured = await measureSolard(
          scope,
          "run",
          async () =>
            await launchPumpTokenAction(input, {
              report: (label, value) =>
                pushLog(row.jobId, label, summarizeForMeasure(value)),
            }),
          {
            summarize: summarizeForMeasure,
            meta: { jobId: row.jobId, kind: "launch:pump" },
            onError: (error) => {
              pushLog(row.jobId, "fatal", summarizeForMeasure(error));
              throw error;
            },
          },
        );
        updateJob(row.jobId, {
          status: "succeeded",
          resultJson: json(measured.value),
          error: null,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);
        updateJob(row.jobId, { status: "failed", error: message });
      }
    })();
  });
  return rowToJob(row, []);
}

export function listLaunchJobs(
  options: ListLaunchJobsOptions = {},
): LaunchJob[] {
  const limit = clampLimit(options.limit, DEFAULT_JOB_LIMIT);
  const query = options.status
    ? db().launchJobs.select().where({ status: options.status })
    : db().launchJobs.select();
  const rows = query
    .orderBy("createdAtMs", "desc")
    .limit(limit)
    .all() as LaunchJobRow[];
  return rows.map((row) =>
    rowToJob(row, options.includeLogs ? listLaunchJobLogs(row.jobId) : []),
  );
}

export function getLaunchJob(id: string): LaunchJob | undefined {
  const row = db().launchJobs.select().where({ jobId: id }).first() as
    LaunchJobRow | undefined;
  return row ? rowToJob(row, listLaunchJobLogs(row.jobId)) : undefined;
}
