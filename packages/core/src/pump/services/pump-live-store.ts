import { openDatabase } from "../../db/database.ts";
import type {
  PriceSampleRow,
  TokenRow,
  TokenWatchGroupRow,
  TokenWatchGroupTokenRow,
} from "../../db/schema.ts";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const MAX_NEW_TOKENS = 2_000;
const MAX_TRADES_PER_TOKEN = 2_000;
const MAX_SAMPLES_PER_TOKEN = 4_000;
const METADATA_ENRICH_LIMIT_MS = 4_000;
const TRADED_GROUP_ID = "traded";
const SESSION_GROUP_ID = "current-session";
const SESSION_GROUP_NAME = "Current session";
const TRADED_GROUP_NAME = "Tokens I traded";

export type PumpLiveSample = {
  capturedAtMs: number;
  marketCapSol: number | null;
  priceSolPerToken?: number | null;
  solAmount?: number | null;
  tokenAmount?: number | null;
  txType?: string | null;
  signature?: string | null;
  source?: string | null;
};

export type PumpLiveToken = {
  mint: string;
  name?: string | null;
  symbol?: string | null;
  description?: string | null;
  image?: string | null;
  uri?: string | null;
  website?: string | null;
  twitter?: string | null;
  telegram?: string | null;
  creator?: string | null;
  signature?: string | null;
  bondingCurveKey?: string | null;
  associatedBondingCurve?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  receivedAt?: string | null;
  lastTradeAtMs?: number | null;
  marketCapSol?: number | null;
  priceSolPerToken?: number | null;
  samples: PumpLiveSample[];
  trades: PumpLiveSample[];
  initialMarketCapSol?: number | null;
  marketCapChangeSol?: number | null;
  marketCapChangePct?: number | null;
  isMayhemMode?: boolean | null;
  quoteAsset?: string | null;
  quoteMint?: string | null;
  raw?: Record<string, unknown> | null;
};

export type TokenWatchGroup = {
  id: string;
  name: string;
  createdAtMs: number;
  updatedAtMs: number;
  tokens: string[];
};

export type PumpLiveTokenSummary = PumpLiveToken & {
  lastMarketCapSol: number | null;
  sma1m: number | null;
  sma5m: number | null;
  sma15m: number | null;
  sma60m: number | null;
};

export type TokenWatchGroupSummary = Omit<TokenWatchGroup, "tokens"> & {
  tokens: PumpLiveTokenSummary[];
};

type Db = ReturnType<typeof openDatabase>;

function db(): Db {
  return openDatabase();
}

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function curveMarket(raw: Record<string, unknown>): {
  marketCapSol: number | null;
  priceSolPerToken: number | null;
} {
  const vSol = num(raw.vSolInBondingCurve) ?? num(raw.virtualSolReservesSol);
  const vTokens =
    num(raw.vTokensInBondingCurve) ?? num(raw.virtualTokenReservesTokens);
  const supply = num(raw.tokenTotalSupply) ?? 1_000_000_000;
  if (
    vSol == null ||
    vTokens == null ||
    vTokens <= 0 ||
    supply == null ||
    supply <= 0
  )
    return { marketCapSol: null, priceSolPerToken: null };
  const priceSolPerToken = vSol / vTokens;
  const marketCapSol = priceSolPerToken * supply;
  return {
    priceSolPerToken: Number.isFinite(priceSolPerToken)
      ? priceSolPerToken
      : null,
    marketCapSol: Number.isFinite(marketCapSol) ? marketCapSol : null,
  };
}

function bool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) return true;
    if (["false", "0", "no"].includes(normalized)) return false;
  }
  return null;
}

function intEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function groupId(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || `group-${Date.now()}`
  );
}

function ensureTokenWatchGroup(
  groupIdInput: string,
  nameInput: string,
): TokenWatchGroup {
  const now = Date.now();
  const id = groupIdInput || groupId(nameInput);
  let row = db().tokenWatchGroups.select().where({ groupId: id }).first() as
    TokenWatchGroupRow | undefined;
  if (!row) {
    row = db().tokenWatchGroups.insert({
      groupId: id,
      name: nameInput,
      createdAtMs: now,
      updatedAtMs: now,
    }) as TokenWatchGroupRow;
  } else if (row.name !== nameInput) {
    row.name = nameInput;
    row.updatedAtMs = now;
  }
  return {
    id: row.groupId,
    name: row.name,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    tokens: [],
  };
}

