import {
  getTerminalToken,
  getWatchedWallet,
  getWalletTransaction,
  listCopyTradeIntents,
  listCopyTradeProfiles,
  listProcessStatus,
  listWalletSwaps,
  listWalletTransactions,
  listWatchedWallets,
  requeueWalletTransaction,
  requeueWalletTransactions,
  resetWatchedWalletBackfill,
  upsertWatchedWallet,
  type WalletSwap,
  type WalletTransaction,
  type WatchedWallet,
} from "../../../shared/db.js";
import { assertWebAuth } from "../../../src/web/http.js";

type Side = "buy" | "sell" | "swap" | "unknown";

type TokenSummary = {
  mint: string;
  symbol: string;
  name: string;
  image: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
};

type DecoratedSwap = WalletSwap & {
  token: TokenSummary;
};

type WalletPosition = {
  wallet: string;
  mint: string;
  token: TokenSummary;
  quoteMint: string | null;
  netTokenUi: number;
  boughtTokenUi: number;
  soldTokenUi: number;
  spentQuoteUi: number;
  receivedQuoteUi: number;
  tradeCount: number;
  copyableTrades: number;
  lastSide: Side;
  lastTradeAtMs: number;
  lastPriceUsd: number | null;
  estimatedValueUsd: number | null;
};

