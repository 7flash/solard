import { recordWorkerError, upsertTerminalToken } from "../shared/db.js";
import type { IndexerConfig } from "./config.ts";
import { indexerMeasure, summarizeError, summarizeValue } from "./measure.ts";
import type { Counters, TokenMetadataPatch } from "./types.ts";

type QueueItem = {
  mint: string;
  uri: string;
  name?: string | null;
  symbol?: string | null;
};

const queue: QueueItem[] = [];

const queued = new Set<string>();

const seenAt = new Map<string, number>();
const METADATA_SEEN_TTL_MS = 30 * 60_000;
let nextSeenPruneAtMs = 0;

let workers = 0;

function pruneSeenAt(now = Date.now()): void {
  if (now < nextSeenPruneAtMs && seenAt.size < 5_000) return;
  const cutoff = now - METADATA_SEEN_TTL_MS;
  for (const [mint, atMs] of seenAt) {
    if (atMs < cutoff && !queued.has(mint)) seenAt.delete(mint);
  }
  nextSeenPruneAtMs = now + 5 * 60_000;
}

function normalizeUri(value: string | null | undefined): string | null {
  const uri = value?.trim();

  if (!uri) {
    return null;
  }

  if (uri.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${uri.slice("ipfs://".length)}`;
  }

  return /^https?:\/\//i.test(uri) ? uri : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function httpUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;

  const normalized = normalizeUri(raw);

  if (normalized) {
    return normalized;
  }

  if (/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(raw)) {
    return `https://${raw}`;
  }

  return null;
}

function socialUrl(
  kind: "twitter" | "telegram",
  value: unknown,
): string | null {
  const raw = text(value);
  if (!raw) return null;

  const direct = httpUrl(raw);

  if (direct) {
    return direct;
  }

  const handle = raw
    .replace(/^@/, "")
    .replace(/^(?:x|twitter|telegram|tg):/i, "")
    .trim();

  if (!/^[a-z0-9_]{2,64}$/i.test(handle)) {
    return null;
  }

  return kind === "twitter"
    ? `https://x.com/${handle}`
    : `https://t.me/${handle}`;
}

function objectValue(value: unknown, ...keys: string[]): unknown {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;

  for (const key of keys) {
    if (record[key] != null) {
      return record[key];
    }
  }

  return null;
}

async function fetchMetadata(uri: string, config: IndexerConfig): Promise<any> {
  const controller = new AbortController();

  const timer = setTimeout(() => controller.abort(), config.metadataTimeoutMs);

  try {
    const response = await fetch(uri, {
      signal: controller.signal,

      headers: {
        accept: "application/json,text/plain,*/*",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);

    if (contentLength > config.metadataMaxBytes) {
      throw new Error(`metadata too large: ${contentLength}`);
    }

    const body = await response.text();

    if (body.length > config.metadataMaxBytes) {
      throw new Error(`metadata too large: ${body.length}`);
    }

    return JSON.parse(body);
  } finally {
    clearTimeout(timer);
  }
}

function makePatch(item: QueueItem, data: any): TokenMetadataPatch {
  const extensions = data?.extensions ?? {};

  const links = data?.links ?? data?.content?.links ?? {};

  const socials =
    data?.socials ?? data?.social ?? data?.properties?.socials ?? {};

  return {
    mint: item.mint,

    uri: item.uri,

    name: text(data?.name) ?? item.name ?? null,

    symbol: text(data?.symbol) ?? item.symbol ?? null,

    image: httpUrl(
      data?.image ??
        data?.image_url ??
        data?.imageUrl ??
        links?.image ??
        data?.properties?.files?.[0]?.uri,
    ),

    description: text(data?.description),

    website: httpUrl(
      data?.website ??
        data?.external_url ??
        extensions?.website ??
        links?.external_url ??
        links?.website ??
        objectValue(socials, "website", "site"),
    ),

    twitter: socialUrl(
      "twitter",
      data?.twitter ??
        data?.x ??
        extensions?.twitter ??
        extensions?.x ??
        links?.twitter ??
        links?.x ??
        objectValue(socials, "twitter", "x"),
    ),

    telegram: socialUrl(
      "telegram",
      data?.telegram ??
        extensions?.telegram ??
        links?.telegram ??
        links?.tg ??
        objectValue(socials, "telegram", "tg"),
    ),
  };
}

async function consume(
  config: IndexerConfig,
  counters: Counters,
): Promise<void> {
  workers++;

  try {
    while (queue.length) {
      const item = queue.shift()!;

      queued.delete(item.mint);

      try {
        await indexerMeasure.measure(
          {
            start: () => `metadata:${item.mint.slice(0, 8)}`,

            end: summarizeValue,

            catch: summarizeError,
          },
          async () => {
            const data = await fetchMetadata(item.uri, config);

            const patch = makePatch(item, data);

            upsertTerminalToken({
              ...patch,
              source: "helius-indexer-metadata",
              updatedAtMs: Date.now(),
            });

            counters.metadataHydrated++;

            return {
              mint: item.mint,
              image: Boolean(patch.image),
            };
          },
        );
      } catch (error) {
        counters.metadataFailed++;

        recordWorkerError(config.name, error, {
          phase: "metadata",
          mint: item.mint,
          uri: item.uri,
        });
      }
    }
  } finally {
    workers--;

    if (queue.length) {
      pump(config, counters);
    }
  }
}

function pump(config: IndexerConfig, counters: Counters): void {
  const concurrency = Math.max(1, Math.trunc(config.metadataConcurrency));

  while (workers < concurrency && queue.length) {
    void consume(config, counters);
  }
}

export function startMetadataHydrator(
  config: IndexerConfig,
  counters: Counters,
): void {
  pump(config, counters);
}

export function enqueueMetadata(
  config: IndexerConfig,
  counters: Counters,
  input: QueueItem,
): void {
  if (!config.metadataFetch) {
    return;
  }

  const uri = normalizeUri(input.uri);

  if (!uri) {
    return;
  }

  const now = Date.now();
  pruneSeenAt(now);

  if (now - (seenAt.get(input.mint) ?? 0) < METADATA_SEEN_TTL_MS) {
    return;
  }

  if (queued.has(input.mint)) {
    return;
  }

  seenAt.set(input.mint, now);

  queued.add(input.mint);

  queue.push({
    ...input,
    uri,
  });

  counters.metadataQueued++;

  pump(config, counters);
}