function ensureDefaultGroups(): void {
  ensureTokenWatchGroup(SESSION_GROUP_ID, SESSION_GROUP_NAME);
  ensureTokenWatchGroup(TRADED_GROUP_ID, TRADED_GROUP_NAME);
}

function tokensForGroup(groupId: string): string[] {
  const rows = db()
    .tokenWatchGroupTokens.select()
    .where({ groupId })
    .orderBy("updatedAtMs", "desc")
    .all() as TokenWatchGroupTokenRow[];
  return [...new Set(rows.map((row) => row.mint).filter(Boolean))];
}

function readGroups(): TokenWatchGroup[] {
  ensureDefaultGroups();
  const rows = db()
    .tokenWatchGroups.select()
    .orderBy("updatedAtMs", "desc")
    .all() as TokenWatchGroupRow[];
  return rows.map((row) => ({
    id: row.groupId,
    name: row.name,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    tokens: tokensForGroup(row.groupId),
  }));
}

function touchGroup(groupId: string): void {
  const row = db().tokenWatchGroups.select().where({ groupId }).first() as
    TokenWatchGroupRow | undefined;
  if (row) row.updatedAtMs = Date.now();
}

function upsertGroupToken(groupId: string, mint: string): void {
  const now = Date.now();
  const existing = db()
    .tokenWatchGroupTokens.select()
    .where({ groupId, mint })
    .first() as TokenWatchGroupTokenRow | undefined;
  if (existing) existing.updatedAtMs = now;
  else
    db().tokenWatchGroupTokens.insert({
      groupId,
      mint,
      addedAtMs: now,
      updatedAtMs: now,
    });
  touchGroup(groupId);
}

function deleteGroupToken(groupId: string, mint: string): void {
  const existing = db()
    .tokenWatchGroupTokens.select()
    .where({ groupId, mint })
    .first() as TokenWatchGroupTokenRow | undefined;
  if (!existing) return;
  // sqlite-zod-orm row objects support delete through the table query API in most
  // runtimes, but direct row deletion is not guaranteed. Marking membership stale
  // by deleting through raw SQL keeps this table normalized without JSON state.
  const database = db() as unknown as {
    exec?: (sql: string, params?: unknown[]) => unknown;
    run?: (sql: string, params?: unknown[]) => unknown;
  };
  if (typeof database.exec === "function")
    database.exec(
      "delete from tokenWatchGroupTokens where groupId = ? and mint = ?",
      [groupId, mint],
    );
  else if (typeof database.run === "function")
    database.run(
      "delete from tokenWatchGroupTokens where groupId = ? and mint = ?",
      [groupId, mint],
    );
  else {
    existing.groupId = `removed:${groupId}:${Date.now()}`;
    existing.updatedAtMs = Date.now();
  }
  touchGroup(groupId);
}

