import {
  getLaunchJob,
  launchJobStatus,
  listLaunchJobLogs,
  listLaunchJobs,
  type LaunchJobStatus,
} from "../jobs/launch-job-store.js";
import { measureSolard, summarizeForMeasure } from "../api-response.js";

export type ListJobsInput = {
  status?: string | null;
  limit?: number | null;
  includeLogs?: boolean | null;
};

export async function listJobsAction(input: ListJobsInput = {}) {
  const status = launchJobStatus(input.status ?? null);
  const measured = await measureSolard(
    `solard:action:jobs:list${status ? `:${status}` : ""}`,
    "listJobsAction",
    () =>
      listLaunchJobs({
        status,
        limit: input.limit,
        includeLogs: Boolean(input.includeLogs),
      }),
    {
      summarize: (value) => ({
        count: value.length,
        first: value[0] ? summarizeForMeasure(value[0]) : null,
      }),
      meta: {
        status,
        limit: input.limit ?? null,
        includeLogs: Boolean(input.includeLogs),
      },
      onError: (error) => {
        throw error;
      },
    },
  );
  return measured.value;
}

export async function getJobAction(input: { id: string }) {
  const id = input.id?.trim();
  if (!id) throw new Error("job id is required");
  const measured = await measureSolard(
    `solard:action:jobs:get:${id}`,
    "getJobAction",
    () => getLaunchJob(id),
    {
      summarize: summarizeForMeasure,
      meta: { jobId: id },
      onError: (error) => {
        throw error;
      },
    },
  );
  if (!measured.value)
    throw Object.assign(new Error("Unknown job"), { status: 404 });
  return measured.value;
}

export async function listJobLogsAction(input: {
  id: string;
  limit?: number | null;
}) {
  const id = input.id?.trim();
  if (!id) throw new Error("job id is required");
  const measured = await measureSolard(
    `solard:action:jobs:logs:${id}`,
    "listJobLogsAction",
    () => listLaunchJobLogs(id, input.limit ?? undefined),
    {
      summarize: (value) => ({
        count: value.length,
        last: value.at(-1) ? summarizeForMeasure(value.at(-1)) : null,
      }),
      meta: { jobId: id, limit: input.limit ?? null },
      onError: (error) => {
        throw error;
      },
    },
  );
  return measured.value;
}

export type { LaunchJobStatus };
