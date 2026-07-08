import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { openDatabase } from "../db/database.js";
import type { TokenRow } from "../db/schema.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MAX_NEW_TOKENS = 2_000;
const MAX_TRADES_PER_TOKEN = 2_000;
const MAX_SAMPLES_PER_TOKEN = 4_000;
const METADATA_ENRICH_LIMIT_MS = 4_000;

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
  creator?: string | null;
  signature?: string | null;
  bondingCurveKey?: string | null;
  associatedBondingCurve?: string | null;
  isMayhemMode?: boolean | null;
  quoteAsset?: string | null;
  quoteMint?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  lastTradeAtMs?: number | null;
  marketCapSol?: number | null;
  priceSolPerToken?: number | null;
  samples: PumpLiveSample[];
  trades: PumpLiveSample[];
  raw?: Record<string, unknown> | null;
};

export type TokenWatchGroup = {
  id: string;
  name: string;
  createdAtMs: number;
  updatedAtMs: number;
  tokens: string[];
};

export type PumpLiveVault = {
  version: 2;
  newTokens: PumpLiveToken[];
  watchGroups: TokenWatchGroup[];
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

function storePath(): string {
  return resolve(
    process.env.SOLWAL_PUMP_LIVE_STORE_PATH ||
      process.env.SOLWAL_WATCH_GROUPS_PATH ||
      process.env.SOWL_WATCH_GROUPS_PATH ||
      "./data/solwal-pump-live.json",
  );
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

function boolish(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number")
    return value === 1 ? true : value === 0 ? false : null;
  if (typeof value !== "string") return null;
  const cleanValue = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "mayhem"].includes(cleanValue)) return true;
  if (["false", "0", "no", "n", "normal", "standard"].includes(cleanValue))
    return false;
  return null;
}

function firstRaw(raw: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (raw[key] != null && raw[key] !== "") return raw[key];
  }
  return null;
}

function inferMayhemMode(
  raw: Record<string, unknown>,
  fallback?: boolean | null,
): boolean | null {
  const direct = firstRaw(raw, [
    "isMayhemMode",
    "mayhemMode",
    "mayhem",
    "isMayhem",
    "isMayhemLaunch",
    "isMayhemToken",
  ]);
  const parsed = boolish(direct);
  if (parsed != null) return parsed;
  const text = String(
    firstRaw(raw, [
      "mode",
      "launchMode",
      "curveType",
      "kind",
      "poolType",
      "tokenMode",
    ]) ?? "",
  ).toLowerCase();
  if (text.includes("mayhem")) return true;
  return fallback ?? null;
}

function inferQuoteMint(
  raw: Record<string, unknown>,
  fallback?: string | null,
): string | null {
  const value = clean(
    firstRaw(raw, [
      "quoteMint",
      "quote_mint",
      "quoteTokenMint",
      "quoteToken",
      "quote",
      "quoteAddress",
      "quoteCurrencyMint",
    ]),
  );
  return value ?? fallback ?? null;
}

