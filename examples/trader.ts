#!/usr/bin/env bun
import { configure, createMeasure } from "measure-fn";
import slrd from "@solard/sdk";

configure({ silent: false });
const m = createMeasure("slrd:trader", { maxResultLength: 1600 });

async function main(): Promise<void> {
  await m.measure(
    {
      start: () => "trader",
      end: (value: { wallet: string; token: string; strategy: string }) =>
        value,
    },
    async () => {
      const wallet = process.argv[2]?.trim();
      const token = process.argv[3]?.trim();
      const strategy = process.argv[4]?.trim() ?? "dip";
      const live = process.argv.includes("--live");
      const buySol = Number(process.env.SOLARD_BUY_SOL ?? "0.01");
      const slippageBps = Number(process.env.SOLARD_SLIPPAGE_BPS ?? "500");
      const feed = process.env.SOLARD_PRICE_FEED ?? "ws://127.0.0.1:8788/ws";

      if (!wallet || !token)
        throw new Error(
          "Usage: bun examples/trader.ts <wallet> <mint> <dip|momentum|range> [--live]",
        );
      if (!new Set(["dip", "momentum", "range"]).has(strategy))
        throw new Error("Strategy must be dip, momentum, or range");
      if (!slrd.listWallets().some((row) => row.name === wallet))
        slrd.createWallet(wallet);

      let holding = false;
      let entry = 0;
      let high = 0;
      let anchor = 0;
      let previous = 0;
      let busy = false;

      const socket = new WebSocket(
        `${feed}?token=${encodeURIComponent(token)}`,
      );

      await m.measure(
        {
          start: () => "connect price server",
          end: () => ({ feed, token }),
        },
        async () =>
          await new Promise<void>((resolve, reject) => {
            socket.addEventListener("open", () => resolve(), { once: true });
            socket.addEventListener(
              "error",
              () => reject(new Error(`Could not connect to ${feed}`)),
              { once: true },
            );
          }),
      );

      socket.addEventListener("message", (event) => {
        void m.measure(
          {
            start: () => "price",
            end: (value: Record<string, unknown>) => value,
          },
          async () => {
            if (busy) return { ignored: "busy" };
            const price = JSON.parse(String(event.data)) as {
              type: string;
              mint: string;
              priceSol: number | null;
              priceUsd: number | null;
              marketCapUsd: number | null;
            };
            if (
              price.type !== "price" ||
              price.mint !== token ||
              !price.priceSol
            )
              return { ignored: "price" };

            high = Math.max(high || price.priceSol, price.priceSol);
            anchor ||= price.priceSol;

            let side: "buy" | "sell" | null = null;
            if (
              holding &&
              (price.priceSol >= entry * 1.1 || price.priceSol <= entry * 0.94)
            )
              side = "sell";
            else if (
              strategy === "dip" &&
              !holding &&
              price.priceSol <= high * 0.92
            )
              side = "buy";
            else if (
              strategy === "momentum" &&
              !holding &&
              previous > 0 &&
              price.priceSol >= previous * 1.025
            )
              side = "buy";
            else if (
              strategy === "range" &&
              !holding &&
              price.priceSol <= anchor * 0.96
            )
              side = "buy";
            else if (
              strategy === "range" &&
              holding &&
              price.priceSol >= anchor * 1.04
            )
              side = "sell";

            previous = price.priceSol;
            if (!side) return { strategy, priceSol: price.priceSol, holding };

            busy = true;
            try {
              const result = await m.measure(
                {
                  start: () => `${side} ${wallet}`,
                  end: (value: unknown) => value,
                },
                async () =>
                  live
                    ? side === "buy"
                      ? await slrd.buy({
                          wallet,
                          token,
                          amount: buySol,
                          slippageBps,
                        })
                      : await slrd.sell({
                          wallet,
                          token,
                          amount: "all",
                          slippageBps,
                        })
                    : { status: "paper", side, priceSol: price.priceSol },
              );

              holding = side === "buy";
              if (holding) entry = price.priceSol;
              else {
                entry = 0;
                high = price.priceSol;
                anchor = price.priceSol;
              }
              return {
                strategy,
                side,
                priceSol: price.priceSol,
                priceUsd: price.priceUsd,
                marketCapUsd: price.marketCapUsd,
                result,
              };
            } finally {
              busy = false;
            }
          },
        );
      });

      await m.measure(
        {
          start: () => "running",
          end: () => ({ wallet, token, strategy, live }),
        },
        async () =>
          await new Promise<void>((resolve) => {
            process.once("SIGINT", () => socket.close());
            process.once("SIGTERM", () => socket.close());
            socket.addEventListener("close", () => resolve(), { once: true });
          }),
      );

      slrd.close();
      return { wallet, token, strategy };
    },
  );
}

await main();
