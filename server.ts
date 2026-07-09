import { serve } from "tradjs";
import { normalizeStreamSource } from "./src/solard/processes/bgrun.js";
import {
  startServerWorkerSupervisor,
  type ServerWorkerSupervisor,
} from "./src/solard/processes/server-supervisor.js";

const ownsWorkers =
  process.env.SOLARD_SERVER_WORKERS !== "0" &&
  process.env.SOLARD_DISABLE_SERVER_WORKERS !== "1";
const stopWorkersOnExit = process.env.SOLARD_STOP_WORKERS_ON_EXIT !== "0";
const source = normalizeStreamSource(
  process.env.SOLARD_STREAM_SOURCE ?? "helius",
);
const telegram = process.env.SOLARD_TELEGRAM_SIGNALS === "1";

let stopping = false;
let exitCode = 0;
let serverHandle: unknown;
let workerSupervisor: ServerWorkerSupervisor | null = null;

function summarizeError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

function startWorkers(): void {
  if (!ownsWorkers) return;
  try {
    workerSupervisor = startServerWorkerSupervisor({
      source,
      telegram,
      restartOnExit: true,
      stopDetachedBgrun: true,
    });
    console.error(
      `[solard:server] worker supervisor started (${workerSupervisor.names.join(", ")})`,
    );
  } catch (error) {
    console.error(
      "[solard:server] worker supervisor failed",
      summarizeError(error),
    );
  }
}

async function stopWorkers(reason: string): Promise<void> {
  if (!ownsWorkers || !stopWorkersOnExit || stopping) return;
  stopping = true;
  try {
    console.error(`[solard:server] stopping workers (${reason})`);
    await workerSupervisor?.stop(reason);
  } catch (error) {
    console.error(
      "[solard:server] worker shutdown failed",
      summarizeError(error),
    );
  }
}

function stopServerHandle(): void {
  const maybeServer = serverHandle as {
    stop?: (closeActiveConnections?: boolean) => unknown;
  } | null;
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
  startWorkers();
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
