import { resolve } from "node:path";
import { Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { pathToFileURL } from "node:url";
import {
  getTokenHistoryCoverage,
  loadTokenHistoryTrades,
  parsePumpHistoryTransaction,
  type TokenHistoryTrade,
} from "@solard/core";
import {
  SolanaTokenHistoryRpc,
  normalizeTokenHistoryRpcOptions,
} from "@solard/core/chain/token-history.ts";

import {
  cacheResearchTransactions,
  cachedResearchTransactions,
  loadResearchHistoryIndex,
  researchHistoryCachePath,
  researchHistoryMeta,
  type ResearchHistorySignature,
} from "./research-history-cache.ts";

import type {
  StrategyExecution,
  StrategyPosition,
  StrategyPriceTick,
  StrategyTrade,
  TradeStrategy,
  TradeStrategyContext,
} from "./trade-strategy-command.ts";

type Flags = Map<string, string>;
type Emit = (value: string) => void;

type ReplayEvent = {
  trade: StrategyTrade;
  price: StrategyPriceTick;
  priceSol: number;
};

type BacktestExecution = StrategyExecution & {
  signalAtMs: number;
  fillAtMs: number | null;
  fillPriceSol: number | null;
  cashAfterSol: number;
  tokenAfterUi: number;
};

type BacktestNotice = {
  atMs: number;
  kind: "notify" | "log";
  message: string;
  data: unknown;
};

function flag(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return value && value !== "true" ? value : undefined;
}

function numberFlag(flags: Flags, key: string, fallback: number): number {
  const value = flag(flags, key);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key}: ${value}`);
  return parsed;
}

function durationMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const scale = ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const)[
    (match[2]?.toLowerCase() ?? "ms") as "ms" | "s" | "m" | "h"
  ];
  return Math.max(1, Math.trunc(Number(match[1]) * scale));
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    return parsed < 10_000_000_000 ? parsed * 1_000 : parsed;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid time: ${value}`);
  return parsed;
}

function params(flags: Flags): Record<string, unknown> {
  const raw = flag(flags, "params");
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("--params must be a JSON object");
  return parsed as Record<string, unknown>;
}

async function loadStrategy(path: string): Promise<TradeStrategy<any>> {
  const absolute = resolve(path);
  const module = await import(
    `${pathToFileURL(absolute).href}?backtest=${Date.now()}`
  );
  const strategy = (module.default ?? module.strategy) as
    TradeStrategy<any> | undefined;
  if (!strategy || typeof strategy !== "object")
    throw new Error(
      `Strategy ${absolute} must default-export a strategy object`,
    );
  if (
    typeof strategy.onPrice !== "function" &&
    typeof strategy.onTrade !== "function"
  )
    throw new Error(`Strategy ${absolute} must define onPrice() or onTrade()`);
  return strategy;
}

function asEvent(row: TokenHistoryTrade): ReplayEvent | null {
  const priceSol = Number(row.priceSol);
  if (!(priceSol > 0) || !Number.isFinite(priceSol)) return null;
  const tokenAmountUi = Math.abs(Number(row.tokenDeltaUi));
  const quoteAmountUi = Math.abs(Number(row.solDeltaUi));
  const trade: StrategyTrade = {
    id: row.eventKey,
    signature: row.signature,
    slot: row.slot,
    atMs: row.tradedAtMs,
    mint: row.mint,
    venue: row.history?.venue ?? row.source,
    side: row.side,
    trader: row.owner ?? "",
    isMine: false,
    tokenAmountRaw: 0n,
    tokenAmountUi,
    quote: "SOL",
    quoteAmountUi,
    priceSol,
    priceUsd: row.priceUsd,
    marketCapUsd: row.marketCapUsd,
  };
  return {
    trade,
    price: {
      signature: row.signature,
      slot: row.slot,
      atMs: row.tradedAtMs,
      mint: row.mint,
      priceSol,
      priceUsd: row.priceUsd,
      marketCapUsd: row.marketCapUsd,
    },
    priceSol,
  };
}

