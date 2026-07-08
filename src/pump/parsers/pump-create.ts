import bs58 from "bs58";

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const CREATE_D8 = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);
const CREATE_V2_D8 = Buffer.from([214, 144, 76, 236, 95, 139, 49, 180]);

type Raw = Record<string, unknown>;

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readString(
  buffer: Buffer,
  offset: number,
): { value: string; offset: number } | null {
  if (offset + 4 > buffer.length) return null;
  const length = buffer.readUInt32LE(offset);
  offset += 4;
  if (length > 2048 || offset + length > buffer.length) return null;
  const value = buffer.subarray(offset, offset + length).toString("utf8");
  return { value, offset: offset + length };
}

export function parsePumpCreateData(data: string): Partial<Raw> | null {
  let buffer: Buffer;
  try {
    buffer = Buffer.from(bs58.decode(data));
  } catch {
    return null;
  }
  if (buffer.length < 8) return null;
  const d8 = buffer.subarray(0, 8);
  const createKind = d8.equals(CREATE_V2_D8)
    ? "create_v2"
    : d8.equals(CREATE_D8)
      ? "create"
      : null;
  if (!createKind) return null;
  let offset = 8;
  const name = readString(buffer, offset);
  if (!name) return null;
  offset = name.offset;
  const symbol = readString(buffer, offset);
  if (!symbol) return null;
  offset = symbol.offset;
  const uri = readString(buffer, offset);
  if (!uri) return null;
  offset = uri.offset;
  const creator =
    offset + 32 <= buffer.length
      ? bs58.encode(buffer.subarray(offset, offset + 32))
      : null;
  if (creator) offset += 32;
  const mayhemMode = offset < buffer.length ? buffer[offset] === 1 : null;
  return {
    createKind,
    name: name.value,
    symbol: symbol.value,
    uri: uri.value,
    creator,
    isMayhemMode: mayhemMode,
  };
}

export function txAccountKey(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const pubkey = (value as { pubkey?: unknown }).pubkey;
    if (typeof pubkey === "string") return pubkey;
  }
  return null;
}

function collectAccountKeys(message: Raw): string[] {
  const accountKeys = Array.isArray(message.accountKeys)
    ? (message.accountKeys.map(txAccountKey).filter(Boolean) as string[])
    : [];
  const lookups = (message as any).loadedAddresses;
  const writable = Array.isArray(lookups?.writable)
    ? (lookups.writable.map(txAccountKey).filter(Boolean) as string[])
    : [];
  const readonly = Array.isArray(lookups?.readonly)
    ? (lookups.readonly.map(txAccountKey).filter(Boolean) as string[])
    : [];
  return [...accountKeys, ...writable, ...readonly];
}

function accountAt(accounts: string[], index: number): string | null {
  return typeof accounts[index] === "string" ? accounts[index] : null;
}

export function findPumpCreateInTransaction(
  tx: Raw,
  signature: string,
): Raw | null {
  const transaction = (tx.transaction as Raw | undefined) ?? {};
  const message = ((transaction.message as Raw | undefined) ?? {}) as Raw;
  const accountKeys = collectAccountKeys(message);
  const instructions = Array.isArray(message.instructions)
    ? (message.instructions as Raw[])
    : [];
  for (const ix of instructions) {
    const programId =
      clean(ix.programId) ??
      (typeof ix.programIdIndex === "number"
        ? accountKeys[ix.programIdIndex]
        : null);
    if (programId !== PUMP_PROGRAM_ID) continue;
    const accounts = Array.isArray(ix.accounts)
      ? (ix.accounts
          .map((account) =>
            typeof account === "number" ? accountKeys[account] : clean(account),
          )
          .filter(Boolean) as string[])
      : [];
    const decoded =
      typeof ix.data === "string" ? parsePumpCreateData(ix.data) : null;
    if (!decoded) continue;
    const user = accountAt(accounts, 7) ?? accountAt(accounts, 5);
    return {
      txType: "create",
      source: "helius-logs",
      signature,
      mint: accountAt(accounts, 0),
      creator: clean(decoded.creator) ?? user,
      traderPublicKey: clean(decoded.creator) ?? user,
      name: decoded.name,
      symbol: decoded.symbol,
      uri: decoded.uri,
      isMayhemMode: decoded.isMayhemMode,
      createKind: decoded.createKind,
      bondingCurveKey: accountAt(accounts, 2),
      associatedBondingCurve: accountAt(accounts, 3),
      quoteAsset: "SOL",
      rawTransactionSlot: tx.slot ?? null,
    };
  }
  return null;
}
