import { randomUUID } from "node:crypto";
import {
  runPumpTokenLaunchFromArgs,
  type PumpTokenLaunchCliResult,
} from "../launches/pump/token-launch-cli.js";
import { jsonReplacer } from "./http.js";

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

const jobs = new Map<string, LaunchJob>();
const MAX_LOGS = 500;
const MAX_JOBS = 100;

function pushLog(job: LaunchJob, label: string, value: unknown): void {
  job.logs.push(
    JSON.parse(
      JSON.stringify({ atMs: Date.now(), label, value }, jsonReplacer),
    ),
  );
  if (job.logs.length > MAX_LOGS)
    job.logs.splice(0, job.logs.length - MAX_LOGS);
  job.updatedAtMs = Date.now();
}

function pruneJobs(): void {
  if (jobs.size <= MAX_JOBS) return;
  const stale = [...jobs.values()]
    .sort((a, b) => a.updatedAtMs - b.updatedAtMs)
    .slice(0, jobs.size - MAX_JOBS);
  for (const job of stale) jobs.delete(job.id);
}

export function startPumpLaunchJob(argv: string[]): LaunchJob {
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
      } catch (error) {
        job.status = "failed";
        job.error =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);
        pushLog(job, "fatal", job.error);
      } finally {
        job.updatedAtMs = Date.now();
      }
    })();
  });

  return job;
}

export function listLaunchJobs(): LaunchJob[] {
  return [...jobs.values()].sort((a, b) => b.createdAtMs - a.createdAtMs);
}

export function getLaunchJob(id: string): LaunchJob | undefined {
  return jobs.get(id);
}
