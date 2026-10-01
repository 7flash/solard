#!/usr/bin/env bun
import { configure, createMeasure } from "measure-fn";
import slrd from "@solard/sdk";

configure({ silent: false });
const m = createMeasure("slrd:cache-price-server", { maxResultLength: 1600 });

async function main(): Promise<void> {
  await m.measure(
    {
      start: () => "price server",
      end: (value: { tokens: string[]; port: number }) => value,
    },
    async () => {
      const tokens = [
        ...new Set(
          process.argv
            .slice(2)
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ];
      if (!tokens.length)
        throw new Error(
          "Usage: bun examples/cache-price-server.ts <mint> [mint...]",
        );

      const cache = new Map<string, Record<string, unknown>>();
      const clients = new Set<any>();
      const controller = new AbortController();

      const listener = await m.measure(
        {
          start: () => "listen trades",
          end: () => ({ tokens }),
        },
        async () =>
          await slrd.listenTrades({
            tokens,
            commitment: "confirmed",
            signal: controller.signal,
          }),
      );

      listener.onTrade((event) => {
        const price = {
          type: "price",
          mint: event.mint,
          atMs: event.atMs,
          signature: event.signature,
          priceSol: event.market.priceSol,
          priceUsd: event.market.priceUsd,
          marketCapSol: event.market.marketCapSol,
          marketCapUsd: event.market.marketCapUsd,
        };
        cache.set(event.mint, price);
        const text = JSON.stringify(price);
        for (const socket of clients) {
          if (socket.data.token === event.mint) socket.send(text);
        }
        m.sync(
          {
            start: () => `price ${event.mint}`,
            end: () => price,
          },
          () => price,
        );
      });

      const server = await m.measure(
        {
          start: () => "start websocket server",
          end: (value: { port: number }) => value,
        },
        async () => {
          const value = Bun.serve<{ token: string }>({
            hostname: "127.0.0.1",
            port: Number(process.env.SOLARD_PRICE_PORT ?? "8788"),
            fetch(request, bunServer) {
              const url = new URL(request.url);
              if (url.pathname === "/health") {
                return Response.json({
                  ok: true,
                  tokens,
                  cached: [...cache.keys()],
                });
              }
              if (url.pathname === "/price") {
                const price = cache.get(url.searchParams.get("token") ?? "");
                return price
                  ? Response.json(price)
                  : new Response("no cached price", { status: 404 });
              }
              if (url.pathname === "/ws") {
                const token = url.searchParams.get("token") ?? "";
                if (!tokens.includes(token))
                  return new Response("unknown token", { status: 404 });
                return bunServer.upgrade(request, { data: { token } })
                  ? undefined
                  : new Response("upgrade failed", { status: 400 });
              }
              return new Response("Solard cached price server\n");
            },
            websocket: {
              open(socket) {
                clients.add(socket);
                const price = cache.get(socket.data.token);
                if (price) socket.send(JSON.stringify(price));
              },
              message() {},
              close(socket) {
                clients.delete(socket);
              },
            },
          });
          return value;
        },
      );

      await m.measure(
        {
          start: () => "ready",
          end: () => ({ port: server.port, tokens, clients: clients.size }),
        },
        async () =>
          await new Promise<void>((resolve) => {
            process.once("SIGINT", resolve);
            process.once("SIGTERM", resolve);
          }),
      );

      controller.abort();
      await listener.close();
      server.stop(true);
      slrd.close();
      return { tokens, port: server.port };
    },
  );
}

await main();
