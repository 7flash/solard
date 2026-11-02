import { Connection } from "@solana/web3.js";
import {
  resolveRpcPacer,solardRpcFetch,
  subscribeLaunches as subscribeCoreLaunches,
  subscribeMigrations as subscribeCoreMigrations,
  subscribeTrades as subscribeCoreTrades,
  type TradeEvent,
  type TradeSubscription,
  type MigrationEvent,
  createLiveTradeHistoryRecorder,
  type LiveTradeHistoryOptions,
} from "@solard/core";

export type LiveEndpointOptions = import('@solard/core').EventSourceOptions & {
  rpc?: import('@solard/core').RpcPacingOptions | import('@solard/core').RpcPacer;
  fetch?: import('@solana/web3.js').FetchFn;
  /** Ordered endpoints on the same cluster; public RPC can be supplied last. */
  rpcUrls?: readonly string[];
  websocketUrls?: readonly string[];
  /** Fresh HTTP and WebSocket readiness probes for pooled trade streams (default 30s). */
  healthCheckIntervalMs?: number;
};
export type SubscribeLaunchesOptions = Omit<
  Parameters<typeof subscribeCoreLaunches>[0],
  "connection"
> &
  LiveEndpointOptions;
export type SubscribeMigrationsOptions = Omit<
  Parameters<typeof subscribeCoreMigrations>[0],
  "connection"
> &
  LiveEndpointOptions;
/** Applications must explicitly revalidate fresh on-chain pool/mint state.
 * Returning true asserts current state only, not historical coverage. */
export type FeedRecoveryVerification = (input: {
  connection: Connection; tokens: readonly string[]; signal: AbortSignal;
}) => Promise<boolean>;
export type RecoverableTradeSubscription = TradeSubscription & {
  readonly feedVerified: boolean;
  verifyAndResume(verify: FeedRecoveryVerification, timeoutMs?: number): Promise<boolean>;
};
export type SubscribeTradesOptions = Omit<
  Parameters<typeof subscribeCoreTrades>[0],
  "connection"
> &
  LiveEndpointOptions;

export type ListenTradesOptions = Omit<SubscribeTradesOptions, "onTrade"> & {
  dbPath?: string;
  /** Enabled by default; collected live history is partial and retains commitment. */
  history?:
    | false
    | Pick<
        LiveTradeHistoryOptions,
        "flushIntervalMs" | "batchSize" | "maxPending"
      >;
};

