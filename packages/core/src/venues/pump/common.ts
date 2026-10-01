import { getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { type AccountMeta, Connection, PublicKey } from "@solana/web3.js";
import { SOL_ASSET, type QuoteAsset } from "../../core/amounts.ts";
import { readMint } from "../../chain/state.ts";
import type { TokenRow } from "../../db/schema.ts";
import { WRAPPED_SOL_MINT } from "./constants.ts";
import type { PumpCurve } from "./state.ts";
import { tokenMeta } from "./routing.ts";

export type CurveMarketMeta = { curve: PumpCurve };
export type PumpSwapMarketMeta = {
  baseDecimals: number;
  pool: PublicKey;
  poolBaseAta: PublicKey;
  poolQuoteAta: PublicKey;
  protocolFeeRecipient: PublicKey;
  coinCreator: PublicKey;
  /** Raw quote-token vault amount from the pool ATA. */
  rawQuoteReserve: bigint;
  /** Signed PumpSwap pool extension. */
  virtualQuoteReserves: bigint;
  /** Effective reserves used for pricing: rawQuoteReserve + virtualQuoteReserves. */
  reserves: { virtualBase: bigint; virtualQuote: bigint };
  extraBuyAccounts?: AccountMeta[];
  extraSellAccounts?: AccountMeta[];
};

export async function poolQuoteAsset(
  connection: Connection,
  token: TokenRow,
  quoteMint: PublicKey,
): Promise<QuoteAsset> {
  if (quoteMint.equals(WRAPPED_SOL_MINT)) return SOL_ASSET;
  // quoteMint comes from the pool/curve account. Its mint owner and decimals
  // must come from that mint account as well; persisted token metadata may be
  // stale (notably for Token-2022 PUMP-quoted pools).
  const mintState = await readMint(connection, quoteMint);
  return {
    kind: "spl-token",
    mint: quoteMint,
    tokenProgram: mintState.tokenProgram,
    decimals: mintState.decimals,
  };
}

export function configuredTotalFeeBps(token: TokenRow): number {
  const value = tokenMeta(token).totalFeeBps;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value >= 10_000
  )
    return 200;
  return value;
}

export function extraAccounts(value: unknown): AccountMeta[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    const row = item as {
      address: string;
      writable?: boolean;
      signer?: boolean;
    };
    return {
      pubkey: new PublicKey(row.address),
      isWritable: row.writable === true,
      isSigner: row.signer === true,
    };
  });
}

export async function tokenAccountAmount(
  connection: Connection,
  address: PublicKey,
  tokenProgram: PublicKey,
  expectedMint?: PublicKey,
): Promise<bigint> {
  const account = await getAccount(
    connection,
    address,
    "confirmed",
    tokenProgram,
  );
  if (expectedMint && !account.mint.equals(expectedMint)) {
    throw new Error(
      `Token vault ${address.toBase58()} mint ${account.mint.toBase58()} does not match expected ${expectedMint.toBase58()}`,
    );
  }
  return account.amount;
}

export async function spendableVaultLamports(
  connection: Connection,
  address: PublicKey,
): Promise<bigint> {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) return 0n;
  const rent = BigInt(
    await connection.getMinimumBalanceForRentExemption(info.data.length),
  );
  const lamports = BigInt(info.lamports);
  return lamports > rent ? lamports - rent : 0n;
}

export function defaultPumpQuoteShell(
  mint: PublicKey,
  now = Date.now(),
): TokenRow {
  return {
    mint: mint.toBase58(),
    name: null,
    symbol: null,
    decimals: null,
    createKind: "unknown",
    creator: null,
    quoteMint: WRAPPED_SOL_MINT.toBase58(),
    quoteTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    baseTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    bondingCurve: null,
    pool: null,
    sharingConfig: null,
    venueHint: "unknown",
    metadataJson: null,
    refreshedAtMs: now,
    createdAtMs: now,
    updatedAtMs: now,
    id: 0,
  };
}
