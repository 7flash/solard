#!/usr/bin/env bun
import { configure, createMeasure } from "measure-fn";
import { Connection } from "@solana/web3.js";
import {
  subscribeLaunches,
  subscribeTrades,
  type LaunchEvent,
  type TradeEvent,
  type TradeSubscription,
} from "@solard/sdk";

type Flags = Map<string, string>;
type FeedVenue = "pump" | "pumpswap" | "raydium-launchlab";
type FeedLaunch = {
  type: "launch";
  atMs: number;
  signature: string | null;
  slot: number | null;
  mint: string;
  venue: "pump" | "raydium-launchlab";
  decimals: number;
  supplyUi: number;
  quoteMint: string | null;
  pool: string | null;
  name: string | null;
  symbol: string | null;
  isMayhemMode: boolean | null;
};
type FeedPrice = {
  type: "price";
  atMs: number;
  signature: string | null;
  slot: number | null;
  mint: string;
  venue: FeedVenue;
  priceSol: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  source: string;
};
type FeedStatus = {
  type: "status";
  atMs: number;
  event: string;
  data?: Record<string, unknown>;
};
type FeedMessage = FeedLaunch | FeedPrice | FeedStatus;
type FeedCommand =
  | {
      op: "subscribe";
      mints?: string[];
      launches?: boolean;
      allPrices?: boolean;
    }
  | { op: "unsubscribe"; mints?: string[] }
  | { op: "ping" };
type Client = {
  mints: Set<string>;
  launches: boolean;
  allPrices: boolean;
};
type MintState = {
  supplyUi: number;
  isMayhemMode: boolean | null;
};

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

configure({ silent: false });
const m = createMeasure("slrd:example-price-feed", { maxResultLength: 1600 });

function parseArgs(argv: string[]): Flags {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
    if (inline != null) flags.set(key!, inline);
    else if (argv[index + 1] && !argv[index + 1]!.startsWith("--"))
      flags.set(key!, argv[++index]!);
    else flags.set(key!, "true");
  }
  return flags;
}

function flag(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return value && value !== "true" ? value : undefined;
}

