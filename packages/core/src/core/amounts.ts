import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export type QuoteAsset =
  | {
      kind: "native-sol";
      mint: PublicKey;
      tokenProgram: PublicKey;
      decimals: 9;
    }
  | {
      kind: "spl-token";
      mint: PublicKey;
      tokenProgram: PublicKey;
      decimals: number;
    };
export type RawAmount = { raw: bigint; asset: QuoteAsset };
export type HumanAmount = { sol: string | number } | RawAmount;
export const SOL_ASSET: QuoteAsset = {
  kind: "native-sol",
  mint: NATIVE_MINT,
  tokenProgram: TOKEN_PROGRAM_ID,
  decimals: 9,
};
function parseDecimal(value: string | number, decimals: number): bigint {
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text))
    throw new Error(`Invalid decimal amount: ${text}`);
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals)
    throw new Error(`Amount ${text} has more than ${decimals} decimal places`);
  return (
    BigInt(whole!) * 10n ** BigInt(decimals) +
    BigInt((fraction + "0".repeat(decimals)).slice(0, decimals))
  );
}
export function sol(value: string | number): RawAmount {
  return { raw: parseDecimal(value, 9), asset: SOL_ASSET };
}
export function tokenAmount(
  value: string | number,
  mint: PublicKey,
  decimals: number,
  tokenProgram = TOKEN_PROGRAM_ID,
): RawAmount {
  return {
    raw: parseDecimal(value, decimals),
    asset: { kind: "spl-token", mint, decimals, tokenProgram },
  };
}
export function rawAmount(
  raw: bigint,
  asset: QuoteAsset = SOL_ASSET,
): RawAmount {
  if (raw < 0n) throw new Error("Raw amount cannot be negative");
  return { raw, asset };
}
export function toRawAmount(amount: HumanAmount): RawAmount {
  return "sol" in amount ? sol(amount.sol) : amount;
}
export function formatRaw(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals),
    whole = raw / base;
  const fraction = (raw % base)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}
export function sameAsset(a: QuoteAsset, b: QuoteAsset): boolean {
  return a.mint.equals(b.mint) && a.tokenProgram.equals(b.tokenProgram);
}
