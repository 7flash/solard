import { Connection } from "@solana/web3.js";
import {
  subscribeLaunches as subscribeCoreLaunches,
  subscribeMigrations as subscribeCoreMigrations,
  subscribeTrades as subscribeCoreTrades,
  type TradeEvent,
  type TradeSubscription,
} from "@solard/core";

export type SubscribeLaunchesOptions = Omit<
  Parameters<typeof subscribeCoreLaunches>[0],
  "connection"
>;
export type SubscribeMigrationsOptions = Omit<
  Parameters<typeof subscribeCoreMigrations>[0],
  "connection"
>;
export type SubscribeTradesOptions = Omit<
  Parameters<typeof subscribeCoreTrades>[0],
  "connection"
>;

export type ListenTradesOptions = Omit<SubscribeTradesOptions, "onTrade">;

export type TradeListener = {
  add(tokens: string | readonly string[]): Promise<void>;
  remove(tokens: string | readonly string[]): Promise<void>;
  has(token: string): boolean;
  list(): string[];
  onTrade(callback: (event: TradeEvent) => void | Promise<void>): () => void;
  close(): Promise<void>;
  readonly closed: Promise<void>;
};

type LiveConnection = {
  endpoint: string;
  websocketEndpoint: string;
  connection: Connection;
};

let shared: LiveConnection | null = null;
let readiness: { endpoint: string; promise: Promise<void> } | null = null;

function endpointFromEnv(): string {
  const endpoint = process.env.RPC_ENDPOINT?.trim();
  if (!endpoint)
    throw new Error(
      "Missing RPC_ENDPOINT. Set one Solana RPC URL in RPC_ENDPOINT; Solard derives WebSocket access from the same endpoint.",
    );
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("RPC_ENDPOINT must be a valid http:// or https:// URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("RPC_ENDPOINT must use http:// or https://.");
  return endpoint;
}

export function deriveWebSocketEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else throw new Error("RPC endpoint must use http:// or https://.");
  return url.toString();
}

export function redactRpcEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const keys: string[] = [];
    url.searchParams.forEach((_value, key) => keys.push(key));
    for (const key of keys) {
      if (/key|token|secret|auth/i.test(key))
        url.searchParams.set(key, "<redacted>");
    }
    return url.toString().replaceAll("%3Credacted%3E", "<redacted>");
  } catch {
    return endpoint.replace(
      /([?&](?:api-?key|api_key|apikey|key|token|secret|auth)=)[^&]+/gi,
      "$1<redacted>",
    );
  }
}

function providerName(endpoint: string): string {
  try {
    return new URL(endpoint).hostname.endsWith("helius-rpc.com")
      ? "Helius"
      : "Solana RPC provider";
  } catch {
    return "Solana RPC provider";
  }
}

function safeMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value
    .replace(
      /([?&](?:api-?key|api_key|apikey|key|token|secret|auth)=)[^&\s]+/gi,
      "$1<redacted>",
    )
    .slice(0, 400);
}

function rpcFailure(endpoint: string, detail: string): Error {
  return new Error(
    `${providerName(endpoint)} rejected RPC_ENDPOINT ${redactRpcEndpoint(endpoint)}. Check the API key, credits/quota, rate limits, and account status. ${detail}`,
  );
}

function websocketFailure(endpoint: string, detail: string): Error {
  return new Error(
    `${providerName(endpoint)} rejected WebSocket access derived from RPC_ENDPOINT ${redactRpcEndpoint(endpoint)}. Check the API key, credits/quota, rate limits, and WebSocket connection limits. ${detail}`,
  );
}

async function preflightRpc(endpoint: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const label =
        response.status === 401 || response.status === 403
          ? "Authentication failed."
          : response.status === 402
            ? "Billing or credits are unavailable."
            : response.status === 429
              ? "Rate limit or quota was exceeded."
              : `HTTP ${response.status}.`;
      throw rpcFailure(endpoint, label);
    }
    const body = (await response.json()) as {
      result?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    if (body.error) {
      const code =
        body.error.code == null ? "" : `code ${String(body.error.code)}: `;
      throw rpcFailure(
        endpoint,
        `${code}${String(body.error.message ?? "RPC error")}`,
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("rejected RPC_ENDPOINT")
    )
      throw error;
    if (controller.signal.aborted)
      throw rpcFailure(endpoint, "Connection timed out.");
    throw rpcFailure(endpoint, safeMessage(error));
  } finally {
    clearTimeout(timer);
  }
}

