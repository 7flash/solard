import { consumeFills, emptyBook, fillFromBuy, fillsToSell, seedFromBag, type FillBook } from "./fill-sells.ts";
import { dirname, join } from "node:path";
/** Runs one target-inventory bot (wallet + coin) inside slrd-bots. See target-inventory.ts for the rules.
 * Nearly stateless: holdings are the wallet's real balance, re-read every 15s and after each trade,
 * so outside buys/sells are simply part of the input. Status goes to .range-bots/target-<w>-<m>.json. */
import { renameSync, writeFileSync, readFileSync } from "node:fs";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { Solard } from "../packages/sdk/src/client.ts";
import { getSolUsdPrice, quoteSolLoader } from "../packages/core/src/market/launch-trades.ts";
import { samplePriceInSol } from "../packages/core/src/market/sample-price-sol.ts";
import type { MarketPrice } from "../packages/core/src/venues/venue-plugin.ts";
import type { PreparedFastTrade } from "../packages/core/src/tx/prepared-submission.ts";
import { withTradeRpcPriority } from "../packages/core/src/chain/rpc-priority.ts";
import { rangeLevels, targetPlan, type TargetPlan } from "../packages/core/src/runtime/target-inventory.ts";

export type TargetRange = { unit: "usd" | "sol"; buy: number; sell: number; steps: number };
export type TargetStatus = {
  mode: "target"; wallet: string; mint: string; budgetSol: number; range: TargetRange; updatedAt: number;
  priceSol: number | null; capUsd: number | null; balanceRaw: string | null; decimals: number | null;
  held: number | null; target: number | null; steps: number; buysPaused: boolean;
  nextBuy: number | null; nextSell: number | null;   // in the range's unit (USD mcap or SOL price)
  inFlight: string | null; last: string | null; error: string | null;
  /** Net SOL from this bot's confirmed trades (sells +, buys -). P&L = flowSol + value of holdings. */
  flowSol: number;
  supplyUi?: number | null;
  /** Last confirmed trade (ms), for "last trade" on the pages. */
  lastTradeAtMs?: number | null;
};

/** Reads must never stall a bot: a hung RPC call becomes an error and the next tick retries. */
const within = <T,>(ms: number, what: string, p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);

const SOL_MINT = "So11111111111111111111111111111111111111112";
const jupiterCache = new Map<string, { value: number; at: number }>();
const jupiterWanted = new Set<string>();
let jupiterBatch: Promise<void> | null = null, jupiterLastAt = 0;
/** One Jupiter price request for every coin that needs one (at most every 4s): per-coin calls got the
 * daemon rate-limited (HTTP 429) by Jupiter's free API. */
