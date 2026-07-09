import {
  listProcessStatus,
  upsertProcessStatus,
} from "../db/terminal-store.js";
import { clearWorkerErrors } from "../db/terminal-ingestion.js";
import { processMeasure, summarizeForMeasure } from "../measure.js";

export type SolardWorkerName =
  | "solard-helius-logs-v1"
  | "solard-helius-live-v2"
  | "solard-helius-laserstream-v1"
  | "solard-pumpportal-live-v2"
  | "solard-reconciler"
  | "solard-telegram-signals";

export type LegacySolardWorkerName =
  | "solard-helius-live"
  | "solard-pumpportal"
  | "solard-pump-creates"
  | "solard-pump-trades";

const LEGACY_WORKERS: LegacySolardWorkerName[] = [
  "solard-helius-live",
  "solard-pumpportal",
  "solard-pump-creates",
  "solard-pump-trades",
];

const WORKER_ALIASES: Record<string, SolardWorkerName> = {
  "solard-helius-live": "solard-helius-logs-v1",
  "solard-helius-logs": "solard-helius-logs-v1",
  "solard-helius-poll": "solard-helius-live-v2",
  "solard-helius-laserstream": "solard-helius-laserstream-v1",
  "solard-helius-ws": "solard-helius-laserstream-v1",
  "solard-pumpportal": "solard-pumpportal-live-v2",
  "solard-pump-creates": "solard-pumpportal-live-v2",
  "solard-pump-trades": "solard-helius-live-v2",
};

export type WorkerSpec = {
  name: SolardWorkerName;
  kind: "stream" | "reconciler" | "signals";
  command: string;
  staleAfterMs: number;
  buildId: string;
  env?: Record<string, string>;
};

const ROOT = process.cwd();

export const WORKER_SPECS: Record<SolardWorkerName, WorkerSpec> = {
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

export type SolardStreamSource = "pumpportal" | "helius" | "helius-ws" | "both";

export function normalizeStreamSource(
  value?: string | null,
): SolardStreamSource {
  const source = String(
    value || process.env.SOLARD_STREAM_SOURCE || "helius",
  ).toLowerCase();
  if (source.includes("both")) return "both";
  if (source.includes("laser") || source.includes("ws")) return "helius-ws";
  if (source.includes("helius")) return "helius";
  return "pumpportal";
}

export function coreWorkersForSource(
  sourceInput?: string | null,
): SolardWorkerName[] {
  const source = normalizeStreamSource(sourceInput);
  const mode = String(
    process.env.SOLARD_HELIUS_MODE ?? "logs+poll",
  ).toLowerCase();
  const heliusWorkers: SolardWorkerName[] =
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
  const streamWorkers: SolardWorkerName[] =
    source === "helius"
      ? heliusWorkers
      : source === "helius-ws"
        ? ["solard-helius-laserstream-v1"]
        : source === "both"
          ? ["solard-pumpportal-live-v2", ...heliusWorkers]
          : ["solard-pumpportal-live-v2"];
  return [...streamWorkers, "solard-reconciler"];
}

export const CORE_WORKERS: SolardWorkerName[] = coreWorkersForSource();

export function normalizeWorkerName(
  value: string | null | undefined,
): SolardWorkerName | null {
  if (!value) return null;
  if (Object.prototype.hasOwnProperty.call(WORKER_SPECS, value))
    return value as SolardWorkerName;
  return WORKER_ALIASES[value] ?? null;
}

export function isSolardWorkerName(
  value: string | null | undefined,
): value is SolardWorkerName {
  return !!normalizeWorkerName(value);
}

export function resolveWorkerNames(input?: {
  worker?: string | null;
  all?: boolean;
  telegram?: boolean;
  source?: string | null;
}): SolardWorkerName[] {
  if (input?.worker && input.worker !== "all") {
    const normalized = normalizeWorkerName(input.worker);
    if (!normalized) {
      throw new Error(`Unknown worker: ${input.worker}`);
    }
    return [normalized];
  }
  const names = coreWorkersForSource(input?.source);
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
  buildMismatch: boolean;
  expectedBuildId: string;
  actualBuildId: string | null;
  error: string | null;
  data: Record<string, unknown>;
};

export function listWorkerRuntimeStatus(
  input: { telegram?: boolean; source?: string | null } = {},
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
      return resolveWorkerNames({
        telegram: input.telegram,
        source: input.source,
      }).map((name) => {
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
        const data = row?.data ?? {};
        const actualBuildId =
          typeof (data as any).buildId === "string"
            ? String((data as any).buildId)
            : null;
        const buildMismatch = !!heartbeatAtMs && actualBuildId !== spec.buildId;
        const supervisor =
          typeof (data as any).supervisor === "string"
            ? String((data as any).supervisor)
            : null;
        const stopped = String(row?.status ?? "").includes("stopped");
        const serverManaged =
          supervisor === "server" && !stopped && !!heartbeatAtMs;
        return {
          name,
          kind: spec.kind,
          command: spec.command,
          managed: !!bgrun || serverManaged,
          bgrun,
          status: row?.status ?? (bgrun ? "starting" : "missing"),
          heartbeatAtMs,
          ageMs,
          stale: !heartbeatAtMs || ageMs > spec.staleAfterMs || buildMismatch,
          buildMismatch,
          expectedBuildId: spec.buildId,
          actualBuildId,
          error: row?.error ?? null,
          data,
        };
      });
    },
  );
}

