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

type EventName = (typeof EVENT_NAMES)[number];

function discriminator(name: string): Buffer {
  return createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
}

const DISCRIMINATORS = new Map<string, EventName>(
  EVENT_NAMES.map((name) => [discriminator(name).toString("hex"), name]),
);

export type PumpLogDiagnostics = {
  programDataLines: number;
  recognizedEventLines: number;
  unknownEventLines: number;
  parseErrors: number;
  lastUnknownDiscriminator: string | null;
  lastProgramDataLength: number | null;
};

export type PumpLogParseResult = {
  events: IndexedEvent[];
  diagnostics: PumpLogDiagnostics;
};

class Reader {
  offset = 0;

  constructor(private readonly bytes: Buffer) {}

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  take(length: number): Buffer {
    if (length < 0 || this.offset + length > this.bytes.length) {
      throw new Error(
        `event buffer underflow offset=${this.offset} need=${length} length=${this.bytes.length}`,
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
    const length = this.u32();

    // Reject a corrupt/misaligned string before allocating or slicing.
    if (length > this.remaining) {
      throw new Error(
        `invalid event string length=${length} remaining=${this.remaining}`,
      );
    }

    return this.take(length).toString("utf8");
  }

  pubkey(): string {
    return base58(this.take(32));
  }
}

function tokenAmount(value: bigint, decimals: number): number {
  return Number(value) / 10 ** decimals;
}

function quoteAmount(value: bigint): number {
  return Number(value) / 1_000_000_000;
}

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function timestampMs(value: bigint, fallback: number): number {
  const seconds = Number(value);

  return Number.isFinite(seconds) && seconds > 1_000_000_000
    ? seconds * 1_000
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
  input: {
    solUsd: number | null;
    tokenDecimals: number;
    pumpSupplyUi: number;
  },
  eventIndex: number,
): IndexedTrade {
  /**
   * The current Pump TradeEvent keeps the legacy prefix below. New protocol
   * fields can be appended without breaking this reader.
   */
  const mint = reader.pubkey();

  const quoteRaw = reader.u64();

  const tokenRaw = reader.u64();

  const isBuy = reader.bool();

  const owner = reader.pubkey();

  const timestamp = reader.i64();

  const virtualQuoteRaw = reader.u64();

  const virtualTokenRaw = reader.u64();

  // Legacy real reserve fields remain part of the stable prefix. Read them
  // only when present so an older or shorter event remains parseable.
  if (reader.remaining >= 16) {
    reader.u64();
    reader.u64();
  }

  const tokenDeltaUi = tokenAmount(tokenRaw, input.tokenDecimals);

  const quoteDeltaUi = quoteAmount(quoteRaw);

  const virtualQuoteUi = quoteAmount(virtualQuoteRaw);

  const virtualTokenUi = tokenAmount(virtualTokenRaw, input.tokenDecimals);

  const executionPrice =
    tokenDeltaUi > 0 ? quoteDeltaUi / tokenDeltaUi : Number.NaN;

  const curvePrice =
    virtualTokenUi > 0 ? virtualQuoteUi / virtualTokenUi : Number.NaN;

  const priceSol = finite(executionPrice) ?? finite(curvePrice);

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

    /**
     * A transaction can emit more than one trade for the same mint, side, and
     * second. Include the Program-data ordinal to avoid collapsing them.
     */
    eventKey: ["helius", job.signature, eventIndex, mint].join(":"),

    mint,

    signature: job.signature,

    slot: job.slot,

    owner,

    side: isBuy ? "buy" : "sell",

    tokenDeltaUi,

    solDeltaUi: quoteDeltaUi,

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

  if (reader.remaining >= 8) {
    createdAtMs = timestampMs(reader.i64(), job.receivedAtMs);
  }

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
  const match = line.match(/^Program data:\s*([A-Za-z0-9+/=]+)\s*$/);

  if (!match) {
    return null;
  }

  try {
    return Buffer.from(match[1]!, "base64");
  } catch {
    return null;
  }
}

function eventAtOffset(data: Buffer): {
  name: EventName;
  offset: number;
} | null {
  /**
   * Normal Anchor logs place the event discriminator at offset 0. Checking
   * offsets 8 and 16 also tolerates an event-CPI wrapper without scanning the
   * whole payload or accepting random field bytes.
   */
  for (const offset of [0, 8, 16]) {
    if (data.length < offset + 8) {
      continue;
    }

    const name = DISCRIMINATORS.get(
      data.subarray(offset, offset + 8).toString("hex"),
    );

    if (name) {
      return {
        name,
        offset,
      };
    }
  }

  return null;
}

export function parsePumpLogs(
  job: LogJob,
  input: {
    solUsd: number | null;
    tokenDecimals: number;
    pumpSupplyUi: number;
    programId: string;
  },
): PumpLogParseResult {
  const events: IndexedEvent[] = [];

  const diagnostics: PumpLogDiagnostics = {
    programDataLines: 0,
    recognizedEventLines: 0,
    unknownEventLines: 0,
    parseErrors: 0,
    lastUnknownDiscriminator: null,
    lastProgramDataLength: null,
  };

  const programStack: string[] = [];

  let eventIndex = 0;

  for (const line of job.logs) {
    const invoke = line.match(
      /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[\d+\]$/,
    );

    if (invoke) {
      programStack.push(invoke[1]!);
      continue;
    }

    const exit = line.match(
      /^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed:.*)$/,
    );

    if (exit) {
      const index = programStack.lastIndexOf(exit[1]!);

      if (index >= 0) {
        programStack.splice(index);
      }

      continue;
    }

    const data = decodeProgramData(line);

    if (!data) {
      continue;
    }

    const activeProgram = programStack[programStack.length - 1] ?? null;

    const located = eventAtOffset(data);

    /**
     * Ignore nested programs' unrelated Program-data lines. Still accept a
     * recognized Pump discriminator when an RPC provider omitted invocation
     * stack lines.
     */
    if (activeProgram !== input.programId && !located) {
      continue;
    }

    diagnostics.programDataLines++;

    diagnostics.lastProgramDataLength = data.length;

    if (!located) {
      diagnostics.unknownEventLines++;

      diagnostics.lastUnknownDiscriminator =
        data.length >= 8
          ? data.subarray(0, 8).toString("hex")
          : `short:${data.length}`;

      continue;
    }

    diagnostics.recognizedEventLines++;

    const payload = data.subarray(located.offset + 8);

    const reader = new Reader(payload);

    const raw = {
      eventName: located.name,

      eventOffset: located.offset,

      eventIndex,

      dataLength: data.length,

      signature: job.signature,

      slot: job.slot,
    };

    try {
      if (located.name === "CreateEvent") {
        events.push(parseCreate(reader, job, raw));
      } else if (located.name === "TradeEvent") {
        events.push(parseTrade(reader, job, raw, input, eventIndex));
      } else {
        events.push(parseComplete(reader, job, raw));
      }

      eventIndex++;
    } catch {
      diagnostics.parseErrors++;
    }
  }

  return {
    events,
    diagnostics,
  };
}
