import type { SowlDatabase, PositionRow } from "../db/schema.js";
import { measure } from "../core/log.js";
import { positionLog } from "../core/log-result.js";
import { measuredSync } from "../core/measured.js";
import { optionalDecimals } from "../core/decimals.js";
const m = measure("positions");
export class PositionStore {
  constructor(private readonly db: SowlDatabase) {}
  recordBalance(args: { walletAddress: string; mint: string; amountRaw: bigint; decimals?: unknown }): void {
    this.db.balances.insert({
      walletAddress: args.walletAddress,
      mint: args.mint,
      amountRaw: args.amountRaw.toString(),
      decimals: optionalDecimals(args.decimals),
      capturedAtMs: Date.now(),
    });
  }
  upsert(args: { walletAddress: string; mint: string; tokenAmountRaw: bigint; quoteMint?: string; avgEntryQuoteRaw?: bigint; realizedPnlQuoteRaw?: bigint }): PositionRow {
    return measuredSync(m, `upsert ${args.mint.slice(0,8)}`, () => {
      const existing = this.db.positions.select().where({ walletAddress: args.walletAddress, mint: args.mint }).first() as PositionRow | undefined;
      if (existing) {
        existing.tokenAmountRaw = args.tokenAmountRaw.toString();
        existing.quoteMint = args.quoteMint ?? existing.quoteMint;
        existing.avgEntryQuoteRaw = args.avgEntryQuoteRaw?.toString() ?? existing.avgEntryQuoteRaw;
        existing.realizedPnlQuoteRaw = args.realizedPnlQuoteRaw?.toString() ?? existing.realizedPnlQuoteRaw;
        existing.updatedAtMs = Date.now();
        return existing;
      }
      return this.db.positions.insert({
        walletAddress: args.walletAddress, mint: args.mint, tokenAmountRaw: args.tokenAmountRaw.toString(),
        avgEntryQuoteRaw: args.avgEntryQuoteRaw?.toString() ?? null, avgExitQuoteRaw: null,
        realizedPnlQuoteRaw: args.realizedPnlQuoteRaw?.toString() ?? null, quoteMint: args.quoteMint ?? null, updatedAtMs: Date.now(),
      }) as PositionRow;
    }, positionLog);
  }
  list(walletAddress?: string): PositionRow[] {
    return walletAddress
      ? this.db.positions.select().where({ walletAddress }).orderBy("updatedAtMs", "desc").all() as PositionRow[]
      : this.db.positions.select().orderBy("updatedAtMs", "desc").all() as PositionRow[];
  }
}
