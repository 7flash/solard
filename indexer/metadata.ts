import type { TerminalDatabase } from "../shared/terminal-db.js";
import { mergeTokenMetadata, recordWorkerError } from "./db.js";
import { indexerMeasure, summarizeError, summarizeValue } from "./measure.js";
import type { Counters, TokenMetadataPatch } from "./types.js";
import type { IndexerConfig } from "./config.js";

type QueueItem = {
  mint: string;
  uri: string;
  name?: string | null;
  symbol?: string | null;
};

const queued = new Set<string>();
const seen = new Map<string, number>();
const queue: QueueItem[] = [];
let running = 0;
let started = false;

function normalizedUri(value: string | null | undefined): string | null {
  const uri = value?.trim();
  if (!uri) return null;
  if (uri.startsWith("ipfs://"))
    return `https://ipfs.io/ipfs/${uri.slice("ipfs://".length)}`;
  if (/^https?:\/\//i.test(uri)) return uri;
  return null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstUrl(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizedUri(text(value));
    if (normalized) return normalized;
  }
  return null;
}

function patchFromJson(
  mint: string,
  uri: string,
  data: any,
  fallback: Partial<TokenMetadataPatch>,
): TokenMetadataPatch {
  const extensions = data?.extensions ?? {};
  const links = data?.links ?? data?.content?.links ?? {};

  return {
    mint,
    uri,
    name: text(data?.name) ?? fallback.name ?? null,
    symbol: text(data?.symbol) ?? fallback.symbol ?? null,
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
    rawJson: JSON.stringify(data).slice(0, 16_000),
  };
}

async function fetchMetadata(uri: string, config: IndexerConfig): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.metadataTimeoutMs);
  try {
    const response = await fetch(uri, {
      signal: controller.signal,
      headers: { accept: "application/json,text/plain,*/*" },
    });
    if (!response.ok)
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength && contentLength > config.metadataMaxBytes)
      throw new Error(`metadata too large: ${contentLength}`);
    const text = await response.text();
    if (text.length > config.metadataMaxBytes)
      throw new Error(`metadata too large: ${text.length}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function worker(args: {
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
          start: () =>
            `metadata:hydrate mint=${item.mint.slice(0, 6)} uri=${item.uri.slice(0, 48)}`,
          end: (value) => summarizeValue(value),
          catch: summarizeError,
        },
        async () => {
          const data = await fetchMetadata(item.uri, args.config);
          const patch = patchFromJson(item.mint, item.uri, data, {
            name: item.name,
            symbol: item.symbol,
          });
          mergeTokenMetadata(args.db, patch);
          args.counters.metadataHydrated++;
          return {
            mint: item.mint,
            hasImage: Boolean(patch.image),
            hasSocials: Boolean(
              patch.website || patch.twitter || patch.telegram,
            ),
          };
        },
      );
    } catch (error) {
      args.counters.metadataFailed++;
      recordWorkerError(args.db, args.config.name, error, {
        phase: "metadata",
        mint: item.mint,
        uri: item.uri,
      });
    } finally {
      running--;
    }
  }
}

function pump(args: {
  db: TerminalDatabase;
  config: IndexerConfig;
  counters: Counters;
}): void {
  if (!started) return;
  while (
    running < Math.max(1, args.config.metadataConcurrency) &&
    queue.length
  ) {
    void worker(args).finally(() => {
      if (queue.length) pump(args);
    });
  }
}

export function startMetadataHydrator(args: {
  db: TerminalDatabase;
  config: IndexerConfig;
  counters: Counters;
}): void {
  if (started) return;
  started = true;
  pump(args);
}

export function enqueueMetadata(
  args: {
    db: TerminalDatabase;
    config: IndexerConfig;
    counters: Counters;
  },
  item: QueueItem,
): void {
  if (!args.config.metadataFetch) return;
  const uri = normalizedUri(item.uri);
  if (!uri) return;

  const now = Date.now();
  const last = seen.get(item.mint) ?? 0;
  if (now - last < 30 * 60_000) return;

  if (queued.has(item.mint)) return;
  queued.add(item.mint);
  seen.set(item.mint, now);
  queue.push({ ...item, uri });
  args.counters.metadataQueued++;
  pump(args);
}
