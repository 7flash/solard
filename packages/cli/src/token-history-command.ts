import type { Solard } from "@solard/sdk";
import {
  analyzeTokenHistory,
  backfillTokenHistory,
  getTokenHistoryCoverage,
  loadTokenHistoryTrades,
  type TokenHistoryTrade,
} from "@solard/sdk";

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
  const venue = row.history.venue === "pumpswap" ? "AMM" : "CURVE";
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

async function runBackfill(args: {
  slrd: Solard;
  mint: string;
  flags: TokenHistoryCliFlags;
  emit: Emit;
}): Promise<void> {
  const jsonMode = args.flags.has("json");
  const progress = (line: string) => {
    if (!jsonMode) process.stderr.write(`${line}\n`);
  };
  progress(`TOKEN BACKFILL  ${args.mint}`);
  const result = await backfillTokenHistory(args.slrd.connection(), args.mint, {
    commitment: args.flags.has("confirmed") ? "confirmed" : "finalized",
    pageSize: numberFlag(args.flags, "page-size", 1_000),
    transactionBatchSize: numberFlag(args.flags, "batch-size", 25),
    rpcTimeoutMs: numberFlag(args.flags, "rpc-timeout-ms", 30_000),
    rpcRetries: numberFlag(args.flags, "rpc-retries", 2),
    retryDelayMs: numberFlag(args.flags, "retry-delay-ms", 750),
    maxSignaturesPerAddress: numberFlag(args.flags, "max-signatures", 0),
    replace: args.flags.has("replace"),
    onProgress: (row) => {
      if (row.phase === "signatures") {
        if (row.pages === 1 || row.pages % 5 === 0) {
          progress(
            `SIGS   ${row.kind.padEnd(5)} pages=${row.pages} signatures=${row.signatures}`,
          );
        }
      } else if (row.phase === "transactions") {
        if (row.completed === 0 || row.completed % 250 === 0) {
          progress(
            `TX     ${Math.min(row.completed + row.batchSize, row.total)}/${row.total}`,
          );
        }
      } else if (row.phase === "store") {
        if (row.completed === row.total || row.completed % 1_000 === 0) {
          progress(
            `STORE  ${row.completed}/${row.total} inserted=${row.inserted} updated=${row.updated}`,
          );
        }
      }
    },
  });
  if (jsonMode) {
    args.emit(`${json(result)}\n`);
    return;
  }
  args.emit(
    [
      "",
      "TOKEN HISTORY BACKFILL",
      `Mint:              ${result.mint}`,
      `Coverage:          ${coverageText(result)}`,
      `Creation:          ${fmtDate(result.creationAtMs)} ${result.creationSignature ? compact(result.creationSignature, 10, 10) : "-"}`,
      `Bonding curve:     ${result.bondingCurve}`,
      `PumpSwap pool:     ${result.pool ?? "not observed / not graduated"}`,
      `Signatures:        ${result.uniqueSignatures}`,
      `Parsed tx:         ${result.parsedTransactions}`,
      `Missing tx:        ${result.missingTransactions}`,
      `Failed tx lookups: ${result.failedTransactions}`,
      `Stored trades:     ${result.storedTrades}`,
      `Inserted/updated:  ${result.insertedTrades}/${result.updatedTrades}`,
      `Ambiguous skipped: ${result.skippedAmbiguous}`,
      "",
      result.complete
        ? "READY: durable tape is proven complete from creation."
        : "WARNING: tape is not proven complete; inspect the gaps above before strict backtesting.",
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

function runAnalyze(args: {
  slrd: Solard;
  mint: string;
  flags: TokenHistoryCliFlags;
  emit: Emit;
}): void {
  const names = aliases(args.slrd);
  const owned = [...names.keys()];
  const analysis = analyzeTokenHistory(args.mint, { ownedWallets: owned });
  const trades = loadTokenHistoryTrades(args.mint);
  const top = Math.max(
    1,
    Math.min(100, Math.trunc(numberFlag(args.flags, "top", 10) ?? 10)),
  );
  if (args.flags.has("json")) {
    args.emit(`${json(analysis)}\n`);
    return;
  }

  const topBuyers = [...analysis.owners]
    .filter((row) => row.buySol > 0)
    .sort((a, b) => b.buySol - a.buySol)
    .slice(0, top);
  const topSellers = [...analysis.owners]
    .filter((row) => row.sellSol > 0)
    .sort((a, b) => b.sellSol - a.sellSol)
    .slice(0, top);
  const ours = analysis.owners.filter((row) => names.has(row.owner));
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
      `First external:   ${analysis.firstExternalBuyer ? `${ownerLabel(analysis.firstExternalBuyer.owner, names)} ${fmtDate(analysis.firstExternalBuyer.tradedAtMs)} ${fmtNumber(analysis.firstExternalBuyer.solDeltaUi)} SOL` : "-"}`,
    ].join("\n") + "\n",
  );

  if (ours.length) {
    args.emit("\nOUR STORED WALLETS\n");
    for (const row of ours) args.emit(`${ownerSummaryLine(row, names)}\n`);
  }
  args.emit("\nTOP BUYERS\n");
  for (const row of topBuyers) args.emit(`${ownerSummaryLine(row, names)}\n`);
  args.emit("\nTOP SELLERS\n");
  for (const row of topSellers) args.emit(`${ownerSummaryLine(row, names)}\n`);
  args.emit("\nEARLIEST TRADES\n");
  trades
    .slice(0, top)
    .forEach((row, index) =>
      args.emit(`${tradeLine(row, index + 1, names)}\n`),
    );
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
          ? "[--replace] [--confirmed] [--json]"
          : args.action === "trades"
            ? "[--from-start] [--min-sol N] [--owner wallet] [--json]"
            : "[--top N] [--json]"
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
