import type { TerminalFeedRow } from "../db/terminal-store.js";

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

export function terminalFeedRowToPumpRow(
  row: TerminalFeedRow | Record<string, unknown>,
) {
  const anyRow = row as Record<string, any>;
  const now = Date.now();
  const updatedAtMs = n(anyRow.updatedAtMs) ?? n(anyRow.createdAtMs) ?? now;
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
  const trades = Array.from(
    { length: Math.min(tradeCount, 80) },
    (_unused, index) => ({
      id: `${s(anyRow.mint) ?? "mint"}:trade-count:${index}`,
    }),
  );

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
    // Runtime historically names these fields *Sol*. In the worker pipeline they
    // are terminal display market-cap units, i.e. USD. Keep aliases so older
    // components sort/render without blank cells.
    marketCapSol: mcapUsd,
    lastMarketCapSol: mcapUsd,
    initialMarketCapSol: initialMcapUsd,
    initialMarketCapUsd,
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
    lastTradeAtMs: tradeCount > 0 ? updatedAtMs : null,
    tradeCount,
    trades,
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
