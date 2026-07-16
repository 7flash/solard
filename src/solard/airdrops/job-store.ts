import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { AirdropJob, AirdropPlan } from "./types.js";

const JOB_DIR = resolve(
  process.env.SOLARD_AIRDROP_JOB_DIR?.trim() || "./.solard/airdrop-jobs",
);

const globalState = globalThis as typeof globalThis & {
  __solardAirdropJobs?: Map<string, AirdropJob>;
  __solardAirdropPlanJobs?: Map<string, string>;
  __solardAirdropJobsLoaded?: boolean;
};

const jobs = (globalState.__solardAirdropJobs ??= new Map<
  string,
  AirdropJob
>());
const planJobs = (globalState.__solardAirdropPlanJobs ??= new Map<
  string,
  string
>());

function jobPath(id: string): string {
  return resolve(JOB_DIR, `${id}.json`);
}

async function ensureLoaded(): Promise<void> {
  if (globalState.__solardAirdropJobsLoaded) return;
  globalState.__solardAirdropJobsLoaded = true;
  await mkdir(JOB_DIR, { recursive: true });
  const names = await readdir(JOB_DIR).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(
        await readFile(resolve(JOB_DIR, name), "utf8"),
      ) as AirdropJob;
      jobs.set(parsed.id, parsed);
      planJobs.set(parsed.planId, parsed.id);
    } catch {
      // Ignore interrupted or manually edited job files.
    }
  }
}

async function persist(job: AirdropJob): Promise<void> {
  await mkdir(JOB_DIR, { recursive: true });
  const path = jobPath(job.id);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(job, null, 2), "utf8");
  await rename(temporary, path);
}

export function snapshotJob(job: AirdropJob): AirdropJob {
  return structuredClone(job);
}

export async function createAirdropJob(plan: AirdropPlan): Promise<AirdropJob> {
  await ensureLoaded();
  const previousId = planJobs.get(plan.planId);
  if (previousId) {
    const previous = await getAirdropJob(previousId);
    if (previous) return previous;
  }

  const now = Date.now();
  const batchSize = Math.max(
    1,
    Math.min(10, Number(process.env.SOLARD_AIRDROP_BATCH_SIZE ?? "5") || 5),
  );
  const job: AirdropJob = {
    id: `airdrop-${now}-${randomUUID().slice(0, 8)}`,
    planId: plan.planId,
    status: "queued",
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
        message: `Queued ${plan.recipients.length} recipient airdrop from ${plan.bankWallet}.`,
      },
    ],
    error: null,
  };

  jobs.set(job.id, job);
  planJobs.set(plan.planId, job.id);
  await persist(job);
  return snapshotJob(job);
}

export async function getAirdropJob(id: string): Promise<AirdropJob | null> {
  await ensureLoaded();
  const cached = jobs.get(id);
  if (cached) return snapshotJob(cached);

  try {
    const parsed = JSON.parse(
      await readFile(jobPath(id), "utf8"),
    ) as AirdropJob;
    jobs.set(parsed.id, parsed);
    planJobs.set(parsed.planId, parsed.id);
    return snapshotJob(parsed);
  } catch {
    return null;
  }
}

export function getMutableAirdropJob(id: string): AirdropJob | null {
  return jobs.get(id) ?? null;
}

export async function updateAirdropJob(
  id: string,
  mutate: (job: AirdropJob) => void,
): Promise<AirdropJob> {
  const job = jobs.get(id);
  if (!job) throw new Error(`Unknown airdrop job: ${id}`);
  mutate(job);
  job.updatedAtMs = Date.now();
  if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500);
  await persist(job);
  return snapshotJob(job);
}

export async function listAirdropJobs(limit = 20): Promise<AirdropJob[]> {
  await ensureLoaded();
  return [...jobs.values()]
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map(snapshotJob);
}
