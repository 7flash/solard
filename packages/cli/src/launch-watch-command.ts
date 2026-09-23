import { configure, createMeasure } from "measure-fn";
import { connectPriceFeed } from "./price-feed-client.ts";
import type { PriceFeedLaunch, PriceFeedPrice } from "./price-feed-protocol.ts";

type Flags = Map<string, string>;
type Emit = (value: string) => void;
type VenueId = "pump" | "raydium-launchlab";
type WatchState = {
  mint: string;
  venue: VenueId;
  createdAtMs: number;
  lastSeenAtMs: number;
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

function feedUrl(flags: Flags): string {
  return (
    flag(flags, "feed") ??
    process.env.SOLARD_FEED_URL?.trim() ??
    "ws://127.0.0.1:8788/ws"
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
  const url = feedUrl(args.flags);
  const states = new Map<string, WatchState>();
  let launches = 0;
  let prices = 0;
  let qualified = 0;
  let thresholdNotifications = 0;
  let athNotifications = 0;
  let ignoredMayhem = 0;
  let feedConnected = false;
  let stopped = false;
  let feedClient: Awaited<ReturnType<typeof connectPriceFeed>> | null = null;

  const onLaunch = (event: PriceFeedLaunch) => {
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
      qualified: false,
      athMarketCapUsd: null,
      lastNotifiedAthUsd: null,
    });
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

  const onPrice = (event: PriceFeedPrice) => {
    let state = states.get(event.mint);
    if (!state) return;
    if (!venues.includes(state.venue)) return;
    state.lastSeenAtMs = event.atMs;
    prices += 1;
    if (showPrices)
      report("price", {
        at: new Date(event.atMs).toISOString(),
        venue: event.venue,
        mint: event.mint,
        marketCapUsd: event.marketCapUsd,
        priceUsd: event.priceUsd,
        priceSol: event.priceSol,
        source: event.source,
      });
    const mcap = event.marketCapUsd;
    if (!(mcap != null && Number.isFinite(mcap) && mcap > 0)) return;
    state.athMarketCapUsd = Math.max(state.athMarketCapUsd ?? 0, mcap);
    if (!state.qualified) {
      if (mcap < minMarketCapUsd) return;
      state.qualified = true;
      state.lastNotifiedAthUsd = mcap;
      if (state.venue === "raydium-launchlab")
        feedClient?.subscribeMints([event.mint]);
      qualified += 1;
      thresholdNotifications += 1;
      const nextAthNotifyUsd = mcap * (1 + athStepPct / 100);
      if (!args.flags.has("no-bell") && !json) process.stderr.write("\x07");
      report("market cap threshold", {
        at: new Date(event.atMs).toISOString(),
        venue: state.venue,
        mint: event.mint,
        marketCapUsd: mcap,
        thresholdMarketCapUsd: minMarketCapUsd,
        nextAthNotifyUsd,
        athStepPct,
        priceUsd: event.priceUsd,
        priceSol: event.priceSol,
        signature: event.signature,
      });
      return;
    }
    const previous = state.lastNotifiedAthUsd;
    if (!(previous != null && previous > 0)) {
      state.lastNotifiedAthUsd = mcap;
      return;
    }
    const target = previous * (1 + athStepPct / 100);
    if (mcap + 1e-12 < target) return;
    state.lastNotifiedAthUsd = mcap;
    athNotifications += 1;
    const increasePct = (mcap / previous - 1) * 100;
    const nextAthNotifyUsd = mcap * (1 + athStepPct / 100);
    if (!args.flags.has("no-bell") && !json) process.stderr.write("\x07");
    report("new ath", {
      at: new Date(event.atMs).toISOString(),
      venue: state.venue,
      mint: event.mint,
      marketCapUsd: mcap,
      previousNotifiedAthUsd: previous,
      nextAthNotifyUsd,
      athStepPct,
      increasePct,
      priceUsd: event.priceUsd,
      priceSol: event.priceSol,
      signature: event.signature,
    });
  };

  const controller = new AbortController();
  feedClient = await connectPriceFeed({
    url,
    subscribe: { op: "subscribe", launches: true, allPrices: true },
    signal: controller.signal,
    onStatus(event, data) {
      if (event === "connected") feedConnected = true;
      if (event === "connect-error") feedConnected = false;
      report(`feed ${event}`, data ?? {});
    },
    onMessage(message) {
      if (message.type === "launch") onLaunch(message);
      if (message.type === "price") onPrice(message);
    },
  });

  const stop = () => {
    stopped = true;
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  report("ready", {
    feed: url,
    venues,
    minMarketCapUsd,
    athStepPct,
    excludeMayhem: true,
    trackTtlMs,
    upstreamSubscriptions: 0,
  });
  const heartbeat = setInterval(
    () => {
      const now = Date.now();
      for (const [mint, state] of states) {
        if (!state.qualified && now - state.lastSeenAtMs > trackTtlMs)
          states.delete(mint);
      }
      report("heartbeat", {
        feedConnected,
        launches,
        ignoredMayhem,
        tracked: states.size,
        qualified,
        prices,
        thresholdNotifications,
        athNotifications,
        upstreamSubscriptions: 0,
      });
    },
    Math.max(1_000, Math.trunc(numberFlag(args.flags, "heartbeat-ms", 15_000))),
  );

  try {
    while (!stopped) await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    clearInterval(heartbeat);
    controller.abort();
    feedClient?.close();
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
