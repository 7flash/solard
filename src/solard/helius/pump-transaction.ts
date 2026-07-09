import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import bs58 from "bs58";

export const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_CREATE_DISC = createHash("sha256")
  .update("global:create")
  .digest()
  .subarray(0, 8);

export type HeliusPumpCreate = {
  mint: string;
  signature: string;
  slot: number;
  name: string;
  symbol: string;
  uri: string | null;
  creator: string | null;
  bondingCurveKey: string | null;
};

export type HeliusPumpTrade = {
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
  creates: HeliusPumpCreate[];
  trades: HeliusPumpTrade[];
};

function asBase58(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof (value as { toBase58?: unknown }).toBase58 === "function")
    return (value as { toBase58: () => string }).toBase58();
  if (value && typeof (value as { toString?: unknown }).toString === "function")
    return String((value as { toString: () => string }).toString());
  return "";
}

function getSignature(tx: any, fallback = ""): string {
  return String(
    tx?.transaction?.signatures?.[0] ?? tx?.signature ?? fallback ?? "",
  );
}

function getAccountKeys(tx: any): string[] {
  const message = tx?.transaction?.message;
  if (!message) return [];
  if (typeof message.getAccountKeys === "function") {
    const keys = message.getAccountKeys();
    const staticKeys = Array.from(keys.staticAccountKeys ?? []).map(asBase58);
    const accountKeys = Array.from(keys.accountKeys ?? []).map(asBase58);
    const loadedWritable = Array.from(
      keys.accountKeysFromLookups?.writable ?? [],
    ).map(asBase58);
    const loadedReadonly = Array.from(
      keys.accountKeysFromLookups?.readonly ?? [],
    ).map(asBase58);
    return accountKeys.length
      ? accountKeys
      : [...staticKeys, ...loadedWritable, ...loadedReadonly];
  }
  const keys = Array.from(
    message.accountKeys ?? message.staticAccountKeys ?? [],
  ).map(asBase58);
  const loadedWritable = Array.from(
    tx?.meta?.loadedAddresses?.writable ??
      tx?.meta?.loadedWritableAddresses ??
      [],
  ).map(asBase58);
  const loadedReadonly = Array.from(
    tx?.meta?.loadedAddresses?.readonly ??
      tx?.meta?.loadedReadonlyAddresses ??
      [],
  ).map(asBase58);
  return [...keys, ...loadedWritable, ...loadedReadonly];
}

function getInstructions(tx: any): any[] {
  const message = tx?.transaction?.message;
  return Array.from(
    message?.compiledInstructions ?? message?.instructions ?? [],
  );
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

function instructionData(ix: any): Buffer {
  const data = ix?.data;
  if (!data) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.from(data);
  if (typeof data === "string") {
    try {
      // web3.js VersionedMessage compiled instruction data is usually base64-ish bytes by this point,
      // but older JSON RPC paths may return base58. Try base64 first because it is cheap and safe enough.
      const base64 = Buffer.from(data, "base64");
      if (base64.length >= 8) return base64;
    } catch {}
    try {
      const decoder = (bs58 as any).default ?? bs58;
      return Buffer.from(decoder.decode(data));
    } catch {}
  }
  return Buffer.alloc(0);
}

function readBorshString(
  buf: Buffer,
  offset: number,
): { value: string; offset: number } | null {
  if (offset + 4 > buf.length) return null;
  const len = buf.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + len;
  if (len > 2048 || end > buf.length) return null;
  return { value: buf.subarray(start, end).toString("utf8"), offset: end };
}

function parseCreateData(
  buf: Buffer,
): { name: string; symbol: string; uri: string | null } | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PUMP_CREATE_DISC))
    return null;
  let offset = 8;
  const name = readBorshString(buf, offset);
  if (!name) return { name: "", symbol: "", uri: null };
  offset = name.offset;
  const symbol = readBorshString(buf, offset);
  if (!symbol) return { name: name.value, symbol: "", uri: null };
  offset = symbol.offset;
  const uri = readBorshString(buf, offset);
  return { name: name.value, symbol: symbol.value, uri: uri?.value || null };
}

