import { chronologicalTokenHistoryTrades } from "./ordering.ts";
import type {
  TokenHistoryCoverage,
  TokenHistoryForensics,
  TokenHistoryForensicsOptions,
  TokenHistoryOwnerPnl,
  TokenHistoryPeriodSummary,
  TokenHistoryTrade,
} from "./types.ts";

const LAMPORTS_PER_SOL = 1_000_000_000;
const EPSILON = 1e-9;

type CostLot = {
  remainingTokens: number;
  costSolPerToken: number;
};

type RealizedEvent = {
  eventKey: string;
  tradedAtMs: number;
  realizedPnlSol: number;
};

type OwnerPnlInternal = {
  row: TokenHistoryOwnerPnl;
  realizedEvents: RealizedEvent[];
};

const DEFAULT_PERIODS: ReadonlyArray<{
  id: string;
  label: string;
  startMs: number;
  endMs: number | null;
}> = [
  { id: "0-5s", label: "0-5s", startMs: 0, endMs: 5_000 },
  { id: "5-15s", label: "5-15s", startMs: 5_000, endMs: 15_000 },
  { id: "15-30s", label: "15-30s", startMs: 15_000, endMs: 30_000 },
  { id: "30-60s", label: "30-60s", startMs: 30_000, endMs: 60_000 },
  { id: "1-5m", label: "1-5m", startMs: 60_000, endMs: 5 * 60_000 },
  { id: "5-15m", label: "5-15m", startMs: 5 * 60_000, endMs: 15 * 60_000 },
  { id: "15-60m", label: "15-60m", startMs: 15 * 60_000, endMs: 60 * 60_000 },
  { id: "1-6h", label: "1-6h", startMs: 60 * 60_000, endMs: 6 * 60 * 60_000 },
  {
    id: "6-24h",
    label: "6-24h",
    startMs: 6 * 60 * 60_000,
    endMs: 24 * 60 * 60_000,
  },
  { id: "1d+", label: "1d+", startMs: 24 * 60 * 60_000, endMs: null },
];