type WalletSummary = WatchedWallet & {
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  swapCount: number;
  copyableTrades: number;
  uniqueTokens: number;
  lastTradeAtMs: number | null;
};

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function response(value: unknown, status = 200): Response {
  return Response.json(
    status >= 400 ? { ok: false, error: value } : { ok: true, value },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(error: unknown, fallback = 400): number {
  return typeof (error as { status?: unknown })?.status === "number"
    ? (error as { status: number }).status
    : fallback;
}

function integer(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  return ["1", "true", "yes", "on", "enabled"].includes(
    String(value).trim().toLowerCase(),
  );
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function cleanAddress(value: unknown): string {
  const address = text(value);
  if (!BASE58_ADDRESS.test(address)) {
    throw new Error("Enter a valid Solana wallet address.");
  }
  return address;
}

async function requestBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const parsed = await request.json();
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  }
  const form = await request.formData();
  return Object.fromEntries(form.entries());
}

function parseObject(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function tokenSummary(mint: string): TokenSummary {
  const token = getTerminalToken(mint);
  return {
    mint,
    symbol: text(token?.symbol),
    name: text(token?.name),
    image: text(token?.image) || null,
    priceUsd:
      token?.priceUsd != null && Number.isFinite(Number(token.priceUsd))
        ? Number(token.priceUsd)
        : null,
    marketCapUsd:
      token?.marketCapUsd != null && Number.isFinite(Number(token.marketCapUsd))
        ? Number(token.marketCapUsd)
        : null,
  };
}

function decorateSwaps(swaps: readonly WalletSwap[]): DecoratedSwap[] {
  const cache = new Map<string, TokenSummary>();
  return swaps.map((swap) => {
    let token = cache.get(swap.subjectMint);
    if (!token) {
      token = tokenSummary(swap.subjectMint);
      cache.set(swap.subjectMint, token);
    }
    return { ...swap, token };
  });
}

function positionRows(swaps: readonly DecoratedSwap[]): WalletPosition[] {
  const rows = new Map<string, WalletPosition>();
  for (const swap of [...swaps].sort(
    (left, right) => left.tradedAtMs - right.tradedAtMs,
  )) {
    const key = `${swap.wallet}:${swap.subjectMint}`;
    const current = rows.get(key) ?? {
      wallet: swap.wallet,
      mint: swap.subjectMint,
      token: swap.token,
      quoteMint: swap.quoteMint,
      netTokenUi: 0,
      boughtTokenUi: 0,
      soldTokenUi: 0,
      spentQuoteUi: 0,
      receivedQuoteUi: 0,
      tradeCount: 0,
      copyableTrades: 0,
      lastSide: "unknown" as Side,
      lastTradeAtMs: 0,
      lastPriceUsd: null,
      estimatedValueUsd: null,
    };

    let subjectDelta = 0;
    if (swap.outputMint === swap.subjectMint) {
      subjectDelta += Math.abs(Number(swap.outputAmountUi) || 0);
    }
    if (swap.inputMint === swap.subjectMint) {
      subjectDelta -= Math.abs(Number(swap.inputAmountUi) || 0);
    }
    if (swap.quoteMint && swap.inputMint === swap.quoteMint) {
      current.spentQuoteUi += Math.abs(Number(swap.inputAmountUi) || 0);
    }
    if (swap.quoteMint && swap.outputMint === swap.quoteMint) {
      current.receivedQuoteUi += Math.abs(Number(swap.outputAmountUi) || 0);
    }

    current.netTokenUi += subjectDelta;
    if (subjectDelta > 0) current.boughtTokenUi += subjectDelta;
    if (subjectDelta < 0) current.soldTokenUi += Math.abs(subjectDelta);
    current.tradeCount += 1;
    current.copyableTrades += Number(swap.copyable) > 0 ? 1 : 0;
    current.lastSide = swap.side;
    current.lastTradeAtMs = Math.max(current.lastTradeAtMs, swap.tradedAtMs);
    current.lastPriceUsd =
      swap.priceUsd ?? swap.token.priceUsd ?? current.lastPriceUsd;
    current.quoteMint = swap.quoteMint ?? current.quoteMint;
    current.token = swap.token;
    rows.set(key, current);
  }

  return [...rows.values()]
    .map((row) => ({
      ...row,
      estimatedValueUsd:
        row.lastPriceUsd != null
          ? Math.max(0, row.netTokenUi) * row.lastPriceUsd
          : null,
    }))
    .sort(
      (left, right) =>
        (right.estimatedValueUsd ?? -1) - (left.estimatedValueUsd ?? -1) ||
        right.lastTradeAtMs - left.lastTradeAtMs,
    );
}

function walletSummaries(
  wallets: readonly WatchedWallet[],
  swaps: readonly DecoratedSwap[],
): WalletSummary[] {
  const stats = new Map<
    string,
    {
      tradeCount: number;
      buyCount: number;
      sellCount: number;
      swapCount: number;
      copyableTrades: number;
      lastTradeAtMs: number | null;
      mints: Set<string>;
    }
  >();

  for (const swap of swaps) {
    const current = stats.get(swap.wallet) ?? {
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      swapCount: 0,
      copyableTrades: 0,
      lastTradeAtMs: null,
      mints: new Set<string>(),
    };
    current.tradeCount++;
    if (swap.side === "buy") current.buyCount++;
    if (swap.side === "sell") current.sellCount++;
    if (swap.side === "swap") current.swapCount++;
    current.copyableTrades += Number(swap.copyable) > 0 ? 1 : 0;
    current.mints.add(swap.subjectMint);
    current.lastTradeAtMs = Math.max(
      current.lastTradeAtMs ?? 0,
      swap.tradedAtMs,
    );
    stats.set(swap.wallet, current);
  }

  return wallets.map((wallet) => {
    const current = stats.get(wallet.address);
    return {
      ...wallet,
      tradeCount: current?.tradeCount ?? 0,
      buyCount: current?.buyCount ?? 0,
      sellCount: current?.sellCount ?? 0,
      swapCount: current?.swapCount ?? 0,
      copyableTrades: current?.copyableTrades ?? 0,
      uniqueTokens: current?.mints.size ?? 0,
      lastTradeAtMs: current?.lastTradeAtMs ?? null,
    };
  });
}

function sideValue(value: string | null): Side | null {
  return value === "buy" ||
    value === "sell" ||
    value === "swap" ||
    value === "unknown"
    ? value
    : null;
}

function statusValue(
  value: string | null,
): WalletTransaction["parseStatus"] | null {
  return value === "pending" ||
    value === "parsed" ||
    value === "ignored" ||
    value === "error"
    ? value
    : null;
}

function countBy<T>(
  values: readonly T[],
  read: (value: T) => string,
): Array<{
  key: string;
  count: number;
}> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = read(value) || "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.key.localeCompare(right.key),
    );
}

function workerStatus(): Record<string, unknown> | null {
  const processes = listProcessStatus(100);
  const row =
    processes.find((item) =>
      /wallet/i.test(`${item.name ?? ""} ${item.kind ?? ""}`),
    ) ?? null;
  if (!row) return null;
  return { ...row, data: parseObject(row.dataJson) };
}

