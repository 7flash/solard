import { Connection } from "@solana/web3.js";
import {
  subscribeLaunches as subscribeCoreLaunches,
  subscribeMigrations as subscribeCoreMigrations,
  subscribeTrades as subscribeCoreTrades,
  type TradeEvent,
  type TradeSubscription,
  type MigrationEvent,
} from "@solard/core";

export type LiveEndpointOptions = {
  /** Ordered endpoints on the same cluster; public RPC can be supplied last. */
  rpcUrls?: readonly string[];
  /** Fresh HTTP and WebSocket readiness probes for pooled trade streams (default 30s). */
  healthCheckIntervalMs?: number;
};
export type SubscribeLaunchesOptions = Omit<
  Parameters<typeof subscribeCoreLaunches>[0],
  "connection"
> & LiveEndpointOptions;
export type SubscribeMigrationsOptions = Omit<
  Parameters<typeof subscribeCoreMigrations>[0],
  "connection"
> & LiveEndpointOptions;
export type SubscribeTradesOptions = Omit<
  Parameters<typeof subscribeCoreTrades>[0],
  "connection"
> & LiveEndpointOptions;

export type ListenTradesOptions = Omit<SubscribeTradesOptions, "onTrade">;

export type TradeListener = {
  add(tokens: string | readonly string[]): Promise<void>;
  remove(tokens: string | readonly string[]): Promise<void>;
  has(token: string): boolean;
  list(): string[];
  onTrade(callback: (event: TradeEvent) => void | Promise<void>): () => void;
  onMigration(callback: (event: TradeListenerMigration) => void | Promise<void>): () => void;
  close(): Promise<void>;
  readonly closed: Promise<void>;
};
export type TradeListenerMigration = MigrationEvent & { oldPool: string | null; newPool: string };

type LiveConnection = {
  endpoint: string;
  websocketEndpoint: string;
  connection: Connection;
};

let shared: LiveConnection | null = null;
let readiness: { endpoint: string; promise: Promise<void> } | null = null;

/** HTTP + a fresh WebSocket handshake must both succeed before choosing an endpoint. */
export class LiveEndpointPool {
  private active = 0;
  readonly endpoints: readonly string[];
  constructor(endpoints: readonly string[], private readonly probe: (endpoint: string) => Promise<void> = async (endpoint) => {
    await Promise.all([preflightRpc(endpoint), preflightWebSocket(endpoint)]);
  }) {
    this.endpoints = [...new Set(endpoints)];
    if (!this.endpoints.length) throw new Error("Live RPC endpoint pool cannot be empty");
    for (const endpoint of this.endpoints) deriveWebSocketEndpoint(endpoint);
  }
  get endpoint(): string { return this.endpoints[this.active]!; }
  async select(skipCurrent = false): Promise<string> {
    const start = this.active;
    let lastError: unknown;
    for (let offset = skipCurrent ? 1 : 0; offset < this.endpoints.length + (skipCurrent ? 1 : 0); offset++) {
      const index = (start + offset) % this.endpoints.length;
      try { await this.probe(this.endpoints[index]!); this.active = index; return this.endpoint; }
      catch (error) { lastError = error; }
    }
    throw lastError;
  }
  async check(): Promise<string> {
    try { await this.probe(this.endpoint); return this.endpoint; }
    catch { return await this.select(true); }
  }
}
const livePools = new Map<string, LiveEndpointPool>();
function endpointPool(options: LiveEndpointOptions): LiveEndpointPool | undefined {
  if (!options.rpcUrls?.length) return undefined;
  const key = JSON.stringify(options.rpcUrls);
  let pool = livePools.get(key);
  if (!pool) { pool = new LiveEndpointPool(options.rpcUrls); livePools.set(key, pool); }
  return pool;
}
function connectionFor(endpoint: string): LiveConnection {
  return { endpoint, websocketEndpoint: deriveWebSocketEndpoint(endpoint), connection: new Connection(endpoint, "confirmed") };
}

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

async function liveConnection(options: LiveEndpointOptions = {}): Promise<LiveConnection> {
  const pool = endpointPool(options);
  if (pool) return connectionFor(await pool.select());
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
  let live = await liveConnection(options);
  notifyReady(options, live);
  const pool = endpointPool(options);
  if (!pool) return await subscribeCoreTrades({ ...options, connection: live.connection });
  // Keep duplicate suppression across connection changes. Provider probes detect
  // dead credentials/quota; they cannot diagnose a silent old socket when a new
  // handshake to that provider remains healthy.
  const seen = new Set<string>();
  const onTrade = async (event: TradeEvent) => {
    const key = [event.signature, event.venue, event.mint, event.pool, event.side, String(event.baseRaw), String(event.quoteRaw)].join(":");
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 4096) seen.delete(seen.values().next().value!);
    await options.onTrade(event);
  };
  let subscription = await subscribeCoreTrades({ ...options, signal: undefined, onTrade, connection: live.connection });
  let stopped = false;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const pending = tail.then(work, work); tail = pending.catch(() => undefined); return pending;
  };
  let settle!: () => void;
  const closed = new Promise<void>((resolve) => { settle = resolve; });
  const requestedInterval = options.healthCheckIntervalMs ?? 30_000;
  if (!Number.isFinite(requestedInterval) || requestedInterval < 1000) {
    await subscription.close();
    throw new Error("healthCheckIntervalMs must be at least 1000");
  }
  let checking = false;
  const timer = setInterval(() => {
    if (stopped || checking) return;
    checking = true;
    void serial(async () => {
      if (stopped) return;
      try {
        const endpoint = await pool.check();
        if (stopped || endpoint === live.endpoint) return;
        const tokens = subscription.listTokens();
        const nextLive = connectionFor(endpoint);
        const next = await subscribeCoreTrades({ ...options, signal: undefined, tokens, onTrade, connection: nextLive.connection });
        await subscription.close();
        subscription = next;
        live = nextLive;
        notifyReady(options, live);
      } catch (error) {
        try { options.onStatus?.("rpc-unavailable", { error: safeMessage(error) }); } catch {}
      }
    }).finally(() => { checking = false; });
  }, Math.trunc(requestedInterval));
  timer.unref?.();
  const close = async () => {
    if (stopped) return await closed;
    stopped = true;
    clearInterval(timer);
    options.signal?.removeEventListener("abort", abort);
    await serial(async () => { await subscription.close(); settle(); });
  };
  const abort = () => { void close(); };
  if (options.signal?.aborted) await close();
  else options.signal?.addEventListener("abort", abort, { once: true });
  return {
    addTokens: (tokens: string | readonly string[]) => serial(async () => { if (stopped) throw new Error("Trade subscription is closed"); await subscription.addTokens(tokens); }),
    removeTokens: (tokens: string | readonly string[]) => serial(async () => { if (!stopped) await subscription.removeTokens(tokens); }),
    hasToken: (token: string) => !stopped && subscription.hasToken(token),
    listTokens: () => stopped ? [] : subscription.listTokens(),
    close, closed,
  } satisfies TradeSubscription;
}

