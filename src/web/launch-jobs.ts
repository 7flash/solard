import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  runPumpTokenLaunchFromArgs,
  type PumpTokenLaunchCliResult,
} from "../launches/pump/token-launch-cli.js";
import { jsonReplacer } from "./http.js";
import { PersistentJobStore, type JobPage } from "./job-store.js";
import { scopedLogger } from "./logger.js";

export type LaunchJobStatus = "running" | "succeeded" | "failed";

export type LaunchJob = {
  id: string;
  kind: "launch:pump";
  status: LaunchJobStatus;
  createdAtMs: number;
  updatedAtMs: number;
  argv: string[];
  logs: Array<{ atMs: number; label: string; value: unknown }>;
  result?: PumpTokenLaunchCliResult;
  error?: string;
};

const logger = scopedLogger("launch-jobs");
const jobs = new Map<string, LaunchJob>();
const MAX_LOGS = Number(process.env.SOLARD_MAX_JOB_LOGS ?? "500");
const MAX_JOBS = Number(process.env.SOLARD_MAX_JOBS ?? "100");
let loaded = false;

function jobsPath(): string {
  return resolve(
    process.env.SOLARD_JOBS_PATH?.trim() ||
      process.env.SOLWAL_JOBS_PATH?.trim() ||
      "./.solard/jobs.json",
  );
}

function serializable(job: LaunchJob): LaunchJob {
  return JSON.parse(JSON.stringify(job, jsonReplacer));
}

function reviveJob(row: any): LaunchJob | null {
  if (!row?.id || row?.kind !== "launch:pump") return null;
  const wasRunning = row.status === "running";
  return {
    id: String(row.id),
    kind: "launch:pump",
    status: wasRunning
      ? "failed"
      : row.status === "succeeded"
        ? "succeeded"
        : "failed",
    createdAtMs: Number(row.createdAtMs) || Date.now(),
    updatedAtMs: Number(row.updatedAtMs) || Date.now(),
    argv: Array.isArray(row.argv) ? row.argv.map(String) : [],
    logs: Array.isArray(row.logs) ? row.logs.slice(-MAX_LOGS) : [],
    result: row.result,
    error: wasRunning
      ? "Server restarted while this launch job was running."
      : typeof row.error === "string"
        ? row.error
        : undefined,
  };
}

const store = new PersistentJobStore<LaunchJob>({
  path: jobsPath(),
  maxRows: MAX_JOBS,
  revive: reviveJob,
});

function loadJobsOnce(): void {
  if (loaded) return;
  loaded = true;
  for (const job of store.all()) jobs.set(job.id, job);
  logger.info("launch jobs loaded", { count: jobs.size, path: jobsPath() });
}

function persistJob(job: LaunchJob): void {
  store.put(serializable(job));
}

function pushLog(job: LaunchJob, label: string, value: unknown): void {
  job.logs.push(
    JSON.parse(
      JSON.stringify({ atMs: Date.now(), label, value }, jsonReplacer),
    ),
  );
  if (job.logs.length > MAX_LOGS)
    job.logs.splice(0, job.logs.length - MAX_LOGS);
  job.updatedAtMs = Date.now();
  persistJob(job);
}

function pruneJobs(): void {
  loadJobsOnce();
  if (jobs.size <= MAX_JOBS) return;
  const stale = [...jobs.values()]
    .sort((a, b) => a.updatedAtMs - b.updatedAtMs)
    .slice(0, jobs.size - MAX_JOBS);
  for (const job of stale) jobs.delete(job.id);
  store.prune();
}

export function startPumpLaunchJob(argv: string[]): LaunchJob {
  loadJobsOnce();
  pruneJobs();
  const job: LaunchJob = {
    id: randomUUID(),
    kind: "launch:pump",
    status: "running",
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    argv,
    logs: [],
  };
  jobs.set(job.id, job);
  persistJob(job);

  queueMicrotask(() => {
    void (async () => {
      try {
        pushLog(job, "launch argv", argv);
        job.result = await runPumpTokenLaunchFromArgs(argv, {
          defaultSubmitMode: "after-deploy-processed",
          defaultDeploymentPriorityMicroLamports: 0,
          defaultBuyerPriorityMicroLamports: 1_500_000,
          defaultSlippageBps: 9_999,
          persistOnLive: true,
          report: (label, value) => pushLog(job, label, value),
        });
        job.status = "succeeded";
        logger.info("launch job succeeded", { id: job.id, result: job.result });
      } catch (error) {
        job.status = "failed";
        job.error =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);
        pushLog(job, "fatal", job.error);
        logger.error("launch job failed", { id: job.id, error: job.error });
      } finally {
        job.updatedAtMs = Date.now();
        persistJob(job);
      }
    })();
  });

  return job;
}

export function listLaunchJobs(): LaunchJob[] {
  loadJobsOnce();
  return [...jobs.values()].sort((a, b) => b.createdAtMs - a.createdAtMs);
}

export function listLaunchJobsPage(
  args: {
    limit?: number;
    cursor?: string | null;
    status?: LaunchJobStatus | "any" | null;
  } = {},
): JobPage<LaunchJob> {
  loadJobsOnce();
  const status = args.status && args.status !== "any" ? args.status : null;
  return store.page({ limit: args.limit, cursor: args.cursor, status });
}

export function getLaunchJob(id: string): LaunchJob | undefined {
  loadJobsOnce();
  return jobs.get(id) ?? store.get(id);
}

export function cleanupLaunchJobs(args: { olderThanMs?: number } = {}): {
  deleted: number;
  remaining: number;
} {
  loadJobsOnce();
  const cutoff = Date.now() - Math.max(1, args.olderThanMs ?? 14 * 86_400_000);
  for (const job of [...jobs.values()]) {
    if (job.updatedAtMs < cutoff) jobs.delete(job.id);
  }
  const deleted = store.pruneOlderThan(cutoff);
  return { deleted, remaining: jobs.size };
}
