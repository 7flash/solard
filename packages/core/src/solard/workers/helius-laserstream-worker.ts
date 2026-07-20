import { upsertProcessStatus } from "@solard/core/db.js";
import { workerMeasure, summarizeForMeasure } from "../measure.ts";
import { resolveSolUsd } from "../prices/sol-usd.ts";
import {
  PUMPFUN_PROGRAM_ID,
  parsePumpTransaction,
} from "../pump/pump-parser.ts";
import { applyParsedPumpTransaction } from "../helius/apply-pump-parsed.ts";
import {
  BoundedAsyncQueue,
  TtlDeduper,
  compactError,
  shortSignature,
} from "../pump/stream-utils.ts";

const WORKER = "solard-helius-laserstream-v1";
const BUILD_ID = "helius-laserstream-v1-transaction-subscribe";
const COMMITMENT = (process.env.SOLARD_HELIUS_WS_COMMITMENT ??
  process.env.SOLARD_HELIUS_COMMITMENT ??
  "processed") as "processed" | "confirmed" | "finalized";
const CONCURRENCY = Math.max(
  1,
  Math.min(32, Number(process.env.SOLARD_HELIUS_WS_CONCURRENCY ?? "6")),
);
const MAX_QUEUED = Math.max(
  100,
  Number(process.env.SOLARD_HELIUS_WS_MAX_QUEUED ?? "2500"),
);
const DEDUPE_TTL_MS = Math.max(
  10_000,
  Number(process.env.SOLARD_HELIUS_WS_DEDUPE_TTL_MS ?? "120000"),
);
let running = true;

