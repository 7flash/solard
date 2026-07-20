import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { measureSolard, summarizeForMeasure } from "../api-response.ts";

export type PumpStreamSource = "helius" | "pumpportal";

export type PumpStreamProcessStatus = {
  status: "idle" | "starting" | "running" | "exited" | "error";
  source: PumpStreamSource;
  pid: number | null;
  startedAtMs: number | null;
  exitedAtMs: number | null;
  restartCount: number;
  lastExitCode: number | null;
  lastSignal: string | null;
  lastError: string | null;
  lastMessageAtMs: number | null;
  lastMessage: unknown;
};

let child: ChildProcessWithoutNullStreams | null = null;
let restarting = false;
let intentionalStop = false;
let status: PumpStreamProcessStatus = {
  status: "idle",
  source: "helius",
  pid: null,
  startedAtMs: null,
  exitedAtMs: null,
  restartCount: 0,
  lastExitCode: null,
  lastSignal: null,
  lastError: null,
  lastMessageAtMs: null,
  lastMessage: null,
};

function bool(value: unknown, fallback: boolean): boolean {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["0", "false", "no"].includes(text)) return false;
  if (["1", "true", "yes"].includes(text)) return true;
  return fallback;
}

function workerPath(): string {
  return resolve(process.cwd(), "src/solard/workers/pump-stream-worker.ts");
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
}

function wireOutput(
  stream: NodeJS.ReadableStream,
  kind: "stdout" | "stderr",
): void {
  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const parsed = parseJsonLine(line);
      status.lastMessage = parsed;
      status.lastMessageAtMs = Date.now();
      if (kind === "stderr") status.lastError = line;
      if (process.env.SOLARD_PUMP_STREAM_PROCESS_LOG === "1") {
        process.stderr.write(`[pump-stream:${kind}] ${line}\n`);
      }
    }
  });
}

function spawnWorker(args: {
  source: PumpStreamSource;
  resetSession: boolean;
}): void {
  intentionalStop = false;
  const bun = process.execPath || "bun";
  status = {
    ...status,
    status: "starting",
    source: args.source,
    pid: null,
    startedAtMs: Date.now(),
    exitedAtMs: null,
    lastExitCode: null,
    lastSignal: null,
    lastError: null,
  };
  child = spawn(bun, ["run", workerPath()], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SOLARD_PUMP_STREAM_WORKER: "1",
      SOLARD_PUMP_STREAM_SOURCE: args.source,
      SOLARD_PUMP_STREAM_RESET_SESSION: args.resetSession ? "1" : "0",
      SOLARD_MEASURE_QUIET: process.env.SOLARD_MEASURE_QUIET ?? "1",
      SOLWAL_MEASURE_QUIET: process.env.SOLWAL_MEASURE_QUIET ?? "1",
      SOLARD_MEASURE_UI: "0",
      SOLWAL_MEASURE_UI: "0",
    },
  });
  status.status = "running";
  status.pid = child.pid ?? null;
  wireOutput(child.stdout, "stdout");
  wireOutput(child.stderr, "stderr");
  child.on("error", (error) => {
    status.status = "error";
    status.lastError = error.message;
  });
  child.on("exit", (code, signal) => {
    status.status = "exited";
    status.pid = null;
    status.exitedAtMs = Date.now();
    status.lastExitCode = code;
    status.lastSignal = signal;
    child = null;
    if (
      !intentionalStop &&
      bool(process.env.SOLARD_PUMP_STREAM_AUTORESTART, true) &&
      !restarting
    ) {
      const backoffMs = Math.min(30_000, 1_000 + status.restartCount * 1_000);
      restarting = true;
      setTimeout(() => {
        restarting = false;
        status.restartCount += 1;
        spawnWorker({ source: status.source, resetSession: false });
      }, backoffMs).unref?.();
    }
  });
}

export async function ensurePumpStreamProcess(
  args: {
    source?: string | null;
    resetSession?: boolean | string | null;
  } = {},
): Promise<PumpStreamProcessStatus> {
  const source: PumpStreamSource =
    args.source === "pumpportal" ? "pumpportal" : "helius";
  const resetSession = bool(args.resetSession, true);
  const measured = await measureSolard(
    "solard:process:pump-stream",
    "ensurePumpStreamProcess",
    () => {
      if (child && !child.killed && status.status === "running") {
        if (source !== status.source) {
          stopPumpStreamProcess();
          status.restartCount += 1;
          spawnWorker({ source, resetSession });
        }
        return status;
      }
      spawnWorker({ source, resetSession });
      return status;
    },
    {
      result: summarizeForMeasure,
      onError: summarizeForMeasure,
      meta: { source, resetSession },
    },
  );
  return measured.value;
}

export function stopPumpStreamProcess(): PumpStreamProcessStatus {
  intentionalStop = true;
  if (child && !child.killed) {
    try {
      child.kill("SIGTERM");
    } catch (error) {
      status.lastError = error instanceof Error ? error.message : String(error);
    }
  }
  child = null;
  status = {
    ...status,
    status: "idle",
    pid: null,
    exitedAtMs: Date.now(),
  };
  return status;
}

export function getPumpStreamProcessStatus(): PumpStreamProcessStatus {
  return { ...status };
}
