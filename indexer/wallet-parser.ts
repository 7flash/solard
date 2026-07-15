import { parsePumpLogs } from "./pump-events.js";
import {
  extractPumpSwapCandidates,
  normalizeTransactionNotification,
} from "./pumpswap-transaction.js";
import {
  USDC_MINT,
  WSOL_MINT,
  type WalletIndexerConfig,
} from "./wallet-config.js";
import type {
  ParsedWalletTransaction,
  WalletConfidence,
  WalletSwapCandidate,
  WalletSwapSide,
} from "./wallet-types.js";

type AnyRow = Record<string, any>;

type Normalized = NonNullable<
  ReturnType<typeof normalizeTransactionNotification>
>;

type AssetDelta = {
  mint: string;
  amountUi: number;
  kind: "native" | "token";
};

function keyString(value: any): string {
  if (typeof value === "string") return value;
  return String(value?.pubkey ?? value?.address ?? "");
}

function fullAccountKeys(transaction: AnyRow, meta: AnyRow): string[] {
  const message =
    transaction?.message ?? transaction?.transaction?.message ?? {};
  const staticKeys = (
    message.accountKeys ??
    message.staticAccountKeys ??
    []
  ).map(keyString);
  const loaded = meta?.loadedAddresses ?? {};
  return [
    ...staticKeys,
    ...(loaded.writable ?? []).map(keyString),
    ...(loaded.readonly ?? []).map(keyString),
  ];
}

function tokenBalanceUi(item: AnyRow): number {
  const ui = item?.uiTokenAmount ?? {};
  const direct = Number(ui.uiAmountString ?? ui.uiAmount);
  if (Number.isFinite(direct)) return direct;
  const raw = Number(ui.amount);
  const decimals = Number(ui.decimals ?? 0);
  return Number.isFinite(raw) ? raw / 10 ** decimals : 0;
}

function tokenAmountsForOwner(
  items: AnyRow[] | undefined,
  owner: string,
): Map<string, number> {
  const output = new Map<string, number>();
  for (const item of items ?? []) {
    if (String(item?.owner ?? "") !== owner) continue;
    const mint = String(item?.mint ?? "");
    if (!mint) continue;
    output.set(mint, (output.get(mint) ?? 0) + tokenBalanceUi(item));
  }
  return output;
}

function ownerSet(items: AnyRow[] | undefined): Set<string> {
  const output = new Set<string>();
  for (const item of items ?? []) {
    const owner = String(item?.owner ?? "");
    if (owner) output.add(owner);
  }
  return output;
}

function transactionWallets(
  normalized: Normalized,
  watchedWallets: ReadonlySet<string>,
): string[] {
  const keys = new Set(
    fullAccountKeys(normalized.transaction, normalized.meta),
  );
  const owners = new Set([
    ...ownerSet(normalized.meta?.preTokenBalances),
    ...ownerSet(normalized.meta?.postTokenBalances),
  ]);
  return [...watchedWallets].filter(
    (wallet) => keys.has(wallet) || owners.has(wallet),
  );
}

function confidence(
  value: WalletConfidence | undefined,
  fallback: WalletIndexerConfig["commitment"],
): "processed" | "confirmed" | "finalized" {
  if (value === "processed" || value === "confirmed" || value === "finalized") {
    return value;
  }
  return fallback;
}

function quoteClassification(
  inputMint: string,
  outputMint: string,
): {
  side: WalletSwapSide;
  subjectMint: string;
  quoteMint: string | null;
} {
  const quotes = new Set([WSOL_MINT, USDC_MINT]);
  const inputQuote = quotes.has(inputMint);
  const outputQuote = quotes.has(outputMint);

  if (inputQuote && !outputQuote) {
    return { side: "buy", subjectMint: outputMint, quoteMint: inputMint };
  }
  if (!inputQuote && outputQuote) {
    return { side: "sell", subjectMint: inputMint, quoteMint: outputMint };
  }
  return { side: "swap", subjectMint: outputMint, quoteMint: null };
}

