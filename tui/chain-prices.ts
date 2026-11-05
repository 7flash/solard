/** Prices of every bot's coin read straight from chain, all at once: one getMultipleAccounts call (up to 100
 * accounts) every few seconds instead of a stream. pump.fun bonding curve: the curve account (virtual reserves).
 * PumpSwap: the pool (virtual quote reserves) and its two vaults. ~80 coins = 2-3 calls per round, about 1 RPC
 * call/s in total, prices 1-3s old, and no dependence on the SQD portal (which throttles us to minutes of lag).
 * Coins on other venues are not handled here (null: the caller falls back to its streams). */
import { PublicKey, type Connection } from "@solana/web3.js";
import { bondingCurvePda } from "../packages/core/src/venues/pump/pda.ts";
import { decodeCurve, decodePool } from "../packages/core/src/venues/pump/state.ts";
import { spotPriceQuotePerToken } from "../packages/core/src/venues/pump/quote.ts";
import type { MarketPrice } from "../packages/core/src/venues/venue-plugin.ts";

const SOL = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
type TokenRow = { mint: string; venueHint?: string | null; pool?: string | null; decimals?: number | null; metadataJson?: string | null; creator?: string | null; quoteTokenProgram?: string | null };
type Pool = { address: PublicKey; baseVault: PublicKey; quoteVault: PublicKey; quoteMint: string; quoteDecimals: number; baseDecimals: number };
type Entry = { mint: string; kind: "curve" | "pumpswap"; row: TokenRow; pool?: Pool; price?: MarketPrice; error?: string; checkedAt?: number };

const splAmount = (data: Buffer) => data.length >= 72 ? data.readBigUInt64LE(64) : null; // SPL token account: amount at 64
const mintDecimals = (data: Buffer) => data.length >= 45 ? data[44]! : null;           // SPL mint: decimals at 44

export class ChainPrices {
  private readonly entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  lastRoundMs = 0; lastRoundAt = 0; calls = 0;
  constructor(private readonly o: { connection: Connection; resolve: (mint: string) => TokenRow | null; log: (t: string) => void;
    intervalMs?: number; wrap?: <T>(task: () => Promise<T>) => Promise<T>;
    /** The stream has no usable price for this coin: read it this round. Without it every coin is read every round. */
    needs?: (mint: string) => boolean;
    /** Every coin is read this often anyway, so a coin the stream silently misses cannot stay wrong. */
    recheckMs?: number }) {}

