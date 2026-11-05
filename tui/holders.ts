/** Exact holders and transfers of the coins we watch, from the SQD portal's token balances (pre/post balance of every
 * token account touched by a transaction). The trade stream only sees pump.fun/PumpSwap trades: a wallet that moves
 * its tokens to another wallet (13% of one coin's transactions) still looked like a holder, relays that buy for users
 * looked like whales, and bundles that spread tokens over fresh wallets were invisible.
 *
 * - holding = the latest post-balance of each token account, summed per owner (exact, transfers included)
 * - transfer = a transaction that changes balances of the coin without any DEX program in it: senders -> receivers
 * - cluster = wallets whose first tokens came by transfer from one source; their combined share of supply
 * One stream for all watched coins from the head; a coin added later is backfilled from its launch block
 * (or up to SLRD_HOLDERS_BACKFILL_BLOCKS, ~24h) in its own request. Snapshots: .range-bots/holders/<mint>.json */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PORTAL = "https://portal.sqd.dev/datasets/solana-mainnet";
const MAX_BACKFILL_BYTES = Number(process.env.SLRD_HOLDERS_MAX_MB ?? 32) * 1_000_000;
/** Programs that make a balance change a trade, not a transfer. */
const DEX = new Set([
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // pump.fun
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // PumpSwap
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter v6
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // Raydium CPMM
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj", // Raydium LaunchLab
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", // Meteora DLMM
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", // Meteora DAMM v2
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", // Meteora DBC
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", // Meteora pools
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirlpool
]);

type Row = { transactionIndex: number; account: string; preMint?: string; postMint?: string; preOwner?: string; postOwner?: string; preAmount?: string; postAmount?: string };
type Block = { header: { number: number; timestamp?: number }; tokenBalances?: Row[]; instructions?: { transactionIndex: number; programId: string }[]; transactions?: { transactionIndex: number; signatures?: string[] }[] };
export type Transfer = { atMs: number; signature: string | null; from: string[]; to: string[]; amount: number };
type Coin = {
  mint: string; decimals: number; accounts: Map<string, { owner: string; amount: bigint }>;
  firstFrom: Map<string, string>;          // owner -> wallet its first tokens came from (transfer)
  transfers: Transfer[]; transferCount: number; cursor: number | null; ready: boolean; dirty: boolean;
};

export class Holders {
  private readonly coins = new Map<string, Coin>();
  private cursor: number | null = null;
  private stopped = false;
  private wakeLoop: (() => void) | null = null;
  constructor(private readonly o: { root: string; log: (t: string) => void; launchBlock?: (mint: string) => number | null;
    /** Pool / bonding-curve accounts of the coin (they hold the liquidity, not a holder). */
    pools?: (mint: string) => string[] }) {
    mkdirSync(resolve(o.root, ".range-bots", "holders"), { recursive: true });
    setInterval(() => this.flush(), 5_000).unref?.();
  }

  /** Backfills run one at a time (the SQD portal answers 429/529 to ~100 parallel ones); urgent = opened on a page. */
  private readonly queue: string[] = [];
  private backfilling = false;
  /** Start tracking a coin (idempotent). decimals: 6 for pump.fun. urgent: backfill it before the others. */
  watch(mint: string, decimals = 6, urgent = false) {
    if (process.env.SLRD_HOLDERS === "0") return;
    if (this.coins.has(mint)) {
      if (urgent && !this.coins.get(mint)!.ready) { const i = this.queue.indexOf(mint); if (i > 0) { this.queue.splice(i, 1); this.queue.unshift(mint); } }
      return;
    }
    this.coins.set(mint, { mint, decimals, accounts: new Map(), firstFrom: new Map(), transfers: [], transferCount: 0, cursor: null, ready: false, dirty: false });
    if (urgent) this.queue.unshift(mint); else this.queue.push(mint);
    void this.drain();
    this.wakeLoop?.();
  }
  private async drain() {
    if (this.backfilling) return;
    this.backfilling = true;
    try {
      while (this.queue.length && !this.stopped) {
        const mint = this.queue.shift()!;
        if (!this.coins.has(mint)) continue;
        const ok = await this.backfill(mint);
        if (!ok && this.coins.has(mint)) { this.queue.push(mint); await Bun.sleep(15_000); } // portal busy: retry later, others first
      }
    } finally { this.backfilling = false; }
  }
  unwatch(mint: string) { this.coins.delete(mint); }
  watching() { return [...this.coins.keys()]; }

