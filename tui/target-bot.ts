/** Runs one target-inventory bot (wallet + coin) inside slrd-bots. See target-inventory.ts for the rules.
 * Nearly stateless: holdings are the wallet's real balance, re-read every 15s and after each trade,
 * so outside buys/sells are simply part of the input. Status goes to .range-bots/target-<w>-<m>.json. */
import { renameSync, writeFileSync } from "node:fs";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { Solard } from "../packages/sdk/src/client.ts";
import { getSolUsdPrice, quoteSolLoader } from "../packages/core/src/market/launch-trades.ts";
import { samplePriceInSol } from "../packages/core/src/market/sample-price-sol.ts";
import type { MarketPrice } from "../packages/core/src/venues/venue-plugin.ts";
import { rangeLevels, targetPlan, type TargetPlan } from "../packages/core/src/runtime/target-inventory.ts";

export type TargetRange = { unit: "usd" | "sol"; buy: number; sell: number; steps: number };
export type TargetStatus = {
  mode: "target"; wallet: string; mint: string; budgetSol: number; range: TargetRange; updatedAt: number;
  priceSol: number | null; capUsd: number | null; balanceRaw: string | null; decimals: number | null;
  held: number | null; target: number | null; steps: number; buysPaused: boolean;
  nextBuy: number | null; nextSell: number | null;   // in the range's unit (USD mcap or SOL price)
  inFlight: string | null; last: string | null; error: string | null;
};

/** Reads must never stall a bot: a hung RPC call becomes an error and the next tick retries. */
const within = <T,>(ms: number, what: string, p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);

