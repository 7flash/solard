#!/usr/bin/env bun
import { configure, createMeasure } from "measure-fn";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import {
  createTraderSolard,
  executeJupiterSwap,
  quoteJupiterSwap,
  rawAmount,
  RaydiumService,
  type JupiterSwapQuote,
  type QuoteResult,
  type RaydiumSwapQuote,
  type TokenRow,
  type TradeVenuePlugin,
  type VenueMarket,
} from "@solard/core";
import {
  normalizeValueBandPolicy,
  type ValueBandBuyMode,
  type ValueBandPolicy,
} from "../packages/core/src/strategy/value-band.ts";

const WSOL = "So11111111111111111111111111111111111111112";

configure({ silent: false });
const m = createMeasure("slrd:value-band-agent", { maxResultLength: 1600 });

type Flags = Map<string, string>;
type NativeSwapVenue = "pump-curve" | "pumpswap";
type SwapVenue = NativeSwapVenue | "jupiter" | "raydium";
type VenueMode = "auto" | "native" | "jupiter" | "raydium";
type TradeSide = "buy" | "sell";

type RoutedQuote = {
  venue: SwapVenue;
  inputMint: string;
  outputMint: string;
  inputRaw: bigint;
  outputRaw: bigint;
  minOutputRaw: bigint | null;
  priceImpactPct: number | null;
  raw: JupiterSwapQuote | RaydiumSwapQuote | QuoteResult;
  alternatives: Array<{ venue: SwapVenue; outputRaw: bigint }>;
};

type PendingSettlement = {
  side: TradeSide;
  venue: SwapVenue;
  signature: string;
  requestedInputRaw: string;
  quotedOutputRaw: string;
  preTokenRaw: string;
  submittedAtMs: number;
  /** Durable expiry proof for transactions compiled locally by Solard. */
  recentBlockhash?: string | null;
  lastValidBlockHeight?: number | null;
  /** Pre-submit balance proof used only when transaction metadata is unavailable. */
  preWalletLamports?: string | null;
  preOwnedTokenAccountLamports?: string | null;
  /** Fee computed from the exact signed message before submission, when available. */
  estimatedNetworkFeeLamports?: string | null;
};

type Journal = {
  version: 1;
  wallet: string;
  mint: string;
  createdAtMs: number;
  updatedAtMs: number;
  lastTradeSide: TradeSide | null;
  /** All-in execution price of the latest settled buy (SOL per wallet token received). */
  lastBuyPriceSol: number | null;
  /** Settled execution price of the latest sell (SOL received per wallet token sold). */
  lastSellPriceSol: number | null;
  lastBuyAtMs: number | null;
  lastSellAtMs: number | null;
  cumulativeBuySol: number;
  cumulativeSellSol: number;
  peakNetCapitalDeployedSol: number;
  executions: number;
  /** Last transaction signature already applied to journal economics. */
  lastSettledSignature?: string | null;
  pendingSettlement: PendingSettlement | null;
  /** Highest fixed-size executable entry quote observed while flat, in lamports/raw-token. */
  entryPeakPriceRaw: number | null;
  /** Probe size used for entryPeakPriceRaw. A size change resets the peak because price impact changes. */
  entryPeakProbeLamports: string | null;
  entryPeakAtMs: number | null;
};

type Snapshot = {
  atMs: number;
  amountRaw: bigint;
  decimals: number | null;
  amountUi: number | null;
  liquidationSol: number;
  walletSol: number;
  walletLamports: bigint;
  ownedTokenAccountLamports: bigint;
  effectivePriceSol: number | null;
  quote: RoutedQuote | null;
};

type Decision = {
  action: TradeSide | "hold";
  reason: string;
  liquidationSol: number;
  lowerSol: number;
  baseSol: number;
  upperSol: number;
  executablePriceSol: number | null;
  lastTradeSide: TradeSide | null;
  lastBuyPriceSol: number | null;
  lastSellPriceSol: number | null;
  nextLadderPriceSol: number | null;
  nextRebuyPriceSol: number | null;
  minTakeProfitPriceSol: number | null;
  entryCurrentPriceRaw: number | null;
  entryPeakPriceRaw: number | null;
  entryTriggerPriceRaw: number | null;
  entryPullbackPct: number;
};

type EntryObservation = {
  probeLamports: bigint;
  venue: SwapVenue;
  outputRaw: bigint;
  /** Fixed-size executable buy quote expressed as lamports per raw token unit. */
  priceRaw: number;
  peakPriceRaw: number;
  triggerPriceRaw: number;
  pullbackPctFromPeak: number;
};

function parseArgs(argv: string[]): Flags {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]!;
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
    if (inline != null) flags.set(key!, inline);
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--"))
      flags.set(key!, argv[++i]!);
    else flags.set(key!, "true");
  }
  return flags;
}

function flag(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return value && value !== "true" ? value : undefined;
}

function required(flags: Flags, key: string): string {
  const value = flag(flags, key);
  if (!value) throw new Error(`Missing --${key} <value>`);
  return value;
}