  start() { void this.loop(); return this; }
  stop() { this.stopped = true; }

  private request(mints: string[], fromBlock: number, toBlock?: number) {
    return fetch(`${PORTAL}/stream`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ type: "solana", fromBlock, ...(toBlock != null ? { toBlock } : {}),
        fields: { block: { number: true, timestamp: true }, tokenBalance: { transactionIndex: true, account: true, preMint: true, postMint: true, preOwner: true, postOwner: true, preAmount: true, postAmount: true },
          transaction: { transactionIndex: true, signatures: true }, instruction: { transactionIndex: true, programId: true } },
        tokenBalances: [{ postMint: mints, transaction: true, transactionInstructions: true }, { preMint: mints, transaction: true, transactionInstructions: true }] }) });
  }

  /** Reads newline-delimited blocks; returns the next block to ask for. */
  private async consume(res: Response, only?: string): Promise<number | null> {
    if (res.status === 204) return null;
    if (!res.ok) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }
    const reader = res.body!.getReader(), dec = new TextDecoder(); let buf = "", next: number | null = null, bytes = 0;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      // A coin with a long life can stream gigabytes and took the whole machine's memory: a backfill stops here, partial.
      if (only && (bytes += value.length) > MAX_BACKFILL_BYTES) { await reader.cancel().catch(() => {}); return null; }
      buf += dec.decode(value, { stream: true }); let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const b = JSON.parse(line) as Block; this.block(b, only); next = b.header.number + 1;
      }
    }
    return next;
  }

  private block(b: Block, only?: string) {
    const atMs = (b.header.timestamp ?? Date.now() / 1000) * 1000;
    const byTx = new Map<number, Row[]>();
    for (const r of b.tokenBalances ?? []) (byTx.get(r.transactionIndex) ?? byTx.set(r.transactionIndex, []).get(r.transactionIndex)!).push(r);
    for (const [ti, rows] of byTx) {
      const dex = (b.instructions ?? []).some(i => i.transactionIndex === ti && DEX.has(i.programId));
      const sig = b.transactions?.find(t => t.transactionIndex === ti)?.signatures?.[0] ?? null;
      const byMint = new Map<string, Row[]>();
      for (const r of rows) { const m = r.postMint ?? r.preMint; if (m) (byMint.get(m) ?? byMint.set(m, []).get(m)!).push(r); }
      for (const [mint, list] of byMint) {
        if (only && mint !== only) continue;
        const c = this.coins.get(mint); if (!c) continue;
        const delta = new Map<string, bigint>();
        for (const r of list) {
          const owner = r.postOwner ?? r.preOwner; if (!owner) continue;
          const post = BigInt(r.postAmount ?? "0"), pre = BigInt(r.preAmount ?? "0");
          c.accounts.set(r.account, { owner, amount: post });
          if (post !== pre) delta.set(owner, (delta.get(owner) ?? 0n) + post - pre);
        }
        c.dirty = true;
        if (dex) continue;
        const from = [...delta].filter(([, d]) => d < 0n).map(([o]) => o), to = [...delta].filter(([, d]) => d > 0n).map(([o]) => o);
        if (!from.length || !to.length) continue; // mint/burn/account open-close
        const amount = Number([...delta].filter(([, d]) => d > 0n).reduce((a, [, d]) => a + d, 0n)) / 10 ** c.decimals;
        c.transfers.push({ atMs, signature: sig, from, to, amount }); c.transferCount++;
        if (c.transfers.length > 500) c.transfers.splice(0, c.transfers.length - 500);
        for (const t of to) if (!c.firstFrom.has(t)) c.firstFrom.set(t, from[0]!);
      }
    }
  }

  private async head() { return (await (await fetch(`${PORTAL}/head`)).json() as { number: number }).number; }

  /** A newly watched coin: its history from launch (or ~24h) up to the live stream's cursor. */
  private async backfill(mint: string): Promise<boolean> {
    const c = this.coins.get(mint); if (!c) return true;
    try {
      const head = this.cursor ?? await this.head();
      const launch = this.o.launchBlock?.(mint) ?? null;
      // From launch when the firehose saw it, else ~6h back (SLRD_HOLDERS_BACKFILL_BLOCKS).
      let from = c.cursor ?? launch ?? head - Number(process.env.SLRD_HOLDERS_BACKFILL_BLOCKS ?? 54_000);
      const t0 = Date.now();
      while (from < head && !this.stopped && this.coins.has(mint)) {
        // Chunks of SLRD_HOLDERS_CHUNK_BLOCKS (5000): one request for the whole range got HTTP 529 (portal overloaded).
        const to = Math.min(head, from + Number(process.env.SLRD_HOLDERS_CHUNK_BLOCKS ?? 5_000));
        const next = (await this.consume(await this.request([mint], from, to), mint)) ?? to + 1;
        if (next <= from) break;
        from = next; c.cursor = from; // resume point if the portal cuts us off
      }
      c.ready = true; c.dirty = true;
      this.o.log(`holders ${mint.slice(0, 6)}: backfilled in ${((Date.now() - t0) / 1000).toFixed(1)}s from ${launch != null ? "launch" : "~6h"}: ${this.ownerCount(c)} holders, ${c.transferCount} transfers`);
      return true;
    } catch (error) {
      this.o.log(`holders ${mint.slice(0, 6)}: backfill paused (${error instanceof Error ? error.message.slice(0, 60) : error}), retrying later`);
      return false;
    }
  }

  /** Live: every watched coin from the head onward, one request. */
  private async loop() {
    let failures = 0;
    while (!this.stopped) {
      const mints = [...this.coins.keys()];
      if (!mints.length) { await new Promise<void>(r => { this.wakeLoop = r; setTimeout(r, 5_000); }); continue; }
      try {
        this.cursor ??= await this.head();
        const next = await this.consume(await this.request(mints, this.cursor));
        if (next != null) this.cursor = next; else await Bun.sleep(1_000);
        failures = 0;
      } catch (error) {
        const wait = Math.min(30_000, 1_000 * 2 ** Math.min(failures++, 5));
        if (failures <= 2 || failures % 10 === 0) this.o.log(`holders stream: ${error instanceof Error ? error.message : error}; retry in ${wait / 1000}s`);
        await Bun.sleep(wait);
      }
    }
  }

  private ownerCount(c: Coin) { const s = new Set<string>(); for (const a of c.accounts.values()) if (a.amount > 0n) s.add(a.owner); return s.size; }

  /** Exact holdings per owner, transfers and funding clusters of a coin. */
  snapshot(mint: string) {
    const c = this.coins.get(mint); if (!c) return null;
    const unit = 10 ** c.decimals, supply = 1e9;
    const pools = new Set(this.o.pools?.(mint) ?? []);
    const byOwner = new Map<string, bigint>();
    for (const a of c.accounts.values()) if (!pools.has(a.owner)) byOwner.set(a.owner, (byOwner.get(a.owner) ?? 0n) + a.amount);
    const holders = [...byOwner].filter(([, v]) => v > 0n).map(([owner, v]) => ({ owner, amount: Number(v) / unit, pct: Number(v) / unit / supply * 100, from: c.firstFrom.get(owner) ?? null }))
      .sort((a, b) => b.amount - a.amount);
    // Clusters: holders funded by transfer, grouped by the wallet their first tokens came from.
    const groups = new Map<string, { members: string[]; pct: number }>();
    for (const h of holders) if (h.from) { const g = groups.get(h.from) ?? { members: [], pct: 0 }; g.members.push(h.owner); g.pct += h.pct; groups.set(h.from, g); }
    const clusters = [...groups].map(([source, g]) => ({ source, members: g.members.length, pct: g.pct })).filter(g => g.members >= 2).sort((a, b) => b.pct - a.pct);
    return { mint, ready: c.ready, at: Date.now(), holders, clusters, transfers: c.transfers.slice(-200).reverse(), transferCount: c.transferCount };
  }

  private flush() {
    for (const c of this.coins.values()) {
      if (!c.dirty) continue; c.dirty = false;
      const s = this.snapshot(c.mint); if (!s) continue;
      const p = resolve(this.o.root, ".range-bots", "holders", `${c.mint}.json`);
      try { writeFileSync(p + ".tmp", JSON.stringify({ ...s, holders: s.holders.slice(0, 2_000) })); renameSync(p + ".tmp", p); } catch {}
    }
  }
}