export async function subscribeLaunches(options: SubscribeLaunchesOptions) {
  const live = await liveConnection(options);
  notifyReady(options, live);
  return await subscribeCoreLaunches({
    ...options,
    connection: live.connection,
  });
}

export async function subscribeMigrations(options: SubscribeMigrationsOptions) {
  const live = await liveConnection(options);
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
  const migrationCallbacks = new Set<(event: TradeListenerMigration) => void | Promise<void>>();
  const pendingMigrations: TradeListenerMigration[] = [];
  const watched = new Set(options.tokens);
  const lastPools = new Map<string, string | null>();
  let subscription: TradeSubscription;
  let migrations: Awaited<ReturnType<typeof subscribeMigrations>> | undefined;
  let stopped = false;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const job = tail.then(work, work); tail = job.catch(() => undefined); return job; };
  const onMigration = async (event: MigrationEvent) => {
    if (stopped || !watched.has(event.mint)) return;
    const migration = { ...event, oldPool: lastPools.get(event.mint) ?? null, newPool: event.pool };
    lastPools.set(event.mint, event.pool);
    await serial(async () => {
      if (stopped || !watched.has(event.mint)) return;
      // Mint mentions cover the new pool; rebuilding resets cached identities,
      // decimals and supply without changing the caller's watched token list.
      await subscription.removeTokens(event.mint);
      await subscription.addTokens(event.mint);
    });
    if (!migrationCallbacks.size) { pendingMigrations.push(migration); if (pendingMigrations.length > 1000) pendingMigrations.shift(); }
    else await Promise.all([...migrationCallbacks].map(callback => callback(migration)));
  };
  const dispatch = async (event: TradeEvent) => {
    if (!watched.has(event.mint) || stopped) return;
    lastPools.set(event.mint, event.pool);
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
  const onStatus = (event: string, data?: Record<string, unknown>) => {
    options.onStatus?.(event, data);
    if (event === "rpc-ready" && migrations && !stopped) void serial(async () => {
      if (stopped) return;
      const next = await subscribeMigrations({ rpcUrls: options.rpcUrls, tokens: [...watched], commitment: options.commitment, metadata: options.metadata, onMigration, onStatus: options.onStatus });
      await migrations?.close(); migrations = next;
    }).catch(error => options.onStatus?.("migration-resubscribe-error", { error: safeMessage(error) }));
  };
  subscription = await subscribeTrades({ ...options, signal: undefined, onStatus, onTrade: dispatch });
  try { migrations = await subscribeMigrations({ rpcUrls: options.rpcUrls, tokens: [...watched], commitment: options.commitment, metadata: options.metadata, onMigration, onStatus: options.onStatus }); }
  catch (error) { await subscription.close(); throw error; }
  const close = async () => {
    if (stopped) return;
    stopped = true; options.signal?.removeEventListener("abort", abort);
    await serial(async () => { await Promise.all([subscription.close(), migrations?.close()]); watched.clear(); });
  };
  const abort = () => { void close(); };
  if (options.signal?.aborted) await close();
  else options.signal?.addEventListener("abort", abort, { once: true });
  return {
    add: (tokens) => serial(async () => { if (stopped) throw new Error("Trade listener is closed"); const values = typeof tokens === "string" ? [tokens] : [...tokens]; await subscription.addTokens(values); await migrations!.addTokens(values); values.forEach(token => watched.add(token)); }),
    remove: (tokens) => serial(async () => { const values = typeof tokens === "string" ? [tokens] : [...tokens]; values.forEach(token => { watched.delete(token); lastPools.delete(token); }); await Promise.all([subscription.removeTokens(values), migrations!.removeTokens(values)]); }),
    has: (token) => !stopped && watched.has(token),
    list: () => stopped ? [] : [...watched],
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
    onMigration(callback) {
      migrationCallbacks.add(callback);
      if (pendingMigrations.length) { const rows = pendingMigrations.splice(0); void Promise.resolve().then(async () => { for (const event of rows) await callback(event); }); }
      return () => migrationCallbacks.delete(callback);
    },
    close,
    get closed() {
      return subscription.closed;
    },
  };
}
