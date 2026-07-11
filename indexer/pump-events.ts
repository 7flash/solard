import { createHash } from "node:crypto";
import { base58 } from "./base58.js";
import type {
  IndexedComplete,
  IndexedCreate,
  IndexedEvent,
  IndexedTrade,
  LogJob,
} from "./types.js";
const EVENT_NAMES = ["CreateEvent", "TradeEvent", "CompleteEvent"] as const;
function discriminator(name: string): Buffer {
  return createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
}
const DISCRIMINATORS = new Map<string, (typeof EVENT_NAMES)[number]>(
  EVENT_NAMES.map((name) => [discriminator(name).toString("hex"), name]),
);
class Reader {
  offset = 0;
  constructor(private readonly bytes: Buffer) {}
  take(length: number): Buffer {
    if (this.offset + length > this.bytes.length)
      throw new Error(
        `buffer underflow at ${this.offset}, need ${length}, len=${this.bytes.length}`,
      );
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
  u32(): number {
    const v = this.bytes.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }
  u64(): bigint {
    const v = this.bytes.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  i64(): bigint {
    const v = this.bytes.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  bool(): boolean {
    return this.take(1)[0] === 1;
  }
  string(): string {
    const len = this.u32();
    return this.take(len).toString("utf8");
  }
  pubkey(): string {
    return base58(this.take(32));
  }
}
function uiAmount(value: bigint, decimals: number): number {
  return Number(value) / 10 ** decimals;
}
function solAmount(value: bigint): number {
  return Number(value) / 1_000_000_000;
}
function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}
function maybeTimestampMs(value: bigint, fallback: number): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 1_000_000_000
    ? seconds * 1000
    : fallback;
}
function parseCreate(reader: Reader, job: LogJob, raw: unknown): IndexedCreate {
  const name = reader.string();
  const symbol = reader.string();
  const uri = reader.string();
  const mint = reader.pubkey();
  const bondingCurveKey = reader.pubkey();
  const creator = reader.pubkey();
  return {
    kind: "create",
    mint,
    bondingCurveKey,
    creator,
    name,
    symbol,
    uri,
    signature: job.signature,
    slot: job.slot,
    createdAtMs: job.receivedAtMs,
    raw,
  };
}
function parseTrade(
  reader: Reader,
  job: LogJob,
  raw: unknown,
  args: { solUsd: number | null; tokenDecimals: number; pumpSupplyUi: number },
): IndexedTrade {
  const mint = reader.pubkey();
  const solRaw = reader.u64();
  const tokenRaw = reader.u64();
  const isBuy = reader.bool();
  const owner = reader.pubkey();
  const timestamp = reader.i64();
  const virtualSolRaw = reader.u64();
  const virtualTokenRaw = reader.u64();
  const realSolRaw = reader.u64();
  const realTokenRaw = reader.u64();
  const tokenDeltaUi = uiAmount(tokenRaw, args.tokenDecimals);
  const solDeltaUi = solAmount(solRaw);
  const virtualSolReservesUi = solAmount(virtualSolRaw);
  const virtualTokenReservesUi = uiAmount(virtualTokenRaw, args.tokenDecimals);
  const realSolReservesUi = solAmount(realSolRaw);
  const realTokenReservesUi = uiAmount(realTokenRaw, args.tokenDecimals);
  const priceFromTrade = tokenDeltaUi > 0 ? solDeltaUi / tokenDeltaUi : NaN;
  const priceFromCurve =
    virtualTokenReservesUi > 0
      ? virtualSolReservesUi / virtualTokenReservesUi
      : NaN;
  const priceSol = finite(priceFromTrade) ?? finite(priceFromCurve);
  const priceUsd =
    priceSol != null && args.solUsd != null ? priceSol * args.solUsd : null;
  const marketCapSol = priceSol != null ? priceSol * args.pumpSupplyUi : null;
  const marketCapUsd =
    marketCapSol != null && args.solUsd != null
      ? marketCapSol * args.solUsd
      : null;
  const createdAtMs = maybeTimestampMs(timestamp, job.receivedAtMs);
  return {
    kind: "trade",
    id: `helius:${job.signature}:${mint}:${isBuy ? "buy" : "sell"}:${createdAtMs}`,
    mint,
    signature: job.signature,
    slot: job.slot,
    owner,
    side: isBuy ? "buy" : "sell",
    tokenDeltaUi,
    solDeltaUi,
    priceSol,
    priceUsd,
    marketCapSol,
    marketCapUsd,
    virtualSolReservesUi,
    virtualTokenReservesUi,
    realSolReservesUi,
    realTokenReservesUi,
    createdAtMs,
    raw,
  };
}
function parseComplete(
  reader: Reader,
  job: LogJob,
  raw: unknown,
): IndexedComplete {
  const owner = reader.pubkey();
  const mint = reader.pubkey();
  const bondingCurveKey = reader.pubkey();
  let createdAtMs = job.receivedAtMs;
  try {
    createdAtMs = maybeTimestampMs(reader.i64(), job.receivedAtMs);
  } catch {}
  return {
    kind: "complete",
    mint,
    bondingCurveKey,
    owner,
    signature: job.signature,
    slot: job.slot,
    createdAtMs,
    raw,
  };
}
function decodeProgramData(line: string): Buffer | null {
  const match = line.match(/Program data:\s*([A-Za-z0-9+/=]+)/);
  if (!match) return null;
  try {
    return Buffer.from(match[1]!, "base64");
  } catch {
    return null;
  }
}
export function parsePumpLogs(
  job: LogJob,
  args: { solUsd: number | null; tokenDecimals: number; pumpSupplyUi: number },
): IndexedEvent[] {
  const events: IndexedEvent[] = [];
  for (const line of job.logs) {
    const data = decodeProgramData(line);
    if (!data || data.length < 8) continue;
    const eventName = DISCRIMINATORS.get(data.subarray(0, 8).toString("hex"));
    if (!eventName) continue;
    const reader = new Reader(data.subarray(8));
    const raw = { line, eventName, signature: job.signature, slot: job.slot };
    try {
      if (eventName === "CreateEvent")
        events.push(parseCreate(reader, job, raw));
      else if (eventName === "TradeEvent")
        events.push(parseTrade(reader, job, raw, args));
      else if (eventName === "CompleteEvent")
        events.push(parseComplete(reader, job, raw));
    } catch (error) {
      throw new Error(
        `Failed to parse ${eventName} for ${job.signature}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return events;
}