function clearGroupTokens(groupId: string): void {
  const database = db() as unknown as {
    exec?: (sql: string, params?: unknown[]) => unknown;
    run?: (sql: string, params?: unknown[]) => unknown;
  };
  if (typeof database.exec === "function")
    database.exec("delete from tokenWatchGroupTokens where groupId = ?", [
      groupId,
    ]);
  else if (typeof database.run === "function")
    database.run("delete from tokenWatchGroupTokens where groupId = ?", [
      groupId,
    ]);
  else {
    const rows = db()
      .tokenWatchGroupTokens.select()
      .where({ groupId })
      .all() as TokenWatchGroupTokenRow[];
    for (const row of rows) {
      row.groupId = `removed:${groupId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      row.updatedAtMs = Date.now();
    }
  }
  touchGroup(groupId);
}

function tokenMetadata(row: TokenRow | undefined): Record<string, unknown> {
  try {
    return row?.metadataJson
      ? (JSON.parse(row.metadataJson) as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rawMetadata(row: TokenRow | undefined): Record<string, unknown> {
  const meta = tokenMetadata(row);
  return (meta.raw && typeof meta.raw === "object" ? meta.raw : {}) as Record<
    string,
    unknown
  >;
}

function toToken(row: TokenRow): PumpLiveToken {
  const meta = tokenMetadata(row);
  const raw = rawMetadata(row);
  const samples = samplesForMint(row.mint);
  const lastSample = samples[0];
  return {
    mint: row.mint,
    name: row.name ?? clean(meta.name) ?? null,
    symbol: row.symbol ?? clean(meta.symbol) ?? null,
    description: clean(meta.description) ?? null,
    image: clean(meta.image) ?? null,
    uri: clean(meta.uri) ?? null,
    website: clean(meta.website) ?? clean(raw.website) ?? null,
    twitter: clean(meta.twitter) ?? clean(raw.twitter) ?? null,
    telegram: clean(meta.telegram) ?? clean(raw.telegram) ?? null,
    creator:
      row.creator ??
      clean(meta.creator) ??
      clean(raw.creator) ??
      clean(raw.traderPublicKey) ??
      null,
    signature:
      clean(meta.signature) ??
      clean(raw.signature) ??
      clean(raw.txSignature) ??
      null,
    bondingCurveKey: clean(meta.bondingCurveKey) ?? row.bondingCurve ?? null,
    associatedBondingCurve: clean(meta.associatedBondingCurve) ?? null,
    createdAtMs: Number(meta.pumpCreatedAtMs ?? row.createdAtMs),
    updatedAtMs: Number(meta.pumpUpdatedAtMs ?? row.updatedAtMs),
    receivedAt:
      clean(meta.receivedAt) ??
      (row.updatedAtMs ? new Date(row.updatedAtMs).toISOString() : null),
    lastTradeAtMs: Number(meta.lastTradeAtMs ?? 0) || null,
    marketCapSol:
      num(meta.lastPumpMarketCapSol) ?? lastSample?.marketCapSol ?? null,
    priceSolPerToken:
      num(meta.priceSolPerToken) ?? lastSample?.priceSolPerToken ?? null,
    samples,
    trades: samples.slice(0, MAX_TRADES_PER_TOKEN),
    initialMarketCapSol: num(meta.initialPumpMarketCapSol),
    isMayhemMode: bool(meta.isMayhemMode) ?? bool(raw.isMayhemMode) ?? null,
    quoteAsset:
      clean(meta.quoteAsset) ??
      clean(raw.quoteAsset) ??
      clean(raw.quoteSymbol) ??
      "SOL",
    quoteMint: clean(meta.quoteMint) ?? clean(raw.quoteMint) ?? SOL_MINT,
    raw,
  };
}

function pumpRows(): TokenRow[] {
  const rows = db()
    .tokens.select()
    .orderBy("updatedAtMs", "desc")
    .limit(MAX_NEW_TOKENS * 2)
    .all() as TokenRow[];
  return rows
    .filter((row) => {
      const meta = tokenMetadata(row);
      return (
        row.venueHint === "pump-curve" ||
        meta.source === "pump-live" ||
        meta.source === "pumpportal" ||
        meta.source === "helius" ||
        meta.lastPumpMarketCapSol != null
      );
    })
    .slice(0, MAX_NEW_TOKENS);
}

function findTokenRow(mint: string): TokenRow | undefined {
  return db().tokens.select().where({ mint }).first() as TokenRow | undefined;
}

function upsertTokenRow(token: PumpLiveToken): TokenRow {
  const existing = findTokenRow(token.mint);
  const now = Date.now();
  const previous = tokenMetadata(existing);
  const metadataJson = JSON.stringify({
    ...previous,
    source: "pump-live",
    name: token.name ?? null,
    symbol: token.symbol ?? null,
    description: token.description ?? null,
    image: token.image ?? null,
    uri: token.uri ?? null,
    website: token.website ?? null,
    twitter: token.twitter ?? null,
    telegram: token.telegram ?? null,
    creator: token.creator ?? null,
    signature: token.signature ?? null,
    bondingCurveKey: token.bondingCurveKey ?? null,
    associatedBondingCurve: token.associatedBondingCurve ?? null,
    lastPumpMarketCapSol: token.marketCapSol ?? null,
    initialPumpMarketCapSol: token.initialMarketCapSol ?? null,
    priceSolPerToken: token.priceSolPerToken ?? null,
    isMayhemMode: token.isMayhemMode ?? null,
    quoteAsset: token.quoteAsset ?? null,
    quoteMint: token.quoteMint ?? null,
    pumpCreatedAtMs: token.createdAtMs,
    pumpUpdatedAtMs: now,
    lastTradeAtMs: token.lastTradeAtMs ?? null,
    receivedAt: token.receivedAt ?? null,
    raw: token.raw ?? previous.raw ?? null,
  });
  if (existing) {
    existing.name = token.name ?? existing.name;
    existing.symbol = token.symbol ?? existing.symbol;
    existing.creator = token.creator ?? existing.creator;
    existing.quoteMint = token.quoteMint ?? existing.quoteMint ?? SOL_MINT;
    existing.bondingCurve =
      token.bondingCurveKey ??
      token.associatedBondingCurve ??
      existing.bondingCurve;
    existing.venueHint = "pump-curve";
    existing.metadataJson = metadataJson;
    existing.updatedAtMs = now;
    return existing;
  }
  return db().tokens.insert({
    mint: token.mint,
    name: token.name ?? null,
    symbol: token.symbol ?? null,
    decimals: 6,
    createKind: "unknown",
    creator: token.creator ?? null,
    quoteMint: token.quoteMint ?? SOL_MINT,
    quoteTokenProgram: null,
    baseTokenProgram: null,
    bondingCurve: token.bondingCurveKey ?? token.associatedBondingCurve ?? null,
    pool: null,
    sharingConfig: null,
    venueHint: "pump-curve",
    metadataJson,
    refreshedAtMs: null,
    createdAtMs: token.createdAtMs,
    updatedAtMs: now,
  }) as TokenRow;
}

function samplesForMint(mint: string): PumpLiveSample[] {
  const rows = db()
    .priceSamples.select()
    .where({ mint })
    .orderBy("capturedAtMs", "desc")
    .limit(MAX_SAMPLES_PER_TOKEN)
    .all() as PriceSampleRow[];
  return rows
    .filter(
      (row) =>
        row.venue === "pump-live-mcap" ||
        row.venue === "pump-live" ||
        row.venue === "pumpportal" ||
        row.venue === "helius",
    )
    .map((row) => ({
      capturedAtMs: row.capturedAtMs,
      marketCapSol:
        row.venue === "pump-live-mcap" || row.venue === "pump-live"
          ? row.priceQuotePerToken
          : null,
      priceSolPerToken:
        row.venue === "pump-live-price" ? row.priceQuotePerToken : null,
      source: row.venue,
    }));
}

function recordPriceSample(
  token: PumpLiveToken,
  sample?: PumpLiveSample,
): void {
  if (!sample) return;
  const price = sample.marketCapSol ?? sample.priceSolPerToken ?? null;
  if (price == null || !Number.isFinite(price) || price <= 0) return;
  db().priceSamples.insert({
    mint: token.mint,
    venue: sample.marketCapSol != null ? "pump-live-mcap" : "pump-live-price",
    quoteMint: token.quoteMint ?? SOL_MINT,
    quoteKind: "native-sol",
    priceQuotePerToken: price,
    baseReserveRaw: null,
    quoteReserveRaw: null,
    capturedAtMs: sample.capturedAtMs,
  });
}

function sampleMarketCap(
  samples: PumpLiveSample[],
  periodMs: number,
  now = Date.now(),
): number | null {
  const values = samples
    .filter((sample) => sample.capturedAtMs >= now - periodMs)
    .map((sample) => sample.marketCapSol)
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    );
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function summarize(
  token: PumpLiveToken,
  now = Date.now(),
): PumpLiveTokenSummary {
  const samples = [...(token.samples ?? [])].sort(
    (a, b) => b.capturedAtMs - a.capturedAtMs,
  );
  const last = samples.find(
    (sample) =>
      typeof sample.marketCapSol === "number" &&
      Number.isFinite(sample.marketCapSol),
  );
  const first = [...samples]
    .reverse()
    .find(
      (sample) =>
        typeof sample.marketCapSol === "number" &&
        Number.isFinite(sample.marketCapSol),
    );
  const lastMarketCapSol = token.marketCapSol ?? last?.marketCapSol ?? null;
  const initialMarketCapSol =
    token.initialMarketCapSol ?? first?.marketCapSol ?? null;
  const marketCapChangeSol =
    lastMarketCapSol != null && initialMarketCapSol != null
      ? lastMarketCapSol - initialMarketCapSol
      : null;
  const marketCapChangePct =
    marketCapChangeSol != null &&
    initialMarketCapSol != null &&
    initialMarketCapSol > 0
      ? (marketCapChangeSol / initialMarketCapSol) * 100
      : null;
  return {
    ...token,
    initialMarketCapSol,
    marketCapChangeSol,
    marketCapChangePct,
    samples,
    trades: [...(token.trades ?? [])].sort(
      (a, b) => b.capturedAtMs - a.capturedAtMs,
    ),
    lastMarketCapSol,
    sma1m: sampleMarketCap(samples, 60_000, now),
    sma5m: sampleMarketCap(samples, 5 * 60_000, now),
    sma15m: sampleMarketCap(samples, 15 * 60_000, now),
    sma60m: sampleMarketCap(samples, 60 * 60_000, now),
  };
}

function ipfsGateway(value: string): string {
  if (value.startsWith("ipfs://"))
    return `https://ipfs.io/ipfs/${value.slice("ipfs://".length)}`;
  return value;
}

let metadataBackoffUntil = 0;
let metadataBusy = false;
const metadataQueue: Array<{ mint: string; uri: string }> = [];
const metadataQueued = new Set<string>();

function enqueueMetadataEnrichment(mint: string, uri: string): void {
  // Helius direct terminal stability: metadata/IPFS fetches are optional. On
  // Windows/Bun, gateway TLS failures have caused noisy toasts and have made
  // the live stream harder to debug. Keep social/image enrichment opt-in;
  // PumpPortal rows still carry socials/images when available.
  if (
    process.env.SOLARD_PUMP_METADATA_ENRICH !== "1" &&
    process.env.SOLWAL_PUMP_METADATA_ENRICH !== "1"
  )
    return;
  if (metadataQueued.has(mint)) return;
  const maxQueue = Math.max(1, intEnv("SOLWAL_PUMP_METADATA_QUEUE_MAX", 150));
  if (metadataQueue.length >= maxQueue) {
    const removed = metadataQueue.shift();
    if (removed) metadataQueued.delete(removed.mint);
  }
  metadataQueue.push({ mint, uri });
  metadataQueued.add(mint);
  void drainMetadataQueue();
}

async function drainMetadataQueue(): Promise<void> {
  if (metadataBusy) return;
  metadataBusy = true;
  try {
    while (metadataQueue.length > 0) {
      const waitMs = Math.max(0, metadataBackoffUntil - Date.now());
      if (waitMs > 0)
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      const item = metadataQueue.shift();
      if (!item) break;
      metadataQueued.delete(item.mint);
      await enrichTokenMetadata(item.mint, item.uri);
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(50, intEnv("SOLWAL_PUMP_METADATA_INTERVAL_MS", 750)),
        ),
      );
    }
  } finally {
    metadataBusy = false;
  }
}

