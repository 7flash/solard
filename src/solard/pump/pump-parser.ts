import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";

export const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMPSWAP_AMM_PROGRAM_ID =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const PUMP_FEES_PROGRAM_ID =
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
export const MAYHEM_PROGRAM_ID = "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e";
export const MIGRATION_WRAPPER_PROGRAM_ID =
  "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID =
  "TokenzQdBNbLqP5VEhdkAS6EPFQqHd6VfUiXfWmjLz";
export const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export const PUMP_CREATE_V1_DISC = disc("global:create");
export const PUMP_CREATE_V2_DISC = disc("global:create_v2");
export const PUMP_BUY_DISC = disc("global:buy");
export const PUMP_SELL_DISC = disc("global:sell");
// Some third-party notes cite this older/incorrect sell discriminator; keep it as an accepted alternate for diagnostics only.
export const PUMP_SELL_DISC_REPORTED_ALT = Buffer.from(
  "33e17a3a30c5e311",
  "hex",
);
export const PUMP_CREATE_EVENT_DISC = disc("event:CreateEvent");
export const PUMP_TRADE_EVENT_DISC = disc("event:TradeEvent");
export const PUMP_COMPLETE_EVENT_DISC = disc("event:CompleteEvent");

export const PUMP_CREATE_V1_DISC_HEX = hex(PUMP_CREATE_V1_DISC);
export const PUMP_CREATE_V2_DISC_HEX = hex(PUMP_CREATE_V2_DISC);
export const PUMP_BUY_DISC_HEX = hex(PUMP_BUY_DISC);
export const PUMP_SELL_DISC_HEX = hex(PUMP_SELL_DISC);

export type PumpLaunchMode = "standard" | "mayhem" | "unknown";

export type ParsedPumpCreate = {
  mint: string;
  signature: string;
  slot: number;
  name: string;
  symbol: string;
  uri: string | null;
  creator: string | null;
  bondingCurveKey: string | null;
  associatedBondingCurve: string | null;
  isCreateV2: boolean;
  isMayhemMode: boolean | null;
  launchMode: PumpLaunchMode;
  raw?: Record<string, unknown>;
};

export type ParsedPumpTrade = {
  id: string;
  mint: string;
  signature: string;
  slot: number;
  owner: string | null;
  side: "buy" | "sell" | "unknown";
  tokenDeltaUi: number;
  solDeltaUi: number;
  priceSol: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  createdAtMs: number;
  raw: Record<string, unknown>;
};

export type ParsedPumpTransaction = {
  creates: ParsedPumpCreate[];
  trades: ParsedPumpTrade[];
  completes: Array<{ mint: string; signature: string; slot: number }>;
};

function disc(label: string): Buffer {
  return createHash("sha256").update(label).digest().subarray(0, 8);
}

function hex(buf: Buffer): string {
  return "0x" + buf.toString("hex");
}

function asBase58(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof PublicKey) return value.toBase58();
  if (value && typeof (value as { pubkey?: unknown }).pubkey === "string")
    return String((value as { pubkey: string }).pubkey);
  if (value && typeof (value as { publicKey?: unknown }).publicKey === "string")
    return String((value as { publicKey: string }).publicKey);
  if (value && (value as { pubkey?: unknown }).pubkey instanceof PublicKey)
    return (value as { pubkey: PublicKey }).pubkey.toBase58();
  if (
    value &&
    (value as { publicKey?: unknown }).publicKey instanceof PublicKey
  )
    return (value as { publicKey: PublicKey }).publicKey.toBase58();
  if (
    value &&
    typeof (value as { toBase58?: unknown }).toBase58 === "function"
  ) {
    return (value as { toBase58: () => string }).toBase58();
  }
  if (value instanceof Uint8Array) return bs58.encode(Buffer.from(value));
  if (
    value &&
    typeof (value as { toString?: unknown }).toString === "function"
  ) {
    const text = String((value as { toString: () => string }).toString());
    return text === "[object Object]" ? "" : text;
  }
  return "";
}

