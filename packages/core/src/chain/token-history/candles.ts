import { chronologicalTokenHistoryTrades } from "./ordering.ts";
import type { TokenHistoryCandle1s, TokenHistoryTrade } from "./types.ts";

function usablePrice(row: TokenHistoryTrade): number | null {
  const direct = Number(row.priceSol);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const tokens = Math.abs(Number(row.tokenDeltaUi));
  const sol = Math.abs(Number(row.solDeltaUi));
  return Number.isFinite(tokens) &&
    tokens > 0 &&
    Number.isFinite(sol) &&
    sol > 0
    ? sol / tokens
    : null;
}

/**
 * Pure sparse 1-second aggregation.
 *
 * Only seconds containing at least one priced market trade are emitted. Exact
 * trades remain the source of truth; candles are an acceleration/index layer.
 */
export function buildSparseTokenHistoryCandles1s(
  rows: readonly TokenHistoryTrade[],
  updatedAtMs: number,
): TokenHistoryCandle1s[] {
  const out: TokenHistoryCandle1s[] = [];
  let candle: TokenHistoryCandle1s | null = null;

  for (const row of chronologicalTokenHistoryTrades(rows)) {
    if (row.confidence === "dropped") continue;
    const price = usablePrice(row);
    if (price == null) continue;
    const bucketAtMs = Math.floor(row.tradedAtMs / 1_000) * 1_000;
    const sol = Math.abs(Number(row.solDeltaUi)) || 0;
    const token = Math.abs(Number(row.tokenDeltaUi)) || 0;

    if (!candle || candle.bucketAtMs !== bucketAtMs) {
      if (candle) out.push(candle);
      candle = {
        candleKey: `${row.mint}:1s:${bucketAtMs}`,
        mint: row.mint,
        bucketAtMs,
        openPriceSol: price,
        highPriceSol: price,
        lowPriceSol: price,
        closePriceSol: price,
        volumeSol: sol,
        volumeToken: token,
        buyVolumeSol: row.side === "buy" ? sol : 0,
        sellVolumeSol: row.side === "sell" ? sol : 0,
        buys: row.side === "buy" ? 1 : 0,
        sells: row.side === "sell" ? 1 : 0,
        trades: 1,
        firstSignature: row.signature,
        lastSignature: row.signature,
        firstSlot: row.slot,
        lastSlot: row.slot,
        updatedAtMs,
      };
      continue;
    }

    candle.highPriceSol = Math.max(candle.highPriceSol, price);
    candle.lowPriceSol = Math.min(candle.lowPriceSol, price);
    candle.closePriceSol = price;
    candle.volumeSol += sol;
    candle.volumeToken += token;
    if (row.side === "buy") {
      candle.buyVolumeSol += sol;
      candle.buys += 1;
    } else {
      candle.sellVolumeSol += sol;
      candle.sells += 1;
    }
    candle.trades += 1;
    candle.lastSignature = row.signature;
    candle.lastSlot = row.slot;
  }

  if (candle) out.push(candle);
  return out;
}
