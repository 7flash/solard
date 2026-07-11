import bgrun from "bgrun";
import { listProcessStatus, type ProcessStatus } from "../../shared/db.js";

export type RuntimeProcess = {
  name: string;
  label: string;
  kind: "supervisor" | "server" | "indexer";

  pid: number;
  command: string | null;
  managed: boolean;

  alive: boolean;
  stale: boolean;
  hasError: boolean;
  buildMismatch: boolean;
  healthy: boolean;

  status: string;
  heartbeatAtMs: number | null;
  ageMs: number | null;

  expectedBuildId: string | null;
  actualBuildId: string | null;

  error: string | null;
  data: Record<string, unknown>;
};

const SPECS = {
  solard: {
    label: "Solard supervisor",
    kind: "supervisor" as const,
    staleAfterMs: null,
    expectedBuildId: null,
    aliases: [] as string[],
  },

  "solard-server-worker": {
    label: "Web server",
    kind: "server" as const,
    staleAfterMs: Number(process.env.SOLARD_SERVER_STALE_MS ?? "10000"),
    expectedBuildId: "solard-server-v1",
    aliases: [] as string[],
  },

  "solard-helius-logs-v1": {
    label: "Helius indexer",
    kind: "indexer" as const,
    staleAfterMs: Number(process.env.SOLARD_HELIUS_LOGS_STALE_MS ?? "15000"),
    expectedBuildId: "indexer-v17-runtime-health",
    aliases: ["solard-indexer-helius"],
  },
};

type RuntimeName = keyof typeof SPECS;

function parseData(row: ProcessStatus | null): Record<string, unknown> {
  if (!row?.dataJson) {
    return {};
  }

  try {
    const value = JSON.parse(row.dataJson);

    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function statusRow(
  rows: ProcessStatus[],
  name: RuntimeName,
): ProcessStatus | null {
  const spec = SPECS[name];

  for (const candidate of [name, ...spec.aliases]) {
    const row = rows.find((value) => value.name === candidate);

    if (row) {
      return row;
    }
  }

  return null;
}

async function bgrunState(name: RuntimeName): Promise<{
  alive: boolean;
  managed: boolean;
  pid: number;
  command: string | null;
}> {
  const processInfo = bgrun.getProcess(name);

  const pid = Number(processInfo?.pid ?? 0);

  const command = String(processInfo?.command ?? "") || null;

  if (!processInfo || pid <= 0) {
    return {
      alive: false,
      managed: false,
      pid: 0,
      command: null,
    };
  }

  return {
    alive: await bgrun.isProcessRunning(pid, command ?? "").catch(() => false),

    managed: true,

    pid,

    command,
  };
}

async function runtimeProcess(
  rows: ProcessStatus[],
  name: RuntimeName,
): Promise<RuntimeProcess> {
  const spec = SPECS[name];

  const process = await bgrunState(name);

  const status = statusRow(rows, name);

  const data = parseData(status);

  const heartbeatAtMs = Number(status?.heartbeatAtMs ?? 0) || null;

  const ageMs =
    heartbeatAtMs == null ? null : Math.max(0, Date.now() - heartbeatAtMs);

  const stale =
    spec.staleAfterMs == null
      ? !process.alive
      : ageMs == null || ageMs > spec.staleAfterMs;

  const actualBuildId = String(status?.buildId ?? data.buildId ?? "") || null;

  const buildMismatch = Boolean(
    spec.expectedBuildId &&
    actualBuildId &&
    actualBuildId !== spec.expectedBuildId,
  );

  const error = String(status?.error ?? "").trim() || null;

  const statusText = String(
    status?.status ?? (process.alive ? "running" : "missing"),
  );

  const hasError =
    Boolean(error) ||
    ["error", "fatal", "failed", "crashed"].some((word) =>
      statusText.toLowerCase().includes(word),
    );

  const healthy = process.alive && !stale && !hasError && !buildMismatch;

  return {
    name,
    label: spec.label,
    kind: spec.kind,

    pid: process.pid,
    command: process.command,
    managed: process.managed,

    alive: process.alive,
    stale,
    hasError,
    buildMismatch,
    healthy,

    status: statusText,

    heartbeatAtMs,
    ageMs,

    expectedBuildId: spec.expectedBuildId,
    actualBuildId,

    error,
    data,
  };
}

export async function getSolardRuntimeHealth(): Promise<{
  ok: boolean;
  status: "ok" | "degraded" | "down";
  checkedAtMs: number;

  processes: RuntimeProcess[];
  supervisor: RuntimeProcess;
  server: RuntimeProcess;
  indexer: RuntimeProcess;

  indexerProcess: RuntimeProcess;
  indexerData: Record<string, unknown>;
  indexerError: string | null;
}> {
  const rows = listProcessStatus(100);

  const [supervisor, server, indexer] = await Promise.all([
    runtimeProcess(rows, "solard"),

    runtimeProcess(rows, "solard-server-worker"),

    runtimeProcess(rows, "solard-helius-logs-v1"),
  ]);

  const ok = server.healthy && indexer.healthy;

  const status = ok
    ? "ok"
    : server.alive || indexer.alive
      ? "degraded"
      : "down";

  return {
    ok,
    status,
    checkedAtMs: Date.now(),

    processes: [supervisor, server, indexer],

    supervisor,
    server,
    indexer,

    indexerProcess: indexer,

    indexerData: indexer.data,

    indexerError: indexer.error,
  };
}
