import {
  assertWebAuth,
  errorResponse,
  jsonResponse,
  readJson,
} from "../../web/http.js";
import {
  addTokenToWatchGroup,
  clearCurrentSessionWatchGroup,
  createTokenWatchGroup,
  listPumpLiveState,
  normalizePumpNewToken,
  recordPumpTrade,
  removeTokenFromWatchGroup,
} from "../../web/pump-live-store.js";
import {
  PUMP_PROGRAM_ID,
  findPumpCreateInTransaction,
} from "../parsers/pump-create.js";

const DEFAULT_PUMP_FEED_WS_URL = "wss://pumpportal.fun/api/data";

type Raw = Record<string, unknown>;

type Source = "pumpportal" | "helius";

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

function watchedMints(): string[] {
  return listPumpLiveState().watchedMints;
}

function subscribeWatched(ws: WebSocket): void {
  const keys = watchedMints();
  if (keys.length > 0)
    ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys }));
}

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function rpcHttpUrl(): string {
  const url =
    process.env.HELIUS_RPC_URL?.trim() || process.env.RPC_ENDPOINT?.trim();
  if (!url)
    throw new Error(
      "HELIUS_RPC_URL or RPC_ENDPOINT is required for Helius transaction enrichment",
    );
  return url;
}

function heliusWsUrl(): string {
  const direct =
    process.env.SOLWAL_HELIUS_WS_URL?.trim() ||
    process.env.HELIUS_WS_URL?.trim();
  if (direct) return direct;
  const apiKey = process.env.HELIUS_API_KEY?.trim();
  if (apiKey)
    return `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
  const rpc =
    process.env.HELIUS_RPC_URL?.trim() || process.env.RPC_ENDPOINT?.trim();
  if (rpc?.includes("helius-rpc.com")) {
    return rpc.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  }
  throw new Error(
    "Set SOLWAL_HELIUS_WS_URL, HELIUS_WS_URL, HELIUS_API_KEY, or a Helius RPC_ENDPOINT for direct Helius stream",
  );
}

class RpcRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

function intEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function retryAfterMs(response: Response, fallbackMs: number): number {
  const header = response.headers.get("retry-after");
  if (!header) return fallbackMs;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.max(250, Math.floor(seconds * 1000));
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(250, at - Date.now()) : fallbackMs;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcHttpUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const text = await response.text();
  let payload: { result?: T; error?: unknown } = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text };
  }
  if (response.status === 429) {
    const waitMs = retryAfterMs(
      response,
      intEnv("SOLWAL_HELIUS_429_BACKOFF_MS", 10_000),
    );
    throw new RpcRateLimitError(`RPC ${method} rate limited`, waitMs);
  }
  if (!response.ok || payload.error)
    throw new Error(
      `RPC ${method} failed: ${JSON.stringify(payload.error ?? response.status)}`,
    );
  return payload.result as T;
}

async function normalizeHeliusSignature(
  signature: string,
): Promise<ReturnType<typeof normalizePumpNewToken> | null> {
  const tx = await rpc<Raw | null>("getTransaction", [
    signature,
    {
      encoding: "json",
      maxSupportedTransactionVersion: 0,
      commitment: "processed",
    },
  ]);
  if (!tx || (tx.meta as Raw | undefined)?.err) return null;
  const raw = findPumpCreateInTransaction(tx, signature);
  return raw ? normalizePumpNewToken(raw) : null;
}

function runPumpPortalStream(args: {
  request: Request;
  controller: ReadableStreamDefaultController<Uint8Array>;
  send: (event: string, data: unknown) => void;
  close: () => void;
}): () => void {
  const wsUrl =
    process.env.SOLWAL_PUMP_FEED_WS_URL?.trim() ||
    process.env.PUMPPORTAL_WS_URL?.trim() ||
    DEFAULT_PUMP_FEED_WS_URL;
  let ws: WebSocket | null = null;
  let subscribed = new Set<string>();
  let seq = 0;
  const watchSync = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const keys = watchedMints().filter((mint) => !subscribed.has(mint));
    if (keys.length > 0) {
      ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys }));
      for (const key of keys) subscribed.add(key);
      args.send("status", {
        status: "subscribed-token-trades",
        source: "pumpportal",
        keys,
        at: new Date().toISOString(),
      });
    }
  }, 2_000);
  args.send("status", {
    status: "connecting",
    source: "pumpportal",
    wsUrl,
    at: new Date().toISOString(),
  });
  ws = new WebSocket(wsUrl);
  ws.addEventListener("open", () => {
    args.send("status", {
      status: "connected",
      source: "pumpportal",
      wsUrl,
      at: new Date().toISOString(),
    });
    ws?.send(JSON.stringify({ method: "subscribeNewToken" }));
    subscribeWatched(ws!);
    subscribed = new Set(watchedMints());
  });
  ws.addEventListener("message", (message) => {
    try {
      const text =
        typeof message.data === "string" ? message.data : String(message.data);
      const parsed = JSON.parse(text) as Raw;
      const txType =
        typeof parsed.txType === "string"
          ? parsed.txType
          : typeof parsed.type === "string"
            ? parsed.type
            : "";
      const isNew =
        txType === "create" || parsed.name != null || parsed.uri != null;
      if (isNew && parsed.mint) {
        const token = normalizePumpNewToken(parsed, ++seq);
        if (token) args.send("token", token);
        return;
      }
      if (parsed.mint) {
        const token = recordPumpTrade(parsed);
        if (token) args.send("trade", token);
      }
    } catch (error) {
      args.send("warning", {
        source: "pumpportal",
        error: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      });
    }
  });
  ws.addEventListener("error", () =>
    args.send("status", {
      status: "error",
      source: "pumpportal",
      at: new Date().toISOString(),
    }),
  );
  ws.addEventListener("close", (event) => {
    args.send("status", {
      status: "closed",
      source: "pumpportal",
      code: event.code,
      reason: event.reason || null,
      at: new Date().toISOString(),
    });
    args.close();
  });
  return () => {
    clearInterval(watchSync);
    try {
      ws?.close();
    } catch {}
  };
}

function runHeliusStream(args: {
  request: Request;
  controller: ReadableStreamDefaultController<Uint8Array>;
  send: (event: string, data: unknown) => void;
  close: () => void;
}): () => void {
  const wsUrl = heliusWsUrl();
  const maxQueue = Math.max(1, intEnv("SOLWAL_HELIUS_ENRICH_QUEUE_MAX", 300));
  const enrichPerSecond = Math.max(
    0.1,
    intEnv("SOLWAL_HELIUS_ENRICH_PER_SECOND", 2),
  );
  const seenLimit = Math.max(
    maxQueue * 4,
    intEnv("SOLWAL_HELIUS_SEEN_LIMIT", 5_000),
  );
  const queue: string[] = [];
  const queued = new Set<string>();
  const seen: string[] = [];
  const seenSet = new Set<string>();
  let ws: WebSocket | null = null;
  let closed = false;
  let processing = false;
  let rateLimitedUntil = 0;
  let dropped = 0;
  let queueTimer: ReturnType<typeof setTimeout> | null = null;
  let statsTimer: ReturnType<typeof setInterval> | null = null;

  const markSeen = (signature: string): boolean => {
    if (seenSet.has(signature)) return false;
    seenSet.add(signature);
    seen.push(signature);
    while (seen.length > seenLimit) {
      const removed = seen.shift();
      if (removed) seenSet.delete(removed);
    }
    return true;
  };

  const schedule = (delayMs = Math.ceil(1000 / enrichPerSecond)) => {
    if (closed || queueTimer) return;
    queueTimer = setTimeout(
      () => {
        queueTimer = null;
        void pumpQueue();
      },
      Math.max(25, delayMs),
    );
  };

  const enqueue = (signature: string): void => {
    if (!markSeen(signature)) return;
    if (queued.has(signature)) return;
    if (queue.length >= maxQueue) {
      dropped += 1;
      const removed = queue.shift();
      if (removed) queued.delete(removed);
    }
    queue.push(signature);
    queued.add(signature);
    schedule(0);
  };

  const pumpQueue = async (): Promise<void> => {
    if (closed || processing) return;
    const now = Date.now();
    if (now < rateLimitedUntil) {
      schedule(rateLimitedUntil - now);
      return;
    }
    const signature = queue.shift();
    if (!signature) return;
    queued.delete(signature);
    processing = true;
    try {
      const token = await normalizeHeliusSignature(signature);
      if (token) args.send("token", token);
      else
        args.send("warning", {
          source: "helius",
          signature,
          error: "create log seen but transaction parser did not extract token",
          at: new Date().toISOString(),
        });
    } catch (error) {
      if (error instanceof RpcRateLimitError) {
        rateLimitedUntil = Date.now() + error.retryAfterMs;
        queue.unshift(signature);
        queued.add(signature);
        args.send("warning", {
          source: "helius",
          kind: "rate-limit",
          error: error.message,
          retryAfterMs: error.retryAfterMs,
          queued: queue.length,
          dropped,
          at: new Date().toISOString(),
        });
      } else {
        args.send("warning", {
          source: "helius",
          signature,
          error: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        });
      }
    } finally {
      processing = false;
      if (queue.length > 0)
        schedule(
          Date.now() < rateLimitedUntil
            ? rateLimitedUntil - Date.now()
            : Math.ceil(1000 / enrichPerSecond),
        );
    }
  };

  args.send("status", {
    status: "connecting",
    source: "helius",
    wsUrl: wsUrl.replace(/api-key=[^&]+/, "api-key=***"),
    enrichPerSecond,
    maxQueue,
    at: new Date().toISOString(),
  });
  ws = new WebSocket(wsUrl);
  ws.addEventListener("open", () => {
    args.send("status", {
      status: "connected",
      source: "helius",
      enrichPerSecond,
      maxQueue,
      at: new Date().toISOString(),
    });
    ws?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [{ mentions: [PUMP_PROGRAM_ID] }, { commitment: "processed" }],
      }),
    );
  });
  ws.addEventListener("message", (message) => {
    try {
      const text =
        typeof message.data === "string" ? message.data : String(message.data);
      const parsed = JSON.parse(text) as Raw;
      const value = ((
        (parsed.params as Raw | undefined)?.result as Raw | undefined
      )?.value ?? {}) as Raw;
      const signature = clean(value.signature);
      const logs = Array.isArray(value.logs) ? value.logs.map(String) : [];
      if (!signature) return;
      if (
        !logs.some(
          (line) =>
            /Instruction:\s*Create/i.test(line) ||
            /CreateV2|create_v2/i.test(line),
        )
      )
        return;
      enqueue(signature);
    } catch (error) {
      args.send("warning", {
        source: "helius",
        error: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      });
    }
  });
  statsTimer = setInterval(() => {
    args.send("status", {
      status: "helius-enrichment",
      source: "helius",
      queued: queue.length,
      dropped,
      rateLimitedMs: Math.max(0, rateLimitedUntil - Date.now()),
      at: new Date().toISOString(),
    });
  }, 5_000);
  ws.addEventListener("error", () =>
    args.send("status", {
      status: "error",
      source: "helius",
      at: new Date().toISOString(),
    }),
  );
  ws.addEventListener("close", (event) => {
    args.send("status", {
      status: "closed",
      source: "helius",
      code: event.code,
      reason: event.reason || null,
      at: new Date().toISOString(),
    });
    args.close();
  });
  return () => {
    closed = true;
    if (queueTimer) clearTimeout(queueTimer);
    if (statsTimer) clearInterval(statsTimer);
    try {
      ws?.close();
    } catch {}
  };
}

export function handlePumpLiveGet(request: Request): Response {
  try {
    assertWebAuth(request);
    const url = new URL(request.url);
    if (url.searchParams.get("stream") !== "1") {
      return jsonResponse({ ok: true, value: listPumpLiveState() });
    }

    const source = (
      url.searchParams.get("source") === "pumpportal" ? "pumpportal" : "helius"
    ) as Source;
    clearCurrentSessionWatchGroup();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let stopSource: (() => void) | null = null;
        const send = (event: string, data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(sse(event, data));
          } catch {
            closed = true;
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          try {
            stopSource?.();
          } catch {}
          try {
            controller.close();
          } catch {}
        };
        const heartbeat = setInterval(
          () => send("ping", { at: new Date().toISOString() }),
          15_000,
        );
        request.signal.addEventListener("abort", close, { once: true });
        stopSource =
          source === "helius"
            ? runHeliusStream({ request, controller, send, close })
            : runPumpPortalStream({ request, controller, send, close });
      },
      cancel() {},
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  } catch (error) {
    return errorResponse(
      error,
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500,
    );
  }
}

export async function handlePumpLivePost(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const body = await readJson(request);
    const action = String(body.action ?? "");
    if (action === "create-group")
      return jsonResponse({
        ok: true,
        value: createTokenWatchGroup(String(body.name ?? "")),
      });
    if (action === "add-token")
      return jsonResponse({
        ok: true,
        value: addTokenToWatchGroup({
          groupId: String(body.groupId ?? "main"),
          ...body.token,
        }),
      });
    if (action === "remove-token")
      return jsonResponse({
        ok: true,
        value: removeTokenFromWatchGroup(
          String(body.groupId ?? ""),
          String(body.mint ?? ""),
        ),
      });
    if (action === "clear-current-session")
      return jsonResponse({ ok: true, value: clearCurrentSessionWatchGroup() });
    throw new Error(`Unknown pump-live action: ${action || "(empty)"}`);
  } catch (error) {
    return errorResponse(
      error,
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500,
    );
  }
}
