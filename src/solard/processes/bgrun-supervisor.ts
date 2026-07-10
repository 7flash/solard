import { upsertProcessStatus } from "../db/terminal-store.js";
import { createMeasure, summarizeForMeasure } from "../measure.js";
import bgrun from "./bgrun-sdk.js";
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
  running: () => Promise<
    Array<{
      name: SolardWorkerName;
      pid: number;
      status: "running" | "stopped" | "missing";
    }>
  >;
  stop: (reason?: string) => Promise<void>;
};

function parentName(): string {
  return process.env.BGR_PROCESS_NAME || "solard";
}

function inheritedStringEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function envForWorker(name: SolardWorkerName): Record<string, string> {
  const spec = WORKER_SPECS[name];
  return {
    ...inheritedStringEnv(),
    SOLARD_WORKER_NAME: name,
    SOLARD_WORKER_SUPERVISOR: "bgrun-sdk",
    SOLARD_EXPECTED_BUILD_ID: spec.buildId,

    // bgrun now auto-injects this when the parent is itself managed. Keeping it
    // explicit makes ownership reliable for local/manual server starts too.
    BGR_PARENT_NAME: parentName(),
  };
}

async function ensureBgrunSdkWorker(
  name: SolardWorkerName,
  restart = false,
): Promise<void> {
  const spec = WORKER_SPECS[name];
  const existing = bgrun.getProcess(name);

  if (existing && restart) {
    await bgrun.handleStop(name);
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
    status:
      existing && !restart
        ? "already-running"
        : restart
          ? "restarted"
          : "started",
    data: {
      command: spec.command,
      buildId: spec.buildId,
      supervisor: "bgrun-sdk",
      parent: parentName(),
      restart,
    },
  });
}

export async function startBgrunWorkerSupervisor(
  options: BgrunWorkerSupervisorOptions = {},
): Promise<BgrunWorkerSupervisor> {
  const names = resolveWorkerNames({
    source: options.source,
    telegram: options.telegram,
  });

  await workerMeasure.measure(
    {
      start: () => "start bgrun sdk workers",
      end: () => ({ names, supervisor: "bgrun-sdk", parent: parentName() }),
      catch: (error) => {
        throw error;
      },
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
      const rows = [];
      for (const name of names) {
        const proc = bgrun.getProcess(name);
        if (!proc || typeof proc.pid !== "number") {
          rows.push({ name, pid: 0, status: "missing" as const });
          continue;
        }
        const alive = await bgrun.isProcessRunning(
          proc.pid,
          String(proc.command ?? ""),
        );
        rows.push({
          name,
          pid: proc.pid,
          status: alive ? ("running" as const) : ("stopped" as const),
        });
      }
      return rows;
    },
    stop: async (reason = "shutdown") => {
      await workerMeasure.measure(
        {
          start: () => "stop bgrun sdk workers",
          end: () => ({ reason, stopped: names.length, parent: parentName() }),
        },
        async () => {
          for (const name of names.toReversed()) {
            const spec = WORKER_SPECS[name];
            const proc = bgrun.getProcess(name);
            upsertProcessStatus({
              name,
              kind: spec.kind,
              status: "stopping",
              data: {
                reason,
                supervisor: "bgrun-sdk",
                command: spec.command,
                buildId: spec.buildId,
              },
            });

            if (proc) await bgrun.handleStop(name);

            upsertProcessStatus({
              name,
              kind: spec.kind,
              status: "stopped",
              data: {
                reason,
                supervisor: "bgrun-sdk",
                command: spec.command,
                buildId: spec.buildId,
              },
            });
          }
          return summarizeForMeasure({ stopped: names });
        },
      );
    },
  };
}
