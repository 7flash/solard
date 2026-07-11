import { serve } from "tradjs";
import { upsertProcessStatus } from "../db/terminal-store.js";
import { measureSync, configure } from "measure-fn";

configure({ timestamps: true });
const WORKER_NAME = process.env.SOLARD_WORKER_NAME || "solard-server-worker";
const BUILD_ID = process.env.SOLARD_EXPECTED_BUILD_ID || "solard-server-v1";
const PORT = Number(process.env.SOLARD_PORT || "3000");

let serverHandle: {
  stop?: (closeActiveConnections?: boolean) => unknown;
} | null = null;
let heartbeatTimer: Timer | null = null;

function sendHeartbeat(status: string, error: string | null = null) {
  try {
    upsertProcessStatus({
      name: WORKER_NAME,
      kind: "server",
      status,
      heartbeatAtMs: Date.now(),
      error,
      data: {
        buildId: BUILD_ID,
        port: PORT,
        pid: process.pid,
        supervisor: "bgrun-sdk",
        parent: process.env.BGR_PARENT_NAME || "solard",
      },
    });
  } catch (err) {
    console.error("Failed to push server worker state to database store:", err);
  }
}

// 1. Core HTTP Server Setup & Route Definitions
try {
  serverHandle = (await serve()) as any;

  console.log(
    `[${WORKER_NAME}] Tradjs web server listening natively on port ${PORT}`,
  );
  sendHeartbeat("running");

  // 2. High-Resolution Heartbeat Ping Interval Loop
  heartbeatTimer = setInterval(() => sendHeartbeat("running"), 3000);
} catch (error: any) {
  sendHeartbeat(
    "error",
    error instanceof Error ? error.message : String(error),
  );
  console.error(`Fatal initialization failure on ${WORKER_NAME}:`, error);
  process.exit(1);
}

// 3. Graceful Termination & Cleanup Hooks
const shutdown = async (signal: string) => {
  console.log(
    `[${WORKER_NAME}] Intercepted ${signal}, tearing down server contexts...`,
  );
  if (heartbeatTimer) clearInterval(heartbeatTimer);

  sendHeartbeat("stopped");

  try {
    if (serverHandle?.stop) serverHandle.stop(true);
  } catch (e) {
    console.error(e);
  }
  setTimeout(() => process.exit(0), 50).unref();
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
