import bs58 from "bs58";

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const CREATE_D8 = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);
const CREATE_V2_D8 = Buffer.from([214, 144, 76, 236, 95, 139, 49, 180]);
const SOL_MINT = "So11111111111111111111111111111111111111112";
const BASE58_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type Raw = Record<string, unknown>;

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isPubkey(value: unknown): value is string {
  return typeof value === "string" && BASE58_PUBKEY_RE.test(value.trim());
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

function collectLoadedAddresses(tx: Raw, message: Raw): string[] {
  const fromMessage = (message as any).loadedAddresses;
  const fromMeta = (tx.meta as Raw | undefined as any)?.loadedAddresses;
  const source = fromMessage ?? fromMeta;
  const writable = Array.isArray(source?.writable)
    ? (source.writable.map(txAccountKey).filter(Boolean) as string[])
    : [];
  const readonly = Array.isArray(source?.readonly)
    ? (source.readonly.map(txAccountKey).filter(Boolean) as string[])
    : [];
  return [...writable, ...readonly];
}

function collectAccountKeys(tx: Raw, message: Raw): string[] {
  const accountKeys = Array.isArray(message.accountKeys)
    ? (message.accountKeys.map(txAccountKey).filter(Boolean) as string[])
    : [];
  return [...accountKeys, ...collectLoadedAddresses(tx, message)];
}

function accountAt(accounts: string[], index: number): string | null {
  return typeof accounts[index] === "string" ? accounts[index] : null;
}

function tokenBalanceMint(balance: unknown): string | null {
  const mint = clean((balance as Raw | undefined)?.mint);
  if (!mint || mint === SOL_MINT) return null;
  return isPubkey(mint) ? mint : null;
}

function mintsFromTokenBalances(tx: Raw): string[] {
  const meta = tx.meta as Raw | undefined;
  const post = Array.isArray(meta?.postTokenBalances)
    ? (meta!.postTokenBalances as unknown[])
    : [];
  const pre = Array.isArray(meta?.preTokenBalances)
    ? (meta!.preTokenBalances as unknown[])
    : [];
  const all = [...post, ...pre]
    .map(tokenBalanceMint)
    .filter(Boolean) as string[];
  return [...new Set(all)];
}

function choosePumpMint(tx: Raw, accounts: string[]): string | null {
  // The token balance mint is the safest source. Some create_v2 account layouts
  // differ, and using a hard-coded account index can accidentally pick a curve,
  // token account, or PDA. That later explodes getTokenLargestAccounts.
  const balanceMints = mintsFromTokenBalances(tx);
  const pumpMint = balanceMints.find((mint) => /pump$/i.test(mint));
  if (pumpMint) return pumpMint;
  if (balanceMints[0]) return balanceMints[0];
  const indexMint = accountAt(accounts, 0);
  return isPubkey(indexMint) ? indexMint : null;
}

function ixAccounts(ix: Raw, accountKeys: string[]): string[] {
  return Array.isArray(ix.accounts)
    ? (ix.accounts
        .map((account) =>
          typeof account === "number" ? accountKeys[account] : clean(account),
        )
        .filter(Boolean) as string[])
    : [];
}

function allInstructions(tx: Raw, message: Raw): Raw[] {
  const outer = Array.isArray(message.instructions)
    ? (message.instructions as Raw[])
    : [];
  const meta = tx.meta as Raw | undefined;
  const innerGroups = Array.isArray(meta?.innerInstructions)
    ? (meta!.innerInstructions as Raw[])
    : [];
  const inner = innerGroups.flatMap((group) =>
    Array.isArray((group as Raw).instructions)
      ? ((group as Raw).instructions as Raw[])
      : [],
  );
  return [...outer, ...inner];
}

export function findPumpCreateInTransaction(
  tx: Raw,
  signature: string,
): Raw | null {
  const transaction = (tx.transaction as Raw | undefined) ?? {};
  const message = ((transaction.message as Raw | undefined) ?? {}) as Raw;
  const accountKeys = collectAccountKeys(tx, message);
  const instructions = allInstructions(tx, message);
  for (const ix of instructions) {
    const programId =
      clean(ix.programId) ??
      (typeof ix.programIdIndex === "number"
        ? accountKeys[ix.programIdIndex]
        : null);
    if (programId !== PUMP_PROGRAM_ID) continue;
    const accounts = ixAccounts(ix, accountKeys);
    const decoded =
      typeof ix.data === "string" ? parsePumpCreateData(ix.data) : null;
    if (!decoded) continue;
    const user =
      accountAt(accounts, 7) ??
      accountAt(accounts, 5) ??
      accountAt(accounts, accounts.length - 1);
    const mint = choosePumpMint(tx, accounts);
    return {
      txType: "create",
      source: "helius-logs",
      signature,
      mint,
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
      parserAccounts: accounts,
      postTokenBalanceMints: mintsFromTokenBalances(tx),
    };
  }
  return null;
}
