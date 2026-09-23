import { PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
import type { Solard } from "@solard/core";
import {
  analyzeTokenHistory,
  analyzeTokenHistoryForensicsFromStore,
  getTokenHistoryCoverage,
  loadTokenHistoryTrades,
  type BackfillTokenHistoryOptions,
  type TokenHistoryCoverage,
  type TokenHistoryTrade,
} from "@solard/core";

import {
  replaceResearchHistoryIndex,
  researchHistoryCachePath,
  type ResearchHistorySignature,
} from "./research-history-cache.ts";

export type TokenHistoryCliFlags = Map<string, string>;

type Emit = (value: string) => void;

function flag(flags: TokenHistoryCliFlags, key: string): string | undefined {
  const value = flags.get(key);
  return value && value !== "true" ? value : undefined;
}

function numberFlag(
  flags: TokenHistoryCliFlags,
  key: string,
  fallback?: number,
): number | undefined {
  const value = flag(flags, key);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key}: ${value}`);
  return parsed;
}

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function compact(address: string, left = 6, right = 6): string {
  if (address.length <= left + right + 1) return address;
  return `${address.slice(0, left)}…${address.slice(-right)}`;
}

function aliases(slrd: Solard): Map<string, string> {
  return new Map(
    slrd.wallets
      .list()
      .map((wallet) => [wallet.address, `@${wallet.name}`] as const),
  );
}

function ownerLabel(owner: string | null, names: Map<string, string>): string {
  if (!owner) return "-";
  return names.get(owner) ?? compact(owner, 5, 5);
}

function resolveOwner(slrd: Solard, value: string | undefined): string | null {
  if (!value) return null;
  try {
    return slrd.resolveWallet(value).address.toBase58();
  } catch {
    return value.trim();
  }
}

function fmtNumber(value: number, digits = 6): string {
  if (!Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1_000_000) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  if (Math.abs(value) >= 1) {
    return value.toLocaleString("en-US", { maximumFractionDigits: digits });
  }
  if (value === 0) return "0";
  if (Math.abs(value) >= 0.000001) return value.toFixed(9).replace(/0+$/, "");
  return value.toExponential(4);
}

function fmtDate(ms: number | null): string {
  return ms == null ? "-" : new Date(ms).toISOString();
}

function fmtDelta(ms: number | null): string {
  if (ms == null) return "-";
  const sign = ms < 0 ? "-" : "+";
  const value = Math.abs(ms);
  if (value < 1_000) return `${sign}${value}ms`;
  if (value < 60_000)
    return `${sign}${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 3)}s`;
  if (value < 3_600_000) return `${sign}${(value / 60_000).toFixed(2)}m`;
  return `${sign}${(value / 3_600_000).toFixed(2)}h`;
}

function signedSol(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${fmtNumber(Math.abs(value))}`;
}

function coverageText(
  coverage: ReturnType<typeof getTokenHistoryCoverage>,
): string {
  if (!coverage) return "NOT BACKFILLED";
  if (coverage.complete && coverage.fromCreation)
    return "COMPLETE FROM CREATION";
  if (coverage.fromCreation) return "FROM CREATION, WITH RPC GAPS/TRUNCATION";
  return "PARTIAL / CREATION NOT PROVEN";
}

function tradeLine(
  row: TokenHistoryTrade,
  index: number,
  names: Map<string, string>,
): string {
  const venue =
    row.history.venue === "pumpswap"
      ? "AMM"
      : row.history.venue === "raydium"
        ? "RAY"
        : "CURVE";
  const side = row.side.toUpperCase().padEnd(4);
  const owner = ownerLabel(row.owner, names).padEnd(12);
  const sol = `${fmtNumber(Math.abs(row.solDeltaUi), 6)} SOL`.padStart(16);
  const tokens = fmtNumber(Math.abs(row.tokenDeltaUi), 4).padStart(16);
  const price = row.priceSol == null ? "-" : fmtNumber(row.priceSol, 9);
  const mcap =
    row.history.marketCapSol == null
      ? "-"
      : `${fmtNumber(row.history.marketCapSol, 2)} SOL`;
  return (
    `${String(index).padStart(6)}  ${fmtDate(row.tradedAtMs)}  ` +
    `${venue.padEnd(5)} ${side} ${owner} ${sol}  ${tokens} tok  ` +
    `px=${price}  mcap=${mcap}  ${compact(row.signature, 8, 8)}`
  );
}