async function preflightWebSocket(endpoint: string): Promise<void> {
  const websocketEndpoint = deriveWebSocketEndpoint(endpoint);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let socket: WebSocket | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error && socket) {
        try {
          socket.close();
        } catch {}
      }
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () =>
        finish(websocketFailure(endpoint, "WebSocket handshake timed out.")),
      6_000,
    );
    try {
      socket = new WebSocket(websocketEndpoint);
    } catch (error) {
      finish(websocketFailure(endpoint, safeMessage(error)));
      return;
    }
    socket.addEventListener(
      "open",
      () => {
        finish();
        try {
          socket?.close(1000);
        } catch {}
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      (event) => {
        const detail = safeMessage(
          (event as { error?: unknown }).error ??
            "WebSocket handshake was rejected.",
        );
        finish(websocketFailure(endpoint, detail));
      },
      { once: true },
    );
    socket.addEventListener(
      "close",
      (event) => {
        if (settled) return;
        const detail = event.reason
          ? `WebSocket closed during handshake: ${event.reason}`
          : `WebSocket closed during handshake with code ${event.code}.`;
        finish(websocketFailure(endpoint, detail));
      },
      { once: true },
    );
  });
}

async function ensureReady(endpoint: string): Promise<void> {
  if (readiness?.endpoint === endpoint) return await readiness.promise;
  const promise = Promise.all([
    preflightRpc(endpoint),
    preflightWebSocket(endpoint),
  ]).then(() => undefined);
  readiness = { endpoint, promise };
  try {
    await promise;
  } catch (error) {
    if (readiness?.promise === promise) readiness = null;
    throw error;
  }
}

async function liveConnection(): Promise<LiveConnection> {
  const endpoint = endpointFromEnv();
  await ensureReady(endpoint);
  if (shared?.endpoint === endpoint) return shared;
  shared = {
    endpoint,
    websocketEndpoint: deriveWebSocketEndpoint(endpoint),
    connection: new Connection(endpoint, "confirmed"),
  };
  return shared;
}

function notifyReady(
  options: {
    onStatus?: (event: string, data?: Record<string, unknown>) => void;
  },
  live: LiveConnection,
): void {
  try {
    options.onStatus?.("rpc-ready", {
      rpc: redactRpcEndpoint(live.endpoint),
      websocket: redactRpcEndpoint(live.websocketEndpoint),
    });
  } catch {}
}

export async function subscribeTrades(options: SubscribeTradesOptions) {
  const live = await liveConnection();
  notifyReady(options, live);
  return await subscribeCoreTrades({ ...options, connection: live.connection });
}

export async function subscribeLaunches(options: SubscribeLaunchesOptions) {
  const live = await liveConnection();
  notifyReady(options, live);
  return await subscribeCoreLaunches({
    ...options,
    connection: live.connection,
  });
}

export async function subscribeMigrations(options: SubscribeMigrationsOptions) {
  const live = await liveConnection();
  notifyReady(options, live);
  return await subscribeCoreMigrations({
    ...options,
    connection: live.connection,
  });
}
export async function listenTrades(
  options: ListenTradesOptions,
): Promise<TradeListener> {
  const callbacks = new Set<(event: TradeEvent) => void | Promise<void>>();
  const pending: TradeEvent[] = [];
  let subscription: TradeSubscription;
  const dispatch = async (event: TradeEvent) => {
    if (callbacks.size === 0) {
      pending.push(event);
      if (pending.length > 1_000) pending.shift();
      return;
    }
    await Promise.all(
      [...callbacks].map(async (callback) => {
        await callback(event);
      }),
    );
  };
  subscription = await subscribeTrades({ ...options, onTrade: dispatch });
  return {
    add: (tokens) => subscription.addTokens(tokens),
    remove: (tokens) => subscription.removeTokens(tokens),
    has: (token) => subscription.hasToken(token),
    list: () => subscription.listTokens(),
    onTrade(callback) {
      callbacks.add(callback);
      if (pending.length) {
        const rows = pending.splice(0);
        void Promise.resolve().then(async () => {
          for (const event of rows) await callback(event);
        });
      }
      return () => callbacks.delete(callback);
    },
    close: () => subscription.close(),
    get closed() {
      return subscription.closed;
    },
  };
}
