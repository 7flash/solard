import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import bs58 from "bs58";
import {
  deriveAssociatedBondingCurveAta,
  deriveBondingCurvePda,
  type ParsedPumpCreate,
  type ParsedPumpTrade,
} from "../pump/pump-parser.ts";

export type ParsedPumpLogEvents = {
  creates: ParsedPumpCreate[];
  trades: ParsedPumpTrade[];
  completes: Array<{ mint: string; signature: string; slot: number }>;
  rawProgramData: number;
};

const CREATE_EVENT_DISC = disc("event:CreateEvent");
const TRADE_EVENT_DISC = disc("event:TradeEvent");
const COMPLETE_EVENT_DISC = disc("event:CompleteEvent");

function disc(label: string): Buffer {
  return createHash("sha256").update(label).digest().subarray(0, 8);
}

function readBorshString(
  buf: Buffer,
  offset: number,
): { value: string; offset: number } | null {
  if (offset + 4 > buf.length) return null;
  const len = buf.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + len;
  if (len > 4096 || end > buf.length) return null;
  return { value: buf.subarray(start, end).toString("utf8"), offset: end };
}

function readPubkey(
  buf: Buffer,
  offset: number,
): { value: string; offset: number } | null {
  if (offset + 32 > buf.length) return null;
  return {
    value: bs58.encode(buf.subarray(offset, offset + 32)),
    offset: offset + 32,
  };
}

function readU64(
  buf: Buffer,
  offset: number,
): { value: bigint; offset: number } | null {
  if (offset + 8 > buf.length) return null;
  return { value: buf.readBigUInt64LE(offset), offset: offset + 8 };
}

function readI64(
  buf: Buffer,
  offset: number,
): { value: bigint; offset: number } | null {
  if (offset + 8 > buf.length) return null;
  return { value: buf.readBigInt64LE(offset), offset: offset + 8 };
}

function readBool(
  buf: Buffer,
  offset: number,
): { value: boolean; offset: number } | null {
  if (offset + 1 > buf.length) return null;
  return { value: buf[offset] !== 0, offset: offset + 1 };
}

function pumpEventStart(buf: Buffer): number {
  for (const start of [0, 8, 16]) {
    if (buf.length < start + 8) continue;
    const candidate = buf.subarray(start, start + 8);
    if (
      candidate.equals(CREATE_EVENT_DISC) ||
      candidate.equals(TRADE_EVENT_DISC) ||
      candidate.equals(COMPLETE_EVENT_DISC)
    ) {
      return start;
    }
  }
  return -1;
}

function programDataBuffers(logs: string[]): Buffer[] {
  const out: Buffer[] = [];
  for (const line of logs ?? []) {
    const marker = "Program data: ";
    const idx = String(line).indexOf(marker);
    if (idx < 0) continue;
    const raw = String(line)
      .slice(idx + marker.length)
      .trim();
    try {
      out.push(Buffer.from(raw, "base64"));
    } catch {}
  }
  return out;
}

function safeNumber(value: bigint, scale: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n / scale : 0;
}

function pickPriceSol(args: {
  solAmount: bigint;
  tokenAmount: bigint;
  virtualSolReserves?: bigint | null;
  virtualTokenReserves?: bigint | null;
}): number | null {
  if (
    args.virtualSolReserves &&
    args.virtualTokenReserves &&
    args.virtualTokenReserves > 0n
  ) {
    const virtualSolUi = safeNumber(args.virtualSolReserves, 1_000_000_000);
    const virtualTokenUi = safeNumber(args.virtualTokenReserves, 1_000_000);
    if (virtualSolUi > 0 && virtualTokenUi > 0)
      return virtualSolUi / virtualTokenUi;
  }
  const solUi = safeNumber(args.solAmount, 1_000_000_000);
  const tokenUi = safeNumber(args.tokenAmount, 1_000_000);
  return solUi > 0 && tokenUi > 0 ? solUi / tokenUi : null;
}