function heliusWsUrl(): string {
  const explicit =
    process.env.SOLARD_HELIUS_WS_URL?.trim() ||
    process.env.HELIUS_WS_URL?.trim();
  if (explicit) return explicit;
  const key = process.env.HELIUS_API_KEY?.trim();
  if (key)
    return `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  throw new Error(
    "Missing SOLARD_HELIUS_WS_URL, HELIUS_WS_URL, or HELIUS_API_KEY for Helius LaserStream mode",
  );
}

function redactUrl(value: string): string {
  return value.replace(/api-key=([^&]+)/i, "api-key=<redacted>");
}

function normalizeNotificationTx(
  result: any,
): { tx: any; signature: string } | null {
  const signature = String(
    result?.signature ??
      result?.transaction?.signature ??
      result?.transaction?.transaction?.signatures?.[0] ??
      result?.value?.signature ??
      "",
  );
  const envelope =
    result?.transaction?.meta || result?.transaction?.transaction
      ? result.transaction
      : (result?.value?.transaction ?? result);
  if (!signature || !envelope) return null;
  return {
    signature,
    tx: {
      ...envelope,
      slot: result?.slot ?? envelope?.slot ?? result?.context?.slot ?? 0,
      signature,
    },
  };
}

function summarizeRawMessage(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return {
      method: parsed?.method ?? null,
      hasResult: !!parsed?.params?.result,
      id: parsed?.id ?? null,
      bytes: raw.length,
    };
  } catch {
    return { bytes: raw.length, json: false };
  }
}

async function processNotification(item: {
  tx: any;
  signature: string;
}): Promise<void> {
  await workerMeasure.measure(
    {
      start: () => `helius laserstream parse ${shortSignature(item.signature)}`,
      end: (result) => summarizeForMeasure(result),
      catch: (error) => ({ error: compactError(error) }),
    },
    async () => {
      const solUsd = await resolveSolUsd();
      const parsed = parsePumpTransaction({
        tx: item.tx,
        signature: item.signature,
        solUsd,
        now: Date.now(),
      });
      const applied = await applyParsedPumpTransaction({
        parsed,
        source: "helius-laserstream",
        confidence: COMMITMENT,
        solUsd,
      });
      return {
        signature: shortSignature(item.signature),
        creates: parsed.creates.length,
        trades: parsed.trades.length,
        completes: parsed.completes?.length ?? 0,
        ...applied,
      };
    },
  );
}

async function makeWebSocket(url: string): Promise<any> {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor)
    throw new Error("globalThis.WebSocket is unavailable in this Bun runtime");
  return new WebSocketCtor(url);
}

function onSocket(
  ws: any,
  event: string,
  handler: (...args: any[]) => void,
): void {
  if (typeof ws.addEventListener === "function") {
    ws.addEventListener(event, (ev: any) => handler(ev));
    return;
  }
  if (typeof ws.on === "function") ws.on(event, handler);
}

function socketPayload(value: any): string {
  const payload = value?.data ?? value;
  if (typeof payload === "string") return payload;
  if (payload instanceof ArrayBuffer)
    return Buffer.from(payload).toString("utf8");
  if (ArrayBuffer.isView(payload))
    return Buffer.from(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    ).toString("utf8");
  if (Buffer.isBuffer(payload)) return payload.toString("utf8");
  return String(payload ?? "");
}

async function runOnce(attempt: number): Promise<void> {
  const url = heliusWsUrl();
  const redacted = redactUrl(url);
  const dedupe = new TtlDeduper(DEDUPE_TTL_MS);
  const queue = new BoundedAsyncQueue(processNotification, {
    concurrency: CONCURRENCY,
    maxQueued: MAX_QUEUED,
  });
  const ws = await makeWebSocket(url);
  let subscribed = false;
  let received = 0;
  let accepted = 0;
  let duplicates = 0;
  let malformed = 0;
  let lastMessageAtMs = 0;
  let lastSignature: string | null = null;
  let lastRaw: Record<string, unknown> | null = null;

  const heartbeat = () => {
    upsertProcessStatus({
      name: WORKER,
      kind: "stream",
      status: subscribed ? "ok" : "connecting",
      data: {
        source: "helius",
        buildId: BUILD_ID,
        mode: "laserstream-transactionSubscribe",
        url: redacted,
        commitment: COMMITMENT,
        attempt,
        subscribed,
        received,
        accepted,
        duplicates,
        malformed,
        dedupeSize: dedupe.size(),
        lastMessageAtMs,
        lastMessageAgeMs: lastMessageAtMs ? Date.now() - lastMessageAtMs : null,
        lastSignature,
        lastRaw,
        queue: queue.stats(),
      },
    });
  };

  const pulse = setInterval(heartbeat, 1_000);

  await new Promise<void>((resolve, reject) => {
    onSocket(ws, "open", () => {
      const req = {
        jsonrpc: "2.0",
        id: 1,
        method: "transactionSubscribe",
        params: [
          {
            accountInclude: [PUMPFUN_PROGRAM_ID],
            vote: false,
            failed: false,
          },
          {
            commitment: COMMITMENT,
            encoding: "jsonParsed",
            transactionDetails: "full",
            maxSupportedTransactionVersion: 0,
          },
        ],
      };
      ws.send(JSON.stringify(req));
      subscribed = true;
      heartbeat();
    });

    onSocket(ws, "message", (payload: any) => {
      const raw = socketPayload(payload);
      lastRaw = summarizeRawMessage(raw);
      lastMessageAtMs = Date.now();
      received++;
      try {
        const data = JSON.parse(raw);
        if (
          data?.method !== "transactionNotification" ||
          !data?.params?.result
        ) {
          heartbeat();
          return;
        }
        const normalized = normalizeNotificationTx(data.params.result);
        if (!normalized) {
          malformed++;
          heartbeat();
          return;
        }
        lastSignature = normalized.signature;
        if (!dedupe.add(normalized.signature)) {
          duplicates++;
          heartbeat();
          return;
        }
        if (queue.push(normalized)) accepted++;
        heartbeat();
      } catch (error) {
        malformed++;
        upsertProcessStatus({
          name: WORKER,
          kind: "stream",
          status: "parse-error",
          error,
          data: { buildId: BUILD_ID, raw: lastRaw },
        });
      }
    });

    onSocket(ws, "close", () => {
      clearInterval(pulse);
      heartbeat();
      resolve();
    });

    onSocket(ws, "error", (error: unknown) => {
      upsertProcessStatus({
        name: WORKER,
        kind: "stream",
        status: "error",
        error,
        data: { buildId: BUILD_ID, mode: "laserstream", url: redacted },
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

async function main() {
  let attempt = 0;
  while (running) {
    attempt++;
    await workerMeasure.measure(
      {
        start: () => "helius laserstream session",
        end: (result) => summarizeForMeasure(result),
        catch: (error) => {
          upsertProcessStatus({
            name: WORKER,
            kind: "stream",
            status: "error",
            error,
            data: { buildId: BUILD_ID, attempt },
          });
          return { error: compactError(error) };
        },
      },
      () => runOnce(attempt),
    );
    const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
    upsertProcessStatus({
      name: WORKER,
      kind: "stream",
      status: "reconnecting",
      data: { buildId: BUILD_ID, attempt, delay },
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
    data: { reason, buildId: BUILD_ID },
  });
  process.exit(0);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

main().catch((error) => {
  upsertProcessStatus({
    name: WORKER,
    kind: "stream",
    status: "fatal",
    error,
    data: { buildId: BUILD_ID },
  });
  throw error;
});