export async function GET(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const url = new URL(request.url);
    const wallet = text(url.searchParams.get("wallet")) || null;
    const mint = text(url.searchParams.get("mint")) || null;
    const signature = text(url.searchParams.get("signature")) || null;
    const side = sideValue(url.searchParams.get("side"));
    const transactionStatus = statusValue(
      url.searchParams.get("transactionStatus"),
    );
    const sinceMs = Math.max(0, integer(url.searchParams.get("sinceMs"), 0));
    const limit = Math.max(
      1,
      Math.min(integer(url.searchParams.get("limit"), 250), 2_000),
    );
    const transactionLimit = Math.max(
      1,
      Math.min(integer(url.searchParams.get("transactionLimit"), 500), 5_000),
    );
    const positionLimit = Math.max(
      limit,
      Math.min(integer(url.searchParams.get("positionLimit"), 10_000), 50_000),
    );
    const includeTransactions = bool(
      url.searchParams.get("includeTransactions"),
      false,
    );
    const includeRaw = bool(url.searchParams.get("includeRaw"), false);

    const wallets = listWatchedWallets({ limit: 50_000 });
    const recentSwaps = decorateSwaps(
      listWalletSwaps({ wallet, mint, side, sinceMs, limit }),
    );
    const portfolioSwaps = decorateSwaps(
      listWalletSwaps({ wallet, limit: positionLimit }),
    );
    const summarySwaps = wallet
      ? decorateSwaps(listWalletSwaps({ limit: positionLimit }))
      : portfolioSwaps;
    const summaries = walletSummaries(wallets, summarySwaps);
    const positions = positionRows(portfolioSwaps);
    const activeWallets = wallets.filter(
      (row) => Number(row.enabled) > 0,
    ).length;

    const allTransactions = listWalletTransactions({
      wallet,
      sinceMs,
      limit: Math.max(transactionLimit, 1_000),
    });
    const transactions = transactionStatus
      ? allTransactions.filter((row) => row.parseStatus === transactionStatus)
      : allTransactions;
    const selectedTransaction =
      wallet && signature ? getWalletTransaction(wallet, signature) : null;
    const selectedSwaps =
      wallet && signature
        ? decorateSwaps(listWalletSwaps({ wallet, signature, limit: 100 }))
        : [];
    const profiles = wallet
      ? listCopyTradeProfiles({ leaderWallet: wallet, limit: 250 })
      : [];
    const intents = wallet
      ? listCopyTradeIntents({ leaderWallet: wallet, limit: 500 })
      : [];
    const swapCountByTransaction = new Map<string, number>();
    for (const swap of portfolioSwaps) {
      const key = `${swap.wallet}:${swap.signature}`;
      swapCountByTransaction.set(
        key,
        (swapCountByTransaction.get(key) ?? 0) + 1,
      );
    }

    return response({
      wallets: summaries,
      swaps: recentSwaps,
      positions,
      worker: workerStatus(),
      transactionStats: {
        total: allTransactions.length,
        pending: allTransactions.filter((row) => row.parseStatus === "pending")
          .length,
        parsed: allTransactions.filter((row) => row.parseStatus === "parsed")
          .length,
        ignored: allTransactions.filter((row) => row.parseStatus === "ignored")
          .length,
        errors: allTransactions.filter((row) => row.parseStatus === "error")
          .length,
        latestAtMs: allTransactions[0]?.tradedAtMs ?? null,
      },
      stats: {
        trackedWallets: wallets.length,
        activeWallets,
        pausedWallets: wallets.length - activeWallets,
        displayedTrades: recentSwaps.length,
        portfolioTrades: portfolioSwaps.length,
        copyableTrades: portfolioSwaps.filter((row) => Number(row.copyable) > 0)
          .length,
        uniqueTokens: new Set(portfolioSwaps.map((row) => row.subjectMint))
          .size,
      },
      diagnostics: {
        transactions: includeTransactions
          ? transactions.slice(0, transactionLimit).map((row) => ({
              ...row,
              rawJson: includeRaw ? row.rawJson : undefined,
              swapCount:
                swapCountByTransaction.get(`${row.wallet}:${row.signature}`) ??
                0,
            }))
          : undefined,
        parseStatuses: countBy(allTransactions, (row) => row.parseStatus),
        parserVersions: countBy(allTransactions, (row) => row.parserVersion),
        swapParsers: countBy(portfolioSwaps, (row) => row.parser),
        venues: countBy(portfolioSwaps, (row) => row.venue),
        confidence: countBy(
          portfolioSwaps,
          (row) => row.classificationConfidence,
        ),
        errors: allTransactions
          .filter((row) => row.parseStatus === "error")
          .slice(0, 20)
          .map((row) => ({
            wallet: row.wallet,
            signature: row.signature,
            error: row.error,
            tradedAtMs: row.tradedAtMs,
          })),
        selectedTransaction: selectedTransaction
          ? {
              ...selectedTransaction,
              rawJson: includeRaw ? selectedTransaction.rawJson : undefined,
              swaps: selectedSwaps,
            }
          : null,
        copyProfiles: profiles,
        copyIntents: intents,
      },
      generatedAtMs: Date.now(),
    });
  } catch (error) {
    return response(errorMessage(error), errorStatus(error));
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const body = await requestBody(request);
    const address = cleanAddress(body.address);
    const wallet = upsertWatchedWallet({
      address,
      label: text(body.label) || null,
      enabled: bool(body.enabled, true) ? 1 : 0,
      backfillEnabled: bool(body.backfillEnabled, true) ? 1 : 0,
      updatedAtMs: Date.now(),
    });
    return response(wallet, 201);
  } catch (error) {
    return response(errorMessage(error), errorStatus(error));
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const body = await requestBody(request);
    const action = text(body.action);
    const address = cleanAddress(body.address);
    const existing = getWatchedWallet(address);
    if (!existing) return response("Watched wallet not found.", 404);

    if (action === "reindex") {
      const reset = resetWatchedWalletBackfill(address);
      return response(
        upsertWatchedWallet({
          ...reset,
          enabled: 1,
          backfillEnabled: 1,
          updatedAtMs: Date.now(),
        }),
      );
    }

    if (action === "reparse") {
      const signature = text(body.signature);
      if (!signature) throw new Error("Transaction signature is required.");
      return response({
        transaction: requeueWalletTransaction({
          wallet: address,
          signature,
          deleteSwaps: bool(body.deleteSwaps, true),
        }),
      });
    }

    if (action === "reparse-errors" || action === "reparse-ignored") {
      const parseStatuses: WalletTransaction["parseStatus"][] =
        action === "reparse-errors" ? ["error"] : ["ignored"];
      return response(
        requeueWalletTransactions({
          wallet: address,
          parseStatuses,
          limit: Math.max(1, Math.min(integer(body.limit, 500), 5_000)),
          deleteSwaps: bool(body.deleteSwaps, true),
        }),
      );
    }

    const wallet = upsertWatchedWallet({
      ...existing,
      address,
      label: Object.prototype.hasOwnProperty.call(body, "label")
        ? text(body.label) || null
        : existing.label,
      enabled: Object.prototype.hasOwnProperty.call(body, "enabled")
        ? bool(body.enabled, Number(existing.enabled) > 0)
          ? 1
          : 0
        : existing.enabled,
      backfillEnabled: Object.prototype.hasOwnProperty.call(
        body,
        "backfillEnabled",
      )
        ? bool(body.backfillEnabled, Number(existing.backfillEnabled) > 0)
          ? 1
          : 0
        : existing.backfillEnabled,
      updatedAtMs: Date.now(),
    });
    return response(wallet);
  } catch (error) {
    return response(errorMessage(error), errorStatus(error));
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const url = new URL(request.url);
    let address = text(url.searchParams.get("address"));
    if (!address) {
      const body = await requestBody(request);
      address = text(body.address);
    }
    address = cleanAddress(address);
    const existing = getWatchedWallet(address);
    if (!existing) return response("Watched wallet not found.", 404);
    return response(
      upsertWatchedWallet({
        ...existing,
        enabled: 0,
        updatedAtMs: Date.now(),
      }),
    );
  } catch (error) {
    return response(errorMessage(error), errorStatus(error));
  }
}