function coalescePriceEvents(
  events: ReplayEvent[],
  sampleMs: number,
): ReplayEvent[] {
  const buckets = new Map<number, ReplayEvent>();
  for (const event of events) {
    const bucket = Math.floor(event.price.atMs / sampleMs) * sampleMs;
    const existing = buckets.get(bucket);
    if (!existing || event.price.atMs >= existing.price.atMs)
      buckets.set(bucket, event);
  }
  return [...buckets.values()].sort(
    (a, b) => a.price.atMs - b.price.atMs || a.price.slot - b.price.slot,
  );
}

function rpcEndpoint(flags: Flags): string {
  const value =
    flag(flags, "rpc") ??
    process.env.RPC_ENDPOINT?.trim() ??
    process.env.SOLANA_RPC_URL?.trim() ??
    process.env.HELIUS_RPC_URL?.trim();
  if (!value)
    throw new Error(
      "Lazy strategy backtest requires RPC_ENDPOINT, SOLANA_RPC_URL, HELIUS_RPC_URL, or --rpc <url>",
    );
  return value;
}

function asRpcRows(rows: readonly ResearchHistorySignature[]) {
  return rows.map((row) => ({
    signature: row.signature,
    slot: row.slot,
    blockTime: row.blockTime,
    err: null,
    memo: null,
    confirmationStatus: "finalized" as const,
    scanKind: row.scanKind,
    scanAddress: row.scanAddress,
    localChronologicalOrder: row.localChronologicalOrder,
  }));
}

async function hydrateResearchTransactions(args: {
  rows: readonly ResearchHistorySignature[];
  flags: Flags;
}): Promise<Map<string, ParsedTransactionWithMeta>> {
  const signatures = args.rows.map((row) => row.signature);
  const cached = cachedResearchTransactions(signatures);
  const missing = args.rows.filter((row) => !cached.has(row.signature));
  if (!missing.length) return cached;
  process.stderr.write(
    `CACHE  hit=${cached.size} miss=${missing.length} path=${researchHistoryCachePath()}\n`,
  );
  const connection = new Connection(rpcEndpoint(args.flags), "confirmed");
  const rpc = new SolanaTokenHistoryRpc(connection);
  const fetched = await rpc.fetchTransactions(
    asRpcRows(missing),
    normalizeTokenHistoryRpcOptions({
      commitment: args.flags.has("confirmed") ? "confirmed" : "finalized",
      transactionBatchSize: Math.max(
        1,
        Math.min(100, Math.trunc(numberFlag(args.flags, "batch-size", 100))),
      ),
      transactionConcurrency: Math.max(
        1,
        Math.min(5, Math.trunc(numberFlag(args.flags, "rpc-concurrency", 2))),
      ),
      rpcTimeoutMs: Math.max(
        1_000,
        Math.trunc(numberFlag(args.flags, "rpc-timeout-ms", 20_000)),
      ),
      rpcRetries: Math.max(
        0,
        Math.trunc(numberFlag(args.flags, "rpc-retries", 2)),
      ),
      retryDelayMs: Math.max(
        100,
        Math.trunc(numberFlag(args.flags, "retry-delay-ms", 750)),
      ),
      onProgress: (row) => {
        if (
          row.phase === "transactions" &&
          (row.completed === row.total || row.completed % 500 === 0)
        )
          process.stderr.write(`TX     ${row.completed}/${row.total}\n`);
        if (row.phase === "retry")
          process.stderr.write(
            `RETRY  ${row.attempt}/${row.maxAttempts} ${row.error}\n`,
          );
      },
    }),
  );
  cacheResearchTransactions(
    fetched.bySignature,
    args.flags.has("confirmed") ? "confirmed" : "finalized",
  );
  for (const [signature, tx] of fetched.bySignature) cached.set(signature, tx);
  return cached;
}