function getSignature(tx: any, fallback = ""): string {
  return String(
    tx?.transaction?.signatures?.[0] ?? tx?.signature ?? fallback ?? "",
  );
}

function loadedAddressLookups(
  tx: any,
): { writable: unknown[]; readonly: unknown[] } | undefined {
  const writable = Array.from(
    tx?.meta?.loadedAddresses?.writable ??
      tx?.meta?.loadedWritableAddresses ??
      [],
  );
  const readonly = Array.from(
    tx?.meta?.loadedAddresses?.readonly ??
      tx?.meta?.loadedReadonlyAddresses ??
      [],
  );
  return writable.length || readonly.length
    ? { writable, readonly }
    : undefined;
}

function flattenResolvedKeys(keys: any): string[] {
  const accountKeys = Array.from(keys?.accountKeys ?? [])
    .map(asBase58)
    .filter(Boolean);
  if (accountKeys.length) return accountKeys;
  const staticKeys = Array.from(keys?.staticAccountKeys ?? [])
    .map(asBase58)
    .filter(Boolean);
  const loadedWritable = Array.from(
    keys?.accountKeysFromLookups?.writable ?? [],
  )
    .map(asBase58)
    .filter(Boolean);
  const loadedReadonly = Array.from(
    keys?.accountKeysFromLookups?.readonly ?? [],
  )
    .map(asBase58)
    .filter(Boolean);
  return [...staticKeys, ...loadedWritable, ...loadedReadonly];
}

function getAccountKeys(tx: any): string[] {
  const message = tx?.transaction?.message;
  if (!message) return [];

  const lookups = loadedAddressLookups(tx);
  if (typeof message.getAccountKeys === "function") {
    if (lookups) {
      try {
        const resolved = flattenResolvedKeys(
          message.getAccountKeys({ accountKeysFromLookups: lookups }),
        );
        if (resolved.length) return resolved;
      } catch {
        // Fall through to static/json fallback. Some RPC responses omit ALT lookups even with maxSupportedTransactionVersion.
      }
    }
    try {
      const resolved = flattenResolvedKeys(message.getAccountKeys());
      if (resolved.length) return resolved;
    } catch {
      // Versioned messages throw "address table lookups were not resolved" when called without lookup addresses.
    }
  }

  const keys = Array.from(
    message.accountKeys ?? message.staticAccountKeys ?? [],
  )
    .map(asBase58)
    .filter(Boolean);
  const loadedWritable = Array.from(lookups?.writable ?? [])
    .map(asBase58)
    .filter(Boolean);
  const loadedReadonly = Array.from(lookups?.readonly ?? [])
    .map(asBase58)
    .filter(Boolean);
  return [...keys, ...loadedWritable, ...loadedReadonly];
}

function getOuterInstructions(tx: any): any[] {
  const message = tx?.transaction?.message;
  return Array.from(
    message?.compiledInstructions ?? message?.instructions ?? [],
  );
}

function getInnerInstructions(tx: any): any[] {
  const groups = Array.from(tx?.meta?.innerInstructions ?? []);
  const out: any[] = [];
  for (const group of groups as any[]) {
    for (const ix of group?.instructions ?? []) out.push(ix);
  }
  return out;
}

function instructionProgramId(ix: any, accountKeys: string[]): string {
  if (typeof ix?.programId === "string") return ix.programId;
  if (ix?.programId) return asBase58(ix.programId);
  const idx = Number(ix?.programIdIndex ?? -1);
  return Number.isInteger(idx) && idx >= 0 ? (accountKeys[idx] ?? "") : "";
}

function instructionAccountIndexes(ix: any): number[] {
  const raw = ix?.accountKeyIndexes ?? ix?.accounts ?? [];
  if (raw instanceof Uint8Array) return Array.from(raw);
  return Array.from(raw)
    .map((v: any) => Number(v))
    .filter((v) => Number.isInteger(v) && v >= 0);
}

