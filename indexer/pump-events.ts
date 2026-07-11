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
    if (this.offset + length > this.bytes.length) {
      throw new Error(
        `Event buffer underflow at ${this.offset}, need ${length}, len=${this.bytes.length}`,
      );
    }

    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  u32(): number {
    const value = this.bytes.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  u64(): bigint {
    const value = this.bytes.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  i64(): bigint {
    const value = this.bytes.readBigInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  bool(): boolean {
    return this.take(1)[0] === 1;
  }

  string(): string {
    return this.take(this.u32()).toString("utf8");
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

function timestampMs(value: bigint, fallback: number): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 1_000_000_000
    ? seconds * 1000
    : fallback;
}

function parseCreate(reader: Reader, job: LogJob, raw: unknown): IndexedCreate {
  return {
    kind: "create",
    name: reader.string(),
    symbol: reader.string(),
    uri: reader.string(),
    mint: reader.pubkey(),
    bondingCurveKey: reader.pubkey(),
    creator: reader.pubkey(),
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
  input: {
    solUsd: number | null;
    tokenDecimals: number;
    pumpSupplyUi: number;
  },
): IndexedTrade {
  const mint = reader.pubkey();
  const solRaw = reader.u64();
  const tokenRaw = reader.u64();
  const isBuy = reader.bool();
  const owner = reader.pubkey();
  const timestamp = reader.i64();
  const virtualSolRaw = reader.u64();
  const virtualTokenRaw = reader.u64();

  // Remaining real reserve fields are read when present.
  try {
    reader.u64();
    reader.u64();
  } catch {}

  const tokenDeltaUi = uiAmount(tokenRaw, input.tokenDecimals);
  const solDeltaUi = solAmount(solRaw);
  const virtualSolUi = solAmount(virtualSolRaw);
  const virtualTokenUi = uiAmount(virtualTokenRaw, input.tokenDecimals);

  const tradePrice = tokenDeltaUi > 0 ? solDeltaUi / tokenDeltaUi : Number.NaN;
  const curvePrice =
    virtualTokenUi > 0 ? virtualSolUi / virtualTokenUi : Number.NaN;

  const priceSol = finite(tradePrice) ?? finite(curvePrice);
  const priceUsd =
    priceSol != null && input.solUsd != null ? priceSol * input.solUsd : null;
  const marketCapSol = priceSol != null ? priceSol * input.pumpSupplyUi : null;
  const marketCapUsd =
    marketCapSol != null && input.solUsd != null
      ? marketCapSol * input.solUsd
      : null;

  const createdAtMs = timestampMs(timestamp, job.receivedAtMs);

  return {
    kind: "trade",
    eventKey: [
      "helius",
      job.signature,
      mint,
      isBuy ? "buy" : "sell",
      createdAtMs,
    ].join(":"),
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
    createdAtMs = timestampMs(reader.i64(), job.receivedAtMs);
  } catch {}

  return {
    kind: "complete",
    owner,
    mint,
    bondingCurveKey,
    signature: job.signature,
    slot: job.slot,
    createdAtMs,
    raw,
  };
}

export function parsePumpLogs(
  job: LogJob,
  input: {
    solUsd: number | null;
    tokenDecimals: number;
    pumpSupplyUi: number;
  },
): IndexedEvent[] {
  const events: IndexedEvent[] = [];

  for (const line of job.logs) {
    const match = line.match(/Program data:\s*([A-Za-z0-9+/=]+)/);
    if (!match) continue;

    const data = Buffer.from(match[1]!, "base64");
    if (data.length < 8) continue;

    const eventName = DISCRIMINATORS.get(data.subarray(0, 8).toString("hex"));
    if (!eventName) continue;

    const reader = new Reader(data.subarray(8));
    const raw = {
      eventName,
      line,
      signature: job.signature,
      slot: job.slot,
    };

    if (eventName === "CreateEvent") {
      events.push(parseCreate(reader, job, raw));
    } else if (eventName === "TradeEvent") {
      events.push(parseTrade(reader, job, raw, input));
    } else {
      events.push(parseComplete(reader, job, raw));
    }
  }

  return events;
}
