/** Every pump.fun curve trade and every PumpSwap trade, from one SQD stream of program event logs
 * (~25 events/s, ~15 KB/s), decoded locally: no RPC. Feeds the wallet scores with first-hand history of
 * every coin from launch, and tracks each coin until it is dead (< $3k and idle), so migrations never
 * need a history replay. PumpSwap events name the pool, so pool->mint comes from pool-creation events
 * (kept in .range-bots/pool-mints.json across restarts). */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { PublicKey, type Connection } from "@solana/web3.js";
import { canonicalPumpPoolCreator, decodePumpProgramData, decodePumpSwapProgramData } from "../packages/core/src/market/launch-trades.ts";
import type { TradeRow } from "./screen.ts";

const PORTAL = "https://portal.sqd.dev/datasets/solana-mainnet";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const SOL = "So11111111111111111111111111111111111111112";

/** Raw quote per raw base after a PumpSwap trade. The event's pool reserves are from before the swap (checked against the
 * vault balances of real trades), so they are moved by the trade itself; without this the price sits one trade behind. */
export function ammPriceAfter(e: { side: "buy" | "sell"; baseRaw: bigint; quoteRaw: bigint; poolBaseRaw: bigint; poolQuoteRaw: bigint; virtualQuoteRaw?: bigint | null }) {
  const buy = e.side === "buy", base = e.poolBaseRaw + (buy ? -e.baseRaw : e.baseRaw), quote = e.poolQuoteRaw + (buy ? e.quoteRaw : -e.quoteRaw) + (e.virtualQuoteRaw ?? 0n);
  return base > 0n ? Number(quote) / Number(base) : NaN;
}
export type CoinState = { mint: string; launchedAtMs: number | null; firstSeenMs: number; lastTradeMs: number; capUsd: number | null; /** SOL per token from the last trade's reserves. */ priceSol?: number; trades: number; migrated: boolean; symbol: string | null;
  /** After migration: market cap from PumpSwap trades only (the curve is empty then). */
  ammCapUsd?: number | null; ammTrades?: number; migratedAtMs?: number;
  /** Block of the launch event (holder backfill starts here). */
  launchBlock?: number;
  /** Deepest PumpSwap pool seen and its quote reserve (raw lamports): trades on far shallower pools are ignored. */
  mainPool?: string; mainPoolQuote?: number;
  /** Last trades, newest last (memory only; for the wallet explorer). */
  recent?: TradeRow[];
  /** Activity since we first saw the coin: unique traders and SOL volume. */
  traders?: Set<string>; volSol?: number;
  /** SOL volume per minute, last 60 minutes (key = minute number): rolling 1h volume without keeping every trade. */
  volMin?: Map<number, number> };
/** SOL traded in the last hour (only what the firehose has seen since it started). */
export function volume1h(c: CoinState, now = Date.now()) {
  if (!c.volMin) return 0;
  const from = Math.floor(now / 60_000) - 59; let v = 0;
  for (const [m, x] of c.volMin) if (m >= from) v += x; else c.volMin.delete(m);
  return v;
}
type PortalLog = { transactionIndex: number; logIndex: number; programId: string; kind: string; message: string };
type PortalBlock = { header: { number: number; timestamp?: number }; logs?: PortalLog[] };

export class Firehose {
  readonly coins = new Map<string, CoinState>();
  private readonly pools = new Map<string, { mint: string; supply: number; decimals?: number; quoteMint?: string }>();
  private poolMints: Set<string> | null = null;
  /** A PumpSwap pool of this coin is known: its trades are seen as they happen (no pool lookup needed first). */
  hasPool(mint: string) { this.poolMints ??= new Set([...this.pools.values()].map(p => p.mint)); return this.poolMints.has(mint); }
  private cursor: number | null = null;
  private stopped = false;
  stats: { events: number; trades: number; unknownPools: number; lagMs: number; startedAt: number; lastBlockMs?: number; rejected?: number; shallowPool?: number } = { events: 0, trades: 0, unknownPools: 0, lagMs: 0, startedAt: Date.now() };
  constructor(private readonly o: {
    poolsPath: string; solUsd: () => number | null; log: (t: string) => void; connection?: Connection;
    onTrade: (mint: string, row: TradeRow, coin: CoinState) => void;
    /** Coins quoted in XMR, DJT, PUMP, ...: SOL per one unit of the quote token and its decimals (cached by the
     * caller, refreshed in the background); null until known: those trades are skipped rather than mispriced. */
    quoteSol?: (quoteMint: string) => { solPerUnit: number; decimals: number } | null;
    /** A pump.fun migration (PumpSwap pool created by pump's migration authority, SOL quote). */
    onMigration?: (m: { mint: string; pool: string; atMs: number; coin: CoinState }) => void;
    deadCapUsd?: number; deadIdleMs?: number;
  }) {
    try { if (existsSync(o.poolsPath)) for (const [pool, v] of Object.entries(JSON.parse(readFileSync(o.poolsPath, "utf8")))) this.pools.set(pool, v as { mint: string; supply: number; decimals?: number; quoteMint?: string }); } catch {}
    setInterval(() => this.housekeep(), 60_000).unref?.();
    setInterval(() => void this.resolvePools(), Number(process.env.SLRD_POOL_RESOLVE_MS ?? 60_000)).unref?.(); // batches up to 100; a coin on a new pool waits at most this long
  }
  stop() { this.stopped = true; }

