import bgrun from "bgrun";
import {
  listProcessStatus,
  upsertProcessStatus,
} from "./src/solard/db/terminal-store.js";
import { processMeasure as m } from "./src/solard/measure.js";

export type SolardWorkerName =
  | "solard-server-worker"
  | "solard-helius-logs-v1"
  | "solard-helius-live-v2"
  | "solard-helius-laserstream-v1"
  | "solard-pumpportal-live-v2"
  | "solard-curve-snapshots"
  | "solard-holder-snapshots"
  | "solard-metadata-repair"
  | "solard-reconciler"
  | "solard-telegram-signals";

export type WorkerSpec = {
  name: SolardWorkerName;
  kind: "stream" | "reconciler" | "signals" | "server";
  command: string;
  staleAfterMs: number;
  buildId: string;
};

const ROOT = process.cwd();
const P_NAME = () => process.env.BGR_PROCESS_NAME || "solard";

if (!bgrun || typeof bgrun.handleRun !== "function") {
  throw new Error(
    "bgrun SDK compatibility error: require bgrun@3.13.0+ exports.",
  );
}

m.sync("bgrun_db", () => ({
  dbPath: bgrun.dbPath,
  bgrHome: bgrun.bgrHome,
}));

export const WORKER_SPECS: Record<SolardWorkerName, WorkerSpec> = {
  "solard-server-worker": {
    name: "solard-server-worker",
    kind: "server",
    command: "bun run ./src/solard/workers/server-worker.ts",
    staleAfterMs: 10_000,
    buildId: "solard-server-v1",
  },

  "solard-helius-logs-v1": {
    name: "solard-helius-logs-v1",
    kind: "stream",
    command: "bun run ./src/solard/workers/helius-logs-worker.ts",
    staleAfterMs: Number(process.env.SOLARD_HELIUS_LOGS_STALE_MS ?? "12000"),
    buildId: "helius-logs-v1-standard-logs-subscribe",
  },

  "solard-helius-live-v2": {
    name: "solard-helius-live-v2",
    kind: "stream",
    command: "bun run ./src/solard/workers/helius-live-worker.ts",
    staleAfterMs: Number(process.env.SOLARD_HELIUS_STALE_MS ?? "15000"),
    buildId: "helius-live-v6-logs-primary-fallback",
  },

  "solard-helius-laserstream-v1": {
    name: "solard-helius-laserstream-v1",
    kind: "stream",
    command: "bun run ./src/solard/workers/helius-laserstream-worker.ts",
    staleAfterMs: Number(process.env.SOLARD_HELIUS_WS_STALE_MS ?? "12000"),
    buildId: "helius-laserstream-v1-transaction-subscribe",
  },

  "solard-pumpportal-live-v2": {
    name: "solard-pumpportal-live-v2",
    kind: "stream",
    command: "bun run ./src/solard/workers/pumpportal-worker.ts",
    staleAfterMs: Number(process.env.SOLARD_PUMPPORTAL_STALE_MS ?? "15000"),
    buildId: "pumpportal-live-v4-trades-mayhem",
  },

  "solard-curve-snapshots": {
    name: "solard-curve-snapshots",
    kind: "stream",
    command: "bun run ./src/solard/workers/curve-snapshot-worker.ts",
    staleAfterMs: Number(process.env.SOLARD_CURVE_SNAPSHOT_STALE_MS ?? "12000"),
    buildId: "curve-snapshots-v1-bonding-account",
  },

  "solard-holder-snapshots": {
    name: "solard-holder-snapshots",
    kind: "stream",
    command: "bun run ./src/solard/workers/holder-snapshot-worker.ts",
    staleAfterMs: Number(
      process.env.SOLARD_HOLDER_SNAPSHOT_STALE_MS ?? "45000",
    ),
    buildId: "holder-snapshots-v1-largest-accounts",
  },

  "solard-metadata-repair": {
    name: "solard-metadata-repair",
    kind: "stream",
    command: "bun run ./src/solard/workers/metadata-repair-worker.ts",
    staleAfterMs: Number(
      process.env.SOLARD_METADATA_REPAIR_STALE_MS ?? "30000",
    ),
    buildId: "metadata-repair-v1-das-uri-loop",
  },

  "solard-reconciler": {
    name: "solard-reconciler",
    kind: "reconciler",
    command: "bun run ./src/solard/workers/reconciler-worker.ts",
    staleAfterMs: Number(process.env.SOLARD_RECONCILER_STALE_MS ?? "30000"),
    buildId: "reconciler-v3-build-heartbeat",
  },

  "solard-telegram-signals": {
    name: "solard-telegram-signals",
    kind: "signals",
    command: "bun run ./src/solard/workers/telegram-signal-worker.ts",
    staleAfterMs: Number(
      process.env.SOLARD_TELEGRAM_SIGNALS_STALE_MS ?? "45000",
    ),
    buildId: "telegram-signals-v2",
  },
};

