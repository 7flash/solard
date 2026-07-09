import {
  dbWrite,
  insertTerminalTrade,
  recomputeTerminalIndicators,
  upsertProcessStatus,
  upsertTerminalToken,
} from "../db/terminal-store.js";
import { recordWorkerError } from "../db/terminal-ingestion.js";
import {
  fetchHeliusAssetMetadata,
  fetchUriMetadata,
} from "../helius/token-metadata.js";
import { parsePumpLogs } from "../helius/pump-log-events.js";
import { PUMPFUN_PROGRAM_ID } from "../pump/pump-parser.js";
import {
  BoundedAsyncQueue,
  TtlDeduper,
  compactError,
  shortSignature,
} from "../pump/stream-utils.js";
import { resolveSolUsd } from "../prices/sol-usd.js";
import { workerMeasure, summarizeForMeasure } from "../measure.js";

const WORKER = "solard-helius-logs-v1";
const BUILD_ID = "helius-logs-v1-standard-logs-subscribe";
const COMMITMENT = (process.env.SOLARD_HELIUS_LOGS_COMMITMENT ??
  process.env.SOLARD_HELIUS_COMMITMENT ??
  "processed") as "processed" | "confirmed" | "finalized";
const CONCURRENCY = Math.max(
  1,
  Math.min(32, Number(process.env.SOLARD_HELIUS_LOGS_CONCURRENCY ?? "8")),
);
const MAX_QUEUED = Math.max(
  100,
  Number(process.env.SOLARD_HELIUS_LOGS_MAX_QUEUED ?? "5000"),
);
const DEDUPE_TTL_MS = Math.max(
  10_000,
  Number(process.env.SOLARD_HELIUS_LOGS_DEDUPE_TTL_MS ?? "120000"),
);

let running = true;

