import {
  ensureBgrunWorker,
  ensureWorkerGroup,
  normalizeWorkerName,
  listBgrunProcesses,
  listManagedBgrunChildren,
  listWorkerRuntimeStatus,
  resolveWorkerNames,
  stopBgrunWorker,
  stopWorkerGroup,
} from "../processes/bgrun.js";
import { terminalStoreStats } from "../db/terminal-store.js";
import { processMeasure, summarizeForMeasure } from "../measure.js";

export function listProcessesAction(
  input: { telegram?: boolean; source?: string | null } = {},
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
      bgrunChildren: listManagedBgrunChildren(),
      store: terminalStoreStats(),
    }),
  );
}

export async function ensureProcessesAction(
  input: {
    worker?: string | null;
    all?: boolean;
    telegram?: boolean;
    source?: string | null;
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
        const worker = normalizeWorkerName(input.worker);
        if (!worker) throw new Error(`Unknown worker: ${input.worker}`);
        return await ensureBgrunWorker(worker, input.restart === true);
      }
      return await ensureWorkerGroup({
        telegram: input.telegram,
        source: input.source,
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
    source?: string | null;
  } = {},
): Promise<Record<string, unknown>> {
  return await processMeasure.measure(
    {
      start: () => "restart processes",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    async () => {
      if (input.worker && input.worker !== "all") {
        const worker = normalizeWorkerName(input.worker);
        if (!worker) throw new Error(`Unknown worker: ${input.worker}`);
        return await ensureBgrunWorker(worker, true);
      }
      return await ensureWorkerGroup({
        telegram: input.telegram,
        source: input.source,
        restart: true,
      });
    },
  );
}

export async function stopProcessAction(
  worker: string,
  input: { telegram?: boolean; source?: string | null } = {},
): Promise<Record<string, unknown>> {
  return await processMeasure.measure(
    {
      start: () => `stop process ${worker || "all"}`,
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    async () => {
      if (!worker || worker === "all")
        return await stopWorkerGroup({
          telegram: input.telegram,
          source: input.source,
        });
      const normalized = normalizeWorkerName(worker);
      if (!normalized) throw new Error(`Unknown worker: ${worker}`);
      return await stopBgrunWorker(normalized);
    },
  );
}

export function resolveProcessesAction(
  input: {
    worker?: string | null;
    telegram?: boolean;
    source?: string | null;
  } = {},
): Record<string, unknown> {
  return {
    workers: resolveWorkerNames({
      worker: input.worker,
      telegram: input.telegram,
      source: input.source,
    }),
  };
}
