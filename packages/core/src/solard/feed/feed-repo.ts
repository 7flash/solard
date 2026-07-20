import { openDatabase } from "../../db/database.ts";
import { convertSolMcapToUsd } from "../market/sol-usd.ts";
import type {
  PumpBalanceDeltaRow,
  PumpHolderCurrentRow,
  PumpPriceAggregateRow,
  PumpSwapRow,
  PumpTokenEventRow,
} from "../../db/schema.ts";

export type PumpFeedObservation = {
  eventType: "create" | "trade" | "curve-poll" | "metadata" | "unknown";
  source: string;
  token?: Record<string, unknown> | null;
  raw?: Record<string, unknown> | null;
};

export type ObservedHolder = {
  owner: string;
  label?: string | null;
  balanceRaw?: string | null;
  balanceUi?: number | null;
  pctSupply?: number | null;
  lastDeltaRaw?: string | null;
  lastDeltaUi?: number | null;
  lastSignature?: string | null;
  lastUpdatedMs: number;
};

export type PumpTerminalFeedRow = {
  mint: string;
  name?: string | null;
  symbol?: string | null;
  image?: string | null;
  uri?: string | null;
  website?: string | null;
  twitter?: string | null;
  telegram?: string | null;
  creator?: string | null;
  signature?: string | null;
  bondingCurveKey?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  receivedAt?: string | null;
  lastTradeAtMs?: number | null;
  marketCapSol?: number | null;
  lastMarketCapSol?: number | null;
  initialMarketCapSol?: number | null;
  marketCapChangeSol?: number | null;
  marketCapUsd?: number | null;
  lastMarketCapUsd?: number | null;
  initialMarketCapUsd?: number | null;
  marketCapChangeUsd?: number | null;
  solUsdPrice?: number | null;
  marketCapChangePct?: number | null;
  priceSolPerToken?: number | null;
  samples: Array<{
    capturedAtMs: number;
    marketCapSol: number | null;
    marketCapUsd?: number | null;
    priceSolPerToken?: number | null;
    source?: string | null;
  }>;
  trades: Array<{
    capturedAtMs: number;
    marketCapSol: number | null;
    marketCapUsd?: number | null;
    priceSolPerToken?: number | null;
    solAmount?: number | null;
    tokenAmount?: number | null;
    txType?: string | null;
    signature?: string | null;
    source?: string | null;
  }>;
  sma1m: number | null;
  sma5m: number | null;
  sma15m: number | null;
  sma1mUsd?: number | null;
  sma5mUsd?: number | null;
  sma15mUsd?: number | null;
  source?: string | null;
  eventType?: string | null;
  quoteAsset?: string | null;
  quoteMint?: string | null;
  raw?: Record<string, unknown> | null;
};

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const INTERVALS_SECONDS = [60, 300, 900];

