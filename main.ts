import bgrun from "bgrun";
import {
  isSqliteBusyError,
  listProcessStatus,
  upsertProcessStatus,
} from "./shared/db.js";
import { compactId, dbMeasure, summarizeError } from "./shared/measure.js";

type WorkerName =
  "solard-server-worker" | "solard-helius-logs-v1" | "solard-telegram-signals";

type WorkerSpec = {
  name: WorkerName;
  kind: "server" | "indexer" | "signals";
  command: string;
  staleAfterMs: number;
  buildId: string;
};

const ROOT = process.cwd();
const PARENT_NAME = process.env.BGR_PROCESS_NAME || "solard";

const WORKERS: Record<WorkerName, WorkerSpec> = {
  "solard-server-worker": {
    name: "solard-server-worker",
    kind: "server",
    command: "bun run ./src/solard/workers/server-worker.ts",
    staleAfterMs: Number(process.env.SOLARD_SERVER_STALE_MS ?? "10000"),
    buildId: "solard-server-v1",
  },

  "solard-helius-logs-v1": {
    name: "solard-helius-logs-v1",
    kind: "indexer",

    /**
     * Important: this is the standalone indexer. The old src/solard worker
     * used terminal-ingestion.ts and treated duplicate event keys as errors.
     */
    command: "bun run ./workers/helius-logs-worker.ts",

    staleAfterMs: Number(process.env.SOLARD_HELIUS_LOGS_STALE_MS ?? "15000"),

    buildId: "indexer-v17-runtime-health",
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

function targetWorkers(): WorkerName[] {
  const names: WorkerName[] = ["solard-server-worker", "solard-helius-logs-v1"];

  if (process.env.SOLARD_TELEGRAM_SIGNALS === "1") {
    names.push("solard-telegram-signals");
  }

  return names;
}

function inheritedEnv(spec: WorkerSpec): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (row): row is [string, string] =>
        typeof row[1] === "string" &&
        ![
          "BGR_PROCESS_NAME",
          "BGR_PARENT_NAME",
          "BGR_STDOUT",
          "BGR_STDERR",
        ].includes(row[0]),
    ),
  );

  return {
    ...env,

    SOLARD_WORKER_NAME: spec.name,

    SOLARD_WORKER_SUPERVISOR: "bgrun-sdk",

    SOLARD_EXPECTED_BUILD_ID: spec.buildId,

    SOLARD_INDEXER_NAME: spec.name,

    SOLARD_INDEXER_BUILD_ID: spec.buildId,

    BGR_PARENT_NAME: PARENT_NAME,
  };
}

function processRow(name: WorkerName) {
  return listProcessStatus(100).find((row) => row.name === name) ?? null;
}

async function processAlive(name: WorkerName): Promise<boolean> {
  const processInfo = bgrun.getProcess(name);

  const pid = Number(processInfo?.pid ?? 0);

  if (!pid || pid <= 0) {
    return false;
  }

  return await bgrun
    .isProcessRunning(pid, String(processInfo?.command ?? ""))
    .catch(() => false);
}

function commandMatches(name: WorkerName): boolean {
  const processInfo = bgrun.getProcess(name);

  if (!processInfo) {
    return false;
  }

  const actual = String(processInfo.command ?? "")
    .replaceAll("\\", "/")
    .trim();

  const expected = WORKERS[name].command.replaceAll("\\", "/").trim();

  return actual === expected;
}

let supervisorStatusQueue: Promise<void> = Promise.resolve();

const STATUS_WRITE_ATTEMPTS = 5;

function statusWriteDelayMs(attempt: number): number {
  return Math.min(500, 20 * 2 ** Math.max(0, attempt - 1));
}

async function persistSupervisorStatus(
  spec: WorkerSpec,
  status: string,
  error: unknown,
): Promise<void> {
  const now = Date.now();

  for (let attempt = 1; attempt <= STATUS_WRITE_ATTEMPTS; attempt++) {
    try {
      dbMeasure.sync(
        {
          start: () =>
            `db.upsert_process_status name=${compactId(spec.name)} status=${status} source=supervisor`,

          end: (result: any) => ({
            updated: result != null,

            status: result?.status ?? status,
          }),

          catch: summarizeError,
        },
        () =>
          upsertProcessStatus({
            name: spec.name,

            kind: spec.kind,

            status,

            heartbeatAtMs: now,

            pid: Number(bgrun.getProcess(spec.name)?.pid ?? 0),

            buildId: spec.buildId,

            error:
              error == null
                ? null
                : error instanceof Error
                  ? error.message
                  : String(error),

            dataJson: JSON.stringify({
              command: spec.command,

              buildId: spec.buildId,

              supervisor: "bgrun-sdk",

              parent: PARENT_NAME,
            }),

            updatedAtMs: now,
          }),
      );

      return;
    } catch (writeError) {
      if (!isSqliteBusyError(writeError) || attempt >= STATUS_WRITE_ATTEMPTS) {
        throw writeError;
      }

      await Bun.sleep(statusWriteDelayMs(attempt));
    }
  }
}

