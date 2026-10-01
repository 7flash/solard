import { PublicKey, type Connection } from "@solana/web3.js";
import { readMint } from "../../chain/state.ts";
import type { TokenRow } from "../../db/schema.ts";
import { fetchPool } from "./state.ts";
import { tokenAccountAmount } from "./common.ts";
import { readDbcMarket } from "../meteora/dbc.ts";
import { readDammV2Market } from "../meteora/damm-v2.ts";

export function mergeTokenMetadataJson(...values: Array<string | null | undefined>): string {
  const merged: Record<string, unknown> = {};
  for (const value of values) {
    if (!value) continue;
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Token metadata must be a JSON object");
    Object.assign(merged, parsed);
  }
  return JSON.stringify(merged);
}

/** Pool identity and mint ownership take precedence over cached caller hints. */
export async function verifyPoolTokenMetadata(connection: Connection, token: Partial<TokenRow>) {
  let quoteMint = token.quoteMint ? new PublicKey(token.quoteMint) : null;
  if (token.venueHint === "meteora-damm-v2" && token.pool) {
    const market = await readDammV2Market(connection, new PublicKey(token.pool));
    if (![market.state.tokenAMint.toBase58(), market.state.tokenBMint.toBase58()].includes(token.mint ?? ""))
      throw new Error("Configured Meteora DAMM v2 pool mint mismatch");
    quoteMint = market.state.tokenAMint.toBase58() === token.mint ? market.state.tokenBMint : market.state.tokenAMint;
  }
  if (token.venueHint === "meteora-dbc" && token.pool) {
    const market = await readDbcMarket(connection, new PublicKey(token.pool));
    if (market.virtualPool.poolState.baseMint.toBase58() !== token.mint)
      throw new Error("Configured Meteora DBC pool base mint does not match token");
    quoteMint = market.config.quoteMint;
  }
  if (token.venueHint === "pumpswap" && token.pool) {
    const pool = await fetchPool(connection, new PublicKey(token.pool));
    if (pool.baseMint.toBase58() !== token.mint)
      throw new Error("Configured PumpSwap pool base mint does not match token");
    const [base, quote] = await Promise.all([
      readMint(connection, pool.baseMint), readMint(connection, pool.quoteMint),
    ]);
    await Promise.all([
      tokenAccountAmount(connection, pool.baseTokenAccount, base.tokenProgram, pool.baseMint),
      tokenAccountAmount(connection, pool.quoteTokenAccount, quote.tokenProgram, pool.quoteMint),
    ]);
    quoteMint = pool.quoteMint;
  }
  if (!quoteMint) return {};
  const quote = await readMint(connection, quoteMint);
  return {
    quoteMint: quoteMint.toBase58(),
    quoteTokenProgram: quote.tokenProgram.toBase58(),
    metadataJson: mergeTokenMetadataJson(token.metadataJson, JSON.stringify({ quoteDecimals: quote.decimals })),
  };
}