function priceFromAmounts(input: {
  side: WalletSwapSide;
  quoteMint: string | null;
  inputMint: string;
  inputAmountUi: number;
  outputMint: string;
  outputAmountUi: number;
  solUsd: number | null;
}): { priceSol: number | null; priceUsd: number | null } {
  let tokenAmount = 0;
  let quoteAmount = 0;

  if (input.side === "buy") {
    tokenAmount = input.outputAmountUi;
    quoteAmount = input.inputAmountUi;
  } else if (input.side === "sell") {
    tokenAmount = input.inputAmountUi;
    quoteAmount = input.outputAmountUi;
  }

  if (tokenAmount <= 0 || quoteAmount <= 0 || !input.quoteMint) {
    return { priceSol: null, priceUsd: null };
  }

  if (input.quoteMint === WSOL_MINT) {
    const priceSol = quoteAmount / tokenAmount;
    return {
      priceSol,
      priceUsd: input.solUsd != null ? priceSol * input.solUsd : null,
    };
  }

  if (input.quoteMint === USDC_MINT) {
    const priceUsd = quoteAmount / tokenAmount;
    return {
      priceSol:
        input.solUsd != null && input.solUsd > 0
          ? priceUsd / input.solUsd
          : null,
      priceUsd,
    };
  }

  return { priceSol: null, priceUsd: null };
}

function makeCandidate(
  input: Omit<
    WalletSwapCandidate,
    "side" | "subjectMint" | "quoteMint" | "priceSol" | "priceUsd"
  > & {
    side?: WalletSwapSide;
    subjectMint?: string;
    quoteMint?: string | null;
    priceSol?: number | null;
    priceUsd?: number | null;
    solUsd: number | null;
  },
): WalletSwapCandidate {
  const classified =
    input.side && input.subjectMint
      ? {
          side: input.side,
          subjectMint: input.subjectMint,
          quoteMint: input.quoteMint ?? null,
        }
      : quoteClassification(input.inputMint, input.outputMint);
  const derived = priceFromAmounts({
    ...input,
    ...classified,
    solUsd: input.solUsd,
  });

  return {
    eventKey: input.eventKey,
    wallet: input.wallet,
    signature: input.signature,
    slot: input.slot,
    inputMint: input.inputMint,
    inputAmountUi: input.inputAmountUi,
    outputMint: input.outputMint,
    outputAmountUi: input.outputAmountUi,
    subjectMint: classified.subjectMint,
    quoteMint: classified.quoteMint,
    side: classified.side,
    venue: input.venue,
    programId: input.programId,
    parser: input.parser,
    classificationConfidence: input.classificationConfidence,
    copyable: input.copyable,
    priceSol: input.priceSol ?? derived.priceSol,
    priceUsd: input.priceUsd ?? derived.priceUsd,
    marketCapUsd: input.marketCapUsd,
    tradedAtMs: input.tradedAtMs,
    raw: input.raw,
  };
}

function parsePumpCurve(
  normalized: Normalized,
  wallets: ReadonlySet<string>,
  config: WalletIndexerConfig,
  solUsd: number | null,
): WalletSwapCandidate[] {
  const logs = Array.isArray(normalized.meta?.logMessages)
    ? normalized.meta.logMessages.map(String)
    : [];
  const parsed = parsePumpLogs(
    {
      signature: normalized.signature,
      slot: normalized.slot,
      logs,
      receivedAtMs: normalized.tradedAtMs,
    },
    {
      solUsd,
      tokenDecimals: config.tokenDecimals,
      pumpSupplyUi: config.pumpSupplyUi,
      programId: config.pumpProgramId,
    },
  );

  const output: WalletSwapCandidate[] = [];
  let index = 0;
  for (const event of parsed.events) {
    if (event.kind !== "trade" || !event.owner || !wallets.has(event.owner)) {
      continue;
    }

    const tokenAmount = Math.abs(Number(event.tokenDeltaUi ?? 0));
    const solAmount = Math.abs(Number(event.solDeltaUi ?? 0));
    if (tokenAmount <= 0 || solAmount <= 0) continue;

    const isBuy = event.side === "buy";
    output.push(
      makeCandidate({
        eventKey: `${event.owner}:${event.signature}:pump:${index++}`,
        wallet: event.owner,
        signature: event.signature,
        slot: event.slot,
        inputMint: isBuy ? WSOL_MINT : event.mint,
        inputAmountUi: isBuy ? solAmount : tokenAmount,
        outputMint: isBuy ? event.mint : WSOL_MINT,
        outputAmountUi: isBuy ? tokenAmount : solAmount,
        side: event.side,
        subjectMint: event.mint,
        quoteMint: WSOL_MINT,
        venue: "pump",
        programId: config.pumpProgramId,
        parser: "pump-event",
        classificationConfidence: "exact",
        copyable: true,
        priceSol: event.priceSol,
        priceUsd: event.priceUsd,
        marketCapUsd: event.marketCapUsd,
        tradedAtMs: event.createdAtMs,
        raw: event.raw,
        solUsd,
      }),
    );
  }
  return output;
}