function writeSupervisorStatus(
  spec: WorkerSpec,
  status: string,
  error: unknown = null,
): void {
  /**
   * Status persistence is telemetry. Keep writes ordered, retry SQLITE_BUSY,
   * and report failure without terminating the supervisor.
   */
  supervisorStatusQueue = supervisorStatusQueue
    .catch(() => undefined)
    .then(() => persistSupervisorStatus(spec, status, error))
    .catch((writeError) => {
      console.error(
        `[solard:supervisor] unable to persist ${spec.name} status=${status}`,
        writeError,
      );
    });
}

async function flushSupervisorStatus(): Promise<void> {
  await supervisorStatusQueue.catch(() => undefined);
}

async function stopWorker(name: WorkerName): Promise<void> {
  const spec = WORKERS[name];

  writeSupervisorStatus(spec, "stopping");

  if (bgrun.getProcess(name)) {
    await bgrun.handleStop(name).catch(() => undefined);
  }

  writeSupervisorStatus(spec, "stopped");
}

async function ensureWorker(name: WorkerName, force = false): Promise<void> {
  const spec = WORKERS[name];

  const existing = bgrun.getProcess(name);

  const alive = await processAlive(name);

  const commandMismatch = Boolean(existing) && !commandMatches(name);

  if (existing && (force || !alive || commandMismatch)) {
    console.warn(
      `[solard:supervisor] replacing ${name}; alive=${alive} commandMismatch=${commandMismatch}`,
    );

    await bgrun.handleStop(name).catch(() => undefined);

    await Bun.sleep(250);
  }

  if (force || !bgrun.getProcess(name) || !alive || commandMismatch) {
    writeSupervisorStatus(spec, "starting");

    await bgrun.handleRun({
      action: "run",

      name,

      command: spec.command,

      directory: ROOT,

      env: inheritedEnv(spec),

      force: true,

      remoteName: "",
    });
  }

  if (!(await processAlive(name))) {
    const error = new Error(`bgrun failed to start ${name}`);

    writeSupervisorStatus(spec, "error", error);

    throw error;
  }
}

const lastRecovery = new Map<WorkerName, number>();

async function healthTick(names: WorkerName[]): Promise<void> {
  const now = Date.now();

  for (const name of names) {
    const spec = WORKERS[name];

    const status = processRow(name);

    const alive = await processAlive(name);

    const commandMismatch = !commandMatches(name);

    const heartbeatAtMs = Number(status?.heartbeatAtMs ?? 0);

    const stale = heartbeatAtMs <= 0 || now - heartbeatAtMs > spec.staleAfterMs;

    const hasError = Boolean(String(status?.error ?? "").trim());

    if (alive && !stale && !hasError && !commandMismatch) {
      continue;
    }

    console.warn(
      `[solard:supervisor] ${name} unhealthy alive=${alive} stale=${stale} commandMismatch=${commandMismatch} error=${status?.error ?? "none"}`,
    );

    /**
     * Dead, stale, or wrong-command workers recover automatically. A fresh
     * process with a historical error remains visible but is not restarted in
     * an endless loop solely because an error string exists.
     */
    if (
      (!alive || stale || commandMismatch) &&
      process.env.SOLARD_AUTO_RECOVERY !== "0"
    ) {
      const previous = lastRecovery.get(name) ?? 0;

      if (now - previous >= 15_000) {
        lastRecovery.set(name, now);

        await ensureWorker(name, true).catch((error) =>
          writeSupervisorStatus(spec, "error", error),
        );
      }
    }
  }
}

let keepRunning = true;
let exitCode = 0;

function shutdown(code: number): void {
  keepRunning = false;
  exitCode = code;
}

process.once("SIGINT", () => shutdown(130));

process.once("SIGTERM", () => shutdown(143));

const names = targetWorkers();

try {
  for (const name of names) {
    await ensureWorker(
      name,
      process.env.SOLARD_RESTART_WORKERS_ON_BOOT === "1",
    );

    await Bun.sleep(200);
  }

  while (keepRunning) {
    await healthTick(names);
    await Bun.sleep(5_000);
  }
} catch (error) {
  exitCode = 1;

  console.error("[solard:supervisor] fatal", error);
} finally {
  if (process.env.SOLARD_STOP_WORKERS_ON_EXIT !== "0") {
    for (const name of [...names].reverse()) {
      await stopWorker(name).catch(() => undefined);
    }
  }

  await flushSupervisorStatus();

  setTimeout(() => process.exit(exitCode), 50).unref();
}