function instructionAccounts(ix: any, accountKeys: string[]): string[] {
  const rawAccounts = ix?.accounts ?? ix?.accountKeyIndexes ?? [];
  if (
    Array.isArray(rawAccounts) &&
    rawAccounts.length &&
    typeof rawAccounts[0] === "string"
  )
    return rawAccounts;
  return instructionAccountIndexes(ix)
    .map((idx) => accountKeys[idx])
    .filter(Boolean);
}

function instructionData(ix: any): Buffer {
  const data = ix?.data;
  if (!data) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.from(data);
  if (typeof data === "string") {
    try {
      const base64 = Buffer.from(data, "base64");
      if (base64.length >= 8 && isKnownDisc(base64.subarray(0, 8)))
        return base64;
    } catch {}
    try {
      return Buffer.from(bs58.decode(data));
    } catch {}
    try {
      return Buffer.from(data, "base64");
    } catch {}
  }
  return Buffer.alloc(0);
}

function isKnownDisc(buf: Buffer): boolean {
  return [
    PUMP_CREATE_V1_DISC,
    PUMP_CREATE_V2_DISC,
    PUMP_BUY_DISC,
    PUMP_SELL_DISC,
    PUMP_SELL_DISC_REPORTED_ALT,
    PUMP_CREATE_EVENT_DISC,
    PUMP_TRADE_EVENT_DISC,
    PUMP_COMPLETE_EVENT_DISC,
  ].some((known) => buf.equals(known));
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

function parseCreateInstructionData(
  buf: Buffer,
): {
  name: string;
  symbol: string;
  uri: string | null;
  isCreateV2: boolean;
} | null {
  if (buf.length < 8) return null;
  const isCreateV1 = buf.subarray(0, 8).equals(PUMP_CREATE_V1_DISC);
  const isCreateV2 = buf.subarray(0, 8).equals(PUMP_CREATE_V2_DISC);
  if (!isCreateV1 && !isCreateV2) return null;
  let offset = 8;
  const name = readBorshString(buf, offset);
  if (!name) return { name: "", symbol: "", uri: null, isCreateV2 };
  offset = name.offset;
  const symbol = readBorshString(buf, offset);
  if (!symbol) return { name: name.value, symbol: "", uri: null, isCreateV2 };
  offset = symbol.offset;
  const uri = readBorshString(buf, offset);
  return {
    name: name.value,
    symbol: symbol.value,
    uri: uri?.value || null,
    isCreateV2,
  };
}

function parsePumpEvent(
  buf: Buffer,
): {
  name: "CreateEvent" | "TradeEvent" | "CompleteEvent";
  data: Record<string, unknown>;
} | null {
  if (buf.length < 8) return null;
  const d = buf.subarray(0, 8);
  let offset = 8;
  if (d.equals(PUMP_CREATE_EVENT_DISC)) {
    const name = readBorshString(buf, offset);
    if (!name) return null;
    offset = name.offset;
    const symbol = readBorshString(buf, offset);
    if (!symbol) return null;
    offset = symbol.offset;
    const uri = readBorshString(buf, offset);
    if (!uri) return null;
    offset = uri.offset;
    const mint = readPubkey(buf, offset);
    if (!mint) return null;
    offset = mint.offset;
    const bondingCurve = readPubkey(buf, offset);
    if (!bondingCurve) return null;
    offset = bondingCurve.offset;
    const user = readPubkey(buf, offset);
    return {
      name: "CreateEvent",
      data: {
        name: name.value,
        symbol: symbol.value,
        uri: uri.value,
        mint: mint.value,
        bondingCurve: bondingCurve.value,
        user: user?.value ?? null,
      },
    };
  }
  if (d.equals(PUMP_TRADE_EVENT_DISC)) {
    const mint = readPubkey(buf, offset);
    if (!mint) return null;
    offset = mint.offset;
    const solAmount = readU64(buf, offset);
    if (!solAmount) return null;
    offset = solAmount.offset;
    const tokenAmount = readU64(buf, offset);
    if (!tokenAmount) return null;
    offset = tokenAmount.offset;
    const isBuy = readBool(buf, offset);
    if (!isBuy) return null;
    offset = isBuy.offset;
    const user = readPubkey(buf, offset);
    if (!user) return null;
    offset = user.offset;
    const timestamp = readI64(buf, offset);
    if (timestamp) offset = timestamp.offset;
    const virtualSolReserves = readU64(buf, offset);
    if (virtualSolReserves) offset = virtualSolReserves.offset;
    const virtualTokenReserves = readU64(buf, offset);
    if (virtualTokenReserves) offset = virtualTokenReserves.offset;
    return {
      name: "TradeEvent",
      data: {
        mint: mint.value,
        solAmount: solAmount.value.toString(),
        tokenAmount: tokenAmount.value.toString(),
        isBuy: isBuy.value,
        user: user.value,
        timestamp: timestamp?.value.toString() ?? null,
        virtualSolReserves: virtualSolReserves?.value.toString() ?? null,
        virtualTokenReserves: virtualTokenReserves?.value.toString() ?? null,
      },
    };
  }
  if (d.equals(PUMP_COMPLETE_EVENT_DISC)) {
    const mint = readPubkey(buf, offset);
    return { name: "CompleteEvent", data: { mint: mint?.value ?? null } };
  }
  return null;
}

function programDataBuffers(logs: string[]): Buffer[] {
  const out: Buffer[] = [];
  for (const line of logs) {
    const marker = "Program data: ";
    const idx = line.indexOf(marker);
    if (idx < 0) continue;
    const raw = line.slice(idx + marker.length).trim();
    try {
      out.push(Buffer.from(raw, "base64"));
    } catch {}
  }
  return out;
}

export function deriveBondingCurvePda(mint: string): string | null {
  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
      new PublicKey(PUMPFUN_PROGRAM_ID),
    );
    return pda.toBase58();
  } catch {
    return null;
  }
}

