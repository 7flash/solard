import { chronologicalTokenHistoryTrades } from "./ordering.ts";
import type {
  TokenHistoryAnalysis,
  TokenHistoryCoverage,
  TokenHistoryTrade,
} from "./types.ts";

/** Pure deterministic analysis over an already-loaded durable tape. */
export function analyzeTokenHistoryTrades(input: {
  mint: string;
  trades: readonly TokenHistoryTrade[];
  coverage: TokenHistoryCoverage | null;
  ownedWallets?: Iterable<string>;
}): TokenHistoryAnalysis {
  const mint = input.mint.trim();
  const trades = chronologicalTokenHistoryTrades(input.trades);
  const owned = new Set(input.ownedWallets ?? []);
  const owners = new Map<string, TokenHistoryAnalysis["owners"][number]>();
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let sells = 0;
  let athPriceSol: number | null = null;
  let atlPriceSol: number | null = null;
  let athMarketCapSol: number | null = null;
  let atlMarketCapSol: number | null = null;
  let firstExternalBuyer: TokenHistoryTrade | null = null;

  for (const trade of trades) {
    const sol = Math.abs(Number(trade.solDeltaUi));
    const tokens = Math.abs(Number(trade.tokenDeltaUi));
    if (trade.side === "buy") {
      buys += 1;
      buySol += sol;
      if (!firstExternalBuyer && trade.owner && !owned.has(trade.owner)) {
        firstExternalBuyer = trade;
      }
    } else {
      sells += 1;
      sellSol += sol;
    }
    if (trade.priceSol != null && trade.priceSol > 0) {
      athPriceSol = Math.max(athPriceSol ?? trade.priceSol, trade.priceSol);
      atlPriceSol = Math.min(atlPriceSol ?? trade.priceSol, trade.priceSol);
    }
    const marketCapSol = trade.history.marketCapSol;
    if (marketCapSol != null && marketCapSol > 0) {
      athMarketCapSol = Math.max(athMarketCapSol ?? marketCapSol, marketCapSol);
      atlMarketCapSol = Math.min(atlMarketCapSol ?? marketCapSol, marketCapSol);
    }
    if (!trade.owner) continue;
    const current = owners.get(trade.owner) ?? {
      owner: trade.owner,
      buySol: 0,
      sellSol: 0,
      netSpentSol: 0,
      boughtTokens: 0,
      soldTokens: 0,
      netTokens: 0,
      buys: 0,
      sells: 0,
      trades: 0,
      firstTradeAtMs: trade.tradedAtMs,
      lastTradeAtMs: trade.tradedAtMs,
    };
    if (trade.side === "buy") {
      current.buySol += sol;
      current.boughtTokens += tokens;
      current.buys += 1;
    } else {
      current.sellSol += sol;
      current.soldTokens += tokens;
      current.sells += 1;
    }
    current.trades += 1;
    current.firstTradeAtMs = Math.min(current.firstTradeAtMs, trade.tradedAtMs);
    current.lastTradeAtMs = Math.max(current.lastTradeAtMs, trade.tradedAtMs);
    current.netSpentSol = current.buySol - current.sellSol;
    current.netTokens = current.boughtTokens - current.soldTokens;
    owners.set(trade.owner, current);
  }

  const ownerRows = [...owners.values()].sort(
    (left, right) => right.trades - left.trades || right.buySol - left.buySol,
  );
  return {
    mint,
    coverage: input.coverage,
    trades: trades.length,
    buys,
    sells,
    uniqueTraders: owners.size,
    buySol,
    sellSol,
    netInflowSol: buySol - sellSol,
    firstTradeAtMs: trades[0]?.tradedAtMs ?? null,
    lastTradeAtMs: trades.at(-1)?.tradedAtMs ?? null,
    firstExternalBuyer,
    athPriceSol,
    atlPriceSol,
    athMarketCapSol,
    atlMarketCapSol,
    roundTripTraders: ownerRows.filter((row) => row.buys > 0 && row.sells > 0)
      .length,
    owners: ownerRows,
  };
}