export function parsePumpLogs(input: {
  logs: string[];
  signature: string;
  slot?: number;
  solUsd?: number | null;
  supplyUi?: number;
  now?: number;
}): ParsedPumpLogEvents {
  const signature = input.signature;
  const slot = Number(input.slot ?? 0);
  const solUsd = input.solUsd ?? null;
  const now = input.now ?? Date.now();
  const supplyUi = input.supplyUi ?? 1_000_000_000;
  const creates: ParsedPumpCreate[] = [];
  const trades: ParsedPumpTrade[] = [];
  const completes: ParsedPumpLogEvents["completes"] = [];
  let tradeIndex = 0;

  const buffers = programDataBuffers(input.logs ?? []);
  for (const buf of buffers) {
    const eventStart = pumpEventStart(buf);
    if (eventStart < 0) continue;
    const d = buf.subarray(eventStart, eventStart + 8);
    let offset = eventStart + 8;

    if (d.equals(CREATE_EVENT_DISC)) {
      const name = readBorshString(buf, offset);
      if (!name) continue;
      offset = name.offset;
      const symbol = readBorshString(buf, offset);
      if (!symbol) continue;
      offset = symbol.offset;
      const uri = readBorshString(buf, offset);
      if (!uri) continue;
      offset = uri.offset;
      const mint = readPubkey(buf, offset);
      if (!mint) continue;
      offset = mint.offset;
      const bondingCurve = readPubkey(buf, offset);
      if (bondingCurve) offset = bondingCurve.offset;
      const user = readPubkey(buf, offset);
      const curve = bondingCurve?.value ?? deriveBondingCurvePda(mint.value);
      creates.push({
        mint: mint.value,
        signature,
        slot,
        name: name.value,
        symbol: symbol.value,
        uri: uri.value || null,
        creator: user?.value ?? null,
        bondingCurveKey: curve ?? null,
        associatedBondingCurve: deriveAssociatedBondingCurveAta(
          mint.value,
          curve,
        ),
        isCreateV2: true,
        isMayhemMode: null,
        launchMode: "unknown",
        raw: { source: "helius-logs", event: "CreateEvent" },
      });
      continue;
    }

    if (d.equals(TRADE_EVENT_DISC)) {
      const mint = readPubkey(buf, offset);
      if (!mint) continue;
      offset = mint.offset;
      const solAmount = readU64(buf, offset);
      if (!solAmount) continue;
      offset = solAmount.offset;
      const tokenAmount = readU64(buf, offset);
      if (!tokenAmount) continue;
      offset = tokenAmount.offset;
      const isBuy = readBool(buf, offset);
      if (!isBuy) continue;
      offset = isBuy.offset;
      const user = readPubkey(buf, offset);
      if (!user) continue;
      offset = user.offset;
      const timestamp = readI64(buf, offset);
      if (timestamp) offset = timestamp.offset;
      const virtualSolReserves = readU64(buf, offset);
      if (virtualSolReserves) offset = virtualSolReserves.offset;
      const virtualTokenReserves = readU64(buf, offset);
      if (virtualTokenReserves) offset = virtualTokenReserves.offset;
      const realSolReserves = readU64(buf, offset);
      if (realSolReserves) offset = realSolReserves.offset;
      const realTokenReserves = readU64(buf, offset);
      if (realTokenReserves) offset = realTokenReserves.offset;
      const solDeltaUi = safeNumber(solAmount.value, 1_000_000_000);
      const tokenDeltaUi = safeNumber(tokenAmount.value, 1_000_000);
      const priceSol = pickPriceSol({
        solAmount: solAmount.value,
        tokenAmount: tokenAmount.value,
        virtualSolReserves: virtualSolReserves?.value ?? null,
        virtualTokenReserves: virtualTokenReserves?.value ?? null,
      });
      const priceUsd =
        priceSol != null && solUsd != null ? priceSol * solUsd : null;
      trades.push({
        id: `${signature}:logs:${tradeIndex++}`,
        mint: mint.value,
        signature,
        slot,
        owner: user.value,
        side: isBuy.value ? "buy" : "sell",
        tokenDeltaUi,
        solDeltaUi,
        priceSol,
        priceUsd,
        marketCapUsd: priceUsd != null ? priceUsd * supplyUi : null,
        createdAtMs:
          timestamp?.value != null &&
          Number(timestamp.value) > 1_000_000_000 &&
          Number(timestamp.value) < 10_000_000_000
            ? Number(timestamp.value) * 1000
            : now,
        raw: {
          source: "helius-logs",
          event: "TradeEvent",
          solAmount: solAmount.value.toString(),
          tokenAmount: tokenAmount.value.toString(),
          timestamp: timestamp?.value.toString() ?? null,
          virtualSolReserves: virtualSolReserves?.value.toString() ?? null,
          virtualTokenReserves: virtualTokenReserves?.value.toString() ?? null,
          realSolReserves: realSolReserves?.value.toString() ?? null,
          realTokenReserves: realTokenReserves?.value.toString() ?? null,
        },
      });
      continue;
    }

    if (d.equals(COMPLETE_EVENT_DISC)) {
      const mint = readPubkey(buf, offset);
      if (mint?.value) completes.push({ mint: mint.value, signature, slot });
    }
  }

  return { creates, trades, completes, rawProgramData: buffers.length };
}
