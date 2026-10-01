import { configure, createMeasure } from "measure-fn";
import { Connection } from "@solana/web3.js";
import {
  subscribeLaunches,
  subscribeTrades,
  type LaunchEvent,
  type TradeEvent,
  type TradeSubscription,
} from "@solard/core";

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

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

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

function rpcUrl(flags: Flags): string {
  const value =
    flag(flags, "rpc") ??
    process.env.RPC_ENDPOINT?.trim() ??
    process.env.SOLANA_RPC_URL?.trim() ??
    process.env.HELIUS_RPC_URL?.trim();
  if (!value)
    throw new Error(
      "Missing --rpc, RPC_ENDPOINT, SOLANA_RPC_URL, or HELIUS_RPC_URL",
    );
  return value;
}

function wsUrl(flags: Flags): string | undefined {
  return (
    flag(flags, "ws") ??
    process.env.SOLANA_WS_URL?.trim() ??
    process.env.HELIUS_WS_URL?.trim()
  );
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadSolUsd(): Promise<number> {
  try {
    const raw = (await fetchJson(
      "https://api.coinbase.com/v2/prices/SOL-USD/spot",
    )) as { data?: { amount?: unknown } };
    const value = Number(raw.data?.amount);
    if (Number.isFinite(value) && value > 0) return value;
  } catch {}
  const raw = (await fetchJson(
    "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
  )) as { solana?: { usd?: unknown } };
  const value = Number(raw.solana?.usd);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("SOL/USD unavailable");
  return value;
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
  const rpc = rpcUrl(args.flags);
  const ws = wsUrl(args.flags);
  const connection = new Connection(
    rpc,
    ws ? { commitment: "confirmed", wsEndpoint: ws } : "confirmed",
  );
  const states = new Map<string, WatchState>();
  let launches = 0;
  let prices = 0;
  let qualified = 0;
  let thresholdNotifications = 0;
  let athNotifications = 0;
  let ignoredMayhem = 0;
  let solUsd: number | null = null;
  let stopped = false;
  let tradeSubscription: TradeSubscription | null = null;

  const refreshSolUsd = async () => {
    try {
      solUsd = await loadSolUsd();
    } catch (error) {
      report("sol/usd unavailable", {
        error: error instanceof Error ? error.message : String(error),
        cached: solUsd,
      });
    }
  };

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
    void tradeSubscription?.addTokens(event.mint);
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
    if (!state || event.priceQuote == null) return;
    state.lastSeenAtMs = event.atMs;
    let priceSol: number | null = null;
    let priceUsd: number | null = null;
    if (event.quoteMint === WSOL_MINT) {
      priceSol = event.priceQuote;
      priceUsd = solUsd == null ? null : event.priceQuote * solUsd;
    } else if (event.quoteMint === USDC_MINT) {
      priceUsd = event.priceQuote;
      priceSol = solUsd == null ? null : event.priceQuote / solUsd;
    }
    const marketCapUsd = priceUsd == null ? null : priceUsd * state.supplyUi;
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
  tradeSubscription = await subscribeTrades({
    connection,
    tokens: [],
    venues: [
      ...(venues.includes("pump") ? (["pump", "pumpswap"] as const) : []),
      ...(venues.includes("raydium-launchlab")
        ? (["raydium-launchlab"] as const)
        : []),
    ],
    signal: controller.signal,
    onTrade,
    onStatus(event, data) {
      report(`trades ${event}`, data ?? {});
    },
  });
  const launchSubscription = await subscribeLaunches({
    connection,
    venues,
    signal: controller.signal,
    onLaunch,
    onStatus(event, data) {
      report(`launches ${event}`, data ?? {});
    },
  });

  await refreshSolUsd();
  const solTimer = setInterval(() => void refreshSolUsd(), 60_000);
  const stop = () => {
    stopped = true;
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  report("ready", {
    rpc,
    ws: ws ?? "connection-default",
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
          void tradeSubscription?.removeTokens(mint);
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
        watchedTokens: tradeSubscription?.listTokens().length ?? 0,
        solUsd,
      });
    },
    Math.max(1_000, Math.trunc(numberFlag(args.flags, "heartbeat-ms", 15_000))),
  );

  try {
    while (!stopped) await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    clearInterval(solTimer);
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
