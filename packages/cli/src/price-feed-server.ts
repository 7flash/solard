import { configure, createMeasure } from "measure-fn";
import { Connection } from "@solana/web3.js";
import {
  subscribeLaunches,
  subscribeTrades,
  type LaunchEvent,
  type TradeEvent,
  type TradeSubscription,
} from "@solard/sdk";
import type {
  PriceFeedCommand,
  PriceFeedLaunch,
  PriceFeedMessage,
  PriceFeedPrice,
} from "./price-feed-protocol.ts";

type Flags = Map<string, string>;
type Emit = (value: string) => void;
type Client = {
  mints: Set<string>;
  launches: boolean;
  allPrices: boolean;
};
type MintState = {
  supplyUi: number | null;
  isMayhemMode: boolean | null;
};

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

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
  if (!value) {
    throw new Error(
      "feed serve requires RPC_ENDPOINT, SOLANA_RPC_URL, HELIUS_RPC_URL, or --rpc <url>",
    );
  }
  return value;
}

function websocketUrl(flags: Flags): string | undefined {
  return (
    flag(flags, "ws") ??
    process.env.SOLANA_WS_URL?.trim() ??
    process.env.HELIUS_WS_URL?.trim()
  );
}

function feedAddress(flags: Flags): { host: string; port: number } {
  const host = flag(flags, "host") ?? "127.0.0.1";
  const port = Math.trunc(numberFlag(flags, "port", 8788));
  if (!(port > 0 && port <= 65_535)) throw new Error("--port must be 1..65535");
  return { host, port };
}

function publicEndpoint(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|auth/i.test(key)) {
        url.searchParams.set(key, "<redacted>");
      }
    }
    return url.toString();
  } catch {
    return value.replace(
      /([?&](?:api-?key|token|secret|auth)=)[^&]+/gi,
      "$1<redacted>",
    );
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("SOL/USD unavailable");
  }
  return value;
}

