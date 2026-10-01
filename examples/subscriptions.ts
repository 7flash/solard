#!/usr/bin/env bun
import { Connection } from "@solana/web3.js";
import { configure, createMeasure } from "measure-fn";
import {
  subscribeLaunches,
  subscribeMigrations,
  subscribeTrades,
  type TradeEvent,
} from "@solard/sdk";

configure({ silent: false });
const m = createMeasure("slrd:subscriptions-example", {
  maxResultLength: 2400,
});

function rpcUrl(): string {
  const value =
    process.env.RPC_ENDPOINT?.trim() ??
    process.env.SOLANA_RPC_URL?.trim() ??
    process.env.HELIUS_RPC_URL?.trim();
  if (!value) {
    throw new Error(
      "Set RPC_ENDPOINT, SOLANA_RPC_URL, or HELIUS_RPC_URL before running this example.",
    );
  }
  return value;
}

function printableTrade(event: TradeEvent) {
  return {
    ...event,
    baseRaw: event.baseRaw?.toString() ?? null,
    quoteRaw: event.quoteRaw?.toString() ?? null,
    virtualBaseRaw: event.virtualBaseRaw?.toString() ?? null,
    virtualQuoteRaw: event.virtualQuoteRaw?.toString() ?? null,
  };
}

const wsEndpoint =
  process.env.SOLANA_WS_URL?.trim() ?? process.env.HELIUS_WS_URL?.trim();
const connection = new Connection(
  rpcUrl(),
  wsEndpoint ? { commitment: "confirmed", wsEndpoint } : "confirmed",
);
const controller = new AbortController();

const trades = await subscribeTrades({
  connection,
  tokens: [],
  metadata: false,
  signal: controller.signal,
  onTrade(event) {
    const value = printableTrade(event);
    m.sync(
      { start: () => "trade", end: (result: typeof value) => result },
      () => value,
    );
  },
});

const migrations = await subscribeMigrations({
  connection,
  tokens: [],
  metadata: "chain",
  signal: controller.signal,
  async onMigration(event) {
    m.sync(
      { start: () => "migration", end: (result: typeof event) => result },
      () => event,
    );
    await trades.addTokens(event.mint);
  },
});

const launches = await subscribeLaunches({
  connection,
  metadata: "chain",
  signal: controller.signal,
  async onLaunch(event) {
    if (event.isMayhemMode === true) return;
    m.sync(
      { start: () => "launch", end: (result: typeof event) => result },
      () => event,
    );
    await migrations.addTokens(event.mint);
  },
});

m.sync(
  {
    start: () => "listening",
    end: (value: Record<string, unknown>) => value,
  },
  () => ({
    flow: "launch -> migration -> trades",
    mayhem: "ignored",
    launchMetadata: "chain",
    migrationMetadata: "chain",
    tradeMetadata: false,
  }),
);

const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await Promise.all([launches.closed, migrations.closed, trades.closed]);
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await Promise.allSettled([
    launches.close(),
    migrations.close(),
    trades.close(),
  ]);
}
