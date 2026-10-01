import { getTokenMetadata, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type Commitment, type Connection } from "@solana/web3.js";

const METAPLEX_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);

export type TokenMetadataMode = false | "chain" | "full";
export type TokenMetadataKind = "token-2022" | "metaplex" | null;

export type TokenMetadata = {
  mint: string;
  name: string | null;
  symbol: string | null;
  uri: string | null;
  updateAuthority: string | null;
  kind: TokenMetadataKind;
  description: string | null;
  image: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  video: string | null;
  showName: boolean | null;
  json: Record<string, unknown> | null;
};

export type TokenMetadataHint = {
  name?: string | null;
  symbol?: string | null;
  uri?: string | null;
};

export type FetchTokenMetadataOptions = {
  mode?: Exclude<TokenMetadataMode, false>;
  commitment?: Commitment;
  timeoutMs?: number;
  hint?: TokenMetadataHint;
};

type ChainMetadata = Pick<
  TokenMetadata,
  "mint" | "name" | "symbol" | "uri" | "updateAuthority" | "kind"
>;

type TimedPromise<T> = {
  promise: Promise<T>;
  expiresAt: number;
};

const chainCache = new WeakMap<
  Connection,
  Map<string, TimedPromise<ChainMetadata | null>>
>();
const jsonCache = new Map<
  string,
  TimedPromise<Record<string, unknown> | null>
>();

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\0/g, "").trim();
  return text || null;
}

export function publicTokenMetadataUrl(uri: string): string {
  const value = uri.trim();
  if (value.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${value
      .slice("ipfs://".length)
      .replace(/^ipfs\//, "")}`;
  }
  if (value.startsWith("ar://")) {
    return `https://arweave.net/${value.slice("ar://".length)}`;
  }
  return value;
}

function readBorshString(
  data: Buffer,
  offset: number,
): { value: string; next: number } {
  if (offset + 4 > data.length)
    throw new Error("truncated metadata string length");
  const length = data.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > data.length) throw new Error("truncated metadata string");
  return {
    value: data.subarray(start, end).toString("utf8").replace(/\0/g, "").trim(),
    next: end,
  };
}

async function readMetaplexMetadata(
  connection: Connection,
  mint: PublicKey,
  commitment: Commitment,
): Promise<ChainMetadata | null> {
  const [metadataAddress] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METAPLEX_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    METAPLEX_TOKEN_METADATA_PROGRAM_ID,
  );
  const account = await connection.getAccountInfo(metadataAddress, commitment);
  if (!account || !account.owner.equals(METAPLEX_TOKEN_METADATA_PROGRAM_ID))
    return null;
  const data = Buffer.from(account.data);
  if (data.length < 65) return null;
  const updateAuthority = new PublicKey(data.subarray(1, 33)).toBase58();
  const encodedMint = new PublicKey(data.subarray(33, 65));
  if (!encodedMint.equals(mint)) return null;
  try {
    let cursor = 65;
    const name = readBorshString(data, cursor);
    cursor = name.next;
    const symbol = readBorshString(data, cursor);
    cursor = symbol.next;
    const uri = readBorshString(data, cursor);
    return {
      mint: mint.toBase58(),
      name: clean(name.value),
      symbol: clean(symbol.value),
      uri: clean(uri.value),
      updateAuthority,
      kind: "metaplex",
    };
  } catch {
    return null;
  }
}

async function readChainMetadata(
  connection: Connection,
  mint: PublicKey,
  commitment: Commitment,
): Promise<ChainMetadata | null> {
  const mintAccount = await connection.getAccountInfo(mint, commitment);
  if (!mintAccount) return null;
  if (mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    try {
      const metadata = await getTokenMetadata(
        connection,
        mint,
        commitment,
        TOKEN_2022_PROGRAM_ID,
      );
      if (metadata) {
        return {
          mint: mint.toBase58(),
          name: clean(metadata.name),
          symbol: clean(metadata.symbol),
          uri: clean(metadata.uri),
          updateAuthority: metadata.updateAuthority?.toBase58() ?? null,
          kind: "token-2022",
        };
      }
    } catch {
      // Some tokens still use a Metaplex metadata account.
    }
  }
  return await readMetaplexMetadata(connection, mint, commitment);
}

