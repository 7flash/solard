#!/usr/bin/env bun
import { isSqliteBusyError, upsertProcessStatus } from "../../../shared/db.js";
import {
  compactId,
  dbMeasure,
  processMeasure,
  summarizeError,
} from "../../../shared/measure.js";

const NAME = "solard-server-worker";

const BUILD_ID = process.env.SOLARD_BUILD_ID ?? process.env.GIT_COMMIT ?? null;

const HEARTBEAT_MS = Math.max(
  1_000,
  Number(process.env.SOLARD_SERVER_HEARTBEAT_MS ?? 5_000),
);

let stopping = false;
let heartbeatInFlight = false;

const STATUS_WRITE_ATTEMPTS = 5;

function statusWriteDelayMs(attempt: number): number {
  return Math.min(500, 20 * 2 ** Math.max(0, attempt - 1));
}

async function sendHeartbeat(
  status = "running",
  error: string | null = null,
): Promise<void> {
  if (heartbeatInFlight) {
    return;
  }

  heartbeatInFlight = true;

  try {
    for (let attempt = 1; attempt <= STATUS_WRITE_ATTEMPTS; attempt++) {
      try {
        dbMeasure.sync(
          {
            start: () =>
              `db.upsert_process_status name=${compactId(NAME)} status=${status}`,

            end: (result: any) => ({
              updated: result != null,

              status: result?.status ?? status,
            }),

            catch: summarizeError,
          },
          () =>
            upsertProcessStatus({
              name: NAME,

              kind: "server",

              status,

              buildId: BUILD_ID,

              error,

              dataJson: JSON.stringify({
                heartbeatMs: HEARTBEAT_MS,

                source: "shared/db.ts",
              }),

              heartbeatAtMs: Date.now(),

              updatedAtMs: Date.now(),
            }),
        );

        return;
      } catch (writeError) {
        if (
          !isSqliteBusyError(writeError) ||
          attempt >= STATUS_WRITE_ATTEMPTS
        ) {
          throw writeError;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, statusWriteDelayMs(attempt)),
        );
      }
    }
  } finally {
    heartbeatInFlight = false;
  }
}

async function stop(signal: string): Promise<void> {
  if (stopping) {
    return;
  }

  stopping = true;

  await sendHeartbeat("stopped", signal).catch(() => undefined);
}

export async function runServerWorker(): Promise<void> {
  await processMeasure.measure(
    {
      start: () => `server_worker.start heartbeatMs=${HEARTBEAT_MS}`,

      end: () => ({
        started: true,
      }),

      catch: summarizeError,
    },
    async () => {
      await sendHeartbeat("starting");

      const timer = setInterval(() => {
        void sendHeartbeat("running").catch((error) => {
          console.error(
            "Failed to push server worker state to shared database:",
            error,
          );
        });
      }, HEARTBEAT_MS);

      process.once("SIGINT", () => {
        clearInterval(timer);

        void stop("SIGINT");
      });

      process.once("SIGTERM", () => {
        clearInterval(timer);

        void stop("SIGTERM");
      });

      await new Promise<void>((resolve) => {
        const wait = setInterval(() => {
          if (stopping) {
            clearInterval(wait);

            resolve();
          }
        }, 250);
      });
    },
  );
}

if (import.meta.main) {
  runServerWorker().catch((error) => {
    console.error("[solard:server-worker] fatal", error);

    process.exitCode = 1;
  });
}
