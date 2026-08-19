import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

import {
  createTraderSolard,
  fetchPumpVampSourceMetadata,
  publicPumpMetadataUrl,
  uploadPumpMetadata,
  type MetadataUploaderId,
  type PumpVampSourceMetadata,
} from "@solard/sdk";

import {
  first,
  parseArgs,
  runPumpTokenLaunchFromArgs,
  type PumpTokenLaunchCliOptions,
  type PumpTokenLaunchCliResult,
} from "./token-launch-cli.ts";

export type PumpVampCliResult = {
  source: PumpVampSourceMetadata;
  resolved: {
    alias: string;
    name: string;
    symbol: string;
    uri: string;
    metadataMode: "source-uri" | "override-uri" | "merged-upload";
    overrides: string[];
  };
  launch: PumpTokenLaunchCliResult;
};

function clean(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text && text !== "true" ? text : undefined;
}

function safeAlias(symbol: string, sourceMint: string): string {
  const stem =
    symbol
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "token";
  return `vamp-${stem}-${sourceMint.slice(0, 6).toLowerCase()}-${Date.now()
    .toString(36)
    .slice(-5)}`;
}

function isRemote(value: string): boolean {
  return /^(?:https?:\/\/|ipfs:\/\/|ar:\/\/)/i.test(value.trim());
}

function imageExtension(value: string): string {
  try {
    const pathname = new URL(publicPumpMetadataUrl(value)).pathname;
    const extension = extname(pathname);
    return extension && extension.length <= 8 ? extension : ".img";
  } catch {
    const extension = extname(value);
    return extension && extension.length <= 8 ? extension : ".img";
  }
}

