import {
  getAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackMint,
  unpackAccount,
} from "@solana/spl-token";
import { type AccountMeta, Connection, PublicKey } from "@solana/web3.js";
import { SOL_ASSET, type QuoteAsset } from "../../core/amounts.ts";
import type { TokenRow } from "../../db/schema.ts";
import { WRAPPED_SOL_MINT } from "./constants.ts";
import type { PumpCurve } from "./state.ts";
import { tokenMeta } from "./routing.ts";
import type { LivePoolReserves } from "../venue-plugin.ts";

export type CurveMarketMeta = { curve: PumpCurve };
type MintMetadata = {
  tokenProgram: PublicKey;
  decimals: number;
  expiresAtMs: number;
};
const mintMetadata = new WeakMap<Connection, Map<string, MintMetadata>>();
function mintCache(connection: Connection): Map<string, MintMetadata> {
  let cache = mintMetadata.get(connection);
  if (!cache) {
    cache = new Map();
    mintMetadata.set(connection, cache);
  }
  return cache;
}

/** Cache initialized mint identity briefly; supply is never cached here. */
export async function poolMintMetadata(
  connection: Connection,
  mint: PublicKey,
): Promise<MintMetadata> {
  const cache = mintCache(connection);
  const cached = cache.get(mint.toBase58());
  if (cached && cached.expiresAtMs > Date.now()) return cached;
  const info = await connection.getAccountInfo(mint, "confirmed");
  return verifiedMintMetadata(connection, mint, info);
}
function verifiedMintMetadata(
  connection: Connection,
  mint: PublicKey,
  info: Parameters<typeof unpackMint>[1],
): MintMetadata {
  if (!info) throw new Error(`Mint account not found: ${mint.toBase58()}`);
  if (
    !info.owner.equals(TOKEN_PROGRAM_ID) &&
    !info.owner.equals(TOKEN_2022_PROGRAM_ID)
  )
    throw new Error(`Unsupported token program for mint ${mint.toBase58()}`);
  const decoded = unpackMint(mint, info, info.owner);
  if (!decoded.isInitialized)
    throw new Error(`Uninitialized mint ${mint.toBase58()}`);
  const value = {
    tokenProgram: info.owner,
    decimals: decoded.decimals,
    expiresAtMs: Date.now() + 60_000,
  };
  mintCache(connection).set(mint.toBase58(), value);
  return value;
}

/** Batch fresh vault balances together with any unverified mint metadata. */
export async function poolAssetsAndReserves(
  connection: Connection,
  args: {
    baseMint: PublicKey;
    quoteMint: PublicKey;
    baseTokenAccount: PublicKey;
    quoteTokenAccount: PublicKey;
  },
  snapshot?: LivePoolReserves,
): Promise<{
  baseMintState: MintMetadata;
  quoteAsset: QuoteAsset;
  baseReserve: bigint;
  rawQuoteReserve: bigint;
}> {
  const cache = mintCache(connection);
  const addresses = new Map<string, PublicKey>();
  for (const mint of [args.baseMint, args.quoteMint]) {
    if ((cache.get(mint.toBase58())?.expiresAtMs ?? 0) <= Date.now()) {
      cache.delete(mint.toBase58());
      addresses.set(mint.toBase58(), mint);
    }
  }
  if (!snapshot)
    for (const vault of [args.baseTokenAccount, args.quoteTokenAccount])
      addresses.set(vault.toBase58(), vault);
  const keys = [...addresses.values()];
  const infos = keys.length
    ? await connection.getMultipleAccountsInfo(
        keys,
        snapshot
          ? { commitment: "confirmed", minContextSlot: snapshot.slot }
          : "confirmed",
      )
    : [];
  const accounts = new Map(
    keys.map((key, index) => [key.toBase58(), infos[index] ?? null]),
  );
  const baseMintState =
    cache.get(args.baseMint.toBase58()) ??
    verifiedMintMetadata(
      connection,
      args.baseMint,
      accounts.get(args.baseMint.toBase58()) ?? null,
    );
  const quoteMintState =
    cache.get(args.quoteMint.toBase58()) ??
    verifiedMintMetadata(
      connection,
      args.quoteMint,
      accounts.get(args.quoteMint.toBase58()) ?? null,
    );
  function amount(
    address: PublicKey,
    mint: PublicKey,
    program: PublicKey,
  ): bigint {
    const account = unpackAccount(
      address,
      accounts.get(address.toBase58()) ?? null,
      program,
    );
    if (!account.mint.equals(mint))
      throw new Error(
        `Token vault ${address.toBase58()} mint ${account.mint.toBase58()} does not match expected ${mint.toBase58()}`,
      );
    return account.amount;
  }
  return {
    baseMintState,
    quoteAsset: args.quoteMint.equals(WRAPPED_SOL_MINT)
      ? SOL_ASSET
      : {
          kind: "spl-token",
          mint: args.quoteMint,
          tokenProgram: quoteMintState.tokenProgram,
          decimals: quoteMintState.decimals,
        },
    baseReserve:
      snapshot?.baseReserveRaw ??
      amount(args.baseTokenAccount, args.baseMint, baseMintState.tokenProgram),
    rawQuoteReserve:
      snapshot?.quoteReserveRaw ??
      amount(
        args.quoteTokenAccount,
        args.quoteMint,
        quoteMintState.tokenProgram,
      ),
  };
}
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
  const mintState = await poolMintMetadata(connection, quoteMint);
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
