import {
  ensureBgrunWorker,
  ensureWorkerGroup,
  isSolardWorkerName,
  listBgrunProcesses,
  listWorkerRuntimeStatus,
  resolveWorkerNames,
  stopBgrunWorker,
  stopWorkerGroup,
  type SolardWorkerName,
} from "../processes/bgrun.js";
import { terminalStoreStats } from "../db/terminal-store.js";
import { processMeasure, summarizeForMeasure } from "../measure.js";

export function listProcessesAction(
  input: { telegram?: boolean } = {},
): Record<string, unknown> {
  return processMeasure.measureSync(
    {
      start: () => "list processes",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    () => ({
      ready: listWorkerRuntimeStatus(input).every(
        (row) => row.managed && !row.stale && !row.error,
      ),
      workers: listWorkerRuntimeStatus(input),
      bgrun: listBgrunProcesses(),
      store: terminalStoreStats(),
    }),
  );
}

export async function ensureProcessesAction(
  input: {
    worker?: string | null;
    all?: boolean;
    telegram?: boolean;
    restart?: boolean;
    restartStale?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  return await processMeasure.measure(
    {
      start: () => "ensure processes",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    async () => {
      if (input.worker && input.worker !== "all") {
        if (!isSolardWorkerName(input.worker))
          throw new Error(`Unknown worker: ${input.worker}`);
        return await ensureBgrunWorker(input.worker, input.restart === true);
      }
      return await ensureWorkerGroup({
        telegram: input.telegram,
        restart: input.restart,
        restartStale: input.restartStale,
      });
    },
  );
}

export async function restartProcessesAction(
  input: {
    worker?: string | null;
    telegram?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  return await processMeasure.measure(
    {
      start: () => "restart processes",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    async () => {
      if (input.worker && input.worker !== "all") {
        if (!isSolardWorkerName(input.worker))
          throw new Error(`Unknown worker: ${input.worker}`);
        return await ensureBgrunWorker(input.worker, true);
      }
      return await ensureWorkerGroup({
        telegram: input.telegram,
        restart: true,
      });
    },
  );
}

export function stopProcessAction(
  worker: string,
  input: { telegram?: boolean } = {},
): Record<string, unknown> {
  return processMeasure.measureSync(
    {
      start: () => `stop process ${worker || "all"}`,
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    () => {
      if (!worker || worker === "all")
        return stopWorkerGroup({ telegram: input.telegram });
      if (!isSolardWorkerName(worker))
        throw new Error(`Unknown worker: ${worker}`);
      return stopBgrunWorker(worker as SolardWorkerName);
    },
  );
}

export function resolveProcessesAction(
  input: { worker?: string | null; telegram?: boolean } = {},
): Record<string, unknown> {
  return {
    workers: resolveWorkerNames({
      worker: input.worker,
      telegram: input.telegram,
    }),
  };
}