async function cachedChainMetadata(
  connection: Connection,
  mint: PublicKey,
  commitment: Commitment,
): Promise<ChainMetadata | null> {
  let cache = chainCache.get(connection);
  if (!cache) {
    cache = new Map();
    chainCache.set(connection, cache);
  }
  const key = `${commitment}:${mint.toBase58()}`;
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now())
    return await existing.promise;
  if (existing) cache.delete(key);
  const entry: TimedPromise<ChainMetadata | null> = {
    expiresAt: Number.POSITIVE_INFINITY,
    promise: Promise.resolve(null),
  };
  entry.promise = readChainMetadata(connection, mint, commitment).then(
    (value) => {
      if (value == null) entry.expiresAt = Date.now() + 30_000;
      return value;
    },
    (error) => {
      cache!.delete(key);
      throw error;
    },
  );
  cache.set(key, entry);
  return await entry.promise;
}

async function fetchMetadataJson(
  uri: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const publicUrl = publicTokenMetadataUrl(uri);
  const existing = jsonCache.get(publicUrl);
  if (existing && existing.expiresAt > Date.now())
    return await existing.promise;
  if (existing) jsonCache.delete(publicUrl);
  const entry: TimedPromise<Record<string, unknown> | null> = {
    expiresAt: Number.POSITIVE_INFINITY,
    promise: Promise.resolve(null),
  };
  entry.promise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(publicUrl, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        entry.expiresAt = Date.now() + 60_000;
        return null;
      }
      const value = await response.json();
      const parsed =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : null;
      if (parsed == null) entry.expiresAt = Date.now() + 60_000;
      return parsed;
    } catch {
      entry.expiresAt = Date.now() + 60_000;
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();
  jsonCache.set(publicUrl, entry);
  return await entry.promise;
}

function baseFromHint(
  mint: string,
  hint?: TokenMetadataHint,
): ChainMetadata | null {
  const name = clean(hint?.name);
  const symbol = clean(hint?.symbol);
  const uri = clean(hint?.uri);
  if (!name && !symbol && !uri) return null;
  return {
    mint,
    name,
    symbol,
    uri,
    updateAuthority: null,
    kind: null,
  };
}

/** Resolve normalized Token-2022/Metaplex metadata for a mint. */
export async function fetchTokenMetadata(
  connection: Connection,
  mintInput: string | PublicKey,
  options: FetchTokenMetadataOptions = {},
): Promise<TokenMetadata | null> {
  const mint =
    mintInput instanceof PublicKey ? mintInput : new PublicKey(mintInput);
  const mintText = mint.toBase58();
  const commitment = options.commitment ?? "confirmed";
  const mode = options.mode ?? "full";
  const chain = await cachedChainMetadata(connection, mint, commitment).catch(
    () => null,
  );
  const hinted = baseFromHint(mintText, options.hint);
  const base = chain
    ? {
        ...chain,
        name: chain.name ?? hinted?.name ?? null,
        symbol: chain.symbol ?? hinted?.symbol ?? null,
        uri: chain.uri ?? hinted?.uri ?? null,
      }
    : hinted;
  if (!base) return null;
  if (mode === "chain" || !base.uri) {
    return {
      ...base,
      description: null,
      image: null,
      website: null,
      twitter: null,
      telegram: null,
      video: null,
      showName: null,
      json: null,
    };
  }
  const json = await fetchMetadataJson(
    base.uri,
    Math.max(250, options.timeoutMs ?? 15_000),
  );
  return {
    ...base,
    description: clean(json?.description),
    image: clean(json?.image),
    website:
      clean(json?.website) ??
      clean(json?.external_url) ??
      clean(json?.externalUrl),
    twitter: clean(json?.twitter) ?? clean(json?.x),
    telegram: clean(json?.telegram) ?? clean(json?.tg),
    video: clean(json?.video),
    showName: typeof json?.showName === "boolean" ? json.showName : null,
    json,
  };
}
