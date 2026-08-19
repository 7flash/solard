import { PublicKey, type Connection } from "@solana/web3.js";
import { getTokenMetadata, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

import { createTraderSolard } from "../../presets/trader.ts";
import {
  first,
  parseArgs,
  pumpLaunchEnvironmentFromFlags,
  required,
  runPumpTokenLaunchFromArgs,
  type PumpTokenLaunchCliOptions,
  type PumpTokenLaunchCliResult,
} from "./token-launch-cli.ts";

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
  json: Record<string, unknown> | null;
};

export type PumpVampCliResult = {
  source: PumpVampSourceMetadata & {
    sourceAuthorityWallet: string;
    authorization: "pump-creator" | "metadata-update-authority";
  };
  launch: PumpTokenLaunchCliResult;
};

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\0/g, "").trim();
  return text || null;
}

function publicMetadataUrl(uri: string): string {
  const value = uri.trim();
  if (value.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${value.slice("ipfs://".length).replace(/^ipfs\//, "")}`;
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
    const response = await fetch(publicMetadataUrl(uri), {
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
    throw new Error(
      "Metaplex metadata account is truncated before a string length.",
    );
  }
  const length = data.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > data.length) {
    throw new Error("Metaplex metadata account is truncated inside a string.");
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
      `Metaplex metadata account ${metadataAddress.toBase58()} belongs to ${encodedMint.toBase58()}, not ${mint.toBase58()}.`,
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
      // Fall through to Metaplex for older or non-standard mints.
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
      `Could not resolve on-chain metadata for source mint ${mint.toBase58()}. ` +
        "Vamp supports Token-2022 metadata-pointer mints and legacy Metaplex metadata mints.",
    );
  }

  if (base.name.length > 32) {
    throw new Error(
      `Source token name is ${base.name.length} characters; Pump create_v2 allows at most 32.`,
    );
  }
  if (base.symbol.length > 13) {
    throw new Error(
      `Source token symbol is ${base.symbol.length} characters; Pump create_v2 allows at most 13.`,
    );
  }
  if (base.uri.length > 200) {
    throw new Error(
      `Source metadata URI is ${base.uri.length} characters; Pump create_v2 allows at most 200.`,
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
    json,
  };
}

function safeAlias(symbol: string, mint: string): string {
  const stem =
    symbol
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "token";
  return `vamp-${stem}-${mint.slice(0, 6).toLowerCase()}`;
}

function stripIdentityArgs(argv: string[]): string[] {
  const removed = new Set([
    "source-authority",
    "alias",
    "name",
    "symbol",
    "uri",
    "metadata",
    "image",
    "description",
    "website",
    "twitter",
    "telegram",
    "video",
    "show-name",
    "hide-name",
    "cashback",
  ]);

  const result: string[] = [];
  let sourcePositionalRemoved = false;

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) {
      if (!sourcePositionalRemoved) {
        sourcePositionalRemoved = true;
        continue;
      }
      result.push(item);
      continue;
    }

    const [key, inline] = item.slice(2).split("=", 2);
    if (!removed.has(key!)) {
      result.push(item);
      if (
        inline == null &&
        argv[index + 1] &&
        !argv[index + 1]!.startsWith("--")
      ) {
        result.push(argv[++index]!);
      }
      continue;
    }

    if (
      inline == null &&
      argv[index + 1] &&
      !argv[index + 1]!.startsWith("--")
    ) {
      index += 1;
    }
  }

  return result;
}

export async function runPumpVampFromArgs(
  argv: string[],
  options: PumpTokenLaunchCliOptions = {},
): Promise<PumpVampCliResult> {
  const { flags, positionals } = parseArgs(argv);
  if (positionals.length !== 1) {
    throw new Error(
      "Usage: slrd vamp <source-mint> --creator <wallet> [--source-authority <wallet>] " +
        "[--buy-plan <file>] [--submit-mode jito-bundle] [--live]",
    );
  }

  const sourceMint = new PublicKey(positionals[0]!).toBase58();
  const creator = required(flags, "creator");
  const sourceAuthorityRef = first(flags, "source-authority") ?? creator;
  const report = options.report ?? (() => {});
  const env = pumpLaunchEnvironmentFromFlags(flags);

  const slrd = createTraderSolard({ rpcUrl: env.rpcUrl });
  let source: PumpVampSourceMetadata;
  let authorization: "pump-creator" | "metadata-update-authority";

  try {
    source = await fetchPumpVampSourceMetadata(slrd.connection(), sourceMint);

    let pumpCreator: string | null = null;
    try {
      const token = await slrd.addToken(sourceMint);
      pumpCreator = token.creator ?? null;
    } catch {
      // Metadata-authority proof can still authorize the source.
    }

    const sourceAuthority = slrd
      .resolveWallet(sourceAuthorityRef)
      .address.toBase58();

    if (pumpCreator === sourceAuthority) {
      authorization = "pump-creator";
    } else if (source.updateAuthority === sourceAuthority) {
      authorization = "metadata-update-authority";
    } else {
      throw new Error(
        `Source-control verification failed for ${sourceMint}. ` +
          `Wallet ${sourceAuthority} is neither the resolved Pump creator ` +
          `(${pumpCreator ?? "unknown"}) nor the metadata update authority ` +
          `(${source.updateAuthority ?? "unknown"}).`,
      );
    }

    report("pump vamp source", {
      mint: source.mint,
      name: source.name,
      symbol: source.symbol,
      uri: source.uri,
      metadataKind: source.metadataKind,
      metadataJsonFetched: source.json != null,
      image: source.image,
      website: source.website,
      twitter: source.twitter,
      telegram: source.telegram,
      sourceAuthorityWallet: sourceAuthority,
      authorization,
      cashback: true,
    });
  } finally {
    slrd.close();
  }

  const alias = first(flags, "alias") ?? safeAlias(source.symbol, source.mint);

  const launchArgv = [
    ...stripIdentityArgs(argv),
    "--alias",
    alias,
    "--name",
    source.name,
    "--symbol",
    source.symbol,
    "--uri",
    source.uri,
    "--cashback",
  ];

  const launch = await runPumpTokenLaunchFromArgs(launchArgv, options);

  report("pump vamp result", {
    sourceMint: source.mint,
    newMint: launch.token.mint,
    alias,
    cashback: true,
    live: launch.live,
  });

  const sourceAuthorityWallet = sourceAuthorityRef;
  return {
    source: {
      ...source,
      sourceAuthorityWallet,
      authorization,
    },
    launch,
  };
}