function applyHistoricalUsd(
  row: TokenHistoryTrade,
  solUsd: number | null,
): TokenHistoryTrade {
  if (!(solUsd != null && solUsd > 0)) return row;
  const priceSol = Number(row.priceSol);
  const marketCapSol = Number(row.history?.marketCapSol);
  return {
    ...row,
    priceUsd:
      Number.isFinite(priceSol) && priceSol > 0 ? priceSol * solUsd : null,
    marketCapUsd:
      Number.isFinite(marketCapSol) && marketCapSol > 0
        ? marketCapSol * solUsd
        : null,
  };
}

function parseResearchTransaction(args: {
  mint: string;
  row: ResearchHistorySignature;
  tx: ParsedTransactionWithMeta;
  decimals: number;
  supplyUi: number;
  solUsd: number | null;
}): TokenHistoryTrade[] {
  const result = parsePumpHistoryTransaction({
    tx: args.tx,
    signature: args.row.signature,
    mint: args.mint,
    decimals: args.decimals,
    supplyUi: args.supplyUi,
    historyOrder: args.row.localChronologicalOrder,
    scanAddress: args.row.scanAddress,
    scanKind: args.row.scanKind,
    confidence: "finalized",
    updatedAtMs:
      args.tx.blockTime == null ? Date.now() : args.tx.blockTime * 1_000,
  });
  return result.trades.map((row) => applyHistoricalUsd(row, args.solUsd));
}

async function lazyResearchTrades(args: {
  mint: string;
  strategy: TradeStrategy<any>;
  flags: Flags;
  fromMs?: number;
  toMs?: number;
}): Promise<{
  rows: TokenHistoryTrade[];
  indexed: number;
  requested: number;
  cachePath: string;
}> {
  const meta = researchHistoryMeta(args.mint);
  if (!meta)
    throw new Error(
      `No research signature index for ${args.mint}. Run: slrd token backfill ${args.mint}`,
    );
  const indexed = loadResearchHistoryIndex(args.mint, {
    fromMs: args.fromMs,
    toMs: args.toMs,
  });
  if (!indexed.length)
    throw new Error(
      `Research index contains no signatures for requested window`,
    );
  const exact =
    args.strategy.history?.mode === "exact" || Boolean(args.strategy.onTrade);
  const sampleMs = exact
    ? 0
    : durationMs(
        flag(args.flags, "price-sample"),
        Math.max(1_000, Math.trunc(args.strategy.history?.sampleMs ?? 1_000)),
      );
  const solUsd =
    flag(args.flags, "sol-usd") == null
      ? null
      : numberFlag(args.flags, "sol-usd", 0);

  if (exact) {
    const txs = await hydrateResearchTransactions({
      rows: indexed,
      flags: args.flags,
    });
    const rows: TokenHistoryTrade[] = [];
    for (const row of indexed) {
      const tx = txs.get(row.signature);
      if (!tx) continue;
      rows.push(
        ...parseResearchTransaction({
          ...args,
          row,
          tx,
          decimals: meta.decimals,
          supplyUi: meta.supplyUi,
          solUsd,
        }),
      );
    }
    return {
      rows,
      indexed: indexed.length,
      requested: indexed.length,
      cachePath: researchHistoryCachePath(),
    };
  }

  const buckets = new Map<number, ResearchHistorySignature[]>();
  for (const row of indexed) {
    if (row.blockTime == null) continue;
    const bucket = Math.floor((row.blockTime * 1_000) / sampleMs);
    const list = buckets.get(bucket) ?? [];
    list.push(row);
    buckets.set(bucket, list);
  }
  for (const list of buckets.values())
    list.sort(
      (a, b) =>
        b.slot - a.slot ||
        b.localChronologicalOrder - a.localChronologicalOrder ||
        b.signature.localeCompare(a.signature),
    );

  const unresolved = new Map(buckets);
  const chosen: TokenHistoryTrade[] = [];
  let requested = 0;
  let depth = 0;
  while (unresolved.size) {
    const candidates: ResearchHistorySignature[] = [];
    for (const list of unresolved.values()) {
      const row = list[depth];
      if (row) candidates.push(row);
    }
    if (!candidates.length) break;
    requested += candidates.length;
    const txs = await hydrateResearchTransactions({
      rows: candidates,
      flags: args.flags,
    });
    for (const [bucket, list] of [...unresolved]) {
      const row = list[depth];
      if (!row) {
        unresolved.delete(bucket);
        continue;
      }
      const tx = txs.get(row.signature);
      if (!tx) continue;
      const parsed = parseResearchTransaction({
        mint: args.mint,
        row,
        tx,
        decimals: meta.decimals,
        supplyUi: meta.supplyUi,
        solUsd,
      }).filter((trade) => Number(trade.priceSol) > 0);
      if (parsed.length) {
        chosen.push(parsed.at(-1)!);
        unresolved.delete(bucket);
      }
    }
    depth += 1;
  }
  chosen.sort((a, b) => a.tradedAtMs - b.tradedAtMs || a.slot - b.slot);
  process.stderr.write(
    `LAZY   sample=${sampleMs}ms buckets=${buckets.size} hydrated=${requested} prices=${chosen.length}\n`,
  );
  return {
    rows: chosen,
    indexed: indexed.length,
    requested,
    cachePath: researchHistoryCachePath(),
  };
}