async function enrichTokenMetadata(mint: string, uri: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    METADATA_ENRICH_LIMIT_MS,
  );
  try {
    const response = await fetch(ipfsGateway(uri), {
      signal: controller.signal,
    });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const retryMs =
        Number.isFinite(retryAfter) && retryAfter >= 0
          ? retryAfter * 1000
          : intEnv("SOLWAL_PUMP_METADATA_429_BACKOFF_MS", 10_000);
      metadataBackoffUntil = Date.now() + Math.max(1_000, retryMs);
      return;
    }
    if (!response.ok) return;
    const metadata = (await response.json()) as Record<string, unknown>;
    const existing = findTokenRow(mint);
    if (!existing) return;
    const token = toToken(existing);
    token.name = clean(metadata.name) ?? token.name ?? null;
    token.symbol = clean(metadata.symbol) ?? token.symbol ?? null;
    token.description =
      clean(metadata.description) ?? token.description ?? null;
    token.image = clean(metadata.image)
      ? ipfsGateway(clean(metadata.image)!)
      : (token.image ?? null);
    token.website =
      clean(metadata.website) ??
      clean(metadata.external_url) ??
      clean(metadata.externalUrl) ??
      token.website ??
      null;
    token.twitter =
      clean(metadata.twitter) ?? clean(metadata.x) ?? token.twitter ?? null;
    token.telegram =
      clean(metadata.telegram) ?? clean(metadata.tg) ?? token.telegram ?? null;
    upsertTokenRow(token);
  } catch {
    // best effort only
  } finally {
    clearTimeout(timeout);
  }
}

