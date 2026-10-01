#!/usr/bin/env bun
import { configure, createMeasure } from "measure-fn";
import slrd from "@solard/sdk";

configure({ silent: false });
const m = createMeasure("slrd:trading-agents:trader", {
  maxResultLength: 1600,
});

async function main(): Promise<void> {
  await m.measure(
    {
      start: () => "trader",
      end: (value: { wallet: string; mint: string; strategy: string }) => value,
    },
    async () => {
      const flags = new Map<string, string>();
      for (let index = 2; index < process.argv.length; index += 2) {
        flags.set(
          process.argv[index]!.replace(/^--/, ""),
          process.argv[index + 1] ?? "",
        );
      }

      const mint = flags.get("mint")!;
      const strategyName = flags.get("strategy")!;
      const wallet = flags.get("wallet")!;
      const budget = Number(flags.get("budget"));

      if (!mint || !strategyName || !wallet || !(budget > 0)) {
        throw new Error(
          "Usage: bun examples/trading-agents/trader.ts --mint <mint> --strategy <strategy> --wallet <wallet> --budget <sol>",
        );
      }

      const strategyModule = await m.measure(
        {
          start: () => `load strategy ${strategyName}`,
          end: () => ({ strategy: strategyName }),
        },
        async () => await import(`./strategies/${strategyName}.ts`),
      );
      const strategy = strategyModule.default as (input: {
        priceSol: number | null;
        priceUsd: number | null;
        marketCapUsd: number | null;
        trades: number;
        buys: number;
        sells: number;
        volumeTokens: number;
        volumeSol: number | null;
        volumeUsd: number | null;
        holding: boolean;
        entryPriceSol: number | null;
        state: Record<string, number>;
        args: ReadonlyMap<string, string>;
      }) => "buy" | "sell" | null;

      let holding = false;
      let entryPriceSol: number | null = null;
      let state: Record<string, number> = {};
      let busy = false;
      const socket = new WebSocket(
        `ws://127.0.0.1:8788/ws?token=${encodeURIComponent(mint)}`,
      );

      await m.measure(
        {
          start: () => "connect price server",
          end: () => ({ mint }),
        },
        async () =>
          await new Promise<void>((resolve, reject) => {
            socket.addEventListener("open", () => resolve(), { once: true });
            socket.addEventListener(
              "error",
              () => reject(new Error("Could not connect to price server")),
              { once: true },
            );
          }),
      );

      socket.addEventListener("message", (event) => {
        void m.measure(
          {
            start: () => "market",
            end: (value: Record<string, unknown>) => value,
          },
          async () => {
            if (busy) return { ignored: "busy" };

            const price = JSON.parse(String(event.data)) as {
              type: string;
              mint: string;
              trades: number;
              buys: number;
              sells: number;
              volumeTokens: number;
              volumeSol: number | null;
              volumeUsd: number | null;
              priceSol: number | null;
              priceUsd: number | null;
              marketCapUsd: number | null;
            };

            if (price.type !== "market" || price.mint !== mint) {
              return { ignored: "market" };
            }

            const side = await m.measure(
              {
                start: () => `strategy ${strategyName}`,
                end: (value: "buy" | "sell" | null) => ({ decision: value }),
              },
              async () =>
                strategy({
                  priceSol: price.priceSol,
                  priceUsd: price.priceUsd,
                  marketCapUsd: price.marketCapUsd,
                  trades: price.trades,
                  buys: price.buys,
                  sells: price.sells,
                  volumeTokens: price.volumeTokens,
                  volumeSol: price.volumeSol,
                  volumeUsd: price.volumeUsd,
                  holding,
                  entryPriceSol,
                  state,
                  args: flags,
                }),
            );

            if (!side) {
              return {
                strategy: strategyName,
                marketCapUsd: price.marketCapUsd,
                trades: price.trades,
                volumeUsd: price.volumeUsd,
                holding,
              };
            }

            busy = true;
            try {
              const result = await m.measure(
                {
                  start: () => `${side} ${wallet}`,
                  end: (value: unknown) => value,
                },
                async () =>
                  side === "buy"
                    ? await slrd.buy({
                        wallet,
                        token: mint,
                        amount: budget,
                        slippageBps: 500,
                      })
                    : await slrd.sell({
                        wallet,
                        token: mint,
                        amount: "all",
                        slippageBps: 500,
                      }),
              );

              holding = side === "buy";
              entryPriceSol = holding ? price.priceSol : null;
              if (!holding) state = {};

              return {
                strategy: strategyName,
                side,
                budget: side === "buy" ? budget : undefined,
                marketCapUsd: price.marketCapUsd,
                trades: price.trades,
                volumeUsd: price.volumeUsd,
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
          end: () => ({ wallet, mint, strategy: strategyName, budget }),
        },
        async () =>
          await new Promise<void>((resolve) => {
            process.once("SIGINT", () => socket.close());
            process.once("SIGTERM", () => socket.close());
            socket.addEventListener("close", () => resolve(), { once: true });
          }),
      );

      slrd.close();
      return { wallet, mint, strategy: strategyName };
    },
  );
}

await main();