function inferQuoteAsset(
  raw: Record<string, unknown>,
  quoteMint?: string | null,
  fallback?: string | null,
): string | null {
  const direct = clean(
    firstRaw(raw, [
      "quoteAsset",
      "quoteSymbol",
      "quoteCurrency",
      "quoteTokenSymbol",
      "quoteMintSymbol",
      "quoteTicker",
    ]),
  );
  const text = String(direct ?? quoteMint ?? "").toLowerCase();
  if (text.includes("usdc") || quoteMint === USDC_MINT) return "USDC";
  if (text.includes("sol") || quoteMint === SOL_MINT) return "SOL";
  return direct ?? fallback ?? "SOL";
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

function readVault(): PumpLiveVault {
  const path = storePath();
  if (!existsSync(path)) return { version: 2, newTokens: [], watchGroups: [] };
  const parsed = JSON.parse(
    readFileSync(path, "utf8"),
  ) as Partial<PumpLiveVault> & { groups?: Array<Record<string, unknown>> };
  // Migration from the earlier token-watch store shape.
  if (!Array.isArray(parsed.newTokens) && Array.isArray(parsed.groups)) {
    const tokens = new Map<string, PumpLiveToken>();
    const groups: TokenWatchGroup[] = [];
    for (const rawGroup of parsed.groups) {
      const tokenRefs: string[] = [];
      for (const rawToken of Array.isArray(rawGroup.tokens)
        ? (rawGroup.tokens as Array<Record<string, unknown>>)
        : []) {
        const mint = clean(rawToken.mint);
        if (!mint) continue;
        tokenRefs.push(mint);
        tokens.set(mint, {
          mint,
          name: clean(rawToken.name),
          symbol: clean(rawToken.symbol),
          creator: clean(rawToken.creator),
          uri: clean(rawToken.uri),
          signature: clean(rawToken.signature),
          createdAtMs: Number(rawToken.addedAtMs ?? Date.now()),
          updatedAtMs: Number(rawToken.updatedAtMs ?? Date.now()),
          marketCapSol: null,
          samples: Array.isArray(rawToken.samples)
            ? (rawToken.samples as PumpLiveSample[])
            : [],
          trades: [],
        });
      }
      groups.push({
        id: clean(rawGroup.id) ?? groupId(clean(rawGroup.name) ?? "main"),
        name: clean(rawGroup.name) ?? "main",
        createdAtMs: Number(rawGroup.createdAtMs ?? Date.now()),
        updatedAtMs: Number(rawGroup.updatedAtMs ?? Date.now()),
        tokens: tokenRefs,
      });
    }
    return { version: 2, newTokens: [...tokens.values()], watchGroups: groups };
  }
  return {
    version: 2,
    newTokens: Array.isArray(parsed.newTokens) ? parsed.newTokens : [],
    watchGroups: Array.isArray(parsed.watchGroups) ? parsed.watchGroups : [],
  };
}

function writeVault(vault: PumpLiveVault): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(vault, null, 2)}\n`, "utf8");
}

function findToken(
  vault: PumpLiveVault,
  mint: string,
): PumpLiveToken | undefined {
  return vault.newTokens.find((token) => token.mint === mint);
}

function upsertToken(vault: PumpLiveVault, mint: string): PumpLiveToken {
  let token = findToken(vault, mint);
  if (!token) {
    const now = Date.now();
    token = {
      mint,
      createdAtMs: now,
      updatedAtMs: now,
      samples: [],
      trades: [],
      marketCapSol: null,
    };
    vault.newTokens.unshift(token);
  }
  return token;
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
  return {
    ...token,
    samples,
    trades: [...(token.trades ?? [])].sort(
      (a, b) => b.capturedAtMs - a.capturedAtMs,
    ),
    lastMarketCapSol: token.marketCapSol ?? last?.marketCapSol ?? null,
    sma1m: sampleMarketCap(samples, 60_000, now),
    sma5m: sampleMarketCap(samples, 5 * 60_000, now),
    sma15m: sampleMarketCap(samples, 15 * 60_000, now),
    sma60m: sampleMarketCap(samples, 60 * 60_000, now),
  };
}

function writeTokenToDb(token: PumpLiveToken, sample?: PumpLiveSample): void {
  if (process.env.SOLWAL_PUMP_LIVE_DB === "0") return;
  try {
    const db = openDatabase();
    const existing = db.tokens.select().where({ mint: token.mint }).first() as
      TokenRow | undefined;
    const now = Date.now();
    const metadataJson = JSON.stringify({
      source: "pumpportal",
      name: token.name ?? null,
      symbol: token.symbol ?? null,
      description: token.description ?? null,
      image: token.image ?? null,
      uri: token.uri ?? null,
      bondingCurveKey: token.bondingCurveKey ?? null,
      associatedBondingCurve: token.associatedBondingCurve ?? null,
      isMayhemMode: token.isMayhemMode ?? null,
      quoteAsset: token.quoteAsset ?? null,
      quoteMint: token.quoteMint ?? null,
      lastPumpMarketCapSol: token.marketCapSol ?? null,
    });
    if (existing) {
      existing.name = token.name ?? existing.name;
      existing.symbol = token.symbol ?? existing.symbol;
      existing.creator = token.creator ?? existing.creator;
      existing.bondingCurve =
        token.bondingCurveKey ??
        token.associatedBondingCurve ??
        existing.bondingCurve;
      existing.venueHint =
        existing.venueHint === "unknown" ? "pump-curve" : existing.venueHint;
      existing.metadataJson = metadataJson;
      existing.updatedAtMs = now;
    } else {
      db.tokens.insert({
        mint: token.mint,
        name: token.name ?? null,
        symbol: token.symbol ?? null,
        decimals: 6,
        createKind: "unknown",
        creator: token.creator ?? null,
        quoteMint: SOL_MINT,
        quoteTokenProgram: null,
        baseTokenProgram: null,
        bondingCurve:
          token.bondingCurveKey ?? token.associatedBondingCurve ?? null,
        pool: null,
        sharingConfig: null,
        venueHint: "pump-curve",
        metadataJson,
        refreshedAtMs: null,
        createdAtMs: now,
        updatedAtMs: now,
      });
    }
    if (
      sample?.priceSolPerToken &&
      Number.isFinite(sample.priceSolPerToken) &&
      sample.priceSolPerToken > 0
    ) {
      db.priceSamples.insert({
        mint: token.mint,
        venue: "pumpportal",
        quoteMint: SOL_MINT,
        quoteKind: "native-sol",
        priceQuotePerToken: sample.priceSolPerToken,
        baseReserveRaw: null,
        quoteReserveRaw: null,
        capturedAtMs: sample.capturedAtMs,
      });
    }
  } catch {
    // The live terminal must not die because analytics persistence is unavailable.
  }
}

function ipfsGateway(value: string): string {
  if (value.startsWith("ipfs://"))
    return `https://ipfs.io/ipfs/${value.slice("ipfs://".length)}`;
  return value;
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
    if (!response.ok) return;
    const metadata = (await response.json()) as Record<string, unknown>;
    const vault = readVault();
    const token = findToken(vault, mint);
    if (!token) return;
    token.name = clean(metadata.name) ?? token.name ?? null;
    token.symbol = clean(metadata.symbol) ?? token.symbol ?? null;
    token.description =
      clean(metadata.description) ?? token.description ?? null;
    token.image = clean(metadata.image)
      ? ipfsGateway(clean(metadata.image)!)
      : (token.image ?? null);
    token.updatedAtMs = Date.now();
    writeVault(vault);
    writeTokenToDb(token);
  } catch {
    // best effort only
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizePumpNewToken(
  raw: Record<string, unknown>,
  seq?: number,
): PumpLiveTokenSummary | null {
  const mint = clean(raw.mint);
  if (!mint) return null;
  const now = Date.now();
  const vault = readVault();
  const token = upsertToken(vault, mint);
  token.name = clean(raw.name) ?? token.name ?? null;
  token.symbol = clean(raw.symbol) ?? token.symbol ?? null;
  token.uri = clean(raw.uri) ?? token.uri ?? null;
  token.creator =
    clean(raw.traderPublicKey) ??
    clean(raw.creator) ??
    clean(raw.user) ??
    token.creator ??
    null;
  token.signature =
    clean(raw.signature) ?? clean(raw.txSignature) ?? token.signature ?? null;
  token.bondingCurveKey =
    clean(raw.bondingCurveKey) ?? token.bondingCurveKey ?? null;
  token.associatedBondingCurve =
    clean(raw.associatedBondingCurve) ?? token.associatedBondingCurve ?? null;
  token.isMayhemMode = inferMayhemMode(raw, token.isMayhemMode ?? null);
  token.quoteMint = inferQuoteMint(raw, token.quoteMint ?? null);
  token.quoteAsset = inferQuoteAsset(
    raw,
    token.quoteMint,
    token.quoteAsset ?? null,
  );
  token.marketCapSol = num(raw.marketCapSol) ?? token.marketCapSol ?? null;
  token.updatedAtMs = now;
  token.raw = { ...raw, seq, receivedAt: new Date(now).toISOString() };
  if (token.marketCapSol != null) {
    token.samples.push({
      capturedAtMs: now,
      marketCapSol: token.marketCapSol,
      txType: clean(raw.txType) ?? "create",
      signature: token.signature ?? null,
      source: "new-token",
    });
    token.samples = token.samples.slice(-MAX_SAMPLES_PER_TOKEN);
  }
  vault.newTokens = [
    token,
    ...vault.newTokens.filter((item) => item.mint !== mint),
  ].slice(0, MAX_NEW_TOKENS);
  writeVault(vault);
  writeTokenToDb(token, token.samples[token.samples.length - 1]);
  if (token.uri && !token.image) void enrichTokenMetadata(mint, token.uri);
  return summarize(token, now);
}

export function recordPumpTrade(
  raw: Record<string, unknown>,
): PumpLiveTokenSummary | null {
  const mint = clean(raw.mint);
  if (!mint) return null;
  const now = Date.now();
  const vault = readVault();
  const token = upsertToken(vault, mint);
  token.name = clean(raw.name) ?? token.name ?? null;
  token.symbol = clean(raw.symbol) ?? token.symbol ?? null;
  token.creator =
    clean(raw.traderPublicKey) ?? clean(raw.creator) ?? token.creator ?? null;
  token.bondingCurveKey =
    clean(raw.bondingCurveKey) ?? token.bondingCurveKey ?? null;
  token.associatedBondingCurve =
    clean(raw.associatedBondingCurve) ?? token.associatedBondingCurve ?? null;
  token.isMayhemMode = inferMayhemMode(raw, token.isMayhemMode ?? null);
  token.quoteMint = inferQuoteMint(raw, token.quoteMint ?? null);
  token.quoteAsset = inferQuoteAsset(
    raw,
    token.quoteMint,
    token.quoteAsset ?? null,
  );
  const solAmount = num(raw.solAmount);
  const tokenAmount = num(raw.tokenAmount);
  const marketCapSol = num(raw.marketCapSol) ?? token.marketCapSol ?? null;
  const priceSolPerToken =
    solAmount != null && tokenAmount != null && tokenAmount > 0
      ? solAmount / tokenAmount
      : (token.priceSolPerToken ?? null);
  const sample: PumpLiveSample = {
    capturedAtMs: now,
    marketCapSol,
    priceSolPerToken,
    solAmount,
    tokenAmount,
    txType: clean(raw.txType) ?? clean(raw.type) ?? "trade",
    signature: clean(raw.signature) ?? clean(raw.txSignature),
    source: "token-trade",
  };
  token.marketCapSol = marketCapSol;
  token.priceSolPerToken = priceSolPerToken;
  token.lastTradeAtMs = now;
  token.updatedAtMs = now;
  token.samples.push(sample);
  token.samples = token.samples.slice(-MAX_SAMPLES_PER_TOKEN);
  token.trades.push(sample);
  token.trades = token.trades.slice(-MAX_TRADES_PER_TOKEN);
  vault.newTokens = [
    token,
    ...vault.newTokens.filter((item) => item.mint !== mint),
  ].slice(0, MAX_NEW_TOKENS);
  writeVault(vault);
  writeTokenToDb(token, sample);
  return summarize(token, now);
}

export function listPumpLiveState(): {
  newTokens: PumpLiveTokenSummary[];
  watchGroups: TokenWatchGroupSummary[];
  watchedMints: string[];
} {
  const vault = readVault();
  const now = Date.now();
  const byMint = new Map(vault.newTokens.map((token) => [token.mint, token]));
  const watchedMints = [
    ...new Set(vault.watchGroups.flatMap((group) => group.tokens)),
  ];
  return {
    newTokens: vault.newTokens.map((token) => summarize(token, now)),
    watchGroups: vault.watchGroups.map((group) => ({
      ...group,
      tokens: group.tokens.map((mint) =>
        summarize(
          byMint.get(mint) ?? {
            mint,
            createdAtMs: group.createdAtMs,
            updatedAtMs: group.updatedAtMs,
            samples: [],
            trades: [],
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
  const vault = readVault();
  let group = vault.watchGroups.find(
    (item) => item.name.toLowerCase() === name.toLowerCase(),
  );
  if (!group) {
    const now = Date.now();
    group = {
      id: groupId(name),
      name,
      createdAtMs: now,
      updatedAtMs: now,
      tokens: [],
    };
    vault.watchGroups.push(group);
    writeVault(vault);
  }
  return listPumpLiveState().watchGroups.find((item) => item.id === group!.id)!;
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
  source?: string | null;
  isMayhemMode?: boolean | null;
  quoteAsset?: string | null;
  quoteMint?: string | null;
}): TokenWatchGroupSummary {
  const mint = clean(args.mint);
  if (!mint) throw new Error("Token mint is required");
  const vault = readVault();
  let group = vault.watchGroups.find((item) => item.id === args.groupId);
  if (!group) {
    const now = Date.now();
    group = {
      id: args.groupId || "main",
      name: args.groupId || "main",
      createdAtMs: now,
      updatedAtMs: now,
      tokens: [],
    };
    vault.watchGroups.push(group);
  }
  const token = upsertToken(vault, mint);
  token.name = clean(args.name) ?? token.name ?? null;
  token.symbol = clean(args.symbol) ?? token.symbol ?? null;
  token.creator = clean(args.creator) ?? token.creator ?? null;
  token.uri = clean(args.uri) ?? token.uri ?? null;
  token.image = clean(args.image) ?? token.image ?? null;
  token.signature = clean(args.signature) ?? token.signature ?? null;
  token.isMayhemMode = args.isMayhemMode ?? token.isMayhemMode ?? null;
  token.quoteMint = clean(args.quoteMint) ?? token.quoteMint ?? null;
  token.quoteAsset =
    clean(args.quoteAsset) ??
    token.quoteAsset ??
    inferQuoteAsset({}, token.quoteMint, token.quoteAsset ?? null);
  token.updatedAtMs = Date.now();
  if (
    typeof args.marketCapSol === "number" &&
    Number.isFinite(args.marketCapSol)
  ) {
    token.marketCapSol = args.marketCapSol;
    token.samples.push({
      capturedAtMs: Date.now(),
      marketCapSol: args.marketCapSol,
      source: clean(args.source) ?? "manual",
    });
    token.samples = token.samples.slice(-MAX_SAMPLES_PER_TOKEN);
  }
  if (!group.tokens.includes(mint)) group.tokens.push(mint);
  group.updatedAtMs = Date.now();
  vault.newTokens = [
    token,
    ...vault.newTokens.filter((item) => item.mint !== mint),
  ].slice(0, MAX_NEW_TOKENS);
  writeVault(vault);
  writeTokenToDb(token, token.samples[token.samples.length - 1]);
  if (token.uri && !token.image) void enrichTokenMetadata(mint, token.uri);
  return listPumpLiveState().watchGroups.find((item) => item.id === group!.id)!;
}

export function removeTokenFromWatchGroup(
  groupId: string,
  mintInput: string,
): TokenWatchGroupSummary {
  const mint = clean(mintInput);
  if (!mint) throw new Error("Token mint is required");
  const vault = readVault();
  const group = vault.watchGroups.find((item) => item.id === groupId);
  if (!group) throw new Error(`Watch group not found: ${groupId}`);
  group.tokens = group.tokens.filter((item) => item !== mint);
  group.updatedAtMs = Date.now();
  writeVault(vault);
  return listPumpLiveState().watchGroups.find((item) => item.id === groupId)!;
}
