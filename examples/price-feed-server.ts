#!/usr/bin/env bun
import slrd, { type TradeEvent, type TradeListener } from "@solard/sdk";
import type {
  PriceFeedMessage,
  PriceFeedPrice,
} from "./lib/price-feed-client.ts";

async function main(): Promise<void> {
  const clients = new Map<unknown, Set<string>>();
  const refs = new Map<string, number>();
  const latest = new Map<string, PriceFeedPrice>();
  const controller = new AbortController();
  let listener: TradeListener | null = null;
  let queue = Promise.resolve();

  listener = await slrd.listenTrades({
    tokens: [],
    commitment: "confirmed",
    signal: controller.signal,
  });

  listener.onTrade((event: TradeEvent) => {
    const message: PriceFeedPrice = {
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
    latest.set(event.mint, message);
    const text = JSON.stringify(message);
    for (const [socket, mints] of clients) {
      if (!mints.has(event.mint)) continue;
      try {
        (socket as { send(value: string): unknown }).send(text);
      } catch {}
    }
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 8788,
    fetch(request, bunServer) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        return bunServer.upgrade(request)
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/health") {
        return Response.json({
          ok: true,
          clients: clients.size,
          tokens: listener?.list().length ?? 0,
          subscriptions: Object.fromEntries(refs),
        });
      }
      return new Response("price feed\n");
    },
    websocket: {
      open(socket) {
        clients.set(socket, new Set());
      },
      message(socket, raw) {
        queue = queue.then(async () => {
          const command = JSON.parse(String(raw)) as {
            op: "subscribe" | "unsubscribe" | "ping";
            mints?: string[];
          };
          const mints = clients.get(socket);
          if (!mints) return;
          if (command.op === "ping") {
            const message: PriceFeedMessage = {
              type: "status",
              atMs: Date.now(),
              event: "pong",
            };
            socket.send(JSON.stringify(message));
            return;
          }
          for (const mint of [...new Set(command.mints ?? [])]) {
            if (command.op === "subscribe") {
              if (mints.has(mint)) continue;
              if ((refs.get(mint) ?? 0) === 0) await listener!.add(mint);
              refs.set(mint, (refs.get(mint) ?? 0) + 1);
              mints.add(mint);
              const cached = latest.get(mint);
              if (cached) socket.send(JSON.stringify(cached));
            } else {
              if (!mints.delete(mint)) continue;
              const count = refs.get(mint) ?? 0;
              if (count <= 1) {
                refs.delete(mint);
                await listener!.remove(mint);
              } else {
                refs.set(mint, count - 1);
              }
            }
          }
        });
      },
      close(socket) {
        queue = queue.then(async () => {
          const mints = clients.get(socket);
          clients.delete(socket);
          if (!mints) return;
          for (const mint of mints) {
            const count = refs.get(mint) ?? 0;
            if (count <= 1) {
              refs.delete(mint);
              await listener!.remove(mint);
            } else {
              refs.set(mint, count - 1);
            }
          }
        });
      },
    },
  });

  process.stdout.write(`price feed ws://127.0.0.1:${server.port}/ws\n`);

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });

  controller.abort();
  await queue;
  await listener.close();
  server.stop(true);
  slrd.close();
}

await main();