function apiKeyFromUrl(url: string | null | undefined): string | null {
  const match = String(url ?? "").match(/[?&](?:api-key|apiKey)=([^&]+)/i);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function heliusWsUrl(): string {
  const explicit =
    process.env.SOLARD_HELIUS_LOGS_WS_URL?.trim() ||
    process.env.SOLARD_HELIUS_WS_URL?.trim() ||
    process.env.HELIUS_WS_URL?.trim();
  if (explicit) return explicit;

  const rpc =
    process.env.HELIUS_RPC_URL?.trim() ||
    process.env.RPC_ENDPOINT?.trim() ||
    process.env.SOLANA_RPC_URL?.trim() ||
    "";
  if (/^https:\/\//i.test(rpc) && /helius-rpc\.com/i.test(rpc))
    return rpc.replace(/^https:/i, "wss:");
  if (/^http:\/\//i.test(rpc) && /helius-rpc\.com/i.test(rpc))
    return rpc.replace(/^http:/i, "ws:");

  const key = process.env.HELIUS_API_KEY?.trim() || apiKeyFromUrl(rpc);
  if (key)
    return `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;

  throw new Error(
    "Missing Helius WebSocket config. Set HELIUS_API_KEY, HELIUS_RPC_URL, SOLARD_HELIUS_WS_URL, or HELIUS_WS_URL.",
  );
}

function redactUrl(value: string): string {
  return value.replace(/(api-key|apiKey)=([^&]+)/i, "$1=<redacted>");
}

function json(value: unknown): string {
  return JSON.stringify(value, (_, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function eventData(event: any): string {
  const data = event?.data;
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data))
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return String(data ?? "");
}

function confidence(): "processed" | "confirmed" | "finalized" | "dropped" {
  return COMMITMENT === "finalized"
    ? "finalized"
    : COMMITMENT === "confirmed"
      ? "confirmed"
      : "processed";
}

type LogJob = {
  signature: string;
  slot: number;
  logs: string[];
  receivedAtMs: number;
};

type Counters = {
  received: number;
  accepted: number;
  duplicates: number;
  malformed: number;
  creates: number;
  trades: number;
  completes: number;
  imaged: number;
  errors: number;
  lastSignature: string | null;
  lastMint: string | null;
  lastMcapUsd: number | null;
  lastMessageAtMs: number;
  lastRaw: Record<string, unknown> | null;
};

async function applyLogJob(job: LogJob, counters: Counters): Promise<void> {
  await workerMeasure
    .measure(
      {
        start: () => `helius logs parse ${shortSignature(job.signature)}`,
        end: (result) => summarizeForMeasure(result),
        catch: (error) => ({ error: compactError(error) }),
      },
      async () => {
        const solUsd = await resolveSolUsd();
        const parsed = parsePumpLogs({
          logs: job.logs,
          signature: job.signature,
          slot: job.slot,
          solUsd,
          now: job.receivedAtMs,
        });

        let imaged = 0;
        for (const create of parsed.creates) {
          const [uriMeta, assetMeta] = await Promise.all([
            fetchUriMetadata(create.uri),
            fetchHeliusAssetMetadata(create.mint),
          ]);
          const merged = { ...assetMeta, ...uriMeta };
          await dbWrite("helius_logs_create", () =>
            upsertTerminalToken({
              mint: create.mint,
              symbol: merged.symbol ?? create.symbol ?? "",
              name: merged.name ?? create.name ?? create.symbol ?? create.mint,
              image: merged.image ?? null,
              uri: create.uri,
              description: merged.description ?? null,
              website: merged.website ?? null,
              twitter: merged.twitter ?? null,
              telegram: merged.telegram ?? null,
              creator: create.creator,
              bondingCurveKey: create.bondingCurveKey,
              source: "helius-logs-create",
              phase: "pump",
              isMayhemMode: create.isMayhemMode === true ? 1 : 0,
              supplyUi: 1_000_000_000,
              lastSlot: create.slot,
              signature: create.signature,
              createdAtMs: job.receivedAtMs,
              updatedAtMs: Date.now(),
            }),
          );
          if (merged.image) imaged++;
          counters.lastMint = create.mint;
        }

        for (const trade of parsed.trades) {
          await dbWrite("helius_logs_trade", () =>
            insertTerminalTrade({
              id: trade.id,
              mint: trade.mint,
              signature: trade.signature,
              slot: trade.slot,
              owner: trade.owner,
              side: trade.side,
              tokenDeltaUi: trade.tokenDeltaUi,
              solDeltaUi: trade.solDeltaUi,
              priceSol: trade.priceSol,
              priceUsd: trade.priceUsd,
              marketCapUsd: trade.marketCapUsd,
              confidence: confidence(),
              source: "helius-logs-trade",
              rawJson: json(trade.raw),
              createdAtMs: trade.createdAtMs,
              updatedAtMs: Date.now(),
            }),
          );
          await dbWrite("helius_logs_trade_token", () =>
            upsertTerminalToken({
              mint: trade.mint,
              source: "helius-logs-trade",
              priceSol: trade.priceSol ?? undefined,
              priceUsd: trade.priceUsd ?? undefined,
              marketCapSol:
                trade.priceSol != null
                  ? trade.priceSol * 1_000_000_000
                  : undefined,
              marketCapUsd: trade.marketCapUsd ?? undefined,
              lastSlot: trade.slot,
              signature: trade.signature,
              updatedAtMs: Date.now(),
            }),
          );
          await dbWrite("helius_logs_indicators", () =>
            recomputeTerminalIndicators(trade.mint),
          );
          counters.lastMint = trade.mint;
          counters.lastMcapUsd = trade.marketCapUsd ?? counters.lastMcapUsd;
        }

        for (const complete of parsed.completes) {
          await dbWrite("helius_logs_complete", () =>
            upsertTerminalToken({
              mint: complete.mint,
              source: "helius-logs-complete",
              phase: "migrated",
              lastSlot: complete.slot,
              signature: complete.signature,
              updatedAtMs: Date.now(),
            }),
          );
        }

        counters.creates += parsed.creates.length;
        counters.trades += parsed.trades.length;
        counters.completes += parsed.completes.length;
        counters.imaged += imaged;
        return {
          signature: shortSignature(job.signature),
          rawProgramData: parsed.rawProgramData,
          creates: parsed.creates.length,
          trades: parsed.trades.length,
          completes: parsed.completes.length,
          imaged,
          solUsd,
        };
      },
    )
    .catch((error) => {
      counters.errors++;
      recordWorkerError(WORKER, error, {
        signature: job.signature,
        slot: job.slot,
      });
    });
}

async function runSession(attempt: number): Promise<void> {
  const url = heliusWsUrl();
  const redacted = redactUrl(url);
  const dedupe = new TtlDeduper(DEDUPE_TTL_MS);
  const counters: Counters = {
    received: 0,
    accepted: 0,
    duplicates: 0,
    malformed: 0,
    creates: 0,
    trades: 0,
    completes: 0,
    imaged: 0,
    errors: 0,
    lastSignature: null,
    lastMint: null,
    lastMcapUsd: null,
    lastMessageAtMs: 0,
    lastRaw: null,
  };
  const queue = new BoundedAsyncQueue<LogJob>(
    (job) => applyLogJob(job, counters),
    {
      concurrency: CONCURRENCY,
      maxQueued: MAX_QUEUED,
    },
  );

  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor)
    throw new Error("globalThis.WebSocket is unavailable in this Bun runtime");
  const ws = new WebSocketCtor(url);
  let subscribed = false;
  let subscriptionId: unknown = null;

  const heartbeat = () => {
    upsertProcessStatus({
      name: WORKER,
      kind: "stream",
      status: subscribed ? "ok" : "connecting",
      data: {
        source: "helius",
        buildId: BUILD_ID,
        mode: "logsSubscribe",
        transport: "helius-standard-websocket",
        url: redacted,
        commitment: COMMITMENT,
        programId: PUMPFUN_PROGRAM_ID,
        attempt,
        subscribed,
        subscriptionId,
        ...counters,
        lastMessageAgeMs: counters.lastMessageAtMs
          ? Date.now() - counters.lastMessageAtMs
          : null,
        dedupeSize: dedupe.size(),
        queue: queue.stats(),
      },
      error: counters.errors ? `${counters.errors} parser/write errors` : null,
    });
  };
  const pulse = setInterval(heartbeat, 1_000);

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => {
      const req = {
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [
          { mentions: [PUMPFUN_PROGRAM_ID] },
          { commitment: COMMITMENT },
        ],
      };
      ws.send(JSON.stringify(req));
      subscribed = true;
      heartbeat();
    });

    ws.addEventListener("message", (event: any) => {
      counters.received++;
      counters.lastMessageAtMs = Date.now();
      const raw = eventData(event);
      try {
        const data = JSON.parse(raw);
        counters.lastRaw = {
          method: data?.method ?? null,
          id: data?.id ?? null,
          hasParams: !!data?.params,
          bytes: raw.length,
        };
        if (data?.id === 1 && data?.result != null) {
          subscriptionId = data.result;
          heartbeat();
          return;
        }
        if (data?.method !== "logsNotification") {
          heartbeat();
          return;
        }
        const value = data?.params?.result?.value ?? {};
        if (value?.err) {
          heartbeat();
          return;
        }
        const signature = String(value?.signature ?? "");
        const logs = Array.isArray(value?.logs) ? value.logs.map(String) : [];
        const slot = Number(data?.params?.result?.context?.slot ?? 0);
        if (!signature || logs.length === 0) {
          counters.malformed++;
          heartbeat();
          return;
        }
        counters.lastSignature = signature;
        if (!dedupe.add(signature)) {
          counters.duplicates++;
          heartbeat();
          return;
        }
        if (queue.push({ signature, logs, slot, receivedAtMs: Date.now() }))
          counters.accepted++;
        heartbeat();
      } catch (error) {
        counters.malformed++;
        counters.errors++;
        recordWorkerError(WORKER, error, {
          phase: "message",
          raw: raw.slice(0, 500),
        });
        heartbeat();
      }
    });

    ws.addEventListener("close", () => {
      clearInterval(pulse);
      heartbeat();
      resolve();
    });

    ws.addEventListener("error", (event: any) => {
      const error = new Error(
        String(event?.message ?? "Helius logs WebSocket error"),
      );
      recordWorkerError(WORKER, error, { phase: "websocket", url: redacted });
      upsertProcessStatus({
        name: WORKER,
        kind: "stream",
        status: "error",
        error,
        data: {
          source: "helius",
          buildId: BUILD_ID,
          mode: "logsSubscribe",
          url: redacted,
        },
      });
      clearInterval(pulse);
      reject(error);
    });
  }).finally(() => {
    clearInterval(pulse);
    try {
      ws.close();
    } catch {}
  });
}

async function main(): Promise<void> {
  let attempt = 0;
  while (running) {
    attempt++;
    await workerMeasure.measure(
      {
        start: () => "helius logs session",
        end: (result) => summarizeForMeasure(result),
        catch: (error) => {
          recordWorkerError(WORKER, error, { attempt });
          upsertProcessStatus({
            name: WORKER,
            kind: "stream",
            status: "error",
            error,
            data: { source: "helius", buildId: BUILD_ID, attempt },
          });
          return { error: compactError(error) };
        },
      },
      () => runSession(attempt),
    );
    const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
    upsertProcessStatus({
      name: WORKER,
      kind: "stream",
      status: "reconnecting",
      data: { source: "helius", buildId: BUILD_ID, attempt, delay },
    });
    await Bun.sleep(delay);
  }
}

function stop(reason: string): void {
  running = false;
  upsertProcessStatus({
    name: WORKER,
    kind: "stream",
    status: "stopped",
    data: { source: "helius", reason, buildId: BUILD_ID },
  });
  process.exit(0);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

main().catch((error) => {
  recordWorkerError(WORKER, error, { phase: "fatal" });
  upsertProcessStatus({
    name: WORKER,
    kind: "stream",
    status: "fatal",
    error,
    data: { source: "helius", buildId: BUILD_ID },
  });
  throw error;
});