async function jupiterFetchAll() {
  const wait = Math.max(0, jupiterLastAt + 4_000 - Date.now());
  if (wait) await Bun.sleep(wait);
  jupiterLastAt = Date.now();
  const mints = [...jupiterWanted]; jupiterWanted.clear();
  for (let i = 0; i < mints.length; i += 49) {
    const ids = [...mints.slice(i, i + 49), SOL_MINT];
    try {
      const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids.join(",")}`, { signal: AbortSignal.timeout(5_000) });
      const j = await r.json() as Record<string, { usdPrice?: number } | undefined>;
      const sol = Number(j[SOL_MINT]?.usdPrice);
      for (const m of mints.slice(i, i + 49)) {
        const v = Number(j[m]?.usdPrice) / sol;
        if (v > 0 && Number.isFinite(v)) jupiterCache.set(m, { value: v, at: Date.now() });
      }
    } catch {}
  }
}
/** SOL per 1 token from Jupiter's price API (batched, cached ~5s per mint; stale value on failure). */
async function jupiterQuoteSol(mint: string): Promise<number | null> {
  const hit = jupiterCache.get(mint);
  if (hit && Date.now() - hit.at < 5_000) return hit.value;
  jupiterWanted.add(mint);
  jupiterBatch ??= jupiterFetchAll().finally(() => { jupiterBatch = null; });
  await jupiterBatch;
  return jupiterCache.get(mint)?.value ?? hit?.value ?? null;
}

const quoteLoaders = new WeakMap<Connection, ReturnType<typeof quoteSolLoader>>();
const sharedQuoteSol = (connection: Connection) => {
  let l = quoteLoaders.get(connection);
  if (!l) { l = quoteSolLoader(connection, () => {}, 60_000); quoteLoaders.set(connection, l); }
  return l;
};

/** The most a buy may pay: the range level it is buying for. It never falls under the old stream guard, so a level just above the price still fills. */
export function buyLimitSol(levels: number[], priceSol: number, baseBps: number) {
  const above = levels.filter(l => l >= priceSol), old = priceSol * (1.07 + baseBps / 10_000);
  return above.length ? Math.max(Math.min(...above), old) : old;
}

export class TargetBot {
  private stopped = false;
  private balance: { raw: bigint; at: number } | null = null;
  private supply: { ui: number; decimals: number; at: number } | null = null;
  private lastTradeAt = 0;
  private holdUntil = 0;
  /** Empty bot moved up to a running price: first buy only after a real pullback to a level under the highest it saw. */
  private dipBand: number | null = null;
  private wakeUp: (() => void) | null = null;
  private priceFailingSince = 0;
  private deadSince = 0;
  private dead = false;
  private lastRefreshAt = 0;
  private lastWakeAt = 0;
  /** Balance seen before the last confirmed trade: until the RPC shows a different one, it is stale. */
  private settling: { before: bigint; until: number } | null = null;
  /** The next order (sell or buy, whichever trigger is nearer) kept built and signed in the background while
   * the price is within 10% of its trigger: when the price gets there, executing it is a single broadcast. */
  private readonly urgentUntil: number;
  private buyRejects = 0;
  /** What each buy cost (tui/fill-sells.ts), saved beside the status file: survives restarts. */
  private book: FillBook = emptyBook();
  private pendingTake: NonNullable<ReturnType<typeof fillsToSell>> | null = null;
  private noRoomUntil = 0; private noRoomLogged = false;
  private prepared: { key: string; side: "buy" | "sell"; trigger: number; amountRaw?: bigint; trade: PreparedFastTrade; routeAt: number } | null = null;
  private preparing = false;
  private prepareErrAt = 0;
  private noPreparedUntil = 0; // venue without a prepared-order builder: normal path only
  readonly status: TargetStatus;
  private readonly loadQuoteSol;
  done: Promise<void> = Promise.resolve();

  constructor(private readonly o: {
    /** SOL this buy may use (the free SOL floor), at most what it asked for; sells are never held. */
    buyRoom?: (sol: number) => Promise<number>;
    client: Solard; connection: Connection; wallet: string; walletAddress: string; mint: string; budgetSol: number;
    range: () => TargetRange; samplePrice: () => Promise<MarketPrice>; statusPath: string;
    log: (text: string) => void; buysPaused?: boolean;
    /** Called once the coin is declared dead (sold and closed); the daemon removes the bot. */
    onDead?: () => void;
    /** Supply saved in the previous status file: no RPC read after a restart. */
    supply?: { ui: number; decimals: number } | null;
    /** Net SOL flow so far (from the previous status file or the daemon log), carried across restarts. */
    flowSol?: number;
    /** Shared wallet balance snapshot (tui/wallet-balances.ts): one RPC read for all of a wallet's coins. */
    balanceOf?: (owner: string, mint: string) => Promise<{ raw: bigint; at: number } | null>;
    /** A confirmed trade changed the wallet: the shared snapshot is stale. */
    onTraded?: () => void;
    /** A trade was rejected because the chain's price disagrees with ours: re-check the price source. */
    onPriceRejected?: () => void;
    /** Signal entry (smart wallets): RPC priority for the first 2 minutes. */
    urgent?: boolean;
  }) {
    this.urgentUntil = o.urgent ? Date.now() + 120_000 : 0;
    // One quote->SOL loader for every bot on this connection, cached 60s: each bot had its own (15s cache), so 9
    // DJT/XMR-quoted bots re-discovered the same quote pools over and over (~150 RPC calls/min).
    const onChain = sharedQuoteSol(o.connection);
    // Coins quoted in BTC, XMR, ...: use the on-chain quote market when there is one, else Jupiter's price.
    this.loadQuoteSol = async (mint: string, decimals: number) =>
      (await Promise.race([onChain(mint, decimals).catch(() => null), Bun.sleep(5_000).then(() => null)])) ?? await jupiterQuoteSol(mint);
    this.book = this.loadBook();
    this.status = { mode: "target", wallet: o.wallet, mint: o.mint, budgetSol: o.budgetSol, range: o.range(), updatedAt: Date.now(),
      priceSol: null, capUsd: null, balanceRaw: null, decimals: null, held: null, target: null, steps: o.range().steps,
      buysPaused: !!o.buysPaused, nextBuy: null, nextSell: null, inFlight: null, last: null, error: null, flowSol: o.flowSol ?? 0 };
  }
  private get bookPath() { return join(dirname(this.o.statusPath), `fills-${this.o.wallet}-${this.o.mint}.json`); }
  private loadBook(): FillBook { try { return { ...emptyBook(), ...JSON.parse(readFileSync(this.bookPath, "utf8")) }; } catch { return emptyBook(); } }
  private saveBook() { try { writeFileSync(`${this.bookPath}.tmp`, JSON.stringify(this.book)); renameSync(`${this.bookPath}.tmp`, this.bookPath); } catch {} }
  private seedSupply() { if (this.o.supply && this.o.supply.ui > 0 && this.o.supply.ui !== 1_000_000_000) this.supply = { ...this.o.supply, at: Date.now() }; } // exactly 1B may be the old hard-coded value: read it
  setBuysPaused(paused: boolean) { this.status.buysPaused = paused; this.write(); }
  /** Change the position size live (SOL at full inventory); the next tick buys up or sells down to the new targets. */
  /** Range and size changed together (tui/recenter.ts): nothing may fire on a mix of old and new numbers. */
  rebase(sol: number, waitForDip = false) { this.prepared = null; this.dipBand = waitForDip ? Infinity : null; this.holdUntil = Math.max(this.holdUntil, Date.now() + 15_000); this.setBudget(sol); }
  setBudget(sol: number) { if (!(sol > 0)) return; this.o.budgetSol = sol; this.status.budgetSol = sol; this.write(); this.wake(); }
  /** A new trade on this coin: tick now instead of waiting for the timer (at most every 400ms). */
  wake() { if (Date.now() - this.lastWakeAt < 400) return; this.lastWakeAt = Date.now(); this.wakeUp?.(); }
  start() { this.seedSupply(); this.done = this.loop(); return this; }
  stop() { this.stopped = true; return this.done; }

  private write() {
    this.status.updatedAt = Date.now();
    try { writeFileSync(`${this.o.statusPath}.tmp`, JSON.stringify(this.status)); renameSync(`${this.o.statusPath}.tmp`, this.o.statusPath); } catch {}
  }
  private async readBalance(force = false) {
    if (!force && this.balance && Date.now() - this.balance.at < 60_000) return this.balance.raw; // force-read before every trade
    if (!force && this.o.balanceOf) {
      const snap = await this.o.balanceOf(this.o.walletAddress, this.o.mint);
      if (snap) { this.balance = snap; return snap.raw; }
    }
    const r = await this.o.connection.getTokenAccountsByOwner(new PublicKey(this.o.walletAddress), { mint: new PublicKey(this.o.mint) });
    let raw = 0n;
    for (const a of r.value) raw += a.account.data.readBigUInt64LE(64); // SPL account: amount at offset 64
    this.balance = { raw, at: Date.now() };
    return raw;
  }
  private async readSupply() {
    if (this.supply && Date.now() - this.supply.at < 3_600_000) return this.supply; // tokens burn at migration, so 1B is not safe: re-read hourly
    try {
      const s = await this.o.connection.getTokenSupply(new PublicKey(this.o.mint));
      this.supply = { ui: Number(s.value.uiAmount ?? 0), decimals: s.value.decimals, at: Date.now() };
    } catch (error) {
      if (!this.supply && !this.o.mint.endsWith("pump")) throw error;
      this.supply = { ...(this.supply ?? { ui: 1_000_000_000, decimals: 6 }), at: Date.now() - 3_300_000 }; // RPC failed: try again in 5 min
    }
    return this.supply;
  }

  /** A coin that migrated (bonding curve -> AMM pool) keeps its old venue in the token registry, so its
   * price reads fail exactly when it pumps. After 30s of venue/price errors, re-register the token so the
   * venue and pool are discovered again (at most once a minute). */
  private async maybeRefreshVenue(error: string) {
    if (!/routing does not supply|verified live pool|curve (is )?complete|migrat|pool not found|no route|NO_ROUTE|Mint account not found/i.test(error)) return;
    this.priceFailingSince ||= Date.now();
    if (Date.now() - this.priceFailingSince < 30_000 || Date.now() - this.lastRefreshAt < 60_000) return;
    this.lastRefreshAt = Date.now();
    try {
      const t = await within(60_000, "token refresh", this.o.client.addToken(this.o.mint));
      this.o.log(`${this.o.wallet} ${this.o.mint.slice(0, 6)}: re-registered token after price errors, venue=${t.venueHint}${t.pool ? ` pool=${t.pool.slice(0, 6)}` : ""}`);
    } catch (e) { this.o.log(`${this.o.wallet} ${this.o.mint.slice(0, 6)}: token refresh failed: ${e instanceof Error ? e.message.slice(0, 120) : e}`); }
  }

  private async loop() {
    // After a restart, give any trade that was in flight time to land before acting on the balance.
    this.holdUntil = Date.now() + 15_000;
    // Stagger the first reads: 24 bots reading supply+balance in the same second clog a slow link.
    await Bun.sleep(Math.random() * 15_000);
    while (!this.stopped) {
      // A new signal-driven bot must get its first price and buy out in seconds: its ticks jump the RPC queue
      // for the first 2 minutes. Afterwards only the trade path does (see tick()).
      try { await (Date.now() < this.urgentUntil ? withTradeRpcPriority(() => this.tick()) : this.tick()); this.status.error = null; this.priceFailingSince = 0; }
      catch (error) {
        this.status.error = (error instanceof Error ? error.message : String(error)).slice(0, 200);
        await this.maybeRefreshVenue(this.status.error);
      }
      this.write();
      await new Promise<void>(done => { const t = setTimeout(done, 2_000); this.wakeUp = () => { clearTimeout(t); done(); }; });
      this.wakeUp = null;
    }
  }

  private async tick() {
    const range = this.o.range(); this.status.range = range; this.status.steps = range.steps;
    // Each read is timed on its own, so a timeout names the read that hung (price / supply / SOL-USD).
    const t0 = Date.now(), took: Record<string, number> = {};
    const timed = <T,>(name: string, p: Promise<T>) => p.finally(() => { took[name] = Date.now() - t0; });
    const reads = Promise.all([timed("price", this.samplePriceOrJupiter()), timed("supply", this.readSupply()), timed("solusd", getSolUsdPrice().then(p => p.price))]);
    const [sample, supply, solUsd] = await within(20_000, "price/supply read", reads).catch(error => {
      const pending = ["price", "supply", "solusd"].filter(k => took[k] == null);
      throw new Error(`${error instanceof Error ? error.message : error}; stuck: ${pending.join("+") || "none"}; done: ${Object.entries(took).map(([k, v]) => `${k} ${v}ms`).join(", ")}`);
    });
    const priceSol = (await within(15_000, "SOL price conversion", samplePriceInSol(sample, this.loadQuoteSol))).priceSol;
    if (!Number.isFinite(priceSol) || priceSol <= 0) throw new Error("no valid SOL price");
    // Range levels sit tens of % apart and every trade re-quotes on chain behind a price guard: a stream price up to
    // 60s old (SQD can run that far behind) decides fine; older ones fail instead of trading on them.
    const maxAge = Number(process.env.SLRD_MAX_PRICE_AGE_MS ?? 60_000);
    if (Date.now() - sample.capturedAtMs > maxAge) throw new Error(`price is stale (${Math.round((Date.now() - sample.capturedAtMs) / 1000)}s old)`);
    const toPrice = (v: number) => range.unit === "usd" ? v / (supply.ui * solUsd) : v;
    const fromPrice = (p: number) => range.unit === "usd" ? p * supply.ui * solUsd : p;
    const levels = rangeLevels(range.buy, range.sell, range.steps).map(toPrice);
    const balanceRaw = await within(15_000, "balance read", this.readBalance());
    const plan: TargetPlan = targetPlan({ levels, budgetSol: this.o.budgetSol, balanceRaw, decimals: supply.decimals, priceSol, buysPaused: this.status.buysPaused });
    Object.assign(this.status, { supplyUi: supply.ui, priceSol, capUsd: priceSol * supply.ui * solUsd, balanceRaw: balanceRaw.toString(), decimals: supply.decimals,
      held: plan.held, target: plan.target, nextBuy: plan.nextBuy == null ? null : fromPrice(plan.nextBuy), nextSell: plan.nextSell == null ? null : fromPrice(plan.nextSell) });
    // Dead coin: market cap under SLRD_DEAD_CAP_USD (default $3k) for 60s -> sell everything, close the
    // account, stop. Checked before the range plan, so it applies whatever the range says.
    // A range deliberately set under the line keeps its own line, 30% under its bottom. Otherwise the line is hard, but
    // not within 10 min of a buy: a $3k line under a $3.2k bottom step sold that step right after buying it.
    const line = Number(process.env.SLRD_DEAD_CAP_USD ?? 3_000), belowLine = range.unit === "usd" && range.buy < line;
    const deadCap = belowLine ? range.buy * 0.7 : line, capUsd = this.status.capUsd ?? Infinity;
    const justBought = !belowLine && Date.now() - (this.status.lastTradeAtMs ?? 0) < 10 * 60_000;
    if (deadCap > 0 && capUsd < deadCap && !justBought) {
      this.deadSince ||= Date.now();
      if (Date.now() - this.deadSince >= 60_000 && Date.now() >= this.holdUntil && !this.dead) { await this.liquidateDead(capUsd, deadCap, supply.decimals); return; }
    } else this.deadSince = 0;
    // Sold at a profit from its real fill, in or out of the range, before any range freeze: see tui/fill-sells.ts.
    if (!this.book.seeded) { this.book = { seeded: true, fills: seedFromBag(balanceRaw, supply.decimals, this.status.flowSol), rebuyAtSol: null }; this.saveBook(); }
    // The range decides. SLRD_FILL_SELL_X above 1 switches on selling each fill at that multiple, anywhere: off by default.
    const fillX = Number(process.env.SLRD_FILL_SELL_X ?? 0), take = fillX > 1 ? fillsToSell(this.book, priceSol, fillX) : null;
    if (take && balanceRaw > 0n && Date.now() >= this.holdUntil && Date.now() - this.lastTradeAt >= 1_000) {
      await withTradeRpcPriority(() => this.sellFills(take, plan, priceSol, supply.decimals, sample.quoteAsset.kind === "native-sol" ? 300 : 800)); return;
    }
    if (sample.quoteAsset.kind === "native-sol" && !this.settling) this.keepPrepared(levels, balanceRaw, supply.decimals, priceSol);
    const band = levels.filter(l => l <= priceSol).length;
    if (this.dipBand != null) {
      if (this.dipBand === Infinity || band >= this.dipBand) { this.dipBand = band; return; }
      this.dipBand = null;
    }
    if (!plan.action || Date.now() < this.holdUntil || Date.now() - this.lastTradeAt < 1_000) return;
    if (plan.action.side === "buy" && Date.now() < this.noRoomUntil) return; // no SOL for it: no balance read on every tick
    await withTradeRpcPriority(() => this.trade(levels, supply.decimals, priceSol, sample.quoteAsset.kind === "native-sol" ? 300 : 800));
  }

  private async sellFills(take: NonNullable<ReturnType<typeof fillsToSell>>, plan: TargetPlan, priceSol: number, decimals: number, slippageBps: number) {
    const fresh = await within(15_000, "balance read", this.readBalance(true));
    if (this.settling) {
      if (fresh === this.settling.before && Date.now() < this.settling.until) { this.balance = null; return; }
      this.settling = null;
    }
    // Under 5% left is dust: selling all closes the account and returns its rent.
    const amountRaw = take.sellRaw >= fresh * 95n / 100n ? fresh : take.sellRaw;
    if (amountRaw <= 0n) return;
    this.o.log(`${this.o.wallet} ${this.o.mint.slice(0, 6)}: take profit, fill at ${take.floorSol.toExponential(3)} SOL, price ${priceSol.toExponential(3)}`);
    this.pendingTake = take;
    await this.execute({ ...plan, action: { side: "sell", amountRaw } }, priceSol, fresh, decimals, slippageBps, take.floorSol);
    this.pendingTake = null;
  }

  /** Everything from the pre-trade balance read to the confirmation jumps the RPC queue. */
  private async trade(levels: number[], decimals: number, priceSol: number, slippageBps: number) {
    const supply = { decimals };
    // Re-read the balance right before trading: never act on a 15s-old view.
    const fresh = await within(15_000, "balance read", this.readBalance(true));
    // Right after a confirmed trade the RPC may still serve the old balance: trading on it would repeat
    // the trade. Wait until the balance moves (or 20s pass, then trust it).
    if (this.settling) {
      if (fresh === this.settling.before && Date.now() < this.settling.until) { this.balance = null; return; }
      this.settling = null;
    }
    const confirm = targetPlan({ levels, budgetSol: this.o.budgetSol, balanceRaw: fresh, decimals: supply.decimals, priceSol, buysPaused: this.status.buysPaused });
    if (!confirm.action || Date.now() < this.holdUntil) return;
    // Coins quoted in another token route SOL -> quote -> coin: two hops of price impact need more room.
    await this.execute(confirm, priceSol, fresh, supply.decimals, slippageBps, Math.min(...levels), buyLimitSol(levels, priceSol, slippageBps));
  }

  /** Pool price from our own venue code; for pools it cannot read (e.g. Raydium CPMM after a migration),
   * Jupiter's price in SOL. Trades for such coins route through Jupiter anyway. */
  private async samplePriceOrJupiter(): Promise<MarketPrice> {
    try { return await this.o.samplePrice(); }
    catch (error) {
      if (!/routing does not supply|verified live pool/i.test(String(error instanceof Error ? error.message : error))) throw error;
      const priceSol = await jupiterQuoteSol(this.o.mint);
      if (!priceSol) throw error;
      return { venue: "jupiter" as MarketPrice["venue"], mint: new PublicKey(this.o.mint), quoteAsset: { kind: "native-sol" } as MarketPrice["quoteAsset"],
        priceQuotePerToken: priceSol, capturedAtMs: Date.now() };
    }
  }

  /** Which order fires next and at what price (SOL per token), if the price is within 10% of it. */
  private nextOrder(levels: number[], balanceRaw: bigint, decimals: number, priceSol: number) {
    const base = { levels, budgetSol: this.o.budgetSol, balanceRaw, decimals, buysPaused: this.status.buysPaused };
    const now = targetPlan({ ...base, priceSol });
    if (now.action) return null; // already triggered: the normal path trades now
    const out: { side: "buy" | "sell"; trigger: number; amountRaw?: bigint; amountSol?: number; gap: number }[] = [];
    if (now.nextSell != null && priceSol >= now.nextSell * 0.9) {
      const at = targetPlan({ ...base, priceSol: now.nextSell });
      if (at.action?.side === "sell") out.push({ side: "sell", trigger: now.nextSell, amountRaw: at.action.amountRaw, gap: now.nextSell / priceSol });
    }
    if (now.nextBuy != null && priceSol <= now.nextBuy * 1.1 && !this.status.buysPaused) {
      const at = targetPlan({ ...base, priceSol: now.nextBuy });
      if (at.action?.side === "buy") out.push({ side: "buy", trigger: now.nextBuy, amountSol: Math.min(at.action.amountSol, this.o.budgetSol * 1.05), gap: priceSol / now.nextBuy });
    }
    return out.sort((a, b) => a.gap - b.gap)[0] ?? null;
  }

  /** Background only, never awaited by the tick. Rebuilds the route at most every 12s; in between only
   * re-signs with a fresh blockhash (the signed bytes are good for 5s). */
  private keepPrepared(levels: number[], balanceRaw: bigint, decimals: number, priceSol: number) {
    if (this.preparing || Date.now() < this.noPreparedUntil) return;
    const next = this.nextOrder(levels, balanceRaw, decimals, priceSol);
    if (!next) { this.prepared = null; return; }
    // Each build is several RPC reads and lasts seconds: only worth it close to the level, and only for a buy that has SOL.
    if ((next.side === "buy" && Date.now() < this.noRoomUntil) || Math.abs(next.trigger / priceSol - 1) > Number(process.env.SLRD_PREPARE_WITHIN ?? 0.03)) { this.prepared = null; return; }
    const key = `${next.side}:${next.amountRaw ?? next.amountSol!.toFixed(6)}:${next.trigger}`;
    const have = this.prepared?.key === key ? this.prepared : null;
    if (have && have.trade.expiresAt - Date.now() > 2_500) return;
    this.preparing = true;
    void withTradeRpcPriority(async () => {
      try {
        let trade: PreparedFastTrade | undefined;
        if (have && Date.now() - have.routeAt < 12_000) trade = await have.trade.refresh().catch(() => undefined);
        const routeAt = trade ? have!.routeAt : Date.now();
        trade ??= await this.o.client.prepareFastTrade({ side: next.side, token: this.o.mint, wallet: this.o.wallet,
          priceSol: String(next.trigger), priceKind: "spot", additionalSlippageBps: 200,
          ...(next.side === "sell" ? { amountRaw: next.amountRaw!.toString() } : { amountSol: next.amountSol!.toFixed(6) }) },
          { priorityFee: { cuLimit: 600_000, microLamports: 20_000 } });
        if (!this.prepared || this.prepared.key !== key) this.o.log(`${this.o.wallet} ${this.o.mint.slice(0, 6)}: ${next.side} prepared, fires at ${next.trigger.toExponential(4)} SOL (now ${priceSol.toExponential(4)})`);
        this.prepared = { key, side: next.side, trigger: next.trigger, amountRaw: next.amountRaw, trade, routeAt };
      } catch (error) {
        this.prepared = null;
        if ((error as { code?: string })?.code === "NO_PREPARED_ROUTE") this.noPreparedUntil = Date.now() + 600_000;
        if (Date.now() - this.prepareErrAt > 60_000) { this.prepareErrAt = Date.now(); this.o.log(`${this.o.wallet} ${this.o.mint.slice(0, 6)}: prepare ${next.side} failed: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`); }
      }
      finally { this.preparing = false; }
    });
  }

  /** The prepared order, if it is exactly the trade the plan wants now and still fresh. */
  private takePrepared(a: NonNullable<TargetPlan["action"]>, priceSol: number) {
    const p = this.prepared;
    if (!p || p.side !== a.side || p.trade.expiresAt - Date.now() < 300) return null;
    if (a.side === "sell" ? (p.amountRaw !== a.amountRaw || priceSol < p.trigger) : priceSol > p.trigger) return null;
    this.prepared = null;
    return p.trade;
  }

  private async liquidateDead(capUsd: number, deadCap: number, decimals: number) {
    const balance = await within(15_000, "balance read", this.readBalance(true));
    const label = `${this.o.wallet} ${this.o.mint.slice(0, 6)}`;
    if (balance > 0n) {
      this.status.inFlight = `DEAD (cap $${(capUsd / 1000).toFixed(1)}k < $${(deadCap / 1000).toFixed(1)}k): selling all`; this.write();
      this.o.log(`${label}: DEAD, cap $${capUsd.toFixed(0)} < $${deadCap} for 60s: selling all + closing account`);
      const r = await this.o.client.sell({ wallet: this.o.wallet, token: this.o.mint, amount: "all", closeTokenAccount: true, slippageBps: 1500 });
      this.status.inFlight = null; this.lastTradeAt = Date.now(); this.balance = null;
      if (r.status === "confirmed" && r.solPrincipalDeltaLamports != null) this.status.flowSol += Number(r.solPrincipalDeltaLamports) / 1e9;
      const sol = r.solPrincipalDeltaLamports != null ? ` ${(Number(r.solPrincipalDeltaLamports) / 1e9).toFixed(4)} SOL` : "";
      this.status.last = `${new Date().toLocaleTimeString()} dead-sell ${r.status}${sol}`;
      this.o.log(`${label}: DEAD sell ${r.status} ${r.code}${sol} ${r.signature ?? ""} ${r.status !== "confirmed" ? r.message.slice(0, 120) : ""}`);
      if (r.status === "unresolved") { this.holdUntil = Date.now() + 60_000; return; } // re-check the chain first
      if (r.status !== "confirmed") { this.holdUntil = Date.now() + 15_000; return; }   // retry
    }
    this.dead = true; this.status.error = "dead coin: liquidated"; this.write();
    this.o.log(`${label}: dead coin liquidated; removing bot`);
    this.o.onDead?.();
  }

  private async execute(plan: TargetPlan, priceSol: number, balanceRaw: bigint, decimals: number, slippageBps: number, floorSol: number, buyLimit?: number) {
    const label = `${this.o.wallet} ${this.o.mint.slice(0, 6)}`;
    let a = plan.action!;
    if (a.side === "buy" && this.o.buyRoom) {
      const room = await this.o.buyRoom(a.amountSol);
      if (room < 0.003) { this.noRoomUntil = Date.now() + 15_000; if (!this.noRoomLogged) this.o.log(`${label}: buy of ${a.amountSol.toFixed(4)} SOL waiting, the free SOL floor leaves nothing for it`); this.noRoomLogged = true; return; }
      this.noRoomLogged = false;
      if (room < a.amountSol) { this.o.log(`${label}: buy cut from ${a.amountSol.toFixed(4)} to ${room.toFixed(4)} SOL by the free SOL floor`); a = { ...a, amountSol: room }; }
    }
    let result: Awaited<ReturnType<Solard["buy"]>>;
    const pre = this.takePrepared(a, priceSol);
    if (pre) {
      const t0 = Date.now();
      this.status.inFlight = `${a.side} (prepared, to ${plan.target}/${plan.steps} steps)`; this.write();
      result = await pre.execute({});
      this.o.log(`${label}: ${a.side.toUpperCase()} prepared order sent in one call: ${result.status} ${result.code} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      // Not sent (expired, consumed, cancelled): fall through to building the trade now.
      if (result.status === "failed" && /^PREPARATION_|ORDER_CANCELLED/.test(String(result.code))) result = undefined as never;
    }
    if (result!) { /* sent from the prepared order */ }
    else if (a.side === "buy") {
      const amountSol = Math.min(a.amountSol, this.o.budgetSol * 1.05);
      if (amountSol < 0.003) return;
      this.status.inFlight = `buy ${amountSol.toFixed(4)} SOL (to ${plan.target}/${plan.steps} steps)`; this.write();
      this.o.log(`${label}: BUY ${amountSol.toFixed(4)} SOL to reach ${plan.target}/${plan.steps} steps`);
      result = await this.o.client.buy({ wallet: this.o.wallet, token: this.o.mint, amount: amountSol.toFixed(6), ...(buyLimit ? { maxPriceSol: buyLimit } : { slippageBps, maxPriceSol: priceSol * (1.07 + slippageBps / 10_000) }) });
    } else {
      const all = a.amountRaw >= balanceRaw;
      this.status.inFlight = `sell ${(Number(a.amountRaw) / 10 ** decimals).toFixed(0)} tokens (to ${plan.target}/${plan.steps} steps)`; this.write();
      this.o.log(`${label}: SELL ${a.amountRaw} raw${all ? " (all + close account)" : ""} to reach ${plan.target}/${plan.steps} steps`);
      result = await this.o.client.sell({ wallet: this.o.wallet, token: this.o.mint, slippageBps, // A sell can take a while to land on a busy RPC; a 10% guard from the trigger price then rejects it
      // after a quick retrace and the bot rides the dump. Allow up to 25% below the trigger, never below the range bottom.
      minPriceSol: Math.max(floorSol, priceSol * 0.75),
        ...(all ? { amount: "all", closeTokenAccount: true } : { amountRaw: a.amountRaw.toString() }) });
    }
    this.lastTradeAt = Date.now(); this.status.inFlight = null;
    if (result.status === "confirmed" && result.solPrincipalDeltaLamports != null) this.status.flowSol += Number(result.solPrincipalDeltaLamports) / 1e9;
    const sol = result.solPrincipalDeltaLamports != null ? ` ${Number(result.solPrincipalDeltaLamports) / 1e9 >= 0 ? "+" : ""}${(Number(result.solPrincipalDeltaLamports) / 1e9).toFixed(4)} SOL` : "";
    this.status.last = `${new Date().toLocaleTimeString()} ${a.side} ${result.status}${sol}${result.signature ? ` ${result.signature.slice(0, 10)}` : ""}${result.status !== "confirmed" ? ` ${result.message.slice(0, 80)}` : ""}`;
    this.o.log(`${label}: ${a.side.toUpperCase()} ${result.status} ${result.code}${sol} ${result.signature ?? ""} ${result.status !== "confirmed" ? result.message.slice(0, 120) : ""}`);
    // Unknown outcome: wait for the chain before deciding again, so a trade is never doubled.
    if (result.status === "confirmed") { this.buyRejects = 0; this.status.lastTradeAtMs = Date.now(); this.o.onTraded?.(); }
    if (result.status === "confirmed") {
      this.settling = { before: balanceRaw, until: Date.now() + 20_000 };
      const delta = result.solPrincipalDeltaLamports != null ? Math.abs(Number(result.solPrincipalDeltaLamports)) / 1e9 : 0;
      if (a.side === "buy") { if (delta > 0) this.book.fills.push(fillFromBuy(delta, priceSol, decimals)); this.book.rebuyAtSol = null; }
      else if (a.amountRaw >= balanceRaw) { this.book.fills = []; this.book.rebuyAtSol = this.pendingTake?.rebuyAtSol ?? null; }
      else if (this.pendingTake) { this.book.fills = this.pendingTake.remaining; this.book.rebuyAtSol = this.pendingTake.rebuyAtSol; }
      else this.book.fills = consumeFills(this.book.fills, a.amountRaw);
      this.saveBook();
    }
    if (result.status === "unresolved") this.holdUntil = Date.now() + 60_000;
    else if (result.status === "failed") {
      const priceMiss = result.code === "PRICE_GUARD_REJECTED" || result.code === "SLIPPAGE";
      // The chain disagrees with our price: have the price source re-check on chain before the next decision.
      if (priceMiss) this.o.onPriceRejected?.();
      // 3 buys in a row rejected against the chain: our price source for this coin is wrong (e.g. it reads a stale
      // pool while trades route elsewhere). Stop buying blind; sells continue. Resume from the CLI/web.
      if (priceMiss && a.side === "buy" && ++this.buyRejects >= 3) {
        this.buyRejects = 0; this.setBuysPaused(true);
        this.status.error = "buys paused: 3 buys rejected, the chain price keeps disagreeing with our price source";
        this.o.log(`${label}: buys paused after 3 price-guard rejections in a row (price source disagrees with the chain)`);
      }
      // Sells retry fast (a missed exit costs most); a rejected buy waits 30s instead of looping every second on a stale price.
      // No SOL in the wallet: retrying every few seconds only burns RPC (1331 failures in one day); wait a minute.
      const noSol = /INSUFFICIENT_SOL/.test(String(result.code));
      this.holdUntil = Date.now() + (noSol ? 60_000 : !priceMiss ? 10_000 : a.side === "sell" ? 1_000 : 30_000);
    }
    this.balance = null; // re-read on next tick
  }
}