export function resolveWorkerNames(): SolardWorkerName[] {
  const list: SolardWorkerName[] = [
    "solard-server-worker",
    "solard-helius-logs-v1",
  ];

  if (process.env.SOLARD_TELEGRAM_SIGNALS === "1") {
    list.push("solard-telegram-signals");
  }

  return list;
}

function syncStatus(
  name: SolardWorkerName,
  status: string,
  extra: Record<string, unknown> = {},
): void {
  upsertProcessStatus({
    name,
    kind: WORKER_SPECS[name].kind,
    status,
    data: {
      command: WORKER_SPECS[name].command,
      buildId: WORKER_SPECS[name].buildId,
      supervisor: "bgrun-sdk",
      parent: P_NAME(),
      ...extra,
    },
  });
}

function cleanEnv(name: SolardWorkerName): Record<string, string> {
  const clean: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (
      key === "BGR_PROCESS_NAME" ||
      key === "BGR_PARENT_NAME" ||
      key === "BGR_STDOUT" ||
      key === "BGR_STDERR" ||
      typeof value !== "string"
    ) {
      continue;
    }

    clean[key] = value;
  }

  return {
    ...clean,
    SOLARD_WORKER_NAME: name,
    SOLARD_WORKER_SUPERVISOR: "bgrun-sdk",
    SOLARD_EXPECTED_BUILD_ID: WORKER_SPECS[name].buildId,
    BGR_PARENT_NAME: P_NAME(),
  };
}

async function isBgrunProcessAlive(processInfo: any | undefined): Promise<boolean> {
  const pid = Number(processInfo?.pid ?? 0);

  if (!pid || pid <= 0) {
    return false;
  }

  return await bgrun.isProcessRunning(
    pid,
    String(processInfo?.command ?? ""),
  );
}

async function cleanStaleWorker(
  name: SolardWorkerName,
  existing: any,
  alive: boolean,
  restartRequested: boolean,
): Promise<void> {
  await m("clean_stale", async () => {
    try {
      await bgrun.handleStop(name);
    } catch (error) {
      m.sync("stop_failed", () => ({
        name,
        error,
      }));
    }

    if (bgrun.getProcess(name)) {
      const removeProcessByName = (bgrun as any).removeProcessByName;

      if (typeof removeProcessByName === "function") {
        removeProcessByName.call(bgrun, name);
      }
    }

    await Bun.sleep(250);

    return {
      pid: existing?.pid ?? null,
      alive,
      restartRequested,
      removed: !bgrun.getProcess(name),
    };
  });
}

export async function ensureWorker(name: SolardWorkerName): Promise<void> {
  await m(`worker:${name}`, async () => {
    const spec = WORKER_SPECS[name];

    const existing = bgrun.getProcess(name);
    const alive = await isBgrunProcessAlive(existing);

    const restartRequested =
      process.env.SOLARD_RESTART_WORKERS_ON_BOOT === "1";

    if (existing && (!alive || restartRequested)) {
      await cleanStaleWorker(name, existing, alive, restartRequested);
    }

    if (!bgrun.getProcess(name)) {
      await m("start", async () => {
        await bgrun.handleRun({
          action: "run",
          name,
          command: spec.command,
          directory: ROOT,
          env: cleanEnv(name),
          force: true,
          remoteName: "",
        });

        syncStatus(name, "started");

        return {
          command: spec.command,
          buildId: spec.buildId,
        };
      });
    }

    const after = bgrun.getProcess(name);
    const afterAlive = await isBgrunProcessAlive(after);

    if (!after || !after.pid || after.pid <= 0 || !afterAlive) {
      throw new Error(
        `bgrun failed to start ${name}: registered pid=${
          after?.pid ?? "null"
        }, alive=${afterAlive}`,
      );
    }

    return {
      status: "ready",
      name,
      pid: after.pid,
      alive: afterAlive,
      command: after.command ?? null,
    };
  });
}

export async function stopWorker(name: SolardWorkerName): Promise<void> {
  await m(`stop_worker:${name}`, async () => {
    syncStatus(name, "stopping");

    const existing = bgrun.getProcess(name);

    if (existing) {
      await bgrun.handleStop(name);
    }

    syncStatus(name, "stopped");

    return {
      name,
      existed: !!existing,
      pid: existing?.pid ?? null,
    };
  });
}

