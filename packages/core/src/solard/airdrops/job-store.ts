import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { publishAirdropJob } from "./events.ts";
import type { AirdropJob, AirdropPlan } from "./types.ts";

const JOB_DIR = resolve(
  process.env.SOLARD_AIRDROP_JOB_DIR?.trim() || "./.solard/airdrop-jobs",
);

const globalState = globalThis as typeof globalThis & {
  __solardAirdropJobsV3?: Map<string, AirdropJob>;
  __solardAirdropPlanJobsV3?: Map<string, string>;
  __solardAirdropJobsLoadedV3?: boolean;
  __solardAirdropJobLocksV3?: Map<string, Promise<unknown>>;
};

const jobs = (globalState.__solardAirdropJobsV3 ??= new Map<
  string,
  AirdropJob
>());
const planJobs = (globalState.__solardAirdropPlanJobsV3 ??= new Map<
  string,
  string
>());
const locks = (globalState.__solardAirdropJobLocksV3 ??= new Map<
  string,
  Promise<unknown>
>());

function jobPath(id: string): string {
  return resolve(JOB_DIR, `${id}.json`);
}

function clone(job: AirdropJob): AirdropJob {
  return structuredClone(job);
}

async function persist(job: AirdropJob): Promise<void> {
  await mkdir(JOB_DIR, { recursive: true });
  const path = jobPath(job.id);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(job, null, 2), "utf8");
  await rename(temporary, path);
}

function interrupted(job: AirdropJob): boolean {
  return job.status === "queued" || job.status === "running";
}

async function ensureLoaded(): Promise<void> {
  if (globalState.__solardAirdropJobsLoadedV3) return;
  globalState.__solardAirdropJobsLoadedV3 = true;
  await mkdir(JOB_DIR, { recursive: true });
  const names = await readdir(JOB_DIR).catch(() => [] as string[]);

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(
        await readFile(resolve(JOB_DIR, name), "utf8"),
      ) as AirdropJob;
      if (parsed?.plan?.version !== 3) continue;
      if (interrupted(parsed)) {
        const now = Date.now();
        const hasSubmitted = (parsed.recipients ?? []).some(
          (recipient) => recipient.status === "submitted",
        );
        parsed.status = hasSubmitted
          ? "attention"
          : parsed.progress?.sent > 0
            ? "partial"
            : "failed";
        parsed.error = hasSubmitted
          ? "The server restarted after a transaction was submitted. Verify submitted signatures on-chain before any retry."
          : "The server restarted before this airdrop finished. Review confirmed signatures before retrying.";
        parsed.finishedAtMs = now;
        parsed.updatedAtMs = now;
        parsed.logs = Array.isArray(parsed.logs) ? parsed.logs : [];
        parsed.logs.push({ atMs: now, level: "error", message: parsed.error });
        for (const recipient of parsed.recipients ?? []) {
          if (recipient.status === "sending") {
            recipient.status = "failed";
            recipient.error =
              "Server restarted while this transaction was in flight; verify on-chain before retrying.";
          } else if (recipient.status === "queued") {
            recipient.status = "cancelled";
          }
        }
        await persist(parsed);
      }
      jobs.set(parsed.id, parsed);
      const previousId = planJobs.get(parsed.planId);
      const previous = previousId ? jobs.get(previousId) : null;
      if (!previous || previous.createdAtMs < parsed.createdAtMs) {
        planJobs.set(parsed.planId, parsed.id);
      }
    } catch {
      // Ignore interrupted or manually edited job files.
    }
  }
}

async function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const chain = previous.catch(() => undefined).then(() => gate);
  locks.set(id, chain);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(id) === chain) locks.delete(id);
  }
}

export async function createAirdropJob(plan: AirdropPlan): Promise<AirdropJob> {
  await ensureLoaded();
  const previousId = planJobs.get(plan.planId);
  if (previousId) {
    const previous = jobs.get(previousId);
    if (previous) {
      const safeFreshAttempt =
        previous.status === "failed" &&
        previous.progress.sent === 0 &&
        !previous.recipients.some(
          (recipient) => recipient.status === "submitted",
        );
      if (!safeFreshAttempt) return clone(previous);
    }
  }

  const previousAttempts = [...jobs.values()].filter(
    (job) => job.planId === plan.planId,
  ).length;
  const now = Date.now();
  const batchSize = Math.max(
    1,
    Math.min(10, Number(process.env.SOLARD_AIRDROP_BATCH_SIZE ?? "5") || 5),
  );
  const job: AirdropJob = {
    id: `airdrop-${now}-${randomUUID().slice(0, 8)}`,
    planId: plan.planId,
    attempt: previousAttempts + 1,
    status: "queued",
    cancelRequested: false,
    createdAtMs: now,
    updatedAtMs: now,
    startedAtMs: null,
    finishedAtMs: null,
    plan,
    progress: {
      total: plan.recipients.length,
      attempted: 0,
      sent: 0,
      failed: 0,
      cancelled: 0,
      batchesTotal: Math.ceil(plan.recipients.length / batchSize),
      batchesComplete: 0,
    },
    signatures: [],
    recipients: plan.recipients.map((recipient) => ({
      ...recipient,
      status: "queued",
    })),
    logs: [
      {
        atMs: now,
        level: "info",
        message: `Queued server airdrop attempt ${previousAttempts + 1} for ${plan.recipients.length} recipients.`,
      },
    ],
    error: null,
  };
  jobs.set(job.id, job);
  planJobs.set(plan.planId, job.id);
  await persist(job);
  publishAirdropJob(job);
  return clone(job);
}

export async function getAirdropJob(id: string): Promise<AirdropJob | null> {
  await ensureLoaded();
  const cached = jobs.get(id);
  if (cached) return clone(cached);
  try {
    const parsed = JSON.parse(
      await readFile(jobPath(id), "utf8"),
    ) as AirdropJob;
    if (parsed?.plan?.version !== 3) return null;
    jobs.set(parsed.id, parsed);
    planJobs.set(parsed.planId, parsed.id);
    return clone(parsed);
  } catch {
    return null;
  }
}

export async function updateAirdropJob(
  id: string,
  mutate: (job: AirdropJob) => void,
): Promise<AirdropJob> {
  await ensureLoaded();
  return await locked(id, async () => {
    const job = jobs.get(id);
    if (!job) throw new Error(`Unknown airdrop job: ${id}`);
    mutate(job);
    job.updatedAtMs = Date.now();
    if (job.logs.length > 600) job.logs.splice(0, job.logs.length - 600);
    await persist(job);
    publishAirdropJob(job);
    return clone(job);
  });
}

export async function requestAirdropCancel(id: string): Promise<AirdropJob> {
  return await updateAirdropJob(id, (job) => {
    if (["completed", "failed", "partial", "cancelled"].includes(job.status))
      return;
    job.cancelRequested = true;
    job.logs.push({
      atMs: Date.now(),
      level: "warn",
      message:
        "Cancellation requested. The current transaction, if any, will finish before the executor stops.",
    });
  });
}

export async function listAirdropJobs(limit = 20): Promise<AirdropJob[]> {
  await ensureLoaded();
  return [...jobs.values()]
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map(clone);
}