const SOL_MINT = "So11111111111111111111111111111111111111112";
const jupiterCache = new Map<string, { value: number; at: number }>();
/** SOL per 1 quote token from Jupiter's price API, cached 30s per mint. */
async function jupiterQuoteSol(mint: string): Promise<number | null> {
  const hit = jupiterCache.get(mint);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  try {
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint},${SOL_MINT}`, { signal: AbortSignal.timeout(5_000) });
    const j = await r.json() as Record<string, { usdPrice?: number } | undefined>;
    const value = Number(j[mint]?.usdPrice) / Number(j[SOL_MINT]?.usdPrice);
    if (!(value > 0) || !Number.isFinite(value)) return hit?.value ?? null;
    jupiterCache.set(mint, { value, at: Date.now() });
    return value;
  } catch { return hit?.value ?? null; }
}

export class TargetBot {
  private stopped = false;
  private balance: { raw: bigint; at: number } | null = null;
  private supply: { ui: number; decimals: number; at: number } | null = null;
  private lastTradeAt = 0;
  private holdUntil = 0;
  private wakeUp: (() => void) | null = null;
  private lastWakeAt = 0;
  /** Balance seen before the last confirmed trade: until the RPC shows a different one, it is stale. */
  private settling: { before: bigint; until: number } | null = null;
  readonly status: TargetStatus;
  private readonly loadQuoteSol;
  done: Promise<void> = Promise.resolve();

  constructor(private readonly o: {
    client: Solard; connection: Connection; wallet: string; walletAddress: string; mint: string; budgetSol: number;
    range: () => TargetRange; samplePrice: () => Promise<MarketPrice>; statusPath: string;
    log: (text: string) => void; buysPaused?: boolean;
  }) {
    const onChain = quoteSolLoader(o.connection, () => {});
    // Coins quoted in BTC, XMR, ...: use the on-chain quote market when there is one, else Jupiter's price.
    this.loadQuoteSol = async (mint: string, decimals: number) =>
      (await Promise.race([onChain(mint, decimals).catch(() => null), Bun.sleep(5_000).then(() => null)])) ?? await jupiterQuoteSol(mint);
    this.status = { mode: "target", wallet: o.wallet, mint: o.mint, budgetSol: o.budgetSol, range: o.range(), updatedAt: Date.now(),
      priceSol: null, capUsd: null, balanceRaw: null, decimals: null, held: null, target: null, steps: o.range().steps,
      buysPaused: !!o.buysPaused, nextBuy: null, nextSell: null, inFlight: null, last: null, error: null };
  }
  setBuysPaused(paused: boolean) { this.status.buysPaused = paused; this.write(); }
  /** A new trade on this coin: tick now instead of waiting for the timer (at most every 400ms). */
  wake() { if (Date.now() - this.lastWakeAt < 400) return; this.lastWakeAt = Date.now(); this.wakeUp?.(); }
  start() { this.done = this.loop(); return this; }
  stop() { this.stopped = true; return this.done; }

  private write() {
    this.status.updatedAt = Date.now();
    try { writeFileSync(`${this.o.statusPath}.tmp`, JSON.stringify(this.status)); renameSync(`${this.o.statusPath}.tmp`, this.o.statusPath); } catch {}
  }
  private async readBalance(force = false) {
    if (!force && this.balance && Date.now() - this.balance.at < 60_000) return this.balance.raw; // force-read before every trade
    const r = await this.o.connection.getTokenAccountsByOwner(new PublicKey(this.o.walletAddress), { mint: new PublicKey(this.o.mint) });
    let raw = 0n;
    for (const a of r.value) raw += a.account.data.readBigUInt64LE(64); // SPL account: amount at offset 64
    this.balance = { raw, at: Date.now() };
    return raw;
  }
  private async readSupply() {
    if (this.supply && Date.now() - this.supply.at < 600_000) return this.supply; // pump supply is fixed
    const s = await this.o.connection.getTokenSupply(new PublicKey(this.o.mint));
    this.supply = { ui: Number(s.value.uiAmount ?? 0), decimals: s.value.decimals, at: Date.now() };
    return this.supply;
  }

  private async loop() {
    // After a restart, give any trade that was in flight time to land before acting on the balance.
    this.holdUntil = Date.now() + 15_000;
    // Stagger the first reads: 24 bots reading supply+balance in the same second clog a slow link.
    await Bun.sleep(Math.random() * 15_000);
    while (!this.stopped) {
      try { await this.tick(); this.status.error = null; }
      catch (error) { this.status.error = (error instanceof Error ? error.message : String(error)).slice(0, 200); }
      this.write();
      await new Promise<void>(done => { const t = setTimeout(done, 2_000); this.wakeUp = () => { clearTimeout(t); done(); }; });
      this.wakeUp = null;
    }
  }

  private async tick() {
    const range = this.o.range(); this.status.range = range; this.status.steps = range.steps;
    const [sample, supply, solUsd] = await within(20_000, "price/supply read", Promise.all([this.o.samplePrice(), this.readSupply(), getSolUsdPrice().then(p => p.price)]));
    const priceSol = (await within(15_000, "SOL price conversion", samplePriceInSol(sample, this.loadQuoteSol))).priceSol;
    if (!Number.isFinite(priceSol) || priceSol <= 0) throw new Error("no valid SOL price");
    if (Date.now() - sample.capturedAtMs > 15_000) throw new Error("price is stale");
    const toPrice = (v: number) => range.unit === "usd" ? v / (supply.ui * solUsd) : v;
    const fromPrice = (p: number) => range.unit === "usd" ? p * supply.ui * solUsd : p;
    const levels = rangeLevels(range.buy, range.sell, range.steps).map(toPrice);
    const balanceRaw = await within(15_000, "balance read", this.readBalance());
    const plan: TargetPlan = targetPlan({ levels, budgetSol: this.o.budgetSol, balanceRaw, decimals: supply.decimals, priceSol, buysPaused: this.status.buysPaused });
    Object.assign(this.status, { priceSol, capUsd: priceSol * supply.ui * solUsd, balanceRaw: balanceRaw.toString(), decimals: supply.decimals,
      held: plan.held, target: plan.target, nextBuy: plan.nextBuy == null ? null : fromPrice(plan.nextBuy), nextSell: plan.nextSell == null ? null : fromPrice(plan.nextSell) });
    if (!plan.action || Date.now() < this.holdUntil || Date.now() - this.lastTradeAt < 1_000) return;
    // Re-read the balance right before trading: never act on a 15s-old view.
    const fresh = await within(15_000, "balance read", this.readBalance(true));
    // Right after a confirmed trade the RPC may still serve the old balance: trading on it would repeat
    // the trade. Wait until the balance moves (or 20s pass, then trust it).
    if (this.settling) {
      if (fresh === this.settling.before && Date.now() < this.settling.until) { this.balance = null; return; }
      this.settling = null;
    }
    const confirm = targetPlan({ levels, budgetSol: this.o.budgetSol, balanceRaw: fresh, decimals: supply.decimals, priceSol, buysPaused: this.status.buysPaused });
    if (!confirm.action) return;
    // Coins quoted in another token route SOL -> quote -> coin: two hops of price impact need more room.
    await this.execute(confirm, priceSol, fresh, supply.decimals, sample.quoteAsset.kind === "native-sol" ? 300 : 800);
  }

  private async execute(plan: TargetPlan, priceSol: number, balanceRaw: bigint, decimals: number, slippageBps: number) {
    const a = plan.action!, label = `${this.o.wallet} ${this.o.mint.slice(0, 6)}`;
    let result: Awaited<ReturnType<Solard["buy"]>>;
    if (a.side === "buy") {
      const amountSol = Math.min(a.amountSol, this.o.budgetSol * 1.05);
      if (amountSol < 0.003) return;
      this.status.inFlight = `buy ${amountSol.toFixed(4)} SOL (to ${plan.target}/${plan.steps} steps)`; this.write();
      this.o.log(`${label}: BUY ${amountSol.toFixed(4)} SOL to reach ${plan.target}/${plan.steps} steps`);
      result = await this.o.client.buy({ wallet: this.o.wallet, token: this.o.mint, amount: amountSol.toFixed(6), slippageBps, maxPriceSol: priceSol * (1.07 + slippageBps / 10_000) });
    } else {
      const all = a.amountRaw >= balanceRaw;
      this.status.inFlight = `sell ${(Number(a.amountRaw) / 10 ** decimals).toFixed(0)} tokens (to ${plan.target}/${plan.steps} steps)`; this.write();
      this.o.log(`${label}: SELL ${a.amountRaw} raw${all ? " (all + close account)" : ""} to reach ${plan.target}/${plan.steps} steps`);
      result = await this.o.client.sell({ wallet: this.o.wallet, token: this.o.mint, slippageBps, minPriceSol: priceSol * (0.93 - slippageBps / 10_000),
        ...(all ? { amount: "all", closeTokenAccount: true } : { amountRaw: a.amountRaw.toString() }) });
    }
    this.lastTradeAt = Date.now(); this.status.inFlight = null;
    const sol = result.solPrincipalDeltaLamports != null ? ` ${Number(result.solPrincipalDeltaLamports) / 1e9 >= 0 ? "+" : ""}${(Number(result.solPrincipalDeltaLamports) / 1e9).toFixed(4)} SOL` : "";
    this.status.last = `${new Date().toLocaleTimeString()} ${a.side} ${result.status}${sol}${result.signature ? ` ${result.signature.slice(0, 10)}` : ""}${result.status !== "confirmed" ? ` ${result.message.slice(0, 80)}` : ""}`;
    this.o.log(`${label}: ${a.side.toUpperCase()} ${result.status} ${result.code}${sol} ${result.signature ?? ""} ${result.status !== "confirmed" ? result.message.slice(0, 120) : ""}`);
    // Unknown outcome: wait for the chain before deciding again, so a trade is never doubled.
    if (result.status === "confirmed") this.settling = { before: balanceRaw, until: Date.now() + 20_000 };
    if (result.status === "unresolved") this.holdUntil = Date.now() + 60_000;
    else if (result.status === "failed") this.holdUntil = Date.now() + 10_000;
    this.balance = null; // re-read on next tick
  }
}