async function scanHistoryAddress(args: {
  slrd: Solard;
  kind: "curve" | "pool";
  address: string;
  maxSignatures: number;
  progress: (line: string) => void;
}): Promise<{
  rows: ResearchHistorySignature[];
  reachedStart: boolean;
  truncated: boolean;
}> {
  const rows: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  let pages = 0;
  let reachedStart = false;
  let truncated = false;
  while (true) {
    const remaining =
      args.maxSignatures > 0 ? args.maxSignatures - rows.length : 1_000;
    if (args.maxSignatures > 0 && remaining <= 0) {
      truncated = true;
      break;
    }
    const limit = Math.min(1_000, args.maxSignatures > 0 ? remaining : 1_000);
    const page = await args.slrd
      .connection()
      .getSignaturesForAddress(
        new PublicKey(args.address),
        { limit, ...(before ? { before } : {}) },
        "finalized",
      );
    pages += 1;
    rows.push(...page.filter((row) => !row.err));
    if (pages === 1 || pages % 5 === 0)
      args.progress(
        `SIGS   ${args.kind.padEnd(5)} pages=${pages} signatures=${rows.length}`,
      );
    if (page.length < limit) {
      reachedStart = true;
      break;
    }
    const next = page.at(-1)?.signature;
    if (!next || next === before) {
      reachedStart = true;
      break;
    }
    before = next;
  }
  return {
    rows: [...rows].reverse().map((row, index) => ({
      mint: "",
      signature: row.signature,
      slot: row.slot,
      blockTime: row.blockTime ?? null,
      scanKind: args.kind,
      scanAddress: args.address,
      localChronologicalOrder: index,
    })),
    reachedStart,
    truncated,
  };
}

async function runIndexBackfill(args: {
  slrd: Solard;
  mint: string;
  flags: TokenHistoryCliFlags;
  emit: Emit;
}): Promise<void> {
  const jsonMode = args.flags.has("json");
  const progress = (line: string) => {
    if (!jsonMode) process.stderr.write(`${line}\n`);
  };
  progress(`TOKEN INDEX     ${args.mint}`);
  const token = await args.slrd.addToken(args.mint);
  if (!token.bondingCurve)
    throw new Error(`Token ${args.mint} has no Pump bonding curve to index`);
  const supply = await args.slrd
    .connection()
    .getTokenSupply(new PublicKey(args.mint), "confirmed");
  const maxSignatures = Math.max(
    0,
    Math.trunc(numberFlag(args.flags, "max-signatures", 0) ?? 0),
  );
  const curve = await scanHistoryAddress({
    slrd: args.slrd,
    kind: "curve",
    address: token.bondingCurve,
    maxSignatures,
    progress,
  });
  const pool = token.pool
    ? await scanHistoryAddress({
        slrd: args.slrd,
        kind: "pool",
        address: token.pool,
        maxSignatures,
        progress,
      })
    : null;
  const unique = new Map<string, ResearchHistorySignature>();
  for (const row of [...curve.rows, ...(pool?.rows ?? [])]) {
    const value = { ...row, mint: args.mint };
    const previous = unique.get(value.signature);
    if (!previous || value.scanKind === "curve")
      unique.set(value.signature, value);
  }
  const rows = [...unique.values()].sort(
    (a, b) =>
      a.slot - b.slot ||
      (a.blockTime ?? 0) - (b.blockTime ?? 0) ||
      a.localChronologicalOrder - b.localChronologicalOrder ||
      a.signature.localeCompare(b.signature),
  );
  rows.forEach((row, index) => {
    row.localChronologicalOrder = index;
  });
  const fromCreation = curve.reachedStart && !curve.truncated;
  const meta = {
    version: 1 as const,
    mint: args.mint,
    decimals: supply.value.decimals,
    supplyUi: Number(supply.value.uiAmountString ?? "0"),
    quoteMint: token.quoteMint ?? null,
    bondingCurve: token.bondingCurve,
    pool: token.pool ?? null,
    fromCreation,
    indexedSignatures: rows.length,
    indexedAtMs: Date.now(),
  };
  replaceResearchHistoryIndex({ mint: args.mint, rows, meta });
  const result = {
    ...meta,
    curveSignatures: curve.rows.length,
    poolSignatures: pool?.rows.length ?? 0,
    cache: researchHistoryCachePath(),
  };
  if (jsonMode) args.emit(`${JSON.stringify(result)}\n`);
  else
    args.emit(
      [
        "",
        "TOKEN HISTORY INDEX",
        `Mint:              ${args.mint}`,
        `Signatures:        ${rows.length}`,
        `From creation:     ${fromCreation ? "yes" : "no"}`,
        `Transactions read: 0`,
        `Research cache:    ${researchHistoryCachePath()}`,
        "",
        "READY: scripts hydrate only the historical intervals they request.",
      ].join("\n") + "\n",
    );
}

