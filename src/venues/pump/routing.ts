import { Connection, PublicKey } from "@solana/web3.js";
import type { QuoteAsset } from "../../core/amounts.js";
import type { TokenRow } from "../../db/schema.js";
import { ata, ammGlobalConfigPda, creatorVaultPda, globalPda } from "./pda.js";

export type PumpRouting = {
  feeRecipient: PublicKey; associatedQuoteFeeRecipient: PublicKey;
  buybackFeeRecipient: PublicKey; associatedQuoteBuybackFeeRecipient: PublicKey;
  creatorVault: PublicKey; associatedCreatorVault: PublicKey;
};
function stringField(meta: Record<string, unknown>, key: string): string | undefined {
  const value = meta[key]; return typeof value === "string" && value ? value : undefined;
}
export function tokenMeta(token: TokenRow): Record<string, unknown> {
  if (!token.metadataJson) return {};
  try { return JSON.parse(token.metadataJson) as Record<string, unknown>; } catch { return {}; }
}
function key(data: Buffer, offset: number): PublicKey { return new PublicKey(data.subarray(offset, offset + 32)); }
function choose(list: PublicKey[], mint: PublicKey): PublicKey { return list[mint.toBytes()[0]! % list.length]!; }
export async function resolvePumpRouting(connection: Connection, token: TokenRow, creator: PublicKey, quote: QuoteAsset, isMayhemMode: boolean): Promise<PumpRouting> {
  const meta = tokenMeta(token);
  const nested = typeof meta.pumpRouting === "object" && meta.pumpRouting ? meta.pumpRouting as Record<string, unknown> : {};
  let feeRecipient: PublicKey | undefined;
  let buybackFeeRecipient: PublicKey | undefined;
  const feeOverride = stringField(nested, "feeRecipient") ?? process.env.PUMP_FEE_RECIPIENT;
  const buybackOverride = stringField(nested, "buybackFeeRecipient") ?? process.env.PUMP_BUYBACK_FEE_RECIPIENT;
  if (feeOverride) feeRecipient = new PublicKey(feeOverride);
  if (buybackOverride) buybackFeeRecipient = new PublicKey(buybackOverride);
  if (!feeRecipient || !buybackFeeRecipient) {
    const account = await connection.getAccountInfo(globalPda(), "confirmed");
    if (!account || account.data.length < 997) throw new Error("Unable to decode live Pump global fee routing");
    const data = Buffer.from(account.data);
    const regularFees = [key(data, 41), ...Array.from({ length: 7 }, (_, i) => key(data, 162 + i * 32))];
    const reservedFees = [key(data, 483), ...Array.from({ length: 7 }, (_, i) => key(data, 516 + i * 32))];
    const buybacks = Array.from({ length: 8 }, (_, i) => key(data, 741 + i * 32));
    feeRecipient ??= choose(isMayhemMode ? reservedFees : regularFees, new PublicKey(token.mint));
    buybackFeeRecipient ??= choose(buybacks, new PublicKey(token.mint));
  }
  const vault = creatorVaultPda(creator);
  return {
    feeRecipient, buybackFeeRecipient,
    associatedQuoteFeeRecipient: ata(quote.mint, feeRecipient, quote.tokenProgram, true),
    associatedQuoteBuybackFeeRecipient: ata(quote.mint, buybackFeeRecipient, quote.tokenProgram, true),
    creatorVault: vault, associatedCreatorVault: ata(quote.mint, vault, quote.tokenProgram, true),
  };
}
export async function resolvePumpSwapProtocolFeeRecipient(connection: Connection, mint: PublicKey, isMayhemMode: boolean, override?: string): Promise<PublicKey> {
  if (override) return new PublicKey(override);
  const account = await connection.getAccountInfo(ammGlobalConfigPda(), "confirmed");
  if (!account || account.data.length < 642) throw new Error("Unable to decode live PumpSwap global fee routing");
  const data = Buffer.from(account.data);
  const regular = Array.from({ length: 8 }, (_, i) => key(data, 57 + i * 32));
  const reserved = [key(data, 385), ...Array.from({ length: 7 }, (_, i) => key(data, 418 + i * 32))];
  return choose(isMayhemMode ? reserved : regular, mint);
}
