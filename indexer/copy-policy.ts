import {
  getCopyTradeTokenContext,
  type CopyTradeProfile,
  type CopyTradeTokenContext,
  type WalletSwap,
} from "../shared/db.js";
import type {
  CopyTradeDecision,
  CopyTradeGatewayRequest,
} from "./copy-types.js";

function parseSet(value: string, lowerCase = false): Set<string> {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .map((item) => String(item).trim())
        .filter(Boolean)
        .map((item) => (lowerCase ? item.toLowerCase() : item)),
    );
  } catch {
    return new Set();
  }
}

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function belowMinimum(
  actual: number | null | undefined,
  minimum: number | null | undefined,
): boolean {
  return minimum != null && (actual == null || actual < minimum);
}

function gatewayRequest(
  profile: CopyTradeProfile,
  swap: WalletSwap,
  amount:
    | { kind: "exact-input-ui"; ui: number }
    | { kind: "balance-bps"; bps: number },
): CopyTradeGatewayRequest {
  return {
    requestId: `${profile.profileKey}:${swap.eventKey}`,
    followerRef: profile.followerRef,
    profileKey: profile.profileKey,
    mode: "live",
    leader: {
      wallet: swap.wallet,
      eventKey: swap.eventKey,
      signature: swap.signature,
      slot: swap.slot,
      tradedAtMs: swap.tradedAtMs,
    },
    trade: {
      side: swap.side as "buy" | "sell",
      inputMint: swap.inputMint,
      outputMint: swap.outputMint,
      subjectMint: swap.subjectMint,
      quoteMint: swap.quoteMint,
      amount,
      slippageBps: profile.slippageBps,
    },
    expiresAtMs: swap.tradedAtMs + profile.maxEventAgeMs,
  };
}