  async start() {
    let failures = 0;
    while (!this.stopped) {
      try {
        // Start ~1 min back (SLRD_FIREHOSE_REPLAY_BLOCKS, 150): migrations and smart-wallet buys during a daemon restart
        // were lost (Beast migrated in that gap and no bot saw it).
        if (this.cursor == null) this.cursor = (await (await fetch(`${PORTAL}/head`)).json() as { number: number }).number - Number(process.env.SLRD_FIREHOSE_REPLAY_BLOCKS ?? 150);
        const res = await fetch(`${PORTAL}/stream`, {
          method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120_000),
          body: JSON.stringify({ type: "solana", fromBlock: this.cursor,
            fields: { block: { number: true, timestamp: true }, log: { transactionIndex: true, logIndex: true, programId: true, kind: true, message: true } },
            logs: [{ programId: [PUMP, PUMP_AMM], kind: ["data"] }] }),
        });
        if (res.status === 204) { await Bun.sleep(400); continue; }
        if (!res.ok) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }
        // Newline-delimited blocks; read as they arrive so the stream stays near real time.
        const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            if (line.trim()) this.block(JSON.parse(line) as PortalBlock);
          }
        }
        failures = 0;
      } catch (error) {
        const wait = Math.min(30_000, 1_000 * 2 ** Math.min(failures++, 5));
        if (failures <= 2 || failures % 10 === 0) this.o.log(`firehose: ${error instanceof Error ? error.message : error}; retry in ${wait / 1000}s`);
        await Bun.sleep(wait);
      }
    }
  }

  private block(b: PortalBlock) {
    this.cursor = b.header.number + 1;
    const atMs = (b.header.timestamp ?? Date.now() / 1000) * 1000;
    this.stats.lagMs = Date.now() - atMs; this.stats.lastBlockMs = atMs;
    for (const log of b.logs ?? []) {
      this.stats.events++;
      const data = Buffer.from(log.message, "base64");
      const id = `${b.header.number}:${log.transactionIndex}:${log.logIndex}`;
      try {
        if (log.programId === PUMP) this.pump(data, id, atMs, b.header.number);
        else if (log.programId === PUMP_AMM) this.amm(data, id, atMs);
      } catch {}
    }
  }

  private coin(mint: string, atMs: number) {
    let c = this.coins.get(mint);
    if (!c) { c = { mint, launchedAtMs: null, firstSeenMs: atMs, lastTradeMs: atMs, capUsd: null, trades: 0, migrated: false, symbol: null }; this.coins.set(mint, c); }
    return c;
  }

  private pump(data: Buffer, id: string, atMs: number, blockNumber?: number) {
    const e = decodePumpProgramData(data);
    if (!e) return;
    if (e.kind === "launch") { const c = this.coin(e.mint, atMs); c.launchedAtMs = e.atMs || atMs; c.symbol = e.symbol; if (blockNumber != null) c.launchBlock = blockNumber; return; }
    if (e.kind !== "trade") return;
    // Curves quoted in another token: amounts and price in that token, converted to SOL.
    const q = e.quoteMint === SOL ? { solPerUnit: 1, decimals: 9 } : this.o.quoteSol?.(e.quoteMint) ?? null;
    if (!q) return;
    const unitQ = 10 ** q.decimals;
    const sol = Number(e.quoteRaw) / unitQ * q.solPerUnit, tokens = Number(e.baseRaw) / 1e6;
    const price = Number(e.virtualQuoteRaw) / unitQ / (Number(e.virtualBaseRaw) / 1e6) * q.solPerUnit; // SOL per token on the curve
    this.trade(e.mint, { signature: id, atMs: e.atMs || atMs, side: e.side, sol, tokens, capUsd: null, trader: e.trader, creator: e.creator }, price * 1e9, price);
  }

  private amm(data: Buffer, id: string, atMs: number) {
    const e = decodePumpSwapProgramData(data);
    if (!e) return;
    if (e.kind === "pool") {
      this.pools.set(e.pool, { mint: e.mint, supply: 1e9, decimals: e.baseDecimals, quoteMint: e.quoteMint }); this.poolMints?.add(e.mint);
      const c = this.coin(e.mint, atMs); c.migrated = true; c.migratedAtMs = atMs; c.ammTrades = 0; c.ammCapUsd = null;
      this.savePools();
      let canonical = false; try { canonical = e.index === 0 && e.creator === canonicalPumpPoolCreator(e.mint); } catch {}
      if (canonical) try { this.o.onMigration?.({ mint: e.mint, pool: e.pool, atMs, coin: c }); } catch {}
      return;
    }
    if (e.kind !== "trade") return;
    const p = this.pools.get(e.pool);
    if (!p) { this.stats.unknownPools++; if (!this.badPools.has(e.pool)) this.unknown.add(e.pool); return; } // migrated before we started: resolved in batches
    // Use the coin's own decimals (pool event); most pump coins have 6, some have 9.
    const unit = 10 ** (p.decimals ?? 6);
    const q = !p.quoteMint || p.quoteMint === SOL ? { solPerUnit: 1, decimals: 9 } : this.o.quoteSol?.(p.quoteMint) ?? null;
    if (!q) return; // quote price not known yet (a few seconds after the first sight of a new quote token)
    const unitQ = 10 ** q.decimals;
    const sol = Number(e.quoteRaw) / unitQ * q.solPerUnit, tokens = Number(e.baseRaw) / unit;
    const supply = e.supplyRaw != null ? Number(e.supplyRaw) / unit : p.supply;
    // PumpSwap prices with the virtual quote reserve on top of the real one (same as launch-trades): without it
    // migrated caps read 5-57% low against DexScreener.
    const price = ammPriceAfter(e) / unitQ * unit * q.solPerUnit;
    // Several pools per coin are possible; a dust pool prints prices 100x off. Follow the deepest one.
    const reserve = Number(e.poolQuoteRaw), cs = this.coins.get(p.mint);
    if (cs) {
      if (cs.mainPool && cs.mainPool !== e.pool && cs.mainPoolQuote != null && reserve * 4 < cs.mainPoolQuote) { this.stats.shallowPool = (this.stats.shallowPool ?? 0) + 1; return; }
      if (cs.mainPool === e.pool || cs.mainPoolQuote == null || reserve >= cs.mainPoolQuote) { cs.mainPool = e.pool; cs.mainPoolQuote = reserve; }
    }
    // A PumpSwap trade means the coin has migrated, even if we never saw the migration (it happened before we
    // started). Marked before trade() so onTrade listeners already see the AMM state.
    const c = this.coin(p.mint, e.atMs || atMs);
    if (!c.migrated) { c.migrated = true; c.migratedAtMs ??= e.atMs || atMs; }
    c.ammTrades = (c.ammTrades ?? 0) + 1;
    const capUsd = this.o.solUsd() ? price * supply * this.o.solUsd()! : null;
    if (capUsd != null && Number.isFinite(capUsd)) c.ammCapUsd = capUsd;
    this.trade(p.mint, { signature: id, atMs: e.atMs || atMs, side: e.side, sol, tokens, capUsd: null, trader: e.trader, creator: e.creator }, price * supply, price);
    c.ammCapUsd = c.capUsd ?? c.ammCapUsd;
  }

  private trade(mint: string, row: TradeRow, capSol: number, priceSol: number) {
    const solUsd = this.o.solUsd();
    row.capUsd = solUsd && Number.isFinite(capSol) ? capSol * solUsd : null;
    // Impossible for a pump coin: a misdecoded event. Never let it into prices or wallet scores.
    const price = row.sol != null && row.tokens ? row.sol / row.tokens : null;
    const why = (row.sol ?? 0) > 1_000 ? "sol>1000" : price != null && price > 0.001 ? "price>0.001" : row.capUsd != null && row.capUsd < 500 ? "cap<$500" : row.capUsd != null && row.capUsd > 5e8 ? "cap>$500M" : null;
    if (why) {
      this.stats.rejected = (this.stats.rejected ?? 0) + 1;
      // Diagnostics: which rule rejects, with sample coins (whole coins went invisible this way).
      const r = (this.rejects[why] ??= { n: 0, mints: new Set<string>() }); r.n++; if (r.mints.size < 4) r.mints.add(`${mint.slice(0, 6)}@${Math.round(row.capUsd ?? 0)}`);
      return;
    }
    const c = this.coin(mint, row.atMs);
    c.trades++; c.lastTradeMs = row.atMs; c.capUsd = row.capUsd ?? c.capUsd; if (Number.isFinite(priceSol) && priceSol > 0) c.priceSol = priceSol;
    (c.recent ??= []).push(row); if (c.recent.length > 600) c.recent.splice(0, c.recent.length - 600);
    if (row.trader) (c.traders ??= new Set()).add(row.trader); c.volSol = (c.volSol ?? 0) + (row.sol ?? 0);
    if (row.sol) { const m = Math.floor(row.atMs / 60_000), vm = (c.volMin ??= new Map()); vm.set(m, (vm.get(m) ?? 0) + row.sol); if (vm.size > 70) volume1h(c); }
    this.stats.trades++;
    this.o.onTrade(mint, row, c);
  }

  private readonly unknown = new Set<string>();
  private readonly badPools = new Set<string>();
  rejects: Record<string, { n: number; mints: Set<string> }> = {};
  private resolving = false;
  /** Pools created before we started: read up to 100 pool accounts per RPC call, base mint at offset 43
   * (discriminator 8, bump 1, index 2, creator 32). Each pool is looked up once, ever. */
  private async resolvePools() {
    if (this.resolving || !this.o.connection || !this.unknown.size) return;
    this.resolving = true;
    try {
      const batch = [...this.unknown].slice(0, 100);
      const infos = await this.o.connection.getMultipleAccountsInfo(batch.map(p => new PublicKey(p)));
      infos.forEach((info, i) => {
        const pool = batch[i]!; this.unknown.delete(pool);
        if (!info || info.data.length < 107 || !info.owner.equals(new PublicKey(PUMP_AMM))) { this.badPools.add(pool); return; }
        const mint = new PublicKey(info.data.subarray(43, 75)).toBase58(), quote = new PublicKey(info.data.subarray(75, 107)).toBase58();
        this.pools.set(pool, { mint, supply: 1e9, quoteMint: quote }); this.poolMints?.add(mint);
      });
      this.savePools();
    } catch {} finally { this.resolving = false; }
  }

  /** Forget dead coins (under the dead cap and idle), keep memory flat. */
  private housekeep() {
    const dead = this.o.deadCapUsd ?? 3_000, idle = this.o.deadIdleMs ?? 10 * 60_000, now = Date.now();
    let dropped = 0;
    for (const [mint, c] of this.coins) if (now - c.lastTradeMs > idle && (c.capUsd == null || c.capUsd < dead || now - c.lastTradeMs > 6 * 3600_000)) { this.coins.delete(mint); dropped++; }
    const s = this.stats;
    this.o.log(`firehose: ${this.coins.size} live coins, ${s.trades} trades, ${(s.trades / ((now - s.startedAt) / 1000)).toFixed(1)}/s, lag ${(s.lagMs / 1000).toFixed(1)}s, ${dropped} dead dropped, ${s.unknownPools} trades on unknown pools, ${s.rejected ?? 0} implausible trades rejected (${Object.entries(this.rejects).map(([k, v]) => `${k} ${v.n}: ${[...v.mints].join(" ")}`).join("; ")})`); this.rejects = {};
  }

  private savePoolsTimer: ReturnType<typeof setTimeout> | null = null;
  private savePools() {
    this.savePoolsTimer ??= setTimeout(() => {
      this.savePoolsTimer = null;
      try { writeFileSync(`${this.o.poolsPath}.tmp`, JSON.stringify(Object.fromEntries(this.pools))); renameSync(`${this.o.poolsPath}.tmp`, this.o.poolsPath); } catch {}
    }, 5_000);
  }
}
