#!/usr/bin/env bun
import slrd, { type SolardTrade } from "@solard/sdk";
import { connectPriceFeed } from "../packages/cli/src/price-feed-client.ts";
import type { PriceFeedPrice } from "../packages/cli/src/price-feed-protocol.ts";

type StrategyName = "dip" | "momentum" | "range";
type Side = "buy" | "sell";

type Config = {
  id: string;
  token: string;
  wallet: string;
  strategy: StrategyName;
  feedUrl: string;
  live: boolean;
  buySol: number;
  slippageBps: number;
  cooldownMs: number;
  maxTickAgeMs: number;
};

type Runtime = {
  holding: boolean;
  entryPrice: number | null;
  anchorPrice: number | null;
  highPrice: number | null;
  samples: number[];
  busy: boolean;
  cooldownUntilMs: number;
  lastEventKey: string | null;
};

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function booleanEnv(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (/^(1|true|yes)$/i.test(raw)) return true;
  if (/^(0|false|no)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function strategyName(value: string): StrategyName {
  if (value === "dip" || value === "momentum" || value === "range")
    return value;
  throw new Error(`Unsupported SOLARD_DEMO_STRATEGY: ${value}`);
}

function config(): Config {
  return {
    id: env("SOLARD_DEMO_ID"),
    token: env("SOLARD_DEMO_TOKEN"),
    wallet: env("SOLARD_DEMO_WALLET"),
    strategy: strategyName(env("SOLARD_DEMO_STRATEGY")),
    feedUrl:
      process.env.SOLARD_PRICE_FEED_URL?.trim() || "ws://127.0.0.1:8788/ws",
    live: booleanEnv("SOLARD_DEMO_LIVE"),
    buySol: Math.max(0.000001, numberEnv("SOLARD_DEMO_BUY_SOL", 0.01)),
    slippageBps: Math.max(
      0,
      Math.trunc(numberEnv("SOLARD_DEMO_SLIPPAGE_BPS", 500)),
    ),
    cooldownMs: Math.max(
      0,
      Math.trunc(numberEnv("SOLARD_DEMO_COOLDOWN_MS", 8_000)),
    ),
    maxTickAgeMs: Math.max(
      1_000,
      Math.trunc(numberEnv("SOLARD_DEMO_MAX_TICK_AGE_MS", 30_000)),
    ),
  };
}

function emit(
  id: string,
  event: string,
  data: Record<string, unknown> = {},
): void {
  process.stdout.write(
    `${JSON.stringify(
      { atMs: Date.now(), agent: id, event, ...data },
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    )}\n`,
  );
}

function latestConfirmedTrade(
  rows: SolardTrade[],
  side: Side,
): SolardTrade | null {
  return (
    rows.find((row) => row.side === side && row.status === "confirmed") ?? null
  );
}

async function hydrate(cfg: Config, state: Runtime): Promise<void> {
  if (!cfg.live) return;
  const [position, trades] = await Promise.all([
    slrd.position({ wallet: cfg.wallet, token: cfg.token }),
    slrd.trades({
      wallet: cfg.wallet,
      token: cfg.token,
      status: "confirmed",
      limit: 30,
    }),
  ]);
  state.holding = position.amountRaw > 0n;
  const buy = latestConfirmedTrade(trades, "buy");
  const sell = latestConfirmedTrade(trades, "sell");
  if (
    state.holding &&
    buy?.priceSol != null &&
    (sell == null || buy.createdAtMs > sell.createdAtMs)
  ) {
    state.entryPrice = buy.priceSol;
  }
  emit(cfg.id, "hydrated", {
    live: true,
    wallet: position.wallet,
    token: position.mint,
    tokenAmount: position.amountUi,
    sol: position.sol,
    holding: state.holding,
    entryPrice: state.entryPrice,
  });
}

function exitSignal(state: Runtime, price: number): string | null {
  if (!state.holding || state.entryPrice == null) return null;
  if (price >= state.entryPrice * 1.1) return "take-profit-10pct";
  if (price <= state.entryPrice * 0.94) return "stop-loss-6pct";
  return null;
}

function dipSignal(
  state: Runtime,
  price: number,
): { side: Side; reason: string } | null {
  state.highPrice = Math.max(state.highPrice ?? price, price);
  const exit = exitSignal(state, price);
  if (exit) return { side: "sell", reason: exit };
  if (!state.holding && price <= state.highPrice * 0.92) {
    return { side: "buy", reason: "8pct-dip-from-running-high" };
  }
  return null;
}

function momentumSignal(
  state: Runtime,
  price: number,
): { side: Side; reason: string } | null {
  state.samples.push(price);
  if (state.samples.length > 12) state.samples.shift();
  const exit = exitSignal(state, price);
  if (exit) return { side: "sell", reason: exit };
  if (!state.holding && state.samples.length >= 8) {
    const baseline = state.samples[0]!;
    if (price >= baseline * 1.025) {
      return { side: "buy", reason: "2.5pct-momentum-over-window" };
    }
  }
  return null;
}

function rangeSignal(
  state: Runtime,
  price: number,
): { side: Side; reason: string } | null {
  state.anchorPrice ??= price;
  if (state.holding) {
    if (price >= state.anchorPrice * 1.04) {
      return { side: "sell", reason: "4pct-above-range-anchor" };
    }
    const exit = exitSignal(state, price);
    if (exit) return { side: "sell", reason: exit };
    return null;
  }
  if (price <= state.anchorPrice * 0.96) {
    return { side: "buy", reason: "4pct-below-range-anchor" };
  }
  return null;
}

function signal(
  strategy: StrategyName,
  state: Runtime,
  price: number,
): { side: Side; reason: string } | null {
  if (strategy === "dip") return dipSignal(state, price);
  if (strategy === "momentum") return momentumSignal(state, price);
  return rangeSignal(state, price);
}

async function execute(
  cfg: Config,
  state: Runtime,
  side: Side,
  price: number,
  reason: string,
): Promise<void> {
  if (state.busy || Date.now() < state.cooldownUntilMs) return;
  state.busy = true;
  try {
    emit(cfg.id, "signal", {
      strategy: cfg.strategy,
      side,
      price,
      reason,
      live: cfg.live,
    });
    if (!cfg.live) {
      state.holding = side === "buy";
      if (side === "buy") state.entryPrice = price;
      else {
        state.entryPrice = null;
        state.anchorPrice = price;
        state.highPrice = price;
        state.samples.length = 0;
      }
      emit(cfg.id, "paper-trade", { side, price, reason });
      state.cooldownUntilMs = Date.now() + cfg.cooldownMs;
      return;
    }
    const result =
      side === "buy"
        ? await slrd.buy({
            wallet: cfg.wallet,
            token: cfg.token,
            amount: cfg.buySol,
            slippageBps: cfg.slippageBps,
          })
        : await slrd.sell({
            wallet: cfg.wallet,
            token: cfg.token,
            amount: "all",
            slippageBps: cfg.slippageBps,
          });
    emit(cfg.id, "trade-result", {
      side,
      reason,
      executionId: result.executionId,
      signature: result.signature,
      status: result.status,
      slot: result.slot,
      error: result.error,
    });
    if (result.status !== "confirmed") {
      throw new Error(
        `Solard returned unexpected default trade status ${result.status} for ${result.signature}`,
      );
    }
    const position = await slrd.position({
      wallet: cfg.wallet,
      token: cfg.token,
    });
    state.holding = position.amountRaw > 0n;
    if (side === "buy") {
      const rows = await slrd.trades({
        wallet: cfg.wallet,
        token: cfg.token,
        status: "confirmed",
        side: "buy",
        limit: 5,
      });
      state.entryPrice =
        rows.find((row) => row.signature === result.signature)?.priceSol ??
        price;
    } else {
      state.entryPrice = null;
      state.anchorPrice = price;
      state.highPrice = price;
      state.samples.length = 0;
    }
    emit(cfg.id, "position", {
      holding: state.holding,
      tokenAmount: position.amountUi,
      sol: position.sol,
      entryPrice: state.entryPrice,
    });
    state.cooldownUntilMs = Date.now() + cfg.cooldownMs;
  } catch (error) {
    emit(cfg.id, "trade-error", {
      side,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    state.cooldownUntilMs = Date.now() + cfg.cooldownMs;
  } finally {
    state.busy = false;
  }
}

async function main(): Promise<void> {
  const cfg = config();
  const state: Runtime = {
    holding: false,
    entryPrice: null,
    anchorPrice: null,
    highPrice: null,
    samples: [],
    busy: false,
    cooldownUntilMs: 0,
    lastEventKey: null,
  };
  await hydrate(cfg, state);
  const controller = new AbortController();
  const close = () => controller.abort();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  const feed = await connectPriceFeed({
    url: cfg.feedUrl,
    mints: cfg.token,
    signal: controller.signal,
    onStatus(event, data) {
      emit(cfg.id, `feed-${event}`, data ?? {});
    },
    async onMessage(message) {
      if (message.type !== "price" || message.mint !== cfg.token) return;
      const tick = message as PriceFeedPrice;
      const price = tick.market.priceSol;
      if (!(price != null && price > 0 && Number.isFinite(price))) return;
      if (Date.now() - tick.atMs > cfg.maxTickAgeMs) return;
      const eventKey = `${tick.signature}:${tick.slot}`;
      if (state.lastEventKey === eventKey) return;
      state.lastEventKey = eventKey;
      state.anchorPrice ??= price;
      state.highPrice ??= price;
      emit(cfg.id, "price", {
        strategy: cfg.strategy,
        priceSol: price,
        priceUsd: tick.market.priceUsd,
        marketCapUsd: tick.market.marketCapUsd,
        side: tick.side,
        signature: tick.signature,
        holding: state.holding,
        entryPrice: state.entryPrice,
      });
      const next = signal(cfg.strategy, state, price);
      if (next) await execute(cfg, state, next.side, price, next.reason);
    },
  });
  emit(cfg.id, "ready", {
    strategy: cfg.strategy,
    token: cfg.token,
    wallet: cfg.wallet,
    walletAddress: slrd.walletAddress(cfg.wallet),
    feedUrl: cfg.feedUrl,
    live: cfg.live,
    buySol: cfg.buySol,
    slippageBps: cfg.slippageBps,
  });
  await feed.closed;
  slrd.close();
}

await main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
