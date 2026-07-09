import { serve } from "tradjs";
import { normalizeStreamSource } from "./src/solard/processes/bgrun.js";
import {
  startBgrunWorkerSupervisor,
  type BgrunWorkerSupervisor,
} from "./src/solard/processes/bgrun-supervisor.js";

const ownsWorkers =
  process.env.SOLARD_SERVER_WORKERS !== "0" &&
  process.env.SOLARD_DISABLE_SERVER_WORKERS !== "1";
const stopWorkersOnExit = process.env.SOLARD_STOP_WORKERS_ON_EXIT !== "0";
const source = normalizeStreamSource(process.env.SOLARD_STREAM_SOURCE ?? "helius");
const telegram = process.env.SOLARD_TELEGRAM_SIGNALS === "1";

let exitCode = 0;
let serverHandle: unknown;
let workerSupervisor: BgrunWorkerSupervisor | null = null;
let stopping = false;

function summarizeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

async function startWorkers(): Promise<void> {
  if (!ownsWorkers) return;
  workerSupervisor = await startBgrunWorkerSupervisor({
    source,
    telegram,
    restart: process.env.SOLARD_RESTART_WORKERS_ON_BOOT === "1",
  });
  console.error(`[solard:server] bgrun-sdk workers ready (${workerSupervisor.names.join(", ")})`);
}

async function stopWorkers(reason: string): Promise<void> {
  if (!ownsWorkers || !stopWorkersOnExit || stopping) return;
  stopping = true;
  console.error(`[solard:server] stopping bgrun-sdk workers (${reason})`);
  try {
    await workerSupervisor?.stop(reason);
  } catch (error) {
    console.error("[solard:server] worker shutdown failed", summarizeError(error));
  }
}

function stopServerHandle(): void {
  const maybeServer = serverHandle as { stop?: (closeActiveConnections?: boolean) => unknown } | null;
  if (!maybeServer || typeof maybeServer.stop !== "function") return;
  try {
    maybeServer.stop(true);
  } catch (error) {
    console.error("[solard:server] web shutdown failed", summarizeError(error));
  }
}

function waitForShutdown(): Promise<string> {
  return new Promise((resolve) => {
    const shutdown = (reason: string, code: number) => {
      exitCode = code;
      resolve(reason);
    };

    process.once("SIGINT", () => shutdown("SIGINT", 130));
    process.once("SIGTERM", () => shutdown("SIGTERM", 143));
  });
}

try {
  await startWorkers();
  serverHandle = await serve();
  await waitForShutdown();
} catch (error) {
  exitCode = 1;
  console.error("[solard:server] fatal", summarizeError(error));
} finally {
  stopServerHandle();
  await stopWorkers(exitCode === 0 ? "shutdown" : "error");
  process.exit(exitCode);
}