function numberFlag(flags: Flags, key: string, fallback: number): number {
  const raw = flag(flags, key);
  if (raw == null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key}: ${raw}`);
  return parsed;
}

function integerFlag(flags: Flags, key: string, fallback: number): number {
  return Math.trunc(numberFlag(flags, key, fallback));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function liveEnabled(): boolean {
  return [
    process.env.SOLARD_ENABLE_LIVE_TRADES,
    process.env.SLRD_ENABLE_LIVE_TRADES,
    process.env.SOLWAL_ENABLE_LIVE_TRADES,
  ].some((value) => value === "1" || value === "true");
}

function resolveMint(
  slrd: ReturnType<typeof createTraderSolard>,
  ref: string,
): string {
  try {
    return slrd.resolveToken(ref).mint;
  } catch {
    return ref;
  }
}

function venueMode(flags: Flags): VenueMode {
  const value = (flag(flags, "venue") ?? "auto").toLowerCase();
  if (
    value === "auto" ||
    value === "native" ||
    value === "jupiter" ||
    value === "raydium"
  )
    return value;
  throw new Error("--venue must be auto, native, jupiter, or raydium");
}

function buyMode(flags: Flags): ValueBandBuyMode {
  // to-base is the coherent default for a value-band controller: a lower-band
  // buy returns exposure toward base instead of doubling through the upper band.
  const raw = flag(flags, "buy-mode") ?? "to-base";
  if (raw === "match-current") return "same-value";
  if (raw === "same-value" || raw === "same-tokens" || raw === "to-base")
    return raw;
  throw new Error(
    "--buy-mode must be same-value, same-tokens, to-base, or match-current",
  );
}

function journalPath(flags: Flags, wallet: string, mint: string): string {
  return resolve(
    flag(flags, "state-file") ??
      `.solard/agents/value-band-${wallet.slice(0, 8)}-${mint.slice(0, 8)}.json`,
  );
}

function freshJournal(wallet: string, mint: string): Journal {
  const now = Date.now();
  return {
    version: 1,
    wallet,
    mint,
    createdAtMs: now,
    updatedAtMs: now,
    lastTradeSide: null,
    lastBuyPriceSol: null,
    lastSellPriceSol: null,
    lastBuyAtMs: null,
    lastSellAtMs: null,
    cumulativeBuySol: 0,
    cumulativeSellSol: 0,
    peakNetCapitalDeployedSol: 0,
    executions: 0,
    lastSettledSignature: null,
    pendingSettlement: null,
    entryPeakPriceRaw: null,
    entryPeakProbeLamports: null,
    entryPeakAtMs: null,
  };
}

function readJournal(path: string, wallet: string, mint: string): Journal {
  if (!existsSync(path)) return freshJournal(wallet, mint);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Journal>;
  if (
    parsed.version !== 1 ||
    parsed.wallet !== wallet ||
    parsed.mint !== mint
  ) {
    throw new Error(
      `State file ${path} belongs to another wallet/mint or unsupported version`,
    );
  }
  const fresh = freshJournal(wallet, mint);
  return {
    ...fresh,
    createdAtMs: Number.isFinite(Number(parsed.createdAtMs))
      ? Number(parsed.createdAtMs)
      : fresh.createdAtMs,
    updatedAtMs: Number.isFinite(Number(parsed.updatedAtMs))
      ? Number(parsed.updatedAtMs)
      : fresh.updatedAtMs,
    lastTradeSide:
      parsed.lastTradeSide === "buy" || parsed.lastTradeSide === "sell"
        ? parsed.lastTradeSide
        : null,
    lastBuyPriceSol:
      Number.isFinite(Number(parsed.lastBuyPriceSol)) &&
      Number(parsed.lastBuyPriceSol) > 0
        ? Number(parsed.lastBuyPriceSol)
        : null,
    lastSellPriceSol:
      Number.isFinite(Number(parsed.lastSellPriceSol)) &&
      Number(parsed.lastSellPriceSol) > 0
        ? Number(parsed.lastSellPriceSol)
        : null,
    lastBuyAtMs: Number.isFinite(Number(parsed.lastBuyAtMs))
      ? Number(parsed.lastBuyAtMs)
      : null,
    lastSellAtMs: Number.isFinite(Number(parsed.lastSellAtMs))
      ? Number(parsed.lastSellAtMs)
      : null,
    cumulativeBuySol: Math.max(0, Number(parsed.cumulativeBuySol ?? 0)),
    cumulativeSellSol: Math.max(0, Number(parsed.cumulativeSellSol ?? 0)),
    peakNetCapitalDeployedSol: Math.max(
      0,
      Number(parsed.peakNetCapitalDeployedSol ?? 0),
    ),
    executions: Math.max(0, Math.trunc(Number(parsed.executions ?? 0))),
    lastSettledSignature:
      typeof parsed.lastSettledSignature === "string"
        ? parsed.lastSettledSignature
        : null,
    pendingSettlement:
      parsed.pendingSettlement &&
      (parsed.pendingSettlement.side === "buy" ||
        parsed.pendingSettlement.side === "sell") &&
      (parsed.pendingSettlement.venue === "jupiter" ||
        parsed.pendingSettlement.venue === "raydium" ||
        parsed.pendingSettlement.venue === "pump-curve" ||
        parsed.pendingSettlement.venue === "pumpswap") &&
      typeof parsed.pendingSettlement.signature === "string" &&
      /^\d+$/.test(String(parsed.pendingSettlement.requestedInputRaw ?? "")) &&
      /^\d+$/.test(String(parsed.pendingSettlement.quotedOutputRaw ?? "")) &&
      /^\d+$/.test(String(parsed.pendingSettlement.preTokenRaw ?? ""))
        ? {
            side: parsed.pendingSettlement.side,
            venue: parsed.pendingSettlement.venue,
            signature: parsed.pendingSettlement.signature,
            requestedInputRaw: String(
              parsed.pendingSettlement.requestedInputRaw,
            ),
            quotedOutputRaw: String(parsed.pendingSettlement.quotedOutputRaw),
            preTokenRaw: String(parsed.pendingSettlement.preTokenRaw),
            submittedAtMs: Number.isFinite(
              Number(parsed.pendingSettlement.submittedAtMs),
            )
              ? Number(parsed.pendingSettlement.submittedAtMs)
              : fresh.updatedAtMs,
            recentBlockhash:
              typeof parsed.pendingSettlement.recentBlockhash === "string"
                ? parsed.pendingSettlement.recentBlockhash
                : null,
            lastValidBlockHeight: Number.isInteger(
              Number(parsed.pendingSettlement.lastValidBlockHeight),
            )
              ? Number(parsed.pendingSettlement.lastValidBlockHeight)
              : null,
            preWalletLamports:
              typeof parsed.pendingSettlement.preWalletLamports === "string" &&
              /^\d+$/.test(parsed.pendingSettlement.preWalletLamports)
                ? parsed.pendingSettlement.preWalletLamports
                : null,
            preOwnedTokenAccountLamports:
              typeof parsed.pendingSettlement.preOwnedTokenAccountLamports ===
                "string" &&
              /^\d+$/.test(
                parsed.pendingSettlement.preOwnedTokenAccountLamports,
              )
                ? parsed.pendingSettlement.preOwnedTokenAccountLamports
                : null,
            estimatedNetworkFeeLamports:
              typeof parsed.pendingSettlement.estimatedNetworkFeeLamports ===
                "string" &&
              /^\d+$/.test(parsed.pendingSettlement.estimatedNetworkFeeLamports)
                ? parsed.pendingSettlement.estimatedNetworkFeeLamports
                : null,
          }
        : null,
    entryPeakPriceRaw:
      Number.isFinite(Number(parsed.entryPeakPriceRaw)) &&
      Number(parsed.entryPeakPriceRaw) > 0
        ? Number(parsed.entryPeakPriceRaw)
        : null,
    entryPeakProbeLamports:
      typeof parsed.entryPeakProbeLamports === "string" &&
      /^\d+$/.test(parsed.entryPeakProbeLamports)
        ? parsed.entryPeakProbeLamports
        : null,
    entryPeakAtMs: Number.isFinite(Number(parsed.entryPeakAtMs))
      ? Number(parsed.entryPeakAtMs)
      : null,
  };
}

function writeJournal(path: string, journal: Journal): void {
  journal.updatedAtMs = Date.now();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function resetGuards(journal: Journal): void {
  journal.lastTradeSide = null;
  journal.lastBuyPriceSol = null;
  journal.lastSellPriceSol = null;
  journal.lastBuyAtMs = null;
  journal.lastSellAtMs = null;
  journal.entryPeakPriceRaw = null;
  journal.entryPeakProbeLamports = null;
  journal.entryPeakAtMs = null;
}

function clearEntryPeak(journal: Journal): void {
  journal.entryPeakPriceRaw = null;
  journal.entryPeakProbeLamports = null;
  journal.entryPeakAtMs = null;
}

function netCapital(journal: Journal): number {
  return Math.max(0, journal.cumulativeBuySol - journal.cumulativeSellSol);
}

function recordBuy(journal: Journal, sol: number): void {
  journal.cumulativeBuySol += sol;
  journal.peakNetCapitalDeployedSol = Math.max(
    journal.peakNetCapitalDeployedSol,
    netCapital(journal),
  );
  journal.executions += 1;
}

function recordSell(journal: Journal, sol: number): void {
  journal.cumulativeSellSol += sol;
  journal.executions += 1;
}

type NativeRoute = {
  token: TokenRow;
  plugin: TradeVenuePlugin;
  market: VenueMarket;
};

function nativeVenue(value: string): NativeSwapVenue {
  if (value === "pump-curve" || value === "pumpswap") return value;
  throw new Error(`Solard native router resolved unsupported venue ${value}`);
}

function venueModeForQuote(venue: SwapVenue): Exclude<VenueMode, "auto"> {
  if (venue === "pump-curve" || venue === "pumpswap") return "native";
  return venue;
}

type SubmissionAmbiguousError = Error & {
  submissionAmbiguous?: true;
  submissionVenue?: SwapVenue;
};

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * RPC sendRawTransaction with skipPreflight=false can reject before broadcast
 * when its own simulation fails. That is provably pre-submission and must never
 * be treated as an ambiguous send.
 */
function isRpcPreflightSimulationRejection(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    /Transaction simulation failed/i.test(message) ||
    /Simulation failed\./i.test(message) ||
    /preflight.*simulation/i.test(message)
  );
}

/**
 * Native Pump/PumpSwap slippage failures are market-state races, not permanent
 * transaction-construction failures. A single fresh re-quote/rebuild retry is
 * useful; after that the outer cycle retries from a new strategy snapshot.
 */
function isNativeSlippageRejection(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    /TooLittleSolReceived/i.test(message) ||
    /TooMuchSolRequired/i.test(message) ||
    /Error Number:\s*6003\b/i.test(message) ||
    /Error Number:\s*6040\b/i.test(message) ||
    /custom program error:\s*0x1773\b/i.test(message)
  );
}

/**
 * RaydiumService.executePrepared() signs, then simulateTransaction() runs before
 * sendRawTransaction(). Its own "Raydium swap simulation failed" error is
 * therefore provably pre-submission. RPC sendRawTransaction preflight simulation
 * rejection is also pre-submission and is covered by the generic classifier.
 */
function isRaydiumPreSubmissionFailure(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    /^Raydium\s+swap\s+simulation\s+failed:/i.test(message) ||
    isRpcPreflightSimulationRejection(error)
  );
}

function markSubmissionAmbiguous(
  error: unknown,
  venue: SwapVenue,
): SubmissionAmbiguousError {
  const wrapped: SubmissionAmbiguousError =
    error instanceof Error ? error : new Error(String(error));
  wrapped.submissionAmbiguous = true;
  wrapped.submissionVenue = venue;
  return wrapped;
}

function isSubmissionAmbiguous(
  error: unknown,
): error is SubmissionAmbiguousError {
  return (
    error instanceof Error &&
    (error as SubmissionAmbiguousError).submissionAmbiguous === true
  );
}

async function resolveNativeRoute(args: {
  slrd: ReturnType<typeof createTraderSolard>;
  walletRef: string;
  mint: string;
}): Promise<NativeRoute> {
  let token: TokenRow;
  try {
    token = args.slrd.resolveToken(args.mint);
  } catch {
    token = await args.slrd.addToken(args.mint);
  }
  const user = args.slrd.signer(args.walletRef).publicKey;
  const { plugin, market } = await args.slrd.route(token, user);
  nativeVenue(market.venue);
  if (market.quoteAsset.kind !== "native-sol") {
    throw new Error(
      `Solard native route ${market.venue} is paired with ${market.quoteAsset.mint.toBase58()}, not native SOL`,
    );
  }
  return { token, plugin, market };
}

async function quoteNativeRoute(args: {
  slrd: ReturnType<typeof createTraderSolard>;
  walletRef: string;
  mint: string;
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  slippageBps: number;
}): Promise<RoutedQuote> {
  const route = await resolveNativeRoute(args);
  const user = args.slrd.signer(args.walletRef).publicKey;
  const ctx = {
    connection: args.slrd.connection(),
    token: route.token,
    user,
  };
  let quote: QuoteResult;
  if (args.inputMint === WSOL && args.outputMint === args.mint) {
    quote = await route.plugin.quoteBuy(
      ctx,
      route.market,
      rawAmount(args.amountRaw, route.market.quoteAsset),
      args.slippageBps,
    );
  } else if (args.inputMint === args.mint && args.outputMint === WSOL) {
    quote = await route.plugin.quoteSell(
      ctx,
      route.market,
      args.amountRaw,
      args.slippageBps,
    );
  } else {
    throw new Error(
      `Solard native controller route only supports SOL <-> ${args.mint}`,
    );
  }
  return {
    venue: nativeVenue(route.market.venue),
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    inputRaw: quote.inputRaw,
    outputRaw: quote.expectedOutputRaw,
    minOutputRaw: quote.minimumOutputRaw,
    priceImpactPct: null,
    raw: quote,
    alternatives: [],
  };
}

function toJupiterRoutedQuote(q: JupiterSwapQuote): RoutedQuote {
  return {
    venue: "jupiter",
    inputMint: q.inputMint,
    outputMint: q.outputMint,
    inputRaw: q.amountRaw,
    outputRaw: q.outAmountRaw,
    minOutputRaw: null,
    priceImpactPct: null,
    raw: q,
    alternatives: [],
  };
}

function toRaydiumRoutedQuote(q: RaydiumSwapQuote): RoutedQuote {
  return {
    venue: "raydium",
    inputMint: q.inputMint,
    outputMint: q.outputMint,
    inputRaw: q.inputRaw,
    outputRaw: q.outputRaw,
    minOutputRaw: q.minOutputRaw,
    priceImpactPct: q.priceImpactPct,
    raw: q,
    alternatives: [],
  };
}

async function quoteBestRoute(args: {
  slrd: ReturnType<typeof createTraderSolard>;
  raydium: RaydiumService;
  walletRef: string;
  mint: string;
  mode: VenueMode;
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  slippageBps: number;
}): Promise<RoutedQuote> {
  const quoteNative = async () =>
    await quoteNativeRoute({
      slrd: args.slrd,
      walletRef: args.walletRef,
      mint: args.mint,
      inputMint: args.inputMint,
      outputMint: args.outputMint,
      amountRaw: args.amountRaw,
      slippageBps: args.slippageBps,
    });
  const quoteJupiter = async () =>
    toJupiterRoutedQuote(
      await quoteJupiterSwap({
        inputMint: args.inputMint,
        outputMint: args.outputMint,
        amountRaw: args.amountRaw,
      }),
    );
  const quoteRaydium = async () =>
    toRaydiumRoutedQuote(
      await args.raydium.quoteExactIn({
        inputMint: args.inputMint,
        outputMint: args.outputMint,
        amountRaw: args.amountRaw,
        slippageBps: args.slippageBps,
      }),
    );

  if (args.mode === "native") return await quoteNative();
  if (args.mode === "jupiter") return await quoteJupiter();
  if (args.mode === "raydium") return await quoteRaydium();

  // `auto` means Solard's own router first. A Pump/PumpSwap token must never
  // call an external aggregator just because it might quote a slightly larger
  // number. If Solard cannot route the token natively, fall back to direct
  // Raydium. Jupiter is explicit-only (`--venue jupiter`).
  try {
    const native = await quoteNative();
    native.alternatives = [
      { venue: native.venue, outputRaw: native.outputRaw },
    ];
    return native;
  } catch (nativeError) {
    // Only an explicit "no registered native venue" result may fall through to
    // Raydium. Once Solard has a Pump/PumpSwap route, programming errors, RPC
    // errors, SDK incompatibilities, quote failures, etc. are native-route
    // failures and must be surfaced directly. Hiding them behind a Raydium
    // ROUTE_NOT_FOUND message made Pump failures look like cross-venue routing.
    if (errorCode(nativeError) !== "UNSUPPORTED_TOKEN") {
      throw new Error(
        `Solard native route failed for ${args.mint}: ${errorMessage(nativeError)}. ` +
          `Refusing external fallback because this was not an UNSUPPORTED_TOKEN result.`,
        nativeError instanceof Error ? { cause: nativeError } : undefined,
      );
    }

    try {
      const raydium = await quoteRaydium();
      raydium.alternatives = [
        { venue: raydium.venue, outputRaw: raydium.outputRaw },
      ];
      return raydium;
    } catch (raydiumError) {
      throw new Error(
        `No executable Solard auto route: native=UNSUPPORTED_TOKEN; ` +
          `raydium=${errorMessage(raydiumError)}. ` +
          `Jupiter is explicit-only; pass --venue jupiter if you intentionally want it.`,
      );
    }
  }
}

async function executeRoutedSwap(args: {
  slrd: ReturnType<typeof createTraderSolard>;
  raydium: RaydiumService;
  walletRef: string;
  quote: RoutedQuote;
  slippageBps: number;
  raydiumPriorityMicroLamports?: string;
  /** Minimum output that the freshly built executable order must still protect. */
  minAcceptableOutputRaw?: bigint;
}): Promise<{
  venue: SwapVenue;
  signature: string | null;
  outputRaw: bigint;
  raw: unknown;
  settlement?: {
    recentBlockhash: string | null;
    lastValidBlockHeight: number | null;
    estimatedNetworkFeeLamports: string | null;
  };
}> {
  if (args.quote.venue === "pump-curve" || args.quote.venue === "pumpswap") {
    const isBuy = args.quote.inputMint === WSOL;
    const mint =
      args.quote.inputMint === WSOL
        ? args.quote.outputMint
        : args.quote.inputMint;

    // One immediate retry is intentionally narrow: only a known native
    // slippage/preflight race gets retried here. Everything else returns to the
    // outer cycle, and sender/transport ambiguity still fail-stops.
    const maxNativeAttempts = 2;
    let lastPreSubmissionError: unknown = null;

    for (let attempt = 1; attempt <= maxNativeAttempts; attempt += 1) {
      const route = await resolveNativeRoute({
        slrd: args.slrd,
        walletRef: args.walletRef,
        mint,
      });
      if (route.market.venue !== args.quote.venue) {
        throw new Error(
          `Solard native route changed from ${args.quote.venue} to ${route.market.venue} before execution; retry from a fresh cycle`,
        );
      }

      const user = args.slrd.signer(args.walletRef).publicKey;
      const ctx = {
        connection: args.slrd.connection(),
        token: route.token,
        user,
      };

      const freshQuote = isBuy
        ? await route.plugin.quoteBuy(
            ctx,
            route.market,
            rawAmount(args.quote.inputRaw, route.market.quoteAsset),
            args.slippageBps,
          )
        : await route.plugin.quoteSell(
            ctx,
            route.market,
            args.quote.inputRaw,
            args.slippageBps,
          );
      const built = isBuy
        ? await route.plugin.buildBuy(ctx, route.market, freshQuote)
        : await route.plugin.buildSell(ctx, route.market, freshQuote);
      const protectedOutput = built.minOutputRaw ?? freshQuote.minimumOutputRaw;

      if (
        args.minAcceptableOutputRaw != null &&
        protectedOutput < args.minAcceptableOutputRaw
      ) {
        // This is a strategy guard, not a sender error. The market moved below
        // the controller's acceptable execution floor before submission.
        throw new Error(
          `${route.market.venue} freshly built transaction protects only ${protectedOutput.toString()} output raw; strategy requires at least ${args.minAcceptableOutputRaw.toString()}`,
        );
      }

      const tx = args.slrd
        .transaction(args.walletRef)
        .addMany(built.instructions, {
          kind: isBuy ? "buy" : "sell",
          mint: route.market.mint,
          meta: {
            venue: route.market.venue,
            inputRaw: freshQuote.inputRaw.toString(),
            minOutputRaw: protectedOutput.toString(),
            controller: "value-band",
            nativeAttempt: attempt,
          },
        });
      const plan = await args.slrd.compile(
        args.slrd.signer(args.walletRef),
        tx.snapshot(),
      );

      const simulation = await args.slrd.simulatePlan(plan);
      if (!simulation.success) {
        const simulationError = new Error(
          `${route.market.venue} simulation failed before submission: ${JSON.stringify(simulation.error)}\n${simulation.logs.join("\\n")}`,
        );
        if (
          attempt < maxNativeAttempts &&
          isNativeSlippageRejection(simulationError)
        ) {
          lastPreSubmissionError = simulationError;
          continue;
        }
        throw simulationError;
      }

      // Capture settlement data from the exact compiled message before
      // broadcast. This gives reconciliation an independent proof path if
      // getTransaction() indexing lags after confirmation.
      let estimatedNetworkFeeLamports: string | null = null;
      try {
        const fee = await args.slrd
          .connection()
          .getFeeForMessage(plan.transaction.message, "confirmed");
        if (
          fee.value != null &&
          Number.isSafeInteger(fee.value) &&
          fee.value >= 0
        ) {
          estimatedNetworkFeeLamports = String(fee.value);
        }
      } catch {
        // Metadata-based reconciliation remains authoritative when fee lookup
        // is unavailable.
      }

      let submission: Awaited<ReturnType<typeof args.slrd.submitPlan>>;
      try {
        submission = await args.slrd.submitPlan(
          plan,
          "rpc",
          `value-band-${isBuy ? "buy" : "sell"}-${route.market.venue}`,
          { skipSimulation: true, skipPreflight: false },
        );
      } catch (error) {
        // IMPORTANT: RPC preflight runs inside sendRawTransaction. A
        // SendTransactionError whose message says transaction simulation
        // failed means the RPC rejected it BEFORE broadcast. It is therefore
        // safe to re-quote/rebuild; never mark it submission-ambiguous.
        if (isRpcPreflightSimulationRejection(error)) {
          if (attempt < maxNativeAttempts && isNativeSlippageRejection(error)) {
            lastPreSubmissionError = error;
            continue;
          }
          throw error;
        }

        // Only transport/sender failures after preflight may be ambiguous.
        throw markSubmissionAmbiguous(error, nativeVenue(route.market.venue));
      }

      return {
        venue: nativeVenue(route.market.venue),
        signature: submission.signature,
        outputRaw: built.expectedOutputRaw ?? freshQuote.expectedOutputRaw,
        raw: {
          submission,
          quote: freshQuote,
          built: {
            venue: built.venue,
            minOutputRaw: protectedOutput.toString(),
            expectedOutputRaw:
              built.expectedOutputRaw?.toString() ??
              freshQuote.expectedOutputRaw.toString(),
          },
          nativeAttempt: attempt,
        },
        settlement: {
          recentBlockhash: submission.plan.recentBlockhash,
          lastValidBlockHeight: submission.plan.lastValidBlockHeight,
          estimatedNetworkFeeLamports,
        },
      };
    }

    throw (
      lastPreSubmissionError ??
      new Error(
        `${args.quote.venue} native execution exhausted fresh pre-submission attempts`,
      )
    );
  }

  if (args.quote.venue === "jupiter") {
    let result: Awaited<ReturnType<typeof executeJupiterSwap>>;
    try {
      result = await executeJupiterSwap({
        inputMint: args.quote.inputMint,
        outputMint: args.quote.outputMint,
        amountRaw: args.quote.inputRaw,
        signer: args.slrd.signer(args.walletRef),
        ...(args.minAcceptableOutputRaw != null
          ? {
              minOutputRaw: (() => {
                const keepBps = 10_000 - args.slippageBps;
                if (keepBps <= 0) {
                  throw new Error(
                    "Cannot enforce an execution-order output guard with 100% slippage",
                  );
                }
                return (
                  (args.minAcceptableOutputRaw * 10_000n +
                    BigInt(keepBps - 1)) /
                  BigInt(keepBps)
                );
              })(),
            }
          : {}),
      });
    } catch (error) {
      const endpoint =
        error && typeof error === "object" && "endpoint" in error
          ? String((error as { endpoint?: unknown }).endpoint ?? "")
          : "";
      // /order happens before Jupiter has a signed transaction to execute.
      // Any later transport/execution failure is conservatively ambiguous.
      if (endpoint === "/order") throw error;
      throw markSubmissionAmbiguous(error, "jupiter");
    }
    const actual = result.outputAmountResult ?? result.totalOutputAmount;
    return {
      venue: "jupiter",
      signature: result.signature ?? null,
      outputRaw:
        actual && /^\d+$/.test(actual) ? BigInt(actual) : args.quote.outputRaw,
      raw: result,
    };
  }

  const prepared = await args.raydium.buildSwapExactIn({
    wallet: args.walletRef,
    inputMint: args.quote.inputMint,
    outputMint: args.quote.outputMint,
    amountRaw: args.quote.inputRaw,
    slippageBps: args.slippageBps,
    ...(args.raydiumPriorityMicroLamports != null
      ? { computeUnitPriceMicroLamports: args.raydiumPriorityMicroLamports }
      : {}),
  });
  if (
    args.minAcceptableOutputRaw != null &&
    prepared.quote.minOutputRaw < args.minAcceptableOutputRaw
  ) {
    throw new Error(
      `Raydium freshly built transaction protects only ${prepared.quote.minOutputRaw.toString()} output raw; strategy requires at least ${args.minAcceptableOutputRaw.toString()}`,
    );
  }

  if (prepared.transactions.length !== 1) {
    throw new Error(
      `Raydium controller settlement currently requires exactly one swap transaction; builder returned ${prepared.transactions.length}`,
    );
  }

  const raydiumTx: any = prepared.transactions[0]!;
  const recentBlockhash =
    typeof raydiumTx?.message?.recentBlockhash === "string"
      ? raydiumTx.message.recentBlockhash
      : typeof raydiumTx?.recentBlockhash === "string"
        ? raydiumTx.recentBlockhash
        : null;
  let estimatedNetworkFeeLamports: string | null = null;
  try {
    const feeMessage =
      raydiumTx?.message ??
      (typeof raydiumTx?.compileMessage === "function"
        ? raydiumTx.compileMessage()
        : null);
    if (feeMessage) {
      const fee = await args.slrd
        .connection()
        .getFeeForMessage(feeMessage, "confirmed");
      if (
        fee.value != null &&
        Number.isSafeInteger(fee.value) &&
        fee.value >= 0
      ) {
        estimatedNetworkFeeLamports = String(fee.value);
      }
    }
  } catch {
    // Transaction metadata remains authoritative when fee lookup is unavailable.
  }

  let result: Awaited<ReturnType<RaydiumService["submitPrepared"]>>;
  try {
    // Submission returns immediately after sendRawTransaction accepts the signed
    // transaction. Confirmation is deliberately delegated to the controller's
    // durable settlement barrier so a timeout can never lose a known signature.
    result = await args.raydium.submitPrepared(prepared, {
      live: true,
      simulate: true,
      commitment: "confirmed",
    });
  } catch (error) {
    // Raydium simulation and RPC preflight rejection are provably pre-send.
    if (isRaydiumPreSubmissionFailure(error)) throw error;

    // A transport failure from sendRawTransaction without a returned signature
    // is still ambiguous and must not be automatically retried.
    throw markSubmissionAmbiguous(error, "raydium");
  }
  return {
    venue: "raydium",
    signature: result.signatures.at(-1) ?? null,
    outputRaw: prepared.quote.outputRaw,
    raw: result,
    settlement: {
      recentBlockhash,
      lastValidBlockHeight: null,
      estimatedNetworkFeeLamports,
    },
  };
}

function keyString(value: any): string {
  if (typeof value === "string") return value;
  if (typeof value?.pubkey === "string") return value.pubkey;
  if (typeof value?.pubkey?.toBase58 === "function")
    return value.pubkey.toBase58();
  if (typeof value?.toBase58 === "function") return value.toBase58();
  return String(value ?? "");
}

function transactionAccountKeys(tx: any): string[] {
  const message = tx?.transaction?.message;
  if (Array.isArray(message?.accountKeys))
    return message.accountKeys.map(keyString);
  if (Array.isArray(message?.staticAccountKeys)) {
    const keys = message.staticAccountKeys.map(keyString);
    const loaded = tx?.meta?.loadedAddresses;
    if (Array.isArray(loaded?.writable))
      keys.push(...loaded.writable.map(keyString));
    if (Array.isArray(loaded?.readonly))
      keys.push(...loaded.readonly.map(keyString));
    return keys;
  }
  return [];
}

function ownerTokenRaw(
  rows: any[] | null | undefined,
  owner: string,
  mint: string,
): { raw: bigint; decimals: number | null } {
  let raw = 0n;
  let decimals: number | null = null;
  for (const row of rows ?? []) {
    if (keyString(row?.owner) !== owner || String(row?.mint ?? "") !== mint)
      continue;
    const amount = row?.uiTokenAmount?.amount;
    if (typeof amount !== "string" || !/^\d+$/.test(amount)) continue;
    raw += BigInt(amount);
    const d = Number(row?.uiTokenAmount?.decimals);
    if (Number.isInteger(d) && d >= 0) decimals = d;
  }
  return { raw, decimals };
}

type TransactionSolEconomics = {
  /** Positive means the wallet gained SOL-like economic value; negative means it spent it. */
  economicLamports: bigint;
  networkFeeLamports: bigint;
  ownerNativeDeltaLamports: bigint;
  ownedTokenAccountLamportDelta: bigint;
  feeAdjustedOwnerNativeDeltaLamports: bigint;
  ownedTokenAccountIndexes: number[];
};

/**
 * Derive transaction-local SOL/WSOL economics for one wallet without using a
 * later wallet snapshot. The fee payer's network fee is added back because the
 * strategy journal tracks trade economics, not validator fees. Lamport changes
 * on wallet-owned SPL accounts are folded in so recoverable ATA rent creation /
 * closure is not mistaken for trading principal and existing WSOL account
 * balance changes are counted as SOL-like value.
 */
function transactionSolEconomics(
  tx: any,
  owner: string,
): TransactionSolEconomics | null {
  const keys = transactionAccountKeys(tx);
  const ownerIndex = keys.indexOf(owner);
  const preBalances = tx?.meta?.preBalances;
  const postBalances = tx?.meta?.postBalances;
  if (
    ownerIndex < 0 ||
    !Array.isArray(preBalances) ||
    !Array.isArray(postBalances) ||
    preBalances[ownerIndex] == null ||
    postBalances[ownerIndex] == null
  ) {
    return null;
  }

  const networkFeeLamports = BigInt(tx?.meta?.fee ?? 0);
  const ownerNativeDeltaLamports =
    BigInt(postBalances[ownerIndex]) - BigInt(preBalances[ownerIndex]);
  // Solana charges the transaction fee to account index 0 (the fee payer).
  const feeAdjustedOwnerNativeDeltaLamports =
    ownerNativeDeltaLamports + (ownerIndex === 0 ? networkFeeLamports : 0n);

  const tokenAccountIndexes = new Set<number>();
  for (const row of [
    ...(tx?.meta?.preTokenBalances ?? []),
    ...(tx?.meta?.postTokenBalances ?? []),
  ]) {
    if (keyString(row?.owner) !== owner) continue;
    const index = Number(row?.accountIndex);
    if (Number.isInteger(index) && index >= 0 && index !== ownerIndex)
      tokenAccountIndexes.add(index);
  }

  let ownedTokenAccountLamportDelta = 0n;
  for (const index of tokenAccountIndexes) {
    if (preBalances[index] == null || postBalances[index] == null) continue;
    ownedTokenAccountLamportDelta +=
      BigInt(postBalances[index]) - BigInt(preBalances[index]);
  }

  return {
    economicLamports:
      feeAdjustedOwnerNativeDeltaLamports + ownedTokenAccountLamportDelta,
    networkFeeLamports,
    ownerNativeDeltaLamports,
    ownedTokenAccountLamportDelta,
    feeAdjustedOwnerNativeDeltaLamports,
    ownedTokenAccountIndexes: [...tokenAccountIndexes].sort((a, b) => a - b),
  };
}

function quoteBuyPriceSol(
  quote: RoutedQuote,
  decimals: number,
  slippageBps: number,
): { expectedPriceSol: number; guardedPriceSol: number } | null {
  if (quote.inputRaw <= 0n || quote.outputRaw <= 0n) return null;
  const scale = 10 ** decimals;
  const expectedTokensUi = Number(quote.outputRaw) / scale;
  if (!(expectedTokensUi > 0)) return null;
  const inputSol = Number(quote.inputRaw) / 1e9;
  const expectedPriceSol = inputSol / expectedTokensUi;
  let guardedOutputRaw = quote.minOutputRaw;
  if (guardedOutputRaw == null) {
    const keepBps = Math.max(0, 10_000 - slippageBps);
    guardedOutputRaw = (quote.outputRaw * BigInt(keepBps)) / 10_000n;
  }
  if (guardedOutputRaw <= 0n) return null;
  const guardedTokensUi = Number(guardedOutputRaw) / scale;
  if (!(guardedTokensUi > 0)) return null;
  return {
    expectedPriceSol,
    guardedPriceSol: inputSol / guardedTokensUi,
  };
}

function quoteSellPriceSol(
  quote: RoutedQuote,
  decimals: number,
  slippageBps: number,
): { expectedPriceSol: number; guardedPriceSol: number } | null {
  if (quote.inputRaw <= 0n || quote.outputRaw <= 0n) return null;
  const scale = 10 ** decimals;
  const inputTokensUi = Number(quote.inputRaw) / scale;
  if (!(inputTokensUi > 0)) return null;
  const expectedPriceSol = Number(quote.outputRaw) / 1e9 / inputTokensUi;
  let guardedOutputRaw = quote.minOutputRaw;
  if (guardedOutputRaw == null) {
    const keepBps = Math.max(0, 10_000 - slippageBps);
    guardedOutputRaw = (quote.outputRaw * BigInt(keepBps)) / 10_000n;
  }
  if (guardedOutputRaw <= 0n) return null;
  return {
    expectedPriceSol,
    guardedPriceSol: Number(guardedOutputRaw) / 1e9 / inputTokensUi,
  };
}

function minimumBuyOutputRawForPrice(
  inputLamports: bigint,
  decimals: number,
  maxPriceSol: number,
): bigint | null {
  if (
    inputLamports <= 0n ||
    !Number.isFinite(maxPriceSol) ||
    !(maxPriceSol > 0)
  )
    return null;
  const raw = Math.ceil(
    (Number(inputLamports) / 1e9 / maxPriceSol) * 10 ** decimals,
  );
  return Number.isSafeInteger(raw) && raw > 0 ? BigInt(raw) : null;
}

function minimumFlatBuyOutputRawForRawPrice(
  inputLamports: bigint,
  maxLamportsPerRawToken: number,
): bigint | null {
  if (
    inputLamports <= 0n ||
    !Number.isFinite(maxLamportsPerRawToken) ||
    !(maxLamportsPerRawToken > 0)
  )
    return null;
  const raw = Math.ceil(Number(inputLamports) / maxLamportsPerRawToken);
  return Number.isSafeInteger(raw) && raw > 0 ? BigInt(raw) : null;
}

function minimumSellOutputRawForPrice(
  inputTokenRaw: bigint,
  decimals: number,
  minPriceSol: number,
): bigint | null {
  if (
    inputTokenRaw <= 0n ||
    !Number.isFinite(minPriceSol) ||
    !(minPriceSol > 0)
  )
    return null;
  const raw = Math.ceil(
    (Number(inputTokenRaw) / 10 ** decimals) * minPriceSol * 1e9,
  );
  return Number.isSafeInteger(raw) && raw > 0 ? BigInt(raw) : null;
}

async function snapshot(
  slrd: ReturnType<typeof createTraderSolard>,
  raydium: RaydiumService,
  routing: VenueMode,
  slippageBps: number,
  walletRef: string,
  mint: string,
): Promise<Snapshot> {
  const wallet = slrd.resolveWallet(walletRef);
  const [accounts, lamports] = await Promise.all([
    slrd.tokenAccounts(walletRef),
    slrd.connection().getBalance(wallet.address, "confirmed"),
  ]);
  const mine = accounts.filter(
    (row) => row.mint === mint && row.isAssociated && row.amountRaw > 0n,
  );
  const amountRaw = mine.reduce((sum, row) => sum + row.amountRaw, 0n);
  const decimals = mine[0]?.decimals ?? null;
  const amountUi = decimals == null ? null : Number(amountRaw) / 10 ** decimals;
  let quote: RoutedQuote | null = null;
  let liquidationSol = 0;

  if (amountRaw > 0n) {
    quote = await quoteBestRoute({
      slrd,
      walletRef,
      mint,
      raydium,
      mode: routing,
      inputMint: mint,
      outputMint: WSOL,
      amountRaw,
      slippageBps,
    });
    liquidationSol = Number(quote.outputRaw) / 1e9;
  }

  const ownedTokenAccountLamports = accounts.reduce(
    (sum, row) => sum + row.lamports,
    0n,
  );

  return {
    atMs: Date.now(),
    amountRaw,
    decimals,
    amountUi,
    liquidationSol,
    walletSol: Number(lamports) / 1e9,
    walletLamports: BigInt(lamports),
    ownedTokenAccountLamports,
    effectivePriceSol:
      amountUi != null && amountUi > 0 ? liquidationSol / amountUi : null,
    quote,
  };
}

async function sizeSameTokens(args: {
  slrd: ReturnType<typeof createTraderSolard>;
  raydium: RaydiumService;
  walletRef: string;
  routing: VenueMode;
  slippageBps: number;
  mint: string;
  tokenRaw: bigint;
  maxLamports: bigint;
  iterations: number;
}): Promise<{ lamports: bigint; expectedTokensRaw: bigint; venue: SwapVenue }> {
  if (args.tokenRaw <= 0n || args.maxLamports <= 0n)
    return { lamports: 0n, expectedTokensRaw: 0n, venue: "raydium" };

  let low = 1n;
  let high = args.maxLamports;
  for (let i = 0; i < args.iterations && high - low > 1n; i += 1) {
    const mid = (low + high) / 2n;
    const q = await quoteBestRoute({
      slrd: args.slrd,
      walletRef: args.walletRef,
      mint: args.mint,
      raydium: args.raydium,
      mode: args.routing,
      inputMint: WSOL,
      outputMint: args.mint,
      amountRaw: mid,
      slippageBps: args.slippageBps,
    });
    if (q.outputRaw < args.tokenRaw) low = mid + 1n;
    else high = mid;
  }

  const q = await quoteBestRoute({
    slrd: args.slrd,
    walletRef: args.walletRef,
    mint: args.mint,
    raydium: args.raydium,
    mode: args.routing,
    inputMint: WSOL,
    outputMint: args.mint,
    amountRaw: high,
    slippageBps: args.slippageBps,
  });
  return { lamports: high, expectedTokensRaw: q.outputRaw, venue: q.venue };
}

async function futureLiquidationForBuy(args: {
  slrd: ReturnType<typeof createTraderSolard>;
  raydium: RaydiumService;
  walletRef: string;
  routing: VenueMode;
  slippageBps: number;
  mint: string;
  currentRaw: bigint;
  buyLamports: bigint;
}): Promise<{ liquidationSol: number; outRaw: bigint; venue: SwapVenue }> {
  const buy = await quoteBestRoute({
    slrd: args.slrd,
    walletRef: args.walletRef,
    mint: args.mint,
    raydium: args.raydium,
    mode: args.routing,
    inputMint: WSOL,
    outputMint: args.mint,
    amountRaw: args.buyLamports,
    slippageBps: args.slippageBps,
  });
  const totalRaw = args.currentRaw + buy.outputRaw;
  const sell = await quoteBestRoute({
    slrd: args.slrd,
    walletRef: args.walletRef,
    mint: args.mint,
    raydium: args.raydium,
    mode: args.routing,
    inputMint: args.mint,
    outputMint: WSOL,
    amountRaw: totalRaw,
    slippageBps: args.slippageBps,
  });
  return {
    liquidationSol: Number(sell.outputRaw) / 1e9,
    outRaw: buy.outputRaw,
    venue: buy.venue,
  };
}

async function sizeToBase(args: {
  slrd: ReturnType<typeof createTraderSolard>;
  raydium: RaydiumService;
  walletRef: string;
  routing: VenueMode;
  slippageBps: number;
  mint: string;
  currentRaw: bigint;
  targetSol: number;
  maxLamports: bigint;
  iterations: number;
}): Promise<{
  lamports: bigint;
  expectedLiquidationSol: number;
  expectedTokensRaw: bigint;
  venue: SwapVenue;
}> {
  if (args.maxLamports <= 0n)
    return {
      lamports: 0n,
      expectedLiquidationSol: 0,
      expectedTokensRaw: 0n,
      venue: "raydium",
    };

  // If already at/above target, never manufacture a minimum-sized buy.
  if (args.currentRaw > 0n) {
    const currentSell = await quoteBestRoute({
      slrd: args.slrd,
      walletRef: args.walletRef,
      mint: args.mint,
      raydium: args.raydium,
      mode: args.routing,
      inputMint: args.mint,
      outputMint: WSOL,
      amountRaw: args.currentRaw,
      slippageBps: args.slippageBps,
    });
    const currentLiquidationSol = Number(currentSell.outputRaw) / 1e9;
    if (currentLiquidationSol >= args.targetSol) {
      return {
        lamports: 0n,
        expectedLiquidationSol: currentLiquidationSol,
        expectedTokensRaw: 0n,
        venue: currentSell.venue,
      };
    }
  }

  let low = 1n;
  let high = args.maxLamports;
  for (let i = 0; i < args.iterations && high - low > 1n; i += 1) {
    const mid = (low + high) / 2n;
    const evaluated = await futureLiquidationForBuy({
      slrd: args.slrd,
      raydium: args.raydium,
      walletRef: args.walletRef,
      routing: args.routing,
      slippageBps: args.slippageBps,
      mint: args.mint,
      currentRaw: args.currentRaw,
      buyLamports: mid,
    });
    if (evaluated.liquidationSol < args.targetSol) low = mid + 1n;
    else high = mid;
  }

  const evaluated = await futureLiquidationForBuy({
    slrd: args.slrd,
    raydium: args.raydium,
    walletRef: args.walletRef,
    routing: args.routing,
    slippageBps: args.slippageBps,
    mint: args.mint,
    currentRaw: args.currentRaw,
    buyLamports: high,
  });
  return {
    lamports: high,
    expectedLiquidationSol: evaluated.liquidationSol,
    expectedTokensRaw: evaluated.outRaw,
    venue: evaluated.venue,
  };
}

export async function runValueBandAgent(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const flags = parseArgs(argv);
  if (flags.has("help")) {
    process.stdout.write(
      "Usage: slrd run examples/position-controller.ts --token <mint|alias> --wallet <wallet> " +
        "[--base-sol 0.1] [--lower-multiple 0.5] [--upper-multiple 1.8] [--sell-fraction 0.5] " +
        "[--buy-mode to-base|same-value|same-tokens] [--max-capital-sol 0.5] [--max-buy-sol 0.1] " +
        "[--venue auto|native|raydium|jupiter] [--slippage-bps 150] [--raydium-priority-micro-lamports N] " +
        "[--rebuy-after-sell-drop-pct 12] [--lower-ladder-drop-pct 15] [--take-profit-after-buy-rise-pct 12] " +
        "[--entry-pullback-pct 18] [--reset-entry-peak] [--reset-guards] [--scale-now] " +
        "[--recover-signature <sig> --recover-side buy|sell --recover-venue raydium --recover-only] " +
        "[--sample-ms 5000] [--cooldown-ms 10000] [--error-retry-ms 3000] [--error-retry-max-ms 30000] [--loop] [--live]\n",
    );
    return;
  }

  const tokenRef = required(flags, "token");
  const walletRef = required(flags, "wallet");
  const baseSol = Math.max(0.000001, numberFlag(flags, "base-sol", 0.1));
  const initialLowerMultiple = numberFlag(flags, "lower-sol", NaN);
  const initialUpperMultiple = numberFlag(flags, "upper-sol", NaN);
  const lowerRatio = Number.isFinite(initialLowerMultiple)
    ? initialLowerMultiple / baseSol
    : numberFlag(flags, "lower-multiple", 0.5);
  const upperRatio = Number.isFinite(initialUpperMultiple)
    ? initialUpperMultiple / baseSol
    : numberFlag(flags, "upper-multiple", 1.8);
  const sellFraction = numberFlag(flags, "sell-fraction", 0.5);
  const sampleMs = Math.max(1_000, integerFlag(flags, "sample-ms", 5_000));
  const cooldownMs = Math.max(0, integerFlag(flags, "cooldown-ms", 10_000));
  const errorRetryMs = Math.max(
    500,
    integerFlag(flags, "error-retry-ms", 3_000),
  );
  const errorRetryMaxMs = Math.max(
    errorRetryMs,
    integerFlag(flags, "error-retry-max-ms", 30_000),
  );
  const rebuyAfterSellDropPct = Math.max(
    0,
    Math.min(95, numberFlag(flags, "rebuy-after-sell-drop-pct", 12)),
  );
  const lowerLadderDropPct = Math.max(
    0,
    Math.min(95, numberFlag(flags, "lower-ladder-drop-pct", 15)),
  );
  const takeProfitAfterBuyRisePct = Math.max(
    0,
    Math.min(1_000, numberFlag(flags, "take-profit-after-buy-rise-pct", 12)),
  );
  // Disabled unless explicitly supplied. When >0 and inventory is empty, the
  // controller observes a fixed-size executable buy quote, remembers its highest
  // price, and bootstraps only after the configured retracement from that peak.
  const entryPullbackPct = Math.max(
    0,
    Math.min(95, numberFlag(flags, "entry-pullback-pct", 0)),
  );
  const sizingIterations = Math.max(
    2,
    Math.min(8, integerFlag(flags, "sizing-iterations", 4)),
  );
  const minTradeSol = Math.max(0, numberFlag(flags, "min-trade-sol", 0.001));
  const reserveSol = Math.max(0, numberFlag(flags, "reserve-sol", 0.02));
  const explicitMaxCapital = flag(flags, "max-capital-sol");
  const explicitMaxBuy = flag(flags, "max-buy-sol");
  const mode = buyMode(flags);
  const routing = venueMode(flags);
  const slippageBps = Math.max(
    0,
    Math.min(10_000, integerFlag(flags, "slippage-bps", 150)),
  );
  const raydiumPriorityMicroLamports = flag(
    flags,
    "raydium-priority-micro-lamports",
  );
  const live = flags.has("live");

  if (live && !liveEnabled()) {
    throw new Error(
      "Live value-band trading requires --live and SOLARD_ENABLE_LIVE_TRADES=1",
    );
  }

  const slrd = createTraderSolard();
  const raydium = new RaydiumService(slrd);
  const mint = resolveMint(slrd, tokenRef);
  const wallet = slrd.resolveWallet(walletRef).address.toBase58();

  // For auto/native, eagerly let Solard inspect a raw Pump mint so routing is
  // based on the canonical venue registry rather than whether the token happened
  // to be registered by an earlier command. Failure is allowed in auto mode: a
  // non-Pump token may still be handled by direct Raydium.
  if (routing === "auto" || routing === "native") {
    try {
      if (!slrd.tokens.list().some((row) => row.mint === mint))
        await slrd.addToken(mint);
    } catch (error) {
      if (routing === "native") throw error;
    }
  }
  const statePath = journalPath(flags, wallet, mint);
  const journal = readJournal(statePath, wallet, mint);

  const note = <T>(label: string, data: T): T =>
    m.sync(
      {
        start: () => label,
        end: (value: T) => value,
      },
      () => data,
    );

  const currentWalletSettlementState = async () => {
    const [accounts, lamports] = await Promise.all([
      slrd.tokenAccounts(walletRef),
      slrd
        .connection()
        .getBalance(slrd.resolveWallet(walletRef).address, "confirmed"),
    ]);
    const mintAccounts = accounts.filter(
      (row) => row.mint === mint && row.isAssociated,
    );
    const currentRaw = mintAccounts.reduce(
      (sum, row) => sum + row.amountRaw,
      0n,
    );
    const decimals =
      mintAccounts.find((row) => Number.isInteger(row.decimals))?.decimals ??
      null;
    const ownedTokenAccountLamports = accounts.reduce(
      (sum, row) => sum + row.lamports,
      0n,
    );
    return {
      accounts,
      mintAccounts,
      currentRaw,
      decimals,
      walletLamports: BigInt(lamports),
      ownedTokenAccountLamports,
    };
  };

  const walletSignatureHistory = async (signature: string) => {
    const rows = await slrd
      .connection()
      .getSignaturesForAddress(
        new PublicKey(wallet),
        { limit: 1000 },
        "confirmed",
      );
    const index = rows.findIndex((row) => row.signature === signature);
    const row = index >= 0 ? rows[index]! : null;
    return {
      found: row != null,
      latest: index === 0,
      err: row?.err ?? null,
      confirmationStatus: row?.confirmationStatus ?? null,
    };
  };

  const tokenSignatureHistory = async (
    signature: string,
    addresses: string[],
  ) => {
    let found = false;
    let latest = true;
    for (const address of addresses) {
      const rows = await slrd
        .connection()
        .getSignaturesForAddress(
          new PublicKey(address),
          { limit: 100 },
          "confirmed",
        );
      const index = rows.findIndex((row) => row.signature === signature);
      if (index < 0) continue;
      found = true;
      if (index !== 0) latest = false;
    }
    return { found, latest };
  };

  const finalizePendingSettlement = (args: {
    pending: PendingSettlement;
    tokenDeltaRaw: bigint;
    decimals: number;
    economicLamports: bigint;
    proof: string;
    networkFeeLamports?: bigint | null;
    ownerNativeDeltaLamports?: bigint | null;
    ownedTokenAccountLamportDelta?: bigint | null;
  }): void => {
    const tokenScale = 10 ** args.decimals;
    if (args.pending.side === "buy") {
      const tokensReceivedUi = Number(args.tokenDeltaRaw) / tokenScale;
      const spendLamports = -args.economicLamports;
      if (spendLamports <= 0n || !(tokensReceivedUi > 0)) {
        throw new Error(
          `Invalid confirmed buy economics for ${args.pending.signature}`,
        );
      }
      const buySol = Number(spendLamports) / 1e9;
      recordBuy(journal, buySol);
      journal.lastTradeSide = "buy";
      journal.lastBuyAtMs = args.pending.submittedAtMs;
      journal.lastBuyPriceSol = buySol / tokensReceivedUi;
      journal.lastSellPriceSol = null;
      clearEntryPeak(journal);
    } else {
      const proceedsLamports = args.economicLamports;
      const tokensSoldUi = Number(-args.tokenDeltaRaw) / tokenScale;
      if (proceedsLamports <= 0n || !(tokensSoldUi > 0)) {
        throw new Error(
          `Invalid confirmed sell economics for ${args.pending.signature}`,
        );
      }
      const actualSol = Number(proceedsLamports) / 1e9;
      recordSell(journal, actualSol);
      journal.lastTradeSide = "sell";
      journal.lastSellAtMs = args.pending.submittedAtMs;
      journal.lastSellPriceSol = actualSol / tokensSoldUi;
    }

    lastTradeAt = Math.max(journal.lastBuyAtMs ?? 0, journal.lastSellAtMs ?? 0);
    journal.lastSettledSignature = args.pending.signature;
    journal.pendingSettlement = null;
    writeJournal(statePath, journal);
    note("settlement.settled", {
      side: args.pending.side,
      venue: args.pending.venue,
      signature: args.pending.signature,
      proof: args.proof,
      tokenDeltaRaw: args.tokenDeltaRaw.toString(),
      economicSolDelta: Number(args.economicLamports) / 1e9,
      networkFeeSol:
        args.networkFeeLamports == null
          ? null
          : Number(args.networkFeeLamports) / 1e9,
      ownerNativeDeltaSol:
        args.ownerNativeDeltaLamports == null
          ? null
          : Number(args.ownerNativeDeltaLamports) / 1e9,
      ownedTokenAccountLamportDeltaSol:
        args.ownedTokenAccountLamportDelta == null
          ? null
          : Number(args.ownedTokenAccountLamportDelta) / 1e9,
      lastBuyPriceSol: journal.lastBuyPriceSol,
      lastSellPriceSol: journal.lastSellPriceSol,
      cumulativeBuySol: journal.cumulativeBuySol,
      cumulativeSellSol: journal.cumulativeSellSol,
      netCapitalSol: netCapital(journal),
    });
  };

  const recoverSignature = flag(flags, "recover-signature");
  if (recoverSignature) {
    const recoverSideRaw = flag(flags, "recover-side");
    if (recoverSideRaw !== "buy" && recoverSideRaw !== "sell") {
      throw new Error("--recover-signature requires --recover-side buy|sell");
    }
    const recoverVenueRaw = flag(flags, "recover-venue") ?? "raydium";
    if (
      recoverVenueRaw !== "raydium" &&
      recoverVenueRaw !== "jupiter" &&
      recoverVenueRaw !== "pump-curve" &&
      recoverVenueRaw !== "pumpswap"
    ) {
      throw new Error(
        "--recover-venue must be raydium, jupiter, pump-curve, or pumpswap",
      );
    }
    if (
      journal.pendingSettlement &&
      journal.pendingSettlement.signature !== recoverSignature
    ) {
      throw new Error(
        `Cannot recover ${recoverSignature} while different settlement ${journal.pendingSettlement.signature} is pending`,
      );
    }

    if (journal.lastSettledSignature === recoverSignature) {
      note("settlement.recover.already-applied", {
        signature: recoverSignature,
      });
    } else {
      const connection = slrd.connection();
      let tx: any = await connection.getTransaction(recoverSignature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) {
        try {
          tx = await connection.getParsedTransaction(recoverSignature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
        } catch {
          // handled below
        }
      }
      if (!tx) {
        throw new Error(
          `Recovery signature ${recoverSignature} is not available as a confirmed transaction yet; refusing to trade or guess its outcome`,
        );
      }
      if (tx.meta?.err) {
        throw new Error(
          `Recovery signature ${recoverSignature} failed on-chain: ${JSON.stringify(tx.meta.err)}`,
        );
      }

      const preToken = ownerTokenRaw(tx.meta?.preTokenBalances, wallet, mint);
      const postToken = ownerTokenRaw(tx.meta?.postTokenBalances, wallet, mint);
      const tokenDeltaRaw = postToken.raw - preToken.raw;
      if (recoverSideRaw === "buy" && tokenDeltaRaw <= 0n) {
        throw new Error(
          `Recovery signature ${recoverSignature} does not prove a buy token delta`,
        );
      }
      if (recoverSideRaw === "sell" && tokenDeltaRaw >= 0n) {
        throw new Error(
          `Recovery signature ${recoverSignature} does not prove a sell token delta`,
        );
      }
      const decimals = postToken.decimals ?? preToken.decimals;
      if (decimals == null) {
        throw new Error(
          `Recovery signature ${recoverSignature} has no token decimals`,
        );
      }
      const solEconomics = transactionSolEconomics(tx, wallet);
      if (!solEconomics) {
        throw new Error(
          `Recovery signature ${recoverSignature} has no provable wallet SOL economics`,
        );
      }

      const pending: PendingSettlement = {
        side: recoverSideRaw,
        venue: recoverVenueRaw,
        signature: recoverSignature,
        requestedInputRaw: "0",
        quotedOutputRaw: "0",
        preTokenRaw: preToken.raw.toString(),
        submittedAtMs:
          typeof tx.blockTime === "number" && tx.blockTime > 0
            ? tx.blockTime * 1_000
            : Date.now(),
      };
      finalizePendingSettlement({
        pending,
        tokenDeltaRaw,
        decimals,
        economicLamports: solEconomics.economicLamports,
        proof: "explicit-signature-transaction-metadata-recovery",
        networkFeeLamports: solEconomics.networkFeeLamports,
        ownerNativeDeltaLamports: solEconomics.ownerNativeDeltaLamports,
        ownedTokenAccountLamportDelta:
          solEconomics.ownedTokenAccountLamportDelta,
      });
      note("settlement.recover.applied", {
        signature: recoverSignature,
        side: recoverSideRaw,
        venue: recoverVenueRaw,
      });
    }

    if (flags.has("recover-only")) return;
  }

  const reconcilePendingSettlement = async (): Promise<boolean> => {
    const pending = journal.pendingSettlement;
    if (!pending) return true;

    const result = await m(
      {
        start: () => `settlement.reconcile.${pending.side}`,
        end: (value: {
          settled: boolean;
          reason: string;
          signature: string;
          signatureStatus?: string | null;
        }) => value,
      },
      async () => {
        const connection = slrd.connection();
        const statusResponse = await connection.getSignatureStatuses(
          [pending.signature],
          { searchTransactionHistory: true },
        );
        const status = statusResponse.value[0] ?? null;
        if (status?.err) {
          journal.pendingSettlement = null;
          writeJournal(statePath, journal);
          throw new Error(
            `Submitted ${pending.side} ${pending.signature} failed on-chain: ${JSON.stringify(status.err)}`,
          );
        }

        const statusName =
          status?.confirmationStatus ??
          (status?.confirmations === null
            ? "finalized"
            : status
              ? "processed"
              : null);

        // Transaction metadata remains the strongest source because it isolates
        // this transaction's exact token/SOL effects. Try both raw and parsed
        // RPC surfaces before using the durable balance fallback below.
        let tx: any = await connection.getTransaction(pending.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (!tx && (statusName === "confirmed" || statusName === "finalized")) {
          try {
            tx = await connection.getParsedTransaction(pending.signature, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            });
          } catch {
            // Some providers expose one transaction surface before the other.
          }
        }

        if (tx) {
          if (tx.meta?.err) {
            journal.pendingSettlement = null;
            writeJournal(statePath, journal);
            throw new Error(
              `Submitted ${pending.side} ${pending.signature} failed on-chain: ${JSON.stringify(tx.meta.err)}`,
            );
          }

          const preToken = ownerTokenRaw(
            tx.meta?.preTokenBalances,
            wallet,
            mint,
          );
          const postToken = ownerTokenRaw(
            tx.meta?.postTokenBalances,
            wallet,
            mint,
          );
          const tokenDeltaRaw = postToken.raw - preToken.raw;
          if (pending.side === "buy" && tokenDeltaRaw <= 0n)
            return {
              settled: false,
              reason: "buy token delta not visible in tx metadata",
              signature: pending.signature,
              signatureStatus: statusName,
            };
          if (pending.side === "sell" && tokenDeltaRaw >= 0n)
            return {
              settled: false,
              reason: "sell token delta not visible in tx metadata",
              signature: pending.signature,
              signatureStatus: statusName,
            };

          const expectedPostRaw = BigInt(pending.preTokenRaw) + tokenDeltaRaw;
          const current = await currentWalletSettlementState();
          if (current.currentRaw !== expectedPostRaw) {
            note("settlement.wait-wallet-index", {
              side: pending.side,
              signature: pending.signature,
              expectedPostTokenRaw: expectedPostRaw.toString(),
              observedTokenRaw: current.currentRaw.toString(),
            });
            return {
              settled: false,
              reason: "wallet token index has not caught up",
              signature: pending.signature,
              signatureStatus: statusName,
            };
          }

          const decimals =
            postToken.decimals ?? preToken.decimals ?? current.decimals;
          if (decimals == null)
            return {
              settled: false,
              reason: "token decimals unavailable",
              signature: pending.signature,
              signatureStatus: statusName,
            };

          const solEconomics = transactionSolEconomics(tx, wallet);
          if (!solEconomics)
            return {
              settled: false,
              reason: "wallet SOL economics not provable from tx metadata",
              signature: pending.signature,
              signatureStatus: statusName,
            };

          finalizePendingSettlement({
            pending,
            tokenDeltaRaw,
            decimals,
            economicLamports: solEconomics.economicLamports,
            proof: "transaction-metadata",
            networkFeeLamports: solEconomics.networkFeeLamports,
            ownerNativeDeltaLamports: solEconomics.ownerNativeDeltaLamports,
            ownedTokenAccountLamportDelta:
              solEconomics.ownedTokenAccountLamportDelta,
          });
          return {
            settled: true,
            reason: "confirmed tx and wallet index agree",
            signature: pending.signature,
            signatureStatus: statusName,
          };
        }

        // If the provider's transaction-meta index is lagging, independently
        // consult wallet signature history. This also distinguishes a genuinely
        // unseen/dropped signature from a confirmed transaction whose metadata
        // endpoint is stale.
        const history = await walletSignatureHistory(pending.signature);
        if (history.err) {
          journal.pendingSettlement = null;
          writeJournal(statePath, journal);
          throw new Error(
            `Submitted ${pending.side} ${pending.signature} failed on-chain: ${JSON.stringify(history.err)}`,
          );
        }
        const historyStatus = history.confirmationStatus;
        const confirmed =
          statusName === "confirmed" ||
          statusName === "finalized" ||
          historyStatus === "confirmed" ||
          historyStatus === "finalized";

        if (!confirmed) {
          const current = await currentWalletSettlementState();
          const preTokenRaw = BigInt(pending.preTokenRaw);

          // Locally compiled native trades carry exact blockhash expiry in new
          // journals. Once that height is past, an unseen signature cannot later
          // land. Clear only when the token balance also proves no trade effect.
          if (pending.lastValidBlockHeight != null && !history.found) {
            const currentBlockHeight =
              await connection.getBlockHeight("confirmed");
            if (
              currentBlockHeight > pending.lastValidBlockHeight &&
              current.currentRaw === preTokenRaw
            ) {
              journal.pendingSettlement = null;
              writeJournal(statePath, journal);
              note("settlement.expired-unseen", {
                side: pending.side,
                signature: pending.signature,
                lastValidBlockHeight: pending.lastValidBlockHeight,
                currentBlockHeight,
              });
              return {
                settled: true,
                reason: "submission expired unseen; pending cleared",
                signature: pending.signature,
                signatureStatus: statusName,
              };
            }
          }

          // Raydium Trade API transactions expose their recent blockhash but
          // not the matching lastValidBlockHeight. The RPC can still prove the
          // blockhash is no longer valid. If the signature is absent from wallet
          // history and token balance is unchanged, it can no longer land.
          if (
            pending.lastValidBlockHeight == null &&
            pending.recentBlockhash &&
            !history.found
          ) {
            try {
              const validity = await connection.isBlockhashValid(
                pending.recentBlockhash,
                "confirmed",
              );
              if (!validity.value && current.currentRaw === preTokenRaw) {
                journal.pendingSettlement = null;
                writeJournal(statePath, journal);
                note("settlement.blockhash-expired-unseen", {
                  side: pending.side,
                  signature: pending.signature,
                  recentBlockhash: pending.recentBlockhash,
                });
                return {
                  settled: true,
                  reason:
                    "submission blockhash expired unseen; pending cleared",
                  signature: pending.signature,
                  signatureStatus: statusName,
                };
              }
            } catch {
              // Fall through to conservative age-based legacy expiry below.
            }
          }

          // Backward-compatible recovery for journals created before blockhash
          // expiry was persisted. Three minutes is deliberately far beyond a
          // normal recent-blockhash lifetime. We still require the signature to
          // be absent from wallet history AND the token balance to be unchanged.
          const legacyExpiryMs = 180_000;
          if (
            pending.lastValidBlockHeight == null &&
            !history.found &&
            Date.now() - pending.submittedAtMs >= legacyExpiryMs &&
            current.currentRaw === preTokenRaw
          ) {
            journal.pendingSettlement = null;
            writeJournal(statePath, journal);
            note("settlement.legacy-expired-unseen", {
              side: pending.side,
              signature: pending.signature,
              ageMs: Date.now() - pending.submittedAtMs,
            });
            return {
              settled: true,
              reason:
                "legacy submission unseen after conservative expiry; pending cleared",
              signature: pending.signature,
              signatureStatus: statusName,
            };
          }

          return {
            settled: false,
            reason: status
              ? `signature ${statusName ?? "pending"}; waiting for confirmation`
              : "signature not yet found in status/history",
            signature: pending.signature,
            signatureStatus: statusName,
          };
        }

        const current = await currentWalletSettlementState();
        const preTokenRaw = BigInt(pending.preTokenRaw);
        const tokenDeltaRaw = current.currentRaw - preTokenRaw;
        if (pending.side === "buy" && tokenDeltaRaw <= 0n)
          return {
            settled: false,
            reason: "signature confirmed; waiting for wallet buy token delta",
            signature: pending.signature,
            signatureStatus: statusName ?? historyStatus,
          };
        if (pending.side === "sell" && tokenDeltaRaw >= 0n)
          return {
            settled: false,
            reason: "signature confirmed; waiting for wallet sell token delta",
            signature: pending.signature,
            signatureStatus: statusName ?? historyStatus,
          };
        if (current.decimals == null)
          return {
            settled: false,
            reason: "signature confirmed; token decimals unavailable",
            signature: pending.signature,
            signatureStatus: statusName ?? historyStatus,
          };

        // Balance fallback is allowed only while this signature remains the
        // latest wallet transaction and the latest transaction touching the
        // strategy token ATA. That prevents unrelated later activity from being
        // misattributed to this pending trade.
        const tokenHistory = await tokenSignatureHistory(
          pending.signature,
          current.mintAccounts.map((row) => row.address),
        );
        if (
          !history.found ||
          !history.latest ||
          !tokenHistory.found ||
          !tokenHistory.latest
        ) {
          return {
            settled: false,
            reason:
              "signature confirmed but transaction metadata unavailable and newer/unattributed wallet activity prevents balance-delta settlement",
            signature: pending.signature,
            signatureStatus: statusName ?? historyStatus,
          };
        }

        // Existing v1 journals did not persist pre-submit SOL accounting. A
        // PumpSwap BuyExactQuoteIn has one useful exception: requestedInputRaw is
        // the exact quote budget consumed by the protocol, so a confirmed latest
        // signature plus its latest token-account delta is sufficient to recover
        // the buy without guessing from a later SOL balance.
        if (pending.side === "buy" && pending.venue === "pumpswap") {
          const spendLamports = BigInt(pending.requestedInputRaw);
          finalizePendingSettlement({
            pending,
            tokenDeltaRaw,
            decimals: current.decimals,
            economicLamports: -spendLamports,
            proof:
              "confirmed-signature+latest-wallet/token-history+pumpswap-exact-input",
          });
          return {
            settled: true,
            reason:
              "confirmed PumpSwap exact-input buy settled from wallet delta",
            signature: pending.signature,
            signatureStatus: statusName ?? historyStatus,
          };
        }

        const hasBalanceProof =
          pending.preWalletLamports != null &&
          pending.preOwnedTokenAccountLamports != null &&
          pending.estimatedNetworkFeeLamports != null;
        if (!hasBalanceProof) {
          return {
            settled: false,
            reason:
              "signature confirmed but transaction metadata unavailable; legacy journal lacks pre-submit accounting proof",
            signature: pending.signature,
            signatureStatus: statusName ?? historyStatus,
          };
        }

        const preWalletLamports = BigInt(pending.preWalletLamports!);
        const preOwnedLamports = BigInt(pending.preOwnedTokenAccountLamports!);
        const networkFeeLamports = BigInt(pending.estimatedNetworkFeeLamports!);
        const ownerNativeDeltaLamports =
          current.walletLamports - preWalletLamports;
        const ownedTokenAccountLamportDelta =
          current.ownedTokenAccountLamports - preOwnedLamports;
        const economicLamports =
          ownerNativeDeltaLamports +
          ownedTokenAccountLamportDelta +
          networkFeeLamports;

        finalizePendingSettlement({
          pending,
          tokenDeltaRaw,
          decimals: current.decimals,
          economicLamports,
          proof: "confirmed-signature+latest-balance-delta",
          networkFeeLamports,
          ownerNativeDeltaLamports,
          ownedTokenAccountLamportDelta,
        });
        return {
          settled: true,
          reason: "confirmed signature settled from durable balance proof",
          signature: pending.signature,
          signatureStatus: statusName ?? historyStatus,
        };
      },
    );
    return result.settled;
  };

  const settleWithRetries = async (
    attempts = 8,
    delayMs = 750,
  ): Promise<boolean> => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (await reconcilePendingSettlement()) return true;
      if (attempt < attempts) await sleep(delayMs);
    }
    return false;
  };

  const settlementHoldDecision = (
    snap: Snapshot,
    p: ReturnType<typeof normalizeValueBandPolicy>,
  ): Decision => ({
    action: "hold",
    reason: journal.pendingSettlement
      ? `settlement pending ${journal.pendingSettlement.side} ${journal.pendingSettlement.signature}; trading blocked`
      : "settlement reconciliation",
    liquidationSol: snap.liquidationSol,
    lowerSol: p.baseSol * p.lowerMultiple,
    baseSol: p.baseSol,
    upperSol: p.baseSol * p.upperMultiple,
    executablePriceSol: snap.effectivePriceSol,
    lastTradeSide: journal.lastTradeSide,
    lastBuyPriceSol: journal.lastBuyPriceSol,
    lastSellPriceSol: journal.lastSellPriceSol,
    nextLadderPriceSol: null,
    nextRebuyPriceSol: null,
    minTakeProfitPriceSol: null,
    entryCurrentPriceRaw: null,
    entryPeakPriceRaw: journal.entryPeakPriceRaw,
    entryTriggerPriceRaw: null,
    entryPullbackPct,
  });

  const policy = (): ValueBandPolicy =>
    normalizeValueBandPolicy({
      version: 1,
      kind: "value-band",
      name: "executable-liquidation value band",
      baseSol,
      lowerMultiple: lowerRatio,
      upperMultiple: upperRatio,
      sellFraction,
      buyMode: mode,
      minTradeSol,
      maxCapitalDeployedSol: explicitMaxCapital
        ? Number(explicitMaxCapital)
        : baseSol * 5,
    });

  const maxBuySol = () =>
    Math.max(minTradeSol, explicitMaxBuy ? Number(explicitMaxBuy) : baseSol);

  if (flags.has("reset-guards")) {
    resetGuards(journal);
    if (live) writeJournal(statePath, journal);
    note("state.reset-guards", {
      mint,
      wallet,
      statePath,
      persisted: live,
    });
  } else if (flags.has("reset-entry-peak")) {
    clearEntryPeak(journal);
    if (live) writeJournal(statePath, journal);
    note("state.reset-entry-peak", {
      mint,
      wallet,
      statePath,
      persisted: live,
    });
  }

  let lastTradeAt = Math.max(
    journal.lastBuyAtMs ?? 0,
    journal.lastSellAtMs ?? 0,
  );
  let scaleNow = flags.has("scale-now");
  let stopping = false;
  let consecutiveCycleFailures = 0;
  // executeRoutedSwap marks only errors that occur inside a potentially
  // submitting sender/execution call as submissionAmbiguous. Quote/build/guard
  // failures remain ordinary retryable cycle failures.
  process.once("SIGINT", () => {
    stopping = true;
  });
  process.once("SIGTERM", () => {
    stopping = true;
  });

  note("agent.start", {
    mint,
    wallet,
    live,
    statePath,
    baseSol,
    lowerSol: baseSol * lowerRatio,
    upperSol: baseSol * upperRatio,
    sellFraction,
    buyMode: mode,
    maxCapitalSol: policy().maxCapitalDeployedSol,
    maxBuySol: maxBuySol(),
    reserveSol,
    lowerLadderDropPct,
    rebuyAfterSellDropPct,
    takeProfitAfterBuyRisePct,
    entryPullbackPct,
    entryPeakPriceRaw: journal.entryPeakPriceRaw,
    entryPeakProbeLamports: journal.entryPeakProbeLamports,
    sampleMs,
    cooldownMs,
    errorRetryMs,
    errorRetryMaxMs,
    routing,
    slippageBps,
    raydiumPriorityMicroLamports: raydiumPriorityMicroLamports ?? "auto",
    journal,
  });

  const availableBuyBudget = async (
    p: ReturnType<typeof normalizeValueBandPolicy>,
    snap: Snapshot,
  ): Promise<number> => {
    const capitalRemaining = Math.max(
      0,
      p.maxCapitalDeployedSol - netCapital(journal),
    );
    const walletAvailable = Math.max(0, snap.walletSol - reserveSol);
    return Math.max(
      0,
      Math.min(capitalRemaining, walletAvailable, maxBuySol()),
    );
  };

  const observeFlatEntry = async (): Promise<EntryObservation | null> => {
    if (entryPullbackPct <= 0) return null;

    // Keep the probe amount deterministic across cycles. If the user restarts with
    // a different base/max-buy, the persisted peak is reset because quote-size
    // price impact makes the two observations incomparable.
    const probeSol = Math.max(minTradeSol, Math.min(baseSol, maxBuySol()));
    const probeLamports = BigInt(Math.max(1, Math.floor(probeSol * 1e9)));
    const probeKey = probeLamports.toString();

    const q = await m(
      {
        start: () => "entry.quote",
        end: (value: RoutedQuote) => ({
          venue: value.venue,
          inputRaw: value.inputRaw.toString(),
          outputRaw: value.outputRaw.toString(),
        }),
      },
      () =>
        quoteBestRoute({
          slrd,
          walletRef,
          mint,
          raydium,
          mode: routing,
          inputMint: WSOL,
          outputMint: mint,
          amountRaw: probeLamports,
          slippageBps,
        }),
    );
    if (q.outputRaw <= 0n) return null;

    // Raw-token units are fine here: token decimals are a constant factor and
    // cancel when comparing the same mint and fixed-size quote over time.
    const priceRaw = Number(probeLamports) / Number(q.outputRaw);
    if (!Number.isFinite(priceRaw) || !(priceRaw > 0)) return null;

    let changed = false;
    if (journal.entryPeakProbeLamports !== probeKey) {
      journal.entryPeakProbeLamports = probeKey;
      journal.entryPeakPriceRaw = priceRaw;
      journal.entryPeakAtMs = Date.now();
      changed = true;
      note("entry.peak.reset", {
        reason: "probe-size-changed",
        probeSol,
        priceRaw,
      });
    } else if (
      journal.entryPeakPriceRaw == null ||
      priceRaw > journal.entryPeakPriceRaw
    ) {
      journal.entryPeakPriceRaw = priceRaw;
      journal.entryPeakAtMs = Date.now();
      changed = true;
      note("entry.peak.new", {
        probeSol,
        priceRaw,
        atMs: journal.entryPeakAtMs,
      });
    }

    if (changed && live) writeJournal(statePath, journal);

    const peakPriceRaw = journal.entryPeakPriceRaw ?? priceRaw;
    const triggerPriceRaw = peakPriceRaw * (1 - entryPullbackPct / 100);
    const pullbackPctFromPeak = Math.max(
      0,
      (1 - priceRaw / peakPriceRaw) * 100,
    );
    const observation: EntryObservation = {
      probeLamports,
      venue: q.venue,
      outputRaw: q.outputRaw,
      priceRaw,
      peakPriceRaw,
      triggerPriceRaw,
      pullbackPctFromPeak,
    };
    note("entry.observe", {
      probeSol,
      venue: q.venue,
      priceRaw,
      peakPriceRaw,
      triggerPriceRaw,
      pullbackPctFromPeak,
      entryPullbackPct,
    });
    return observation;
  };

  const planBuy = async (
    p: ReturnType<typeof normalizeValueBandPolicy>,
    snap: Snapshot,
    forceToBase = false,
  ) => {
    const maxSol = await availableBuyBudget(p, snap);
    if (maxSol < p.minTradeSol) {
      return {
        lamports: 0n,
        expectedLiquidationSol: snap.liquidationSol,
        expectedTokensRaw: 0n,
        venue: null as SwapVenue | null,
        reason: "buy budget below minimum",
      };
    }
    const maxLamports = BigInt(Math.floor(maxSol * 1e9));

    if (snap.amountRaw <= 0n || snap.liquidationSol <= 0) {
      const sized = await sizeToBase({
        slrd,
        raydium,
        walletRef,
        routing,
        slippageBps,
        mint,
        currentRaw: 0n,
        targetSol: p.baseSol,
        maxLamports,
        iterations: sizingIterations,
      });
      return {
        lamports: sized.lamports,
        expectedLiquidationSol: sized.expectedLiquidationSol,
        expectedTokensRaw: sized.expectedTokensRaw,
        venue: sized.venue,
        reason: "bootstrap-to-base",
      };
    }

    const selectedMode: ValueBandBuyMode = forceToBase ? "to-base" : p.buyMode;
    if (selectedMode === "same-value") {
      const spendSol = Math.min(maxSol, Math.max(0, snap.liquidationSol));
      if (spendSol < p.minTradeSol) {
        return {
          lamports: 0n,
          expectedLiquidationSol: snap.liquidationSol,
          expectedTokensRaw: 0n,
          venue: null as SwapVenue | null,
          reason: "same-value buy below minimum",
        };
      }
      const lamports = BigInt(Math.floor(spendSol * 1e9));
      const q = await quoteBestRoute({
        slrd,
        walletRef,
        mint,
        raydium,
        mode: routing,
        inputMint: WSOL,
        outputMint: mint,
        amountRaw: lamports,
        slippageBps,
      });
      return {
        lamports,
        expectedLiquidationSol: NaN,
        expectedTokensRaw: q.outputRaw,
        venue: q.venue,
        reason: "same-value",
      };
    }

    if (selectedMode === "same-tokens") {
      const sized = await sizeSameTokens({
        slrd,
        raydium,
        walletRef,
        routing,
        slippageBps,
        mint,
        tokenRaw: snap.amountRaw,
        maxLamports,
        iterations: sizingIterations,
      });
      return {
        lamports: sized.lamports,
        expectedLiquidationSol: NaN,
        expectedTokensRaw: sized.expectedTokensRaw,
        venue: sized.venue,
        reason: "same-tokens",
      };
    }

    const sized = await sizeToBase({
      slrd,
      raydium,
      walletRef,
      routing,
      slippageBps,
      mint,
      currentRaw: snap.amountRaw,
      targetSol: p.baseSol,
      maxLamports,
      iterations: sizingIterations,
    });
    return {
      lamports: sized.lamports,
      expectedLiquidationSol: sized.expectedLiquidationSol,
      expectedTokensRaw: sized.expectedTokensRaw,
      venue: sized.venue,
      reason: "to-base",
    };
  };

  const executeBuy = async (
    snap: Snapshot,
    forceToBase = false,
  ): Promise<Snapshot> =>
    await m(
      {
        start: () => (forceToBase ? "trade.buy.scale-to-base" : "trade.buy"),
        end: (value: Snapshot) => ({
          liquidationSol: value.liquidationSol,
          executablePriceSol: value.effectivePriceSol,
          walletSol: value.walletSol,
        }),
      },
      async () => {
        const p = normalizeValueBandPolicy(policy());

        // A decision can be several route/sizing requests old by the time a swap
        // is ready to submit. Re-snapshot here so we never execute a buy merely
        // because an earlier cycle saw a dip that has already reversed.
        if (live) {
          snap = await m(
            {
              start: () => "snapshot.pre-submit-buy",
              end: (value: Snapshot) => ({
                tokenRaw: value.amountRaw.toString(),
                liquidationSol: value.liquidationSol,
                executablePriceSol: value.effectivePriceSol,
                walletSol: value.walletSol,
                venue: value.quote?.venue ?? null,
              }),
            },
            () =>
              snapshot(slrd, raydium, routing, slippageBps, walletRef, mint),
          );

          if (forceToBase) {
            if (snap.liquidationSol >= p.baseSol) {
              note("trade.buy.pre-submit-hold", {
                reason: "fresh position is already at-or-above base",
                liquidationSol: snap.liquidationSol,
                baseSol: p.baseSol,
              });
              return snap;
            }
          } else if (snap.amountRaw <= 0n || snap.liquidationSol <= 0) {
            if (entryPullbackPct <= 0) {
              note("trade.buy.pre-submit-hold", {
                reason:
                  "fresh inventory is flat and no entry pullback is enabled",
              });
              return snap;
            }
            const freshEntry = await observeFlatEntry();
            if (
              !freshEntry ||
              freshEntry.priceRaw > freshEntry.triggerPriceRaw
            ) {
              note("trade.buy.pre-submit-hold", {
                reason: "flat entry pullback is no longer satisfied",
                entryPullbackPct,
                priceRaw: freshEntry?.priceRaw ?? null,
                triggerPriceRaw: freshEntry?.triggerPriceRaw ?? null,
                pullbackPctFromPeak: freshEntry?.pullbackPctFromPeak ?? null,
              });
              return snap;
            }
          } else {
            const lowerSol = p.baseSol * p.lowerMultiple;
            const currentPrice = snap.effectivePriceSol;
            if (snap.liquidationSol >= lowerSol) {
              note("trade.buy.pre-submit-hold", {
                reason: "fresh liquidation is no longer below lower band",
                liquidationSol: snap.liquidationSol,
                lowerSol,
              });
              return snap;
            }
            if (currentPrice == null || !(currentPrice > 0)) {
              note("trade.buy.pre-submit-hold", {
                reason: "fresh executable price unavailable",
              });
              return snap;
            }
            if (
              journal.lastTradeSide === "sell" &&
              journal.lastSellPriceSol != null
            ) {
              const maxPrice =
                journal.lastSellPriceSol * (1 - rebuyAfterSellDropPct / 100);
              if (currentPrice > maxPrice) {
                note("trade.buy.pre-submit-hold", {
                  reason: "post-sell retracement disappeared before sizing",
                  currentPriceSol: currentPrice,
                  maxBuyPriceSol: maxPrice,
                });
                return snap;
              }
            } else if (
              journal.lastTradeSide === "buy" &&
              journal.lastBuyPriceSol != null
            ) {
              const maxPrice =
                journal.lastBuyPriceSol * (1 - lowerLadderDropPct / 100);
              if (currentPrice > maxPrice) {
                note("trade.buy.pre-submit-hold", {
                  reason: "lower-ladder discount disappeared before sizing",
                  currentPriceSol: currentPrice,
                  maxBuyPriceSol: maxPrice,
                });
                return snap;
              }
            } else {
              note("trade.buy.pre-submit-hold", {
                reason: "fresh position has no usable price anchor",
              });
              return snap;
            }
          }
        }

        const sized = await m(
          {
            start: () =>
              `trade.buy.size.${forceToBase ? "to-base" : p.buyMode}`,
            end: (value: Awaited<ReturnType<typeof planBuy>>) => ({
              reason: value.reason,
              buySol: Number(value.lamports) / 1e9,
              expectedLiquidationSol: Number.isFinite(
                value.expectedLiquidationSol,
              )
                ? value.expectedLiquidationSol
                : null,
              venue: value.venue,
            }),
          },
          () => planBuy(p, snap, forceToBase),
        );
        const buySol = Number(sized.lamports) / 1e9;
        if (buySol < p.minTradeSol) {
          note("trade.buy.hold", { reason: sized.reason, buySol });
          return snap;
        }

        if (!live) {
          note("trade.buy.preview", {
            reason: sized.reason,
            buySol,
            liquidationBeforeSol: snap.liquidationSol,
            expectedTokensRaw: sized.expectedTokensRaw.toString(),
            venue: sized.venue,
          });
          return snap;
        }

        let minAcceptableOutputRaw: bigint | undefined;
        let flatEntryMaxPriceRaw: number | null = null;

        // A flat pullback probe is fixed-size and can age while to-base sizing
        // performs several route requests. Check it once more immediately before
        // the final executable quote.
        if (!forceToBase && snap.amountRaw <= 0n && entryPullbackPct > 0) {
          const finalEntry = await observeFlatEntry();
          if (!finalEntry || finalEntry.priceRaw > finalEntry.triggerPriceRaw) {
            note("trade.buy.pre-submit-hold", {
              reason: "flat entry pullback reversed during sizing",
              priceRaw: finalEntry?.priceRaw ?? null,
              triggerPriceRaw: finalEntry?.triggerPriceRaw ?? null,
              pullbackPctFromPeak: finalEntry?.pullbackPctFromPeak ?? null,
            });
            return snap;
          }
          flatEntryMaxPriceRaw = finalEntry.triggerPriceRaw;
        }

        const executionQuote = await quoteBestRoute({
          slrd,
          walletRef,
          mint,
          raydium,
          mode: sized.venue ? venueModeForQuote(sized.venue) : routing,
          inputMint: WSOL,
          outputMint: mint,
          amountRaw: sized.lamports,
          slippageBps,
        });

        // The final exact-input quote is the freshest price observation before
        // submission. Reject a rebound even if the earlier full-position
        // snapshot still looked buyable. Raydium uses its explicit min output;
        // Jupiter is guarded by the controller slippage budget.
        if (!forceToBase && snap.amountRaw > 0n && snap.decimals != null) {
          const quotePrice = quoteBuyPriceSol(
            executionQuote,
            snap.decimals,
            slippageBps,
          );
          const maxPrice =
            journal.lastTradeSide === "sell" && journal.lastSellPriceSol != null
              ? journal.lastSellPriceSol * (1 - rebuyAfterSellDropPct / 100)
              : journal.lastTradeSide === "buy" &&
                  journal.lastBuyPriceSol != null
                ? journal.lastBuyPriceSol * (1 - lowerLadderDropPct / 100)
                : null;
          minAcceptableOutputRaw =
            maxPrice == null
              ? undefined
              : (minimumBuyOutputRawForPrice(
                  executionQuote.inputRaw,
                  snap.decimals,
                  maxPrice,
                ) ?? undefined);
          note("trade.buy.pre-submit", {
            venue: executionQuote.venue,
            expectedPriceSol: quotePrice?.expectedPriceSol ?? null,
            guardedPriceSol: quotePrice?.guardedPriceSol ?? null,
            maxBuyPriceSol: maxPrice,
            minAcceptableOutputRaw: minAcceptableOutputRaw?.toString() ?? null,
            liquidationSol: snap.liquidationSol,
          });
          if (
            maxPrice == null ||
            quotePrice == null ||
            minAcceptableOutputRaw == null ||
            quotePrice.guardedPriceSol > maxPrice
          ) {
            note("trade.buy.pre-submit-hold", {
              reason:
                "final executable quote no longer satisfies buy price guard",
              venue: executionQuote.venue,
              expectedPriceSol: quotePrice?.expectedPriceSol ?? null,
              guardedPriceSol: quotePrice?.guardedPriceSol ?? null,
              maxBuyPriceSol: maxPrice,
            });
            return snap;
          }
        } else if (!forceToBase && flatEntryMaxPriceRaw != null) {
          minAcceptableOutputRaw =
            minimumFlatBuyOutputRawForRawPrice(
              executionQuote.inputRaw,
              flatEntryMaxPriceRaw,
            ) ?? undefined;
          const keepBps = Math.max(0, 10_000 - slippageBps);
          const guardedOutputRaw =
            executionQuote.minOutputRaw ??
            (executionQuote.outputRaw * BigInt(keepBps)) / 10_000n;
          note("trade.buy.pre-submit.flat", {
            venue: executionQuote.venue,
            entryMaxPriceRaw: flatEntryMaxPriceRaw,
            expectedOutputRaw: executionQuote.outputRaw.toString(),
            guardedOutputRaw: guardedOutputRaw.toString(),
            minAcceptableOutputRaw: minAcceptableOutputRaw?.toString() ?? null,
          });
          if (
            minAcceptableOutputRaw == null ||
            guardedOutputRaw < minAcceptableOutputRaw
          ) {
            note("trade.buy.pre-submit-hold", {
              reason:
                "final flat-entry quote no longer satisfies pullback price guard",
              venue: executionQuote.venue,
              guardedOutputRaw: guardedOutputRaw.toString(),
              minAcceptableOutputRaw:
                minAcceptableOutputRaw?.toString() ?? null,
            });
            return snap;
          }
        }

        note("trade.execution.prepare", {
          side: "buy",
          venue: executionQuote.venue,
          requestedInputRaw: executionQuote.inputRaw.toString(),
        });
        const result = await m(
          {
            start: () => `swap.buy.${executionQuote.venue}`,
            end: (value: Awaited<ReturnType<typeof executeRoutedSwap>>) => ({
              venue: value.venue,
              signature: value.signature,
              outputRaw: value.outputRaw.toString(),
            }),
          },
          () =>
            executeRoutedSwap({
              slrd,
              raydium,
              walletRef,
              quote: executionQuote,
              slippageBps,
              raydiumPriorityMicroLamports,
              minAcceptableOutputRaw,
            }),
        );

        if (!result.signature) {
          throw new Error(
            "Buy submission returned no signature; refusing to continue without settlement proof",
          );
        }
        journal.pendingSettlement = {
          side: "buy",
          venue: result.venue,
          signature: result.signature,
          requestedInputRaw: executionQuote.inputRaw.toString(),
          quotedOutputRaw: executionQuote.outputRaw.toString(),
          preTokenRaw: snap.amountRaw.toString(),
          submittedAtMs: Date.now(),
          recentBlockhash: result.settlement?.recentBlockhash ?? null,
          lastValidBlockHeight: result.settlement?.lastValidBlockHeight ?? null,
          preWalletLamports: snap.walletLamports.toString(),
          preOwnedTokenAccountLamports:
            snap.ownedTokenAccountLamports.toString(),
          estimatedNetworkFeeLamports:
            result.settlement?.estimatedNetworkFeeLamports ?? null,
        };
        writeJournal(statePath, journal);
        note("settlement.pending", journal.pendingSettlement);

        const settled = await settleWithRetries();
        if (!settled) {
          note("trade.buy.blocked", {
            signature: result.signature,
            reason: "settlement proof incomplete",
          });
          return snap;
        }

        const post = await m(
          {
            start: () => "snapshot.post-buy",
            end: (value: Snapshot) => ({
              liquidationSol: value.liquidationSol,
              executablePriceSol: value.effectivePriceSol,
            }),
          },
          () => snapshot(slrd, raydium, routing, slippageBps, walletRef, mint),
        );
        note("trade.buy.executed", {
          reason: sized.reason,
          buySol,
          venue: result.venue,
          signature: result.signature,
          liquidationBeforeSol: snap.liquidationSol,
          liquidationAfterSol: post.liquidationSol,
          buyAnchorPriceSol: journal.lastBuyPriceSol,
          anchorSource: "confirmed-execution",
          netCapitalSol: netCapital(journal),
          cumulativeBuySol: journal.cumulativeBuySol,
          cumulativeSellSol: journal.cumulativeSellSol,
        });
        return post;
      },
    );

  const executeSell = async (snap: Snapshot): Promise<Snapshot> =>
    await m(
      {
        start: () => "trade.sell",
        end: (value: Snapshot) => ({
          liquidationSol: value.liquidationSol,
          executablePriceSol: value.effectivePriceSol,
          walletSol: value.walletSol,
        }),
      },
      async () => {
        const p = normalizeValueBandPolicy(policy());

        if (live) {
          snap = await m(
            {
              start: () => "snapshot.pre-submit-sell",
              end: (value: Snapshot) => ({
                tokenRaw: value.amountRaw.toString(),
                liquidationSol: value.liquidationSol,
                executablePriceSol: value.effectivePriceSol,
                walletSol: value.walletSol,
                venue: value.quote?.venue ?? null,
              }),
            },
            () =>
              snapshot(slrd, raydium, routing, slippageBps, walletRef, mint),
          );
          const upperSol = p.baseSol * p.upperMultiple;
          if (snap.liquidationSol < upperSol) {
            note("trade.sell.pre-submit-hold", {
              reason: "fresh liquidation is no longer above upper band",
              liquidationSol: snap.liquidationSol,
              upperSol,
            });
            return snap;
          }
          if (
            journal.lastTradeSide === "buy" &&
            journal.lastBuyPriceSol != null
          ) {
            const minPrice =
              journal.lastBuyPriceSol * (1 + takeProfitAfterBuyRisePct / 100);
            if (
              snap.effectivePriceSol == null ||
              snap.effectivePriceSol < minPrice
            ) {
              note("trade.sell.pre-submit-hold", {
                reason:
                  "fresh executable price no longer satisfies post-buy profit guard",
                currentPriceSol: snap.effectivePriceSol,
                minSellPriceSol: minPrice,
              });
              return snap;
            }
          }
        }

        const sellRaw =
          (snap.amountRaw * BigInt(Math.floor(p.sellFraction * 1_000_000))) /
          1_000_000n;
        if (sellRaw <= 0n) {
          note("trade.sell.hold", { reason: "sell amount rounded to zero" });
          return snap;
        }

        const quote = await quoteBestRoute({
          slrd,
          walletRef,
          mint,
          raydium,
          mode: routing,
          inputMint: mint,
          outputMint: WSOL,
          amountRaw: sellRaw,
          slippageBps,
        });
        const proceedsSol = Number(quote.outputRaw) / 1e9;
        if (proceedsSol < p.minTradeSol) {
          note("trade.sell.hold", {
            reason: "sell proceeds below minimum",
            proceedsSol,
            minTradeSol: p.minTradeSol,
          });
          return snap;
        }

        if (!live) {
          note("trade.sell.preview", {
            sellFraction: p.sellFraction,
            expectedProceedsSol: proceedsSol,
            liquidationBeforeSol: snap.liquidationSol,
            executablePriceSol: snap.effectivePriceSol,
            venue: quote.venue,
          });
          return snap;
        }

        let minAcceptableOutputRaw: bigint | undefined;
        if (
          journal.lastTradeSide === "buy" &&
          journal.lastBuyPriceSol != null &&
          snap.decimals != null
        ) {
          const quotePrice = quoteSellPriceSol(
            quote,
            snap.decimals,
            slippageBps,
          );
          const minPrice =
            journal.lastBuyPriceSol * (1 + takeProfitAfterBuyRisePct / 100);
          minAcceptableOutputRaw =
            minimumSellOutputRawForPrice(
              quote.inputRaw,
              snap.decimals,
              minPrice,
            ) ?? undefined;
          note("trade.sell.pre-submit", {
            venue: quote.venue,
            expectedPriceSol: quotePrice?.expectedPriceSol ?? null,
            guardedPriceSol: quotePrice?.guardedPriceSol ?? null,
            minSellPriceSol: minPrice,
            minAcceptableOutputRaw: minAcceptableOutputRaw?.toString() ?? null,
            liquidationSol: snap.liquidationSol,
          });
          if (
            quotePrice == null ||
            minAcceptableOutputRaw == null ||
            quotePrice.guardedPriceSol < minPrice
          ) {
            note("trade.sell.pre-submit-hold", {
              reason:
                "final executable quote no longer satisfies post-buy profit guard",
              venue: quote.venue,
              expectedPriceSol: quotePrice?.expectedPriceSol ?? null,
              guardedPriceSol: quotePrice?.guardedPriceSol ?? null,
              minSellPriceSol: minPrice,
            });
            return snap;
          }
        }

        note("trade.execution.prepare", {
          side: "sell",
          venue: quote.venue,
          requestedInputRaw: quote.inputRaw.toString(),
        });
        const result = await m(
          {
            start: () => `swap.sell.${quote.venue}`,
            end: (value: Awaited<ReturnType<typeof executeRoutedSwap>>) => ({
              venue: value.venue,
              signature: value.signature,
              outputRaw: value.outputRaw.toString(),
            }),
          },
          () =>
            executeRoutedSwap({
              slrd,
              raydium,
              walletRef,
              quote,
              slippageBps,
              raydiumPriorityMicroLamports,
              minAcceptableOutputRaw,
            }),
        );

        if (!result.signature) {
          throw new Error(
            "Sell submission returned no signature; refusing to continue without settlement proof",
          );
        }
        const cumulativeSellBefore = journal.cumulativeSellSol;
        journal.pendingSettlement = {
          side: "sell",
          venue: result.venue,
          signature: result.signature,
          requestedInputRaw: quote.inputRaw.toString(),
          quotedOutputRaw: quote.outputRaw.toString(),
          preTokenRaw: snap.amountRaw.toString(),
          submittedAtMs: Date.now(),
          recentBlockhash: result.settlement?.recentBlockhash ?? null,
          lastValidBlockHeight: result.settlement?.lastValidBlockHeight ?? null,
          preWalletLamports: snap.walletLamports.toString(),
          preOwnedTokenAccountLamports:
            snap.ownedTokenAccountLamports.toString(),
          estimatedNetworkFeeLamports:
            result.settlement?.estimatedNetworkFeeLamports ?? null,
        };
        writeJournal(statePath, journal);
        note("settlement.pending", journal.pendingSettlement);

        const settled = await settleWithRetries();
        if (!settled) {
          note("trade.sell.blocked", {
            signature: result.signature,
            reason: "settlement proof incomplete",
          });
          return snap;
        }

        const post = await m(
          {
            start: () => "snapshot.post-sell",
            end: (value: Snapshot) => ({
              liquidationSol: value.liquidationSol,
              executablePriceSol: value.effectivePriceSol,
            }),
          },
          () => snapshot(slrd, raydium, routing, slippageBps, walletRef, mint),
        );
        note("trade.sell.executed", {
          sellFraction: p.sellFraction,
          actualSol: journal.cumulativeSellSol - cumulativeSellBefore,
          venue: result.venue,
          signature: result.signature,
          liquidationBeforeSol: snap.liquidationSol,
          liquidationAfterSol: post.liquidationSol,
          sellAnchorPriceSol: journal.lastSellPriceSol,
          anchorSource: "confirmed-execution",
          netCapitalSol: netCapital(journal),
          cumulativeBuySol: journal.cumulativeBuySol,
          cumulativeSellSol: journal.cumulativeSellSol,
        });
        return post;
      },
    );

  const decide = (
    snap: Snapshot,
    p: ReturnType<typeof normalizeValueBandPolicy>,
    entry: EntryObservation | null,
  ): Decision => {
    const lowerSol = p.baseSol * p.lowerMultiple;
    const upperSol = p.baseSol * p.upperMultiple;
    const currentPrice = snap.effectivePriceSol;
    const nextLadderPriceSol =
      journal.lastBuyPriceSol == null
        ? null
        : journal.lastBuyPriceSol * (1 - lowerLadderDropPct / 100);
    const nextRebuyPriceSol =
      journal.lastSellPriceSol == null
        ? null
        : journal.lastSellPriceSol * (1 - rebuyAfterSellDropPct / 100);
    const minTakeProfitPriceSol =
      journal.lastTradeSide === "buy" && journal.lastBuyPriceSol != null
        ? journal.lastBuyPriceSol * (1 + takeProfitAfterBuyRisePct / 100)
        : null;

    let action: TradeSide | "hold" = "hold";
    let reason = "inside value band";

    // Sell priority is still exposure-driven, but a fresh buy cannot immediately
    // self-trigger a lower-priced sell merely because resizing pushed liquidation
    // over the upper band. After the first sell, repeated trims may continue.
    if (snap.liquidationSol >= upperSol) {
      if (
        journal.lastTradeSide === "buy" &&
        minTakeProfitPriceSol != null &&
        (currentPrice == null || currentPrice < minTakeProfitPriceSol)
      ) {
        reason =
          currentPrice == null
            ? "above upper band but executable price unavailable for post-buy profit guard"
            : `above upper band; waiting for post-buy price >= ${minTakeProfitPriceSol.toExponential(6)} before selling (current ${currentPrice.toExponential(6)})`;
      } else {
        action = "sell";
        reason = `liquidation ${snap.liquidationSol.toFixed(6)} >= upper ${upperSol.toFixed(6)}; sell priority`;
      }
    } else if (snap.liquidationSol < lowerSol) {
      if (snap.amountRaw <= 0n || snap.liquidationSol <= 0) {
        if (entryPullbackPct > 0 && entry != null) {
          if (entry.priceRaw <= entry.triggerPriceRaw) {
            action = "buy";
            reason = `flat entry pullback reached ${entry.pullbackPctFromPeak.toFixed(1)}% from executable peak (trigger ${entryPullbackPct.toFixed(1)}%)`;
          } else {
            reason = `flat; waiting for executable entry pullback ${entryPullbackPct.toFixed(1)}% (currently ${entry.pullbackPctFromPeak.toFixed(1)}%)`;
          }
        } else if (entryPullbackPct > 0) {
          reason =
            "flat; entry pullback enabled but executable entry quote is unavailable";
        } else {
          reason =
            "empty inventory; use --scale-now for immediate bootstrap or --entry-pullback-pct N to wait for a retracement";
        }
      } else if (currentPrice == null || !(currentPrice > 0)) {
        reason = "below lower band but executable price is unavailable";
      } else if (
        journal.lastTradeSide === "sell" &&
        nextRebuyPriceSol != null
      ) {
        if (currentPrice <= nextRebuyPriceSol) {
          action = "buy";
          reason = `post-sell price retraced ${rebuyAfterSellDropPct.toFixed(1)}%`;
        } else {
          reason = `below lower band; waiting for post-sell price <= ${nextRebuyPriceSol.toExponential(6)} (current ${currentPrice.toExponential(6)})`;
        }
      } else if (
        journal.lastTradeSide === "buy" &&
        nextLadderPriceSol != null
      ) {
        if (currentPrice <= nextLadderPriceSol) {
          action = "buy";
          reason = `lower ladder price fell another ${lowerLadderDropPct.toFixed(1)}%`;
        } else {
          reason = `below lower band; waiting for ladder price <= ${nextLadderPriceSol.toExponential(6)} (current ${currentPrice.toExponential(6)})`;
        }
      } else {
        // State may come from an older controller with no usable price anchor.
        // Do not silently bypass the ladder; require an explicit reset/scale restart.
        reason =
          "below lower band but no usable buy/sell price anchor; restart with --reset-guards --scale-now if intentional";
      }
    }

    return {
      action,
      reason,
      liquidationSol: snap.liquidationSol,
      lowerSol,
      baseSol: p.baseSol,
      upperSol,
      executablePriceSol: currentPrice,
      lastTradeSide: journal.lastTradeSide,
      lastBuyPriceSol: journal.lastBuyPriceSol,
      lastSellPriceSol: journal.lastSellPriceSol,
      nextLadderPriceSol,
      nextRebuyPriceSol,
      minTakeProfitPriceSol,
      entryCurrentPriceRaw: entry?.priceRaw ?? null,
      entryPeakPriceRaw: entry?.peakPriceRaw ?? journal.entryPeakPriceRaw,
      entryTriggerPriceRaw: entry?.triggerPriceRaw ?? null,
      entryPullbackPct,
    };
  };

  try {
    do {
      try {
        await m(
          {
            start: () => "cycle",
            end: (value: {
              decision: Decision;
              live: boolean;
              cooldownRemainingMs: number;
              netCapitalSol: number;
              walletSol: number;
            }) => value,
          },
          async () => {
            if (live && journal.pendingSettlement) {
              const settled = await settleWithRetries(1, 0);
              if (!settled) {
                const blockedSnapshot = await snapshot(
                  slrd,
                  raydium,
                  routing,
                  slippageBps,
                  walletRef,
                  mint,
                );
                const blockedPolicy = normalizeValueBandPolicy(policy());
                const blockedDecision = settlementHoldDecision(
                  blockedSnapshot,
                  blockedPolicy,
                );
                note("decision", {
                  ...blockedDecision,
                  pendingSettlement: journal.pendingSettlement,
                });
                return {
                  decision: blockedDecision,
                  live,
                  cooldownRemainingMs: 0,
                  netCapitalSol: netCapital(journal),
                  walletSol: blockedSnapshot.walletSol,
                };
              }
            }

            let latest = await m(
              {
                start: () => "snapshot",
                end: (value: Snapshot) => ({
                  tokenRaw: value.amountRaw.toString(),
                  liquidationSol: value.liquidationSol,
                  executablePriceSol: value.effectivePriceSol,
                  walletSol: value.walletSol,
                  venue: value.quote?.venue ?? null,
                }),
              },
              () =>
                snapshot(slrd, raydium, routing, slippageBps, walletRef, mint),
            );

            const p = normalizeValueBandPolicy(policy());
            const entryObservation =
              latest.amountRaw <= 0n && entryPullbackPct > 0 && !scaleNow
                ? await observeFlatEntry()
                : null;

            if (scaleNow) {
              // --scale-now is an intent to scale toward base, not permission for
              // exactly one broadcast attempt. Keep it armed across a dropped or
              // expired submission; consume it only once the confirmed position
              // reaches base or the configured capital budget cannot fund another
              // minimum trade.
              if (latest.liquidationSol < p.baseSol) {
                latest = await executeBuy(latest, true);
              }

              if (!journal.pendingSettlement) {
                const capitalRemaining = Math.max(
                  0,
                  p.maxCapitalDeployedSol - netCapital(journal),
                );
                if (latest.liquidationSol >= p.baseSol) {
                  scaleNow = false;
                  note("scale.complete", {
                    reason: "confirmed position reached base",
                    liquidationSol: latest.liquidationSol,
                    baseSol: p.baseSol,
                    netCapitalSol: netCapital(journal),
                  });
                } else {
                  const executableBudgetSol = await availableBuyBudget(
                    p,
                    latest,
                  );
                  if (executableBudgetSol < p.minTradeSol) {
                    scaleNow = false;
                    note("scale.hold", {
                      reason:
                        capitalRemaining < p.minTradeSol
                          ? "capital cap reached before base"
                          : "wallet/reserve budget cannot fund another minimum trade",
                      liquidationSol: latest.liquidationSol,
                      baseSol: p.baseSol,
                      netCapitalSol: netCapital(journal),
                      maxCapitalSol: p.maxCapitalDeployedSol,
                      capitalRemainingSol: capitalRemaining,
                      executableBudgetSol,
                    });
                  } else {
                    note("scale.armed", {
                      reason:
                        "scale-to-base intent remains armed; no confirmed fill yet",
                      liquidationSol: latest.liquidationSol,
                      baseSol: p.baseSol,
                      netCapitalSol: netCapital(journal),
                      capitalRemainingSol: capitalRemaining,
                      executableBudgetSol,
                    });
                  }
                }
              } else {
                note("scale.armed", {
                  reason:
                    "scale-to-base intent remains armed while buy settlement is unresolved",
                  signature: journal.pendingSettlement.signature,
                });
              }
            }

            if (journal.pendingSettlement) {
              const blockedDecision = settlementHoldDecision(latest, p);
              note("decision", {
                ...blockedDecision,
                pendingSettlement: journal.pendingSettlement,
              });
              return {
                decision: blockedDecision,
                live,
                cooldownRemainingMs: 0,
                netCapitalSol: netCapital(journal),
                walletSol: latest.walletSol,
              };
            }

            const decision = decide(latest, p, entryObservation);
            const cooldownRemainingMs = Math.max(
              0,
              cooldownMs - (Date.now() - lastTradeAt),
            );
            note("decision", {
              ...decision,
              cooldownRemainingMs,
              netCapitalSol: netCapital(journal),
              maxCapitalSol: p.maxCapitalDeployedSol,
              maxBuySol: maxBuySol(),
            });

            if (decision.action !== "hold") {
              if (cooldownRemainingMs > 0) {
                note("trade.hold.cooldown", {
                  action: decision.action,
                  reason: decision.reason,
                  cooldownRemainingMs,
                });
              } else if (decision.action === "sell") {
                latest = await executeSell(latest);
              } else {
                latest = await executeBuy(latest, false);
              }
            }

            return {
              decision,
              live,
              cooldownRemainingMs,
              netCapitalSol: netCapital(journal),
              walletSol: latest.walletSol,
            };
          },
        );

        consecutiveCycleFailures = 0;
        if (!flags.has("loop") || stopping) break;
        await sleep(sampleMs);
      } catch (error) {
        const err =
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: "Error", message: String(error) };

        if (isSubmissionAmbiguous(error)) {
          note("cycle.fail-stop.execution-ambiguous", {
            ...err,
            venue: error.submissionVenue ?? null,
            reason:
              "sender/execution call failed after submission may have begun but before a signature was durably journaled; refusing automatic retry",
          });
          throw error;
        }

        // A failed observation/quote/RPC read is not a trading instruction. In
        // loop mode retry the whole cycle from a fresh snapshot. No pending
        // decision is carried forward, so recovery cannot execute stale intent.
        if (!flags.has("loop") || stopping) throw error;
        consecutiveCycleFailures += 1;
        const retryInMs = Math.min(
          errorRetryMaxMs,
          errorRetryMs * 2 ** Math.min(8, consecutiveCycleFailures - 1),
        );
        note("cycle.retry", {
          ...err,
          consecutiveFailures: consecutiveCycleFailures,
          retryInMs,
          pendingSettlement: journal.pendingSettlement
            ? {
                side: journal.pendingSettlement.side,
                venue: journal.pendingSettlement.venue,
                signature: journal.pendingSettlement.signature,
              }
            : null,
        });
        await sleep(retryInMs);
      }
    } while (!stopping);
  } finally {
    note("agent.stop", {
      reason: stopping ? "signal" : "complete",
      journal,
    });
  }
}

if (import.meta.main) {
  runValueBandAgent().catch((error) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    m.sync(
      {
        start: () => "agent.error",
        end: (value: { error: string }) => value,
      },
      () => ({ error: message }),
    );
    process.exitCode = 1;
  });
}