async function runBackfill(args: {
  slrd: Solard;
  mint: string;
  flags: TokenHistoryCliFlags;
  emit: Emit;
}): Promise<void> {
  if (!args.flags.has("exact") && !args.flags.has("materialize")) {
    await runIndexBackfill(args);
    return;
  }
  const jsonMode = args.flags.has("json");
  const progress = (line: string) => {
    if (!jsonMode) process.stderr.write(`${line}\n`);
  };
  progress(`TOKEN BACKFILL  ${args.mint}`);
  const backfillOptions: BackfillTokenHistoryOptions = {
    commitment: args.flags.has("confirmed")
      ? ("confirmed" as const)
      : ("finalized" as const),
    pageSize: numberFlag(args.flags, "page-size", 1_000),
    transactionBatchSize: numberFlag(args.flags, "batch-size", 100),
    transactionConcurrency: numberFlag(args.flags, "rpc-concurrency", 3),
    rpcTimeoutMs: numberFlag(args.flags, "rpc-timeout-ms", 20_000),
    rpcRetries: numberFlag(args.flags, "rpc-retries", 2),
    retryDelayMs: numberFlag(args.flags, "retry-delay-ms", 750),
    maxSignaturesPerAddress: numberFlag(args.flags, "max-signatures", 0),
    priceSampleMs: args.flags.has("exact")
      ? 0
      : numberFlag(args.flags, "price-sample-ms", 1_000),
    replace: args.flags.has("replace"),
    onProgress: (row) => {
      if (row.phase === "signatures") {
        if (row.pages === 1 || row.pages % 5 === 0)
          progress(
            `SIGS   ${row.kind.padEnd(5)} pages=${row.pages} signatures=${row.signatures}`,
          );
      } else if (row.phase === "sample") {
        progress(
          `SAMPLE ${row.selected}/${row.total} signatures @ ${row.sampleMs}ms`,
        );
      } else if (row.phase === "transactions") {
        if (
          row.completed === row.total ||
          row.completed <= row.batchSize ||
          row.completed % 500 === 0
        )
          progress(`TX     ${row.completed}/${row.total}`);
      } else if (row.phase === "retry") {
        progress(
          `RETRY  ${row.operation}${row.kind ? `:${row.kind}` : ""} ${row.attempt}/${row.maxAttempts}  ${row.error}`,
        );
      } else if (row.phase === "rpc-error") {
        progress(
          `RPCERR ${row.operation}${row.kind ? `:${row.kind}` : ""} failed=${row.failedItems}  ${row.error}`,
        );
      } else if (row.phase === "throttle") {
        progress(
          `THROT  ${row.reason} wait=${row.waitMs}ms batch=${row.batchSize}->${row.nextBatchSize}`,
        );
      } else if (row.phase === "parse") {
        if (
          row.completed === row.total ||
          row.completed === 1 ||
          row.completed % 1_000 === 0
        )
          progress(
            `PARSE  ${row.completed}/${row.total} trades=${row.trades} ambiguous=${row.ambiguous}`,
          );
      } else if (row.phase === "store") {
        if (row.completed === row.total || row.completed % 1_000 === 0)
          progress(
            `STORE  ${row.completed}/${row.total} inserted=${row.inserted} updated=${row.updated}`,
          );
      } else if (row.phase === "candles") {
        progress(`1S     trades=${row.trades} sparse-candles=${row.candles}`);
      }
    },
  };
  const market = await args.slrd.history.market(args.mint, {
    ...backfillOptions,
    backfill: true,
    maxRaydiumPools: Math.max(
      1,
      Math.trunc(numberFlag(args.flags, "raydium-pools", 8) ?? 8),
    ),
  });
  const result: TokenHistoryCoverage = market.coverage;
  if (jsonMode) {
    args.emit(`${json(result)}\n`);
    return;
  }
  args.emit(
    [
      "",
      "TOKEN HISTORY MATERIALIZATION",
      `Mint:              ${result.mint}`,
      `Coverage:          ${coverageText(result)}`,
      `Creation:          ${fmtDate(result.creationAtMs)} ${result.creationSignature ? compact(result.creationSignature, 10, 10) : "-"}`,
      `Signatures:        ${result.uniqueSignatures}`,
      `History mode:      ${result.historyMode ?? "exact"}${result.priceSampleMs ? ` @ ${result.priceSampleMs}ms` : ""}`,
      `Hydrated tx:       ${result.parsedTransactions}/${result.uniqueSignatures}`,
      `Stored trades:     ${result.storedTrades}`,
      `Sparse 1s candles: ${result.storedCandles1s}`,
      "",
    ].join("\n") + "\n",
  );
}