function tokenFromRaw(
  raw: Record<string, unknown>,
  existing?: PumpLiveToken,
  seq?: number,
): PumpLiveToken | null {
  const mint = clean(raw.mint);
  if (!mint) return null;
  const now = Date.now();
  const snapshot =
    raw.bondingCurveSnapshot && typeof raw.bondingCurveSnapshot === "object"
      ? (raw.bondingCurveSnapshot as Record<string, unknown>)
      : {};
  const curve = curveMarket(raw);
  const marketCapSol =
    num(raw.marketCapSol) ??
    num(snapshot.marketCapSol) ??
    curve.marketCapSol ??
    existing?.marketCapSol ??
    null;
  const priceSolPerToken =
    num(raw.priceSolPerToken) ??
    num(snapshot.priceSolPerToken) ??
    curve.priceSolPerToken ??
    existing?.priceSolPerToken ??
    null;
  return {
    mint,
    name: clean(raw.name) ?? existing?.name ?? null,
    symbol: clean(raw.symbol) ?? existing?.symbol ?? null,
    description: existing?.description ?? null,
    image: clean(raw.image) ?? existing?.image ?? null,
    uri: clean(raw.uri) ?? existing?.uri ?? null,
    website: clean(raw.website) ?? existing?.website ?? null,
    twitter: clean(raw.twitter) ?? existing?.twitter ?? null,
    telegram: clean(raw.telegram) ?? existing?.telegram ?? null,
    creator:
      clean(raw.traderPublicKey) ??
      clean(raw.creator) ??
      clean(raw.user) ??
      existing?.creator ??
      null,
    signature:
      clean(raw.signature) ??
      clean(raw.txSignature) ??
      existing?.signature ??
      null,
    bondingCurveKey:
      clean(raw.bondingCurveKey) ?? existing?.bondingCurveKey ?? null,
    associatedBondingCurve:
      clean(raw.associatedBondingCurve) ??
      existing?.associatedBondingCurve ??
      null,
    createdAtMs: existing?.createdAtMs ?? now,
    updatedAtMs: now,
    receivedAt: new Date(now).toISOString(),
    lastTradeAtMs: num(raw.blockTime)
      ? Number(raw.blockTime) * 1000
      : (existing?.lastTradeAtMs ?? null),
    marketCapSol,
    priceSolPerToken,
    samples: existing?.samples ?? [],
    trades: existing?.trades ?? [],
    initialMarketCapSol: existing?.initialMarketCapSol ?? marketCapSol,
    isMayhemMode:
      bool(raw.isMayhemMode) ??
      bool(raw.mayhemMode) ??
      existing?.isMayhemMode ??
      null,
    quoteAsset:
      clean(raw.quoteAsset) ??
      clean(raw.quoteSymbol) ??
      existing?.quoteAsset ??
      "SOL",
    quoteMint: clean(raw.quoteMint) ?? existing?.quoteMint ?? SOL_MINT,
    raw: { ...raw, seq, receivedAt: new Date(now).toISOString() },
  };
}

