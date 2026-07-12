import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";

import {
  pumpLaunchArgsFromInput,
  type PumpLaunchInput,
} from "../actions/launches.js";
import {
  runPumpTokenLaunchFromArgs,
  type PumpTokenLaunchCliResult,
} from "../../launches/pump/token-launch-cli.js";
import {
  db,
  isSqliteBusyError,
  type LaunchJobDbRow,
  type LaunchJobLogDbRow,
} from "../../../shared/db.js";
import {
  compactId,
  dbMeasure,
  indexerMeasure,
  summarizeError,
  summarizeForMeasure,
} from "../../../shared/measure.js";

export const LAUNCH_JOB_RUNNER_VERSION = "v50-direct-live";

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

/**
 * Persistence is bookkeeping. It must never prevent or delay live execution.
 */
const LAUNCH_PERSIST_RETRY_MS = 60_000;

const runtimeJobs = new Map<string, LaunchJob>();

let persistenceTail: Promise<void> = Promise.resolve();

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
    1_000,
    20 * 2 ** Math.min(attempt, 6) + Math.floor(Math.random() * 31),
  );
}

function persistedLaunchInput(input: PumpLaunchInput): PumpLaunchInput {
  const { temporaryImagePath, ...persisted } = input;

  if (temporaryImagePath && persisted.imagePath === temporaryImagePath) {
    persisted.imagePath = "[browser-upload]";
  }

  return persisted;
}

function cloneJob(job: LaunchJob, includeLogs = true): LaunchJob {
  return {
    ...job,

    input: {
      ...job.input,
    },

    argv: [...job.argv],

    logs: includeLogs
      ? job.logs.map((entry) => ({
          ...entry,
        }))
      : [],
  };
}

function jobToRow(job: LaunchJob): LaunchJobDbRow {
  return {
    jobId: job.id,

    kind: job.kind,

    status: job.status,

    inputJson: json(job.input),

    argvJson: json(job.argv),

    resultJson: job.result ? json(job.result) : null,

    error: job.error ?? null,

    createdAtMs: job.createdAtMs,

    updatedAtMs: job.updatedAtMs,
  };
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

async function persistWithRetry<T>(
  action: string,
  operation: () => T,
): Promise<T> {
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

      if (elapsedMs >= LAUNCH_PERSIST_RETRY_MS) {
        throw Object.assign(
          new Error(
            `Launch history persistence timed out after ${elapsedMs}ms.`,
            {
              cause: error,
            },
          ),
          {
            code: "SOLARD_LAUNCH_HISTORY_BUSY",

            attempts: attempt,
          },
        );
      }

      const delayMs = Math.min(
        busyDelayMs(attempt),
        LAUNCH_PERSIST_RETRY_MS - elapsedMs,
      );

      if (attempt === 1 || attempt % 8 === 0) {
        console.warn(
          `[solard:launch-history] ${action} busy; retrying asynchronously in ${delayMs}ms`,
        );
      }

      await Bun.sleep(delayMs);
    }
  }
}

function enqueuePersistence(action: string, operation: () => unknown): void {
  persistenceTail = persistenceTail
    .catch(() => undefined)
    .then(async () => {
      await persistWithRetry(action, operation);
    })
    .catch((error) => {
      /**
       * Persistence failure is observable, but it never aborts or delays
       * the live launch that owns this bookkeeping event.
       */
      console.error(`[solard:launch-history] ${action} failed`, error);
    });
}

function persistJob(job: LaunchJob): void {
  const row = jobToRow(cloneJob(job, false));

  enqueuePersistence(
    `db.persist_launch_job job=${compactId(job.id)} status=${job.status}`,
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
      }),
  );
}

function persistLog(jobId: string, entry: LaunchJob["logs"][number]): void {
  const row: LaunchJobLogDbRow = {
    logId: randomUUID(),

    jobId,

    atMs: entry.atMs,

    label: entry.label,

    valueJson: json(entry.value),
  };

  enqueuePersistence(`db.persist_launch_log job=${compactId(jobId)}`, () =>
    db.launchJobLogsV2.insert(row),
  );
}

function updateRuntimeJob(
  jobId: string,
  patch: Partial<Pick<LaunchJob, "status" | "result" | "error">>,
): LaunchJob | null {
  const current = runtimeJobs.get(jobId);

  if (!current) {
    return null;
  }

  const next: LaunchJob = {
    ...current,
    ...patch,

    updatedAtMs: Date.now(),
  };

  if (patch.error === undefined && current.error !== undefined) {
    next.error = current.error;
  }

  runtimeJobs.set(jobId, next);

  persistJob(next);

  return next;
}

function pushLog(jobId: string, label: string, value: unknown): void {
  const current = runtimeJobs.get(jobId);

  if (!current) {
    return;
  }

  const entry = {
    atMs: Date.now(),

    label,

    value,
  };

  const logs = [...current.logs, entry].slice(-MAX_LOGS_PER_JOB);

  runtimeJobs.set(jobId, {
    ...current,

    logs,

    updatedAtMs: entry.atMs,
  });

  persistLog(jobId, entry);
}

