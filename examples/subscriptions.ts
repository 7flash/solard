#!/usr/bin/env bun
import { configure, createMeasure } from "measure-fn";
import slrd, { type TradeEvent } from "@solard/sdk";

configure({ silent: false });
const m = createMeasure("slrd:subscriptions-example", {
  maxResultLength: 2400,
});

function printableTrade(event: TradeEvent) {
  return {
    ...event,
    baseRaw: event.baseRaw?.toString() ?? null,
    quoteRaw: event.quoteRaw?.toString() ?? null,
    market: {
      ...event.market,
      supplyRaw: event.market.supplyRaw.toString(),
      baseReserveRaw: event.market.baseReserveRaw.toString(),
      quoteReserveRaw: event.market.quoteReserveRaw.toString(),
    },
  };
}

const controller = new AbortController();
const solUsdQuote = await slrd.getSolUsdPrice();
m.sync(
  { start: () => "sol-usd", end: (value: typeof solUsdQuote) => value },
  () => solUsdQuote,
);

const trades = await slrd.listenTrades({
  tokens: [],
  metadata: false,
  signal: controller.signal,
});
trades.onTrade((event) => {
  const value = printableTrade(event);
  m.sync(
    { start: () => "trade", end: (result: typeof value) => result },
    () => value,
  );
});

const migrations = await slrd.subscribeMigrations({
  tokens: [],
  metadata: "chain",
  signal: controller.signal,
  async onMigration(event) {
    m.sync(
      { start: () => "migration", end: (result: typeof event) => result },
      () => event,
    );
    await trades.add(event.mint);
  },
});

const launches = await slrd.subscribeLaunches({
  metadata: "chain",
  signal: controller.signal,
  async onLaunch(event) {
    if (event.isMayhemMode === true) return;
    m.sync(
      { start: () => "launch", end: (result: typeof event) => result },
      () => event,
    );
    await migrations.add(event.mint);
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