export function evaluateCopyTrade(
  profile: CopyTradeProfile,
  swap: WalletSwap,
  now = Date.now(),
  suppliedContext?: CopyTradeTokenContext | null,
): CopyTradeDecision {
  if (profile.enabled <= 0)
    return { approved: false, reason: "profile-disabled" };
  if (swap.wallet !== profile.leaderWallet) {
    return { approved: false, reason: "leader-wallet-mismatch" };
  }
  if (swap.copyable <= 0 || swap.classificationConfidence !== "exact") {
    return { approved: false, reason: "source-not-exact-copyable" };
  }
  if (swap.side !== "buy" && swap.side !== "sell") {
    return { approved: false, reason: "unsupported-side" };
  }
  if (swap.side === "buy" && profile.copyBuys <= 0) {
    return { approved: false, reason: "buys-disabled" };
  }
  if (swap.side === "sell" && profile.copySells <= 0) {
    return { approved: false, reason: "sells-disabled" };
  }

  const ageMs = Math.max(0, now - swap.tradedAtMs);
  if (swap.tradedAtMs <= 0 || ageMs > profile.maxEventAgeMs) {
    return { approved: false, reason: "source-event-expired" };
  }

  const allowedMints = parseSet(profile.allowedMintsJson);
  const blockedMints = parseSet(profile.blockedMintsJson);
  const allowedQuotes = parseSet(profile.allowedQuoteMintsJson);
  const allowedPhases = parseSet(profile.allowedPhasesJson, true);
  const allowedVenues = parseSet(profile.allowedVenuesJson, true);
  const allowedParsers = parseSet(profile.allowedParsersJson, true);

  if (allowedMints.size && !allowedMints.has(swap.subjectMint)) {
    return { approved: false, reason: "subject-mint-not-allowed" };
  }
  if (blockedMints.has(swap.subjectMint)) {
    return { approved: false, reason: "subject-mint-blocked" };
  }
  if (
    allowedQuotes.size &&
    (!swap.quoteMint || !allowedQuotes.has(swap.quoteMint))
  ) {
    return { approved: false, reason: "quote-mint-not-allowed" };
  }
  if (allowedVenues.size && !allowedVenues.has(swap.venue.toLowerCase())) {
    return { approved: false, reason: "venue-not-allowed" };
  }
  if (allowedParsers.size && !allowedParsers.has(swap.parser.toLowerCase())) {
    return { approved: false, reason: "parser-not-allowed" };
  }

  const context =
    suppliedContext ?? getCopyTradeTokenContext(swap.subjectMint, now);
  if (allowedPhases.size && !allowedPhases.has(context.phase.toLowerCase())) {
    return { approved: false, reason: "token-phase-not-allowed" };
  }
  if (profile.allowMayhem <= 0 && context.isMayhemMode) {
    return { approved: false, reason: "mayhem-token-blocked" };
  }

  const marketCapUsd = finite(swap.marketCapUsd) ?? context.marketCapUsd;
  const hasPriceData =
    finite(swap.priceUsd) != null ||
    finite(swap.priceSol) != null ||
    context.priceUsd != null ||
    marketCapUsd != null;
  if (profile.requirePriceData > 0 && !hasPriceData) {
    return { approved: false, reason: "price-data-required" };
  }

  if (profile.minMarketCapUsd != null) {
    if (marketCapUsd == null) {
      return { approved: false, reason: "market-cap-required" };
    }
    if (marketCapUsd < profile.minMarketCapUsd) {
      return { approved: false, reason: "market-cap-below-minimum" };
    }
  }
  if (profile.maxMarketCapUsd != null) {
    if (marketCapUsd == null) {
      return { approved: false, reason: "market-cap-required" };
    }
    if (marketCapUsd > profile.maxMarketCapUsd) {
      return { approved: false, reason: "market-cap-above-maximum" };
    }
  }

  if (profile.maxPriceAgeMs != null) {
    if (context.priceAgeMs == null) {
      return { approved: false, reason: "price-age-unknown" };
    }
    if (context.priceAgeMs > profile.maxPriceAgeMs) {
      return { approved: false, reason: "price-data-stale" };
    }
  }
  if (profile.minTokenAgeMs != null) {
    if (context.tokenAgeMs == null) {
      return { approved: false, reason: "token-age-unknown" };
    }
    if (context.tokenAgeMs < profile.minTokenAgeMs) {
      return { approved: false, reason: "token-too-new" };
    }
  }
  if (profile.maxTokenAgeMs != null) {
    if (context.tokenAgeMs == null) {
      return { approved: false, reason: "token-age-unknown" };
    }
    if (context.tokenAgeMs > profile.maxTokenAgeMs) {
      return { approved: false, reason: "token-too-old" };
    }
  }

  if (belowMinimum(context.holders?.holdersNow, profile.minHolders)) {
    return { approved: false, reason: "holders-below-minimum" };
  }
  if (belowMinimum(context.window?.trades1m, profile.minTrades1m)) {
    return { approved: false, reason: "trades-1m-below-minimum" };
  }
  if (belowMinimum(context.window?.trades5m, profile.minTrades5m)) {
    return { approved: false, reason: "trades-5m-below-minimum" };
  }
  if (belowMinimum(context.window?.trades15m, profile.minTrades15m)) {
    return { approved: false, reason: "trades-15m-below-minimum" };
  }
  if (belowMinimum(context.window?.volumeSol1m, profile.minVolumeSol1m)) {
    return { approved: false, reason: "volume-1m-below-minimum" };
  }
  if (belowMinimum(context.window?.volumeSol5m, profile.minVolumeSol5m)) {
    return { approved: false, reason: "volume-5m-below-minimum" };
  }
  if (belowMinimum(context.window?.volumeSol15m, profile.minVolumeSol15m)) {
    return { approved: false, reason: "volume-15m-below-minimum" };
  }

  const leaderQuoteAmountUi = Math.abs(
    finite(swap.side === "buy" ? swap.inputAmountUi : swap.outputAmountUi) ?? 0,
  );
  if (
    profile.minLeaderQuoteAmountUi != null &&
    leaderQuoteAmountUi < profile.minLeaderQuoteAmountUi
  ) {
    return { approved: false, reason: "leader-trade-below-minimum" };
  }
  if (
    profile.maxLeaderQuoteAmountUi != null &&
    leaderQuoteAmountUi > profile.maxLeaderQuoteAmountUi
  ) {
    return { approved: false, reason: "leader-trade-above-maximum" };
  }

  if (swap.side === "buy") {
    const leaderInput = Math.max(0, finite(swap.inputAmountUi) ?? 0);
    const desired =
      profile.buySizing === "leader-ratio"
        ? (leaderInput * profile.leaderScaleBps) / 10_000
        : profile.fixedBuyAmountUi;
    const amountUi = Math.min(desired, profile.maxBuyAmountUi);
    if (!Number.isFinite(amountUi) || amountUi <= 0) {
      return { approved: false, reason: "buy-size-zero" };
    }
    const request = gatewayRequest(profile, swap, {
      kind: "exact-input-ui",
      ui: amountUi,
    });
    return {
      approved: true,
      amountKind: "exact-input-ui",
      amountUi,
      balanceBps: null,
      request,
    };
  }

  const balanceBps = Math.max(1, Math.min(10_000, profile.sellBalanceBps));
  const request = gatewayRequest(profile, swap, {
    kind: "balance-bps",
    bps: balanceBps,
  });
  return {
    approved: true,
    amountKind: "balance-bps",
    amountUi: null,
    balanceBps,
    request,
  };
}
