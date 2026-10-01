#!/usr/bin/env bun
import { configure, createMeasure } from "measure-fn";
import slrd from "@solard/sdk";

configure({ silent: false });
const m = createMeasure("slrd:trading-agents:price-server", {
  maxResultLength: 1600,
});

async function main(): Promise<void> {
  await m.measure(
    {
      start: () => "price server",
      end: (value: { port: number; tokens: string[] }) => value,
    },
    async () => {
      const cache = new Map<string, Record<string, unknown>>();
      const quoteUsdCache = new Map<string, { price: number; atMs: number }>();
      const quoteUsdPending = new Map<string, Promise<number | null>>();
      const buckets = new Map<
        string,
        {
          trades: number;
          buys: number;
          sells: number;
          volumeTokens: number;
          volumeQuote: number;
          volumeSol: number;
          volumeUsd: number;
          hasVolumeSol: boolean;
          hasVolumeUsd: boolean;
          atMs: number;
          quoteMint: string;
          quoteUsd: number | null;
          solUsd: number | null;
          priceQuotePerToken: number;
          marketCapQuote: number;
          priceSol: number | null;
          priceUsd: number | null;
          marketCapSol: number | null;
          marketCapUsd: number | null;
        }
      >();
      const clients = new Set<any>();
      const tokens = new Set<string>();
      const controller = new AbortController();

      const listener = await m.measure(
        {
          start: () => "listen trades",
          end: () => ({ tokens: [...tokens] }),
        },
        async () =>
          await slrd.listenTrades({
            tokens: [],
            commitment: "confirmed",
            signal: controller.signal,
          }),
      );

      listener.onTrade(async (event) => {
        let quoteUsd =
          event.market.priceUsd != null && event.market.priceQuotePerToken > 0
            ? event.market.priceUsd / event.market.priceQuotePerToken
            : null;

        if (!(quoteUsd != null && quoteUsd > 0)) {
          const cached = quoteUsdCache.get(event.market.quoteMint);
          if (cached && Date.now() - cached.atMs < 15_000) {
            quoteUsd = cached.price;
          } else {
            let pending = quoteUsdPending.get(event.market.quoteMint);
            if (!pending) {
              pending = (async () => {
                try {
                  const response = await fetch(
                    `https://api-v3.raydium.io/mint/price?mints=${encodeURIComponent(event.market.quoteMint)}`,
                    { signal: AbortSignal.timeout(5_000) },
                  );
                  if (!response.ok) return null;
                  const raw = (await response.json()) as {
                    data?: Record<string, unknown>;
                  };
                  const price = Number(raw.data?.[event.market.quoteMint]);
                  if (!(price > 0) || !Number.isFinite(price)) return null;
                  quoteUsdCache.set(event.market.quoteMint, {
                    price,
                    atMs: Date.now(),
                  });
                  return price;
                } catch {
                  return null;
                }
              })().finally(() => {
                quoteUsdPending.delete(event.market.quoteMint);
              });
              quoteUsdPending.set(event.market.quoteMint, pending);
            }
            quoteUsd = await pending;
          }
        }

        const priceUsd =
          event.market.priceUsd ??
          (quoteUsd == null
            ? null
            : event.market.priceQuotePerToken * quoteUsd);
        const marketCapUsd =
          event.market.marketCapUsd ??
          (quoteUsd == null ? null : event.market.marketCapQuote * quoteUsd);
        let solUsd = event.market.solUsd;
        if (solUsd == null && quoteUsd != null) {
          try {
            solUsd = (await slrd.getSolUsdPrice({ maxAgeMs: 15_000 })).price;
          } catch {}
        }
        const priceSol =
          event.market.priceSol ??
          (priceUsd == null || solUsd == null ? null : priceUsd / solUsd);
        const marketCapSol =
          event.market.marketCapSol ??
          (marketCapUsd == null || solUsd == null
            ? null
            : marketCapUsd / solUsd);
        const amount =
          event.baseRaw == null
            ? 0
            : Number(event.baseRaw) / 10 ** event.market.baseDecimals;
        const quoteAmount =
          event.quoteRaw == null
            ? amount * event.market.priceQuotePerToken
            : Number(event.quoteRaw) / 10 ** event.market.quoteDecimals;
        const volumeSol =
          quoteUsd != null && solUsd != null
            ? (quoteAmount * quoteUsd) / solUsd
            : priceSol == null
              ? null
              : amount * priceSol;
        const volumeUsd = quoteUsd == null ? null : quoteAmount * quoteUsd;
        const bucket = buckets.get(event.mint) ?? {
          trades: 0,
          buys: 0,
          sells: 0,
          volumeTokens: 0,
          volumeQuote: 0,
          volumeSol: 0,
          volumeUsd: 0,
          hasVolumeSol: false,
          hasVolumeUsd: false,
          atMs: event.atMs,
          quoteMint: event.market.quoteMint,
          quoteUsd,
          solUsd,
          priceQuotePerToken: event.market.priceQuotePerToken,
          marketCapQuote: event.market.marketCapQuote,
          priceSol,
          priceUsd,
          marketCapSol,
          marketCapUsd,
        };

        bucket.trades += 1;
        if (event.side === "buy") bucket.buys += 1;
        if (event.side === "sell") bucket.sells += 1;
        bucket.volumeTokens += amount;
        bucket.volumeQuote += quoteAmount;
        if (volumeSol != null) {
          bucket.volumeSol += volumeSol;
          bucket.hasVolumeSol = true;
        }
        if (volumeUsd != null) {
          bucket.volumeUsd += volumeUsd;
          bucket.hasVolumeUsd = true;
        }
        bucket.atMs = event.atMs;
        bucket.quoteMint = event.market.quoteMint;
        bucket.quoteUsd = quoteUsd;
        bucket.solUsd = solUsd;
        bucket.priceQuotePerToken = event.market.priceQuotePerToken;
        bucket.marketCapQuote = event.market.marketCapQuote;
        bucket.priceSol = priceSol;
        bucket.priceUsd = priceUsd;
        bucket.marketCapSol = marketCapSol;
        bucket.marketCapUsd = marketCapUsd;
        buckets.set(event.mint, bucket);
      });

      const flush = setInterval(() => {
        for (const [mint, bucket] of buckets) {
          const snapshot = {
            type: "market",
            mint,
            atMs: bucket.atMs,
            windowMs: 1000,
            trades: bucket.trades,
            buys: bucket.buys,
            sells: bucket.sells,
            volumeTokens: bucket.volumeTokens,
            volumeQuote: bucket.volumeQuote,
            volumeSol: bucket.hasVolumeSol ? bucket.volumeSol : null,
            volumeUsd: bucket.hasVolumeUsd ? bucket.volumeUsd : null,
            quoteMint: bucket.quoteMint,
            quoteUsd: bucket.quoteUsd,
            solUsd: bucket.solUsd,
            priceQuotePerToken: bucket.priceQuotePerToken,
            marketCapQuote: bucket.marketCapQuote,
            priceSol: bucket.priceSol,
            priceUsd: bucket.priceUsd,
            marketCapSol: bucket.marketCapSol,
            marketCapUsd: bucket.marketCapUsd,
          };
          buckets.delete(mint);
          cache.set(mint, snapshot);
          const payload = JSON.stringify(snapshot);
          const now = Date.now();
          for (const socket of clients) {
            if (
              socket.data.token === mint &&
              now - socket.data.lastSentAt >= 1000
            ) {
              socket.send(payload);
              socket.data.lastSentAt = now;
            }
          }
          m.sync(
            {
              start: () => `market ${mint}`,
              end: () => snapshot,
            },
            () => snapshot,
          );
        }
      }, 1000);

      const server = await m.measure(
        {
          start: () => "start websocket server",
          end: (value: { port: number }) => value,
        },
        async () =>
          Bun.serve<{ token: string; lastSentAt: number }>({
            hostname: "127.0.0.1",
            port: Number(process.env.SOLARD_PRICE_PORT ?? "8788"),
            async fetch(request, bunServer) {
              const url = new URL(request.url);
              if (url.pathname === "/health") {
                return Response.json({
                  ok: true,
                  tokens: [...tokens],
                  cached: [...cache.keys()],
                  clients: clients.size,
                });
              }
              if (url.pathname === "/ws") {
                const token = url.searchParams.get("token")?.trim() ?? "";
                if (!token)
                  return new Response("token required", { status: 400 });
                if (!tokens.has(token)) {
                  await m.measure(
                    {
                      start: () => `subscribe ${token}`,
                      end: () => ({ token }),
                    },
                    async () => {
                      await listener.add(token);
                      tokens.add(token);
                    },
                  );
                }
                return bunServer.upgrade(request, {
                  data: { token, lastSentAt: 0 },
                })
                  ? undefined
                  : new Response("upgrade failed", { status: 400 });
              }
              return new Response("Solard trading-agents price server\n");
            },
            websocket: {
              open(socket) {
                clients.add(socket);
                const snapshot = cache.get(socket.data.token);
                if (snapshot) {
                  socket.send(JSON.stringify(snapshot));
                  socket.data.lastSentAt = Date.now();
                }
              },
              message() {},
              close(socket) {
                clients.delete(socket);
              },
            },
          }),
      );

      await m.measure(
        {
          start: () => "ready",
          end: () => ({
            port: server.port,
            tokens: [...tokens],
            clients: clients.size,
          }),
        },
        async () =>
          await new Promise<void>((resolve) => {
            process.once("SIGINT", resolve);
            process.once("SIGTERM", resolve);
          }),
      );

      clearInterval(flush);
      controller.abort();
      await listener.close();
      server.stop(true);
      slrd.close();
      return { port: server.port, tokens: [...tokens] };
    },
  );
}
await main();
