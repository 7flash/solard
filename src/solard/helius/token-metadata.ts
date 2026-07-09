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

function cacheKey(kind: string, value: string): string {
  return `${kind}:${value}`;
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
  if (!uri || !/^https?:\/\//i.test(uri)) return {};
  const key = cacheKey("uri", uri);
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
      const res = await fetch(uri, {
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
        image:
          typeof (json as any).image === "string" ? (json as any).image : null,
        description:
          typeof (json as any).description === "string"
            ? (json as any).description
            : null,
        ...readSocials(json),
      };
      cache.set(key, { expiresAtMs: Date.now() + 20 * 60_000, value });
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

function firstString(...values: unknown[]): string | undefined {
  for (const value of values)
    if (typeof value === "string" && value.trim()) return value.trim();
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
        name: firstString(metadata?.name, asset?.token_info?.symbol),
        symbol: firstString(asset?.token_info?.symbol, metadata?.symbol),
        image: firstString(links?.image, content?.files?.[0]?.uri) ?? null,
        description: firstString(metadata?.description) ?? null,
        website:
          firstString(links?.external_url, metadata?.external_url) ?? null,
        twitter:
          firstString(metadata?.twitter, metadata?.extensions?.twitter) ?? null,
        telegram:
          firstString(metadata?.telegram, metadata?.extensions?.telegram) ??
          null,
      };
      cache.set(key, { expiresAtMs: Date.now() + 20 * 60_000, value });
      return value;
    },
  );
}