function runTrades(args: {
  slrd: Solard;
  mint: string;
  flags: TokenHistoryCliFlags;
  emit: Emit;
}): void {
  const names = aliases(args.slrd);
  const owner = resolveOwner(args.slrd, flag(args.flags, "owner"));
  const side = flag(args.flags, "side");
  if (side && side !== "buy" && side !== "sell") {
    throw new Error("--side must be buy or sell");
  }
  const minSol = Math.max(0, numberFlag(args.flags, "min-sol", 0) ?? 0);
  const fromStart = args.flags.has("from-start") || args.flags.has("oldest");
  const explicitLimit = numberFlag(args.flags, "limit");
  const limit =
    explicitLimit == null
      ? fromStart
        ? Number.POSITIVE_INFINITY
        : 100
      : Math.max(1, Math.trunc(explicitLimit));

  let rows = loadTokenHistoryTrades(args.mint).filter(
    (row) =>
      (!owner || row.owner === owner) &&
      (!side || row.side === side) &&
      Math.abs(row.solDeltaUi) >= minSol,
  );
  if (!fromStart) rows = rows.reverse();
  rows = rows.slice(0, limit);
  const coverage = getTokenHistoryCoverage(args.mint);

  if (args.flags.has("json")) {
    args.emit(`${json({ coverage, trades: rows })}\n`);
    return;
  }

  args.emit(`TOKEN TRADES  ${args.mint}\n`);
  args.emit(`Coverage: ${coverageText(coverage)}\n`);
  if (coverage?.creationAtMs) {
    args.emit(
      `CREATE    ${fmtDate(coverage.creationAtMs)}  ${coverage.creationSignature ?? "-"}` +
        `${coverage.creationSymbol ? `  $${coverage.creationSymbol}` : ""}\n`,
    );
  }
  if (coverage?.pumpswap?.oldestBlockTime != null) {
    args.emit(
      `POOL      ${fmtDate(coverage.pumpswap.oldestBlockTime * 1_000)}  ${coverage.pool ?? "-"}\n`,
    );
  }
  args.emit(
    `Rows: ${rows.length}${Number.isFinite(limit) ? ` (limit ${limit})` : ""}` +
      `${minSol > 0 ? `  min=${minSol} SOL` : ""}` +
      `${owner ? `  owner=${ownerLabel(owner, names)}` : ""}\n\n`,
  );
  rows.forEach((row, index) =>
    args.emit(`${tradeLine(row, index + 1, names)}\n`),
  );
}

