import {
  getTerminalToken,
  getWatchedWallet,
  listProcessStatus,
  listWalletSwaps,
  listWalletTransactions,
  listWatchedWallets,
  resetWatchedWalletBackfill,
  upsertWatchedWallet,
  type WalletSwap,
  type WatchedWallet,
} from "../../../shared/db.js";

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
    {
      status,
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

    const quoteMint = swap.quoteMint || null;
    if (quoteMint && swap.inputMint === quoteMint) {
      current.spentQuoteUi += Math.abs(Number(swap.inputAmountUi) || 0);
    }
    if (quoteMint && swap.outputMint === quoteMint) {
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
    current.quoteMint = quoteMint ?? current.quoteMint;
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
  type WalletAggregate = {
    tradeCount: number;
    buyCount: number;
    sellCount: number;
    swapCount: number;
    copyableTrades: number;
    uniqueTokens: number;
    lastTradeAtMs: number | null;
    mints: Set<string>;
  };
  const stats = new Map<string, WalletAggregate>();

  for (const swap of swaps) {
    const current = stats.get(swap.wallet) ?? {
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      swapCount: 0,
      copyableTrades: 0,
      uniqueTokens: 0,
      lastTradeAtMs: null,
      mints: new Set<string>(),
    };
    current.tradeCount += 1;
    if (swap.side === "buy") current.buyCount += 1;
    if (swap.side === "sell") current.sellCount += 1;
    if (swap.side === "swap") current.swapCount += 1;
    current.copyableTrades += Number(swap.copyable) > 0 ? 1 : 0;
    current.mints.add(swap.subjectMint);
    current.uniqueTokens = current.mints.size;
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
      uniqueTokens: current?.uniqueTokens ?? 0,
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

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const wallet = text(url.searchParams.get("wallet")) || null;
    const mint = text(url.searchParams.get("mint")) || null;
    const side = sideValue(url.searchParams.get("side"));
    const sinceMs = Math.max(0, integer(url.searchParams.get("sinceMs"), 0));
    const limit = Math.max(
      1,
      Math.min(integer(url.searchParams.get("limit"), 250), 2_000),
    );
    const positionLimit = Math.max(
      limit,
      Math.min(integer(url.searchParams.get("positionLimit"), 10_000), 50_000),
    );

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
    const transactions = listWalletTransactions({
      wallet,
      sinceMs,
      limit: Math.max(limit, 1_000),
    });
    const processes = listProcessStatus(100);
    const worker =
      processes.find((row) =>
        /wallet/i.test(`${row.name ?? ""} ${row.kind ?? ""}`),
      ) ?? null;

    const summaries = walletSummaries(wallets, summarySwaps);
    const positions = positionRows(portfolioSwaps);
    const activeWallets = wallets.filter(
      (row) => Number(row.enabled) > 0,
    ).length;

    return response({
      wallets: summaries,
      swaps: recentSwaps,
      positions,
      worker,
      transactionStats: {
        total: transactions.length,
        parsed: transactions.filter((row) => row.parseStatus === "parsed")
          .length,
        ignored: transactions.filter((row) => row.parseStatus === "ignored")
          .length,
        errors: transactions.filter((row) => row.parseStatus === "error")
          .length,
        latestAtMs: transactions[0]?.tradedAtMs ?? null,
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
      generatedAtMs: Date.now(),
    });
  } catch (error) {
    return response(errorMessage(error), 400);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
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
    return response(errorMessage(error), 400);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    const body = await requestBody(request);
    const address = cleanAddress(body.address);
    const existing = getWatchedWallet(address);
    if (!existing) return response("Watched wallet not found.", 404);

    if (text(body.action) === "reindex") {
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
    return response(errorMessage(error), 400);
  }
}

/**
 * Removing a watched wallet is intentionally soft: historical observations stay
 * queryable while the realtime worker stops subscribing to the address.
 */
export async function DELETE(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    let address = text(url.searchParams.get("address"));
    if (!address) {
      const body = await requestBody(request);
      address = text(body.address);
    }
    address = cleanAddress(address);
    const existing = getWatchedWallet(address);
    if (!existing) return response("Watched wallet not found.", 404);
    const wallet = upsertWatchedWallet({
      ...existing,
      enabled: 0,
      updatedAtMs: Date.now(),
    });
    return response(wallet);
  } catch (error) {
    return response(errorMessage(error), 400);
  }
}
