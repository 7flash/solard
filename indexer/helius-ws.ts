import { recordWorkerError, upsertProcessStatus } from "../shared/db.js";
import { applyIndexedEvents } from "./apply.js";
import type { IndexerConfig } from "./config.js";
import { redactedUrl } from "./config.js";
import { indexerMeasure, summarizeError, summarizeValue } from "./measure.js";
import { parsePumpLogs } from "./pump-events.js";
import { refreshSolUsd } from "./sol-usd.js";
import type { Counters, LogJob } from "./types.js";

type HeliusNotification = {
  params?: {
    result?: {
      context?: {
        slot?: number;
      };

      value?: {
        signature?: string;
        err?: unknown;
        logs?: string[];
      };
    };
  };
};

function parseNotification(raw: string, receivedAtMs: number): LogJob | null {
  const message = JSON.parse(raw) as HeliusNotification;

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

function statusData(
  config: IndexerConfig,
  counters: Counters,
  attempt: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    source: "helius",

    mode: "logsSubscribe",

    url: redactedUrl(config.wsUrl),

    programId: config.programId,

    programIdSource: config.programIdSource,

    programIdCorrected: config.programIdCorrected,

    commitment: config.commitment,

    attempt,

    ...counters,

    ...extra,
  };
}

export async function runHeliusWsSession(input: {
  config: IndexerConfig;
  counters: Counters;
  attempt: number;
  signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  const { config, counters, attempt, signal } = input;

  return await indexerMeasure.measure(
    {
      start: () => `helius ws session attempt=${attempt}`,

      end: summarizeValue,

      catch: summarizeError,
    },
    async () => {
      counters.sessions++;

      const socket = new WebSocket(config.wsUrl);

      let subscribed = false;

      let heartbeat: ReturnType<typeof setInterval> | null = null;

      let messageQueue: Promise<void> = Promise.resolve();

      const openedAtMs = Date.now();

      const close = () => {
        if (heartbeat) {
          clearInterval(heartbeat);
        }

        try {
          socket.close();
        } catch {}
      };

      const abort = () => close();

      signal.addEventListener("abort", abort, {
        once: true,
      });

      try {
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => {
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",

                id: 1,

                method: "logsSubscribe",

                params: [
                  {
                    mentions: [config.programId],
                  },

                  {
                    commitment: config.commitment,
                  },
                ],
              }),
            );

            upsertProcessStatus({
              name: config.name,

              kind: "indexer",

              status: "subscribing",

              buildId: config.buildId,

              dataJson: JSON.stringify(statusData(config, counters, attempt)),

              updatedAtMs: Date.now(),
            });

            heartbeat = setInterval(() => {
              upsertProcessStatus({
                name: config.name,

                kind: "indexer",

                status: subscribed ? "ok" : "subscribing",

                buildId: config.buildId,

                dataJson: JSON.stringify(statusData(config, counters, attempt)),

                updatedAtMs: Date.now(),
              });
            }, config.heartbeatMs);
          });

          socket.addEventListener("message", (message) => {
            const raw = String(message.data);

            if (raw.includes('"result"') && raw.includes('"id":1')) {
              subscribed = true;
              return;
            }

            messageQueue = messageQueue
              .then(async () => {
                const job = parseNotification(raw, Date.now());

                if (!job) {
                  return;
                }

                counters.messages++;

                await indexerMeasure.measure(
                  {
                    start: () =>
                      `log:${job.signature.slice(0, 8)} slot=${job.slot}`,

                    end: summarizeValue,

                    catch: summarizeError,
                  },
                  async () => {
                    const sol = await refreshSolUsd({
                      fallback: config.solUsd,

                      maxAgeMs: config.solUsdRefreshMs,

                      timeoutMs: 2_000,
                    }).catch(() => ({
                      value: config.solUsd,
                    }));

                    counters.solUsd = sol.value ?? null;

                    counters.solUsdAtMs = Date.now();

                    const parsed = parsePumpLogs(job, {
                      solUsd: counters.solUsd,

                      tokenDecimals: config.tokenDecimals,

                      pumpSupplyUi: config.pumpSupplyUi,

                      programId: config.programId,
                    });

                    counters.programDataLines +=
                      parsed.diagnostics.programDataLines;

                    counters.recognizedEventLines +=
                      parsed.diagnostics.recognizedEventLines;

                    counters.unknownEventLines +=
                      parsed.diagnostics.unknownEventLines;

                    counters.eventParseErrors += parsed.diagnostics.parseErrors;

                    counters.lastUnknownDiscriminator =
                      parsed.diagnostics.lastUnknownDiscriminator ??
                      counters.lastUnknownDiscriminator;

                    counters.lastProgramDataLength =
                      parsed.diagnostics.lastProgramDataLength ??
                      counters.lastProgramDataLength;

                    counters.parsedCreates += parsed.events.filter(
                      (event) => event.kind === "create",
                    ).length;

                    counters.parsedTrades += parsed.events.filter(
                      (event) => event.kind === "trade",
                    ).length;

                    counters.parsedCompletes += parsed.events.filter(
                      (event) => event.kind === "complete",
                    ).length;

                    const applied = await applyIndexedEvents(parsed.events, {
                      config,
                      counters,
                    });

                    upsertProcessStatus({
                      name: config.name,

                      kind: "indexer",

                      status: "ok",

                      buildId: config.buildId,

                      dataJson: JSON.stringify(
                        statusData(config, counters, attempt, {
                          phase: "message",

                          eventCount: parsed.events.length,

                          applied: applied.applied,

                          duplicateTrades: applied.duplicateTrades,
                        }),
                      ),

                      updatedAtMs: Date.now(),
                    });

                    return {
                      signature: job.signature,

                      slot: job.slot,

                      eventCount: parsed.events.length,

                      ...applied,

                      mints: parsed.events.map((event) => event.mint),
                    };
                  },
                );
              })
              .catch((error) => {
                counters.errors++;

                recordWorkerError(config.name, error, {
                  phase: "message",
                });
              });
          });

          socket.addEventListener("close", () => {
            void messageQueue.finally(resolve);
          });

          socket.addEventListener("error", () => {
            const error = new Error("Helius websocket error");

            recordWorkerError(config.name, error, {
              attempt,

              url: redactedUrl(config.wsUrl),
            });

            close();
            reject(error);
          });
        });
      } finally {
        signal.removeEventListener("abort", abort);

        close();
      }

      return {
        subscribed,

        uptimeMs: Date.now() - openedAtMs,

        ...counters,
      };
    },
  );
}