export type TradeListener = {
  add(tokens: string | readonly string[]): Promise<void>;
  remove(tokens: string | readonly string[]): Promise<void>;
  has(token: string): boolean;
  list(): string[];
  onTrade(callback: (event: TradeEvent) => void | Promise<void>): () => void;
  onMigration(
    callback: (event: TradeListenerMigration) => void | Promise<void>,
  ): () => void;
  close(): Promise<void>;
  readonly closed: Promise<void>;
  readonly feedVerified: boolean;
  verifyAndResume(verify: FeedRecoveryVerification, timeoutMs?: number): Promise<boolean>;
};
export type TradeListenerMigration = MigrationEvent & {
  oldPool: string | null;
  newPool: string;
};

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
  constructor(
    endpoints: readonly string[],
    private readonly probe: (endpoint: string) => Promise<void> = async (
      endpoint,
    ) => {
      await Promise.all([preflightRpc(endpoint), preflightWebSocket(endpoint)]);
    },
  ) {
    this.endpoints = [...new Set(endpoints)];
    if (!this.endpoints.length)
      throw new Error("Live RPC endpoint pool cannot be empty");
    for (const endpoint of this.endpoints) deriveWebSocketEndpoint(endpoint);
  }
  get endpoint(): string {
    return this.endpoints[this.active]!;
  }
  async select(skipCurrent = false): Promise<string> {
    const start = this.active;
    let lastError: unknown;
    for (
      let offset = skipCurrent ? 1 : 0;
      offset < this.endpoints.length + (skipCurrent ? 1 : 0);
      offset++
    ) {
      const index = (start + offset) % this.endpoints.length;
      try {
        await this.probe(this.endpoints[index]!);
        this.active = index;
        return this.endpoint;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
  async check(): Promise<string> {
    try {
      await this.probe(this.endpoint);
      return this.endpoint;
    } catch {
      return await this.select(true);
    }
  }
}
const livePools = new Map<string, LiveEndpointPool>();
const transportIds=new WeakMap<object,number>();let transportId=0;
const defaultRpcFetch=solardRpcFetch as unknown as import('@solana/web3.js').FetchFn;
function rpcFetch(options:LiveEndpointOptions={}):import('@solana/web3.js').FetchFn{
 return options.rpc||options.fetch?resolveRpcPacer(options.rpc,options.fetch).fetch:defaultRpcFetch;
}
function endpointPool(
  options: LiveEndpointOptions,
): LiveEndpointPool | undefined {
  const env = process.env.SLRD_RPC_URLS;
  const urls = options.rpcUrls ?? (env ? JSON.parse(env) as string[] :
    wsCandidates(options).length ? [endpointFromEnv()] : []);
  if (!urls.length) return undefined;
  const transport=rpcFetch(options);
  if(!transportIds.has(transport))transportIds.set(transport,++transportId);
  const key = JSON.stringify([urls, options.websocketUrls ?? process.env.SLRD_WS_URLS,transportIds.get(transport)]);
  let pool = livePools.get(key);
  if (!pool) {
    pool = new LiveEndpointPool(urls,async endpoint=>{
      await preflightRpc(endpoint,transport);
      if(!wsCandidates(options).length)await preflightWebSocket(endpoint);
    });
    livePools.set(key, pool);
  }
  return pool;
}
function wsCandidates(options: LiveEndpointOptions): string[] {
  const fallback = process.env.SLRD_WS_URLS ? JSON.parse(process.env.SLRD_WS_URLS) as unknown : [];
  const urls = options.websocketUrls ?? fallback;
  if (!Array.isArray(urls) || !urls.every(value => typeof value === "string" && /^wss?:\/\//.test(value)))
    throw new Error("Invalid WebSocket endpoint list");
  return [...new Set(urls)] as string[];
}
function connectionFor(endpoint: string, ws = deriveWebSocketEndpoint(endpoint),options:LiveEndpointOptions={}): LiveConnection {
  return { endpoint, websocketEndpoint: ws,
    connection: new Connection(endpoint, { commitment: "confirmed", wsEndpoint: ws,
      disableRetryOnRateLimit: true,fetch:rpcFetch(options) }) };
}

/** SQD needs no WebSocket handshake. This Connection is used only for verified
 * account metadata/conversion and protocol-specific transaction enrichment. */
function sqdReadConnection(options: LiveEndpointOptions): LiveConnection {
  const configured = options.rpcUrls ?? (process.env.SLRD_RPC_URLS ? JSON.parse(process.env.SLRD_RPC_URLS) as string[] : []);
  return connectionFor(configured[0] ?? process.env.RPC_ENDPOINT?.trim() ?? "https://api.mainnet-beta.solana.com", undefined, options);
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
  try { const url = new URL(endpoint); return `${url.protocol}//${url.host}/***`; }
  catch { return "<invalid RPC endpoint>"; }
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
  return value.replace(/(?:https?|wss?):\/\/[^\s]+/gi, redactRpcEndpoint).slice(0,400);
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

async function preflightRpc(endpoint: string,transport:import('@solana/web3.js').FetchFn=defaultRpcFetch): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await transport(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }),
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
    if (body.result !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d")
      throw rpcFailure(endpoint, "Non-mainnet genesis hash");
    const account = await transport(endpoint, { method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "getBalance",
        params: ["11111111111111111111111111111111"] }) });
    if (!account.ok) throw rpcFailure(endpoint, `Balance HTTP ${account.status}`);
    const balance = await account.json() as { error?: unknown; result?: { context?: {slot?:number}; value?:number } };
    if (balance.error || !Number.isFinite(balance.result?.context?.slot) || !Number.isFinite(balance.result?.value))
      throw rpcFailure(endpoint, "Balance reads unavailable");
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
  const websocketEndpoint = /^wss?:\/\//.test(endpoint) ? endpoint : deriveWebSocketEndpoint(endpoint);
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
    socket.addEventListener("open", () => {
      try { socket?.send(JSON.stringify({ jsonrpc: "2.0", id: 71, method: "slotSubscribe" })); }
      catch { finish(websocketFailure(endpoint, "Subscription send failed")); }
    }, { once: true });
    socket.addEventListener("message", event => {
      try { const packet = JSON.parse(String(event.data)) as { id?: number; result?: number; error?: unknown };
        if (packet.id !== 71) return;
        if (packet.error || !Number.isSafeInteger(packet.result)) {
          finish(websocketFailure(endpoint, "Subscription was rejected")); return;
        }
        try { socket?.send(JSON.stringify({ jsonrpc: "2.0", id: 72,
          method: "slotUnsubscribe", params: [packet.result] })); } catch {}
        finish(); try { socket?.close(1000); } catch {}
      } catch { finish(websocketFailure(endpoint, "Malformed subscription reply")); }
    });
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

async function liveConnection(
  options: LiveEndpointOptions = {},
): Promise<LiveConnection> {
  const pool = endpointPool(options);
  const endpoint = pool ? await pool.select() : endpointFromEnv();
  const independent = wsCandidates(options);
  if (independent.length) {
    await preflightRpc(endpoint,rpcFetch(options));
    let last: unknown;
    for (const ws of independent) {
      try { await preflightWebSocket(ws); return connectionFor(endpoint, ws,options); }
      catch (error) { last = error; }
    }
    throw last ?? new Error("No usable WSS endpoint");
  }
  if (pool) return connectionFor(endpoint,undefined,options);
  if(options.rpc||options.fetch){await preflightRpc(endpoint,rpcFetch(options));await preflightWebSocket(endpoint);return connectionFor(endpoint,undefined,options);}
  await ensureReady(endpoint);
  if (shared?.endpoint === endpoint) return shared;
  shared = connectionFor(endpoint);
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

export async function subscribeTrades(options: SubscribeTradesOptions): Promise<RecoverableTradeSubscription> {
  if (options.signal?.aborted) throw new DOMException("Trade subscription cancelled", "AbortError");
  const useRpc = options.source === "rpc";
  let live = useRpc ? await liveConnection(options) : sqdReadConnection(options);
  if (useRpc) notifyReady(options, live);
  const pool = useRpc ? endpointPool(options) ?? new LiveEndpointPool([live.endpoint],async endpoint=>{
    await preflightRpc(endpoint,rpcFetch(options));await preflightWebSocket(endpoint);
  }) : undefined;
  // Keep duplicate suppression across connection changes. Provider probes detect
  // dead credentials/quota; they cannot diagnose a silent old socket when a new
  // handshake to that provider remains healthy.
  const seen = new Set<string>();
  let gapUnverified = false;
  let lastAcceptedAt = Date.now();
  let lastSourceProgressAt = 0;
  const progressMaxAgeMs = !useRpc && options.commitment && options.commitment !== "processed" && options.commitment !== "recent" ? 120_000 : 30_000;
  const transportLastActiveAt = () => useRpc ? lastAcceptedAt : lastSourceProgressAt;
  const observeStatus = (event: string, data?: Record<string, unknown>) => {
    if (event === "feed-gap-unverified") invalidate();
    if (!useRpc && event === "source-progress" && typeof data?.atMs === "number" &&
        Number.isFinite(data.atMs) && Date.now() - data.atMs <= progressMaxAgeMs && data.atMs <= Date.now() + 10_000)
      lastSourceProgressAt = Date.now();
    options.onStatus?.(event, data);
  };
  let generation = 0;
  const recoveries = new Set<AbortController>();
  const invalidate = () => { gapUnverified = true; generation++; };
  const onTrade = async (event: TradeEvent) => {
    const activeAt = transportLastActiveAt();
    if (!gapUnverified && activeAt !== 0 && Date.now() - activeAt >= 60_000) invalidate();
    if (gapUnverified || !Number.isFinite(event.atMs) || Date.now() - event.atMs > progressMaxAgeMs || event.atMs > Date.now() + 10_000) {
      try { options.onStatus?.("feed-stale", { reason: gapUnverified ? "gap-unverified" : "event-outside-live-window" }); } catch {}
      return;
    }
    const key = [
      event.signature,
      event.venue,
      event.mint,
      event.pool,
      event.logIndex == null ? event.eventIndex ?? `${event.side}:${event.baseRaw}:${event.quoteRaw}` : `log:${event.logIndex}`,
    ].join(":");
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 4096) seen.delete(seen.values().next().value!);
    lastAcceptedAt = Date.now();
    await options.onTrade(event);
  };
  let subscription = await subscribeCoreTrades({
    ...options,
    signal: useRpc ? undefined : options.signal,
    onTrade,
    onStatus: observeStatus,
    connection: live.connection,
  });
  let stopped = false;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const pending = tail.then(work, work);
    tail = pending.catch(() => undefined);
    return pending;
  };
  let settle!: () => void;
  const closed = new Promise<void>((resolve) => {
    settle = resolve;
  });
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
      const activeAt = transportLastActiveAt();
      if (!gapUnverified && activeAt !== 0 && Date.now() - activeAt >= 60_000) {
        invalidate();
        try { options.onStatus?.("feed-gap-unverified", {
          reason: useRpc ? "no-recent-accepted-trades" : "no-recent-source-progress", historyComplete: false,
        }); } catch {}
      }
      try {
        if (!pool) return;
        const endpoint = await pool.check();
        const independent = wsCandidates(options);
        let ws = independent.length ? live.websocketEndpoint : deriveWebSocketEndpoint(endpoint);
        if (independent.length) {
          try { await preflightWebSocket(ws); }
          catch {
            const candidates = independent.filter(candidate => candidate !== ws);
            let found = false;
            for (const candidate of candidates) {
              try { await preflightWebSocket(candidate); ws = candidate; found = true; break; }
              catch {}
            }
            if (!found) throw new Error("All independent WebSocket endpoints are unavailable");
          }
        }
        if (stopped || (endpoint === live.endpoint && ws === live.websocketEndpoint)) return;
        invalidate();
        try { options.onStatus?.("feed-gap-unverified", { endpoint: redactRpcEndpoint(endpoint),
          websocket: redactRpcEndpoint(ws) }); } catch {}
        const tokens = subscription.listTokens();
        const nextLive = connectionFor(endpoint, ws,options);
        const next = await subscribeCoreTrades({
          ...options,
          signal: undefined,
          tokens,
          onTrade,
          onStatus: observeStatus,
          connection: nextLive.connection,
        });
        const previous = subscription;
        subscription = next;
        trackClosure(next);
        await previous.close();
        live = nextLive;
        notifyReady(options, live);
      } catch (error) {
        invalidate();
        try {
          options.onStatus?.("feed-gap-unverified", { reason: "provider-readiness-failed", historyComplete: false });
          options.onStatus?.("rpc-unavailable", { error: safeMessage(error) });
        } catch {}
      }
    }).finally(() => {
      checking = false;
    });
  }, Math.trunc(requestedInterval));
  timer.unref?.();
  const close = async () => {
    if (stopped) return await closed;
    stopped = true;
    invalidate();
    for (const controller of recoveries) controller.abort();
    clearInterval(timer);
    options.signal?.removeEventListener("abort", abort);
    await serial(async () => {
      await subscription.close();
      settle();
    });
  };
  const abort = () => {
    void close();
  };
  const trackClosure = (current: TradeSubscription) => {
    void current.closed.then(() => { if (!stopped && current === subscription) void close(); });
  };
  trackClosure(subscription);
  if (options.signal?.aborted) await close();
  else options.signal?.addEventListener("abort", abort, { once: true });
  return {
    addTokens: (tokens: string | readonly string[]) => {
      const values = typeof tokens === "string" ? [tokens] : tokens;
      if (values.some(token => !subscription.hasToken(token))) invalidate();
      return serial(async () => {
        if (stopped) throw new Error("Trade subscription is closed");
        await subscription.addTokens(tokens);
      });
    },
    removeTokens: (tokens: string | readonly string[]) => {
      const values = typeof tokens === "string" ? [tokens] : tokens;
      if (values.some(token => subscription.hasToken(token))) invalidate();
      return serial(async () => {
        if (!stopped) await subscription.removeTokens(tokens);
      });
    },
    hasToken: (token: string) => !stopped && subscription.hasToken(token),
    listTokens: () => (stopped ? [] : subscription.listTokens()),
    get feedVerified() { return !stopped && !gapUnverified &&
      transportLastActiveAt() !== 0 && Date.now() - transportLastActiveAt() < 60_000; },
    verifyAndResume: (verify: FeedRecoveryVerification, timeoutMs = 5000) => {
      if (stopped) return Promise.reject(new Error("Trade subscription is closed"));
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
        return Promise.reject(new Error("Recovery timeout must be 1..30000ms"));
      // The deadline includes time queued behind health checks or token edits.
      invalidate();
      const expected = generation;
      const controller = new AbortController();
      recoveries.add(controller);
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) controller.abort();
      let rejectAbort!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new Error("Feed verification cancelled or timed out"));
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
        if (controller.signal.aborted) rejectAbort();
      });
      const pending = serial(async () => {
        if (controller.signal.aborted) throw new Error("Feed verification cancelled or timed out");
        if (stopped) throw new Error("Trade subscription is closed");
        if (generation !== expected) return false;
        const verified = await Promise.race([
          Promise.resolve().then(() => verify({ connection: live.connection,
            tokens: subscription.listTokens(), signal: controller.signal })), cancelled,
        ]);
        if (verified !== true || stopped || generation !== expected || controller.signal.aborted) return false;
        gapUnverified = false;
        lastAcceptedAt = Date.now();
        try { options.onStatus?.("feed-fresh-state-verified", { historyComplete: false }); } catch {}
        return true;
      });
      return Promise.race([pending, cancelled]).finally(() => {
        clearTimeout(timeout); recoveries.delete(controller);
        controller.signal.removeEventListener("abort", rejectAbort);
        options.signal?.removeEventListener("abort", onAbort);
      });
    },
    close,
    closed,
  } satisfies RecoverableTradeSubscription;
}