export async function startAllWorkers(): Promise<void> {
  await m("start_all_workers", async () => {
    const started: SolardWorkerName[] = [];

    for (const name of targetWorkers) {
      await ensureWorker(name);
      started.push(name);
      await Bun.sleep(200);
    }

    return {
      count: started.length,
      workers: started,
    };
  });
}

export async function stopAllWorkers(): Promise<void> {
  await m("stop_all_workers", async () => {
    const stopped: SolardWorkerName[] = [];

    for (const name of targetWorkers.toReversed()) {
      await stopWorker(name);
      stopped.push(name);
      await Bun.sleep(200);
    }

    return {
      count: stopped.length,
      workers: stopped,
    };
  });
}

async function checkWorker(
  name: SolardWorkerName,
  dbStatuses: Map<string, any>,
) {
  return await m(`check:${name}`, async () => {
    const processInfo = bgrun.getProcess(name);
    const db = dbStatuses.get(name);

    const alive = await isBgrunProcessAlive(processInfo);

    const stale =
      !db?.heartbeatAtMs ||
      Date.now() - Number(db.heartbeatAtMs) >
        WORKER_SPECS[name].staleAfterMs;

    const hasErrors = !!db?.error;

    if (!alive || stale || hasErrors) {
      m.sync(`alert:${name}`, () => {
        console.warn(
          `Recovery trigger on ${name}. Alive: ${alive}, Stale: ${stale}, Error: ${
            db?.error ?? "none"
          }`,
        );

        return {
          alive,
          stale,
          hasErrors,
          error: db?.error ?? null,
        };
      });

      if (process.env.SOLARD_AUTO_RECOVERY === "1") {
        await m(`recover:${name}`, async () => {
          if (processInfo) {
            await bgrun.handleStop(name);
            await Bun.sleep(250);
          }

          await ensureWorker(name);

          return {
            recovered: true,
          };
        });
      }
    }

    return {
      name,
      alive,
      stale,
      hasErrors,
    };
  });
}

async function healthCheckTick(): Promise<void> {
  await m.root("health_check_tick", async () => {
    const dbStatuses = new Map(
      listProcessStatus().map((row) => [row.name, row]),
    );

    const checked = await Promise.all(
      targetWorkers.map((name) => checkWorker(name, dbStatuses)),
    );

    return {
      targetCount: targetWorkers.length,
      activeCount: checked.filter((worker) => worker.alive && !worker.stale)
        .length,
      status: checked,
    };
  });
}

const targetWorkers = resolveWorkerNames();

let exitCode = 0;
let keepRunning = true;

const shutdown = (reason: string, code: number) => {
  if (!keepRunning) return;

  keepRunning = false;
  exitCode = code;

  m.sync(`shutdown:${reason}`, () => {
    console.log(`Teardown initiated: ${reason}`);

    return {
      reason,
      code,
    };
  });
};

process.once("SIGINT", () => shutdown("SIGINT", 130));
process.once("SIGTERM", () => shutdown("SIGTERM", 143));

process.on("unhandledRejection", (reason) => {
  m.sync("unhandled_rejection", () => {
    console.error(reason);
    return reason;
  });

  shutdown("Unhandled Rejection", 1);
});

process.on("uncaughtException", (error) => {
  m.sync("uncaught_exception", () => {
    console.error(error);
    return error;
  });

  shutdown("Uncaught Exception", 1);
});

try {
  await m.root(
    {
      start: () => "boot",
      end: () => "workers ready",
    },
    async () => {
      await startAllWorkers();

      return {
        workers: targetWorkers,
        count: targetWorkers.length,
      };
    },
  );

  while (keepRunning) {
    await healthCheckTick();
    await Bun.sleep(5000);
  }
} catch (error) {
  exitCode = 1;

  m.sync("fatal", () => {
    console.error("Fatal exception:", error);
    return error;
  });
} finally {
  try {
    if (process.env.SOLARD_STOP_WORKERS_ON_EXIT !== "0") {
      await stopAllWorkers();
    }
  } catch (error) {
    m.sync("stop_workers_on_exit_failed", () => {
      console.error(error);
      return error;
    });
  }

  m.sync("complete", () => ({
    exitCode,
    message: `Exiting pipeline system with exit code ${exitCode}`,
  }));

  setTimeout(() => process.exit(exitCode), 50).unref();
}