function ownerSummaryLine(
  row: ReturnType<typeof analyzeTokenHistory>["owners"][number],
  names: Map<string, string>,
): string {
  return (
    `${ownerLabel(row.owner, names).padEnd(14)} ` +
    `buy=${fmtNumber(row.buySol)}  sell=${fmtNumber(row.sellSol)}  ` +
    `net=${fmtNumber(row.netSpentSol)} SOL  trades=${row.trades}`
  );
}

function pnlLine(
  row: ReturnType<
    typeof analyzeTokenHistoryForensicsFromStore
  >["ownedPnl"][number],
  names: Map<string, string>,
): string {
  const status = row.costBasisComplete ? "" : "  BASIS?";
  const roi =
    row.roiPct == null
      ? "-"
      : `${row.roiPct >= 0 ? "+" : ""}${row.roiPct.toFixed(1)}%`;
  return (
    `${ownerLabel(row.owner, names).padEnd(14)} ` +
    `real=${signedSol(row.realizedPnlSol).padStart(10)}  ` +
    `unreal=${signedSol(row.unrealizedPnlSol).padStart(10)}  ` +
    `total=${signedSol(row.totalPnlSol).padStart(10)}  ` +
    `costs=${fmtNumber(row.recordedExecutionCostsSol).padStart(9)}  ` +
    `net=${signedSol(row.netPnlAfterRecordedCostsSol).padStart(10)} SOL  ` +
    `roi=${roi}${status}`
  );
}

