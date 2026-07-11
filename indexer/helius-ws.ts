import type { TerminalDatabase } from "../shared/terminal-db.js";
import {
  recordWorkerError,
  upsertProcessStatus,
} from "../shared/terminal-repo.js";
import { applyIndexedEvents } from "./apply.js";
import type { IndexerConfig } from "./config.js";
import { redactedUrl } from "./config.js";
import { indexerMeasure, summarizeError, summarizeValue } from "./measure.js";
import { parsePumpLogs } from "./pump-events.js";
import { refreshSolUsd } from "./sol-usd.js";
import type { Counters, LogJob } from "./types.js";

type Notification = {
  params?: {
    result?: {
      context?: { slot?: number };
      value?: {
        signature?: string;
        err?: unknown;
        logs?: string[];
      };
    };
  };
};

function notification(raw: string, receivedAtMs: number): LogJob | null {
  const message = JSON.parse(raw) as Notification;
  const value = message.params?.result?.value;

  if (!value?.signature || !Array.isArray(value.logs) || value.err) {
    return null;
  }

  return {
    signature: value.signature,
    slot: Number(message.params?.result?.context?.slot ?? 0),
    logs: value.logs,
    receivedAtMs,
  };
}

export async function runHeliusWsSession(input: {
  db: TerminalDatabase;
  config: IndexerConfig;
  counters: Counters;
  attempt: number;
  signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  return await indexerMeasure.measure(
    {
      start: () => `helius ws session attempt=${input.attempt}`,
      end: summarizeValue,
      catch: summarizeError,
    },
    async () => {
      input.counters.sessions++;

      const socket = new WebSocket(input.config.wsUrl);
      let subscribed = false;
      let openedAtMs = Date.now();
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const close = () => {
        if (heartbeat) clearInterval(heartbeat);
        try {
          socket.close();
        } catch {}
      };

      const abort = () => close();
      input.signal.addEventListener("abort", abort, { once: true });

      try {
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => {
            openedAtMs = Date.now();

            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "logsSubscribe",
                params: [
                  {
                    mentions: [input.config.programId],
                  },
                  {
                    commitment: input.config.commitment,
                  },
                ],
              }),
            );

            heartbeat = setInterval(() => {
              upsertProcessStatus(
                {
                  name: input.config.name,
                  kind: "indexer",
                  status: subscribed ? "ok" : "subscribing",
                  buildId: input.config.buildId,
                  data: {
                    source: "helius",
                    url: redactedUrl(input.config.wsUrl),
                    attempt: input.attempt,
                    ...input.counters,
                  },
                },
                input.db,
              );
            }, input.config.heartbeatMs);
          });

          socket.addEventListener("message", (message) => {
            void (async () => {
              const raw = String(message.data);

              if (raw.includes('"result"') && raw.includes('"id":1')) {
                subscribed = true;
                return;
              }

              const job = notification(raw, Date.now());
              if (!job) return;

              input.counters.messages++;

              await indexerMeasure.measure(
                {
                  start: () =>
                    `log:${job.signature.slice(0, 8)} slot=${job.slot}`,
                  end: summarizeValue,
                  catch: summarizeError,
                },
                async () => {
                  const sol = await refreshSolUsd({
                    fallback: input.config.solUsd,
                    maxAgeMs: input.config.solUsdRefreshMs,
                    timeoutMs: 2_000,
                  }).catch(() => ({
                    value: input.config.solUsd,
                  }));

                  input.counters.solUsd = sol.value ?? null;
                  input.counters.solUsdAtMs = Date.now();

                  const events = parsePumpLogs(job, {
                    solUsd: input.counters.solUsd,
                    tokenDecimals: input.config.tokenDecimals,
                    pumpSupplyUi: input.config.pumpSupplyUi,
                  });

                  const applied = applyIndexedEvents(input.db, events, {
                    signature: job.signature,
                    supplyUi: input.config.pumpSupplyUi,
                    config: input.config,
                    counters: input.counters,
                  });

                  upsertProcessStatus(
                    {
                      name: input.config.name,
                      kind: "indexer",
                      status: "ok",
                      buildId: input.config.buildId,
                      data: {
                        source: "helius",
                        phase: "message",
                        eventCount: events.length,
                        applied: applied.applied,
                        duplicate: applied.duplicate,
                        ...input.counters,
                      },
                    },
                    input.db,
                  );

                  return {
                    signature: job.signature,
                    events: events.length,
                    ...applied,
                  };
                },
              );
            })().catch((error) => {
              input.counters.errors++;
              recordWorkerError(
                input.config.name,
                error,
                { phase: "message" },
                input.db,
              );
            });
          });

          socket.addEventListener("close", () => {
            close();
            resolve();
          });

          socket.addEventListener("error", () => {
            const error = new Error("Helius websocket error");
            recordWorkerError(
              input.config.name,
              error,
              {
                attempt: input.attempt,
                url: redactedUrl(input.config.wsUrl),
              },
              input.db,
            );
            close();
            reject(error);
          });
        });
      } finally {
        input.signal.removeEventListener("abort", abort);
        close();
      }

      return {
        subscribed,
        uptimeMs: Date.now() - openedAtMs,
        ...input.counters,
      };
    },
  );
}
