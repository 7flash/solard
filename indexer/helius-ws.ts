import type { Database } from "bun:sqlite";
import { applyIndexedEvents } from "./apply.js";
import { recordWorkerError, upsertProcessStatus } from "./db.js";
import { indexerMeasure, summarizeError, summarizeValue } from "./measure.js";
import { parsePumpLogs } from "./pump-events.js";
import type { Counters, LogJob } from "./types.js";
import type { IndexerConfig } from "./config.js";
import { redactedUrl } from "./config.js";
type HeliusLogsNotification = {
  jsonrpc?: string;
  method?: string;
  params?: {
    result?: {
      context?: { slot?: number };
      value?: { signature?: string; err?: unknown; logs?: string[] };
    };
  };
};
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function parseNotification(raw: string, receivedAtMs: number): LogJob | null {
  const msg = JSON.parse(raw) as HeliusLogsNotification;
  const value = msg.params?.result?.value;
  if (!value?.signature || !Array.isArray(value.logs)) return null;
  if (value.err) return null;
  return {
    signature: value.signature,
    slot: Number(msg.params?.result?.context?.slot ?? 0),
    logs: value.logs,
    receivedAtMs,
  };
}
function socketClosed(ws: WebSocket): boolean {
  return (
    ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING
  );
}
export async function runHeliusWsSession(args: {
  db: Database;
  config: IndexerConfig;
  counters: Counters;
  attempt: number;
  signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  const { db, config, counters, attempt, signal } = args;
  return await indexerMeasure.measure(
    {
      start: () => `helius ws session attempt=${attempt}`,
      end: summarizeValue,
      catch: summarizeError,
    },
    async () => {
      counters.sessions++;
      const ws = new WebSocket(config.wsUrl);
      let subscribed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let openedAtMs = Date.now();
      const close = () => {
        if (heartbeat) clearInterval(heartbeat);
        try {
          if (!socketClosed(ws)) ws.close();
        } catch {}
      };
      const onAbort = () => close();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await new Promise<void>((resolve, reject) => {
          ws.addEventListener("open", () => {
            openedAtMs = Date.now();
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "logsSubscribe",
                params: [
                  { mentions: [config.programId] },
                  { commitment: config.commitment },
                ],
              }),
            );
            heartbeat = setInterval(() => {
              upsertProcessStatus(db, {
                name: config.name,
                kind: "indexer",
                status: subscribed ? "ok" : "subscribing",
                buildId: config.buildId,
                data: {
                  source: "helius",
                  mode: "logsSubscribe",
                  url: redactedUrl(config.wsUrl),
                  programId: config.programId,
                  commitment: config.commitment,
                  attempt,
                  ...counters,
                },
              });
            }, config.heartbeatMs);
            upsertProcessStatus(db, {
              name: config.name,
              kind: "indexer",
              status: "subscribing",
              buildId: config.buildId,
              data: {
                source: "helius",
                mode: "logsSubscribe",
                url: redactedUrl(config.wsUrl),
                programId: config.programId,
                commitment: config.commitment,
                attempt,
              },
            });
          });
          ws.addEventListener("message", (event) => {
            void (async () => {
              const raw = String(event.data);
              const now = Date.now();
              if (raw.includes('"result"') && raw.includes('"id":1')) {
                subscribed = true;
                upsertProcessStatus(db, {
                  name: config.name,
                  kind: "indexer",
                  status: "ok",
                  buildId: config.buildId,
                  data: {
                    source: "helius",
                    phase: "subscribed",
                    programId: config.programId,
                    commitment: config.commitment,
                    attempt,
                  },
                });
                return;
              }
              const job = parseNotification(raw, now);
              if (!job) return;
              counters.messages++;
              await indexerMeasure.measure(
                {
                  start: () =>
                    `log:${job.signature.slice(0, 8)} slot=${job.slot}`,
                  end: summarizeValue,
                  catch: (error) => {
                    counters.errors++;
                    recordWorkerError(db, config.name, error, {
                      phase: "log-job",
                      signature: job.signature,
                      slot: job.slot,
                    });
                    return summarizeError(error);
                  },
                },
                async () => {
                  const events = parsePumpLogs(job, {
                    solUsd: config.solUsd,
                    tokenDecimals: config.tokenDecimals,
                    pumpSupplyUi: config.pumpSupplyUi,
                  });
                  const applied = applyIndexedEvents(db, events, {
                    signature: job.signature,
                    supplyUi: config.pumpSupplyUi,
                    counters,
                  });
                  upsertProcessStatus(db, {
                    name: config.name,
                    kind: "indexer",
                    status: "ok",
                    buildId: config.buildId,
                    data: {
                      source: "helius",
                      phase: "message",
                      eventCount: events.length,
                      applied: applied.applied,
                      duplicate: applied.duplicate,
                      programId: config.programId,
                      commitment: config.commitment,
                      attempt,
                      ...counters,
                    },
                  });
                  return {
                    signature: job.signature,
                    slot: job.slot,
                    eventCount: events.length,
                    applied: applied.applied,
                    duplicate: applied.duplicate,
                    mints: events.map((item) => item.mint),
                  };
                },
              );
            })().catch((error) => {
              counters.errors++;
              recordWorkerError(db, config.name, error, { phase: "message" });
            });
          });
          ws.addEventListener("close", () => {
            close();
            resolve();
          });
          ws.addEventListener("error", () => {
            const error = new Error("Helius websocket error");
            recordWorkerError(db, config.name, error, {
              url: redactedUrl(config.wsUrl),
              attempt,
            });
            upsertProcessStatus(db, {
              name: config.name,
              kind: "indexer",
              status: "error",
              buildId: config.buildId,
              error,
              data: { source: "helius", mode: "logsSubscribe", attempt },
            });
            close();
            reject(error);
          });
        });
      } finally {
        signal.removeEventListener("abort", onAbort);
        close();
      }
      await sleep(0);
      return { uptimeMs: Date.now() - openedAtMs, subscribed, ...counters };
    },
  );
}