function db() {
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
function boolSide(value: unknown): "buy" | "sell" | "unknown" {
  const s = String(value ?? "")
    .trim()
    .toLowerCase();
  if (s === "buy") return "buy";
  if (s === "sell") return "sell";
  return "unknown";
}
function json(value: unknown): string | null {
  try {
    return value == null ? null : JSON.stringify(value);
  } catch {
    return null;
  }
}
function tokenValue(observation: PumpFeedObservation, key: string): unknown {
  return (
    (observation.token && observation.token[key]) ??
    (observation.raw && observation.raw[key])
  );
}
function likelyPubkey(value: string | null | undefined): value is string {
  return !!value && SOLANA_PUBKEY_RE.test(value);
}

function safeParseJson(
  value: string | null | undefined,
): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function latestPumpAggregateRows(mint: string): PumpPriceAggregateRow[] {
  return db()
    .pumpPriceAggregates.select()
    .where({ mint })
    .orderBy("bucketStartMs", "desc")
    .limit(24)
    .all() as PumpPriceAggregateRow[];
}

function latestPumpSwaps(mint: string, limit = 50): PumpSwapRow[] {
  return db()
    .pumpSwaps.select()
    .where({ mint })
    .orderBy("createdAtMs", "desc")
    .limit(Math.max(1, Math.min(200, limit)))
    .all() as PumpSwapRow[];
}

function mcapUsd(
  value: number | null | undefined,
  solUsdPrice: number | null | undefined,
): number | null {
  return convertSolMcapToUsd(value, solUsdPrice);
}

export function latestPumpAggregates(mint: string): {
  sma1m: number | null;
  sma5m: number | null;
  sma15m: number | null;
  sma1mUsd?: number | null;
  sma5mUsd?: number | null;
  sma15mUsd?: number | null;
} {
  const rows = db()
    .pumpPriceAggregates.select()
    .where({ mint })
    .orderBy("bucketStartMs", "desc")
    .limit(20)
    .all() as PumpPriceAggregateRow[];
  const latestFor = (intervalSeconds: number) =>
    rows.find((row) => row.intervalSeconds === intervalSeconds)
      ?.smaMarketCapSol ?? null;
  return {
    sma1m: latestFor(60),
    sma5m: latestFor(300),
    sma15m: latestFor(900),
  };
}

function upsertTokenEvent(
  observation: PumpFeedObservation,
): PumpTokenEventRow | null {
  const mint = clean(tokenValue(observation, "mint"));
  if (!likelyPubkey(mint)) return null;
  const now = Date.now();
  const existing = db().pumpTokenEvents.select().where({ mint }).first() as
    PumpTokenEventRow | undefined;
  const marketCapSol =
    num(tokenValue(observation, "marketCapSol")) ??
    num(tokenValue(observation, "lastMarketCapSol"));
  const priceSolPerToken = num(tokenValue(observation, "priceSolPerToken"));
  const next = {
    mint,
    signature:
      clean(tokenValue(observation, "signature")) ??
      clean(tokenValue(observation, "txSignature")) ??
      existing?.signature ??
      null,
    source: observation.source,
    eventType: observation.eventType,
    name: clean(tokenValue(observation, "name")) ?? existing?.name ?? null,
    symbol:
      clean(tokenValue(observation, "symbol")) ?? existing?.symbol ?? null,
    creator:
      clean(tokenValue(observation, "creator")) ??
      clean(tokenValue(observation, "traderPublicKey")) ??
      existing?.creator ??
      null,
    uri: clean(tokenValue(observation, "uri")) ?? existing?.uri ?? null,
    image: clean(tokenValue(observation, "image")) ?? existing?.image ?? null,
    website:
      clean(tokenValue(observation, "website")) ?? existing?.website ?? null,
    twitter:
      clean(tokenValue(observation, "twitter")) ?? existing?.twitter ?? null,
    telegram:
      clean(tokenValue(observation, "telegram")) ?? existing?.telegram ?? null,
    bondingCurve:
      clean(tokenValue(observation, "bondingCurveKey")) ??
      clean(tokenValue(observation, "bondingCurve")) ??
      existing?.bondingCurve ??
      null,
    marketCapSol: marketCapSol ?? existing?.marketCapSol ?? null,
    priceSolPerToken: priceSolPerToken ?? existing?.priceSolPerToken ?? null,
    initialMarketCapSol: existing?.initialMarketCapSol ?? marketCapSol ?? null,
    lastTradeAtMs:
      observation.eventType === "trade" ||
      observation.eventType === "curve-poll"
        ? now
        : (existing?.lastTradeAtMs ?? null),
    rawJson: json({
      raw: observation.raw ?? null,
      token: observation.token ?? null,
    }),
    createdAtMs: existing?.createdAtMs ?? now,
    updatedAtMs: now,
  } satisfies Omit<PumpTokenEventRow, "id">;
  if (existing) {
    Object.assign(existing, next);
    return existing;
  }
  return db().pumpTokenEvents.insert(next) as PumpTokenEventRow;
}

function upsertPriceAggregate(
  mint: string,
  marketCapSol: number,
  now = Date.now(),
): void {
  if (!Number.isFinite(marketCapSol) || marketCapSol <= 0) return;
  for (const intervalSeconds of INTERVALS_SECONDS) {
    const intervalMs = intervalSeconds * 1000;
    const bucketStartMs = Math.floor(now / intervalMs) * intervalMs;
    const existing = db()
      .pumpPriceAggregates.select()
      .where({ mint, intervalSeconds, bucketStartMs })
      .first() as PumpPriceAggregateRow | undefined;
    if (existing) {
      existing.sampleCount += 1;
      existing.sumMarketCapSol += marketCapSol;
      existing.smaMarketCapSol =
        existing.sumMarketCapSol / existing.sampleCount;
      existing.lastMarketCapSol = marketCapSol;
      existing.updatedAtMs = now;
    } else {
      db().pumpPriceAggregates.insert({
        mint,
        intervalSeconds,
        bucketStartMs,
        smaMarketCapSol: marketCapSol,
        sampleCount: 1,
        sumMarketCapSol: marketCapSol,
        lastMarketCapSol: marketCapSol,
        updatedAtMs: now,
      });
    }
  }
}

function recordSwap(
  observation: PumpFeedObservation,
  mint: string,
  now: number,
): void {
  const signature =
    clean(tokenValue(observation, "signature")) ??
    clean(tokenValue(observation, "txSignature"));
  if (!signature) return;
  const existing = db().pumpSwaps.select().where({ signature }).first() as
    PumpSwapRow | undefined;
  if (existing) return;
  const solAmount = num(tokenValue(observation, "solAmount"));
  const tokenAmount = num(tokenValue(observation, "tokenAmount"));
  db().pumpSwaps.insert({
    signature,
    mint,
    slot: num(tokenValue(observation, "slot")),
    blockTime: num(tokenValue(observation, "blockTime")),
    side: boolSide(tokenValue(observation, "txType")),
    trader:
      clean(tokenValue(observation, "traderPublicKey")) ??
      clean(tokenValue(observation, "owner")) ??
      null,
    tokenAmountRaw: clean(tokenValue(observation, "tokenAmountRaw")) ?? null,
    tokenAmountUi: tokenAmount,
    solAmountLamports:
      clean(tokenValue(observation, "solAmountLamports")) ?? null,
    solAmount,
    marketCapSol:
      num(tokenValue(observation, "marketCapSol")) ??
      num(tokenValue(observation, "lastMarketCapSol")),
    priceSolPerToken:
      num(tokenValue(observation, "priceSolPerToken")) ??
      (solAmount != null && tokenAmount != null && tokenAmount > 0
        ? solAmount / tokenAmount
        : null),
    source: observation.source,
    rawJson: json(observation.raw ?? observation.token),
    createdAtMs: now,
  });
}

function recordObservedHolder(
  observation: PumpFeedObservation,
  mint: string,
  now: number,
): void {
  const owner =
    clean(tokenValue(observation, "traderPublicKey")) ??
    clean(tokenValue(observation, "owner")) ??
    clean(tokenValue(observation, "user"));
  if (!likelyPubkey(owner)) return;
  const signature =
    clean(tokenValue(observation, "signature")) ??
    clean(tokenValue(observation, "txSignature"));
  const side = boolSide(tokenValue(observation, "txType"));
  const tokenAmount = num(tokenValue(observation, "tokenAmount"));
  const signedUi =
    tokenAmount == null ? null : side === "sell" ? -tokenAmount : tokenAmount;
  if (signature) {
    const existingDelta = db()
      .pumpBalanceDeltas.select()
      .where({ signature, owner, mint })
      .first() as PumpBalanceDeltaRow | undefined;
    if (!existingDelta) {
      db().pumpBalanceDeltas.insert({
        mint,
        owner,
        signature,
        side,
        deltaRaw: clean(tokenValue(observation, "tokenAmountRaw")) ?? null,
        deltaUi: signedUi,
        postBalanceRaw:
          clean(tokenValue(observation, "postBalanceRaw")) ?? null,
        postBalanceUi: num(tokenValue(observation, "postBalanceUi")),
        source: observation.source,
        blockTime: num(tokenValue(observation, "blockTime")),
        createdAtMs: now,
      });
    }
  }
  const existing = db()
    .pumpHoldersCurrent.select()
    .where({ mint, owner })
    .first() as PumpHolderCurrentRow | undefined;
  const prevBalance = existing?.balanceUi ?? 0;
  const knownPost = num(tokenValue(observation, "postBalanceUi"));
  const nextBalance =
    knownPost ??
    (signedUi == null ? prevBalance : Math.max(0, prevBalance + signedUi));
  if (existing) {
    existing.balanceUi = Number.isFinite(nextBalance)
      ? nextBalance
      : existing.balanceUi;
    existing.lastDeltaUi = signedUi;
    existing.lastSignature = signature ?? existing.lastSignature;
    existing.lastUpdatedMs = now;
  } else {
    db().pumpHoldersCurrent.insert({
      mint,
      owner,
      label: null,
      balanceRaw: clean(tokenValue(observation, "postBalanceRaw")) ?? null,
      balanceUi: Number.isFinite(nextBalance) ? nextBalance : null,
      pctSupply: null,
      lastDeltaRaw: clean(tokenValue(observation, "tokenAmountRaw")) ?? null,
      lastDeltaUi: signedUi,
      lastSignature: signature ?? null,
      lastUpdatedMs: now,
    });
  }
}

export function recordPumpFeedObservation(
  observation: PumpFeedObservation,
): void {
  const tokenRow = upsertTokenEvent(observation);
  if (!tokenRow) return;
  const now = Date.now();
  const marketCapSol =
    num(tokenValue(observation, "marketCapSol")) ??
    num(tokenValue(observation, "lastMarketCapSol"));
  if (marketCapSol != null)
    upsertPriceAggregate(tokenRow.mint, marketCapSol, now);
  if (observation.eventType === "trade")
    recordSwap(observation, tokenRow.mint, now);
  recordObservedHolder(observation, tokenRow.mint, now);
}

function terminalRowFromToken(
  row: PumpTokenEventRow,
  now = Date.now(),
  solUsdPrice: number | null = null,
): PumpTerminalFeedRow {
  const aggregateRows = latestPumpAggregateRows(row.mint);
  const aggregateFor = (
    intervalSeconds: number,
  ): PumpPriceAggregateRow | undefined =>
    aggregateRows.find((item) => item.intervalSeconds === intervalSeconds);
  const swaps = latestPumpSwaps(row.mint, 25);
  const raw = safeParseJson(row.rawJson);
  const samples = aggregateRows
    .map((agg) => ({
      capturedAtMs: agg.updatedAtMs || agg.bucketStartMs,
      marketCapSol: agg.lastMarketCapSol ?? agg.smaMarketCapSol ?? null,
      marketCapUsd: mcapUsd(
        agg.lastMarketCapSol ?? agg.smaMarketCapSol ?? null,
        solUsdPrice,
      ),
      priceSolPerToken: row.priceSolPerToken ?? null,
      source: `sma-${agg.intervalSeconds}s`,
    }))
    .filter(
      (sample, index, arr) =>
        index ===
        arr.findIndex(
          (other) =>
            Math.abs(other.capturedAtMs - sample.capturedAtMs) < 1000 &&
            other.marketCapSol === sample.marketCapSol,
        ),
    )
    .slice(0, 100);
  if (
    row.marketCapSol != null &&
    !samples.some(
      (sample) => Math.abs(sample.capturedAtMs - row.updatedAtMs) < 1000,
    )
  ) {
    samples.unshift({
      capturedAtMs: row.updatedAtMs || now,
      marketCapSol: row.marketCapSol,
      marketCapUsd: mcapUsd(row.marketCapSol, solUsdPrice),
      priceSolPerToken: row.priceSolPerToken ?? null,
      source: row.source,
    });
  }
  const trades = swaps.map((swap) => ({
    capturedAtMs: swap.createdAtMs,
    marketCapSol: swap.marketCapSol ?? null,
    marketCapUsd: mcapUsd(swap.marketCapSol, solUsdPrice),
    priceSolPerToken: swap.priceSolPerToken ?? null,
    solAmount: swap.solAmount ?? null,
    tokenAmount: swap.tokenAmountUi ?? null,
    txType: swap.side ?? null,
    signature: swap.signature,
    source: swap.source,
  }));
  const current =
    row.marketCapSol ??
    samples.find((sample) => sample.marketCapSol != null)?.marketCapSol ??
    null;
  const initial =
    row.initialMarketCapSol ??
    [...samples].reverse().find((sample) => sample.marketCapSol != null)
      ?.marketCapSol ??
    current ??
    null;
  const currentUsd = mcapUsd(current, solUsdPrice);
  const initialUsd = mcapUsd(initial, solUsdPrice);
  const change = current != null && initial != null ? current - initial : null;
  const changeUsd =
    currentUsd != null && initialUsd != null ? currentUsd - initialUsd : null;
  const changePct =
    change != null && initial != null && initial > 0
      ? (change / initial) * 100
      : null;
  return {
    mint: row.mint,
    name: row.name,
    symbol: row.symbol,
    image: row.image,
    uri: row.uri,
    website: row.website,
    twitter: row.twitter,
    telegram: row.telegram,
    creator: row.creator,
    signature: row.signature,
    bondingCurveKey: row.bondingCurve,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    receivedAt: row.updatedAtMs
      ? new Date(row.updatedAtMs).toISOString()
      : null,
    lastTradeAtMs: row.lastTradeAtMs,
    marketCapSol: current,
    lastMarketCapSol: current,
    initialMarketCapSol: initial,
    marketCapChangeSol: change,
    marketCapUsd: currentUsd,
    lastMarketCapUsd: currentUsd,
    initialMarketCapUsd: initialUsd,
    marketCapChangeUsd: changeUsd,
    solUsdPrice,
    marketCapChangePct: changePct,
    priceSolPerToken: row.priceSolPerToken,
    samples,
    trades,
    sma1m: aggregateFor(60)?.smaMarketCapSol ?? null,
    sma5m: aggregateFor(300)?.smaMarketCapSol ?? null,
    sma15m: aggregateFor(900)?.smaMarketCapSol ?? null,
    sma1mUsd: mcapUsd(aggregateFor(60)?.smaMarketCapSol ?? null, solUsdPrice),
    sma5mUsd: mcapUsd(aggregateFor(300)?.smaMarketCapSol ?? null, solUsdPrice),
    sma15mUsd: mcapUsd(aggregateFor(900)?.smaMarketCapSol ?? null, solUsdPrice),
    source: row.source,
    eventType: row.eventType,
    quoteAsset: "SOL",
    quoteMint: "So11111111111111111111111111111111111111112",
    raw,
  };
}

export function listPumpTerminalFeedRows(
  args: {
    sinceMs?: number;
    pinnedMints?: string[];
    limit?: number;
    solUsdPrice?: number | null;
  } = {},
): PumpTerminalFeedRow[] {
  const now = Date.now();
  const limit = Math.max(1, Math.min(500, Math.floor(args.limit ?? 250)));
  const sinceMs = Number(args.sinceMs ?? 0);
  const cutoff =
    Number.isFinite(sinceMs) && sinceMs > 0
      ? sinceMs - 60_000
      : now - 10 * 60_000;
  const pinned = new Set(
    (args.pinnedMints ?? []).filter((mint) => likelyPubkey(mint)),
  );
  const rows = db()
    .pumpTokenEvents.select()
    .orderBy("updatedAtMs", "desc")
    .limit(limit * 4)
    .all() as PumpTokenEventRow[];
  const filtered = rows.filter(
    (row) =>
      pinned.has(row.mint) ||
      row.updatedAtMs >= cutoff ||
      (row.lastTradeAtMs != null && row.lastTradeAtMs >= cutoff),
  );
  return filtered
    .slice(0, limit)
    .map((row) => terminalRowFromToken(row, now, args.solUsdPrice ?? null))
    .sort((a, b) => {
      const pinDelta = Number(pinned.has(b.mint)) - Number(pinned.has(a.mint));
      if (pinDelta) return pinDelta;
      return (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0);
    });
}

export function getPumpFeedDbStats(): {
  tokens: number;
  swaps: number;
  holders: number;
  aggregates: number;
  latestUpdatedAtMs: number | null;
} {
  // Bounded counts keep the status path cheap. This is operational telemetry,
  // not an accounting endpoint.
  const tokens = db()
    .pumpTokenEvents.select()
    .orderBy("updatedAtMs", "desc")
    .limit(10_000)
    .all() as PumpTokenEventRow[];
  const swaps = db()
    .pumpSwaps.select()
    .orderBy("createdAtMs", "desc")
    .limit(10_000)
    .all() as PumpSwapRow[];
  const holders = db()
    .pumpHoldersCurrent.select()
    .orderBy("lastUpdatedMs", "desc")
    .limit(10_000)
    .all() as PumpHolderCurrentRow[];
  const aggregates = db()
    .pumpPriceAggregates.select()
    .orderBy("updatedAtMs", "desc")
    .limit(10_000)
    .all() as PumpPriceAggregateRow[];
  return {
    tokens: tokens.length,
    swaps: swaps.length,
    holders: holders.length,
    aggregates: aggregates.length,
    latestUpdatedAtMs: tokens[0]?.updatedAtMs ?? null,
  };
}

export function listObservedPumpHolders(
  mint: string,
  limit = 12,
): ObservedHolder[] {
  const rows = db()
    .pumpHoldersCurrent.select()
    .where({ mint })
    .orderBy("balanceUi", "desc")
    .limit(Math.max(1, Math.min(50, limit)))
    .all() as PumpHolderCurrentRow[];
  return rows.map((row) => ({
    owner: row.owner,
    label: row.label,
    balanceRaw: row.balanceRaw,
    balanceUi: row.balanceUi,
    pctSupply: row.pctSupply,
    lastDeltaRaw: row.lastDeltaRaw,
    lastDeltaUi: row.lastDeltaUi,
    lastSignature: row.lastSignature,
    lastUpdatedMs: row.lastUpdatedMs,
  }));
}
