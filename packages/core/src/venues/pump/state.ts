import { Buffer } from "buffer";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { SOL_ASSET, type QuoteAsset } from "../../core/amounts.ts";
import { readMint } from "../../chain/state.ts";
import { pumpAmmJson } from "@pump-fun/pump-swap-sdk";
import type { TokenRow } from "../../db/schema.ts";
import { bondingCurvePda, globalPda, sharingConfigPda } from "./pda.ts";
import {
  WRAPPED_SOL_MINT,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
} from "./constants.ts";

export type PumpCurve = {
  address: PublicKey;
  virtualBase: bigint;
  virtualQuote: bigint;
  realBase: bigint;
  realQuote: bigint;
  totalSupply: bigint;
  complete: boolean;
  creator: PublicKey | null;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  quoteAsset: QuoteAsset;
};
export type PumpPool = {
  address: PublicKey;
  creator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseTokenAccount: PublicKey;
  quoteTokenAccount: PublicKey;
  coinCreator: PublicKey;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  /** PumpSwap 2026 pool extension; signed i128 at byte offset 245. */
  virtualQuoteReserves: bigint;
};
function readU64(data: Buffer, offset: number): bigint {
  return data.length >= offset + 8 ? data.readBigUInt64LE(offset) : 0n;
}
function readI128(data: Buffer, offset: number): bigint {
  if (data.length < offset + 16) return 0n;
  const low = data.readBigUInt64LE(offset);
  const high = data.readBigInt64LE(offset + 8);
  return (high << 64n) + low;
}
function readKey(data: Buffer, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}
export function decodeCurve(
  address: PublicKey,
  data: Buffer,
  token: TokenRow,
): PumpCurve {
  if (data.length < 49)
    throw new Error(`Bonding curve account ${address.toBase58()} is too short`);
  const metadata = token.metadataJson
    ? (JSON.parse(token.metadataJson) as { quoteDecimals?: number })
    : {};
  const onChainQuoteMint = data.length >= 115 ? readKey(data, 83) : null;
  const quoteMint =
    onChainQuoteMint == null || onChainQuoteMint.equals(PublicKey.default)
      ? WRAPPED_SOL_MINT
      : onChainQuoteMint;
  const quoteProgram = token.quoteTokenProgram
    ? new PublicKey(token.quoteTokenProgram)
    : TOKEN_PROGRAM_ID;
  const quoteAsset: QuoteAsset = quoteMint.equals(WRAPPED_SOL_MINT)
    ? SOL_ASSET
    : {
        kind: "spl-token",
        mint: quoteMint,
        tokenProgram: quoteProgram,
        decimals: metadata.quoteDecimals ?? 6,
      };
  return {
    address,
    virtualBase: readU64(data, 8),
    virtualQuote: readU64(data, 16),
    realBase: readU64(data, 24),
    realQuote: readU64(data, 32),
    totalSupply: readU64(data, 40),
    complete: data[48] === 1,
    creator:
      data.length >= 81
        ? readKey(data, 49)
        : token.creator
          ? new PublicKey(token.creator)
          : null,
    isMayhemMode: data.length > 81 && data[81] === 1,
    isCashbackCoin: data.length > 82 && data[82] === 1,
    quoteAsset,
  };
}
export function decodePool(address: PublicKey, data: Buffer): PumpPool {
  if (data.length < 245)
    throw new Error(`PumpSwap pool account ${address.toBase58()} is too short`);
  return {
    address,
    creator: readKey(data, 11),
    baseMint: readKey(data, 43),
    quoteMint: readKey(data, 75),
    baseTokenAccount: readKey(data, 139),
    quoteTokenAccount: readKey(data, 171),
    coinCreator: readKey(data, 211),
    isMayhemMode: data[243] === 1,
    isCashbackCoin: data[244] === 1,
    // Appended in the 2026 PumpSwap pool layout. Older accounts decode as 0.
    virtualQuoteReserves: readI128(data, 245),
  };
}
export async function fetchCurve(
  connection: Connection,
  token: TokenRow,
): Promise<PumpCurve | null> {
  const address = bondingCurvePda(new PublicKey(token.mint));
  const account = await connection.getAccountInfo(address, "confirmed");
  if (!account) return null;
  // A migrated/closed curve PDA can remain a zero-data System account. It is
  // absent as a curve and must allow AMM discovery, rather than blocking it.
  if (
    account.owner.equals(SystemProgram.programId) &&
    account.data.length === 0
  )
    return null;
  if (!account.owner.equals(PUMP_PROGRAM_ID))
    throw new Error(
      `Bonding curve ${address.toBase58()} has unexpected program owner`,
    );

  const curve = decodeCurve(address, Buffer.from(account.data), token);
  // Token rows can outlive a migration or be created from partial launch data.
  // Never trust persisted quote program/decimals when the curve itself names a
  // non-SOL quote mint: mint ownership and decimals are chain facts.
  if (curve.quoteAsset.kind === "spl-token") {
    const mintState = await readMint(connection, curve.quoteAsset.mint);
    curve.quoteAsset = {
      kind: "spl-token",
      mint: curve.quoteAsset.mint,
      tokenProgram: mintState.tokenProgram,
      decimals: mintState.decimals,
    };
  }
  return curve;
}
export async function fetchPool(
  connection: Connection,
  address: PublicKey,
): Promise<PumpPool> {
  const account = await connection.getAccountInfo(address, "confirmed");
  if (!account)
    throw new Error(`PumpSwap pool not found: ${address.toBase58()}`);
  if (!account.owner.equals(PUMP_AMM_PROGRAM_ID))
    throw new Error(
      `PumpSwap pool ${address.toBase58()} has unexpected program owner`,
    );
  const poolAccount = pumpAmmJson.accounts.find(
    (entry) => entry.name.toLowerCase() === "pool",
  );
  if (
    !poolAccount ||
    !Buffer.from(account.data)
      .subarray(0, 8)
      .equals(Buffer.from(poolAccount.discriminator))
  )
    throw new Error(
      `PumpSwap pool ${address.toBase58()} has invalid account discriminator`,
    );
  return decodePool(address, Buffer.from(account.data));
}
export async function hasSharingConfig(
  connection: Connection,
  mint: PublicKey,
): Promise<boolean> {
  return (
    (await connection.getAccountInfo(sharingConfigPda(mint), "confirmed")) !=
    null
  );
}
export function defaultTokenProgram(token: TokenRow): PublicKey {
  return new PublicKey(token.baseTokenProgram ?? TOKEN_PROGRAM_ID);
}

/** Initial reserve state for a newly created SOL-paired Pump bonding curve.
 * These two legacy Global fields remain the source for native-SOL launches. */
export async function fetchInitialSolCurveState(
  connection: Connection,
): Promise<{ virtualBase: bigint; virtualQuote: bigint }> {
  const account = await connection.getAccountInfo(globalPda(), "confirmed");
  if (!account || account.data.length < 89)
    throw new Error("Unable to decode Pump global initial SOL curve reserves");
  const data = Buffer.from(account.data);
  return { virtualBase: readU64(data, 73), virtualQuote: readU64(data, 81) };
}