export function normalizePumpNewToken(
  raw: Record<string, unknown>,
  seq?: number,
): PumpLiveTokenSummary | null {
  const mint = clean(raw.mint);
  if (!mint) return null;
  const existingRow = findTokenRow(mint);
  const existing = existingRow ? toToken(existingRow) : undefined;
  const token = tokenFromRaw(raw, existing, seq);
  if (!token) return null;
  if (token.marketCapSol != null) {
    token.samples.unshift({
      capturedAtMs: Date.now(),
      marketCapSol: token.marketCapSol,
      txType: clean(raw.txType) ?? "create",
      signature: token.signature ?? null,
      source: "new-token",
    });
    token.samples = token.samples.slice(0, MAX_SAMPLES_PER_TOKEN);
  }
  upsertTokenRow(token);
  recordPriceSample(token, token.samples[0]);
  addMintToGroup(SESSION_GROUP_ID, SESSION_GROUP_NAME, token.mint);
  if (token.uri && !token.image)
    enqueueMetadataEnrichment(token.mint, token.uri);
  return summarize(token);
}

export function recordPumpTrade(
  raw: Record<string, unknown>,
): PumpLiveTokenSummary | null {
  const mint = clean(raw.mint);
  if (!mint) return null;
  const existingRow = findTokenRow(mint);
  const existing = existingRow ? toToken(existingRow) : undefined;
  const token = tokenFromRaw(raw, existing);
  if (!token) return null;
  const solAmount = num(raw.solAmount);
  const tokenAmount = num(raw.tokenAmount);
  const marketCapSol = num(raw.marketCapSol) ?? token.marketCapSol ?? null;
  const priceSolPerToken =
    solAmount != null && tokenAmount != null && tokenAmount > 0
      ? solAmount / tokenAmount
      : (token.priceSolPerToken ?? null);
  const sample: PumpLiveSample = {
    capturedAtMs: Date.now(),
    marketCapSol,
    priceSolPerToken,
    solAmount,
    tokenAmount,
    txType: clean(raw.txType) ?? clean(raw.type) ?? "trade",
    signature: clean(raw.signature) ?? clean(raw.txSignature),
    source: "token-trade",
  };
  const txType =
    sample.txType ?? clean(raw.txType) ?? clean(raw.type) ?? "trade";
  const isCurvePoll =
    txType === "curve-poll" || clean(raw.source) === "curve-poll";
  token.marketCapSol = marketCapSol;
  token.priceSolPerToken = priceSolPerToken;
  if (!isCurvePoll) token.lastTradeAtMs = sample.capturedAtMs;
  token.samples = [sample, ...(token.samples ?? [])].slice(
    0,
    MAX_SAMPLES_PER_TOKEN,
  );
  token.trades = isCurvePoll
    ? (token.trades ?? []).slice(0, MAX_TRADES_PER_TOKEN)
    : [sample, ...(token.trades ?? [])].slice(0, MAX_TRADES_PER_TOKEN);
  if (token.initialMarketCapSol == null && marketCapSol != null)
    token.initialMarketCapSol = marketCapSol;
  upsertTokenRow(token);
  recordPriceSample(token, sample);
  return summarize(token);
}

