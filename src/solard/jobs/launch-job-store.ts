import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";

import {
  launchPumpTokenAction,
  pumpLaunchArgsFromInput,
  type PumpLaunchInput,
} from "../actions/launches.js";
import type { PumpTokenLaunchCliResult } from "../../launches/pump/token-launch-cli.js";
import {
  db,
  isSqliteBusyError,
  type LaunchJobDbRow,
  type LaunchJobLogDbRow,
} from "../../../shared/db.js";
import {
  compactId,
  dbMeasure,
  summarizeError,
  summarizeForMeasure,
} from "../../../shared/measure.js";

export type LaunchJobStatus = "queued" | "running" | "succeeded" | "failed";

export type LaunchJob = {
  id: string;
  kind: "launch:pump";
  status: LaunchJobStatus;
  createdAtMs: number;
  updatedAtMs: number;
  input: PumpLaunchInput;
  argv: string[];
  logs: Array<{
    atMs: number;
    label: string;
    value: unknown;
  }>;
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

const LAUNCH_DB_RETRY_MS = 2_500;

const RETRY_SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function json(value: unknown): string {
  return JSON.stringify(value, jsonReplacer);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }

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

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function busyDelayMs(attempt: number): number {
  return Math.min(
    350,
    12 * 2 ** Math.min(attempt, 5) + Math.floor(Math.random() * 17),
  );
}

function sleepSync(delayMs: number): void {
  Atomics.wait(RETRY_SLEEP_ARRAY, 0, 0, delayMs);
}

function launchDbOperation<T>(action: string, operation: () => T): T {
  const startedAtMs = Date.now();

  let attempt = 0;

  while (true) {
    try {
      return dbMeasure.sync(
        {
          start: () => `${action} attempt=${attempt + 1}`,

          end: (result: any) => ({
            ok: result != null,
          }),

          catch: summarizeError,
        },
        operation,
      );
    } catch (error) {
      if (!isSqliteBusyError(error)) {
        throw error;
      }

      attempt++;

      const elapsedMs = Date.now() - startedAtMs;

      if (elapsedMs >= LAUNCH_DB_RETRY_MS) {
        const wrapped = new Error(
          `Launch storage remained busy after ${elapsedMs}ms. Please retry the launch.`,
          {
            cause: error,
          },
        );

        Object.assign(wrapped, {
          code: "SOLARD_LAUNCH_DB_BUSY",

          attempts: attempt,
        });

        throw wrapped;
      }

      const delayMs = Math.min(
        busyDelayMs(attempt),
        LAUNCH_DB_RETRY_MS - elapsedMs,
      );

      if (attempt === 1 || attempt % 4 === 0) {
        console.warn(
          `[solard:launch-db] ${action} busy; retrying in ${delayMs}ms`,
        );
      }

      sleepSync(delayMs);
    }
  }
}

export function initLaunchJobStore(): void {
  /**
   * sqlite-zod-orm creates the typed V2 tables from shared/db.ts.
   * Kept for compatibility with existing callers.
   */
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

function rowToJob(
  row: LaunchJobDbRow,
  logs: LaunchJob["logs"] = [],
): LaunchJob {
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

    input: parseJson<PumpLaunchInput>(row.inputJson, {
      creator: "",
    }),

    argv: parseJson<string[]>(row.argvJson, []),

    logs,

    ...(result
      ? {
          result,
        }
      : {}),

    ...(row.error
      ? {
          error: row.error,
        }
      : {}),
  };
}

export function listLaunchJobLogs(
  jobId: string,
  limit = MAX_LOGS_PER_JOB,
): LaunchJob["logs"] {
  const rows = launchDbOperation(
    `db.list_launch_logs job=${compactId(jobId)}`,
    () =>
      db.launchJobLogsV2
        .select()
        .where({
          jobId,
        })
        .orderBy("atMs", "DESC")
        .limit(clampLimit(limit, MAX_LOGS_PER_JOB))
        .all() as LaunchJobLogDbRow[],
  );

  return rows.reverse().map((row) => ({
    atMs: Number(row.atMs) || 0,

    label: row.label,

    value: parseJson(row.valueJson, null),
  }));
}

function persistedLaunchInput(input: PumpLaunchInput): PumpLaunchInput {
  const { temporaryImagePath, ...persisted } = input;

  if (temporaryImagePath && persisted.imagePath === temporaryImagePath) {
    persisted.imagePath = "[browser-upload]";
  }

  return persisted;
}

function createJobRow(input: PumpLaunchInput): LaunchJobDbRow {
  const now = Date.now();

  const publicInput = persistedLaunchInput(input);

  const row: LaunchJobDbRow = {
    jobId: randomUUID(),

    kind: "launch:pump",

    status: "queued",

    inputJson: json(publicInput),

    argvJson: json(pumpLaunchArgsFromInput(publicInput)),

    resultJson: null,

    error: null,

    createdAtMs: now,

    updatedAtMs: now,
  };

  return launchDbOperation(
    `db.insert_launch_job job=${compactId(row.jobId)}`,
    () => db.launchJobsV2.insert(row) as LaunchJobDbRow,
  );
}

function getJobRow(jobId: string): LaunchJobDbRow | null {
  return launchDbOperation(
    `db.get_launch_job job=${compactId(jobId)}`,
    () =>
      (db.launchJobsV2
        .select()
        .where({
          jobId,
        })
        .get() as LaunchJobDbRow | null) ?? null,
  );
}

function updateJob(
  jobId: string,
  patch: Partial<Omit<LaunchJobDbRow, "jobId" | "createdAtMs">>,
): LaunchJobDbRow | null {
  const existing = getJobRow(jobId);

  if (!existing) {
    return null;
  }

  const row: LaunchJobDbRow = {
    ...existing,
    ...patch,

    jobId: existing.jobId,

    kind: "launch:pump",

    createdAtMs: existing.createdAtMs,

    updatedAtMs: patch.updatedAtMs ?? Date.now(),
  };

  return launchDbOperation(
    `db.upsert_launch_job job=${compactId(jobId)} status=${row.status}`,
    () =>
      db.launchJobsV2.upsert(row, {
        on: "jobId",

        merge: (t) => ({
          kind: t.excluded("kind"),

          status: t.excluded("status"),

          inputJson: t.excluded("inputJson"),

          argvJson: t.excluded("argvJson"),

          resultJson: t.excluded("resultJson"),

          error: t.excluded("error"),

          updatedAtMs: t.excluded("updatedAtMs"),
        }),
      }) as LaunchJobDbRow,
  );
}

function pushLog(jobId: string, label: string, value: unknown): void {
  const atMs = Date.now();

  const row: LaunchJobLogDbRow = {
    logId: randomUUID(),

    jobId,
    atMs,
    label,

    valueJson: json(value),
  };

  launchDbOperation(
    `db.insert_launch_log job=${compactId(jobId)}`,
    () => db.launchJobLogsV2.insert(row) as LaunchJobLogDbRow,
  );

  updateJob(jobId, {
    updatedAtMs: atMs,
  });
}

async function cleanupTemporaryLaunchImage(
  input: PumpLaunchInput,
): Promise<void> {
  const path = input.temporaryImagePath?.trim();

  if (!path) {
    return;
  }

  await unlink(path).catch((error) => {
    if (
      (
        error as {
          code?: unknown;
        }
      )?.code === "ENOENT"
    ) {
      return;
    }

    throw error;
  });
}

export function startPumpLaunchJob(input: PumpLaunchInput): LaunchJob {
  const row = createJobRow(input);

  queueMicrotask(() => {
    void (async () => {
      try {
        updateJob(row.jobId, {
          status: "running",

          error: null,
        });

        const publicInput = persistedLaunchInput(input);

        pushLog(row.jobId, "launch input", summarizeForMeasure(publicInput));

        pushLog(row.jobId, "launch argv", pumpLaunchArgsFromInput(publicInput));

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

        try {
          pushLog(row.jobId, "fatal", message);
        } catch (logError) {
          console.error(
            "[solard:launch] failed to persist fatal log",
            logError,
          );
        }

        try {
          updateJob(row.jobId, {
            status: "failed",

            error: message,
          });
        } catch (updateError) {
          console.error(
            "[solard:launch] failed to persist failed status",
            updateError,
          );
        }
      } finally {
        await cleanupTemporaryLaunchImage(input).catch((error) => {
          try {
            pushLog(
              row.jobId,
              "image cleanup failed",
              summarizeForMeasure(error),
            );
          } catch (logError) {
            console.error(
              "[solard:launch] failed to persist image cleanup error",
              logError,
            );
          }
        });
      }
    })();
  });

  return rowToJob(row);
}

export function listLaunchJobs(
  options: ListLaunchJobsOptions = {},
): LaunchJob[] {
  const limit = clampLimit(options.limit, DEFAULT_JOB_LIMIT);

  const status = launchJobStatus(options.status ?? null);

  const rows = launchDbOperation(
    `db.list_launch_jobs status=${status ?? "all"}`,
    () =>
      (status
        ? db.launchJobsV2
            .select()
            .where({
              status,
            })
            .orderBy("createdAtMs", "DESC")
            .limit(limit)
            .all()
        : db.launchJobsV2
            .select()
            .orderBy("createdAtMs", "DESC")
            .limit(limit)
            .all()) as LaunchJobDbRow[],
  );

  return rows.map((row) =>
    rowToJob(row, options.includeLogs ? listLaunchJobLogs(row.jobId) : []),
  );
}

export function getLaunchJob(id: string): LaunchJob | undefined {
  const row = getJobRow(id);

  return row ? rowToJob(row, listLaunchJobLogs(row.jobId)) : undefined;
}