export function deriveAssociatedBondingCurveAta(
  mint: string,
  bondingCurve: string | null | undefined,
): string | null {
  try {
    const curve = new PublicKey(
      bondingCurve || deriveBondingCurvePda(mint) || "",
    );
    const [ata] = PublicKey.findProgramAddressSync(
      [
        curve.toBuffer(),
        new PublicKey(TOKEN_PROGRAM_ID).toBuffer(),
        new PublicKey(mint).toBuffer(),
      ],
      new PublicKey(ATA_PROGRAM_ID),
    );
    return ata.toBase58();
  } catch {
    return null;
  }
}

function aggregateTokenBalances(
  tokenBalances: any[] | undefined,
): Map<string, Map<string, { raw: bigint; decimals: number }>> {
  const out = new Map<string, Map<string, { raw: bigint; decimals: number }>>();
  for (const row of tokenBalances ?? []) {
    const mint = typeof row?.mint === "string" ? row.mint : "";
    const owner = typeof row?.owner === "string" ? row.owner : "";
    if (!mint || !owner) continue;
    let raw = 0n;
    try {
      raw = BigInt(String(row?.uiTokenAmount?.amount ?? "0"));
    } catch {}
    const decimals = Number(row?.uiTokenAmount?.decimals ?? 6);
    const byOwner =
      out.get(mint) ?? new Map<string, { raw: bigint; decimals: number }>();
    const prev = byOwner.get(owner);
    byOwner.set(owner, {
      raw: (prev?.raw ?? 0n) + raw,
      decimals: prev?.decimals ?? decimals,
    });
    out.set(mint, byOwner);
  }
  return out;
}

