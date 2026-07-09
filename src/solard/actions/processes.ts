import {
  ensureBgrunWorker,
  ensureWorkerGroup,
  listBgrunProcesses,
  stopBgrunWorker,
  type SolardWorkerName,
} from "../processes/bgrun.js";
import { listProcessStatus, terminalStoreStats } from "../db/terminal-store.js";
import { processMeasure, summarizeForMeasure } from "../measure.js";

export function listProcessesAction(): Record<string, unknown> {
  return processMeasure.measureSync(
    {
      start: () => "list processes",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    () => ({
      bgrun: listBgrunProcesses(),
      status: listProcessStatus(),
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
  } = {},
): Promise<Record<string, unknown>> {
  return await processMeasure.measure(
    {
      start: () => "ensure processes",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    async () => {
      if (input.worker && input.worker !== "all") {
        return await ensureBgrunWorker(
          input.worker as SolardWorkerName,
          input.restart === true,
        );
      }
      return await ensureWorkerGroup({
        telegram: input.telegram,
        restart: input.restart,
      });
    },
  );
}

export function stopProcessAction(worker: string): Record<string, unknown> {
  return stopBgrunWorker(worker as SolardWorkerName);
}