async function downloadToTemp(
  value: string,
): Promise<{ path: string; cleanup: () => void }> {
  const directory = mkdtempSync(join(tmpdir(), "solard-vamp-"));
  const url = publicPumpMetadataUrl(value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(
        `Could not download vamp image (${response.status}) from ${url}`,
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length)
      throw new Error(`Downloaded vamp image is empty: ${url}`);
    const path = join(directory, `image${imageExtension(value)}`);
    writeFileSync(path, bytes);
    return {
      path,
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveImagePath(
  configured: string | undefined,
  sourceImage: string | null,
): Promise<{ path: string; cleanup: () => void }> {
  const selected = configured ?? sourceImage ?? undefined;
  if (!selected) {
    throw new Error(
      "Vamp metadata override requires an image. Source metadata has no image; provide --image <path-or-url>.",
    );
  }

  if (isRemote(selected)) return await downloadToTemp(selected);

  const path = resolve(selected);
  if (!existsSync(path)) {
    throw new Error(`Vamp image file not found: ${path}`);
  }
  return { path, cleanup: () => {} };
}

function stripVampArgs(argv: string[]): string[] {
  const handled = new Set([
    "source-authority", // legacy v1 flag: intentionally ignored now
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
  let sourceMintRemoved = false;

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) {
      if (!sourceMintRemoved) {
        sourceMintRemoved = true;
        continue;
      }
      result.push(item);
      continue;
    }

    const [key, inline] = item.slice(2).split("=", 2);
    if (!handled.has(key!)) {
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

function metadataProvider(
  flags: ReturnType<typeof parseArgs>["flags"],
): MetadataUploaderId {
  return (clean(first(flags, "metadata-provider")) ??
    clean(process.env.SLRD_METADATA_UPLOADER) ??
    clean(process.env.PUMP_METADATA_PROVIDER) ??
    "pump-frontend") as MetadataUploaderId;
}

export async function runPumpVampFromArgs(
  argv: string[],
  options: PumpTokenLaunchCliOptions = {},
): Promise<PumpVampCliResult> {
  const { flags, positionals } = parseArgs(argv);
  if (positionals.length !== 1) {
    throw new Error(
      "Usage: slrd vamp <source-mint> --creator <wallet> [metadata overrides] [launch flags]",
    );
  }
  if (first(flags, "metadata")) {
    throw new Error(
      "vamp does not accept --metadata <file>; override individual fields or provide --uri <metadata-uri>.",
    );
  }

  const sourceMint = positionals[0]!;
  const report = options.report ?? (() => {});
  const sourceSlrd = createTraderSolard();
  let source: PumpVampSourceMetadata;
  try {
    source = await fetchPumpVampSourceMetadata(
      sourceSlrd.connection(),
      sourceMint,
    );
  } finally {
    sourceSlrd.close();
  }

  const alias =
    clean(first(flags, "alias")) ?? safeAlias(source.symbol, source.mint);
  const name = clean(first(flags, "name")) ?? source.name;
  const symbol = clean(first(flags, "symbol")) ?? source.symbol;
  const explicitUri = clean(first(flags, "uri"));
  const image = clean(first(flags, "image"));
  const description = clean(first(flags, "description"));
  const website = clean(first(flags, "website"));
  const twitter = clean(first(flags, "twitter"));
  const telegram = clean(first(flags, "telegram"));
  const video = clean(first(flags, "video"));
  const showName = flags.has("hide-name")
    ? false
    : flags.has("show-name")
      ? first(flags, "show-name") !== "false"
      : (source.showName ?? true);

  const overrides = [
    ["alias", clean(first(flags, "alias"))],
    ["name", clean(first(flags, "name"))],
    ["symbol", clean(first(flags, "symbol"))],
    ["uri", explicitUri],
    ["image", image],
    ["description", description],
    ["website", website],
    ["twitter", twitter],
    ["telegram", telegram],
    ["video", video],
    [
      "showName",
      flags.has("show-name") || flags.has("hide-name") ? "set" : undefined,
    ],
  ]
    .filter(([, value]) => value != null)
    .map(([key]) => key!);

  const hasJsonFieldOverrides = Boolean(
    image ||
    description ||
    website ||
    twitter ||
    telegram ||
    video ||
    flags.has("show-name") ||
    flags.has("hide-name"),
  );
  const shouldMergeUpload =
    !explicitUri &&
    Boolean(
      clean(first(flags, "name")) ||
      clean(first(flags, "symbol")) ||
      hasJsonFieldOverrides,
    );

  if (explicitUri && hasJsonFieldOverrides) {
    throw new Error(
      "--uri already defines metadata JSON. Do not combine it with --image/--description/--website/--twitter/--telegram/--video/--show-name/--hide-name; put those fields in the supplied URI instead.",
    );
  }

  let uri = explicitUri ?? source.uri;
  let metadataMode: PumpVampCliResult["resolved"]["metadataMode"] = explicitUri
    ? "override-uri"
    : "source-uri";

  if (shouldMergeUpload) {
    const imageFile = await resolveImagePath(image, source.image);
    try {
      const uploaded = await uploadPumpMetadata(
        {
          imagePath: imageFile.path,
          name,
          symbol,
          description:
            description ?? source.description ?? `${name} (${symbol})`,
          website: website ?? source.website ?? undefined,
          twitter: twitter ?? source.twitter ?? undefined,
          telegram: telegram ?? source.telegram ?? undefined,
          video: video ?? source.video ?? undefined,
          showName,
        },
        {
          provider: metadataProvider(flags),
        },
      );
      uri = uploaded.metadataUri;
      metadataMode = "merged-upload";
      report("pump vamp metadata uploaded", {
        provider: uploaded.provider,
        metadataUri: uploaded.metadataUri,
        imageUri: uploaded.imageUri ?? null,
      });
    } finally {
      imageFile.cleanup();
    }
  }

  report("pump vamp source", {
    mint: source.mint,
    metadataKind: source.metadataKind,
    sourceName: source.name,
    sourceSymbol: source.symbol,
    sourceUri: source.uri,
    metadataJsonFetched: source.json != null,
  });
  report("pump vamp resolved", {
    alias,
    name,
    symbol,
    uri,
    metadataMode,
    overrides,
    cashback: true,
  });

  const launchArgv = [
    ...stripVampArgs(argv),
    "--alias",
    alias,
    "--name",
    name,
    "--symbol",
    symbol,
    "--uri",
    uri,
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

  return {
    source,
    resolved: {
      alias,
      name,
      symbol,
      uri,
      metadataMode,
      overrides,
    },
    launch,
  };
}