function aggregateTokenBalances(
  tokenBalances: any[] | undefined,
): Map<string, Map<string, { raw: bigint; decimals: number }>> {
  const out = new Map<string, Map<string, { raw: bigint; decimals: number }>>();
  for (const row of tokenBalances ?? []) {
    const mint = typeof row?.mint === "string" ? row.mint : "";
    const owner = typeof row?.owner === "string" ? row.owner : "";
    if (!mint || !owner) continue;
    const rawText = String(row?.uiTokenAmount?.amount ?? "0");
    let raw = 0n;
    try {
      raw = BigInt(rawText);
    } catch {
      raw = 0n;
    }
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

export function parsePumpTransaction(input: {
  tx: any;
  signature?: string;
  solUsd: number | null;
  supplyUi?: number;
  now?: number;
}): ParsedPumpTransaction {
  const tx = input.tx;
  const signature = getSignature(tx, input.signature);
  const slot = Number(tx?.slot ?? 0);
  const now = input.now ?? Date.now();
  const accountKeys = getAccountKeys(tx);
  const creates: HeliusPumpCreate[] = [];

  for (const ix of getInstructions(tx)) {
    if (instructionProgramId(ix, accountKeys) !== PUMPFUN_PROGRAM_ID) continue;
    const data = instructionData(ix);
    const create = parseCreateData(data);
    if (!create) continue;
    const accountIndexes = instructionAccountIndexes(ix);
    const accounts = accountIndexes
      .map((idx) => accountKeys[idx])
      .filter(Boolean);
    const mint = accounts[0] ?? "";
    if (!mint) continue;
    creates.push({
      mint,
      signature,
      slot,
      name: create.name,
      symbol: create.symbol,
      uri: create.uri,
      creator: accounts[7] ?? accounts[6] ?? null,
      bondingCurveKey: accounts[2] ?? accounts[1] ?? null,
    });
  }

  const pre = aggregateTokenBalances(tx?.meta?.preTokenBalances);
  const post = aggregateTokenBalances(tx?.meta?.postTokenBalances);
  const mints = new Set<string>(
    [...pre.keys(), ...post.keys()].filter((mint) => mint.endsWith("pump")),
  );
  for (const create of creates) mints.add(create.mint);

  const trades: HeliusPumpTrade[] = [];
  for (const mint of mints) {
    const owners = new Set<string>([
      ...(pre.get(mint)?.keys() ?? []),
      ...(post.get(mint)?.keys() ?? []),
    ]);
    for (const owner of owners) {
      const before = pre.get(mint)?.get(owner);
      const after = post.get(mint)?.get(owner);
      const decimals = after?.decimals ?? before?.decimals ?? 6;
      const beforeRaw = before?.raw ?? 0n;
      const afterRaw = after?.raw ?? 0n;
      const deltaRaw = afterRaw - beforeRaw;
      if (deltaRaw === 0n) continue;
      const tokenDeltaUi = Math.abs(ui(deltaRaw, decimals));
      if (!Number.isFinite(tokenDeltaUi) || tokenDeltaUi <= 0) continue;
      const solDelta = ownerSolDeltaLamports(tx, accountKeys, owner);
      const solDeltaUi =
        solDelta == null ? 0 : Math.abs(Number(solDelta) / 1_000_000_000);
      const priceSol = solDeltaUi > 0 ? solDeltaUi / tokenDeltaUi : null;
      const priceUsd =
        priceSol != null && input.solUsd != null
          ? priceSol * input.solUsd
          : null;
      const supplyUi = input.supplyUi ?? 1_000_000_000;
      const marketCapUsd = priceUsd != null ? priceUsd * supplyUi : null;
      trades.push({
        id: `${signature}:${mint}:${owner}`,
        mint,
        signature,
        slot,
        owner,
        side: deltaRaw > 0n ? "buy" : deltaRaw < 0n ? "sell" : "unknown",
        tokenDeltaUi,
        solDeltaUi,
        priceSol,
        priceUsd,
        marketCapUsd,
        createdAtMs: now,
        raw: { owner, deltaRaw: deltaRaw.toString(), source: "helius" },
      });
    }
  }

  return { creates, trades };
}
