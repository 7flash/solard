import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { SOL_ASSET, type QuoteAsset } from "../../core/amounts.js";
import type { TokenRow } from "../../db/schema.js";
import { bondingCurvePda, globalPda, sharingConfigPda } from "./pda.js";
import { WRAPPED_SOL_MINT } from "./constants.js";

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
};
function readU64(data: Buffer, offset: number): bigint {
  return data.length >= offset + 8 ? data.readBigUInt64LE(offset) : 0n;
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
  };
}
export async function fetchCurve(
  connection: Connection,
  token: TokenRow,
): Promise<PumpCurve | null> {
  const address = bondingCurvePda(new PublicKey(token.mint));
  const account = await connection.getAccountInfo(address, "confirmed");
  return account
    ? decodeCurve(address, Buffer.from(account.data), token)
    : null;
}
export async function fetchPool(
  connection: Connection,
  address: PublicKey,
): Promise<PumpPool> {
  const account = await connection.getAccountInfo(address, "confirmed");
  if (!account)
    throw new Error(`PumpSwap pool not found: ${address.toBase58()}`);
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