function finitePositive(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function lamportsToSol(value: string): number {
  try {
    return Number(BigInt(value)) / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

function lastMarkPrice(trades: readonly TokenHistoryTrade[]): number | null {
  for (let index = trades.length - 1; index >= 0; index -= 1) {
    const value = trades[index]?.priceSol;
    if (value != null && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function ownerPnl(
  owner: string,
  trades: readonly TokenHistoryTrade[],
  markPriceSol: number | null,
): OwnerPnlInternal {
  const rows = trades.filter((trade) => trade.owner === owner);
  const lots: CostLot[] = [];
  const realizedEvents: RealizedEvent[] = [];
  const costSignatures = new Set<string>();
  let buys = 0;
  let sells = 0;
  let buySol = 0;
  let sellSol = 0;
  let boughtTokens = 0;
  let soldTokens = 0;
  let realizedCostSol = 0;
  let realizedProceedsSol = 0;
  let realizedPnlSol = 0;
  let unmatchedSoldTokens = 0;
  let unmatchedSellProceedsSol = 0;
  let networkFeesSol = 0;
  let externalTransfersSol = 0;
  let firstBuyAtMs: number | null = null;
  let lastSellAtMs: number | null = null;

  for (const trade of rows) {
    if (!costSignatures.has(trade.signature)) {
      costSignatures.add(trade.signature);
      networkFeesSol += lamportsToSol(trade.history.networkFeeLamports);
      externalTransfersSol += lamportsToSol(
        trade.history.excludedExternalTransfersLamports,
      );
    }

    const tokens = Math.abs(finitePositive(trade.tokenDeltaUi));
    const sol = Math.abs(finitePositive(trade.solDeltaUi));
    if (tokens <= 0) continue;

    if (trade.side === "buy") {
      buys += 1;
      buySol += sol;
      boughtTokens += tokens;
      firstBuyAtMs =
        firstBuyAtMs == null
          ? trade.tradedAtMs
          : Math.min(firstBuyAtMs, trade.tradedAtMs);
      lots.push({
        remainingTokens: tokens,
        costSolPerToken: sol / tokens,
      });
      continue;
    }

    sells += 1;
    sellSol += sol;
    soldTokens += tokens;
    lastSellAtMs =
      lastSellAtMs == null
        ? trade.tradedAtMs
        : Math.max(lastSellAtMs, trade.tradedAtMs);

    let remainingToMatch = tokens;
    let matchedTokens = 0;
    let matchedCostSol = 0;
    while (remainingToMatch > EPSILON && lots.length > 0) {
      const lot = lots[0]!;
      const matched = Math.min(remainingToMatch, lot.remainingTokens);
      matchedTokens += matched;
      matchedCostSol += matched * lot.costSolPerToken;
      lot.remainingTokens -= matched;
      remainingToMatch -= matched;
      if (lot.remainingTokens <= EPSILON) lots.shift();
    }

    const matchedRatio = Math.min(1, matchedTokens / tokens);
    const matchedProceedsSol = sol * matchedRatio;
    const unmatchedProceeds = sol - matchedProceedsSol;
    const eventPnl = matchedProceedsSol - matchedCostSol;
    realizedCostSol += matchedCostSol;
    realizedProceedsSol += matchedProceedsSol;
    realizedPnlSol += eventPnl;
    unmatchedSoldTokens += Math.max(0, remainingToMatch);
    unmatchedSellProceedsSol += Math.max(0, unmatchedProceeds);
    if (matchedTokens > EPSILON) {
      realizedEvents.push({
        eventKey: trade.eventKey,
        tradedAtMs: trade.tradedAtMs,
        realizedPnlSol: eventPnl,
      });
    }
  }

  const remainingTokens = lots.reduce(
    (sum, lot) => sum + lot.remainingTokens,
    0,
  );
  const remainingCostSol = lots.reduce(
    (sum, lot) => sum + lot.remainingTokens * lot.costSolPerToken,
    0,
  );
  const markedValueSol =
    markPriceSol == null ? 0 : remainingTokens * markPriceSol;
  const unrealizedPnlSol =
    markPriceSol == null ? 0 : markedValueSol - remainingCostSol;
  const totalPnlSol = realizedPnlSol + unrealizedPnlSol;
  const recordedExecutionCostsSol = networkFeesSol + externalTransfersSol;
  const costBasisComplete = unmatchedSoldTokens <= EPSILON;
  const deployedCostSol = realizedCostSol + remainingCostSol;
  const roiPct =
    costBasisComplete && deployedCostSol > EPSILON
      ? (totalPnlSol / deployedCostSol) * 100
      : null;

  return {
    row: {
      owner,
      buys,
      sells,
      buySol,
      sellSol,
      boughtTokens,
      soldTokens,
      realizedCostSol,
      realizedProceedsSol,
      realizedPnlSol,
      remainingTokens,
      remainingCostSol,
      markPriceSol,
      markedValueSol,
      unrealizedPnlSol,
      totalPnlSol,
      networkFeesSol,
      externalTransfersSol,
      recordedExecutionCostsSol,
      netPnlAfterRecordedCostsSol: totalPnlSol - recordedExecutionCostsSol,
      unmatchedSoldTokens,
      unmatchedSellProceedsSol,
      costBasisComplete,
      roiPct,
      firstBuyAtMs,
      lastSellAtMs,
    },
    realizedEvents,
  };
}

function aggregateOwnedPnl(
  ownerRows: readonly TokenHistoryOwnerPnl[],
  ownedTrades: readonly TokenHistoryTrade[],
): TokenHistoryForensics["ownedTotal"] {
  const seen = new Set<string>();
  let networkFeesSol = 0;
  let externalTransfersSol = 0;
  for (const trade of ownedTrades) {
    if (seen.has(trade.signature)) continue;
    seen.add(trade.signature);
    networkFeesSol += lamportsToSol(trade.history.networkFeeLamports);
    externalTransfersSol += lamportsToSol(
      trade.history.excludedExternalTransfersLamports,
    );
  }
  const realizedPnlSol = ownerRows.reduce(
    (sum, row) => sum + row.realizedPnlSol,
    0,
  );
  const unrealizedPnlSol = ownerRows.reduce(
    (sum, row) => sum + row.unrealizedPnlSol,
    0,
  );
  const totalPnlSol = realizedPnlSol + unrealizedPnlSol;
  const recordedExecutionCostsSol = networkFeesSol + externalTransfersSol;
  return {
    wallets: ownerRows.length,
    buySol: ownerRows.reduce((sum, row) => sum + row.buySol, 0),
    sellSol: ownerRows.reduce((sum, row) => sum + row.sellSol, 0),
    realizedPnlSol,
    unrealizedPnlSol,
    totalPnlSol,
    networkFeesSol,
    externalTransfersSol,
    recordedExecutionCostsSol,
    netPnlAfterRecordedCostsSol: totalPnlSol - recordedExecutionCostsSol,
    remainingTokens: ownerRows.reduce(
      (sum, row) => sum + row.remainingTokens,
      0,
    ),
    incompleteWallets: ownerRows.filter((row) => !row.costBasisComplete).length,
  };
}

function buildPeriods(input: {
  trades: readonly TokenHistoryTrade[];
  owned: ReadonlySet<string>;
  anchorAtMs: number;
  realizedByEventKey: ReadonlyMap<string, number>;
}): TokenHistoryPeriodSummary[] {
  const rows = DEFAULT_PERIODS.map((period) => ({
    ...period,
    trades: 0,
    buys: 0,
    sells: 0,
    buySol: 0,
    sellSol: 0,
    netFlowSol: 0,
    ownedTrades: 0,
    ownedBuySol: 0,
    ownedSellSol: 0,
    ownedRealizedPnlSol: 0,
    ownedRecordedExecutionCostsSol: 0,
    ownedNetRealizedAfterRecordedCostsSol: 0,
  }));
  const costSeen = new Set<string>();
  for (const trade of input.trades) {
    const delta = Math.max(0, trade.tradedAtMs - input.anchorAtMs);
    const period = rows.find(
      (row) => delta >= row.startMs && (row.endMs == null || delta < row.endMs),
    );
    if (!period) continue;
    const sol = Math.abs(finitePositive(trade.solDeltaUi));
    period.trades += 1;
    if (trade.side === "buy") {
      period.buys += 1;
      period.buySol += sol;
    } else {
      period.sells += 1;
      period.sellSol += sol;
    }
    period.netFlowSol = period.buySol - period.sellSol;
    if (!trade.owner || !input.owned.has(trade.owner)) continue;
    period.ownedTrades += 1;
    if (trade.side === "buy") period.ownedBuySol += sol;
    else period.ownedSellSol += sol;
    period.ownedRealizedPnlSol +=
      input.realizedByEventKey.get(trade.eventKey) ?? 0;
    if (!costSeen.has(trade.signature)) {
      costSeen.add(trade.signature);
      period.ownedRecordedExecutionCostsSol +=
        lamportsToSol(trade.history.networkFeeLamports) +
        lamportsToSol(trade.history.excludedExternalTransfersLamports);
    }
    period.ownedNetRealizedAfterRecordedCostsSol =
      period.ownedRealizedPnlSol - period.ownedRecordedExecutionCostsSol;
  }
  return rows;
}

/**
 * Pure deterministic launch/trader forensics over exact historical fills.
 * P/L uses FIFO cost basis. Wallets that sell more tokens than their recorded
 * buys are flagged costBasisComplete=false and excluded from winner rankings.
 */
export function analyzeTokenHistoryForensics(input: {
  mint: string;
  trades: readonly TokenHistoryTrade[];
  coverage: TokenHistoryCoverage | null;
  ownedWallets?: Iterable<string>;
  options?: TokenHistoryForensicsOptions;
}): TokenHistoryForensics {
  const mint = input.mint.trim();
  const trades = chronologicalTokenHistoryTrades(input.trades);
  const owned = new Set(input.ownedWallets ?? []);
  const markPriceSol = lastMarkPrice(trades);
  const ownerSet = new Set<string>();
  for (const trade of trades) {
    if (typeof trade.owner === "string" && trade.owner)
      ownerSet.add(trade.owner);
  }
  const owners = [...ownerSet];
  const internals = owners.map((owner) =>
    ownerPnl(owner, trades, markPriceSol),
  );
  const ownerPnlRows = internals.map((entry) => entry.row);
  const realizedByEventKey = new Map<string, number>();
  for (const internal of internals) {
    for (const event of internal.realizedEvents) {
      realizedByEventKey.set(
        event.eventKey,
        (realizedByEventKey.get(event.eventKey) ?? 0) + event.realizedPnlSol,
      );
    }
  }

  const buys = trades.filter((trade) => trade.side === "buy" && !!trade.owner);
  const firstMarketBuy = buys[0] ?? null;
  const firstExternalBuy =
    buys.find((trade) => trade.owner && !owned.has(trade.owner)) ?? null;
  const buyerFirstRank = new Map<string, number>();
  let uniqueBuyerCount = 0;
  const firstBuyerLimit = Math.max(
    1,
    Math.min(500, Math.trunc(input.options?.firstBuyerLimit ?? 50)),
  );
  const firstBuyers = buys.slice(0, firstBuyerLimit).map((trade, index) => {
    const owner = trade.owner!;
    if (!buyerFirstRank.has(owner))
      buyerFirstRank.set(owner, ++uniqueBuyerCount);
    return {
      trade,
      buyRank: index + 1,
      uniqueBuyerRank: buyerFirstRank.get(owner)!,
      owned: owned.has(owner),
      creationDeltaMs:
        input.coverage?.creationAtMs == null
          ? null
          : trade.tradedAtMs - input.coverage.creationAtMs,
      firstBuyDeltaMs:
        firstMarketBuy == null
          ? null
          : trade.tradedAtMs - firstMarketBuy.tradedAtMs,
      slotDeltaFromFirstBuy:
        firstMarketBuy == null ? null : trade.slot - firstMarketBuy.slot,
    };
  });

  // Build ranks over the complete buy tape, not just the displayed prefix.
  buyerFirstRank.clear();
  uniqueBuyerCount = 0;
  for (const trade of buys) {
    const owner = trade.owner!;
    if (!buyerFirstRank.has(owner))
      buyerFirstRank.set(owner, ++uniqueBuyerCount);
  }

  const ownedEntries: TokenHistoryForensics["ownedEntries"] = [];
  for (const owner of owned) {
    const index = buys.findIndex((trade) => trade.owner === owner);
    if (index < 0) continue;
    const trade = buys[index]!;
    const prior = buys.slice(0, index);
    const priorExternal = prior.filter(
      (row) => row.owner && !owned.has(row.owner),
    );
    ownedEntries.push({
      owner,
      trade,
      buyRank: index + 1,
      uniqueBuyerRank: buyerFirstRank.get(owner) ?? null,
      buyersAhead: prior.length,
      uniqueBuyersAhead: new Set(prior.map((row) => row.owner).filter(Boolean))
        .size,
      buySolAhead: prior.reduce(
        (sum, row) => sum + Math.abs(row.solDeltaUi),
        0,
      ),
      externalBuysAhead: priorExternal.length,
      externalUniqueBuyersAhead: new Set(priorExternal.map((row) => row.owner))
        .size,
      externalBuySolAhead: priorExternal.reduce(
        (sum, row) => sum + Math.abs(row.solDeltaUi),
        0,
      ),
      sameTimestampBuysAhead: prior.filter(
        (row) => row.tradedAtMs === trade.tradedAtMs,
      ).length,
      sameSlotBuysAhead: prior.filter((row) => row.slot === trade.slot).length,
      creationDeltaMs:
        input.coverage?.creationAtMs == null
          ? null
          : trade.tradedAtMs - input.coverage.creationAtMs,
      firstBuyDeltaMs:
        firstMarketBuy == null
          ? null
          : trade.tradedAtMs - firstMarketBuy.tradedAtMs,
      firstExternalBuyDeltaMs:
        firstExternalBuy == null
          ? null
          : trade.tradedAtMs - firstExternalBuy.tradedAtMs,
      slotDeltaFromFirstBuy:
        firstMarketBuy == null ? null : trade.slot - firstMarketBuy.slot,
      slotDeltaFromFirstExternalBuy:
        firstExternalBuy == null ? null : trade.slot - firstExternalBuy.slot,
    });
  }
  ownedEntries.sort((left, right) => left.buyRank - right.buyRank);

  const ownedPnl = ownerPnlRows
    .filter((row) => owned.has(row.owner))
    .sort((left, right) => right.totalPnlSol - left.totalPnlSol);
  const ownedTrades = trades.filter(
    (trade) => trade.owner && owned.has(trade.owner),
  );
  const ownedTotal = aggregateOwnedPnl(ownedPnl, ownedTrades);
  const rankable = ownerPnlRows.filter(
    (row) => row.costBasisComplete && row.buySol > EPSILON,
  );
  const topLimit = Math.max(
    1,
    Math.min(500, Math.trunc(input.options?.topLimit ?? 25)),
  );
  const topRealizedWinners = [...rankable]
    .filter((row) => row.sells > 0)
    .sort((left, right) => right.realizedPnlSol - left.realizedPnlSol)
    .slice(0, topLimit);
  const topTotalWinners = [...rankable]
    .sort((left, right) => right.totalPnlSol - left.totalPnlSol)
    .slice(0, topLimit);
  const topTotalLosers = [...rankable]
    .sort((left, right) => left.totalPnlSol - right.totalPnlSol)
    .slice(0, topLimit);
  const anchorAtMs = input.coverage?.creationAtMs ?? trades[0]?.tradedAtMs ?? 0;
  const periods = buildPeriods({
    trades,
    owned,
    anchorAtMs,
    realizedByEventKey,
  });

  return {
    mint,
    coverage: input.coverage,
    markPriceSol,
    firstMarketBuy,
    firstExternalBuy,
    firstBuyers,
    ownedEntries,
    ownerPnl: ownerPnlRows,
    ownedPnl,
    ownedTotal,
    topRealizedWinners,
    topTotalWinners,
    topTotalLosers,
    periods,
  };
}