function parsePumpSwap(
  normalized: Normalized,
  wallets: ReadonlySet<string>,
  fallbackWallets: readonly string[],
  config: WalletIndexerConfig,
  solUsd: number | null,
): WalletSwapCandidate[] {
  const output: WalletSwapCandidate[] = [];
  const candidates = extractPumpSwapCandidates(
    normalized,
    config.pumpSwapProgramId,
  );

  candidates.forEach((candidate, index) => {
    const wallet =
      candidate.owner && wallets.has(candidate.owner)
        ? candidate.owner
        : fallbackWallets.length === 1
          ? fallbackWallets[0]!
          : null;
    if (!wallet) return;

    const isBuy = candidate.side === "buy";
    output.push(
      makeCandidate({
        eventKey: `${wallet}:${candidate.signature}:pumpswap:${candidate.pool}:${index}`,
        wallet,
        signature: candidate.signature,
        slot: candidate.slot,
        inputMint: isBuy ? candidate.quoteMint : candidate.baseMint,
        inputAmountUi: isBuy ? candidate.quoteAmountUi : candidate.baseAmountUi,
        outputMint: isBuy ? candidate.baseMint : candidate.quoteMint,
        outputAmountUi: isBuy
          ? candidate.baseAmountUi
          : candidate.quoteAmountUi,
        side: candidate.side,
        subjectMint: candidate.baseMint,
        quoteMint: candidate.quoteMint,
        venue: "pumpswap",
        programId: config.pumpSwapProgramId,
        parser: "pumpswap-instruction",
        classificationConfidence: "exact",
        copyable: true,
        marketCapUsd: null,
        tradedAtMs: candidate.tradedAtMs,
        raw: {
          pool: candidate.pool,
          instruction: candidate.instruction,
          poolBaseTokenAccount: candidate.poolBaseTokenAccount,
          poolQuoteTokenAccount: candidate.poolQuoteTokenAccount,
        },
        solUsd,
      }),
    );
  });

  return output;
}

function nativeDelta(normalized: Normalized, wallet: string): number {
  const keys = fullAccountKeys(normalized.transaction, normalized.meta);
  const index = keys.indexOf(wallet);
  if (index < 0) return 0;

  const pre = Number(normalized.meta?.preBalances?.[index] ?? 0);
  const post = Number(normalized.meta?.postBalances?.[index] ?? 0);
  if (!Number.isFinite(pre) || !Number.isFinite(post)) return 0;

  let deltaLamports = post - pre;
  const feePayer = keys[0] ?? "";
  if (wallet === feePayer) {
    const fee = Number(normalized.meta?.fee ?? 0);
    if (Number.isFinite(fee) && fee > 0) deltaLamports += fee;
  }
  return deltaLamports / 1_000_000_000;
}

function assetDeltas(normalized: Normalized, wallet: string): AssetDelta[] {
  const pre = tokenAmountsForOwner(normalized.meta?.preTokenBalances, wallet);
  const post = tokenAmountsForOwner(normalized.meta?.postTokenBalances, wallet);
  const mints = new Set([...pre.keys(), ...post.keys()]);
  const output: AssetDelta[] = [];

  for (const mint of mints) {
    const amountUi = (post.get(mint) ?? 0) - (pre.get(mint) ?? 0);
    if (Number.isFinite(amountUi) && Math.abs(amountUi) > 1e-12) {
      output.push({ mint, amountUi, kind: "token" });
    }
  }

  const sol = nativeDelta(normalized, wallet);
  if (Number.isFinite(sol) && Math.abs(sol) > 0.000000001) {
    output.push({ mint: WSOL_MINT, amountUi: sol, kind: "native" });
  }

  return output;
}

