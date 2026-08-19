import { getTokenMetadata, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";

const METAPLEX_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);

export type PumpVampSourceMetadata = {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  updateAuthority: string | null;
  metadataKind: "token-2022" | "metaplex";
  description: string | null;
  image: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  video: string | null;
  showName: boolean | null;
  json: Record<string, unknown> | null;
};

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\0/g, "").trim();
  return text || null;
}

export function publicPumpMetadataUrl(uri: string): string {
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

async function fetchMetadataJson(
  uri: string,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(publicPumpMetadataUrl(uri), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const value = await response.json();
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readBorshString(
  data: Buffer,
  offset: number,
): { value: string; next: number } {
  if (offset + 4 > data.length) {
    throw new Error("Metaplex metadata is truncated before a string length.");
  }
  const length = data.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > data.length) {
    throw new Error("Metaplex metadata is truncated inside a string.");
  }
  return {
    value: data.subarray(start, end).toString("utf8").replace(/\0/g, "").trim(),
    next: end,
  };
}

async function readMetaplexMetadata(
  connection: Connection,
  mint: PublicKey,
): Promise<{
  name: string;
  symbol: string;
  uri: string;
  updateAuthority: string;
} | null> {
  const [metadataAddress] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METAPLEX_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    METAPLEX_TOKEN_METADATA_PROGRAM_ID,
  );

  const account = await connection.getAccountInfo(metadataAddress, "confirmed");
  if (!account || !account.owner.equals(METAPLEX_TOKEN_METADATA_PROGRAM_ID)) {
    return null;
  }

  const data = Buffer.from(account.data);
  if (data.length < 65) {
    throw new Error(
      `Metaplex metadata account ${metadataAddress.toBase58()} is too short.`,
    );
  }

  const updateAuthority = new PublicKey(data.subarray(1, 33)).toBase58();
  const encodedMint = new PublicKey(data.subarray(33, 65));
  if (!encodedMint.equals(mint)) {
    throw new Error(
      `Metaplex metadata ${metadataAddress.toBase58()} belongs to ${encodedMint.toBase58()}, not ${mint.toBase58()}.`,
    );
  }

  let cursor = 65;
  const name = readBorshString(data, cursor);
  cursor = name.next;
  const symbol = readBorshString(data, cursor);
  cursor = symbol.next;
  const uri = readBorshString(data, cursor);

  if (!name.value || !symbol.value || !uri.value) {
    throw new Error(
      `Metaplex metadata for ${mint.toBase58()} is missing name, symbol, or URI.`,
    );
  }

  return {
    name: name.value,
    symbol: symbol.value,
    uri: uri.value,
    updateAuthority,
  };
}

export async function fetchPumpVampSourceMetadata(
  connection: Connection,
  sourceMint: string | PublicKey,
): Promise<PumpVampSourceMetadata> {
  const mint =
    sourceMint instanceof PublicKey ? sourceMint : new PublicKey(sourceMint);
  const mintAccount = await connection.getAccountInfo(mint, "confirmed");
  if (!mintAccount) {
    throw new Error(`Source mint does not exist: ${mint.toBase58()}`);
  }

  let base: {
    name: string;
    symbol: string;
    uri: string;
    updateAuthority: string | null;
    metadataKind: "token-2022" | "metaplex";
  } | null = null;

  if (mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    try {
      const metadata = await getTokenMetadata(
        connection,
        mint,
        "confirmed",
        TOKEN_2022_PROGRAM_ID,
      );
      if (metadata) {
        const name = clean(metadata.name);
        const symbol = clean(metadata.symbol);
        const uri = clean(metadata.uri);
        if (name && symbol && uri) {
          base = {
            name,
            symbol,
            uri,
            updateAuthority: metadata.updateAuthority?.toBase58() ?? null,
            metadataKind: "token-2022",
          };
        }
      }
    } catch {
      // Some Pump-era mints use Metaplex metadata instead.
    }
  }

  if (!base) {
    const metadata = await readMetaplexMetadata(connection, mint);
    if (metadata) {
      base = {
        ...metadata,
        metadataKind: "metaplex",
      };
    }
  }

  if (!base) {
    throw new Error(
      `Could not resolve Token-2022 or Metaplex metadata for source mint ${mint.toBase58()}.`,
    );
  }

  const json = await fetchMetadataJson(base.uri);

  return {
    mint: mint.toBase58(),
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
    showName:
      typeof json?.showName === "boolean" ? (json.showName as boolean) : null,
    json,
  };
}
