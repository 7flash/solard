import {
  listProcessStatus,
  upsertProcessStatus,
} from "../db/terminal-store.js";
import { processMeasure, summarizeForMeasure } from "../measure.js";

export type SolardWorkerName =
  | "solard-pumpportal"
  | "solard-pump-creates"
  | "solard-pump-trades"
  | "solard-reconciler"
  | "solard-telegram-signals";

export type WorkerSpec = {
  name: SolardWorkerName;
  kind: "stream" | "reconciler" | "signals";
  command: string;
  staleAfterMs: number;
  env?: Record<string, string>;
};

const ROOT = process.cwd();

export const WORKER_SPECS: Record<SolardWorkerName, WorkerSpec> = {
  "solard-pumpportal": {
    name: "solard-pumpportal",
    kind: "stream",
    command: "bun run ./src/solard/workers/pumpportal-worker.ts",
    staleAfterMs: Number(process.env.SOLARD_PUMPPORTAL_STALE_MS ?? "15000"),
  },
  "solard-pump-creates": {
    name: "solard-pump-creates",
    kind: "stream",
    command: "bun run ./src/solard/workers/pump-create-worker.ts",
    staleAfterMs: Number(process.env.SOLARD_PUMP_CREATE_STALE_MS ?? "15000"),
  },
  "solard-pump-trades": {
    name: "solard-pump-trades",
    kind: "stream",
    command: "bun run ./src/solard/workers/pump-trade-worker.ts",
    staleAfterMs: Number(process.env.SOLARD_PUMP_TRADE_STALE_MS ?? "15000"),
  },
  "solard-reconciler": {
    name: "solard-reconciler",
    kind: "reconciler",
    command: "bun run ./src/solard/workers/reconciler-worker.ts",
    staleAfterMs: Number(process.env.SOLARD_RECONCILER_STALE_MS ?? "30000"),
  },
  "solard-telegram-signals": {
    name: "solard-telegram-signals",
    kind: "signals",
    command: "bun run ./src/solard/workers/telegram-signal-worker.ts",
    staleAfterMs: Number(
      process.env.SOLARD_TELEGRAM_SIGNALS_STALE_MS ?? "45000",
    ),
  },
};

export const CORE_WORKERS: SolardWorkerName[] = [
  "solard-pumpportal",
  "solard-pump-creates",
  "solard-pump-trades",
  "solard-reconciler",
];

export function isSolardWorkerName(
  value: string | null | undefined,
): value is SolardWorkerName {
  return !!value && Object.prototype.hasOwnProperty.call(WORKER_SPECS, value);
}

export function resolveWorkerNames(input?: {
  worker?: string | null;
  all?: boolean;
  telegram?: boolean;
}): SolardWorkerName[] {
  if (input?.worker && input.worker !== "all") {
    if (!isSolardWorkerName(input.worker)) {
      throw new Error(`Unknown worker: ${input.worker}`);
    }
    return [input.worker];
  }
  const names = [...CORE_WORKERS];
  if (input?.telegram || process.env.SOLARD_TELEGRAM_SIGNALS === "1") {
    names.push("solard-telegram-signals");
  }
  return names;
}

function decode(stdout: Uint8Array | null | undefined): string {
  return stdout ? new TextDecoder().decode(stdout).trim() : "";
}