function detectGenericVenue(normalized: Normalized): string {
  const logs = (normalized.meta?.logMessages ?? [])
    .map(String)
    .join("\n")
    .toLowerCase();
  if (logs.includes("jupiter")) return "jupiter";
  if (logs.includes("raydium")) return "raydium";
  if (logs.includes("meteora")) return "meteora";
  if (logs.includes("orca")) return "orca";
  return "unknown";
}

function parseGeneric(
  normalized: Normalized,
  wallets: readonly string[],
  solUsd: number | null,
): WalletSwapCandidate[] {
  const output: WalletSwapCandidate[] = [];
  const venue = detectGenericVenue(normalized);

  for (const wallet of wallets) {
    const deltas = assetDeltas(normalized, wallet);
    const negatives = deltas.filter((item) => item.amountUi < 0);
    const positives = deltas.filter((item) => item.amountUi > 0);

    // Keep the inferred path intentionally conservative. Liquidity changes,
    // transfers, multi-hop leftovers and account-management transactions are
    // stored as wallet transactions but are not labeled as swaps.
    if (negatives.length !== 1 || positives.length !== 1) continue;

    const input = negatives[0]!;
    const outputAsset = positives[0]!;
    if (input.mint === outputAsset.mint) continue;

    output.push(
      makeCandidate({
        eventKey: `${wallet}:${normalized.signature}:inferred:0`,
        wallet,
        signature: normalized.signature,
        slot: normalized.slot,
        inputMint: input.mint,
        inputAmountUi: Math.abs(input.amountUi),
        outputMint: outputAsset.mint,
        outputAmountUi: Math.abs(outputAsset.amountUi),
        venue,
        programId: null,
        parser: "owner-balance-delta",
        classificationConfidence: "inferred",
        copyable: false,
        marketCapUsd: null,
        tradedAtMs: normalized.tradedAtMs,
        raw: { deltas },
        solUsd,
      }),
    );
  }

  return output;
}

function dedupeSwaps(
  swaps: readonly WalletSwapCandidate[],
): WalletSwapCandidate[] {
  const output = new Map<string, WalletSwapCandidate>();
  for (const swap of swaps) {
    const economicKey = [
      swap.wallet,
      swap.signature,
      swap.inputMint,
      swap.outputMint,
      swap.inputAmountUi.toPrecision(12),
      swap.outputAmountUi.toPrecision(12),
    ].join("|");
    const previous = output.get(economicKey);
    if (
      !previous ||
      (previous.classificationConfidence !== "exact" &&
        swap.classificationConfidence === "exact")
    ) {
      output.set(economicKey, swap);
    }
  }
  return [...output.values()];
}

export function parseWatchedWalletTransaction(
  message: AnyRow,
  input: {
    watchedWallets: ReadonlySet<string>;
    config: WalletIndexerConfig;
    solUsd: number | null;
    confidence?: WalletConfidence;
  },
): ParsedWalletTransaction | null {
  const normalized = normalizeTransactionNotification(message);
  if (!normalized) return null;

  const wallets = transactionWallets(normalized, input.watchedWallets);
  if (!wallets.length) return null;

  const normalizedWithConfidence: Normalized = {
    ...normalized,
    confidence: confidence(input.confidence, input.config.commitment),
  };
  const walletSet = new Set(wallets);

  const exact = [
    ...parsePumpCurve(
      normalizedWithConfidence,
      walletSet,
      input.config,
      input.solUsd,
    ),
    ...parsePumpSwap(
      normalizedWithConfidence,
      walletSet,
      wallets,
      input.config,
      input.solUsd,
    ),
  ];

  const exactWallets = new Set(exact.map((swap) => swap.wallet));
  const inferredWallets = wallets.filter((wallet) => !exactWallets.has(wallet));
  const inferred = parseGeneric(
    normalizedWithConfidence,
    inferredWallets,
    input.solUsd,
  );

  return {
    signature: normalized.signature,
    slot: normalized.slot,
    tradedAtMs: normalized.tradedAtMs,
    confidence: normalizedWithConfidence.confidence,
    wallets,
    swaps: dedupeSwaps([...exact, ...inferred]),
    raw: message?.params?.result ?? message?.result ?? message,
  };
}
