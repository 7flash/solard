import bgrun, * as bgrunModule from "bgrun";
import { measure, measureSync, configure } from "measure-fn";
import {
  listProcessStatus,
  upsertProcessStatus,
} from "./src/solard/db/terminal-store.js";
import {
  processMeasure,
  createMeasure,
  summarizeForMeasure,
} from "./src/solard/measure.js";

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

configure({ timestamps: true });
const workerMeasure = createMeasure("solard:orchestrator"),
  ROOT = process.cwd(),
  P_NAME = () => process.env.BGR_PROCESS_NAME || "solard";
const bgrunSdk = [
  bgrun,
  (bgrun as any)?.default,
  bgrunModule,
  bgrunModule.default,
  (bgrunModule.default as any)?.default,
].find((c) => c && typeof c.handleRun === "function") as any;
if (!bgrunSdk) throw new Error("bgrun SDK missing required lifecycle exports.");

export const WORKER_SPECS: Record<SolardWorkerName, WorkerSpec> = {
  "solard-server-worker": {
    name: "solard-server-worker",
    kind: "server",
    command: "bun run ./src/solard/workers/server-worker.ts",
    staleAfterMs: 10000,
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

export function resolveWorkerNames() {
  const src = String(
    process.env.SOLARD_STREAM_SOURCE || "helius",
  ).toLowerCase();
  const mode = String(
    process.env.SOLARD_HELIUS_MODE ?? "logs+poll",
  ).toLowerCase();
  const hWorkers: SolardWorkerName[] =
    mode === "poll"
      ? ["solard-helius-live-v2"]
      : mode === "laserstream" ||
          mode === "ws" ||
          process.env.SOLARD_HELIUS_TRANSPORT === "ws"
        ? ["solard-helius-laserstream-v1"]
        : mode === "all"
          ? [
              "solard-helius-logs-v1",
              "solard-helius-live-v2",
              "solard-helius-laserstream-v1",
            ]
          : ["solard-helius-logs-v1", "solard-helius-live-v2"];
  const list: SolardWorkerName[] = [
    "solard-server-worker",
    // ...(src === "helius"
    //   ? hWorkers
    //   : src === "helius-ws"
    //     ? ["solard-helius-laserstream-v1"]
    //     : src === "both"
    //       ? ["solard-pumpportal-live-v2", ...hWorkers]
    //       : (["solard-pumpportal-live-v2"] as SolardWorkerName[])),
    // "solard-curve-snapshots",
    // "solard-holder-snapshots",
    // "solard-metadata-repair",
    // "solard-reconciler",
  ];
  if (process.env.SOLARD_TELEGRAM_SIGNALS === "1")
    list.push("solard-telegram-signals");
  return list;
}

async function syncStatus(name: SolardWorkerName, status: string, extra = {}) {
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

export async function manageWorkers(
  action: "start" | "stop",
  names: SolardWorkerName[],
) {
  for (const name of action === "stop" ? names.toReversed() : names) {
    const proc = bgrunSdk.getProcess(name);
    if (action === "start") {
      if (proc && process.env.SOLARD_RESTART_WORKERS_ON_BOOT === "1") {
        await bgrunSdk.handleStop(name);
        await Bun.sleep(200);
      }
      if (
        !bgrunSdk.getProcess(name) ||
        process.env.SOLARD_RESTART_WORKERS_ON_BOOT === "1"
      ) {
        await bgrunSdk.handleRun({
          action: "run",
          name,
          command: WORKER_SPECS[name].command,
          directory: ROOT,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                (e) => typeof e[1] === "string",
              ),
            ),
            SOLARD_WORKER_NAME: name,
            SOLARD_WORKER_SUPERVISOR: "bgrun-sdk",
            SOLARD_EXPECTED_BUILD_ID: WORKER_SPECS[name].buildId,
            BGR_PARENT_NAME: P_NAME(),
          },
          force: true,
          remoteName: "",
        });
      }
      await syncStatus(name, bgrunSdk.getProcess(name) ? "started" : "error");
    } else {
      await syncStatus(name, "stopping");
      if (proc) await bgrunSdk.handleStop(name);
      await syncStatus(name, "stopped");
    }
    await Bun.sleep(200);
  }
}

const targetWorkers = resolveWorkerNames();
let exitCode = 0,
  keepRunning = true;

const shutdown = (reason: string, code: number) => {
  if (!keepRunning) return;
  keepRunning = false;
  exitCode = code;
  measureSync(`solard:shutdown:${reason}`, () =>
    console.log(`Triggering orchestrator teardown: ${reason}`),
  );
};
process.once("SIGINT", () => shutdown("SIGINT", 130));
process.once("SIGTERM", () => shutdown("SIGTERM", 143));
process.on("unhandledRejection", (r) => {
  console.error(r);
  shutdown("Unhandled Rejection", 1);
});
process.on("uncaughtException", (e) => {
  console.error(e);
  shutdown("Uncaught Exception", 1);
});

try {
  await measure(
    {
      start: () => "solard:orchestrator:boot",
      end: () => "Runtime processing established.",
    },
    async () => {
      await manageWorkers("start", targetWorkers);

      while (keepRunning) {
        await processMeasure.measure(
          { start: () => "solard:health_check_tick", end: (res) => res },
          async () => {
            const dbStatuses = new Map(
              listProcessStatus().map((r) => [r.name, r]),
            );
            const checked = await Promise.all(
              targetWorkers.map(async (name) => {
                const p = bgrunSdk.getProcess(name),
                  db = dbStatuses.get(name);
                const alive = p?.pid
                  ? await bgrunSdk.isProcessRunning(
                      p.pid,
                      String(p.command ?? ""),
                    )
                  : false;
                const stale =
                  !db?.heartbeatAtMs ||
                  Date.now() - Number(db.heartbeatAtMs) >
                    WORKER_SPECS[name].staleAfterMs;

                if (!alive || stale || db?.error) {
                  measureSync(`solard:alert:${name}`, () =>
                    console.warn(
                      `Worker failure detected on ${name}. Alive: ${alive}, Stale: ${stale}, Error: ${db?.error ?? "none"}`,
                    ),
                  );
                  if (process.env.SOLARD_AUTO_RECOVERY === "1")
                    await manageWorkers("start", [name]);
                }
                return { name, alive, stale, hasErrors: !!db?.error };
              }),
            );
            return {
              targetCount: targetWorkers.length,
              activeCount: checked.filter((c) => c.alive && !c.stale).length,
              status: checked,
            };
          },
        );
        await Bun.sleep(5000);
      }
    },
  );
} catch (err) {
  exitCode = 1;
  console.error("Fatal exception in main loop block:", err);
} finally {
  try {
    if (process.env.SOLARD_STOP_WORKERS_ON_EXIT !== "0")
      await manageWorkers("stop", targetWorkers);
  } catch (e) {
    console.error(e);
  }
  measureSync(
    "solard:orchestrator:complete",
    () => `Exiting pipeline system with exit code ${exitCode}`,
  );
  setTimeout(() => process.exit(exitCode), 50).unref();
}