function runAnalyze(args: {
  slrd: Solard;
  mint: string;
  flags: TokenHistoryCliFlags;
  emit: Emit;
}): void {
  const names = aliases(args.slrd);
  const owned = [...names.keys()];
  const top = Math.max(
    1,
    Math.min(100, Math.trunc(numberFlag(args.flags, "top", 10) ?? 10)),
  );
  const first = Math.max(
    1,
    Math.min(100, Math.trunc(numberFlag(args.flags, "first", 20) ?? 20)),
  );
  const analysis = analyzeTokenHistory(args.mint, { ownedWallets: owned });
  const forensics = analyzeTokenHistoryForensicsFromStore(args.mint, {
    ownedWallets: owned,
    firstBuyerLimit: first,
    topLimit: top,
  });
  const trades = loadTokenHistoryTrades(args.mint);
  if (args.flags.has("json")) {
    args.emit(`${json({ analysis, forensics })}\n`);
    return;
  }

  const topBuyers = [...analysis.owners]
    .filter((row) => row.buySol > 0)
    .sort((a, b) => b.buySol - a.buySol)
    .slice(0, top);
  const largest = [...trades]
    .sort((a, b) => Math.abs(b.solDeltaUi) - Math.abs(a.solDeltaUi))
    .slice(0, top);

  args.emit(
    [
      "TOKEN HISTORICAL ANALYSIS",
      `Mint:             ${analysis.mint}`,
      `Coverage:         ${coverageText(analysis.coverage)}`,
      `Creation:         ${fmtDate(analysis.coverage?.creationAtMs ?? null)}`,
      `Curve:            ${analysis.coverage?.bondingCurve ?? "-"}`,
      `PumpSwap pool:    ${analysis.coverage?.pool ?? "-"}`,
      `Period:           ${fmtDate(analysis.firstTradeAtMs)} -> ${fmtDate(analysis.lastTradeAtMs)}`,
      "",
      `Trades:           ${analysis.trades} (${analysis.buys} buys / ${analysis.sells} sells)`,
      `Unique traders:   ${analysis.uniqueTraders}`,
      `Buy volume:       ${fmtNumber(analysis.buySol)} SOL`,
      `Sell volume:      ${fmtNumber(analysis.sellSol)} SOL`,
      `Net market flow:  ${fmtNumber(analysis.netInflowSol)} SOL`,
      `Round trips:      ${analysis.roundTripTraders} traders`,
      `ATH price:        ${analysis.athPriceSol == null ? "-" : fmtNumber(analysis.athPriceSol, 9)} SOL/token`,
      `ATL price:        ${analysis.atlPriceSol == null ? "-" : fmtNumber(analysis.atlPriceSol, 9)} SOL/token`,
      `ATH mcap:         ${analysis.athMarketCapSol == null ? "-" : `${fmtNumber(analysis.athMarketCapSol)} SOL`}`,
      `ATL mcap:         ${analysis.atlMarketCapSol == null ? "-" : `${fmtNumber(analysis.atlMarketCapSol)} SOL`}`,
      `Mark price:       ${forensics.markPriceSol == null ? "-" : `${fmtNumber(forensics.markPriceSol, 9)} SOL/token`}`,
    ].join("\n") + "\n",
  );

  args.emit("\nFIRST BUYERS / ON-CHAIN ORDER\n");
  args.emit(
    " rank  uniq  who             ours   createΔ   firstΔ  slotΔ       SOL  slot\n",
  );
  for (const row of forensics.firstBuyers) {
    args.emit(
      `${String(row.buyRank).padStart(5)}  ` +
        `${String(row.uniqueBuyerRank).padStart(4)}  ` +
        `${ownerLabel(row.trade.owner, names).padEnd(15)} ` +
        `${(row.owned ? "YES" : "-").padEnd(5)} ` +
        `${fmtDelta(row.creationDeltaMs).padStart(9)} ` +
        `${fmtDelta(row.firstBuyDeltaMs).padStart(8)} ` +
        `${String(row.slotDeltaFromFirstBuy ?? "-").padStart(6)}  ` +
        `${fmtNumber(Math.abs(row.trade.solDeltaUi)).padStart(8)}  ` +
        `${row.trade.slot}\n`,
    );
  }

  args.emit("\nOUR FIRST BUY / SNIPE POSITION\n");
  if (!forensics.ownedEntries.length) {
    args.emit("No stored wallet has a recorded buy in this tape.\n");
  } else {
    for (const row of forensics.ownedEntries) {
      args.emit(
        `${ownerLabel(row.owner, names).padEnd(14)} ` +
          `rank=${row.buyRank} unique=${row.uniqueBuyerRank ?? "-"}  ` +
          `createΔ=${fmtDelta(row.creationDeltaMs)} firstΔ=${fmtDelta(row.firstBuyDeltaMs)} ` +
          `slotΔ=${row.slotDeltaFromFirstBuy ?? "-"}  ` +
          `external-ahead=${row.externalBuysAhead}/${row.externalUniqueBuyersAhead} ` +
          `(${fmtNumber(row.externalBuySolAhead)} SOL)  ` +
          `same-sec-ahead=${row.sameTimestampBuysAhead} same-slot-ahead=${row.sameSlotBuysAhead}\n`,
      );
    }
    args.emit(
      "Note: blockTime is second-resolution. Same-second ordering is reliable from history order, but not millisecond latency.\n",
    );
  }

  args.emit("\nOUR P/L TOTAL\n");
  args.emit(
    `wallets=${forensics.ownedTotal.wallets}  ` +
      `buy=${fmtNumber(forensics.ownedTotal.buySol)}  sell=${fmtNumber(forensics.ownedTotal.sellSol)}  ` +
      `realized=${signedSol(forensics.ownedTotal.realizedPnlSol)}  ` +
      `unrealized=${signedSol(forensics.ownedTotal.unrealizedPnlSol)}  ` +
      `total=${signedSol(forensics.ownedTotal.totalPnlSol)}  ` +
      `recorded-costs=${fmtNumber(forensics.ownedTotal.recordedExecutionCostsSol)}  ` +
      `net=${signedSol(forensics.ownedTotal.netPnlAfterRecordedCostsSol)} SOL\n`,
  );
  if (forensics.ownedTotal.incompleteWallets) {
    args.emit(
      `WARNING: ${forensics.ownedTotal.incompleteWallets} stored wallet(s) have incomplete on-chain buy cost basis; their sells may include transferred-in tokens.\n`,
    );
  }

  args.emit("\nOUR P/L BY WALLET (FIFO)\n");
  if (!forensics.ownedPnl.length) args.emit("-\n");
  for (const row of forensics.ownedPnl) args.emit(`${pnlLine(row, names)}\n`);

  args.emit("\nTOP REALIZED WINNERS (complete recorded buy basis)\n");
  for (const row of forensics.topRealizedWinners)
    args.emit(`${pnlLine(row, names)}\n`);

  args.emit(
    "\nTOP MARKED WINNERS (realized + remaining inventory @ last exact price)\n",
  );
  for (const row of forensics.topTotalWinners)
    args.emit(`${pnlLine(row, names)}\n`);

  args.emit("\nTOP MARKED LOSERS\n");
  for (const row of forensics.topTotalLosers)
    args.emit(`${pnlLine(row, names)}\n`);

  args.emit("\nOUR REALIZED P/L BY PERIOD FROM CREATION\n");
  args.emit(
    " period     mkt-buy  mkt-sell   our-buy  our-sell  realized    costs      net\n",
  );
  for (const row of forensics.periods) {
    if (row.trades === 0 && row.ownedTrades === 0) continue;
    args.emit(
      `${row.label.padEnd(10)} ` +
        `${fmtNumber(row.buySol).padStart(8)} ` +
        `${fmtNumber(row.sellSol).padStart(9)} ` +
        `${fmtNumber(row.ownedBuySol).padStart(9)} ` +
        `${fmtNumber(row.ownedSellSol).padStart(9)} ` +
        `${signedSol(row.ownedRealizedPnlSol).padStart(9)} ` +
        `${fmtNumber(row.ownedRecordedExecutionCostsSol).padStart(8)} ` +
        `${signedSol(row.ownedNetRealizedAfterRecordedCostsSol).padStart(9)}\n`,
    );
  }

  args.emit("\nTOP BUYERS BY SOL\n");
  for (const row of topBuyers) args.emit(`${ownerSummaryLine(row, names)}\n`);
  args.emit("\nLARGEST TRADES\n");
  largest.forEach((row, index) =>
    args.emit(`${tradeLine(row, index + 1, names)}\n`),
  );
}

export async function runTokenHistoryCommand(args: {
  slrd: Solard;
  action: string;
  values: string[];
  flags: TokenHistoryCliFlags;
  emit: Emit;
}): Promise<void> {
  const mint = args.values[0]?.trim();
  if (!mint) {
    throw new Error(
      `Usage: slrd token ${args.action} <CA> ${
        args.action === "backfill"
          ? "[--exact|--materialize --price-sample-ms 1000] [--max-signatures N] [--json]"
          : args.action === "trades"
            ? "[--from-start] [--min-sol N] [--owner wallet] [--json]"
            : "[--top N] [--first N] [--json]"
      }`,
    );
  }
  if (args.action === "backfill") {
    await runBackfill({ ...args, mint });
    return;
  }
  if (args.action === "trades") {
    runTrades({ ...args, mint });
    return;
  }
  if (args.action === "analyze") {
    runAnalyze({ ...args, mint });
    return;
  }
  throw new Error("Usage: slrd token <backfill|trades|analyze> <CA>");
}
