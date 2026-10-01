import BN from "bn.js";
import { PublicKey, type Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import { dbcClient, DYNAMIC_BONDING_CURVE_PROGRAM_ID } from "./dbc.ts";

export type DbcTradeEvent = {
  pool: PublicKey; config: PublicKey; sell: boolean;
  inputRaw: bigint; outputRaw: bigint; nextSqrtPrice: BN; atMs: number;
};

export function eventPublicKey(value: unknown): PublicKey | null {
  // SDKs may resolve another installed web3.js instance; instanceof would
  // reject valid decoded keys from that instance.
  if (!value || typeof value !== "object" || !("toBase58" in value) || typeof value.toBase58 !== "function") return null;
  try { return new PublicKey(value.toBase58()); } catch { return null; }
}

export function decodeDbcTrade(connection: Connection, data: Buffer): DbcTradeEvent | null {
  const decoded = dbcClient(connection).state.getProgram().coder.events.decode(data.toString("base64"));
  if (!decoded || !["evtSwap", "evtSwap2"].includes(decoded.name)) return null;
  const event = decoded.data as {
    pool?: unknown; config?: unknown; tradeDirection?: unknown; currentTimestamp?: unknown; amountIn?: unknown;
    swapResult?: { actualInputAmount?: unknown; includedFeeInputAmount?: unknown; outputAmount?: unknown; nextSqrtPrice?: unknown };
  };
  const result = event.swapResult;
  const input = event.amountIn ?? result?.includedFeeInputAmount;
  const pool = eventPublicKey(event.pool), config = eventPublicKey(event.config);
  if (!pool || !config ||
      ![0, 1].includes(Number(event.tradeDirection)) || !BN.isBN(input) ||
      !BN.isBN(result?.outputAmount) || !BN.isBN(result?.nextSqrtPrice) || !BN.isBN(event.currentTimestamp)) return null;
  const atMs = Number(event.currentTimestamp.toString()) * 1000;
  if (!Number.isSafeInteger(atMs) || input.isNeg() || result.outputAmount.isNeg() || result.nextSqrtPrice.lten(0)) return null;
  return { pool, config, sell: event.tradeDirection === 0,
    inputRaw: BigInt(input.toString()), outputRaw: BigInt(result.outputAmount.toString()),
    nextSqrtPrice: result.nextSqrtPrice, atMs };
}

// Anchor event-CPI instruction discriminator; these events need not appear as
// Program data logs. Decode only self-CPI instructions from the DBC program.
const EVENT_CPI = Buffer.from("e445a52e51cb9a1d", "hex");
export function dbcTradesFromTransaction(connection: Connection, transaction: ParsedTransactionWithMeta): Array<DbcTradeEvent> {
  const events: Array<DbcTradeEvent> = [];
  for (const data of selfCpiEventData(transaction, DYNAMIC_BONDING_CURVE_PROGRAM_ID)) {
    const decoded = decodeDbcTrade(connection, data);
    if (decoded) events.push(decoded);
  }
  return events;
}

export function selfCpiEventData(transaction: ParsedTransactionWithMeta, program: PublicKey): Array<Buffer> {
  if (transaction.meta?.err) return [];
  const events: Array<Buffer> = [];
  for (const group of transaction.meta?.innerInstructions ?? []) {
    for (const instruction of group.instructions) {
      if (!("data" in instruction) || !instruction.programId.equals(program)) continue;
      const data = Buffer.from(bs58.decode(instruction.data));
      if (!data.subarray(0, EVENT_CPI.length).equals(EVENT_CPI)) continue;
      events.push(data.subarray(EVENT_CPI.length));
    }
  }
  return events;
}
