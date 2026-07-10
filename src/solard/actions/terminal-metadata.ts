import {
  listTerminalTokensNeedingMetadata,
  upsertTerminalToken,
} from "../db/terminal-store.js";
import { fetchHeliusAssetMetadata, fetchUriMetadata } from "../helius/token-metadata.js";
import { createMeasure, summarizeForMeasure } from "../measure.js";

const metaMeasure = createMeasure("solard:terminal-metadata");
const attempted = new Map<string, number>();

function needsRetry(mint: string): boolean {
  const now = Date.now();
  const last = attempted.get(mint) ?? 0;
  const ttl = Number(process.env.SOLARD_METADATA_RETRY_MS ?? "120000");
  return now - last >= ttl;
}

function remember(mint: string): void {
  attempted.set(mint, Date.now());
  if (attempted.size <= 5000) return;
  const cutoff = Date.now() - Number(process.env.SOLARD_METADATA_RETRY_MS ?? "120000") * 4;
  for (const [key, value] of attempted) if (value < cutoff) attempted.delete(key);
}

function hasAnyMetadata(value: Record<string, unknown>): boolean {
  return ["name", "symbol", "image", "description", "website", "twitter", "telegram"].some((key) => {
    const item = value[key];
    return typeof item === "string" && item.trim().length > 0;
  });
}

export async function hydrateMissingTerminalMetadata(input: { limit?: number; timeoutMs?: number } = {}): Promise<{
  checked: number;
  hydrated: number;
  skipped: number;
}> {
  return await metaMeasure.measure(
    {
      start: () => "hydrate missing terminal metadata",
      end: (value) => ({ value: summarizeForMeasure(value) }),
      catch: (error) => ({ error: error instanceof Error ? error.message : String(error) }),
    },
    async () => {
      const rows = listTerminalTokensNeedingMetadata(input.limit ?? Number(process.env.SOLARD_METADATA_BACKFILL_LIMIT ?? "8"));
      let hydrated = 0;
      let skipped = 0;

      await Promise.all(rows.map(async (row) => {
        if (!needsRetry(row.mint)) {
          skipped++;
          return;
        }
        remember(row.mint);
        const [uriMeta, assetMeta] = await Promise.all([
          fetchUriMetadata(row.uri),
          fetchHeliusAssetMetadata(row.mint),
        ]);
        const merged = { ...assetMeta, ...uriMeta } as Record<string, unknown>;
        if (!hasAnyMetadata(merged)) {
          skipped++;
          return;
        }
        upsertTerminalToken({
          mint: row.mint,
          symbol: typeof merged.symbol === "string" ? merged.symbol : undefined,
          name: typeof merged.name === "string" ? merged.name : undefined,
          image: typeof merged.image === "string" ? merged.image : undefined,
          description: typeof merged.description === "string" ? merged.description : undefined,
          website: typeof merged.website === "string" ? merged.website : undefined,
          twitter: typeof merged.twitter === "string" ? merged.twitter : undefined,
          telegram: typeof merged.telegram === "string" ? merged.telegram : undefined,
          updatedAtMs: Date.now(),
        });
        hydrated++;
      }));

      return { checked: rows.length, hydrated, skipped };
    },
  );
}

export function triggerTerminalMetadataHydration(input: { limit?: number } = {}): void {
  void hydrateMissingTerminalMetadata(input).catch(() => undefined);
}