function numberFlag(flags: Flags, key: string, fallback: number): number {
  const raw = flag(flags, key);
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid --${key}: ${raw}`);
  return value;
}

function rpcUrl(flags: Flags): string {
  const value =
    flag(flags, "rpc") ??
    process.env.RPC_ENDPOINT?.trim() ??
    process.env.SOLANA_RPC_URL?.trim() ??
    process.env.HELIUS_RPC_URL?.trim();
  if (!value)
    throw new Error(
      "Missing --rpc, RPC_ENDPOINT, SOLANA_RPC_URL, or HELIUS_RPC_URL",
    );
  return value;
}

function wsUrl(flags: Flags): string | undefined {
  return (
    flag(flags, "ws") ??
    process.env.SOLANA_WS_URL?.trim() ??
    process.env.HELIUS_WS_URL?.trim()
  );
}

function report<T extends Record<string, unknown>>(label: string, value: T): T {
  return m.sync(
    { start: () => label, end: (result: T) => result },
    () => value,
  );
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadSolUsd(): Promise<number> {
  try {
    const raw = (await fetchJson(
      "https://api.coinbase.com/v2/prices/SOL-USD/spot",
    )) as { data?: { amount?: unknown } };
    const value = Number(raw.data?.amount);
    if (Number.isFinite(value) && value > 0) return value;
  } catch {}
  const raw = (await fetchJson(
    "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
  )) as { solana?: { usd?: unknown } };
  const value = Number(raw.solana?.usd);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("SOL/USD unavailable");
  return value;
}

const flags = parseArgs(process.argv.slice(2));
const host = flag(flags, "host") ?? "127.0.0.1";
const port = Math.trunc(numberFlag(flags, "port", 8788));
if (!(port > 0 && port <= 65_535)) throw new Error("--port must be 1..65535");
const rpc = rpcUrl(flags);
const ws = wsUrl(flags);
const includeMayhem = flags.has("include-mayhem");
const connection = new Connection(
  rpc,
  ws ? { commitment: "confirmed", wsEndpoint: ws } : "confirmed",
);
const clients = new Map<unknown, Client>();
const launches = new Map<string, FeedLaunch>();
const latest = new Map<string, FeedPrice>();
const mints = new Map<string, MintState>();
const discoveredMints = new Set<string>();
const mintRefs = new Map<string, number>();
let tradeSubscription: TradeSubscription | null = null;
let solUsd: number | null = null;
let launchCount = 0;
let tradeCount = 0;
let priceCount = 0;
let stopped = false;

function send(
  socket: { send(value: string): unknown },
  value: FeedMessage,
): void {
  try {
    socket.send(JSON.stringify(value));
  } catch {}
}

function broadcast(value: FeedMessage): void {
  for (const [socket, client] of clients) {
    const target = socket as { send(value: string): unknown };
    if (value.type === "launch") {
      if (client.launches) send(target, value);
    } else if (value.type === "price") {
      if (client.allPrices || client.mints.has(value.mint)) send(target, value);
    } else send(target, value);
  }
}

function onLaunch(event: LaunchEvent): void {
  if (event.isMayhemMode === true && !includeMayhem) return;
  const value: FeedLaunch = {
    type: "launch",
    atMs: event.atMs,
    signature: event.signature,
    slot: event.slot,
    mint: event.mint,
    venue: event.venue,
    decimals: event.decimals,
    supplyUi: event.supplyUi,
    quoteMint: event.quoteMint,
    pool: event.pool,
    name: event.name,
    symbol: event.symbol,
    isMayhemMode: event.isMayhemMode,
  };
  mints.set(event.mint, {
    supplyUi: event.supplyUi,
    isMayhemMode: event.isMayhemMode,
  });
  launches.set(event.mint, value);
  discoveredMints.add(event.mint);
  void tradeSubscription?.addTokens(event.mint);
  launchCount += 1;
  broadcast(value);
}

function onTrade(event: TradeEvent): void {
  tradeCount += 1;
  if (event.priceQuote == null) return;
  const state = mints.get(event.mint);
  if (state?.isMayhemMode === true && !includeMayhem) return;
  let priceSol: number | null = null;
  let priceUsd: number | null = null;
  if (event.quoteMint === WSOL_MINT) {
    priceSol = event.priceQuote;
    priceUsd = solUsd == null ? null : event.priceQuote * solUsd;
  } else if (event.quoteMint === USDC_MINT) {
    priceUsd = event.priceQuote;
    priceSol = solUsd == null ? null : event.priceQuote / solUsd;
  }
  const value: FeedPrice = {
    type: "price",
    atMs: event.atMs,
    signature: event.signature,
    slot: event.slot,
    mint: event.mint,
    venue: event.venue,
    priceSol,
    priceUsd,
    marketCapUsd:
      priceUsd != null && state?.supplyUi != null
        ? priceUsd * state.supplyUi
        : null,
    source: `${event.venue}-trade-event`,
  };
  latest.set(event.mint, value);
  priceCount += 1;
  broadcast(value);
}

async function updateMintRef(mint: string, delta: 1 | -1): Promise<void> {
  const next = Math.max(0, (mintRefs.get(mint) ?? 0) + delta);
  if (next === 0) mintRefs.delete(mint);
  else mintRefs.set(mint, next);
  if (!tradeSubscription) return;
  if (next > 0) await tradeSubscription.addTokens(mint);
  else if (!discoveredMints.has(mint))
    await tradeSubscription.removeTokens(mint);
}

async function applyCommand(
  socket: unknown,
  command: FeedCommand,
): Promise<void> {
  const client = clients.get(socket);
  if (!client) return;
  if (command.op === "ping") {
    send(socket as { send(value: string): unknown }, {
      type: "status",
      atMs: Date.now(),
      event: "pong",
    });
    return;
  }
  const rows = (command.mints ?? []).filter(Boolean);
  if (command.op === "subscribe") {
    if (command.launches === true && !client.launches) {
      client.launches = true;
      for (const value of launches.values())
        send(socket as { send(value: string): unknown }, value);
    }
    if (command.allPrices === true && !client.allPrices) {
      client.allPrices = true;
      for (const value of latest.values())
        send(socket as { send(value: string): unknown }, value);
    }
    for (const mint of rows) {
      if (!client.mints.has(mint)) {
        client.mints.add(mint);
        await updateMintRef(mint, 1);
      }
      const value = latest.get(mint);
      if (value) send(socket as { send(value: string): unknown }, value);
    }
    return;
  }
  for (const mint of rows) {
    if (!client.mints.delete(mint)) continue;
    await updateMintRef(mint, -1);
  }
}

async function releaseClient(socket: unknown): Promise<void> {
  const client = clients.get(socket);
  clients.delete(socket);
  if (!client) return;
  for (const mint of client.mints) await updateMintRef(mint, -1);
}

const controller = new AbortController();
tradeSubscription = await subscribeTrades({
  connection,
  tokens: [],
  signal: controller.signal,
  onTrade,
  onStatus(event, data) {
    report(`trades ${event}`, data ?? {});
  },
});
const launchSubscription = await subscribeLaunches({
  connection,
  signal: controller.signal,
  onLaunch,
  onStatus(event, data) {
    report(`launches ${event}`, data ?? {});
  },
});

const server = Bun.serve({
  hostname: host,
  port,
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(request);
      return upgraded
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        clients: clients.size,
        launches: launchCount,
        trades: tradeCount,
        prices: priceCount,
        cachedLaunches: launches.size,
        latestPrices: latest.size,
        watchedTokens: tradeSubscription?.listTokens().length ?? 0,
        solUsd,
      });
    }
    return new Response("Solard price feed example\n");
  },
  websocket: {
    open(socket) {
      clients.set(socket, {
        mints: new Set(),
        launches: false,
        allPrices: false,
      });
      send(socket, { type: "status", atMs: Date.now(), event: "ready" });
    },
    message(socket, message) {
      try {
        void applyCommand(
          socket,
          JSON.parse(String(message)) as FeedCommand,
        ).catch((error) => {
          send(socket, {
            type: "status",
            atMs: Date.now(),
            event: "client-error",
            data: {
              error: error instanceof Error ? error.message : String(error),
            },
          });
        });
      } catch (error) {
        send(socket, {
          type: "status",
          atMs: Date.now(),
          event: "client-error",
          data: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    },
    close(socket) {
      void releaseClient(socket);
    },
  },
});

const refreshSolUsd = async () => {
  try {
    solUsd = await loadSolUsd();
  } catch (error) {
    report("sol/usd unavailable", {
      error: error instanceof Error ? error.message : String(error),
      cached: solUsd,
    });
  }
};

await refreshSolUsd();
const solTimer = setInterval(() => void refreshSolUsd(), 60_000);
const heartbeat = setInterval(
  () =>
    report("heartbeat", {
      clients: clients.size,
      launches: launchCount,
      trades: tradeCount,
      prices: priceCount,
      cachedLaunches: launches.size,
      latestPrices: latest.size,
      watchedTokens: tradeSubscription?.listTokens().length ?? 0,
      solUsd,
    }),
  Math.max(1_000, Math.trunc(numberFlag(flags, "heartbeat-ms", 15_000))),
);

report("ready", {
  url: `ws://${host}:${server.port}/ws`,
  health: `http://${host}:${server.port}/health`,
  rpc,
  ws: ws ?? "connection-default",
  includeMayhem,
});

const stop = () => {
  if (stopped) return;
  stopped = true;
  controller.abort();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await Promise.all([launchSubscription.closed, tradeSubscription.closed]);
} finally {
  clearInterval(solTimer);
  clearInterval(heartbeat);
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await launchSubscription.close();
  await tradeSubscription.close();
  server.stop(true);
  report("stopped", {
    launches: launchCount,
    trades: tradeCount,
    prices: priceCount,
  });
}