function runBgrun(args: string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const proc = Bun.spawnSync({
    cmd: ["bun", "x", "bgrun", ...args],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  return {
    exitCode: proc.exitCode,
    stdout: decode(proc.stdout),
    stderr: decode(proc.stderr),
  };
}

export function listBgrunProcesses(): Array<Record<string, unknown>> {
  return processMeasure.measureSync(
    {
      start: () => "bgrun list",
      end: (rows) => ({ rows: Array.isArray(rows) ? rows.length : 0 }),
      catch: () => [],
    },
    () => {
      const result = runBgrun(["--json"]);
      if (result.exitCode !== 0) return [];
      const parsed = JSON.parse(result.stdout || "[]");
      return Array.isArray(parsed) ? parsed : [];
    },
  );
}

function bgrunRowByName(name: string): Record<string, unknown> | null {
  return (
    listBgrunProcesses().find((row) => String(row.name ?? "") === name) ?? null
  );
}

export type WorkerRuntimeStatus = {
  name: SolardWorkerName;
  kind: WorkerSpec["kind"];
  command: string;
  managed: boolean;
  bgrun: Record<string, unknown> | null;
  status: string;
  heartbeatAtMs: number;
  ageMs: number;
  stale: boolean;
  error: string | null;
  data: Record<string, unknown>;
};

export function listWorkerRuntimeStatus(
  input: { telegram?: boolean } = {},
): WorkerRuntimeStatus[] {
  return processMeasure.measureSync(
    {
      start: () => "worker runtime status",
      end: (rows) => ({
        rows: rows.length,
        stale: rows.filter((row) => row.stale).length,
      }),
    },
    () => {
      const now = Date.now();
      const processRows = new Map(
        listProcessStatus().map((row) => [row.name, row]),
      );
      const bgrunRows = new Map(
        listBgrunProcesses().map((row) => [String(row.name ?? ""), row]),
      );
      return resolveWorkerNames({ telegram: input.telegram }).map((name) => {
        const spec = WORKER_SPECS[name];
        const row = processRows.get(name) as
          | {
              name: string;
              kind: string;
              status: string;
              heartbeatAtMs: number;
              error: string | null;
              data?: Record<string, unknown>;
            }
          | undefined;
        const heartbeatAtMs = Number(row?.heartbeatAtMs ?? 0);
        const ageMs =
          heartbeatAtMs > 0 ? now - heartbeatAtMs : Number.POSITIVE_INFINITY;
        const bgrun = bgrunRows.get(name) ?? null;
        return {
          name,
          kind: spec.kind,
          command: spec.command,
          managed: !!bgrun,
          bgrun,
          status: row?.status ?? (bgrun ? "starting" : "missing"),
          heartbeatAtMs,
          ageMs,
          stale: !heartbeatAtMs || ageMs > spec.staleAfterMs,
          error: row?.error ?? null,
          data: row?.data ?? {},
        };
      });
    },
  );
}

export async function ensureBgrunWorker(
  name: SolardWorkerName,
  restart = false,
): Promise<Record<string, unknown>> {
  const spec = WORKER_SPECS[name];
  return await processMeasure.measure(
    {
      start: () => `ensure ${name}`,
      end: (result) => ({ result: summarizeForMeasure(result) }),
      catch: (error) => {
        upsertProcessStatus({
          name,
          kind: spec.kind,
          status: "error",
          error,
          data: { command: spec.command, phase: "ensure" },
        });
        throw error;
      },
    },
    async () => {
      const exists = !!bgrunRowByName(name);
      const shouldStart = restart || !exists;
      if (shouldStart) {
        const args = exists
          ? ["--restart", name]
          : [
              "--name",
              name,
              "--command",
              spec.command,
              "--directory",
              ROOT,
              "--force",
            ];
        const result = runBgrun(args);
        if (result.exitCode !== 0) {
          throw new Error(
            `bgrun ${name} failed: ${result.stderr || result.stdout || result.exitCode}`,
          );
        }
      }
      upsertProcessStatus({
        name,
        kind: spec.kind,
        status:
          exists && !restart
            ? "already-running"
            : restart
              ? "restarted"
              : "started",
        data: { command: spec.command, restart, supervisor: "bgrun" },
      });
      return {
        name,
        kind: spec.kind,
        running: true,
        restarted: restart,
        command: spec.command,
      };
    },
  );
}

export async function ensureWorkerGroup(
  args: { telegram?: boolean; restart?: boolean; restartStale?: boolean } = {},
): Promise<Record<string, unknown>> {
  return await processMeasure.measure(
    {
      start: () => "ensure worker group",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    async () => {
      const before = listWorkerRuntimeStatus({ telegram: args.telegram });
      const results = [];
      for (const status of before) {
        const restart =
          args.restart === true ||
          (args.restartStale === true && status.stale && status.managed);
        results.push(await ensureBgrunWorker(status.name, restart));
        await Bun.sleep(350);
      }
      const after = listWorkerRuntimeStatus({ telegram: args.telegram });
      return {
        ready: after.every((row) => row.managed && !row.error),
        stale: after.filter((row) => row.stale).map((row) => row.name),
        workers: results,
        status: after,
      };
    },
  );
}

export function stopBgrunWorker(
  name: SolardWorkerName,
): Record<string, unknown> {
  return processMeasure.measureSync(
    {
      start: () => `stop ${name}`,
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    () => {
      const result = runBgrun(["--stop", name]);
      upsertProcessStatus({
        name,
        kind: WORKER_SPECS[name].kind,
        status: result.exitCode === 0 ? "stopped" : "stop-failed",
        data: { stdout: result.stdout, supervisor: "bgrun" },
        error: result.exitCode === 0 ? null : result.stderr,
      });
      return {
        name,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  );
}

export function stopWorkerGroup(
  input: { telegram?: boolean } = {},
): Record<string, unknown> {
  const workers = resolveWorkerNames({ telegram: input.telegram });
  return { workers: workers.map((name) => stopBgrunWorker(name)) };
}
