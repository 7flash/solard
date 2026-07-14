import type { TerminalFeedRow } from "../../../shared/db.js";

function n(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function s(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function b(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["1", "true", "yes", "mayhem"].includes(text)) return true;
    if (["0", "false", "no", "standard"].includes(text)) return false;
  }
  return null;
}

export function terminalFeedRowToPumpRow(
  row: TerminalFeedRow | Record<string, unknown>,
) {
  const anyRow = row as Record<string, any>;
  const now = Date.now();
  const updatedAtMs = n(anyRow.updatedAtMs) ?? n(anyRow.createdAtMs) ?? now;
  const priceUpdatedAtMs =
    n(anyRow.priceUpdatedAtMs) ??
    n(anyRow.lastTradeAtMs) ??
    (n(anyRow.priceUsd) != null || n(anyRow.marketCapUsd) != null
      ? updatedAtMs
      : null);
  const mcapUsd = n(anyRow.marketCapUsd);
  const initialMcapUsd = n(anyRow.initialMarketCapUsd) ?? mcapUsd;
  const priceUsd = n(anyRow.priceUsd);
  const tradeCount = Math.max(
    0,
    Math.floor(
      n(anyRow.tradeCount) ??
        (Array.isArray(anyRow.trades) ? anyRow.trades.length : 0),
    ),
  );
  const eventType =
    anyRow.kind === "signal" ? "signal" : tradeCount > 0 ? "trade" : "create";
  const priceAgeMs =
    priceUpdatedAtMs == null ? null : Math.max(0, now - priceUpdatedAtMs);
  const priceStatus =
    priceUpdatedAtMs == null
      ? "missing"
      : priceAgeMs != null && priceAgeMs > 30_000
        ? "stale"
        : String(anyRow.priceSource ?? anyRow.source ?? "").includes("snapshot")
          ? "snapshot"
          : "live";
  const trades = Array.from(
    { length: Math.min(tradeCount, 80) },
    (_unused, index) => ({
      id: `${s(anyRow.mint) ?? "mint"}:trade-count:${index}`,
    }),
  );
  const isMayhemMode = b(anyRow.isMayhemMode) ?? b(anyRow.mayhemMode) ?? false;

  return {
    seq: updatedAtMs,
    receivedAt: new Date(updatedAtMs).toISOString(),
    createdAtMs: n(anyRow.createdAtMs) ?? updatedAtMs,
    updatedAtMs,
    eventType,
    source: s(anyRow.source) ?? s(anyRow.kind) ?? "terminal-sqlite",
    mint: s(anyRow.mint),
    name: s(anyRow.name),
    symbol: s(anyRow.symbol),
    uri: s(anyRow.uri),
    website: s(anyRow.website),
    twitter: s(anyRow.twitter),
    telegram: s(anyRow.telegram),
    description: s(anyRow.description),
    creator: s(anyRow.creator),
    signature: s(anyRow.signature),
    image: s(anyRow.image),
    bondingCurveKey: s(anyRow.bondingCurveKey),
    marketCapUsd: mcapUsd,
    priceUsd,
    priceUpdatedAtMs,
    priceAgeMs,
    priceStatus,
    priceSource: s(anyRow.priceSource),
    marketCapSol: n(anyRow.marketCapSol),
    lastMarketCapSol: mcapUsd,
    initialMarketCapSol: initialMcapUsd,
    initialMarketCapUsd: initialMcapUsd,
    marketCapChangeSol:
      mcapUsd != null && initialMcapUsd != null
        ? mcapUsd - initialMcapUsd
        : null,
    marketCapChangePct:
      mcapUsd != null && initialMcapUsd != null && initialMcapUsd > 0
        ? ((mcapUsd - initialMcapUsd) / initialMcapUsd) * 100
        : null,
    priceSolPerToken: n(anyRow.priceSol),
    sma1m: n(anyRow.sma1m),
    sma5m: n(anyRow.sma5m),
    sma15m: n(anyRow.sma15m),
    lastTradeAtMs:
      n(anyRow.lastTradeAtMs) ??
      (tradeCount > 0 ? (priceUpdatedAtMs ?? updatedAtMs) : null),
    tradeCount,
    trades,
    isMayhemMode,
    quoteAsset: s(anyRow.quoteAsset),
    quoteMint: s(anyRow.quoteMint),
    signalText: s(anyRow.signalText),
    signalSource: s(anyRow.signalSource),
    raw: anyRow,
  };
}

export function terminalFeedRowsToPumpRows(
  rows: Array<TerminalFeedRow | Record<string, unknown>>,
) {
  return rows.map((row) => terminalFeedRowToPumpRow(row));
}
