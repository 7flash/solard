import { upsertProcessStatus } from "../db/terminal-store.js";
import { createMeasure, summarizeForMeasure } from "../measure.js";
import { getBgrunSdk } from "./bgrun-sdk.js";
import {
  resolveWorkerNames,
  WORKER_SPECS,
  type SolardStreamSource,
  type SolardWorkerName,
} from "./bgrun.js";

const workerMeasure = createMeasure("solard:bgrun-workers");
const ROOT = process.cwd();

export type BgrunWorkerSupervisorOptions = {
  source?: SolardStreamSource | string | null;
  telegram?: boolean;
  restart?: boolean;
};

export type BgrunWorkerSupervisor = {
  readonly names: SolardWorkerName[];
  running: () => Promise<Array<{ name: SolardWorkerName; pid: number; status: "running" | "stopped" | "missing" }>>;
  stop: (reason?: string) => Promise<void>;
};

function envForWorker(name: SolardWorkerName): Record<string, string> {
  const spec = WORKER_SPECS[name];
  return {
    ...process.env,
    SOLARD_WORKER_NAME: name,
    SOLARD_WORKER_SUPERVISOR: "bgrun-sdk",
    SOLARD_EXPECTED_BUILD_ID: spec.buildId,
    BGR_PARENT_NAME: process.env.BGR_PROCESS_NAME || "solard",
  };
}

async function ensureBgrunSdkWorker(name: SolardWorkerName, restart = false): Promise<void> {
  const bgrun = await getBgrunSdk();
  const spec = WORKER_SPECS[name];
  const existing = bgrun.getProcess(name);

  if (existing && restart && typeof existing.pid === "number") {
    await bgrun.terminateProcess(existing.pid, true);
    await bgrun.removeProcessByName(name);
    await Bun.sleep(250);
  }

  if (!existing || restart) {
    await bgrun.handleRun({
      action: "run",
      name,
      command: spec.command,
      directory: ROOT,
      env: envForWorker(name),
      force: true,
      remoteName: "",
    });
  }

  upsertProcessStatus({
    name,
    kind: spec.kind,
    status: existing && !restart ? "already-running" : restart ? "restarted" : "started",
    data: {
      command: spec.command,
      buildId: spec.buildId,
      supervisor: "bgrun-sdk",
      parent: process.env.BGR_PROCESS_NAME || "solard",
      restart,
    },
  });
}

export async function startBgrunWorkerSupervisor(
  options: BgrunWorkerSupervisorOptions = {},
): Promise<BgrunWorkerSupervisor> {
  const names = resolveWorkerNames({ source: options.source, telegram: options.telegram });

  await workerMeasure.measure(
    {
      start: () => "start bgrun sdk workers",
      end: () => ({ names, supervisor: "bgrun-sdk" }),
    },
    async () => {
      for (const name of names) {
        await ensureBgrunSdkWorker(name, options.restart === true);
        await Bun.sleep(250);
      }
      return summarizeForMeasure({ names });
    },
  );

  return {
    names,
    running: async () => {
      const bgrun = await getBgrunSdk();
      const rows = [];
      for (const name of names) {
        const proc = bgrun.getProcess(name);
        if (!proc || typeof proc.pid !== "number") {
          rows.push({ name, pid: 0, status: "missing" as const });
          continue;
        }
        const alive = await bgrun.isProcessRunning(proc.pid, String(proc.command ?? ""));
        rows.push({ name, pid: proc.pid, status: alive ? "running" as const : "stopped" as const });
      }
      return rows;
    },
    stop: async (reason = "shutdown") => {
      await workerMeasure.measure(
        {
          start: () => "stop bgrun sdk workers",
          end: () => ({ reason, stopped: names.length }),
        },
        async () => {
          const bgrun = await getBgrunSdk();
          for (const name of names) {
            const spec = WORKER_SPECS[name];
            const proc = bgrun.getProcess(name);
            upsertProcessStatus({
              name,
              kind: spec.kind,
              status: "stopping",
              data: { reason, supervisor: "bgrun-sdk", command: spec.command, buildId: spec.buildId },
            });
            if (proc && typeof proc.pid === "number") {
              await bgrun.terminateProcess(proc.pid, true);
              await bgrun.removeProcessByName(name);
            }
            upsertProcessStatus({
              name,
              kind: spec.kind,
              status: "stopped",
              data: { reason, supervisor: "bgrun-sdk", command: spec.command, buildId: spec.buildId },
            });
          }
          return summarizeForMeasure({ stopped: names });
        },
      );
    },
  };
}