function ui(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

function ownerSolDeltaLamports(
  tx: any,
  accountKeys: string[],
  owner: string,
): bigint | null {
  const idx = accountKeys.findIndex((key) => key === owner);
  if (idx < 0) return null;
  const pre = tx?.meta?.preBalances?.[idx];
  const post = tx?.meta?.postBalances?.[idx];
  if (typeof pre !== "number" || typeof post !== "number") return null;
  return BigInt(post) - BigInt(pre);
}

function initialSupplyTransferCount(tx: any, mint: string): number {
  let count = 0;
  for (const ix of getInnerInstructions(tx)) {
    const parsed = ix?.parsed;
    if (!parsed || String(parsed.type ?? "").toLowerCase() !== "transfer")
      continue;
    const info = parsed.info ?? {};
    if (String(info.mint ?? "") && String(info.mint) !== mint) continue;
    const rawAmount = String(info.amount ?? info.tokenAmount?.amount ?? "");
    if (rawAmount === "1000000000000000") count++;
  }
  return count;
}

function createFromInstruction(args: {
  ix: any;
  tx: any;
  signature: string;
  slot: number;
  accountKeys: string[];
}): ParsedPumpCreate | null {
  const data = instructionData(args.ix);
  const create = parseCreateInstructionData(data);
  if (!create) return null;
  const accounts = instructionAccounts(args.ix, args.accountKeys);
  const mint = accounts[0] ?? accounts[2] ?? "";
  if (!mint) return null;
  const bondingCurve =
    accounts.find(
      (value) =>
        value &&
        value !== mint &&
        value !== PUMPFUN_PROGRAM_ID &&
        value.endsWith("pump") === false,
    ) ?? deriveBondingCurvePda(mint);
  const associated = deriveAssociatedBondingCurveAta(mint, bondingCurve);
  const transferCount = initialSupplyTransferCount(args.tx, mint);
  const mayhem = transferCount >= 2;
  return {
    mint,
    signature: args.signature,
    slot: args.slot,
    name: create.name,
    symbol: create.symbol,
    uri: create.uri,
    creator: accounts[7] ?? accounts[6] ?? null,
    bondingCurveKey: bondingCurve ?? null,
    associatedBondingCurve: associated,
    isCreateV2: create.isCreateV2,
    isMayhemMode: transferCount > 0 ? mayhem : null,
    launchMode:
      transferCount >= 2
        ? "mayhem"
        : transferCount === 1
          ? "standard"
          : "unknown",
    raw: {
      source: "instruction",
      accounts: accounts.length,
      disc: hex(data.subarray(0, 8)),
      transferCount,
    },
  };
}

function createsFromLogs(args: {
  tx: any;
  signature: string;
  slot: number;
}): ParsedPumpCreate[] {
  const out: ParsedPumpCreate[] = [];
  for (const buffer of programDataBuffers(args.tx?.meta?.logMessages ?? [])) {
    const event = parsePumpEvent(buffer);
    if (!event || event.name !== "CreateEvent") continue;
    const mint = String(event.data.mint ?? "");
    if (!mint) continue;
    const bondingCurve = String(
      event.data.bondingCurve ?? deriveBondingCurvePda(mint) ?? "",
    );
    const transferCount = initialSupplyTransferCount(args.tx, mint);
    out.push({
      mint,
      signature: args.signature,
      slot: args.slot,
      name: String(event.data.name ?? ""),
      symbol: String(event.data.symbol ?? ""),
      uri: typeof event.data.uri === "string" ? String(event.data.uri) : null,
      creator:
        typeof event.data.user === "string" ? String(event.data.user) : null,
      bondingCurveKey: bondingCurve || null,
      associatedBondingCurve: deriveAssociatedBondingCurveAta(
        mint,
        bondingCurve,
      ),
      isCreateV2: true,
      isMayhemMode: transferCount > 0 ? transferCount >= 2 : null,
      launchMode:
        transferCount >= 2
          ? "mayhem"
          : transferCount === 1
            ? "standard"
            : "unknown",
      raw: { source: "event", transferCount },
    });
  }
  return out;
}

function tradesFromLogs(args: {
  tx: any;
  signature: string;
  slot: number;
  solUsd: number | null;
  now: number;
  supplyUi: number;
}): ParsedPumpTrade[] {
  const out: ParsedPumpTrade[] = [];
  let index = 0;
  for (const buffer of programDataBuffers(args.tx?.meta?.logMessages ?? [])) {
    const event = parsePumpEvent(buffer);
    if (!event || event.name !== "TradeEvent") continue;
    const mint = String(event.data.mint ?? "");
    if (!mint) continue;
    const solDeltaUi =
      Number(BigInt(String(event.data.solAmount ?? "0"))) / 1_000_000_000;
    const tokenDeltaUi =
      Number(BigInt(String(event.data.tokenAmount ?? "0"))) / 1_000_000;
    const priceSol = tokenDeltaUi > 0 ? solDeltaUi / tokenDeltaUi : null;
    const priceUsd =
      priceSol != null && args.solUsd != null ? priceSol * args.solUsd : null;
    out.push({
      id: `${args.signature}:event:${index++}`,
      mint,
      signature: args.signature,
      slot: args.slot,
      owner:
        typeof event.data.user === "string" ? String(event.data.user) : null,
      side:
        event.data.isBuy === true
          ? "buy"
          : event.data.isBuy === false
            ? "sell"
            : "unknown",
      tokenDeltaUi,
      solDeltaUi,
      priceSol,
      priceUsd,
      marketCapUsd: priceUsd != null ? priceUsd * args.supplyUi : null,
      createdAtMs: args.now,
      raw: { source: "event", ...event.data },
    });
  }
  return out;
}

function tradesFromBalances(args: {
  tx: any;
  signature: string;
  slot: number;
  solUsd: number | null;
  now: number;
  supplyUi: number;
}): ParsedPumpTrade[] {
  const accountKeys = getAccountKeys(args.tx);
  const pre = aggregateTokenBalances(args.tx?.meta?.preTokenBalances);
  const post = aggregateTokenBalances(args.tx?.meta?.postTokenBalances);
  const pumpInstructionMints = new Set<string>();
  for (const ix of getOuterInstructions(args.tx)) {
    if (instructionProgramId(ix, accountKeys) !== PUMPFUN_PROGRAM_ID) continue;
    const data = instructionData(ix);
    if (
      !data.subarray(0, 8).equals(PUMP_BUY_DISC) &&
      !data.subarray(0, 8).equals(PUMP_SELL_DISC) &&
      !data.subarray(0, 8).equals(PUMP_SELL_DISC_REPORTED_ALT)
    )
      continue;
    const accounts = instructionAccounts(ix, accountKeys);
    const mint =
      accounts.find((value) => value?.endsWith("pump")) ?? accounts[2] ?? "";
    if (mint) pumpInstructionMints.add(mint);
  }
  const mints = new Set<string>(
    [...pre.keys(), ...post.keys()].filter(
      (mint) => mint.endsWith("pump") || pumpInstructionMints.has(mint),
    ),
  );
  const out: ParsedPumpTrade[] = [];
  for (const mint of mints) {
    const owners = new Set<string>([
      ...(pre.get(mint)?.keys() ?? []),
      ...(post.get(mint)?.keys() ?? []),
    ]);
    for (const owner of owners) {
      const before = pre.get(mint)?.get(owner);
      const after = post.get(mint)?.get(owner);
      const decimals = after?.decimals ?? before?.decimals ?? 6;
      const deltaRaw = (after?.raw ?? 0n) - (before?.raw ?? 0n);
      if (deltaRaw === 0n) continue;
      const tokenDeltaUi = Math.abs(ui(deltaRaw, decimals));
      if (!Number.isFinite(tokenDeltaUi) || tokenDeltaUi <= 0) continue;
      const solDelta = ownerSolDeltaLamports(args.tx, accountKeys, owner);
      const solDeltaUi =
        solDelta == null ? 0 : Math.abs(Number(solDelta) / 1_000_000_000);
      const priceSol = solDeltaUi > 0 ? solDeltaUi / tokenDeltaUi : null;
      const priceUsd =
        priceSol != null && args.solUsd != null ? priceSol * args.solUsd : null;
      out.push({
        id: `${args.signature}:balance:${mint}:${owner}`,
        mint,
        signature: args.signature,
        slot: args.slot,
        owner,
        side: deltaRaw > 0n ? "buy" : deltaRaw < 0n ? "sell" : "unknown",
        tokenDeltaUi,
        solDeltaUi,
        priceSol,
        priceUsd,
        marketCapUsd: priceUsd != null ? priceUsd * args.supplyUi : null,
        createdAtMs: args.now,
        raw: { source: "balance", owner, deltaRaw: deltaRaw.toString() },
      });
    }
  }
  return out;
}

export function parsePumpTransaction(input: {
  tx: any;
  signature?: string;
  solUsd: number | null;
  supplyUi?: number;
  now?: number;
}): ParsedPumpTransaction {
  const signature = getSignature(input.tx, input.signature);
  const slot = Number(input.tx?.slot ?? 0);
  const now = input.now ?? Date.now();
  const supplyUi = input.supplyUi ?? 1_000_000_000;
  const accountKeys = getAccountKeys(input.tx);

  const createsByMint = new Map<string, ParsedPumpCreate>();
  for (const create of createsFromLogs({ tx: input.tx, signature, slot }))
    createsByMint.set(create.mint, create);
  for (const ix of getOuterInstructions(input.tx)) {
    if (instructionProgramId(ix, accountKeys) !== PUMPFUN_PROGRAM_ID) continue;
    const create = createFromInstruction({
      ix,
      tx: input.tx,
      signature,
      slot,
      accountKeys,
    });
    if (create && !createsByMint.has(create.mint))
      createsByMint.set(create.mint, create);
  }

  const eventTrades = tradesFromLogs({
    tx: input.tx,
    signature,
    slot,
    solUsd: input.solUsd,
    now,
    supplyUi,
  });
  const balanceTrades = tradesFromBalances({
    tx: input.tx,
    signature,
    slot,
    solUsd: input.solUsd,
    now,
    supplyUi,
  });
  const tradesById = new Map<string, ParsedPumpTrade>();
  for (const trade of eventTrades) tradesById.set(trade.id, trade);
  for (const trade of balanceTrades) {
    if (
      [...tradesById.values()].some(
        (existing) =>
          existing.mint === trade.mint &&
          existing.owner === trade.owner &&
          Math.abs(existing.tokenDeltaUi - trade.tokenDeltaUi) < 0.000001,
      )
    )
      continue;
    tradesById.set(trade.id, trade);
  }

  const completes: ParsedPumpTransaction["completes"] = [];
  for (const buffer of programDataBuffers(input.tx?.meta?.logMessages ?? [])) {
    const event = parsePumpEvent(buffer);
    if (event?.name === "CompleteEvent" && typeof event.data.mint === "string")
      completes.push({ mint: event.data.mint, signature, slot });
  }

  return {
    creates: [...createsByMint.values()],
    trades: [...tradesById.values()],
    completes,
  };
}

export function decodeBondingCurveAccount(buffer: Buffer): null | {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: string | null;
} {
  if (buffer.length < 49) return null;
  const virtualTokenReserves = buffer.readBigUInt64LE(8);
  const virtualSolReserves = buffer.readBigUInt64LE(16);
  const realTokenReserves = buffer.readBigUInt64LE(24);
  const realSolReserves = buffer.readBigUInt64LE(32);
  const tokenTotalSupply = buffer.readBigUInt64LE(40);
  const complete = buffer[48] !== 0;
  const creator =
    buffer.length >= 81 ? bs58.encode(buffer.subarray(49, 81)) : null;
  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
    creator,
  };
}

export function bondingCurveProgressPct(
  curve: { realTokenReserves: bigint; tokenTotalSupply?: bigint },
  reservedBaseUnits = 206_900_000_000_000n,
): number {
  const total = curve.tokenTotalSupply ?? 1_000_000_000_000_000n;
  const denominator = total - reservedBaseUnits;
  if (denominator <= 0n) return 0;
  const numerator = curve.realTokenReserves - reservedBaseUnits;
  const progress = 100 * (1 - Number(numerator) / Number(denominator));
  return Math.max(0, Math.min(100, progress));
}
