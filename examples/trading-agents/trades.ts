#!/usr/bin/env bun
import { configure, createMeasure } from "measure-fn";
import slrd from "@solard/sdk";

configure({ silent: false });
const m = createMeasure("slrd:trading-agents:trades", {
  maxResultLength: 1600,
});

async function main(): Promise<void> {
  await m.measure(
    {
      start: () => "agent trades",
      end: (value: { wallet: string; trades: number }) => value,
    },
    async () => {
      const index = process.argv.indexOf("--wallet");
      const wallet = index >= 0 ? process.argv[index + 1]?.trim() : undefined;
      if (!wallet) {
        throw new Error(
          "Usage: bun examples/trading-agents/trades.ts --wallet <wallet-address-or-name>",
        );
      }

      const trades = await m.measure(
        {
          start: () => `query ${wallet}`,
          end: (value: unknown[]) => ({ trades: value.length }),
        },
        async () =>
          await slrd.trades({
            wallet,
            status: "confirmed",
          }),
      );

      process.stdout.write(
        `${JSON.stringify(
          trades,
          (_key, value) =>
            typeof value === "bigint" ? value.toString() : value,
          2,
        )}\n`,
      );

      slrd.close();
      return { wallet, trades: trades.length };
    },
  );
}

await main();
