import BN from "bn.js";
import { PublicKey, type Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { dammV2Client, CP_AMM_PROGRAM_ID } from "./damm-v2.ts";
import { selfCpiEventData, eventPublicKey } from "./dbc-events.ts";
export type DammV2TradeEvent = {
  pool: PublicKey; aToB: boolean; inputRaw: bigint; outputRaw: bigint;
  nextSqrtPrice: BN; reserveA: bigint; reserveB: bigint; atMs: number;
};
export function decodeDammV2Trade(connection: Connection, data: Buffer): DammV2TradeEvent | null {
  const decoded = dammV2Client(connection)._program.coder.events.decode(data.toString("base64"));
  if (!decoded || decoded.name !== "evtSwap2") return null;
  const event = decoded.data as {
    pool?: unknown; tradeDirection?: unknown; currentTimestamp?: unknown;
    includedTransferFeeAmountIn?: unknown; excludedTransferFeeAmountOut?: unknown;
    reserveAAmount?: unknown; reserveBAmount?: unknown;
    swapResult?: { nextSqrtPrice?: unknown };
  };
  const pool = eventPublicKey(event.pool);
  if (!pool || (event.tradeDirection !== 0 && event.tradeDirection !== 1) ||
      !BN.isBN(event.currentTimestamp) || !BN.isBN(event.includedTransferFeeAmountIn) || !BN.isBN(event.excludedTransferFeeAmountOut) ||
      !BN.isBN(event.reserveAAmount) || !BN.isBN(event.reserveBAmount) || !BN.isBN(event.swapResult?.nextSqrtPrice)) return null;
  const atMs = Number(event.currentTimestamp.toString()) * 1000;
  if (!Number.isSafeInteger(atMs) || event.swapResult.nextSqrtPrice.lten(0)) return null;
  return { pool, aToB: event.tradeDirection === 0, atMs,
    inputRaw: BigInt(event.includedTransferFeeAmountIn.toString()), outputRaw: BigInt(event.excludedTransferFeeAmountOut.toString()),
    nextSqrtPrice: event.swapResult.nextSqrtPrice,
    reserveA: BigInt(event.reserveAAmount.toString()), reserveB: BigInt(event.reserveBAmount.toString()) };
}
export function dammV2TradesFromTransaction(connection: Connection, transaction: ParsedTransactionWithMeta): Array<DammV2TradeEvent> {
  return selfCpiEventData(transaction, CP_AMM_PROGRAM_ID)
    .map((data) => decodeDammV2Trade(connection, data)).filter((event): event is DammV2TradeEvent => event !== null);
}