function readWithoutWaiting<T>(
  action: string,
  operation: () => T,
  fallback: T,
): T {
  try {
    return dbMeasure.sync(
      {
        start: () => action,

        end: (result: any) => ({
          ok: result != null,
        }),

        catch: summarizeError,
      },
      operation,
    );
  } catch (error) {
    if (isSqliteBusyError(error)) {
      console.warn(
        `[solard:launch-history] ${action} busy; serving in-memory jobs`,
      );

      return fallback;
    }

    console.error(
      `[solard:launch-history] ${action} failed; serving in-memory jobs`,
      error,
    );

    return fallback;
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

export function listLaunchJobLogs(
  jobId: string,
  limit = MAX_LOGS_PER_JOB,
): LaunchJob["logs"] {
  const runtime = runtimeJobs.get(jobId);

  if (runtime) {
    return runtime.logs.slice(-clampLimit(limit, MAX_LOGS_PER_JOB));
  }

  const rows = readWithoutWaiting(
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
    [],
  );

  return rows.reverse().map((row) => ({
    atMs: Number(row.atMs) || 0,

    label: row.label,

    value: parseJson(row.valueJson, null),
  }));
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
  const now = Date.now();

  const publicInput = persistedLaunchInput(input);

  const job: LaunchJob = {
    id: randomUUID(),

    kind: "launch:pump",

    status: "queued",

    createdAtMs: now,

    updatedAtMs: now,

    input: publicInput,

    argv: pumpLaunchArgsFromInput(publicInput),

    logs: [],
  };

  /**
   * Acceptance is in-memory and immediate. Database availability is not part
   * of the live-launch admission path.
   */
  runtimeJobs.set(job.id, job);

  persistJob(job);

  queueMicrotask(() => {
    void (async () => {
      updateRuntimeJob(job.id, {
        status: "running",

        error: undefined,
      });

      pushLog(job.id, "launch input", summarizeForMeasure(publicInput));

      pushLog(job.id, "launch argv", job.argv);

      try {
        const argv = pumpLaunchArgsFromInput(input);

        const result = await indexerMeasure.measure(
          {
            start: () =>
              `launch.pump.live job=${compactId(job.id)} creator=${compactId(input.creator)}`,

            end: (value: any) => ({
              job: compactId(job.id),

              mint: compactId(value?.token?.mint ?? value?.mint),

              live: true,
            }),

            catch: summarizeError,
          },
          () =>
            runPumpTokenLaunchFromArgs(argv, {
              defaultSubmitMode: "after-deploy-processed",

              defaultDeploymentPriorityMicroLamports: 0,

              defaultBuyerPriorityMicroLamports: 1_500_000,

              defaultSlippageBps: 9_999,

              persistOnLive: true,

              report: (label, value) =>
                pushLog(job.id, label, summarizeForMeasure(value)),
            }),
        );

        updateRuntimeJob(job.id, {
          status: "succeeded",

          result,

          error: undefined,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);

        pushLog(job.id, "fatal", message);

        updateRuntimeJob(job.id, {
          status: "failed",

          error: message,
        });
      } finally {
        await cleanupTemporaryLaunchImage(input).catch((error) => {
          pushLog(job.id, "image cleanup failed", summarizeForMeasure(error));
        });
      }
    })();
  });

  return cloneJob(job);
}

export function listLaunchJobs(
  options: ListLaunchJobsOptions = {},
): LaunchJob[] {
  const limit = clampLimit(options.limit, DEFAULT_JOB_LIMIT);

  const status = launchJobStatus(options.status ?? null);

  const rows = readWithoutWaiting(
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
    [],
  );

  const byId = new Map<string, LaunchJob>();

  for (const row of rows) {
    byId.set(
      row.jobId,
      rowToJob(row, options.includeLogs ? listLaunchJobLogs(row.jobId) : []),
    );
  }

  for (const job of runtimeJobs.values()) {
    if (status && job.status !== status) {
      continue;
    }

    byId.set(job.id, cloneJob(job, Boolean(options.includeLogs)));
  }

  return [...byId.values()]
    .sort((left, right) => right.createdAtMs - left.createdAtMs)
    .slice(0, limit);
}

export function getLaunchJob(id: string): LaunchJob | undefined {
  const runtime = runtimeJobs.get(id);

  if (runtime) {
    return cloneJob(runtime);
  }

  const row = readWithoutWaiting<LaunchJobDbRow | null>(
    `db.get_launch_job job=${compactId(id)}`,
    () =>
      (db.launchJobsV2
        .select()
        .where({
          jobId: id,
        })
        .get() as LaunchJobDbRow | null) ?? null,
    null,
  );

  return row ? rowToJob(row, listLaunchJobLogs(row.jobId)) : undefined;
}