  /** Start pricing a coin (no-op for venues this reader does not handle). */
  add(mint: string) {
    if (this.entries.has(mint)) return;
    const row = this.o.resolve(mint);
    const kind = row?.venueHint === "pumpswap" && row.pool ? "pumpswap" : row?.venueHint === "pump-curve" ? "curve" : null;
    if (!row || !kind) return;
    this.entries.set(mint, { mint, kind, row });
    this.timer ??= setInterval(() => void this.round(), this.o.intervalMs ?? 3_000);
  }
  remove(mint: string) { this.entries.delete(mint); }
  /** This reader prices the coin (curve or PumpSwap) and has not failed on it. */
  handles(mint: string) { const e = this.entries.get(mint); return !!e && !(e.error && /complete|missing|empty/.test(e.error)); }
  /** Last on-chain price if it is at most maxAgeMs old. */
  price(mint: string, maxAgeMs = 10_000): MarketPrice | null {
    const p = this.entries.get(mint)?.price;
    return p && Date.now() - p.capturedAtMs <= maxAgeMs ? p : null;
  }
  stats() {
    const all = [...this.entries.values()], errs = new Map<string, number>();
    for (const e of all) if (e.error) errs.set(e.error.slice(0, 50), (errs.get(e.error.slice(0, 50)) ?? 0) + 1);
    return { coins: all.length, priced: all.filter(e => e.price && Date.now() - e.price.capturedAtMs < 25_000).length, lastRoundMs: this.lastRoundMs,
      sinceRoundMs: this.lastRoundAt ? Date.now() - this.lastRoundAt : null, errors: [...errs].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => `${n}x ${k}`).join("; ") };
  }

  private async many(keys: PublicKey[]) {
    const out: (Buffer | null)[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      this.calls++;
      const infos = await this.o.connection.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed");
      out.push(...infos.map(x => (x ? Buffer.from(x.data) : null)));
    }
    return out;
  }

  /** PumpSwap pools: vault addresses and decimals, read once per pool. */
  private async resolvePools() {
    const need = [...this.entries.values()].filter(e => e.kind === "pumpswap" && !e.pool);
    if (!need.length) return;
    const data = await this.many(need.map(e => new PublicKey(e.row.pool!)));
    const quoteMints: PublicKey[] = [];
    const decoded = need.map((e, i) => {
      try { const d = data[i]; if (!d) throw new Error("pool account missing"); const p = decodePool(new PublicKey(e.row.pool!), d); quoteMints.push(p.quoteMint); return p; }
      catch (error) { e.error = String(error instanceof Error ? error.message : error); return null; }
    });
    const qd = await this.many(quoteMints);
    let q = 0;
    need.forEach((e, i) => {
      const p = decoded[i]; if (!p) return;
      const quoteMint = p.quoteMint.toBase58(), quoteDecimals = quoteMint === SOL ? 9 : mintDecimals(qd[q] ?? Buffer.alloc(0)) ?? 6; q++;
      e.pool = { address: p.address, baseVault: p.baseTokenAccount, quoteVault: p.quoteTokenAccount, quoteMint, quoteDecimals, baseDecimals: e.row.decimals ?? 6 };
      (e as Entry & { virtualQuote?: bigint }).virtualQuote = BigInt(p.virtualQuoteReserves.toString());
    });
  }

  private async round() {
    if (this.running || !this.entries.size) return;
    this.running = true;
    const t0 = Date.now();
    try {
      // A round stuck on one slow RPC response must not hold back every later round: drop it after 8s.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("round timed out after 8s")), 8_000); });
      await Promise.race([timeout, (this.o.wrap ?? (t => t()))(async () => {
        await this.resolvePools();
        const now = Date.now(), recheck = this.o.recheckMs ?? 300_000, gone = (e: Entry) => !!e.error && /complete|missing|empty/.test(e.error);
        const list = [...this.entries.values()].filter(e => (e.kind === "curve" || e.pool) && (!this.o.needs || now - (e.checkedAt ?? 0) >= recheck || (!gone(e) && this.o.needs(e.mint))));
        for (const e of list) e.checkedAt = now;
        const keys: PublicKey[] = [];
        for (const e of list) {
          if (e.kind === "curve") keys.push(bondingCurvePda(new PublicKey(e.mint)));
          else keys.push(e.pool!.address, e.pool!.baseVault, e.pool!.quoteVault);
        }
        const data = await this.many(keys);
        const at = Date.now(); let k = 0;
        for (const e of list) {
          try {
            if (e.kind === "curve") {
              const d = data[k++];
              if (!d) throw new Error("curve account missing");
              const curve = decodeCurve(bondingCurvePda(new PublicKey(e.mint)), d, e.row as never);
              if (curve.complete) { e.price = undefined; e.error = "curve complete (migrated)"; continue; }
              const price = spotPriceQuotePerToken(curve, e.row.decimals ?? 6, curve.quoteAsset.decimals);
              e.price = { venue: "pump-curve" as MarketPrice["venue"], mint: new PublicKey(e.mint), quoteAsset: curve.quoteAsset, priceQuotePerToken: price,
                baseReserveRaw: curve.virtualBase, quoteReserveRaw: curve.virtualQuote, capturedAtMs: at } as MarketPrice;
            } else {
              const [pd, bd, qd] = [data[k++], data[k++], data[k++]];
              if (!pd || !bd || !qd) throw new Error("pool or vault account missing");
              const p = e.pool!, virtualQuote = BigInt(decodePool(p.address, pd).virtualQuoteReserves.toString());
              const base = splAmount(bd), quote = splAmount(qd);
              if (base == null || quote == null || base <= 0n) throw new Error("empty pool");
              const price = spotPriceQuotePerToken({ virtualBase: base, virtualQuote: quote + virtualQuote } as never, p.baseDecimals, p.quoteDecimals);
              const quoteAsset = p.quoteMint === SOL
                ? { kind: "native-sol", mint: new PublicKey(SOL), tokenProgram: TOKEN_PROGRAM, decimals: 9 }
                : { kind: "spl-token", mint: new PublicKey(p.quoteMint), tokenProgram: TOKEN_PROGRAM, decimals: p.quoteDecimals };
              e.price = { venue: "pumpswap" as MarketPrice["venue"], mint: new PublicKey(e.mint), quoteAsset: quoteAsset as MarketPrice["quoteAsset"],
                priceQuotePerToken: price, baseReserveRaw: base, quoteReserveRaw: quote + virtualQuote, capturedAtMs: at } as MarketPrice;
            }
            e.error = undefined;
          } catch (error) { e.error = String(error instanceof Error ? error.message : error).slice(0, 100); }
        }
      })]).finally(() => clearTimeout(timer));
    } catch (error) {
      this.o.log(`chain prices: round failed: ${String(error instanceof Error ? error.message : error).slice(0, 120)}`);
    } finally { this.lastRoundMs = Date.now() - t0; this.lastRoundAt = Date.now(); this.running = false; }
  }
}
