/** One SQD trade subscription feeding prices to every bot in the process.
 *
 * Pump curve and PumpSwap prices only move on trades, so "last trade price, valid up to the
 * newest block SQD has processed" is exact. A price is reported with capturedAtMs = that
 * block's timestamp; when the stream lags more than maxAgeMs (or has no price yet) the
 * feed falls back to one RPC read. Every verifyMs it also reads RPC and compares; if SQD
 * disagrees by more than maxDivergence the mint is pinned to RPC. */
import type { Connection } from "@solana/web3.js";
import { subscribeTrades, type TradeEvent, type TradeSubscription } from "../packages/core/src/market/launch-trades.ts";
import type { MarketPrice } from "../packages/core/src/venues/venue-plugin.ts";

type Sampler = (mint: string) => Promise<MarketPrice>;
type Entry = { template?: MarketPrice; price?: number; tradeAtMs?: number; rpcAtMs?: number; verifiedAtMs?: number;
  pinnedToRpc?: string; trades: number; rpcInFlight?: Promise<MarketPrice>; rpcLast?: MarketPrice };
export type FeedStats = { mint: string; source: "sqd" | "rpc" | "none"; price: number | null; trades: number; pinnedToRpc?: string };

export class SqdPriceFeed {
  private readonly entries = new Map<string, Entry>();
  private subscription: TradeSubscription | null = null;
  private opening: Promise<void> | null = null;
  private closed = false;
  /** Newest block timestamp the stream has fully processed. */
  lastBlockMs = 0;
  lastProgressAt = 0;
  status = "starting";
  constructor(private readonly options: {
    connection: Connection; rpcSample: Sampler; log: (text: string) => void;
    maxAgeMs?: number; verifyMs?: number; maxDivergence?: number;
    onTrade?: (event: TradeEvent) => void;
  }) {}

  private get maxAgeMs() { return this.options.maxAgeMs ?? 12_000; } // SQD normally runs 2-6s behind the chain
  private live(now = Date.now()) { return !!this.subscription && now - this.lastBlockMs <= this.maxAgeMs; }

  async add(mint: string) {
    if (!this.entries.has(mint)) this.entries.set(mint, { trades: 0 });
    await this.ensureOpen();
    if (!this.subscription!.hasToken(mint)) await this.subscription!.addTokens(mint);
  }
  async remove(mint: string) {
    this.entries.delete(mint);
    if (this.subscription?.hasToken(mint)) await this.subscription.removeTokens(mint).catch(() => {});
  }
  stats(): FeedStats[] {
    const now = Date.now();
    return [...this.entries].map(([mint, e]) => ({ mint, trades: e.trades, pinnedToRpc: e.pinnedToRpc,
      price: e.price ?? null, source: e.price == null ? "none" : !e.pinnedToRpc && this.live(now) ? "sqd" : "rpc" }));
  }
  async close() { this.closed = true; await this.subscription?.close().catch(() => {}); }

  /** Engine sampler: SQD price when the stream is current, otherwise one RPC read. */
  async samplePrice(mint: string): Promise<MarketPrice> {
    const e = this.entries.get(mint) ?? { trades: 0 };
    this.entries.set(mint, e);
    const now = Date.now();
    const verifyDue = now - (e.verifiedAtMs ?? 0) > (this.options.verifyMs ?? 120_000);
    if (e.template && e.price != null && !e.pinnedToRpc && this.live(now) && !verifyDue) {
      return { venue: e.template.venue, mint: e.template.mint, quoteAsset: e.template.quoteAsset,
        priceQuotePerToken: e.price, capturedAtMs: Math.min(now, Math.max(this.lastBlockMs, e.tradeAtMs ?? 0)) };
    }
    // Share one RPC read per coin (in flight or < 4s old): RPC is the fallback, not a poller.
    if (e.rpcInFlight) return e.rpcInFlight;
    if (e.rpcLast && now - e.rpcLast.capturedAtMs < 4_000) return e.rpcLast;
    e.rpcInFlight = this.options.rpcSample(mint).finally(() => { e.rpcInFlight = undefined; });
    const rpc = await e.rpcInFlight;
    e.rpcLast = rpc;
    if (e.price != null && e.template && this.live(now)) {
      const divergence = Math.abs(e.price - rpc.priceQuotePerToken) / rpc.priceQuotePerToken;
      // Volatile coins move a few % between the last trade and an RPC read; only a large gap means a broken feed.
      if (!e.pinnedToRpc && divergence > (this.options.maxDivergence ?? 0.15)) {
        e.pinnedToRpc = `SQD ${e.price.toPrecision(6)} vs RPC ${rpc.priceQuotePerToken.toPrecision(6)} (${(divergence * 100).toFixed(1)}%)`;
        this.options.log(`price feed ${mint}: pinned to RPC, ${e.pinnedToRpc}`);
      } else if (e.pinnedToRpc && divergence < 0.03) {
        this.options.log(`price feed ${mint}: SQD agrees again; back on SQD`); e.pinnedToRpc = undefined;
      }
    }
    e.template = rpc; e.price = rpc.priceQuotePerToken; e.rpcAtMs = rpc.capturedAtMs; e.verifiedAtMs = now;
    return rpc;
  }

  private ensureOpen(): Promise<void> {
    if (this.subscription) return Promise.resolve();
    this.opening ??= this.open().finally(() => { this.opening = null; });
    return this.opening;
  }
  private async open() {
    const tokens = [...this.entries.keys()];
    this.subscription = await subscribeTrades({
      source: "sqd", sqd: { portalUrl: "https://portal.sqd.dev/datasets/solana-mainnet" },
      connection: this.options.connection, tokens, venues: ["pump", "pumpswap"],
      onTrade: event => {
        const e = this.entries.get(event.mint);
        if (e) {
          // Ignore trades older than our last RPC read: the RPC price already includes them.
          const price = event.market.priceQuotePerToken;
          if (Number.isFinite(price) && price > 0 && event.atMs >= (e.rpcAtMs ?? 0) - 1_000) {
            if (e.template && e.template.venue !== event.venue) { e.template = undefined; this.options.log(`price feed ${event.mint}: venue changed to ${event.venue}`); }
            e.price = price; e.tradeAtMs = event.atMs;
          }
          e.trades++;
        }
        try { this.options.onTrade?.(event); } catch {}
      },
      onStatus: (event, data) => {
        if (event === "source-progress") {
          const at = Number((data as { atMs?: number } | undefined)?.atMs);
          if (Number.isFinite(at) && at > this.lastBlockMs) this.lastBlockMs = at;
          this.lastProgressAt = Date.now(); this.status = "live";
        } else if (event !== "tokens-changed") this.options.log(`sqd ${event} ${JSON.stringify(data ?? {}).slice(0, 300)}`);
      },
    });
    this.status = "live";
    const current = this.subscription;
    void current.closed.then(async () => {
      if (this.closed || this.subscription !== current) return;
      this.subscription = null; this.status = "reconnecting"; this.options.log("sqd feed closed; reconnecting (RPC prices meanwhile)");
      while (!this.closed && !this.subscription) {
        await Bun.sleep(2_000);
        try { await this.ensureOpen(); } catch (error) { this.options.log(`sqd reconnect failed: ${error}`); }
      }
    });
  }
}