function cloneState<State>(value: State): State {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as State;
}

function fmtPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export async function runStrategyBacktestCommand(args: {
  values: string[];
  flags: Flags;
  emit: Emit;
}): Promise<void> {
  const file = args.values[1];
  if (!file)
    throw new Error(
      "Usage: slrd strategy backtest <file.ts> --token <mint> [--params <json>] [--capital-sol 1] [--price-sample 500ms] [--json]",
    );
  const mint = flag(args.flags, "token") ?? flag(args.flags, "mint");
  if (!mint) throw new Error("strategy backtest requires --token <mint>");

  const strategy = await loadStrategy(file);
  const coverage = getTokenHistoryCoverage(mint);
  const indexedMeta = researchHistoryMeta(mint);
  const fromMs = parseTime(flag(args.flags, "from"));
  const toMs = parseTime(flag(args.flags, "to"));
  if (
    args.flags.has("require-from-start") &&
    !(indexedMeta?.fromCreation || coverage?.complete)
  )
    throw new Error(
      `History for ${mint} is not indexed from creation; run token backfill first`,
    );

  const lazy = indexedMeta
    ? await lazyResearchTrades({
        mint,
        strategy,
        flags: args.flags,
        fromMs,
        toMs,
      })
    : null;
  const rawRows = (lazy?.rows ?? loadTokenHistoryTrades(mint))
    .filter((row) => row.confidence !== "dropped")
    .filter((row) => fromMs == null || row.tradedAtMs >= fromMs)
    .filter((row) => toMs == null || row.tradedAtMs <= toMs)
    .sort((a, b) => a.tradedAtMs - b.tradedAtMs || a.slot - b.slot);
  const exact = rawRows
    .map(asEvent)
    .filter((row): row is ReplayEvent => row != null);
  if (exact.length < 2)
    throw new Error(
      `Need at least two usable historical trades for ${mint}; run: slrd token backfill ${mint}`,
    );

  const priceSampleMs = durationMs(
    flag(args.flags, "price-sample"),
    Math.max(1_000, Math.trunc(strategy.history?.sampleMs ?? 1_000)),
  );
  const replay = strategy.onTrade
    ? exact
    : coalescePriceEvents(exact, priceSampleMs);
  const inputParams = params(args.flags);
  const initialState =
    typeof strategy.state === "function"
      ? await strategy.state()
      : strategy.state == null
        ? {}
        : cloneState(strategy.state);

  const startingSol = numberFlag(args.flags, "capital-sol", 1);
  const slippageBps = Math.max(0, numberFlag(args.flags, "slippage-bps", 500));
  const venueFeeBps = Math.max(0, numberFlag(args.flags, "venue-fee-bps", 0));
  const networkFeeSol = Math.max(
    0,
    numberFlag(args.flags, "network-fee-sol", 0.00001),
  );
  let cashSol = startingSol;
  let tokenUi = 0;
  let stopped = false;
  let stopReason = "end-of-history";
  let currentIndex = -1;
  let priceCount = 0;
  let tradeCount = 0;
  let lastPrice: StrategyPriceTick | null = null;
  let lastTrade: StrategyTrade | null = null;
  const executions: BacktestExecution[] = [];
  const notices: BacktestNotice[] = [];

  const currentEvent = () => replay[Math.max(0, currentIndex)]!;
  const fillEvent = () => replay[currentIndex + 1] ?? null;
  const position = (): StrategyPosition => ({
    tokenRaw:
      tokenUi > 0 ? BigInt(Math.max(1, Math.floor(tokenUi * 1_000_000))) : 0n,
    tokenUi,
    tokenDecimals: null,
    solLamports: BigInt(Math.max(0, Math.floor(cashSol * 1_000_000_000))),
    sol: cashSol,
  });

  const execute = async (
    side: "buy" | "sell",
    requested: number,
    reason: string | undefined,
  ): Promise<StrategyExecution> => {
    const signal = currentEvent();
    const fill = fillEvent();
    const degradation = (slippageBps + venueFeeBps) / 10_000;
    let signature: string | null = null;
    let fillPriceSol: number | null = null;
    let fillAtMs: number | null = null;
    if (fill) {
      fillPriceSol =
        side === "buy"
          ? fill.priceSol * (1 + degradation)
          : fill.priceSol * Math.max(0, 1 - degradation);
      fillAtMs = fill.price.atMs;
      signature = fill.price.signature;
      if (side === "buy") {
        const spend = Math.min(
          Math.max(0, requested),
          Math.max(0, cashSol - networkFeeSol),
        );
        if (spend > 0 && fillPriceSol > 0) {
          cashSol -= spend + networkFeeSol;
          tokenUi += spend / fillPriceSol;
        }
      } else {
        const pct = Math.max(0, Math.min(100, requested));
        const sold = tokenUi * (pct / 100);
        if (sold > 0 && fillPriceSol > 0) {
          tokenUi -= sold;
          cashSol += sold * fillPriceSol - networkFeeSol;
        }
      }
    }
    const execution: BacktestExecution = {
      live: false,
      side,
      requested,
      reason: reason ?? null,
      venue: fill?.trade.venue ?? null,
      signature,
      tokenDeltaRaw: null,
      solDeltaLamports: null,
      completedAt: fillAtMs ?? signal.price.atMs,
      signalAtMs: signal.price.atMs,
      fillAtMs,
      fillPriceSol,
      cashAfterSol: cashSol,
      tokenAfterUi: tokenUi,
    };
    executions.push(execution);
    return execution;
  };

  const ctx: TradeStrategyContext<any> = {
    mint,
    wallet: "backtest",
    walletAddress: "backtest",
    live: false,
    state: initialState,
    params: inputParams,
    get priceCount() {
      return priceCount;
    },
    get lastPrice() {
      return lastPrice;
    },
    get tradeCount() {
      return tradeCount;
    },
    get lastTrade() {
      return lastTrade;
    },
    buy: ({ sol, reason }) => execute("buy", sol, reason),
    sell: ({ percent, reason }) => execute("sell", percent, reason),
    position: async () => position(),
    samplePrice: async () => ({
      price: currentEvent().priceSol,
      venue: currentEvent().trade.venue,
    }),
    log: (message, data) =>
      notices.push({
        atMs: currentEvent()?.price.atMs ?? Date.now(),
        kind: "log",
        message,
        data: data ?? null,
      }),
    notify: (message, data) =>
      notices.push({
        atMs: currentEvent()?.price.atMs ?? Date.now(),
        kind: "notify",
        message,
        data: data ?? null,
      }),
    stop: (reason) => {
      stopped = true;
      stopReason = reason ?? "strategy-stop";
    },
  };

  if (strategy.onStart) await strategy.onStart(ctx);
  for (
    currentIndex = 0;
    currentIndex < replay.length && !stopped;
    currentIndex += 1
  ) {
    const event = replay[currentIndex]!;
    try {
      lastPrice = event.price;
      priceCount += 1;
      if (strategy.onPrice) await strategy.onPrice(ctx, event.price);
      if (strategy.onTrade) {
        lastTrade = event.trade;
        tradeCount += 1;
        await strategy.onTrade(ctx, event.trade);
      }
    } catch (error) {
      if (strategy.onError) await strategy.onError(ctx, error, lastTrade);
      else throw error;
    }
  }
  if (strategy.onStop) await strategy.onStop(ctx, stopReason);

  const finalPrice = replay.at(-1)!.priceSol;
  const finalEquitySol = cashSol + tokenUi * finalPrice;
  const returnPct =
    startingSol > 0 ? (finalEquitySol / startingSol - 1) * 100 : 0;
  const notifications = notices.filter((row) => row.kind === "notify");
  const result = {
    strategy: strategy.name ?? file,
    mint,
    coverage,
    researchCache: lazy
      ? {
          path: lazy.cachePath,
          indexed: lazy.indexed,
          hydratedRequested: lazy.requested,
        }
      : null,
    source: strategy.onTrade ? "exact-trades" : "coalesced-price",
    priceSampleMs: strategy.onTrade ? null : priceSampleMs,
    rawTrades: rawRows.length,
    usableTrades: exact.length,
    replayEvents: replay.length,
    coalescedAway: strategy.onTrade ? 0 : exact.length - replay.length,
    range: {
      from: new Date(replay[0]!.price.atMs).toISOString(),
      to: new Date(replay.at(-1)!.price.atMs).toISOString(),
    },
    params: inputParams,
    executionAssumptions: {
      slippageBps,
      venueFeeBps,
      networkFeeSol,
      fill: "next-observable-event",
    },
    summary: {
      startingSol,
      endingCashSol: cashSol,
      endingTokenUi: tokenUi,
      finalPriceSol: finalPrice,
      finalEquitySol,
      returnPct,
      buys: executions.filter((row) => row.side === "buy" && row.signature)
        .length,
      sells: executions.filter((row) => row.side === "sell" && row.signature)
        .length,
      notifications: notifications.length,
      stopped,
      stopReason,
    },
    notifications,
    executions,
    finalState: ctx.state,
  };

  if (args.flags.has("json")) {
    args.emit(
      `${JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`,
    );
    return;
  }

  args.emit(
    `STRATEGY BACKTEST\n` +
      `strategy=${result.strategy}\n` +
      `mint=${mint}\n` +
      `source=${result.source}${result.priceSampleMs ? ` sample=${result.priceSampleMs}ms` : ""}\n` +
      `${result.researchCache ? `cache=${result.researchCache.path} indexed=${result.researchCache.indexed} requested=${result.researchCache.hydratedRequested}\n` : ""}` +
      `history=${result.rawTrades} trades, replay=${result.replayEvents}, coalesced=${result.coalescedAway}\n` +
      `range=${result.range.from} -> ${result.range.to}\n` +
      `notifications=${result.summary.notifications} buys=${result.summary.buys} sells=${result.summary.sells}\n` +
      `equity=${result.summary.finalEquitySol.toFixed(6)} SOL return=${fmtPct(result.summary.returnPct)}\n`,
  );
  for (const notice of notifications.slice(0, 50)) {
    args.emit(
      `${new Date(notice.atMs).toISOString()} ALERT ${notice.message} ${notice.data == null ? "" : JSON.stringify(notice.data)}\n`,
    );
  }
  if (notifications.length > 50)
    args.emit(
      `... ${notifications.length - 50} more notifications; use --json for all\n`,
    );
}