function addMintToGroup(
  groupIdInput: string,
  groupNameInput: string,
  mint: string,
): TokenWatchGroup {
  const group = ensureTokenWatchGroup(groupIdInput, groupNameInput);
  upsertGroupToken(group.id, mint);
  return {
    ...group,
    updatedAtMs: Date.now(),
    tokens: tokensForGroup(group.id),
  };
}

export function listPumpLiveState(): {
  newTokens: PumpLiveTokenSummary[];
  watchGroups: TokenWatchGroupSummary[];
  watchedMints: string[];
} {
  const now = Date.now();
  const tokens = pumpRows().map((row) => summarize(toToken(row), now));
  const byMint = new Map(tokens.map((token) => [token.mint, token]));
  const groups = readGroups();
  const watchedMints = [...new Set(groups.flatMap((group) => group.tokens))];
  return {
    newTokens: tokens,
    watchGroups: groups.map((group) => ({
      ...group,
      tokens: group.tokens.map(
        (mint) =>
          byMint.get(mint) ??
          summarize(
            {
              mint,
              createdAtMs: group.createdAtMs,
              updatedAtMs: group.updatedAtMs,
              samples: [],
              trades: [],
              marketCapSol: null,
            },
            now,
          ),
      ),
    })),
    watchedMints,
  };
}

export function listTokenWatchGroups(): TokenWatchGroupSummary[] {
  return listPumpLiveState().watchGroups;
}

export function createTokenWatchGroup(
  nameInput: string,
): TokenWatchGroupSummary {
  const name = clean(nameInput);
  if (!name) throw new Error("Watch group name is required");
  const existing = db().tokenWatchGroups.select().where({ name }).first() as
    TokenWatchGroupRow | undefined;
  const group = existing
    ? {
        id: existing.groupId,
        name: existing.name,
        createdAtMs: existing.createdAtMs,
        updatedAtMs: existing.updatedAtMs,
        tokens: tokensForGroup(existing.groupId),
      }
    : ensureTokenWatchGroup(groupId(name), name);
  return listPumpLiveState().watchGroups.find((item) => item.id === group.id)!;
}

