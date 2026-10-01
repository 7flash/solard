import { configure, createMeasure } from "measure-fn";
import slrd, {
  type LaunchEvent,
  type TradeEvent,
  type TradeListener,
} from "@solard/sdk";

type Flags = Map<string, string>;
type Emit = (value: string) => void;
type VenueId = "pump" | "raydium-launchlab";
type WatchState = {
  mint: string;
  venue: VenueId;
  createdAtMs: number;
  lastSeenAtMs: number;
  supplyUi: number;
  qualified: boolean;
  athMarketCapUsd: number | null;
  lastNotifiedAthUsd: number | null;
};

function flag(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return value && value !== "true" ? value : undefined;
}

function numberFlag(flags: Flags, key: string, fallback: number): number {
  const value = flag(flags, key);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key}: ${value}`);
  return parsed;
}

function duration(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const scale = ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const)[
    (match[2]?.toLowerCase() ?? "ms") as "ms" | "s" | "m" | "h"
  ];
  return Math.max(100, Math.floor(Number(match[1]) * scale));
}

function venueList(flags: Flags): VenueId[] {
  const raw = flag(flags, "venue") ?? "pump,raydium-launchlab";
  const values = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) =>
      value === "launchlab" || value === "raydium" || value === "stonkfun"
        ? "raydium-launchlab"
        : value,
    );
  const out = [...new Set(values)] as string[];
  for (const value of out)
    if (value !== "pump" && value !== "raydium-launchlab")
      throw new Error(`Unsupported --venue value: ${value}`);
  return out as VenueId[];
}

function requireSingleEndpoint(flags: Flags): void {
  if (flags.has("rpc") || flags.has("ws"))
    throw new Error(
      "Set only RPC_ENDPOINT in the environment. --rpc and --ws are intentionally unsupported.",
    );
  if (!process.env.RPC_ENDPOINT?.trim())
    throw new Error(
      "Missing RPC_ENDPOINT. Set one Solana RPC URL in RPC_ENDPOINT; WebSocket access is derived from the same endpoint.",
    );
}

export async function runLaunchWatchCommand(args: {
  flags: Flags;
  emit: Emit;
  forcedVenues?: VenueId[];
}): Promise<void> {
  configure({
    silent: false,
    logger(_event: unknown, next?: () => void) {
      next?.();
    },
  });
  const json = args.flags.has("json");
  const m = createMeasure("slrd:launch-watch", { maxResultLength: 1600 });
  const report = <T extends Record<string, unknown>>(
    label: string,
    value: T,
  ): T => {
    if (json) {
      args.emit(`${JSON.stringify({ type: label, ...value })}\n`);
      return value;
    }
    return m.sync(
      { start: () => label, end: (result: T) => result },
      () => value,
    );
  };
  const venues = args.forcedVenues ?? venueList(args.flags);
  const minMarketCapUsd = numberFlag(args.flags, "min-mcap", 5_000);
  const athStepPct = numberFlag(args.flags, "ath-step-pct", 20);
  if (!(minMarketCapUsd > 0)) throw new Error("--min-mcap must be > 0");
  if (!(athStepPct > 0)) throw new Error("--ath-step-pct must be > 0");
  const trackTtlMs = duration(flag(args.flags, "track-ttl"), 30 * 60_000);
  const showNew = args.flags.has("show-new");
  const showPrices = args.flags.has("trades") || args.flags.has("prices");
  requireSingleEndpoint(args.flags);
  const states = new Map<string, WatchState>();
  let launches = 0;
  let prices = 0;
  let qualified = 0;
  let thresholdNotifications = 0;
  let athNotifications = 0;
  let ignoredMayhem = 0;
  let stopped = false;
  let tradeSubscription: TradeListener | null = null;

  const onLaunch = (event: LaunchEvent) => {
    if (!venues.includes(event.venue)) return;
    if (event.isMayhemMode === true) {
      ignoredMayhem += 1;
      return;
    }
    states.set(event.mint, {
      mint: event.mint,
      venue: event.venue,
      createdAtMs: event.atMs,
      lastSeenAtMs: event.atMs,
      supplyUi: event.supplyUi,
      qualified: false,
      athMarketCapUsd: null,
      lastNotifiedAthUsd: null,
    });
    void tradeSubscription?.add(event.mint);
    launches += 1;
    if (showNew)
      report("new launch", {
        at: new Date(event.atMs).toISOString(),
        venue: event.venue,
        mint: event.mint,
        symbol: event.symbol,
        name: event.name,
        supplyUi: event.supplyUi,
      });
  };

  const onTrade = (event: TradeEvent) => {
    const state = states.get(event.mint);
    if (!state) return;
    state.lastSeenAtMs = event.atMs;
    const priceSol = event.market.priceSol;
    const priceUsd = event.market.priceUsd;
    const marketCapUsd = event.market.marketCapUsd;
    prices += 1;
    if (showPrices)
      report("price", {
        at: new Date(event.atMs).toISOString(),
        venue: event.venue,
        mint: event.mint,
        marketCapUsd,
        priceUsd,
        priceSol,
        source: `${event.venue}-trade`,
      });
    if (!(
      marketCapUsd != null &&
      Number.isFinite(marketCapUsd) &&
      marketCapUsd > 0
    ))
      return;
    state.athMarketCapUsd = Math.max(state.athMarketCapUsd ?? 0, marketCapUsd);
    if (!state.qualified) {
      if (marketCapUsd < minMarketCapUsd) return;
      state.qualified = true;
      state.lastNotifiedAthUsd = marketCapUsd;
      qualified += 1;
      thresholdNotifications += 1;
      const nextAthNotifyUsd = marketCapUsd * (1 + athStepPct / 100);
      if (!args.flags.has("no-bell") && !json) process.stderr.write("\x07");
      report("market cap threshold", {
        at: new Date(event.atMs).toISOString(),
        venue: state.venue,
        mint: event.mint,
        marketCapUsd,
        thresholdMarketCapUsd: minMarketCapUsd,
        nextAthNotifyUsd,
        athStepPct,
        priceUsd,
        priceSol,
        signature: event.signature,
      });
      return;
    }
    const previous = state.lastNotifiedAthUsd;
    if (!(previous != null && previous > 0)) {
      state.lastNotifiedAthUsd = marketCapUsd;
      return;
    }
    const target = previous * (1 + athStepPct / 100);
    if (marketCapUsd + 1e-12 < target) return;
    state.lastNotifiedAthUsd = marketCapUsd;
    athNotifications += 1;
    const increasePct = (marketCapUsd / previous - 1) * 100;
    const nextAthNotifyUsd = marketCapUsd * (1 + athStepPct / 100);
    if (!args.flags.has("no-bell") && !json) process.stderr.write("\x07");
    report("new ath", {
      at: new Date(event.atMs).toISOString(),
      venue: state.venue,
      mint: event.mint,
      marketCapUsd,
      previousNotifiedAthUsd: previous,
      nextAthNotifyUsd,
      athStepPct,
      increasePct,
      priceUsd,
      priceSol,
      signature: event.signature,
    });
  };

  const controller = new AbortController();
  tradeSubscription = await slrd.listenTrades({
    tokens: [],
    venues: [
      ...(venues.includes("pump") ? (["pump", "pumpswap"] as const) : []),
      ...(venues.includes("raydium-launchlab")
        ? (["raydium-launchlab"] as const)
        : []),
    ],
    signal: controller.signal,
    onStatus(event, data) {
      report(`trades ${event}`, data ?? {});
    },
  });
  tradeSubscription.onTrade(onTrade);
  const launchSubscription = await slrd.subscribeLaunches({
    venues,
    signal: controller.signal,
    onLaunch,
    onStatus(event, data) {
      report(`launches ${event}`, data ?? {});
    },
  });

  const stop = () => {
    stopped = true;
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  report("ready", {
    rpc: "RPC_ENDPOINT",
    websocket: "derived-from-RPC_ENDPOINT",
    venues,
    minMarketCapUsd,
    athStepPct,
    excludeMayhem: true,
    trackTtlMs,
    upstreamSubscriptions: venues.length,
  });
  const heartbeat = setInterval(
    () => {
      const now = Date.now();
      for (const [mint, state] of states) {
        if (!state.qualified && now - state.lastSeenAtMs > trackTtlMs) {
          states.delete(mint);
          void tradeSubscription?.remove(mint);
        }
      }
      report("heartbeat", {
        launches,
        ignoredMayhem,
        tracked: states.size,
        qualified,
        prices,
        thresholdNotifications,
        athNotifications,
        watchedTokens: tradeSubscription?.list().length ?? 0,
      });
    },
    Math.max(1_000, Math.trunc(numberFlag(args.flags, "heartbeat-ms", 15_000))),
  );

  try {
    while (!stopped) await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    clearInterval(heartbeat);
    controller.abort();
    await launchSubscription.close();
    await tradeSubscription.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    report("stopped", {
      launches,
      prices,
      thresholdNotifications,
      athNotifications,
    });
  }
}
