import { PublicKey } from "@solana/web3.js";
import { measure } from "../core/log.js";
import { UnknownTokenError } from "../core/errors.js";
import { tokenLog } from "../core/log-result.js";
import { measuredSync } from "../core/measured.js";
import type { TokenRef } from "../core/refs.js";
import type { SowlDatabase, TokenRow } from "./schema.js";

const m = measure("tokens");
function normalizeName(value: string): string { return value.startsWith("$") ? value.slice(1) : value; }
function isMint(value: string): boolean { try { new PublicKey(value); return true; } catch { return false; } }

export class TokenRepo {
  constructor(private readonly db: SowlDatabase) {}
  upsert(input: Partial<Omit<TokenRow, "id">> & { mint: string }): TokenRow {
    return measuredSync(m, `upsert ${input.mint.slice(0, 8)}`, () => {
      const existing = this.db.tokens.select().where({ mint: input.mint }).first() as TokenRow | undefined;
      const now = Date.now();
      if (existing) {
        Object.assign(existing, input, { updatedAtMs: now });
        return existing;
      }
      return this.db.tokens.insert({
        mint: input.mint, name: input.name ?? null, symbol: input.symbol ?? null, decimals: input.decimals ?? null,
        createKind: input.createKind ?? "unknown", creator: input.creator ?? null, quoteMint: input.quoteMint ?? null,
        quoteTokenProgram: input.quoteTokenProgram ?? null, baseTokenProgram: input.baseTokenProgram ?? null,
        bondingCurve: input.bondingCurve ?? null, pool: input.pool ?? null, sharingConfig: input.sharingConfig ?? null,
        venueHint: input.venueHint ?? "unknown", metadataJson: input.metadataJson ?? null,
        refreshedAtMs: input.refreshedAtMs ?? null, createdAtMs: now, updatedAtMs: now,
      }) as TokenRow;
    }, tokenLog);
  }
  list(): TokenRow[] { return this.db.tokens.select().orderBy("id", "desc").all() as TokenRow[]; }
  resolve(ref: TokenRef): TokenRow {
    if (typeof ref !== "string" && !(ref instanceof PublicKey)) return ref;
    const value = ref instanceof PublicKey ? ref.toBase58() : normalizeName(ref);
    const rows = this.list();
    const token = isMint(value)
      ? rows.find((row) => row.mint === value)
      : rows.find((row) => row.name === value || row.symbol?.toUpperCase() === value.toUpperCase());
    if (!token) throw new UnknownTokenError(String(ref));
    return token;
  }
}