export async function runPriceFeedServerCommand(args: {
  flags: Flags;
  emit: Emit;
}): Promise<void> {
  configure({
    silent: false,
    logger(_event: unknown, next?: () => void) {
      next?.();
    },
  });
  const m = createMeasure("slrd:feed", { maxResultLength: 1600 });
  const report = <T extends Record<string, unknown>>(
    label: string,
    value: T,
  ): T =>
    m.sync({ start: () => label, end: (result: T) => result }, () => value);
  const { host, port } = feedAddress(args.flags);
  const rpc = rpcUrl(args.flags);
  const ws = websocketUrl(args.flags);
  const includeMayhem = args.flags.has("include-mayhem");
  const connection = new Connection(
    rpc,
    ws ? { commitment: "confirmed", wsEndpoint: ws } : "confirmed",
  );
  const controller = new AbortController();
  const clients = new Map<unknown, Client>();
  const launches = new Map<string, PriceFeedLaunch>();
  const latest = new Map<string, PriceFeedPrice>();
  const mintState = new Map<string, MintState>();
  const discoveredMints = new Set<string>();
  const explicitMintRefs = new Map<string, number>();
  let tradeSubscription: TradeSubscription | null = null;
  let allPriceClients = 0;
  let solUsd: number | null = null;
  let launchCount = 0;
  let tradeCount = 0;
  let priceCount = 0;
  let stopped = false;

  const send = (
    socket: { send(value: string): unknown },
    value: PriceFeedMessage,
  ): void => {
    try {
      socket.send(JSON.stringify(value));
    } catch {}
  };

  const broadcast = (value: PriceFeedMessage): void => {
    for (const [socket, client] of clients) {
      const target = socket as { send(value: string): unknown };
      if (value.type === "launch") {
        if (client.launches) send(target, value);
        continue;
      }
      if (value.type === "price") {
        if (client.allPrices || client.mints.has(value.mint))
          send(target, value);
        continue;
      }
      send(target, value);
    }
  };

  const shouldWatchMint = (mint: string): boolean =>
    (explicitMintRefs.get(mint) ?? 0) > 0 ||
    (allPriceClients > 0 && discoveredMints.has(mint));

  const syncMintSubscription = async (mint: string): Promise<void> => {
    if (!tradeSubscription) return;
    const watched = tradeSubscription.hasToken(mint);
    const desired = shouldWatchMint(mint);
    if (desired && !watched) await tradeSubscription.addTokens(mint);
    if (!desired && watched) await tradeSubscription.removeTokens(mint);
  };

  const syncDiscoveredSubscriptions = async (): Promise<void> => {
    await Promise.allSettled(
      [...discoveredMints].map((mint) => syncMintSubscription(mint)),
    );
  };

  const onLaunch = async (event: LaunchEvent): Promise<void> => {
    if (event.isMayhemMode === true && !includeMayhem) return;
    const value: PriceFeedLaunch = {
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
    mintState.set(event.mint, {
      supplyUi: event.supplyUi,
      isMayhemMode: event.isMayhemMode,
    });
    launches.set(event.mint, value);
    discoveredMints.add(event.mint);
    launchCount += 1;
    broadcast(value);
    await syncMintSubscription(event.mint);
  };

  const onTrade = (event: TradeEvent): void => {
    tradeCount += 1;
    if (event.priceQuote == null) return;
    const state = mintState.get(event.mint);
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
    const value: PriceFeedPrice = {
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
  };

  const updateExplicitMintRef = async (
    mint: string,
    delta: 1 | -1,
  ): Promise<void> => {
    const next = Math.max(0, (explicitMintRefs.get(mint) ?? 0) + delta);
    if (next === 0) explicitMintRefs.delete(mint);
    else explicitMintRefs.set(mint, next);
    await syncMintSubscription(mint);
  };

  const enableAllPrices = async (client: Client): Promise<void> => {
    if (client.allPrices) return;
    client.allPrices = true;
    allPriceClients += 1;
    if (allPriceClients === 1) await syncDiscoveredSubscriptions();
  };

  const disableAllPrices = async (client: Client): Promise<void> => {
    if (!client.allPrices) return;
    client.allPrices = false;
    allPriceClients = Math.max(0, allPriceClients - 1);
    if (allPriceClients === 0) await syncDiscoveredSubscriptions();
  };

  const applyCommand = async (
    socket: unknown,
    command: PriceFeedCommand,
  ): Promise<void> => {
    const client = clients.get(socket);
    if (!client) return;
    const target = socket as { send(value: string): unknown };
    if (command.op === "ping") {
      send(target, { type: "status", atMs: Date.now(), event: "pong" });
      return;
    }
    const mints: string[] = [...new Set((command.mints ?? []).filter(Boolean))];
    if (command.op === "subscribe") {
      if (command.launches === true && !client.launches) {
        client.launches = true;
        for (const value of launches.values()) send(target, value);
      }
      if (command.allPrices === true && !client.allPrices) {
        await enableAllPrices(client);
        for (const value of latest.values()) send(target, value);
      }
      for (const mint of mints) {
        if (!client.mints.has(mint)) {
          client.mints.add(mint);
          await updateExplicitMintRef(mint, 1);
        }
        const value = latest.get(mint);
        if (value) send(target, value);
      }
      return;
    }
    for (const mint of mints) {
      if (!client.mints.delete(mint)) continue;
      await updateExplicitMintRef(mint, -1);
    }
  };

  const releaseClient = async (socket: unknown): Promise<void> => {
    const client = clients.get(socket);
    clients.delete(socket);
    if (!client) return;
    await disableAllPrices(client);
    await Promise.allSettled(
      [...client.mints].map((mint) => updateExplicitMintRef(mint, -1)),
    );
  };

  tradeSubscription = await subscribeTrades({
    connection,
    tokens: [],
    commitment: "confirmed",
    metadata: false,
    signal: controller.signal,
    onTrade,
    onStatus(event, data) {
      report(`trades ${event}`, data ?? {});
    },
  });
  const launchSubscription = await subscribeLaunches({
    connection,
    commitment: "confirmed",
    metadata: false,
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
          launchCount,
          tradeCount,
          priceCount,
          cachedLaunches: launches.size,
          latestPrices: latest.size,
          discoveredMints: discoveredMints.size,
          explicitMints: explicitMintRefs.size,
          allPriceClients,
          watchedTokens: tradeSubscription?.listTokens().length ?? 0,
          solUsd,
        });
      }
      return new Response("Solard price feed\n");
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
            JSON.parse(String(message)) as PriceFeedCommand,
          ).catch((error) => {
            send(socket, {
              type: "status",
              atMs: Date.now(),
              event: "client-error",
              data: { error: errorText(error) },
            });
          });
        } catch (error) {
          send(socket, {
            type: "status",
            atMs: Date.now(),
            event: "client-error",
            data: { error: errorText(error) },
          });
        }
      },
      close(socket) {
        void releaseClient(socket);
      },
    },
  });

  const refreshSolUsd = async (): Promise<void> => {
    try {
      solUsd = await loadSolUsd();
    } catch (error) {
      report("sol/usd unavailable", {
        error: errorText(error),
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
        launchCount,
        tradeCount,
        priceCount,
        cachedLaunches: launches.size,
        latestPrices: latest.size,
        discoveredMints: discoveredMints.size,
        explicitMints: explicitMintRefs.size,
        allPriceClients,
        watchedTokens: tradeSubscription?.listTokens().length ?? 0,
        solUsd,
      }),
    Math.max(1_000, Math.trunc(numberFlag(args.flags, "heartbeat-ms", 15_000))),
  );

  report("ready", {
    url: `ws://${host}:${server.port}/ws`,
    health: `http://${host}:${server.port}/health`,
    rpc: publicEndpoint(rpc),
    ws: ws ? publicEndpoint(ws) : "connection-default",
    includeMayhem,
  });

  const stop = (): void => {
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
      launchCount,
      tradeCount,
      priceCount,
      clients: clients.size,
    });
  }
}
