import {
  dbWrite,
  insertTerminalTrade,
  recomputeTerminalIndicators,
  upsertTerminalToken,
} from "../db/terminal-store.js";
import {
  fetchHeliusAssetMetadata,
  fetchUriMetadata,
} from "./token-metadata.js";
import type { ParsedPumpTransaction } from "../pump/pump-parser.js";

function formatRaw(value: unknown): string {
  return JSON.stringify(value, (_, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

const tradeMetadataAttempts = new Map<string, number>();

function shouldHydrateTradeMint(mint: string): boolean {
  const now = Date.now();
  const last = tradeMetadataAttempts.get(mint) ?? 0;
  const ttl = Number(process.env.SOLARD_TRADE_METADATA_RETRY_MS ?? "120000");
  if (now - last < ttl) return false;
  tradeMetadataAttempts.set(mint, now);
  if (tradeMetadataAttempts.size > 5000) {
    for (const [key, value] of tradeMetadataAttempts)
      if (now - value > ttl * 4) tradeMetadataAttempts.delete(key);
  }
  return true;
}

function hasMetadata(value: Record<string, unknown>): boolean {
  return [
    "name",
    "symbol",
    "image",
    "description",
    "website",
    "twitter",
    "telegram",
  ].some((key) => {
    const item = value[key];
    return typeof item === "string" && item.trim().length > 0;
  });
}

async function hydrateTradeMint(mint: string): Promise<{ imaged: boolean }> {
  if (!shouldHydrateTradeMint(mint)) return { imaged: false };
  const assetMeta = await fetchHeliusAssetMetadata(mint);
  if (!hasMetadata(assetMeta as Record<string, unknown>))
    return { imaged: false };
  await dbWrite("hydrate_trade_mint", () =>
    upsertTerminalToken({
      mint,
      symbol: assetMeta.symbol,
      name: assetMeta.name,
      image: assetMeta.image ?? undefined,
      description: assetMeta.description ?? undefined,
      website: assetMeta.website ?? undefined,
      twitter: assetMeta.twitter ?? undefined,
      telegram: assetMeta.telegram ?? undefined,
      updatedAtMs: Date.now(),
    }),
  );
  return { imaged: !!assetMeta.image };
}

export async function applyParsedPumpTransaction(args: {
  parsed: ParsedPumpTransaction;
  source: string;
  confidence: "processed" | "confirmed" | "finalized" | "dropped";
  solUsd: number | null;
}): Promise<{
  tokens: number;
  trades: number;
  imaged: number;
  completes: number;
}> {
  let tokens = 0;
  let trades = 0;
  let imaged = 0;

  for (const create of args.parsed.creates) {
    const [uriMeta, assetMeta] = await Promise.all([
      fetchUriMetadata(create.uri),
      fetchHeliusAssetMetadata(create.mint),
    ]);
    const merged = { ...assetMeta, ...uriMeta };
    await dbWrite(`${args.source}_upsert_create`, () =>
      upsertTerminalToken({
        mint: create.mint,
        symbol: merged.symbol ?? create.symbol ?? "",
        name: merged.name ?? create.name ?? create.symbol ?? create.mint,
        image: merged.image ?? null,
        uri: create.uri,
        description: merged.description ?? null,
        website: merged.website ?? null,
        twitter: merged.twitter ?? null,
        telegram: merged.telegram ?? null,
        creator: create.creator,
        bondingCurveKey: create.bondingCurveKey,
        source: `${args.source}-create`,
        phase: "pump",
        isMayhemMode: create.isMayhemMode === true ? 1 : 0,
        supplyUi: 1_000_000_000,
        lastSlot: create.slot,
        signature: create.signature,
        updatedAtMs: Date.now(),
      }),
    );
    if (merged.image) imaged++;
    tokens++;
  }

  for (const trade of args.parsed.trades) {
    const marketCapSol =
      trade.priceSol != null ? trade.priceSol * 1_000_000_000 : null;
    const hydrated = await hydrateTradeMint(trade.mint).catch(() => ({
      imaged: false,
    }));
    if (hydrated.imaged) imaged++;
    await dbWrite(`${args.source}_insert_trade`, () =>
      insertTerminalTrade({
        id: trade.id,
        mint: trade.mint,
        signature: trade.signature,
        slot: trade.slot,
        owner: trade.owner,
        side: trade.side,
        tokenDeltaUi: trade.tokenDeltaUi,
        solDeltaUi: trade.solDeltaUi,
        priceSol: trade.priceSol,
        priceUsd: trade.priceUsd,
        marketCapUsd: trade.marketCapUsd,
        confidence: args.confidence,
        source: `${args.source}-trade`,
        rawJson: formatRaw(trade.raw),
        createdAtMs: trade.createdAtMs,
        updatedAtMs: Date.now(),
      }),
    );
    await dbWrite(`${args.source}_upsert_trade_token`, () =>
      upsertTerminalToken({
        mint: trade.mint,
        source: `${args.source}-trade`,
        priceSol: trade.priceSol ?? undefined,
        priceUsd: trade.priceUsd ?? undefined,
        marketCapSol: marketCapSol ?? undefined,
        marketCapUsd: trade.marketCapUsd ?? undefined,
        lastSlot: trade.slot,
        signature: trade.signature,
        updatedAtMs: Date.now(),
      }),
    );
    await dbWrite(`${args.source}_indicators`, () =>
      recomputeTerminalIndicators(trade.mint),
    );
    trades++;
  }

  for (const complete of args.parsed.completes ?? []) {
    await dbWrite(`${args.source}_complete`, () =>
      upsertTerminalToken({
        mint: complete.mint,
        source: `${args.source}-complete`,
        phase: "migrated",
        lastSlot: complete.slot,
        signature: complete.signature,
        updatedAtMs: Date.now(),
      }),
    );
  }

  return {
    tokens,
    trades,
    imaged,
    completes: args.parsed.completes?.length ?? 0,
  };
}