function stopLegacyWorkersFor(name: SolardWorkerName): void {
  const legacyToStop =
    name === "solard-pumpportal-live-v2"
      ? ["solard-pumpportal", "solard-pump-creates"]
      : name === "solard-helius-logs-v1" ||
          name === "solard-helius-live-v2" ||
          name === "solard-helius-laserstream-v1"
        ? ["solard-helius-live", "solard-pump-trades"]
        : [];
  for (const legacy of legacyToStop) {
    const row = bgrunRowByName(legacy);
    if (!row) continue;
    const result = runBgrun(["--stop", legacy]);
    upsertProcessStatus({
      name: legacy,
      kind: "stream",
      status: result.exitCode === 0 ? "legacy-stopped" : "legacy-stop-failed",
      data: { replacement: name, stdout: result.stdout, stderr: result.stderr },
      error: result.exitCode === 0 ? null : result.stderr || result.stdout,
    });
  }
}

function stopAllLegacyWorkers(): void {
  for (const legacy of LEGACY_WORKERS) {
    const row = bgrunRowByName(legacy);
    if (!row) continue;
    const result = runBgrun(["--stop", legacy]);
    upsertProcessStatus({
      name: legacy,
      kind: "stream",
      status: result.exitCode === 0 ? "legacy-stopped" : "legacy-stop-failed",
      data: { stdout: result.stdout, stderr: result.stderr },
      error: result.exitCode === 0 ? null : result.stderr || result.stdout,
    });
  }
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
      stopLegacyWorkersFor(name);
      clearWorkerErrors([...LEGACY_WORKERS, name]);
      const exists = !!bgrunRowByName(name);
      const runtime = listWorkerRuntimeStatus({
        source: name.includes("helius")
          ? "helius"
          : name.includes("pumpportal")
            ? "pumpportal"
            : "both",
        telegram: name.includes("telegram"),
      }).find((row) => row.name === name);
      const buildMismatch = runtime?.buildMismatch === true;
      const shouldStart = restart || buildMismatch || !exists;
      if ((restart || buildMismatch) && exists) {
        runBgrun(["--stop", name]);
        await Bun.sleep(250);
      }
      if (shouldStart) {
        const result = runBgrun([
          "--name",
          name,
          "--command",
          spec.command,
          "--directory",
          ROOT,
          "--force",
        ]);
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
        data: {
          command: spec.command,
          restart,
          buildMismatch,
          buildId: spec.buildId,
          supervisor: "bgrun",
        },
      });
      return {
        name,
        kind: spec.kind,
        running: true,
        restarted: restart || buildMismatch,
        buildMismatch,
        buildId: spec.buildId,
        command: spec.command,
      };
    },
  );
}

export async function ensureWorkerGroup(
  args: {
    telegram?: boolean;
    restart?: boolean;
    restartStale?: boolean;
    source?: string | null;
  } = {},
): Promise<Record<string, unknown>> {
  return await processMeasure.measure(
    {
      start: () => "ensure worker group",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    async () => {
      if (args.restart === true) stopAllLegacyWorkers();
      const before = listWorkerRuntimeStatus({
        telegram: args.telegram,
        source: args.source,
      });
      const results = [];
      for (const status of before) {
        const restart =
          args.restart === true ||
          (args.restartStale === true && status.stale && status.managed);
        results.push(await ensureBgrunWorker(status.name, restart));
        await Bun.sleep(350);
      }
      const after = listWorkerRuntimeStatus({
        telegram: args.telegram,
        source: args.source,
      });
      return {
        ready: after.every(
          (row) => row.managed && !row.error && !row.buildMismatch,
        ),
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
  input: { telegram?: boolean; source?: string | null } = {},
): Record<string, unknown> {
  const workers = resolveWorkerNames({
    telegram: input.telegram,
    source: input.source,
  });
  const stopped = workers.map((name) => stopBgrunWorker(name));
  stopAllLegacyWorkers();
  return { workers: stopped, legacyStopped: LEGACY_WORKERS };
}
