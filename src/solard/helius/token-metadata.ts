import { Buffer } from "node:buffer";
import { PublicKey } from "@solana/web3.js";
import { apiMeasure } from "../measure.js";

export type SolardTokenMetadata = {
  name?: string;
  symbol?: string;
  image?: string | null;
  description?: string | null;
  website?: string | null;
  twitter?: string | null;
  telegram?: string | null;
};

const cache = new Map<
  string,
  { expiresAtMs: number; value: SolardTokenMetadata }
>();

function normalizeMetadataUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (/^ipfs:\/\//i.test(text))
    return `https://ipfs.io/ipfs/${text.replace(/^ipfs:\/\//i, "")}`;
  if (/^ar:\/\//i.test(text))
    return `https://arweave.net/${text.replace(/^ar:\/\//i, "")}`;
  if (/^https?:\/\//i.test(text)) return text;
  return undefined;
}

function cacheKey(kind: string, value: string): string {
  return `${kind}:${value}`;
}

function hasUsefulMetadata(value: SolardTokenMetadata): boolean {
  return !!(
    value.name ||
    value.symbol ||
    value.image ||
    value.description ||
    value.website ||
    value.twitter ||
    value.telegram
  );
}

function metadataCacheTtl(value: SolardTokenMetadata): number {
  return hasUsefulMetadata(value)
    ? Number(process.env.SOLARD_METADATA_CACHE_MS ?? "1200000")
    : Number(process.env.SOLARD_EMPTY_METADATA_CACHE_MS ?? "15000");
}

function readSocials(
  json: any,
): Pick<SolardTokenMetadata, "website" | "twitter" | "telegram"> {
  const ext =
    json?.extensions && typeof json.extensions === "object"
      ? json.extensions
      : {};
  const website =
    typeof json?.website === "string"
      ? json.website
      : typeof ext.website === "string"
        ? ext.website
        : null;
  const twitter =
    typeof json?.twitter === "string"
      ? json.twitter
      : typeof ext.twitter === "string"
        ? ext.twitter
        : null;
  const telegram =
    typeof json?.telegram === "string"
      ? json.telegram
      : typeof ext.telegram === "string"
        ? ext.telegram
        : null;
  return { website, twitter, telegram };
}

export async function fetchUriMetadata(
  uri: string | null | undefined,
): Promise<SolardTokenMetadata> {
  const normalizedUri = normalizeMetadataUrl(uri);
  if (!normalizedUri) return {};
  const key = cacheKey("uri", normalizedUri);
  const hit = cache.get(key);
  if (hit && hit.expiresAtMs > Date.now()) return hit.value;
  return await apiMeasure.measure(
    {
      start: () => "fetch token uri metadata",
      end: (value) => ({
        image: !!value.image,
        name: value.name,
        symbol: value.symbol,
      }),
      catch: () => ({}),
    },
    async () => {
      const res = await fetch(normalizedUri, {
        headers: { accept: "application/json,text/plain;q=0.8,*/*;q=0.5" },
        signal: AbortSignal.timeout(
          Number(process.env.SOLARD_METADATA_TIMEOUT_MS ?? "3500"),
        ),
      });
      if (!res.ok) return {};
      const json = await res.json().catch(() => null);
      if (!json || typeof json !== "object") return {};
      const value: SolardTokenMetadata = {
        name:
          typeof (json as any).name === "string"
            ? (json as any).name
            : undefined,
        symbol:
          typeof (json as any).symbol === "string"
            ? (json as any).symbol
            : undefined,
        image: normalizeMetadataUrl((json as any).image) ?? null,
        description:
          typeof (json as any).description === "string"
            ? (json as any).description
            : null,
        ...readSocials(json),
      };
      cache.set(key, {
        expiresAtMs: Date.now() + metadataCacheTtl(value),
        value,
      });
      return value;
    },
  );
}

function heliusApiKey(): string | null {
  const explicit = process.env.HELIUS_API_KEY?.trim();
  if (explicit) return explicit;
  const fromUrl = (
    process.env.HELIUS_RPC_URL ||
    process.env.RPC_ENDPOINT ||
    ""
  ).match(/[?&]api-key=([^&]+)/)?.[1];
  return fromUrl ? decodeURIComponent(fromUrl) : null;
}

function heliusRpcUrl(): string | null {
  const url =
    process.env.HELIUS_RPC_URL?.trim() || process.env.RPC_ENDPOINT?.trim();
  if (url) return url;
  const key = heliusApiKey();
  return key
    ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`
    : null;
}

const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);

function readBorshString(
  buffer: Buffer,
  offset: number,
): { value: string; offset: number } | null {
  if (offset + 4 > buffer.length) return null;
  const len = buffer.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + len;
  if (len < 0 || len > 4096 || end > buffer.length) return null;
  return {
    value: buffer
      .subarray(start, end)
      .toString("utf8")
      .replace(/\u0000/g, "")
      .trim(),
    offset: end,
  };
}

function metadataPda(mint: string): string | null {
  try {
    const mintKey = new PublicKey(mint);
    const [pda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mintKey.toBuffer(),
      ],
      TOKEN_METADATA_PROGRAM_ID,
    );
    return pda.toBase58();
  } catch {
    return null;
  }
}

function decodeMetaplexMetadataAccount(buffer: Buffer): SolardTokenMetadata {
  // MetadataV1: key u8, updateAuthority pubkey, mint pubkey, then Data{name,symbol,uri,...}
  let offset = 1 + 32 + 32;
  const name = readBorshString(buffer, offset);
  if (!name) return {};
  offset = name.offset;
  const symbol = readBorshString(buffer, offset);
  if (!symbol) return {};
  offset = symbol.offset;
  const uri = readBorshString(buffer, offset);
  if (!uri) return {};
  return {
    name: cleanMetadataText(name.value),
    symbol: cleanMetadataText(symbol.value),
    image: null,
    website: normalizeMetadataUrl(uri.value) ?? null,
  };
}

function cleanMetadataText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\u0000/g, "").trim();
  if (
    !text ||
    text === "-" ||
    text.toLowerCase() === "token" ||
    text.toLowerCase() === "unknown"
  )
    return undefined;
  return text;
}

export async function fetchMetaplexTokenMetadata(
  mint: string,
): Promise<SolardTokenMetadata> {
  if (!mint) return {};
  const key = cacheKey("metaplex", mint);
  const hit = cache.get(key);
  if (hit && hit.expiresAtMs > Date.now()) return hit.value;
  const rpcUrl = heliusRpcUrl();
  const pda = metadataPda(mint);
  if (!rpcUrl || !pda) return {};
  return await apiMeasure.measure(
    {
      start: () => "fetch metaplex token metadata",
      end: (value) => ({
        image: !!value.image,
        name: value.name,
        symbol: value.symbol,
      }),
      catch: () => ({}),
    },
    async () => {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(
          Number(process.env.SOLARD_METAPLEX_METADATA_TIMEOUT_MS ?? "3500"),
        ),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "solard-metaplex-metadata",
          method: "getAccountInfo",
          params: [pda, { encoding: "base64", commitment: "confirmed" }],
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as any;
      const encoded = payload?.result?.value?.data?.[0];
      if (typeof encoded !== "string") return {};
      const decoded = decodeMetaplexMetadataAccount(
        Buffer.from(encoded, "base64"),
      );
      const uriMeta = await fetchUriMetadata(decoded.website ?? undefined);
      const value: SolardTokenMetadata = {
        ...decoded,
        ...uriMeta,
        name: uriMeta.name ?? decoded.name,
        symbol: uriMeta.symbol ?? decoded.symbol,
        image: uriMeta.image ?? decoded.image ?? null,
        website: uriMeta.website ?? decoded.website ?? null,
      };
      cache.set(key, {
        expiresAtMs: Date.now() + metadataCacheTtl(value),
        value,
      });
      return value;
    },
  );
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values)
    if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function firstUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    const url = normalizeMetadataUrl(value);
    if (url) return url;
  }
  return undefined;
}

export async function fetchHeliusAssetMetadata(
  mint: string,
): Promise<SolardTokenMetadata> {
  if (!mint) return {};
  const key = cacheKey("asset", mint);
  const hit = cache.get(key);
  if (hit && hit.expiresAtMs > Date.now()) return hit.value;
  const rpcUrl = heliusRpcUrl();
  if (!rpcUrl) return {};
  return await apiMeasure.measure(
    {
      start: () => "fetch helius asset metadata",
      end: (value) => ({
        image: !!value.image,
        name: value.name,
        symbol: value.symbol,
      }),
      catch: () => ({}),
    },
    async () => {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(
          Number(process.env.SOLARD_HELIUS_DAS_TIMEOUT_MS ?? "4500"),
        ),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "solard-get-asset",
          method: "getAsset",
          params: { id: mint },
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as any;
      const asset = payload?.result;
      const content = asset?.content ?? {};
      const metadata = content?.metadata ?? {};
      const links = content?.links ?? {};
      const value: SolardTokenMetadata = {
        name: firstString(
          metadata?.name,
          asset?.token_info?.name,
          asset?.token_info?.symbol,
        ),
        symbol: firstString(asset?.token_info?.symbol, metadata?.symbol),
        image:
          firstUrl(
            links?.image,
            content?.files?.[0]?.uri,
            content?.json_uri,
            metadata?.image,
          ) ?? null,
        description: firstString(metadata?.description) ?? null,
        website:
          firstString(links?.external_url, metadata?.external_url) ?? null,
        twitter:
          firstString(metadata?.twitter, metadata?.extensions?.twitter) ?? null,
        telegram:
          firstString(metadata?.telegram, metadata?.extensions?.telegram) ??
          null,
      };
      const fallback = hasUsefulMetadata(value)
        ? {}
        : await fetchMetaplexTokenMetadata(mint);
      const merged: SolardTokenMetadata = {
        ...fallback,
        ...value,
        name: value.name ?? fallback.name,
        symbol: value.symbol ?? fallback.symbol,
        image: value.image ?? fallback.image ?? null,
        description: value.description ?? fallback.description ?? null,
        website: value.website ?? fallback.website ?? null,
        twitter: value.twitter ?? fallback.twitter ?? null,
        telegram: value.telegram ?? fallback.telegram ?? null,
      };
      cache.set(key, {
        expiresAtMs: Date.now() + metadataCacheTtl(merged),
        value: merged,
      });
      return merged;
    },
  );
}
