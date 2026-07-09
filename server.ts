import { serve } from "tradjs";
import {
  ensureWorkerGroup,
  normalizeStreamSource,
  stopWorkerGroup,
} from "./src/solard/processes/bgrun.js";

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

function summarizeError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

async function startWorkers(): Promise<void> {
  if (!ownsWorkers) return;
  try {
    await ensureWorkerGroup({ source, telegram, restartStale: true });
  } catch (error) {
    console.error(
      "[solard:server] worker startup failed",
      summarizeError(error),
    );
  }
}

async function stopWorkers(reason: string): Promise<void> {
  if (!ownsWorkers || !stopWorkersOnExit || stopping) return;
  stopping = true;
  try {
    console.error(`[solard:server] stopping workers (${reason})`);
    await stopWorkerGroup({ source: "both", telegram: true });
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

// Do not await worker startup before the web server comes up. bgrun status calls
// can take seconds on Windows, and the UI should load while streams warm up.
const workerStartup = startWorkers();

try {
  serverHandle = await serve();
  await waitForShutdown();
} catch (error) {
  exitCode = 1;
  console.error("[solard:server] fatal", summarizeError(error));
} finally {
  await workerStartup.catch((error) => {
    console.error(
      "[solard:server] worker startup failed",
      summarizeError(error),
    );
  });
  stopServerHandle();
  await stopWorkers(exitCode === 0 ? "shutdown" : "error");
  process.exit(exitCode);
}
