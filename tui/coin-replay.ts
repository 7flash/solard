/** Replay a coin's trade history (from its launch) through the same SQD decoder the bots use, then stop.
 * Used on every migration: migrated coins are the ones that ran, so their early buyers are the wallets
 * worth knowing. Trades go to `onTrade` (the daemon feeds them into the trader scores). */
import type { Connection } from "@solana/web3.js";
import { getSolUsdPrice, subscribeTrades, type TradeEvent } from "../packages/core/src/market/launch-trades.ts";

const PORTAL = "https://portal.sqd.dev/datasets/solana-mainnet";

/** Launch time of the coin's bonding curve (DexScreener's pump.fun pair), else `fallbackHours` ago. */
export async function coinLaunchMs(mint: string, fallbackHours = 3): Promise<number> {
  try {
    const pairs = ((await (await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(8_000) })).json()) as
      { pairs?: Array<{ dexId?: string; pairCreatedAt?: number }> }).pairs ?? [];
    const created = pairs.map(p => p.pairCreatedAt ?? Infinity).reduce((a, b) => Math.min(a, b), Infinity);
    if (Number.isFinite(created)) return created;
  } catch {}
  return Date.now() - fallbackHours * 3600_000;
}

export async function replayCoin(o: {
  mint: string; fromMs: number; connection: Connection; onTrade: (e: TradeEvent) => void;
  log?: (t: string) => void; maxMs?: number;
}): Promise<{ trades: number; tookMs: number; caughtUp: boolean }> {
  const started = Date.now();
  const head = await (await fetch(`${PORTAL}/head`)).json() as { number: number };
  const fromSlot = Math.max(0, head.number - Math.ceil((started - o.fromMs) / 400) - 300); // ~2.5 slots/s
  let trades = 0, caughtUp = false, done!: () => void;
  const finished = new Promise<void>(r => { done = r; });
  const sub = await subscribeTrades({
    source: "sqd", sqd: { portalUrl: PORTAL, fromSlot }, connection: o.connection, tokens: [o.mint],
    venues: ["pump", "pumpswap", "raydium-launchlab", "raydium-cpmm", "meteora-dbc", "meteora-damm-v2"],
    metadata: false, solUsd: async () => (await getSolUsdPrice()).price, solUsdRefreshMs: 300_000,
    onTrade: e => { trades++; try { o.onTrade(e); } catch {} },
    onStatus: (event, data) => {
      if (event === "source-progress") {
        const at = Number((data as { atMs?: number } | undefined)?.atMs);
        if (Number.isFinite(at) && at >= started - 5_000) { caughtUp = true; done(); } // reached "now": history done
      }
    },
  } as Parameters<typeof subscribeTrades>[0]);
  const timer = setTimeout(done, o.maxMs ?? 10 * 60_000);
  await finished; clearTimeout(timer);
  await sub.close().catch(() => {});
  return { trades, tookMs: Date.now() - started, caughtUp };
}
