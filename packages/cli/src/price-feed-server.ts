import { configure, createMeasure } from "measure-fn";
import slrd, { type TradeEvent, type TradeListener } from "@solard/sdk";
import type {
  PriceFeedCommand,
  PriceFeedMessage,
  PriceFeedPrice,
} from "./price-feed-protocol.ts";

type Flags = Map<string, string>;
type Emit = (value: string) => void;
type Client = { mints: Set<string> };

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

function feedAddress(flags: Flags): { host: string; port: number } {
  if (flags.has("rpc") || flags.has("ws")) {
    throw new Error(
      "Set only RPC_ENDPOINT in the environment. --rpc and --ws are intentionally unsupported.",
    );
  }
  const host = flag(flags, "host") ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("The trader price feed is loopback-only");
  }
  const port = Math.trunc(numberFlag(flags, "port", 8788));
  if (!(port > 0 && port <= 65_535)) throw new Error("--port must be 1..65535");
  return { host, port };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueMints(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("mints must be an array");
  return [...new Set(value.map((mint) => String(mint).trim()).filter(Boolean))];
}

function priceMessage(event: TradeEvent): PriceFeedPrice {
  return {
    type: "price",
    atMs: event.atMs,
    signature: event.signature,
    slot: event.slot,
    mint: event.mint,
    pool: event.pool,
    venue: event.venue,
    side: event.side,
    market: {
      quoteMint: event.market.quoteMint,
      baseDecimals: event.market.baseDecimals,
      quoteDecimals: event.market.quoteDecimals,
      supply: event.market.supply,
      baseReserve: event.market.baseReserve,
      quoteReserve: event.market.quoteReserve,
      priceQuotePerToken: event.market.priceQuotePerToken,
      marketCapQuote: event.market.marketCapQuote,
      priceSol: event.market.priceSol,
      marketCapSol: event.market.marketCapSol,
      solUsd: event.market.solUsd,
      solUsdSource: event.market.solUsdSource,
      solUsdAtMs: event.market.solUsdAtMs,
      priceUsd: event.market.priceUsd,
      marketCapUsd: event.market.marketCapUsd,
    },
  };
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
  const controller = new AbortController();
  const clients = new Map<unknown, Client>();
  const refs = new Map<string, number>();
  const latest = new Map<string, PriceFeedPrice>();
  let tradeSubscription: TradeListener | null = null;
  let tradeCount = 0;
  let stopped = false;
  let commandQueue = Promise.resolve();

  const send = (
    socket: { send(value: string): unknown },
    value: PriceFeedMessage,
  ): void => {
    try {
      socket.send(JSON.stringify(value));
    } catch {}
  };

  const status = (
    socket: { send(value: string): unknown },
    event: string,
    data?: Record<string, unknown>,
  ): void => send(socket, { type: "status", atMs: Date.now(), event, data });

  const onTrade = (event: TradeEvent): void => {
    tradeCount += 1;
    const value = priceMessage(event);
    latest.set(event.mint, value);
    for (const [socket, client] of clients) {
      if (!client.mints.has(event.mint)) continue;
      send(socket as { send(value: string): unknown }, value);
    }
  };

  const addRef = async (mint: string): Promise<void> => {
    const current = refs.get(mint) ?? 0;
    if (current === 0) {
      if (!tradeSubscription) throw new Error("Price feed is not ready");
      await tradeSubscription.add(mint);
    }
    refs.set(mint, current + 1);
  };

  const removeRef = async (mint: string): Promise<void> => {
    const current = refs.get(mint) ?? 0;
    if (current <= 0) return;
    if (current === 1) {
      refs.delete(mint);
      await tradeSubscription?.remove(mint);
      return;
    }
    refs.set(mint, current - 1);
  };

  const applyCommand = async (
    socket: unknown,
    command: PriceFeedCommand,
  ): Promise<void> => {
    const client = clients.get(socket);
    if (!client) return;
    const target = socket as { send(value: string): unknown };
    if (command.op === "ping") {
      status(target, "pong", {
        watchedMints: client.mints.size,
        upstreamMints: refs.size,
      });
      return;
    }
    const mints = uniqueMints(command.mints);
    if (command.op === "subscribe") {
      for (const mint of mints) {
        if (!client.mints.has(mint)) {
          await addRef(mint);
          client.mints.add(mint);
        }
        const cached = latest.get(mint);
        if (cached) send(target, cached);
      }
      status(target, "subscribed", {
        mints,
        watchedMints: client.mints.size,
        upstreamMints: refs.size,
      });
      return;
    }
    for (const mint of mints) {
      if (!client.mints.delete(mint)) continue;
      await removeRef(mint);
    }
    status(target, "unsubscribed", {
      mints,
      watchedMints: client.mints.size,
      upstreamMints: refs.size,
    });
  };

  const releaseClient = async (socket: unknown): Promise<void> => {
    const client = clients.get(socket);
    clients.delete(socket);
    if (!client) return;
    for (const mint of client.mints) await removeRef(mint);
  };

  tradeSubscription = await slrd.listenTrades({
    tokens: [],
    commitment: "confirmed",
    signal: controller.signal,
    onStatus(event, data) {
      report(`trades ${event}`, data ?? {});
    },
  });
  tradeSubscription.onTrade(onTrade);

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
          service: "solard-price-feed",
          clients: clients.size,
          upstreamMints: refs.size,
          watchedTokens: tradeSubscription?.list().length ?? 0,
          cachedPrices: latest.size,
          tradeCount,
          subscriptions: Object.fromEntries(refs),
        });
      }
      return new Response("Solard trader price feed\n");
    },
    websocket: {
      open(socket) {
        clients.set(socket, { mints: new Set() });
        status(socket, "ready", {
          upstreamMints: refs.size,
        });
      },
      message(socket, message) {
        let command: PriceFeedCommand;
        try {
          command = JSON.parse(String(message)) as PriceFeedCommand;
          if (
            !command ||
            (command.op !== "subscribe" &&
              command.op !== "unsubscribe" &&
              command.op !== "ping")
          ) {
            throw new Error("op must be subscribe, unsubscribe, or ping");
          }
        } catch (error) {
          status(socket, "client-error", { error: errorText(error) });
          return;
        }
        commandQueue = commandQueue
          .then(() => applyCommand(socket, command))
          .catch((error) => {
            status(socket, "client-error", { error: errorText(error) });
          });
      },
      close(socket) {
        commandQueue = commandQueue
          .then(() => releaseClient(socket))
          .catch((error) => {
            report("release-client-error", { error: errorText(error) });
          });
      },
    },
  });

  const heartbeat = setInterval(
    () =>
      report("heartbeat", {
        clients: clients.size,
        upstreamMints: refs.size,
        watchedTokens: tradeSubscription?.list().length ?? 0,
        cachedPrices: latest.size,
        tradeCount,
        subscriptions: Object.fromEntries(refs),
      }),
    Math.max(1_000, Math.trunc(numberFlag(args.flags, "heartbeat-ms", 15_000))),
  );

  report("ready", {
    url: `ws://${host}:${server.port}/ws`,
    health: `http://${host}:${server.port}/health`,
  });

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await tradeSubscription.closed;
  } finally {
    clearInterval(heartbeat);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await tradeSubscription.close();
    await commandQueue.catch(() => undefined);
    server.stop(true);
    report("stopped", {
      clients: clients.size,
      upstreamMints: refs.size,
      tradeCount,
    });
  }
}
