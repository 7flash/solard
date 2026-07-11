import type { TerminalDatabase } from "../shared/terminal-db.js";
import {
  recordWorkerError,
  upsertTerminalToken,
} from "../shared/terminal-repo.js";
import type { IndexerConfig } from "./config.js";
import { indexerMeasure, summarizeError, summarizeValue } from "./measure.js";
import type { Counters, TokenMetadataPatch } from "./types.js";

type QueueItem = {
  mint: string;
  uri: string;
  name?: string | null;
  symbol?: string | null;
};

const queue: QueueItem[] = [];
const queued = new Set<string>();
const seen = new Map<string, number>();
let running = 0;
let started = false;

function normalizeUri(value: string | null | undefined): string | null {
  const uri = value?.trim();
  if (!uri) return null;

  if (uri.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${uri.slice("ipfs://".length)}`;
  }

  return /^https?:\/\//i.test(uri) ? uri : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstUrl(...values: unknown[]): string | null {
  for (const value of values) {
    const result = normalizeUri(text(value));
    if (result) return result;
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

    const body = await response.text();
    if (body.length > config.metadataMaxBytes) {
      throw new Error(`metadata too large: ${body.length}`);
    }

    return JSON.parse(body);
  } finally {
    clearTimeout(timer);
  }
}

function metadataPatch(item: QueueItem, data: any): TokenMetadataPatch {
  const extensions = data?.extensions ?? {};
  const links = data?.links ?? data?.content?.links ?? {};

  return {
    mint: item.mint,
    uri: item.uri,
    name: text(data?.name) ?? item.name ?? null,
    symbol: text(data?.symbol) ?? item.symbol ?? null,
    image: firstUrl(data?.image, data?.image_url, data?.imageUrl, links?.image),
    description: text(data?.description),
    website: firstUrl(
      data?.website,
      data?.external_url,
      extensions?.website,
      links?.external_url,
    ),
    twitter: firstUrl(
      data?.twitter,
      data?.x,
      extensions?.twitter,
      links?.twitter,
    ),
    telegram: firstUrl(data?.telegram, extensions?.telegram, links?.telegram),
  };
}

async function consume(input: {
  db: TerminalDatabase;
  config: IndexerConfig;
  counters: Counters;
}): Promise<void> {
  while (queue.length) {
    const item = queue.shift()!;
    queued.delete(item.mint);
    running++;

    try {
      await indexerMeasure.measure(
        {
          start: () => `metadata:hydrate mint=${item.mint.slice(0, 6)}`,
          end: summarizeValue,
          catch: summarizeError,
        },
        async () => {
          const data = await fetchMetadata(item.uri, input.config);
          const patch = metadataPatch(item, data);

          upsertTerminalToken(
            {
              mint: patch.mint,
              name: patch.name,
              symbol: patch.symbol,
              image: patch.image,
              description: patch.description,
              website: patch.website,
              twitter: patch.twitter,
              telegram: patch.telegram,
              uri: patch.uri,
              updatedAtMs: Date.now(),
            },
            input.db,
          );

          input.counters.metadataHydrated++;

          return {
            mint: item.mint,
            hasImage: Boolean(patch.image),
          };
        },
      );
    } catch (error) {
      input.counters.metadataFailed++;
      recordWorkerError(
        input.config.name,
        error,
        {
          phase: "metadata",
          mint: item.mint,
          uri: item.uri,
        },
        input.db,
      );
    } finally {
      running--;
    }
  }
}

function pump(input: {
  db: TerminalDatabase;
  config: IndexerConfig;
  counters: Counters;
}): void {
  if (!started) return;

  while (
    running < Math.max(1, input.config.metadataConcurrency) &&
    queue.length
  ) {
    void consume(input).finally(() => {
      if (queue.length) pump(input);
    });
  }
}

export function startMetadataHydrator(input: {
  db: TerminalDatabase;
  config: IndexerConfig;
  counters: Counters;
}): void {
  started = true;
  pump(input);
}

export function enqueueMetadata(
  input: {
    db: TerminalDatabase;
    config: IndexerConfig;
    counters: Counters;
  },
  item: QueueItem,
): void {
  if (!input.config.metadataFetch) return;

  const uri = normalizeUri(item.uri);
  if (!uri) return;

  const now = Date.now();
  if (now - (seen.get(item.mint) ?? 0) < 30 * 60_000) {
    return;
  }
  if (queued.has(item.mint)) return;

  seen.set(item.mint, now);
  queued.add(item.mint);
  queue.push({ ...item, uri });
  input.counters.metadataQueued++;
  pump(input);
}