export function addTokenToWatchGroup(args: {
  groupId: string;
  mint: string;
  name?: string | null;
  symbol?: string | null;
  creator?: string | null;
  uri?: string | null;
  image?: string | null;
  signature?: string | null;
  marketCapSol?: number | null;
  isMayhemMode?: boolean | null;
  quoteAsset?: string | null;
  quoteMint?: string | null;
  source?: string | null;
}): TokenWatchGroupSummary {
  const mint = clean(args.mint);
  if (!mint) throw new Error("Token mint is required");
  const existingRow = findTokenRow(mint);
  const existing = existingRow ? toToken(existingRow) : undefined;
  const token: PumpLiveToken = {
    mint,
    name: clean(args.name) ?? existing?.name ?? null,
    symbol: clean(args.symbol) ?? existing?.symbol ?? null,
    creator: clean(args.creator) ?? existing?.creator ?? null,
    uri: clean(args.uri) ?? existing?.uri ?? null,
    image: clean(args.image) ?? existing?.image ?? null,
    signature: clean(args.signature) ?? existing?.signature ?? null,
    createdAtMs: existing?.createdAtMs ?? Date.now(),
    updatedAtMs: Date.now(),
    receivedAt: existing?.receivedAt ?? new Date().toISOString(),
    marketCapSol:
      typeof args.marketCapSol === "number" &&
      Number.isFinite(args.marketCapSol)
        ? args.marketCapSol
        : (existing?.marketCapSol ?? null),
    initialMarketCapSol:
      existing?.initialMarketCapSol ??
      (typeof args.marketCapSol === "number" ? args.marketCapSol : null),
    isMayhemMode:
      typeof args.isMayhemMode === "boolean"
        ? args.isMayhemMode
        : (existing?.isMayhemMode ?? null),
    quoteAsset: clean(args.quoteAsset) ?? existing?.quoteAsset ?? "SOL",
    quoteMint: clean(args.quoteMint) ?? existing?.quoteMint ?? SOL_MINT,
    samples: existing?.samples ?? [],
    trades: existing?.trades ?? [],
    raw: existing?.raw ?? null,
  };
  if (
    typeof args.marketCapSol === "number" &&
    Number.isFinite(args.marketCapSol)
  ) {
    token.samples.unshift({
      capturedAtMs: Date.now(),
      marketCapSol: args.marketCapSol,
      source: clean(args.source) ?? "manual",
    });
  }
  upsertTokenRow(token);
  recordPriceSample(token, token.samples[0]);
  const group = ensureTokenWatchGroup(
    args.groupId || "main",
    args.groupId || "main",
  );
  upsertGroupToken(group.id, mint);
  if (token.uri && !token.image) enqueueMetadataEnrichment(mint, token.uri);
  return listPumpLiveState().watchGroups.find((item) => item.id === group.id)!;
}

export function addTokenToTradedGroup(
  args: Omit<Parameters<typeof addTokenToWatchGroup>[0], "groupId">,
): TokenWatchGroupSummary {
  return addTokenToWatchGroup({
    ...args,
    groupId: TRADED_GROUP_ID,
    source: args.source ?? "trade",
  });
}

export function clearCurrentSessionWatchGroup(): TokenWatchGroupSummary {
  ensureTokenWatchGroup(SESSION_GROUP_ID, SESSION_GROUP_NAME);
  clearGroupTokens(SESSION_GROUP_ID);
  return listPumpLiveState().watchGroups.find(
    (item) => item.id === SESSION_GROUP_ID,
  )!;
}

export function currentSessionWatchGroupId(): string {
  return SESSION_GROUP_ID;
}
export function tradedWatchGroupId(): string {
  return TRADED_GROUP_ID;
}

export function removeTokenFromWatchGroup(
  groupId: string,
  mintInput: string,
): TokenWatchGroupSummary {
  const mint = clean(mintInput);
  if (!mint) throw new Error("Token mint is required");
  const group = db().tokenWatchGroups.select().where({ groupId }).first() as
    TokenWatchGroupRow | undefined;
  if (!group) throw new Error(`Watch group not found: ${groupId}`);
  deleteGroupToken(groupId, mint);
  return listPumpLiveState().watchGroups.find((item) => item.id === groupId)!;
}