export async function subscribeLaunches(options: SubscribeLaunchesOptions) {
  const live = options.source === "rpc" ? await liveConnection(options) : sqdReadConnection(options);
  if (options.source === "rpc") notifyReady(options, live);
  return await subscribeCoreLaunches({
    ...options,
    connection: live.connection,
  });
}

export async function subscribeMigrations(options: SubscribeMigrationsOptions) {
  const live = options.source === "rpc" ? await liveConnection(options) : sqdReadConnection(options);
  if (options.source === "rpc") notifyReady(options, live);
  return await subscribeCoreMigrations({
    ...options,
    connection: live.connection,
  });
}
export async function listenTrades(
  options: ListenTradesOptions,
): Promise<TradeListener> {
  const callbacks = new Set<(event: TradeEvent) => void | Promise<void>>();
  const history =
    options.history === false
      ? undefined
      : createLiveTradeHistoryRecorder({
          ...options.history,
          dbPath: options.dbPath,
          commitment: options.commitment,
          onStatus: options.onStatus,
        });
  const pending: TradeEvent[] = [];
  const migrationCallbacks = new Set<
    (event: TradeListenerMigration) => void | Promise<void>
  >();
  const pendingMigrations: TradeListenerMigration[] = [];
  const watched = new Set(options.tokens);
  const lastPools = new Map<string, string | null>();
  let subscription: RecoverableTradeSubscription;
  let migrations: Awaited<ReturnType<typeof subscribeMigrations>> | undefined;
  let stopped = false;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  void closed.catch(() => undefined);
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const job = tail.then(work, work);
    tail = job.catch(() => undefined);
    return job;
  };
  const onMigration = async (event: MigrationEvent) => {
    if (stopped || !watched.has(event.mint)) return;
    const migration = {
      ...event,
      oldPool: lastPools.get(event.mint) ?? null,
      newPool: event.pool,
    };
    lastPools.set(event.mint, event.pool);
    await serial(async () => {
      if (stopped || !watched.has(event.mint)) return;
      // Mint mentions cover the new pool; rebuilding resets cached identities,
      // decimals and supply without changing the caller's watched token list.
      await subscription.removeTokens(event.mint);
      await subscription.addTokens(event.mint);
    });
    if (!migrationCallbacks.size) {
      pendingMigrations.push(migration);
      if (pendingMigrations.length > 1000) pendingMigrations.shift();
    } else
      await Promise.all(
        [...migrationCallbacks].map((callback) => callback(migration)),
      );
  };
  const dispatch = async (event: TradeEvent) => {
    if (!watched.has(event.mint) || stopped) return;
    lastPools.set(event.mint, event.pool);
    try {
      await history?.record(event);
    } catch (error) {
      options.onStatus?.("history-persistence-error", {
        error: safeMessage(error),
      });
    }
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
    if (event === "feed-gap-unverified" || event === "feed-stale") pending.length = 0;
    if (event === "rpc-ready" && migrations && !stopped)
      void serial(async () => {
        if (stopped) return;
        const next = await subscribeMigrations({
          source: options.source, sqd: options.sqd,
          rpc:options.rpc,fetch:options.fetch,
          rpcUrls: options.rpcUrls,
          websocketUrls: options.websocketUrls,
          tokens: [...watched],
          commitment: options.commitment,
          metadata: options.metadata,
          onMigration,
          onStatus: options.onStatus,
        });
        const previous = migrations;
        migrations = next;
        trackMigrationClosure(next);
        await previous?.close();
      }).catch((error) =>
        options.onStatus?.("migration-resubscribe-error", {
          error: safeMessage(error),
        }),
      );
  };
  try {
    subscription = await subscribeTrades({
      ...options,
      signal: options.signal,
      onStatus,
      onTrade: dispatch,
    });
  } catch (error) {
    await history?.close();
    throw error;
  }
  try {
    migrations = await subscribeMigrations({
      source: options.source, sqd: options.sqd,
      signal: options.signal,
      rpc:options.rpc,fetch:options.fetch,
      rpcUrls: options.rpcUrls,
      websocketUrls: options.websocketUrls,
      tokens: [...watched],
      commitment: options.commitment,
      metadata: options.metadata,
      onMigration,
      onStatus: options.onStatus,
    });
  } catch (error) {
    await subscription.close();
    await history?.close();
    throw error;
  }
  const close = async () => {
    if (stopped) return await closed;
    stopped = true;
    options.signal?.removeEventListener("abort", abort);
    try {
      await serial(async () => {
        await Promise.all([subscription.close(), migrations?.close()]);
        watched.clear();
        pending.length = 0;
        pendingMigrations.length = 0;
        await history?.close();
      });
      resolveClosed();
    } catch (error) {
      rejectClosed(error);
      throw error;
    }
  };
  const abort = () => {
    void close();
  };
  void subscription.closed.then(() => { if (!stopped) void close(); });
  const trackMigrationClosure = (current: NonNullable<typeof migrations>) => {
    void current.closed.then(() => { if (!stopped && current === migrations) void close(); });
  };
  if (migrations) trackMigrationClosure(migrations);
  if (options.signal?.aborted) await close();
  else options.signal?.addEventListener("abort", abort, { once: true });
  return {
    add: (tokens) =>
      serial(async () => {
        if (stopped) throw new Error("Trade listener is closed");
        const values = typeof tokens === "string" ? [tokens] : [...tokens];
        await subscription.addTokens(values);
        await migrations!.addTokens(values);
        values.forEach((token) => watched.add(token));
      }),
    remove: (tokens) =>
      serial(async () => {
        const values = typeof tokens === "string" ? [tokens] : [...tokens];
        values.forEach((token) => {
          watched.delete(token);
          lastPools.delete(token);
        });
        await Promise.all([
          subscription.removeTokens(values),
          migrations!.removeTokens(values),
        ]);
      }),
    get feedVerified() { return !stopped && subscription.feedVerified === true; },
    verifyAndResume: (verify, timeoutMs) => subscription.verifyAndResume(verify, timeoutMs),
    has: (token) => !stopped && watched.has(token),
    list: () => (stopped ? [] : [...watched]),
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
      if (pendingMigrations.length) {
        const rows = pendingMigrations.splice(0);
        void Promise.resolve().then(async () => {
          for (const event of rows) await callback(event);
        });
      }
      return () => migrationCallbacks.delete(callback);
    },
    close,
    get closed() {
      return closed;
    },
  };
}
