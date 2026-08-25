import BN from "bn.js";
import bs58 from "bs58";
import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Commitment,
  type Connection,
} from "@solana/web3.js";
import type { WalletRef } from "../../core/refs.ts";
import {
  METEORA_MARKET_FEATURE_SCHEMA_V1,
  METEORA_MARKET_FEATURE_SEMANTICS_HASH_V1,
  METEORA_POOL_DISCOVERY_SCHEMA_V1,
} from "./types.ts";
import type {
  MeteoraActiveBin,
  MeteoraActiveBinSample,
  MeteoraAddLiquidityArgs,
  MeteoraDiscoverPoolsArgs,
  MeteoraExecutionAccounting,
  MeteoraExecutionOptions,
  MeteoraExecutionResult,
  MeteoraErrorCode,
  MeteoraInteger,
  MeteoraInfrastructureFundingPolicy,
  MeteoraInfrastructurePreflight,
  MeteoraInfrastructureQuote,
  MeteoraSharedInfrastructureQuote,
  MeteoraLimitOrderInfrastructureQuote,
  MeteoraLimitOrderSide,
  MeteoraLimitOrderSnapshot,
  MeteoraLimitOrderVerification,
  MeteoraExecutionVerification,
  MeteoraPlaceLimitOrderArgs,
  MeteoraCancelLimitOrderArgs,
  MeteoraLimitOrderPreflight,
  MeteoraLiquidityDepthMetrics,
  MeteoraMicrostructureMetrics,
  MeteoraMoveCapitalAttribution,
  MeteoraMovePositionArgs,
  MeteoraMovePositionResult,
  MeteoraOhlcvArgs,
  MeteoraOhlcvResponse,
  MeteoraCandleRegimeMetrics,
  MeteoraOracleObservation,
  MeteoraOracleSnapshot,
  MeteoraOracleSnapshotArgs,
  MeteoraOracleTwapWindow,
  MeteoraPoolMarketMetrics,
  MeteoraMarketFeatureVectorArgs,
  MeteoraMarketFeatureVectorV1,
  MeteoraPoolProfileMetrics,
  MeteoraRangePathMetrics,
  MeteoraRollingPoolMetrics,
  MeteoraOpenPositionArgs,
  MeteoraPoolSearchResult,
  MeteoraPoolDiscoveryArgs,
  MeteoraPoolDiscoveryCandidateV1,
  MeteoraPoolDiscoveryPageV1,
  MeteoraPoolState,
  MeteoraPairDescriptor,
  MeteoraRange,
  MeteoraPoolToken,
  MeteoraPositionAccountingSnapshot,
  MeteoraPositionActionArgs,
  MeteoraPositionSnapshot,
  MeteoraPositionSnapshotComparison,
  MeteoraPositionVerification,
  MeteoraPositionVerificationOptions,
  MeteoraVerifyPositionArgs,
  MeteoraPreparedTransactions,
  MeteoraOpenBatchPreflight,
  MeteoraOpenBatchPreflightArgs,
  MeteoraOpenBatchPreflightCandidate,
  MeteoraRemoveLiquidityArgs,
  MeteoraStrategy,
  MeteoraSwapExactInArgs,
  MeteoraSwapExactOutArgs,
  MeteoraSwapQuote,
  MeteoraTimeframe,
  MeteoraUiAmount,
  MeteoraWalletAccountingSnapshot,
  MeteoraWalletPoolBalances,
  MeteoraPoolWalletSnapshot,
  MeteoraPoolWalletSnapshotArgs,
  MeteoraWalletPositions,
} from "./types.ts";

type DlmmModule = typeof import("@meteora-ag/dlmm");
type DlmmPool = Awaited<ReturnType<DlmmModule["default"]["create"]>>;

export type MeteoraDlmmHost = {
  connection(): Connection;
  signer(ref: WalletRef): Keypair;
  /** Resolve a public wallet address without decrypting/loading signing material. */
  walletAddress?(ref: WalletRef): string | PublicKey;
};

const DEFAULT_DATA_API = "https://dlmm.datapi.meteora.ag";
const DEFAULT_DISCOVERY_API = "https://pool-discovery-api.datapi.meteora.ag";
const STANDARD_POSITION_BINS = 69;
const WSOL_MINT = "So11111111111111111111111111111111111111112";

type MeteoraCluster = "mainnet-beta" | "devnet" | "localhost";

function meteoraCluster(): MeteoraCluster {
  const value = String(process.env.METEORA_DLMM_CLUSTER ?? "mainnet-beta")
    .trim()
    .toLowerCase();
  if (value === "mainnet-beta" || value === "devnet" || value === "localhost")
    return value;
  throw new Error(
    `METEORA_DLMM_CLUSTER must be mainnet-beta, devnet, or localhost (received ${value})`,
  );
}

let sdkPromise: Promise<DlmmModule> | null = null;

async function dlmmSdk(): Promise<DlmmModule> {
  if (!sdkPromise) sdkPromise = import("@meteora-ag/dlmm");
  return await sdkPromise;
}

function asPublicKey(value: string | PublicKey): PublicKey {
  return value instanceof PublicKey ? value : new PublicKey(String(value));
}

function publicKeyString(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "toBase58" in value &&
    typeof (value as { toBase58?: unknown }).toBase58 === "function"
  ) {
    return (value as { toBase58(): string }).toBase58();
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "toString" in value &&
    typeof (value as { toString?: unknown }).toString === "function"
  ) {
    const result = (value as { toString(): string }).toString();
    return result && result !== "[object Object]" ? result : null;
  }
  return null;
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  if (
    typeof value === "object" &&
    value !== null &&
    "toNumber" in value &&
    typeof (value as { toNumber?: unknown }).toNumber === "function"
  ) {
    const number = (value as { toNumber(): number }).toNumber();
    return Number.isFinite(number) ? number : null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerString(value: unknown, fallback = "0"): string {
  if (value == null) return fallback;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value))
    return Math.trunc(value).toString();
  if (typeof value === "string" && /^-?\d+$/.test(value.trim()))
    return value.trim();
  if (
    typeof value === "object" &&
    value !== null &&
    "toString" in value &&
    typeof (value as { toString?: unknown }).toString === "function"
  ) {
    const result = (value as { toString(): string }).toString();
    return /^-?\d+$/.test(result) ? result : fallback;
  }
  return fallback;
}

function toBN(value: MeteoraInteger, label: string): BN {
  const normalized =
    typeof value === "bigint"
      ? value.toString()
      : typeof value === "number"
        ? Number.isSafeInteger(value)
          ? String(value)
          : ""
        : String(value).trim();
  if (!/^\d+$/.test(normalized))
    throw new Error(`${label} must be a non-negative integer`);
  return new BN(normalized, 10);
}

function decimalToRaw(value: MeteoraUiAmount, decimals: number): BN {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30)
    throw new Error(`Invalid token decimals: ${decimals}`);

  let text = String(value).trim();
  if (!text || text.startsWith("-"))
    throw new Error("Token amount must be non-negative");

  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const [whole = "0", fraction = ""] = text.split(".");
    if (fraction.length > decimals) {
      const discarded = fraction.slice(decimals);
      if (/[1-9]/.test(discarded))
        throw new Error(
          `Token amount has more than ${decimals} decimal places`,
        );
    }
    const padded = fraction.slice(0, decimals).padEnd(decimals, "0");
    return new BN(`${whole}${padded}`.replace(/^0+(?=\d)/, "") || "0", 10);
  }

  const number = Number(text);
  if (!Number.isFinite(number) || number < 0)
    throw new Error("Token amount must be a finite non-negative number");
  text = number.toFixed(decimals);
  return decimalToRaw(text, decimals);
}

function normalizeStrategy(
  strategy: MeteoraStrategy,
  StrategyType: DlmmModule["StrategyType"],
): number {
  if (strategy === "spot") return StrategyType.Spot;
  if (strategy === "bid_ask") return StrategyType.BidAsk;
  if (strategy === "curve") return StrategyType.Curve;
  throw new Error(`Unsupported Meteora strategy: ${String(strategy)}`);
}

function tokenReserve(reserve: unknown): MeteoraPoolToken {
  const row = (reserve ?? {}) as Record<string, any>;
  const mint = row.mint ?? {};
  return {
    mint:
      publicKeyString(row.publicKey) ??
      publicKeyString(mint.address) ??
      publicKeyString(mint.publicKey) ??
      "",
    decimals:
      numberOrNull(mint.decimals) ??
      numberOrNull(row.decimals) ??
      numberOrNull(row.mintDecimals),
    reserve:
      publicKeyString(row.reserve) ??
      publicKeyString(row.reservePublicKey) ??
      null,
    tokenProgram:
      publicKeyString(row.tokenProgram) ??
      publicKeyString(row.tokenProgramId) ??
      publicKeyString(mint.owner) ??
      null,
  };
}

function asTxArray(
  value:
    | Transaction
    | VersionedTransaction
    | Array<Transaction | VersionedTransaction>
    | null
    | undefined,
): Array<Transaction | VersionedTransaction> {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function isLegacyTransaction(
  transaction: Transaction | VersionedTransaction,
): transaction is Transaction {
  return transaction instanceof Transaction;
}

function envEnabled(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function transportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /socket|fetch|ECONNRESET|ETIMEDOUT|EAI_AGAIN|429|502|503|504|network|connection.*closed/i.test(
    message,
  );
}

function signedTransactionSignature(
  transaction: Transaction | VersionedTransaction,
): string | null {
  const bytes =
    transaction instanceof Transaction
      ? transaction.signature
      : transaction.signatures[0];
  if (!bytes || bytes.length === 0) return null;
  if ([...bytes].every((value) => value === 0)) return null;
  return bs58.encode(bytes);
}

function commitmentReached(
  status: {
    confirmationStatus?: string | null;
    confirmations?: number | null;
  } | null,
  commitment: Commitment,
): boolean {
  if (!status) return false;
  const level = status.confirmationStatus;
  if (commitment === "processed") return true;
  if (commitment === "confirmed")
    return (
      level === "confirmed" ||
      level === "finalized" ||
      status.confirmations === null
    );
  return level === "finalized" || status.confirmations === null;
}

async function recoverSubmittedSignature(
  connection: Connection,
  signature: string,
  commitment: Commitment,
  attempts = 6,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      const status = result.value[0];
      if (status?.err) {
        throw new MeteoraError(
          `Meteora transaction ${signature} failed on-chain: ${JSON.stringify(status.err)}`,
          "TRANSACTION_FAILED",
          { signature, error: status.err },
          false,
        );
      }
      if (commitmentReached(status, commitment)) return true;
    } catch (error) {
      if (!transportError(error)) throw error;
    }
    if (attempt + 1 < attempts)
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  return false;
}

function assertLiveTradingEnabled(options: MeteoraExecutionOptions): void {
  if (options.live !== true)
    throw new MeteoraError(
      "Meteora write refused: execution requires { live: true }",
      "LIVE_TRADING_DISABLED",
    );

  const enabled =
    envEnabled("SOLARD_ENABLE_LIVE_TRADES") ||
    envEnabled("SOLWAL_ENABLE_LIVE_TRADES") ||
    envEnabled("SLRD_ENABLE_LIVE_TRADES");
  if (!enabled) {
    throw new MeteoraError(
      "Meteora write refused: set SOLARD_ENABLE_LIVE_TRADES=1 to enable live transactions",
      "LIVE_TRADING_DISABLED",
    );
  }
}

function uniqueSigners(signers: Keypair[]): Keypair[] {
  const seen = new Set<string>();
  return signers.filter((signer) => {
    const key = signer.publicKey.toBase58();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Return only the candidate keypairs that this specific transaction actually
 * requires. Meteora wide/extended position flows are chunked: the position
 * keypair signs the position-creation transaction, while later liquidity
 * chunks typically require only the wallet. Passing every prepared signer to
 * every legacy Transaction.partialSign() causes web3.js to throw
 * `unknown signer` for those later chunks.
 */
function transactionRequiredSignerKeys(
  transaction: Transaction | VersionedTransaction,
): PublicKey[] {
  if (isLegacyTransaction(transaction)) {
    const message = transaction.compileMessage();
    return message.accountKeys.slice(0, message.header.numRequiredSignatures);
  }
  return transaction.message.staticAccountKeys.slice(
    0,
    transaction.message.header.numRequiredSignatures,
  );
}

function transactionSigners(
  transaction: Transaction | VersionedTransaction,
  candidates: Keypair[],
): Keypair[] {
  const required = new Set(
    transactionRequiredSignerKeys(transaction).map((key) => key.toBase58()),
  );
  return candidates.filter((signer) =>
    required.has(signer.publicKey.toBase58()),
  );
}

function nonZeroSignature(value: Uint8Array | null | undefined): boolean {
  return (
    !!value && value.length > 0 && Array.from(value).some((byte) => byte !== 0)
  );
}

/**
 * Fail before simulation/send when a required signature is still absent. This
 * produces a useful Solard error instead of serializing a transaction that is
 * guaranteed to fail. Pre-signed SDK transactions remain valid: an already
 * populated signature satisfies the check even if Solard does not own that
 * keypair.
 */
function assertTransactionFullySigned(
  transaction: Transaction | VersionedTransaction,
): void {
  const required = transactionRequiredSignerKeys(transaction);
  const missing: string[] = [];

  if (isLegacyTransaction(transaction)) {
    const byKey = new Map(
      transaction.signatures.map((entry) => [
        entry.publicKey.toBase58(),
        entry.signature,
      ]),
    );
    for (const key of required) {
      if (!nonZeroSignature(byKey.get(key.toBase58())))
        missing.push(key.toBase58());
    }
  } else {
    for (let index = 0; index < required.length; index += 1) {
      if (!nonZeroSignature(transaction.signatures[index]))
        missing.push(required[index]!.toBase58());
    }
  }

  if (missing.length) {
    throw new MeteoraMissingRequiredSignerError(missing);
  }
}

function safeJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (value == null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value))
    return value.map((entry) => safeJsonValue(entry, depth + 1));
  const key = publicKeyString(value);
  if (
    key &&
    typeof value === "object" &&
    value !== null &&
    ("toBase58" in value || "negative" in value || "words" in value)
  )
    return key;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(
      value as Record<string, unknown>,
    ))
      out[name] = safeJsonValue(entry, depth + 1);
    return out;
  }
  return String(value);
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean"
    ? value
    : value == null
      ? null
      : Boolean(value);
}

function normalizeLimitOrderStatus(
  value: unknown,
): "not-filled" | "partial-filled" | "fulfilled" | "unknown" {
  if (typeof value === "number") {
    if (value === 0) return "not-filled";
    if (value === 1) return "partial-filled";
    if (value === 2) return "fulfilled";
  }
  const text = String(value ?? "")
    .replace(/[\s_-]+/g, "")
    .toLowerCase();
  if (text === "notfilled" || text === "0") return "not-filled";
  if (text === "partialfilled" || text === "1") return "partial-filled";
  if (text === "fulfilled" || text === "2") return "fulfilled";
  return "unknown";
}

function limitOrderBinId(row: Record<string, unknown>): number | null {
  const candidate = firstFiniteValue(row.binId, row.id, row.bin_id);
  return candidate != null && Number.isInteger(candidate) ? candidate : null;
}

function limitOrderBinEmpty(row: Record<string, unknown>): boolean {
  if (typeof row.empty === "boolean") return row.empty;
  const status = normalizeLimitOrderStatus(row.status);
  if (status === "fulfilled") return true;
  const amount = integerString(
    row.amount ??
      row.openOrderAmount ??
      row.remainingAmount ??
      row.remaining_amount,
    "0",
  );
  return amount === "0" && status === "unknown";
}

export class MeteoraError extends Error {
  readonly code: MeteoraErrorCode;
  readonly details: unknown;
  readonly retryable: boolean;

  constructor(
    message: string,
    code: MeteoraErrorCode = "UNKNOWN",
    details: unknown = null,
    retryable = false,
  ) {
    super(message);
    this.name = "MeteoraError";
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

export function meteoraErrorCode(error: unknown): MeteoraErrorCode | null {
  return error instanceof MeteoraError ? error.code : null;
}

export class MeteoraMissingRequiredSignerError extends MeteoraError {
  readonly missingSignerPubkeys: string[];

  constructor(missingSignerPubkeys: string[]) {
    super(
      `Meteora transaction is missing required signer(s): ${missingSignerPubkeys.join(", ")}`,
      "MISSING_REQUIRED_SIGNER",
      { missingSignerPubkeys: [...missingSignerPubkeys] },
      false,
    );
    this.name = "MeteoraMissingRequiredSignerError";
    this.missingSignerPubkeys = [...missingSignerPubkeys];
  }
}

export class MeteoraDataApiError extends MeteoraError {
  readonly path: string;
  readonly status: number | null;
  readonly responseBody: string | null;

  constructor(args: {
    path: string;
    message: string;
    status?: number | null;
    responseBody?: string | null;
    cause?: unknown;
  }) {
    const status = args.status ?? null;
    super(
      args.message,
      "DATA_API_ERROR",
      {
        path: args.path,
        status,
        responseBody: args.responseBody ?? null,
        cause: safeJsonValue(args.cause),
      },
      status === 429 || (status != null && status >= 500),
    );
    this.name = "MeteoraDataApiError";
    this.path = args.path;
    this.status = status;
    this.responseBody = args.responseBody ?? null;
  }
}

export class MeteoraInfrastructureFundingRequiredError extends MeteoraError {
  readonly quote: MeteoraSharedInfrastructureQuote;

  constructor(message: string, quote: MeteoraSharedInfrastructureQuote) {
    super(message, "INFRASTRUCTURE_FUNDING_REQUIRED", { quote }, false);
    this.name = "MeteoraInfrastructureFundingRequiredError";
    this.quote = quote;
  }
}

export class MeteoraPartialExecutionError extends MeteoraError {
  readonly result: MeteoraExecutionResult;
  readonly cause: unknown;

  constructor(message: string, result: MeteoraExecutionResult, cause: unknown) {
    super(message, "PARTIAL_EXECUTION", { result }, true);
    this.name = "MeteoraPartialExecutionError";
    this.result = result;
    this.cause = cause;
  }
}

export class MeteoraVerificationError extends MeteoraError {
  readonly result: MeteoraExecutionResult;

  constructor(message: string, result: MeteoraExecutionResult) {
    super(message, "VERIFICATION_FAILED", { result }, true);
    this.name = "MeteoraVerificationError";
    this.result = result;
  }
}

export class MeteoraMovePositionError extends MeteoraError {
  readonly stage: "close" | "reopen";
  readonly sourcePosition: string;
  readonly closeResult: MeteoraExecutionResult | null;
  readonly attribution: MeteoraMoveCapitalAttribution | null;
  override readonly cause: unknown;

  constructor(args: {
    message: string;
    stage: "close" | "reopen";
    sourcePosition: string;
    closeResult?: MeteoraExecutionResult | null;
    attribution?: MeteoraMoveCapitalAttribution | null;
    cause?: unknown;
  }) {
    super(
      args.message,
      "MOVE_FAILED",
      { stage: args.stage, sourcePosition: args.sourcePosition },
      args.stage === "reopen",
    );
    this.name = "MeteoraMovePositionError";
    this.stage = args.stage;
    this.sourcePosition = args.sourcePosition;
    this.closeResult = args.closeResult ?? null;
    this.attribution = args.attribution ?? null;
    this.cause = args.cause;
  }
}

function bigintOrZero(value: unknown): bigint {
  const text = integerString(value, "0");
  try {
    const out = BigInt(text);
    return out >= 0n ? out : 0n;
  } catch {
    return 0n;
  }
}

/**
 * Meteora quoteCreatePosition() currently reports its *Cost fields as SOL
 * numbers (POSITION_FEE, BIN_ARRAY_FEE, bitmap fee, and realloc Decimal values),
 * despite several downstream integrations naturally expecting lamports. Normalize
 * those values at the Solard boundary. The large-integer branch retains
 * compatibility with older/custom SDK builds that may already return lamports.
 */
function meteoraQuotedSolCostToLamports(value: unknown): bigint | null {
  const n = numberOrNull(value);
  if (n == null || n < 0) return null;
  if (Number.isInteger(n) && n >= 1_000_000) return BigInt(n);
  const lamports = Math.round(n * 1_000_000_000);
  return Number.isSafeInteger(lamports) ? BigInt(lamports) : null;
}

function sdkRentConstantLamports(
  sdk: Record<string, unknown>,
  bnKey: string,
  solKey: string,
): bigint | null {
  const bn = sdk[bnKey];
  if (bn != null) {
    const text = integerString(bn, "");
    if (/^\d+$/.test(text)) return BigInt(text);
  }
  return meteoraQuotedSolCostToLamports(sdk[solKey]);
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function integerLikeNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = finiteNumber(
    typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint"
      ? value
      : String(value),
  );
  return parsed != null && Number.isSafeInteger(parsed) ? parsed : null;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  return percentile(values, 0.5);
}

function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, q * (sorted.length - 1)),
  );
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  const fraction = index - lower;
  return sorted[lower]! * (1 - fraction) + sorted[upper]! * fraction;
}

function standardDeviation(values: number[]): number | null {
  if (values.length < 2) return null;
  const avg = mean(values)!;
  const variance =
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function coefficientOfVariation(values: number[]): number | null {
  const avg = mean(values);
  const sd = standardDeviation(values);
  if (avg == null || sd == null || avg === 0) return null;
  return sd / Math.abs(avg);
}

function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let numerator = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    numerator += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denominator = Math.sqrt(dx2 * dy2);
  return denominator > 0 ? numerator / denominator : null;
}

function ratioOrNull(
  numerator: number | null,
  denominator: number | null,
): number | null {
  if (numerator == null || denominator == null || denominator === 0)
    return null;
  return numerator / denominator;
}

function rawField(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value == null) continue;
    const text = integerString(value, "");
    if (/^\d+$/.test(text)) return text;
  }
  return "0";
}

function rawToUi(raw: string, decimals: number | null): number | null {
  if (decimals == null || !Number.isInteger(decimals) || decimals < 0)
    return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n / 10 ** decimals;
}

function rowArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value))
    return value.filter((row) => row && typeof row === "object") as Record<
      string,
      unknown
    >[];
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (Array.isArray(row.bins))
      return row.bins.filter(
        (entry) => entry && typeof entry === "object",
      ) as Record<string, unknown>[];
    if (Array.isArray(row.data))
      return row.data.filter(
        (entry) => entry && typeof entry === "object",
      ) as Record<string, unknown>[];
  }
  return [];
}

function recordOrEmpty(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function firstFiniteValue(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function timeframeMetric(
  row: Record<string, any>,
  timeframe: MeteoraTimeframe,
  keys: string[],
): number | null {
  for (const key of keys) {
    const direct = row[key];
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      const fromWindow = firstFiniteValue(
        direct[timeframe],
        direct[timeframe.replace("m", "min")],
      );
      if (fromWindow != null) return fromWindow;
    }
    const flat = firstFiniteValue(
      row[`${key}_${timeframe}`],
      row[`${key}${timeframe}`],
      row[`${timeframe}_${key}`],
    );
    if (flat != null) return flat;
    const directNumber = finiteNumber(direct);
    if (directNumber != null) return directNumber;
  }
  return null;
}

function discoveryToken(
  row: Record<string, any>,
  side: "x" | "y",
): {
  mint: string | null;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
} {
  const token = recordOrEmpty(
    row[`token_${side}`] ?? row[`token${side.toUpperCase()}`] ?? row[side],
  );
  const mint = recordOrEmpty(token.mint);
  return {
    mint:
      publicKeyString(
        row[`mint_${side}`] ??
          row[`token_${side}_mint`] ??
          token.address ??
          token.mint_address ??
          token.mint ??
          mint.address ??
          mint.publicKey,
      ) ?? null,
    symbol:
      row[`mint_${side}_symbol`] != null
        ? String(row[`mint_${side}_symbol`])
        : token.symbol != null
          ? String(token.symbol)
          : mint.symbol != null
            ? String(mint.symbol)
            : null,
    name:
      row[`mint_${side}_name`] != null
        ? String(row[`mint_${side}_name`])
        : token.name != null
          ? String(token.name)
          : mint.name != null
            ? String(mint.name)
            : null,
    decimals: firstFiniteValue(
      row[`mint_${side}_decimals`],
      row[`token_${side}_decimals`],
      token.decimals,
      mint.decimals,
    ),
  };
}

function extractBinId(bin: unknown): number | null {
  const row = (bin ?? {}) as Record<string, unknown>;
  return (
    numberOrNull(row.binId) ??
    numberOrNull(row.id) ??
    numberOrNull(row.activeId)
  );
}

function positionHasLiquidity(position: any): boolean {
  const bins = Array.isArray(position?.positionData?.positionBinData)
    ? position.positionData.positionBinData
    : [];
  return bins.some((bin: any) => {
    const raw =
      bin?.positionLiquidity ?? bin?.liquidityShare ?? bin?.liquidity ?? "0";
    try {
      return new BN(String(raw), 10).gt(new BN(0));
    } catch {
      return false;
    }
  });
}

function mapEntries<T>(
  value: Map<string, T> | Record<string, T>,
): Array<[string, T]> {
  return value instanceof Map ? [...value.entries()] : Object.entries(value);
}

function signedBigintDelta(after: string, before: string): string {
  return (BigInt(after) - BigInt(before)).toString();
}

function positiveBigintDelta(after: string, before: string): string {
  const delta = BigInt(after) - BigInt(before);
  return (delta > 0n ? delta : 0n).toString();
}

function negativeBigintDeltaMagnitude(after: string, before: string): string {
  const delta = BigInt(before) - BigInt(after);
  return (delta > 0n ? delta : 0n).toString();
}

function accountingSupportedKind(
  kind: MeteoraPreparedTransactions["kind"],
): boolean {
  return (
    kind === "open-position" ||
    kind === "add-liquidity" ||
    kind === "remove-liquidity" ||
    kind === "close-position" ||
    kind === "claim-fees" ||
    kind === "swap-exact-in" ||
    kind === "swap-exact-out" ||
    kind === "place-limit-order" ||
    kind === "cancel-limit-order" ||
    kind === "close-limit-order"
  );
}

type MeteoraExecutionAccountingBefore = {
  walletAddress: string;
  tokenXMint: string;
  tokenYMint: string;
  wallet: MeteoraWalletAccountingSnapshot;
  position: MeteoraPositionAccountingSnapshot | null;
  limitOrder: { exists: boolean; accountLamports: string } | null;
};

export class MeteoraDlmmService {
  private readonly pools = new Map<string, Promise<DlmmPool>>();
  /**
   * Process-local wallet write serialization. This intentionally covers the whole
   * close -> recover -> reopen move so another Solard Meteora write cannot consume
   * or mutate the same wallet inventory between those stages.
   */
  private readonly walletWriteTails = new Map<string, Promise<void>>();

  constructor(private readonly host: MeteoraDlmmHost) {}

  private async withWalletWriteLock<T>(
    wallet: WalletRef,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = this.resolveWalletAddress(wallet);
    const previous = this.walletWriteTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => gate);
    this.walletWriteTails.set(key, tail);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.walletWriteTails.get(key) === tail)
        this.walletWriteTails.delete(key);
    }
  }

  private dataApiBase(): string {
    return (
      process.env.METEORA_DLMM_DATA_API_URL?.trim() || DEFAULT_DATA_API
    ).replace(/\/+$/, "");
  }

  private discoveryApiBase(): string {
    return (
      process.env.METEORA_POOL_DISCOVERY_API_URL?.trim() ||
      DEFAULT_DISCOVERY_API
    ).replace(/\/+$/, "");
  }

  resolveWalletAddress(wallet: WalletRef): string {
    const publicAddress = this.host.walletAddress?.(wallet);
    if (publicAddress) return asPublicKey(publicAddress).toBase58();
    return this.host.signer(wallet).publicKey.toBase58();
  }

  createPositionScope(args: {
    wallet: WalletRef;
    pool: string;
  }): MeteoraManagedPositionScope {
    return new MeteoraManagedPositionScope(this, args.wallet, args.pool);
  }

  /** Describe X/Y orientation relative to an explicit quote mint. */
  async describePair(
    poolAddress: string,
    args: { quoteMint: string | PublicKey },
  ): Promise<MeteoraPairDescriptor> {
    const state = await this.getPoolState(poolAddress, true);
    const quoteMint = asPublicKey(args.quoteMint).toBase58();
    const xIsQuote = state.tokenX.mint === quoteMint;
    const yIsQuote = state.tokenY.mint === quoteMint;
    if (xIsQuote === yIsQuote) {
      throw new MeteoraError(
        `Quote mint ${quoteMint} is not exactly one side of Meteora pool ${state.pool}`,
        "INVALID_ARGUMENT",
        {
          pool: state.pool,
          quoteMint,
          tokenX: state.tokenX.mint,
          tokenY: state.tokenY.mint,
        },
      );
    }
    return {
      version: 1,
      pool: state.pool,
      tokenX: state.tokenX,
      tokenY: state.tokenY,
      quoteMint,
      baseMint: xIsQuote ? state.tokenY.mint : state.tokenX.mint,
      quoteSide: xIsQuote ? "x" : "y",
      baseSide: xIsQuote ? "y" : "x",
      basePriceBinDirection: xIsQuote ? -1 : 1,
    };
  }

  /** Native Meteora limit-order side for the token being deposited. ASK deposits X; BID deposits Y. */
  limitOrderSideForInputMint(
    pair: MeteoraPairDescriptor,
    inputMint: string | PublicKey,
  ): MeteoraLimitOrderSide {
    const mint = asPublicKey(inputMint).toBase58();
    if (mint === pair.tokenX.mint) return "ask";
    if (mint === pair.tokenY.mint) return "bid";
    throw new MeteoraError(
      `Limit-order input mint ${mint} is not part of pool ${pair.pool}`,
      "INVALID_ARGUMENT",
      {
        pool: pair.pool,
        inputMint: mint,
        tokenX: pair.tokenX.mint,
        tokenY: pair.tokenY.mint,
      },
    );
  }

  /** Resolve the non-replenishing side for buying or selling the pair's base token. */
  limitOrderSideForBaseAction(
    pair: MeteoraPairDescriptor,
    action: "sell-base" | "buy-base",
  ): MeteoraLimitOrderSide {
    if (action === "sell-base") return pair.baseSide === "x" ? "ask" : "bid";
    return pair.quoteSide === "x" ? "ask" : "bid";
  }

  centeredRange(activeBin: number, width: number): MeteoraRange {
    if (
      !Number.isInteger(activeBin) ||
      !Number.isInteger(width) ||
      width <= 0
    ) {
      throw new MeteoraError(
        "Meteora centeredRange requires integer activeBin and positive integer width",
        "INVALID_ARGUMENT",
        { activeBin, width },
      );
    }
    const below = Math.floor((width - 1) / 2);
    return {
      minBinId: activeBin - below,
      maxBinId: activeBin + (width - 1 - below),
    };
  }

  rangeOnBasePriceSide(
    activeBin: number,
    width: number,
    gapBins: number,
    pair: MeteoraPairDescriptor,
    side: "below" | "above",
  ): MeteoraRange {
    if (
      !Number.isInteger(activeBin) ||
      !Number.isInteger(width) ||
      width <= 0 ||
      !Number.isInteger(gapBins) ||
      gapBins < 1
    ) {
      throw new MeteoraError(
        "Meteora rangeOnBasePriceSide requires integer activeBin, positive width, and gapBins >= 1",
        "INVALID_ARGUMENT",
        { activeBin, width, gapBins, side },
      );
    }
    const higherBin =
      (side === "above" && pair.basePriceBinDirection === 1) ||
      (side === "below" && pair.basePriceBinDirection === -1);
    if (higherBin) {
      const minBinId = activeBin + gapBins;
      return { minBinId, maxBinId: minBinId + width - 1 };
    }
    const maxBinId = activeBin - gapBins;
    return { minBinId: maxBinId - width + 1, maxBinId };
  }

  rangeDistance(activeBin: number, range: MeteoraRange): number {
    if (activeBin < range.minBinId) return range.minBinId - activeBin;
    if (activeBin > range.maxBinId) return activeBin - range.maxBinId;
    return 0;
  }

  orientedBaseBinMove(
    fromBin: number,
    toBin: number,
    pair: MeteoraPairDescriptor,
  ): number {
    return (toBin - fromBin) * pair.basePriceBinDirection;
  }

  priceBaseInQuote(priceYPerX: number, pair: MeteoraPairDescriptor): number {
    if (!(priceYPerX > 0)) {
      throw new MeteoraError(
        "Meteora priceYPerX must be positive",
        "INVALID_ARGUMENT",
        { priceYPerX },
      );
    }
    return pair.quoteSide === "y" ? priceYPerX : 1 / priceYPerX;
  }

  amountsFromBaseQuote(
    baseRaw: MeteoraInteger,
    quoteRaw: MeteoraInteger,
    pair: MeteoraPairDescriptor,
  ): { xRaw: string; yRaw: string } {
    const base = toBN(baseRaw, "baseRaw").toString(10);
    const quote = toBN(quoteRaw, "quoteRaw").toString(10);
    return pair.baseSide === "x"
      ? { xRaw: base, yRaw: quote }
      : { xRaw: quote, yRaw: base };
  }

  amountsToBaseQuote(
    xRaw: MeteoraInteger,
    yRaw: MeteoraInteger,
    pair: MeteoraPairDescriptor,
  ): { baseRaw: string; quoteRaw: string } {
    const x = toBN(xRaw, "xRaw").toString(10);
    const y = toBN(yRaw, "yRaw").toString(10);
    return pair.baseSide === "x"
      ? { baseRaw: x, quoteRaw: y }
      : { baseRaw: y, quoteRaw: x };
  }

  clearPoolCache(pool?: string): void {
    if (pool) this.pools.delete(asPublicKey(pool).toBase58());
    else this.pools.clear();
  }

  async rawPool(pool: string, refresh = false): Promise<DlmmPool> {
    const key = asPublicKey(pool).toBase58();
    if (refresh) this.pools.delete(key);
    let pending = this.pools.get(key);
    if (!pending) {
      pending = dlmmSdk().then(({ default: DLMM }) =>
        DLMM.create(this.host.connection(), new PublicKey(key), {
          cluster: meteoraCluster(),
        }),
      );
      this.pools.set(key, pending);
    }
    const client = await pending;
    if (refresh) await client.refetchStates();
    return client;
  }

  async rawPools(pools: string[]): Promise<DlmmPool[]> {
    const keys = pools.map((pool) => asPublicKey(pool));
    const { default: DLMM } = await dlmmSdk();
    return await DLMM.createMultiple(this.host.connection(), keys, {
      cluster: meteoraCluster(),
    });
  }

  async getPoolState(
    poolAddress: string,
    refresh = false,
  ): Promise<MeteoraPoolState> {
    const pool = await this.rawPool(poolAddress, refresh);
    const activeBin = await this.getActiveBin(poolAddress, false);
    let feeInfo: Record<string, unknown> | null = null;
    let dynamicFee: string | null = null;
    try {
      feeInfo = (safeJsonValue(pool.getFeeInfo()) ?? null) as Record<
        string,
        unknown
      > | null;
    } catch {}
    try {
      dynamicFee = String(pool.getDynamicFee());
    } catch {}

    return {
      pool: pool.pubkey.toBase58(),
      tokenX: tokenReserve(pool.tokenX),
      tokenY: tokenReserve(pool.tokenY),
      binStep: numberOrNull((pool.lbPair as any)?.binStep),
      activeId: numberOrNull((pool.lbPair as any)?.activeId),
      activeBin,
      feeInfo,
      dynamicFee,
    };
  }

  async getActiveBin(
    poolAddress: string,
    refresh = false,
  ): Promise<MeteoraActiveBin> {
    const pool = await this.rawPool(poolAddress, refresh);
    const active = await pool.getActiveBin();
    const rawPrice = String((active as any).price);
    return {
      pool: pool.pubkey.toBase58(),
      binId:
        extractBinId(active) ??
        numberOrNull((pool.lbPair as any)?.activeId) ??
        0,
      price: String(pool.fromPricePerLamport(Number(rawPrice))),
      pricePerLamport: rawPrice,
    };
  }

  async getActiveBinSample(
    poolAddress: string,
    refresh = true,
  ): Promise<MeteoraActiveBinSample> {
    const observedAt = Date.now();
    const pool = await this.rawPool(poolAddress, refresh);
    const [active, slot] = await Promise.all([
      pool.getActiveBin(),
      this.host
        .connection()
        .getSlot("processed")
        .then((value) => Number(value))
        .catch(() => null),
    ]);
    const rawPrice = finiteNumber(String((active as any)?.price));
    const priceYPerX =
      rawPrice != null
        ? (finiteNumber(pool.fromPricePerLamport(rawPrice)) ?? Number.NaN)
        : Number.NaN;
    const binId =
      extractBinId(active) ?? numberOrNull((pool.lbPair as any)?.activeId);
    if (binId == null || !Number.isFinite(priceYPerX))
      throw new Error("Meteora active-bin sample is unavailable");
    let dynamicFeePct: number | null = null;
    try {
      dynamicFeePct = finiteNumber(String(pool.getDynamicFee()));
    } catch {}
    return {
      version: 1,
      observedAt,
      slot,
      pool: pool.pubkey.toBase58(),
      binId,
      priceYPerX,
      pricePerLamport: rawPrice,
      dynamicFeePct,
    };
  }

  analyzeActiveBinSamples(
    samples: MeteoraActiveBinSample[],
  ): MeteoraMicrostructureMetrics {
    const ordered = [...samples]
      .filter(
        (sample) =>
          Number.isFinite(sample.observedAt) &&
          Number.isInteger(sample.binId) &&
          Number.isFinite(sample.priceYPerX) &&
          sample.priceYPerX > 0,
      )
      .sort((a, b) => a.observedAt - b.observedAt);
    const pool = ordered[0]?.pool ?? samples[0]?.pool ?? "";
    if (ordered.some((sample) => sample.pool !== pool))
      throw new Error("Meteora active-bin samples must belong to one pool");

    const start = ordered[0] ?? null;
    const end = ordered.at(-1) ?? null;
    const durationSec =
      start && end && end.observedAt >= start.observedAt
        ? (end.observedAt - start.observedAt) / 1000
        : null;
    const durationMin = durationSec != null ? durationSec / 60 : null;
    const intervalsSec: number[] = [];
    const signedSteps: number[] = [];
    const nonzeroAbsSteps: number[] = [];
    const logMovesPct: number[] = [];
    let stationarySec = 0;
    let pathBins = 0;
    let binChanges = 0;
    let directionFlips = 0;
    let previousDirection = 0;

    for (let i = 1; i < ordered.length; i += 1) {
      const a = ordered[i - 1]!;
      const b = ordered[i]!;
      const dtSec = (b.observedAt - a.observedAt) / 1000;
      if (!(dtSec > 0)) continue;
      intervalsSec.push(dtSec);
      const step = b.binId - a.binId;
      signedSteps.push(step);
      pathBins += Math.abs(step);
      if (step === 0) stationarySec += dtSec;
      else {
        binChanges += 1;
        nonzeroAbsSteps.push(Math.abs(step));
        const direction = Math.sign(step);
        if (previousDirection !== 0 && direction !== previousDirection)
          directionFlips += 1;
        previousDirection = direction;
      }
      if (a.priceYPerX > 0 && b.priceYPerX > 0)
        logMovesPct.push(Math.log(b.priceYPerX / a.priceYPerX) * 100);
    }

    const dwellSec: number[] = [];
    if (ordered.length) {
      let runStart = ordered[0]!.observedAt;
      let runBin = ordered[0]!.binId;
      for (let i = 1; i < ordered.length; i += 1) {
        const sample = ordered[i]!;
        if (sample.binId === runBin) continue;
        dwellSec.push(Math.max(0, (sample.observedAt - runStart) / 1000));
        runStart = sample.observedAt;
        runBin = sample.binId;
      }
      if (end) {
        const finalDwell = Math.max(0, (end.observedAt - runStart) / 1000);
        if (finalDwell > 0 || dwellSec.length === 0) dwellSec.push(finalDwell);
      }
    }

    const bins = ordered.map((sample) => sample.binId);
    const prices = ordered.map((sample) => sample.priceYPerX);
    const dynamicFees = ordered
      .map((sample) => sample.dynamicFeePct)
      .filter(
        (value): value is number => value != null && Number.isFinite(value),
      );
    const displacementBins = start && end ? end.binId - start.binId : null;
    const priceReturnPct =
      start && end && start.priceYPerX > 0
        ? (end.priceYPerX / start.priceYPerX - 1) * 100
        : null;

    return {
      version: 1,
      pool,
      sampleCount: ordered.length,
      startAt: start?.observedAt ?? null,
      endAt: end?.observedAt ?? null,
      durationSec,
      meanSampleIntervalSec: mean(intervalsSec),
      p90SampleIntervalSec: percentile(intervalsSec, 0.9),
      maxSampleIntervalSec: intervalsSec.length
        ? Math.max(...intervalsSec)
        : null,
      startBin: start?.binId ?? null,
      endBin: end?.binId ?? null,
      displacementBins,
      totalPathBins: ordered.length ? pathBins : null,
      totalSpanBins: bins.length ? Math.max(...bins) - Math.min(...bins) : null,
      pathBinsPerMinute:
        durationMin != null && durationMin > 0 ? pathBins / durationMin : null,
      netBinsPerMinute:
        durationMin != null && durationMin > 0 && displacementBins != null
          ? displacementBins / durationMin
          : null,
      trendEfficiency:
        displacementBins != null && pathBins > 0
          ? Math.min(1, Math.abs(displacementBins) / pathBins)
          : pathBins === 0 && ordered.length > 1
            ? 0
            : null,
      binChanges,
      binChangesPerMinute:
        durationMin != null && durationMin > 0
          ? binChanges / durationMin
          : null,
      stationaryTimePct:
        durationSec != null && durationSec > 0
          ? (stationarySec / durationSec) * 100
          : null,
      uniqueBinsVisited: new Set(bins).size,
      directionFlips,
      meanAbsMovePerChangeBins: mean(nonzeroAbsSteps),
      medianAbsMovePerChangeBins: median(nonzeroAbsSteps),
      p90AbsMovePerChangeBins: percentile(nonzeroAbsSteps, 0.9),
      maxAbsMovePerChangeBins: nonzeroAbsSteps.length
        ? Math.max(...nonzeroAbsSteps)
        : null,
      realizedStepVolBins: standardDeviation(signedSteps),
      meanDwellSec: mean(dwellSec),
      medianDwellSec: median(dwellSec),
      p90DwellSec: percentile(dwellSec, 0.9),
      maxDwellSec: dwellSec.length ? Math.max(...dwellSec) : null,
      startPriceYPerX: start?.priceYPerX ?? null,
      endPriceYPerX: end?.priceYPerX ?? null,
      priceReturnPct,
      highLowSpanPct:
        prices.length && Math.min(...prices) > 0
          ? (Math.max(...prices) / Math.min(...prices) - 1) * 100
          : null,
      realizedLogVolPct: standardDeviation(logMovesPct),
      meanDynamicFeePct: mean(dynamicFees),
      p90DynamicFeePct: percentile(dynamicFees, 0.9),
    };
  }

  analyzeRangeFromActiveBinSamples(
    samples: MeteoraActiveBinSample[],
    minBinId: number,
    maxBinId: number,
  ): MeteoraRangePathMetrics {
    if (!Number.isInteger(minBinId) || !Number.isInteger(maxBinId))
      throw new Error("Meteora range bins must be integers");
    if (minBinId > maxBinId)
      throw new Error("Meteora minBinId cannot be greater than maxBinId");
    const ordered = [...samples]
      .filter(
        (sample) =>
          Number.isFinite(sample.observedAt) && Number.isInteger(sample.binId),
      )
      .sort((a, b) => a.observedAt - b.observedAt);
    const pool = ordered[0]?.pool ?? samples[0]?.pool ?? "";
    if (ordered.some((sample) => sample.pool !== pool))
      throw new Error("Meteora active-bin samples must belong to one pool");
    const start = ordered[0] ?? null;
    const end = ordered.at(-1) ?? null;
    const durationSec =
      start && end && end.observedAt >= start.observedAt
        ? (end.observedAt - start.observedAt) / 1000
        : null;
    const contains = (binId: number) => binId >= minBinId && binId <= maxBinId;
    const distance = (binId: number) =>
      binId < minBinId
        ? minBinId - binId
        : binId > maxBinId
          ? binId - maxBinId
          : 0;
    let inRangeSec = 0;
    let outOfRangeSec = 0;
    let entries = 0;
    let exits = 0;
    let firstExitAfterSec: number | null = null;
    let firstEntryAfterSec: number | null = null;
    let longestInRangeSec = 0;
    let longestOutOfRangeSec = 0;
    let currentState = start ? contains(start.binId) : null;
    let stateStartedAt = start?.observedAt ?? null;
    let maxOutOfRangeDistanceBins: number | null = null;

    for (let i = 0; i < ordered.length; i += 1) {
      const sample = ordered[i]!;
      const d = distance(sample.binId);
      if (d > 0)
        maxOutOfRangeDistanceBins = Math.max(maxOutOfRangeDistanceBins ?? 0, d);
      if (i === 0) continue;
      const previous = ordered[i - 1]!;
      const dtSec = Math.max(
        0,
        (sample.observedAt - previous.observedAt) / 1000,
      );
      if (contains(previous.binId)) inRangeSec += dtSec;
      else outOfRangeSec += dtSec;
      const nextState = contains(sample.binId);
      if (currentState != null && nextState !== currentState) {
        const stateDuration =
          stateStartedAt != null
            ? Math.max(0, (sample.observedAt - stateStartedAt) / 1000)
            : 0;
        if (currentState) {
          exits += 1;
          longestInRangeSec = Math.max(longestInRangeSec, stateDuration);
          if (firstExitAfterSec == null && start)
            firstExitAfterSec = (sample.observedAt - start.observedAt) / 1000;
        } else {
          entries += 1;
          longestOutOfRangeSec = Math.max(longestOutOfRangeSec, stateDuration);
          if (firstEntryAfterSec == null && start)
            firstEntryAfterSec = (sample.observedAt - start.observedAt) / 1000;
        }
        currentState = nextState;
        stateStartedAt = sample.observedAt;
      }
    }
    if (end && currentState != null && stateStartedAt != null) {
      const finalDuration = Math.max(
        0,
        (end.observedAt - stateStartedAt) / 1000,
      );
      if (currentState)
        longestInRangeSec = Math.max(longestInRangeSec, finalDuration);
      else longestOutOfRangeSec = Math.max(longestOutOfRangeSec, finalDuration);
    }
    const totalMeasuredSec = inRangeSec + outOfRangeSec;
    return {
      version: 1,
      pool,
      minBinId,
      maxBinId,
      width: maxBinId - minBinId + 1,
      sampleCount: ordered.length,
      durationSec,
      inRangeTimePct:
        totalMeasuredSec > 0 ? (inRangeSec / totalMeasuredSec) * 100 : null,
      inRangeSec: ordered.length > 1 ? inRangeSec : null,
      outOfRangeSec: ordered.length > 1 ? outOfRangeSec : null,
      entries,
      exits,
      finalInRange: end ? contains(end.binId) : null,
      maxOutOfRangeDistanceBins,
      firstExitAfterSec,
      firstEntryAfterSec,
      longestInRangeSec: ordered.length > 1 ? longestInRangeSec : null,
      longestOutOfRangeSec: ordered.length > 1 ? longestOutOfRangeSec : null,
    };
  }

  async getPoolOracleSnapshot(
    poolAddress: string,
    args: MeteoraOracleSnapshotArgs = {},
  ): Promise<MeteoraOracleSnapshot> {
    const observedAt = Date.now();
    const pool = await this.rawPool(poolAddress, args.refresh ?? true);
    const active = await pool.getActiveBin();
    const spotBin =
      extractBinId(active) ?? numberOrNull((pool.lbPair as any)?.activeId) ?? 0;
    const rawPrice = finiteNumber(String((active as any)?.price));
    const spotPriceYPerX =
      rawPrice != null
        ? (finiteNumber(pool.fromPricePerLamport(rawPrice)) ?? Number.NaN)
        : Number.NaN;
    if (!Number.isFinite(spotPriceYPerX))
      throw new Error("Meteora oracle snapshot requires an active pool price");

    const poolClockUnixSec = integerLikeNumber(
      (pool as any)?.clock?.unixTimestamp,
    );
    let rpcBlockTimeUnixSec: number | null = null;
    if (poolClockUnixSec == null) {
      try {
        const slot = await this.host.connection().getSlot("confirmed");
        rpcBlockTimeUnixSec = await this.host.connection().getBlockTime(slot);
      } catch {}
    }
    const currentTimestampUnixSec =
      poolClockUnixSec ?? rpcBlockTimeUnixSec ?? Math.floor(observedAt / 1000);
    const currentTimestampSource =
      poolClockUnixSec != null
        ? ("pool-clock" as const)
        : rpcBlockTimeUnixSec != null
          ? ("rpc-block-time" as const)
          : ("local-clock" as const);
    const base: Omit<
      MeteoraOracleSnapshot,
      | "supported"
      | "available"
      | "oracleAddress"
      | "metadata"
      | "initializedObservationCount"
      | "earliestObservationAtUnixSec"
      | "latestObservationAtUnixSec"
      | "latestObservationAgeSec"
      | "maxDurationSec"
      | "twaps"
      | "observations"
      | "error"
    > = {
      version: 1,
      observedAt,
      pool: pool.pubkey.toBase58(),
      currentTimestampUnixSec,
      currentTimestampSource,
      spotBin,
      spotPriceYPerX,
    };

    if (typeof (pool as any).getOracle !== "function") {
      return {
        ...base,
        supported: false,
        available: false,
        oracleAddress: null,
        metadata: null,
        initializedObservationCount: 0,
        earliestObservationAtUnixSec: null,
        latestObservationAtUnixSec: null,
        latestObservationAgeSec: null,
        maxDurationSec: null,
        twaps: [],
        observations: null,
        error:
          "Installed @meteora-ag/dlmm does not expose getOracle(); upgrade to an oracle-capable release",
      };
    }

    try {
      const oracle: any = await (pool as any).getOracle();
      const now = new BN(String(currentTimestampUnixSec), 10);
      const decoded: MeteoraOracleObservation[] = Array.isArray(
        oracle?.observations,
      )
        ? oracle.observations.map((observation: any, index: number) => ({
            index,
            initialized:
              typeof observation?.isInitialized === "function"
                ? observation.isInitialized()
                : (() => {
                    const created = integerLikeNumber(observation?.createdAt);
                    const updated = integerLikeNumber(
                      observation?.lastUpdatedAt,
                    );
                    return (
                      created != null &&
                      created !== 0 &&
                      updated != null &&
                      updated !== 0
                    );
                  })(),
            cumulativeActiveBinId: integerString(
              observation?.cumulativeActiveBinId,
              "0",
            ),
            createdAtUnixSec: integerLikeNumber(observation?.createdAt),
            lastUpdatedAtUnixSec: integerLikeNumber(observation?.lastUpdatedAt),
          }))
        : [];
      const initialized = decoded.filter(
        (observation) => observation.initialized,
      );
      const updatedTimes = initialized
        .map((observation) => observation.lastUpdatedAtUnixSec)
        .filter((value): value is number => value != null);
      const windows = [...new Set(args.twapWindowsSec ?? [60, 300, 900, 3600])]
        .map((value) => Math.trunc(Number(value)))
        .filter((value) => value > 0 && value <= 7 * 24 * 60 * 60)
        .sort((a, b) => a - b);
      const twaps: MeteoraOracleTwapWindow[] = windows.map((requestedSec) => {
        const start = now.sub(new BN(requestedSec));
        const activeResult = oracle.getActiveIdByTime(start, now);
        const priceResult = oracle.getUiPriceByTime(start, now);
        const twapActiveBin = activeResult
          ? integerLikeNumber(activeResult.value)
          : null;
        const twapPrice = priceResult
          ? finiteNumber(String(priceResult.value))
          : null;
        const durationSec =
          integerLikeNumber(activeResult?.duration) ??
          integerLikeNumber(priceResult?.duration);
        const covered =
          twapActiveBin != null && twapPrice != null && twapPrice > 0;
        return {
          requestedSec,
          covered,
          durationSec,
          activeBin: twapActiveBin,
          uiPriceYPerX: twapPrice,
          spotDeviationBins:
            twapActiveBin != null ? spotBin - twapActiveBin : null,
          spotVsTwapPct:
            twapPrice != null && twapPrice > 0
              ? (spotPriceYPerX / twapPrice - 1) * 100
              : null,
        };
      });
      const metadataRaw = (safeJsonValue(oracle?.metadata) ?? {}) as Record<
        string,
        unknown
      >;
      const maxDurationSec =
        typeof oracle?.getMaxDuration === "function"
          ? integerLikeNumber(oracle.getMaxDuration(now))
          : null;
      return {
        ...base,
        supported: true,
        available: true,
        oracleAddress: publicKeyString(oracle?.oracleAddress),
        metadata: {
          idx: integerLikeNumber(oracle?.metadata?.idx),
          activeSize: integerLikeNumber(oracle?.metadata?.activeSize),
          length: integerLikeNumber(oracle?.metadata?.length),
          raw: metadataRaw,
        },
        initializedObservationCount: initialized.length,
        earliestObservationAtUnixSec: updatedTimes.length
          ? Math.min(...updatedTimes)
          : null,
        latestObservationAtUnixSec: updatedTimes.length
          ? Math.max(...updatedTimes)
          : null,
        latestObservationAgeSec: updatedTimes.length
          ? Math.max(0, currentTimestampUnixSec - Math.max(...updatedTimes))
          : null,
        maxDurationSec,
        twaps,
        observations: args.includeObservations ? decoded : null,
        error: null,
      };
    } catch (error) {
      return {
        ...base,
        supported: true,
        available: false,
        oracleAddress: null,
        metadata: null,
        initializedObservationCount: 0,
        earliestObservationAtUnixSec: null,
        latestObservationAtUnixSec: null,
        latestObservationAgeSec: null,
        maxDurationSec: null,
        twaps: [],
        observations: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getBinsAroundActiveBin(
    poolAddress: string,
    left = 20,
    right = 20,
  ): Promise<unknown> {
    const pool = await this.rawPool(poolAddress);
    return safeJsonValue(await pool.getBinsAroundActiveBin(left, right));
  }

  async getBinsBetween(
    poolAddress: string,
    lowerBinId: number,
    upperBinId: number,
  ): Promise<unknown> {
    const pool = await this.rawPool(poolAddress);
    return safeJsonValue(
      await pool.getBinsBetweenLowerAndUpperBound(lowerBinId, upperBinId),
    );
  }

  async getBinsByPrice(
    poolAddress: string,
    minPrice: number,
    maxPrice: number,
  ): Promise<unknown> {
    if (!(minPrice > 0) || !(maxPrice > 0) || minPrice > maxPrice)
      throw new Error("Meteora price range must be positive and ordered");
    const pool = await this.rawPool(poolAddress);
    // The SDK bin math operates on price-per-lamport. Solard exposes human/UI prices.
    const minPricePerLamport = Number(pool.toPricePerLamport(minPrice));
    const maxPricePerLamport = Number(pool.toPricePerLamport(maxPrice));
    return safeJsonValue(
      await pool.getBinsBetweenMinAndMaxPrice(
        minPricePerLamport,
        maxPricePerLamport,
      ),
    );
  }

  async getBinIdFromPrice(
    poolAddress: string,
    price: number,
    roundDown: boolean,
  ): Promise<number> {
    if (!(price > 0)) throw new Error("Meteora price must be positive");
    const pool = await this.rawPool(poolAddress);
    const pricePerLamport = Number(pool.toPricePerLamport(price));
    return pool.getBinIdFromPrice(pricePerLamport, roundDown);
  }

  async getBinIdFromPricePerLamport(
    poolAddress: string,
    pricePerLamport: number,
    roundDown: boolean,
  ): Promise<number> {
    if (!(pricePerLamport > 0))
      throw new Error("Meteora pricePerLamport must be positive");
    const pool = await this.rawPool(poolAddress);
    return pool.getBinIdFromPrice(pricePerLamport, roundDown);
  }

  /**
   * Canonical, typed pool discovery backed by Meteora's official DLMM Data API.
   * This method intentionally does not rank or reject pools by trading policy; it
   * only normalizes identity and rolling market measurements for the requested
   * window so an autonomous caller can shortlist pools deterministically.
   */
  async discoverPoolCandidates(
    args: MeteoraPoolDiscoveryArgs = {},
  ): Promise<MeteoraPoolDiscoveryPageV1> {
    const observedAtMs = Date.now();
    const timeframe = args.timeframe ?? "5m";
    const page = Math.max(1, Math.trunc(args.page ?? 1));
    const pageSize = Math.max(
      1,
      Math.min(1000, Math.trunc(args.pageSize ?? 100)),
    );
    const raw = (await this.dataApiGet("/pools", {
      page,
      page_size: pageSize,
      query: args.query?.trim() || undefined,
      sort_by: args.sortBy?.trim() || undefined,
      filter_by: args.filterBy?.trim() || undefined,
    })) as any;
    const rows = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.data)
        ? raw.data
        : Array.isArray(raw?.pools)
          ? raw.pools
          : [];
    const pools: MeteoraPoolDiscoveryCandidateV1[] = [];
    let droppedMalformedRows = 0;
    const nowSec = Math.floor(observedAtMs / 1000);

    for (const value of rows) {
      const row = recordOrEmpty(value);
      const pool = String(
        row.address ?? row.pool_address ?? row.poolAddress ?? row.pool ?? "",
      ).trim();
      if (!pool) {
        droppedMalformedRows += 1;
        continue;
      }
      const config = recordOrEmpty(row.pool_config ?? row.poolConfig);
      const tokenX = discoveryToken(row, "x");
      const tokenY = discoveryToken(row, "y");
      const createdRaw = firstFiniteValue(
        row.created_at,
        row.pool_created_at,
        row.createdAt,
      );
      const createdAtUnixSec =
        createdRaw == null
          ? null
          : createdRaw > 10_000_000_000
            ? createdRaw / 1000
            : createdRaw;
      const tvlUsd = firstFiniteValue(row.tvl, row.liquidity);
      const activeTvlUsd = firstFiniteValue(row.active_tvl, row.activeTvl);
      const volumeUsd = timeframeMetric(row, timeframe, [
        "volume",
        "trade_volume",
        "tradeVolume",
      ]);
      const feeUsd = timeframeMetric(row, timeframe, [
        "fees",
        "fee",
        "trade_fee",
        "tradeFee",
      ]);
      const feeTvlRatio = timeframeMetric(row, timeframe, [
        "fee_tvl_ratio",
        "feeTvlRatio",
      ]);
      const feeActiveTvlPct =
        feeUsd != null && activeTvlUsd != null && activeTvlUsd > 0
          ? (feeUsd / activeTvlUsd) * 100
          : null;
      const volumeActiveTvlPct =
        volumeUsd != null && activeTvlUsd != null && activeTvlUsd > 0
          ? (volumeUsd / activeTvlUsd) * 100
          : null;
      const priceChangePct = timeframeMetric(row, timeframe, [
        "price_change_pct",
        "pool_price_change_pct",
        "priceChangePct",
      ]);
      const swapCount = timeframeMetric(row, timeframe, [
        "swap_count",
        "swapCount",
        "trades",
      ]);
      const uniqueTraders = timeframeMetric(row, timeframe, [
        "unique_traders",
        "uniqueTraders",
      ]);
      const uniqueLps = timeframeMetric(row, timeframe, [
        "unique_lps",
        "uniqueLps",
      ]);
      const rollingMetrics = [
        activeTvlUsd,
        volumeUsd,
        feeUsd,
        feeTvlRatio,
        priceChangePct,
        swapCount,
        uniqueTraders,
        uniqueLps,
      ];

      pools.push({
        schema: METEORA_POOL_DISCOVERY_SCHEMA_V1,
        version: 1,
        observedAtMs,
        timeframe,
        pool,
        name: row.name == null ? null : String(row.name),
        tokenX,
        tokenY,
        createdAtUnixSec,
        ageSec:
          createdAtUnixSec != null
            ? Math.max(0, nowSec - createdAtUnixSec)
            : null,
        currentPriceYPerX: firstFiniteValue(
          row.current_price,
          row.currentPrice,
        ),
        binStep: firstFiniteValue(
          config.bin_step,
          config.binStep,
          row.bin_step,
          row.binStep,
        ),
        baseFeePct: firstFiniteValue(
          config.base_fee_pct,
          config.baseFeePct,
          row.base_fee_pct,
          row.baseFeePct,
          row.base_fee_percentage,
        ),
        dynamicFeePct: firstFiniteValue(row.dynamic_fee_pct, row.dynamicFeePct),
        maxFeePct: firstFiniteValue(
          config.max_fee_pct,
          config.maxFeePct,
          row.max_fee_pct,
          row.maxFeePct,
        ),
        protocolFeePct: firstFiniteValue(
          config.protocol_fee_pct,
          config.protocolFeePct,
          row.protocol_fee_pct,
          row.protocolFeePct,
        ),
        tvlUsd,
        activeTvlUsd,
        volumeUsd,
        feeUsd,
        feeTvlRatio,
        feeActiveTvlPct,
        volumeActiveTvlPct,
        priceChangePct,
        swapCount,
        uniqueTraders,
        uniqueLps,
        aprPct: firstFiniteValue(row.apr, row.apr_24h, row.apr24h),
        apyPct: firstFiniteValue(row.apy, row.apy_24h, row.apy24h),
        hasFarm:
          typeof row.has_farm === "boolean"
            ? row.has_farm
            : typeof row.hasFarm === "boolean"
              ? row.hasFarm
              : null,
        isBlacklisted:
          typeof row.is_blacklisted === "boolean"
            ? row.is_blacklisted
            : typeof row.isBlacklisted === "boolean"
              ? row.isBlacklisted
              : null,
        quality: {
          identityComplete: Boolean(pool && tokenX.mint && tokenY.mint),
          tokenMetadataComplete: Boolean(tokenX.symbol && tokenY.symbol),
          rollingMetricsPresent: rollingMetrics.filter((x) => x != null).length,
          rollingMetricsExpected: 8,
          feeActiveTvlDerived: feeActiveTvlPct != null,
          volumeActiveTvlDerived: volumeActiveTvlPct != null,
        },
        raw: args.includeRaw
          ? ((safeJsonValue(row) ?? {}) as Record<string, unknown>)
          : null,
      });
    }

    const total = firstFiniteValue(raw?.total, raw?.total_count, raw?.count);
    const totalPages = firstFiniteValue(
      raw?.pages,
      raw?.total_pages,
      raw?.totalPages,
    );
    return {
      schema: METEORA_POOL_DISCOVERY_SCHEMA_V1,
      version: 1,
      observedAtMs,
      timeframe,
      page:
        firstFiniteValue(raw?.page, raw?.current_page, raw?.currentPage) ??
        page,
      pageSize: firstFiniteValue(raw?.page_size, raw?.pageSize) ?? pageSize,
      total,
      totalPages:
        totalPages ??
        (total != null && pageSize > 0 ? Math.ceil(total / pageSize) : null),
      returned: pools.length,
      droppedMalformedRows,
      query: args.query?.trim() || null,
      sortBy: args.sortBy?.trim() || null,
      filterBy: args.filterBy?.trim() || null,
      pools,
    };
  }

  async listPools(
    args: {
      page?: number;
      pageSize?: number;
      query?: string;
      sortBy?: string;
      filterBy?: string;
      volumeTw?: string;
      feeTvlRatioTw?: string;
    } = {},
  ): Promise<unknown> {
    return await this.dataApiGet("/pools", {
      page: args.page,
      page_size: args.pageSize,
      query: args.query,
      sort_by: args.sortBy,
      filter_by: args.filterBy,
      volume_tw: args.volumeTw,
      fee_tvl_ratio_tw: args.feeTvlRatioTw,
    });
  }

  async searchPools(
    query: string,
    limit = 10,
  ): Promise<MeteoraPoolSearchResult[]> {
    const normalized = query.trim();
    if (!normalized) throw new Error("Meteora pool search query is required");
    const body = (await this.dataApiGet("/pools", {
      query: normalized,
      page: 1,
      page_size: Math.max(1, Math.min(100, Math.trunc(limit))),
    })) as any;
    const rows = (Array.isArray(body) ? body : (body?.data ?? [])).slice(
      0,
      Math.max(1, Math.min(100, Math.trunc(limit))),
    );

    return rows.map((row: any) => ({
      pool: String(row.address ?? row.pool_address ?? ""),
      name: row.name ? String(row.name) : null,
      binStep: numberOrNull(
        row.bin_step ?? row.dlmm_params?.bin_step ?? row.pool_config?.bin_step,
      ),
      feePct: numberOrNull(
        row.base_fee_percentage ?? row.fee_pct ?? row.pool_config?.base_fee_pct,
      ),
      tvl: numberOrNull(row.liquidity ?? row.tvl),
      volume24h: numberOrNull(
        row.trade_volume_24h ?? row.volume_24h ?? row.volume?.["24h"],
      ),
      tokenX: {
        symbol: row.mint_x_symbol ?? row.token_x?.symbol ?? null,
        mint: row.mint_x ?? row.token_x?.address ?? null,
      },
      tokenY: {
        symbol: row.mint_y_symbol ?? row.token_y?.symbol ?? null,
        mint: row.mint_y ?? row.token_y?.address ?? null,
      },
      raw: (safeJsonValue(row) ?? {}) as Record<string, unknown>,
    }));
  }

  async getIndexedPool(poolAddress: string): Promise<Record<string, unknown>> {
    const pool = asPublicKey(poolAddress).toBase58();
    return ((await this.dataApiGet(`/pools/${pool}`)) ?? {}) as Record<
      string,
      unknown
    >;
  }

  async getPoolProfileMetrics(
    poolAddress: string,
  ): Promise<MeteoraPoolProfileMetrics> {
    const pool = asPublicKey(poolAddress).toBase58();
    const raw = (await this.getIndexedPool(pool)) as any;
    const config = raw?.pool_config ?? {};
    const cumulative = raw?.cumulative_metrics ?? {};
    const windows: MeteoraTimeframe[] = [
      "5m",
      "30m",
      "1h",
      "2h",
      "4h",
      "12h",
      "24h",
    ];
    const windowMap = (
      value: unknown,
    ): Partial<Record<MeteoraTimeframe, number>> => {
      const row =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      const out: Partial<Record<MeteoraTimeframe, number>> = {};
      for (const timeframe of windows) {
        const number = finiteNumber(row[timeframe]);
        if (number != null) out[timeframe] = number;
      }
      return out;
    };
    const createdAtRaw = finiteNumber(raw?.created_at ?? raw?.pool_created_at);
    const createdAtUnixSec =
      createdAtRaw == null
        ? null
        : createdAtRaw > 10_000_000_000
          ? createdAtRaw / 1000
          : createdAtRaw;
    const nowSec = Math.floor(Date.now() / 1000);
    const tvl = finiteNumber(raw?.tvl ?? raw?.liquidity);
    const feesByWindow = windowMap(raw?.fees);
    const feeTvlPctByWindow: Partial<Record<MeteoraTimeframe, number>> = {};
    if (tvl != null && tvl > 0) {
      for (const [timeframe, fee] of Object.entries(feesByWindow)) {
        if (fee != null)
          feeTvlPctByWindow[timeframe as MeteoraTimeframe] =
            (Number(fee) / tvl) * 100;
      }
    }
    return {
      pool,
      createdAtUnixSec,
      ageSec:
        createdAtUnixSec != null && createdAtUnixSec >= 0
          ? Math.max(0, nowSec - createdAtUnixSec)
          : null,
      currentPrice: finiteNumber(raw?.current_price),
      binStep: finiteNumber(config?.bin_step ?? raw?.bin_step),
      baseFeePct: finiteNumber(config?.base_fee_pct ?? raw?.base_fee_pct),
      dynamicFeePct: finiteNumber(raw?.dynamic_fee_pct),
      maxFeePct: finiteNumber(config?.max_fee_pct ?? raw?.max_fee_pct),
      protocolFeePct: finiteNumber(
        config?.protocol_fee_pct ?? raw?.protocol_fee_pct,
      ),
      tvl,
      apr24h: finiteNumber(raw?.apr),
      apy24h: finiteNumber(raw?.apy),
      farmApr24h: finiteNumber(raw?.farm_apr),
      farmApy24h: finiteNumber(raw?.farm_apy),
      hasFarm: typeof raw?.has_farm === "boolean" ? raw.has_farm : null,
      isBlacklisted:
        typeof raw?.is_blacklisted === "boolean" ? raw.is_blacklisted : null,
      volumeByWindow: windowMap(raw?.volume),
      feesByWindow,
      feeTvlPctByWindow,
      cumulativeVolume: finiteNumber(cumulative?.volume),
      cumulativeTradeFee: finiteNumber(cumulative?.trade_fee),
      cumulativeProtocolFee: finiteNumber(cumulative?.protocol_fee),
      raw: (safeJsonValue(raw) ?? {}) as Record<string, unknown>,
    };
  }

  async getPoolDetail(
    poolAddress: string,
    timeframe: MeteoraDiscoverPoolsArgs["timeframe"] = "5m",
  ): Promise<Record<string, unknown> | null> {
    const pool = asPublicKey(poolAddress).toBase58();
    const url = new URL(`${this.discoveryApiBase()}/pools`);
    url.searchParams.set("page_size", "1");
    url.searchParams.set("filter_by", `pool_address=${pool}`);
    url.searchParams.set("timeframe", timeframe);
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new MeteoraDataApiError({
        path: "/pool-discovery/pools",
        message: `Meteora pool discovery detail request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        cause: error,
      });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new MeteoraDataApiError({
        path: "/pool-discovery/pools",
        status: response.status,
        responseBody: detail ? detail.slice(0, 1000) : null,
        message: `Meteora pool discovery detail HTTP ${response.status}${
          detail ? `: ${detail.slice(0, 300)}` : ""
        }`,
      });
    }
    const body = (await response.json()) as any;
    const row = Array.isArray(body?.data) ? body.data[0] : null;
    return row ? (safeJsonValue(row) as Record<string, unknown>) : null;
  }

  async discoverPools(args: MeteoraDiscoverPoolsArgs = {}): Promise<{
    total: number | null;
    currentPage: number | null;
    pages: number | null;
    pageSize: number | null;
    pools: Record<string, unknown>[];
  }> {
    const pageSize = Math.max(
      1,
      Math.min(100, Math.trunc(args.pageSize ?? 50)),
    );
    const url = new URL(`${this.discoveryApiBase()}/pools`);
    url.searchParams.set("page_size", String(pageSize));
    url.searchParams.set("timeframe", args.timeframe ?? "24h");
    // Important: omitted category means the broad discovery universe / UI All tab.
    // top/new/trending are explicit subsets and must never be silently selected.
    if (args.category) url.searchParams.set("category", args.category);
    if (args.filterBy?.trim())
      url.searchParams.set("filter_by", args.filterBy.trim());

    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new MeteoraDataApiError({
        path: "/pool-discovery/pools",
        message: `Meteora pool discovery request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        cause: error,
      });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new MeteoraDataApiError({
        path: "/pool-discovery/pools",
        status: response.status,
        responseBody: detail ? detail.slice(0, 1000) : null,
        message: `Meteora pool discovery HTTP ${response.status}${
          detail ? `: ${detail.slice(0, 300)}` : ""
        }`,
      });
    }
    const body = (await response.json()) as any;
    const rows = Array.isArray(body?.data) ? body.data : [];
    return {
      total: numberOrNull(body?.total),
      currentPage: numberOrNull(body?.current_page ?? body?.page),
      pages: numberOrNull(body?.pages ?? body?.total_pages),
      pageSize: numberOrNull(body?.page_size),
      pools: rows.map(
        (row: unknown) => (safeJsonValue(row) ?? {}) as Record<string, unknown>,
      ),
    };
  }

  private async dataApiGet(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<unknown> {
    const url = new URL(`${this.dataApiBase()}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value == null) continue;
      url.searchParams.set(key, String(value));
    }
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new MeteoraDataApiError({
        path,
        message: `Meteora Data API ${path} request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        cause: error,
      });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new MeteoraDataApiError({
        path,
        status: response.status,
        responseBody: detail ? detail.slice(0, 1000) : null,
        message: `Meteora Data API ${path} HTTP ${response.status}${
          detail ? `: ${detail.slice(0, 300)}` : ""
        }`,
      });
    }
    try {
      return safeJsonValue(await response.json());
    } catch (error) {
      throw new MeteoraDataApiError({
        path,
        status: response.status,
        message: `Meteora Data API ${path} returned invalid JSON`,
        cause: error,
      });
    }
  }

  async getPoolOhlcv(
    poolAddress: string,
    args: MeteoraOhlcvArgs = {},
  ): Promise<MeteoraOhlcvResponse> {
    const pool = asPublicKey(poolAddress).toBase58();
    const raw = (await this.dataApiGet(`/pools/${pool}/ohlcv`, {
      timeframe: args.timeframe ?? "24h",
      start_time: args.startTime,
      end_time: args.endTime,
    })) as any;
    const rows = Array.isArray(raw?.data)
      ? raw.data
      : Array.isArray(raw)
        ? raw
        : [];
    const candles = rows
      .map((row: any) => ({
        timestamp: finiteNumber(row?.timestamp),
        timestampStr:
          row?.timestamp_str == null ? null : String(row.timestamp_str),
        open: finiteNumber(row?.open),
        high: finiteNumber(row?.high),
        low: finiteNumber(row?.low),
        close: finiteNumber(row?.close),
        volume: finiteNumber(row?.volume) ?? 0,
      }))
      .filter(
        (row: any) =>
          row.timestamp != null &&
          row.open != null &&
          row.high != null &&
          row.low != null &&
          row.close != null,
      )
      .sort((a: any, b: any) => a.timestamp - b.timestamp)
      .map((row: any) => ({
        timestamp: row.timestamp as number,
        timestampStr: row.timestampStr as string | null,
        open: row.open as number,
        high: row.high as number,
        low: row.low as number,
        close: row.close as number,
        volume: row.volume as number,
      }));
    return {
      pool,
      timeframe:
        raw?.timeframe == null
          ? (args.timeframe ?? "24h")
          : String(raw.timeframe),
      startTime: finiteNumber(raw?.start_time),
      endTime: finiteNumber(raw?.end_time),
      candles,
    };
  }

  async getPoolRollingMetrics(
    poolAddress: string,
    timeframe: MeteoraDiscoverPoolsArgs["timeframe"] = "5m",
  ): Promise<MeteoraRollingPoolMetrics | null> {
    const pool = asPublicKey(poolAddress).toBase58();
    const detail = (await this.getPoolDetail(pool, timeframe)) as any;
    if (!detail) return null;
    const tvl = finiteNumber(detail.tvl ?? detail.liquidity);
    const activeTvl = finiteNumber(detail.active_tvl ?? detail.activeTvl);
    const volume = finiteNumber(
      detail.volume ??
        detail.volume_window ??
        detail.volume_24h ??
        detail.volume24h,
    );
    const fee = finiteNumber(detail.fee ?? detail.fees);
    const directFeeActive = finiteNumber(
      detail.fee_active_tvl_ratio ?? detail.feeActiveTvlRatio,
    );
    const directVolumeActive = finiteNumber(
      detail.volume_active_tvl_ratio ?? detail.volumeActiveTvlRatio,
    );
    return {
      pool,
      timeframe: timeframe ?? "5m",
      tvl,
      activeTvl,
      volume,
      fee,
      feeActiveTvlPct:
        fee != null && activeTvl != null && activeTvl > 0
          ? (fee / activeTvl) * 100
          : directFeeActive,
      volumeActiveTvlPct:
        volume != null && activeTvl != null && activeTvl > 0
          ? (volume / activeTvl) * 100
          : directVolumeActive,
      swapCount: finiteNumber(detail.swap_count ?? detail.swapCount),
      uniqueTraders: finiteNumber(
        detail.unique_traders ?? detail.uniqueTraders,
      ),
      uniqueLps: finiteNumber(detail.unique_lps ?? detail.uniqueLps),
      priceChangePct: finiteNumber(
        detail.pool_price_change_pct ??
          detail.price_change_pct ??
          detail.priceChangePct,
      ),
      raw: (safeJsonValue(detail) ?? {}) as Record<string, unknown>,
    };
  }

  private async candleRegimeFromOhlcv(
    poolAddress: string,
    ohlcv: MeteoraOhlcvResponse,
  ): Promise<MeteoraCandleRegimeMetrics> {
    const candles = ohlcv.candles;
    const pool = await this.rawPool(poolAddress);
    const pctMoves: number[] = [];
    const absPctMoves: number[] = [];
    const logMoves: number[] = [];
    const candleRangesPct: number[] = [];
    const bodyToRangePct: number[] = [];
    const closeLocationPct: number[] = [];
    const volumes: number[] = [];
    const directions: number[] = [];
    const candleRangeBins: number[] = [];
    const closeMoveBins: number[] = [];
    const closeBins: number[] = [];
    const lowBins: number[] = [];
    const highBins: number[] = [];

    const binFor = (price: number, roundDown: boolean): number | null => {
      if (!(price > 0)) return null;
      try {
        return pool.getBinIdFromPrice(
          Number(pool.toPricePerLamport(price)),
          roundDown,
        );
      } catch {
        return null;
      }
    };

    for (let i = 0; i < candles.length; i += 1) {
      const candle = candles[i]!;
      volumes.push(candle.volume);
      const range = candle.high - candle.low;
      if (candle.open > 0) candleRangesPct.push((range / candle.open) * 100);
      if (range > 0) {
        bodyToRangePct.push(
          (Math.abs(candle.close - candle.open) / range) * 100,
        );
        closeLocationPct.push(((candle.close - candle.low) / range) * 100);
      }
      directions.push(
        candle.close > candle.open ? 1 : candle.close < candle.open ? -1 : 0,
      );
      const lowBin = binFor(candle.low, true);
      const highBin = binFor(candle.high, false);
      const closeBin = binFor(candle.close, true);
      if (lowBin != null) lowBins.push(lowBin);
      if (highBin != null) highBins.push(highBin);
      if (closeBin != null) closeBins.push(closeBin);
      if (lowBin != null && highBin != null)
        candleRangeBins.push(Math.abs(highBin - lowBin));

      if (i > 0) {
        const previous = candles[i - 1]!;
        if (previous.close > 0 && candle.close > 0) {
          const move = (candle.close / previous.close - 1) * 100;
          pctMoves.push(move);
          absPctMoves.push(Math.abs(move));
          logMoves.push(Math.log(candle.close / previous.close) * 100);
        }
        const previousBin =
          closeBins.length >= 2 ? closeBins[closeBins.length - 2] : null;
        if (previousBin != null && closeBin != null)
          closeMoveBins.push(Math.abs(closeBin - previousBin));
      }
    }

    let directionFlips = 0;
    let previousDirection = 0;
    for (const direction of directions) {
      if (direction === 0) continue;
      if (previousDirection !== 0 && direction !== previousDirection)
        directionFlips += 1;
      previousDirection = direction;
    }

    const start = candles[0] ?? null;
    const end = candles.at(-1) ?? null;
    const startPrice = start?.open ?? null;
    const endPrice = end?.close ?? null;
    const maxHigh = candles.length
      ? Math.max(...candles.map((c) => c.high))
      : null;
    const minLow = candles.length
      ? Math.min(...candles.map((c) => c.low))
      : null;
    const durationSec =
      start && end ? Math.max(0, end.timestamp - start.timestamp) : null;
    const pathPct = absPctMoves.reduce((sum, value) => sum + value, 0);
    const netPct =
      startPrice != null && endPrice != null && startPrice > 0
        ? Math.abs((endPrice / startPrice - 1) * 100)
        : null;

    const half = Math.floor(candles.length / 2);
    const prior = half > 0 ? candles.slice(0, half) : [];
    const recent = half > 0 ? candles.slice(candles.length - half) : [];
    const avgRangePct = (rows: typeof candles): number | null =>
      mean(
        rows
          .filter((c) => c.open > 0)
          .map((c) => ((c.high - c.low) / c.open) * 100),
      );
    const avgVolume = (rows: typeof candles): number | null =>
      mean(rows.map((c) => c.volume));
    const closeVol = (rows: typeof candles): number | null => {
      const values: number[] = [];
      for (let i = 1; i < rows.length; i += 1) {
        if (rows[i - 1]!.close > 0 && rows[i]!.close > 0)
          values.push(Math.log(rows[i]!.close / rows[i - 1]!.close) * 100);
      }
      return standardDeviation(values);
    };

    const up = directions.filter((x) => x > 0).length;
    const down = directions.filter((x) => x < 0).length;
    const flat = directions.filter((x) => x === 0).length;
    const startBin = startPrice == null ? null : binFor(startPrice, true);
    const endBin = endPrice == null ? null : binFor(endPrice, true);
    const pathBins = closeMoveBins.reduce((sum, value) => sum + value, 0);
    const durationMin =
      durationSec != null && durationSec > 0 ? durationSec / 60 : null;

    return {
      version: 1,
      pool: asPublicKey(poolAddress).toBase58(),
      timeframe: ohlcv.timeframe,
      candleCount: candles.length,
      startTime: ohlcv.startTime ?? start?.timestamp ?? null,
      endTime: ohlcv.endTime ?? end?.timestamp ?? null,
      durationSec,
      startPriceYPerX: startPrice,
      endPriceYPerX: endPrice,
      returnPct:
        startPrice != null && endPrice != null && startPrice > 0
          ? (endPrice / startPrice - 1) * 100
          : null,
      highLowSpanPct:
        minLow != null && maxHigh != null && minLow > 0
          ? (maxHigh / minLow - 1) * 100
          : null,
      realizedCloseVolPct: standardDeviation(logMoves),
      meanAbsCloseMovePct: mean(absPctMoves),
      medianAbsCloseMovePct: median(absPctMoves),
      p90AbsCloseMovePct: percentile(absPctMoves, 0.9),
      maxAbsCloseMovePct: absPctMoves.length ? Math.max(...absPctMoves) : null,
      meanCandleRangePct: mean(candleRangesPct),
      p75CandleRangePct: percentile(candleRangesPct, 0.75),
      p90CandleRangePct: percentile(candleRangesPct, 0.9),
      maxCandleRangePct: candleRangesPct.length
        ? Math.max(...candleRangesPct)
        : null,
      meanBodyToRangePct: mean(bodyToRangePct),
      meanCloseLocationPct: mean(closeLocationPct),
      trendEfficiency:
        netPct != null && pathPct > 0 ? Math.min(1, netPct / pathPct) : null,
      directionFlips,
      upCandlePct: directions.length ? (up / directions.length) * 100 : null,
      downCandlePct: directions.length
        ? (down / directions.length) * 100
        : null,
      flatCandlePct: directions.length
        ? (flat / directions.length) * 100
        : null,
      totalVolume: volumes.length
        ? volumes.reduce((sum, value) => sum + value, 0)
        : null,
      meanVolume: mean(volumes),
      medianVolume: median(volumes),
      volumeCv: coefficientOfVariation(volumes),
      volumeAbsMoveCorrelation:
        absPctMoves.length && volumes.length > 1
          ? pearson(volumes.slice(1, absPctMoves.length + 1), absPctMoves)
          : null,
      recentToPriorVolumeRatio: ratioOrNull(
        avgVolume(recent),
        avgVolume(prior),
      ),
      recentToPriorRangeRatio: ratioOrNull(
        avgRangePct(recent),
        avgRangePct(prior),
      ),
      recentToPriorVolatilityRatio: ratioOrNull(
        closeVol(recent),
        closeVol(prior),
      ),
      startBin,
      endBin,
      displacementBins:
        startBin != null && endBin != null ? endBin - startBin : null,
      totalSpanBins:
        lowBins.length && highBins.length
          ? Math.max(...highBins) - Math.min(...lowBins)
          : null,
      meanCandleRangeBins: mean(candleRangeBins),
      p75CandleRangeBins: percentile(candleRangeBins, 0.75),
      p90CandleRangeBins: percentile(candleRangeBins, 0.9),
      maxCandleRangeBins: candleRangeBins.length
        ? Math.max(...candleRangeBins)
        : null,
      meanAbsCloseMoveBins: mean(closeMoveBins),
      p90AbsCloseMoveBins: percentile(closeMoveBins, 0.9),
      pathBinsPerMinute:
        durationMin != null && durationMin > 0 ? pathBins / durationMin : null,
      netBinsPerMinute:
        durationMin != null &&
        durationMin > 0 &&
        startBin != null &&
        endBin != null
          ? (endBin - startBin) / durationMin
          : null,
    };
  }

  async getPoolCandleRegime(
    poolAddress: string,
    args: MeteoraOhlcvArgs = {},
  ): Promise<MeteoraCandleRegimeMetrics> {
    const ohlcv = await this.getPoolOhlcv(poolAddress, args);
    return await this.candleRegimeFromOhlcv(poolAddress, ohlcv);
  }

  async getPoolLiquidityDepth(
    poolAddress: string,
    radius = 20,
    refresh = true,
  ): Promise<MeteoraLiquidityDepthMetrics> {
    const normalizedRadius = Math.max(1, Math.min(200, Math.trunc(radius)));
    const pool = await this.rawPool(poolAddress, refresh);
    const active = await pool.getActiveBin();
    const activeBin =
      extractBinId(active) ?? numberOrNull((pool.lbPair as any)?.activeId) ?? 0;
    const activePriceYPerX = Number(
      pool.fromPricePerLamport(Number((active as any).price)),
    );
    const xToken = tokenReserve(pool.tokenX);
    const yToken = tokenReserve(pool.tokenY);
    const around = await pool.getBinsAroundActiveBin(
      normalizedRadius,
      normalizedRadius,
    );
    const rows = rowArray(around);
    const bins = rows
      .map((row) => {
        const binId =
          finiteNumber(row.binId ?? row.id ?? row.bin_id) ?? Number.NaN;
        if (!Number.isInteger(binId)) return null;
        const xRaw = rawField(row, ["xAmount", "amountX", "x_amount"]);
        const yRaw = rawField(row, ["yAmount", "amountY", "y_amount"]);
        const xUi = rawToUi(xRaw, xToken.decimals);
        const yUi = rawToUi(yRaw, yToken.decimals);
        const xValueY =
          xUi == null || !Number.isFinite(activePriceYPerX)
            ? null
            : xUi * activePriceYPerX;
        const totalValueY =
          xValueY == null || yUi == null ? null : xValueY + yUi;
        return {
          binId,
          distanceFromActive: binId - activeBin,
          xRaw,
          yRaw,
          xUi,
          yUi,
          xValueY,
          totalValueY,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row != null)
      .sort((a, b) => a.binId - b.binId);

    const nonEmpty = bins.filter(
      (bin) => bigintOrZero(bin.xRaw) > 0n || bigintOrZero(bin.yRaw) > 0n,
    );
    const valued = bins.filter((bin) => bin.totalValueY != null);
    const lower = valued.filter((bin) => bin.distanceFromActive < 0);
    const activeRows = valued.filter((bin) => bin.distanceFromActive === 0);
    const upper = valued.filter((bin) => bin.distanceFromActive > 0);
    const sumValue = (rowsToSum: typeof valued): number =>
      rowsToSum.reduce((sum, bin) => sum + (bin.totalValueY ?? 0), 0);
    const lowerValueY = valued.length ? sumValue(lower) : null;
    const activeValueY = valued.length ? sumValue(activeRows) : null;
    const upperValueY = valued.length ? sumValue(upper) : null;
    const totalValueY = valued.length ? sumValue(valued) : null;
    const xValueY = valued.length
      ? valued.reduce((sum, bin) => sum + (bin.xValueY ?? 0), 0)
      : null;
    const yValueY = valued.length
      ? valued.reduce((sum, bin) => sum + (bin.yUi ?? 0), 0)
      : null;
    const nearestLower = nonEmpty
      .filter((bin) => bin.distanceFromActive < 0)
      .map((bin) => Math.abs(bin.distanceFromActive));
    const nearestUpper = nonEmpty
      .filter((bin) => bin.distanceFromActive > 0)
      .map((bin) => bin.distanceFromActive);
    const topBinValue = valued.length
      ? Math.max(...valued.map((bin) => bin.totalValueY ?? 0))
      : null;
    const weightedDistanceNumerator = valued.reduce(
      (sum, bin) =>
        sum + Math.abs(bin.distanceFromActive) * (bin.totalValueY ?? 0),
      0,
    );

    return {
      version: 1,
      pool: pool.pubkey.toBase58(),
      radius: normalizedRadius,
      activeBin,
      activePriceYPerX,
      binsSeen: bins.length,
      nonEmptyBins: nonEmpty.length,
      emptyBinPct: bins.length
        ? ((bins.length - nonEmpty.length) / bins.length) * 100
        : null,
      activeBinHasLiquidity: nonEmpty.some(
        (bin) => bin.distanceFromActive === 0,
      ),
      nearestLowerLiquidityBins: nearestLower.length
        ? Math.min(...nearestLower)
        : null,
      nearestUpperLiquidityBins: nearestUpper.length
        ? Math.min(...nearestUpper)
        : null,
      lowerValueY,
      activeValueY,
      upperValueY,
      totalValueY,
      xValueY,
      yValueY,
      xSharePct:
        totalValueY != null && totalValueY > 0 && xValueY != null
          ? (xValueY / totalValueY) * 100
          : null,
      ySharePct:
        totalValueY != null && totalValueY > 0 && yValueY != null
          ? (yValueY / totalValueY) * 100
          : null,
      upperVsLowerValueRatio: ratioOrNull(upperValueY, lowerValueY),
      sideImbalancePct:
        upperValueY != null &&
        lowerValueY != null &&
        upperValueY + lowerValueY > 0
          ? ((upperValueY - lowerValueY) / (upperValueY + lowerValueY)) * 100
          : null,
      topBinValueSharePct:
        totalValueY != null && totalValueY > 0 && topBinValue != null
          ? (topBinValue / totalValueY) * 100
          : null,
      weightedMeanAbsDistanceBins:
        totalValueY != null && totalValueY > 0
          ? weightedDistanceNumerator / totalValueY
          : null,
      bins,
    };
  }

  async getPoolMarketMetrics(
    poolAddress: string,
    args: MeteoraOhlcvArgs & {
      depthRadius?: number;
      oracleTwapWindowsSec?: number[];
      includeOracleObservations?: boolean;
    } = {},
  ): Promise<MeteoraPoolMarketMetrics> {
    const pool = asPublicKey(poolAddress).toBase58();
    const timeframe = args.timeframe ?? "5m";

    // Establish one refreshed pool state first, then reuse the cached pool for
    // the remaining reads to reduce avoidable active-bin skew within this snapshot.
    const state = await this.getPoolState(pool, true);
    const [activeBinSample, oracle, profile, rolling, ohlcv, liquidityDepth] =
      await Promise.all([
        this.getActiveBinSample(pool, false),
        this.getPoolOracleSnapshot(pool, {
          refresh: false,
          twapWindowsSec: args.oracleTwapWindowsSec,
          includeObservations: args.includeOracleObservations ?? false,
        }),
        this.getPoolProfileMetrics(pool),
        this.getPoolRollingMetrics(pool, timeframe),
        this.getPoolOhlcv(pool, args),
        this.getPoolLiquidityDepth(pool, args.depthRadius ?? 20, false),
      ]);
    const candleRegime = await this.candleRegimeFromOhlcv(pool, ohlcv);
    return {
      version: 2,
      observedAt: Date.now(),
      pool,
      state,
      activeBinSample,
      oracle,
      profile,
      rolling,
      ohlcv,
      candleRegime,
      liquidityDepth,
    };
  }

  async getMarketFeatureVector(
    poolAddress: string,
    args: MeteoraMarketFeatureVectorArgs = {},
  ): Promise<MeteoraMarketFeatureVectorV1> {
    const metrics =
      args.marketMetrics ??
      (await this.getPoolMarketMetrics(poolAddress, {
        timeframe: args.timeframe,
        startTime: args.startTime,
        endTime: args.endTime,
        depthRadius: args.depthRadius,
        oracleTwapWindowsSec: args.oracleTwapWindowsSec,
        includeOracleObservations: args.includeOracleObservations,
      }));
    const samples = (args.activeBinSamples ?? []).filter(
      (sample) => sample.pool === metrics.pool,
    );
    const micro =
      samples.length >= 2 ? this.analyzeActiveBinSamples(samples) : null;
    const twap60 =
      metrics.oracle.twaps.find((row) => row.requestedSec === 60) ?? null;
    const twap300 =
      metrics.oracle.twaps.find((row) => row.requestedSec === 300) ?? null;

    const vectorCore = {
      activeTvlUsd: metrics.rolling?.activeTvl ?? null,
      feeActiveTvlPct: metrics.rolling?.feeActiveTvlPct ?? null,
      volumeActiveTvlPct: metrics.rolling?.volumeActiveTvlPct ?? null,
      dynamicFeePct: metrics.activeBinSample.dynamicFeePct,
      candleRangeP90Bins: metrics.candleRegime.p90CandleRangeBins,
      candleCloseMoveP90Bins: metrics.candleRegime.p90AbsCloseMoveBins,
      pathBinsPerMinute:
        micro?.pathBinsPerMinute ?? metrics.candleRegime.pathBinsPerMinute,
      netBinsPerMinute:
        micro?.netBinsPerMinute ?? metrics.candleRegime.netBinsPerMinute,
      trendEfficiency:
        micro?.trendEfficiency ?? metrics.candleRegime.trendEfficiency,
      directionFlips:
        micro?.directionFlips ?? metrics.candleRegime.directionFlips,
      stationaryTimePct: micro?.stationaryTimePct ?? null,
      realizedVolPct:
        micro?.realizedLogVolPct ?? metrics.candleRegime.realizedCloseVolPct,
      moveP90Bins: micro?.p90AbsMovePerChangeBins ?? null,
      dwellP90Sec: micro?.p90DwellSec ?? null,
      spotVsTwap60Bins: twap60?.spotDeviationBins ?? null,
      spotVsTwap300Bins: twap300?.spotDeviationBins ?? null,
      oracleAgeSec: metrics.oracle.latestObservationAgeSec,
      emptyBinPct: metrics.liquidityDepth.emptyBinPct,
      sideImbalancePct: metrics.liquidityDepth.sideImbalancePct,
      concentrationPct: metrics.liquidityDepth.topBinValueSharePct,
    };
    const nonNullFeatureCount = Object.values(vectorCore).filter(
      (value) => value != null && Number.isFinite(Number(value)),
    ).length;

    return {
      schema: METEORA_MARKET_FEATURE_SCHEMA_V1,
      semanticsVersion: 1,
      semanticsHash: METEORA_MARKET_FEATURE_SEMANTICS_HASH_V1,
      semanticsId: "meteora-market-features-v1-20260825",
      observedAtMs: metrics.observedAt,
      pool: metrics.pool,
      slot: metrics.activeBinSample.slot,
      activeBin: metrics.activeBinSample.binId,
      priceYPerX: metrics.activeBinSample.priceYPerX,
      ...vectorCore,
      quality: {
        candleCount: metrics.candleRegime.candleCount,
        microSampleCount: micro?.sampleCount ?? samples.length,
        oracleSupported: metrics.oracle.supported,
        oracleAvailable: metrics.oracle.available,
        oracleTwap60Covered: twap60?.covered ?? null,
        oracleTwap300Covered: twap300?.covered ?? null,
        nonNullFeatureCount,
      },
    };
  }

  async getPoolVolumeHistory(
    poolAddress: string,
    args: {
      timeframe?: MeteoraDiscoverPoolsArgs["timeframe"];
      startTime?: number;
      endTime?: number;
    } = {},
  ): Promise<unknown> {
    const pool = asPublicKey(poolAddress).toBase58();
    return await this.dataApiGet(`/pools/${pool}/volume/history`, {
      timeframe: args.timeframe ?? "24h",
      start_time: args.startTime,
      end_time: args.endTime,
    });
  }

  async listPoolGroups(
    args: {
      page?: number;
      pageSize?: number;
      query?: string;
      sortBy?: string;
      filterBy?: string;
      volumeTw?: string;
      feeTvlRatioTw?: string;
    } = {},
  ): Promise<unknown> {
    return await this.dataApiGet("/pools/groups", {
      page: args.page,
      page_size: args.pageSize,
      query: args.query,
      sort_by: args.sortBy,
      filter_by: args.filterBy,
      volume_tw: args.volumeTw,
      fee_tvl_ratio_tw: args.feeTvlRatioTw,
    });
  }

  async getPoolGroup(
    lexicalOrderMints: string,
    args: {
      page?: number;
      pageSize?: number;
      query?: string;
      sortBy?: string;
      filterBy?: string;
    } = {},
  ): Promise<unknown> {
    const key = lexicalOrderMints.trim();
    if (!key) throw new Error("Meteora lexical_order_mints is required");
    return await this.dataApiGet(`/pools/groups/${encodeURIComponent(key)}`, {
      page: args.page,
      page_size: args.pageSize,
      query: args.query,
      sort_by: args.sortBy,
      filter_by: args.filterBy,
    });
  }

  async getPortfolio(args: {
    user: string | PublicKey;
    page?: number;
    pageSize?: number;
    daysBack?: number;
  }): Promise<unknown> {
    return await this.dataApiGet("/portfolio", {
      user: asPublicKey(args.user).toBase58(),
      page: args.page,
      page_size: args.pageSize,
      days_back: args.daysBack,
    });
  }

  async getOpenPortfolio(args: {
    user: string | PublicKey;
    page?: number;
    pageSize?: number;
    sortDirection?: "asc" | "desc";
    sortBy?: "current_balances" | "unclaimed_fee" | "fee_per_tvl24h";
  }): Promise<unknown> {
    return await this.dataApiGet("/portfolio/open", {
      user: asPublicKey(args.user).toBase58(),
      page: args.page,
      page_size: args.pageSize,
      sort_direction: args.sortDirection,
      sort_by: args.sortBy,
    });
  }

  async getPortfolioTotal(user: string | PublicKey): Promise<unknown> {
    return await this.dataApiGet("/portfolio/total", {
      user: asPublicKey(user).toBase58(),
    });
  }

  async getPositionHistory(
    positionAddress: string,
    args: {
      eventType?: "add" | "remove" | "claim_fee" | "claim_reward";
      orderDirection?: "asc" | "desc";
      page?: number;
      pageSize?: number;
    } = {},
  ): Promise<unknown> {
    const position = asPublicKey(positionAddress).toBase58();
    return await this.dataApiGet(`/positions/${position}/historical`, {
      event_type: args.eventType,
      order_direction: args.orderDirection,
      page: args.page,
      page_size: args.pageSize,
    });
  }

  async getProtocolMetrics(): Promise<unknown> {
    return await this.dataApiGet("/stats/protocol_metrics");
  }

  async getDailyProtocolFees(): Promise<unknown> {
    return await this.dataApiGet("/stats/daily/protocol_fees");
  }

  async getDailyTradingFees(): Promise<unknown> {
    return await this.dataApiGet("/stats/daily/trading_fees");
  }

  async getDailyVolume(): Promise<unknown> {
    return await this.dataApiGet("/stats/daily/volume");
  }

  async getOpenLimitOrderPools(
    wallet: string | PublicKey,
    args: { page?: number; pageSize?: number } = {},
  ): Promise<unknown> {
    const address = asPublicKey(wallet).toBase58();
    return await this.dataApiGet(
      `/wallets/${address}/limit_orders/open/pools`,
      {
        page: args.page,
        page_size: args.pageSize,
      },
    );
  }

  async getOpenLimitOrders(
    wallet: string | PublicKey,
    poolAddress: string,
    args: { page?: number; pageSize?: number } = {},
  ): Promise<unknown> {
    const address = asPublicKey(wallet).toBase58();
    const pool = asPublicKey(poolAddress).toBase58();
    return await this.dataApiGet(
      `/wallets/${address}/limit_orders/open/pools/${pool}`,
      { page: args.page, page_size: args.pageSize },
    );
  }

  async getClosedLimitOrderPools(
    wallet: string | PublicKey,
    args: { page?: number; pageSize?: number } = {},
  ): Promise<unknown> {
    const address = asPublicKey(wallet).toBase58();
    return await this.dataApiGet(
      `/wallets/${address}/limit_orders/closed/pools`,
      {
        page: args.page,
        page_size: args.pageSize,
      },
    );
  }

  async getClosedLimitOrders(
    wallet: string | PublicKey,
    poolAddress: string,
    args: { page?: number; pageSize?: number } = {},
  ): Promise<unknown> {
    const address = asPublicKey(wallet).toBase58();
    const pool = asPublicKey(poolAddress).toBase58();
    return await this.dataApiGet(
      `/wallets/${address}/limit_orders/closed/pools/${pool}`,
      { page: args.page, page_size: args.pageSize },
    );
  }

  async getLimitOrderSummary(wallet: string | PublicKey): Promise<unknown> {
    const address = asPublicKey(wallet).toBase58();
    return await this.dataApiGet(`/wallets/${address}/limit_orders/summary`);
  }

  async getLimitOrderBonusClaimed(
    wallet: string | PublicKey,
    poolAddress: string,
  ): Promise<unknown> {
    const address = asPublicKey(wallet).toBase58();
    const pool = asPublicKey(poolAddress).toBase58();
    return await this.dataApiGet(
      `/wallets/${address}/limit_orders/pools/${pool}/bonus_claimed`,
    );
  }

  async getWalletPoolTotalClaims(
    wallet: string | PublicKey,
    poolAddress: string,
  ): Promise<unknown> {
    const address = asPublicKey(wallet).toBase58();
    const pool = asPublicKey(poolAddress).toBase58();
    return await this.dataApiGet(
      `/wallets/${address}/pools/${pool}/total_claims`,
    );
  }

  async getPositionPnl(args: {
    pool: string;
    wallet: string | PublicKey;
    position?: string;
    status?: "open" | "closed";
  }): Promise<unknown> {
    const pool = asPublicKey(args.pool).toBase58();
    const wallet = asPublicKey(args.wallet).toBase58();
    const body = (await this.dataApiGet(`/positions/${pool}/pnl`, {
      user: wallet,
      status: args.status ?? "open",
      page_size: 100,
      page: 1,
    })) as any;
    if (!args.position) return safeJsonValue(body);
    const rows = body?.positions ?? body?.data ?? [];
    return safeJsonValue(
      rows.find(
        (row: any) =>
          String(row?.positionAddress ?? row?.address ?? row?.position) ===
          args.position,
      ) ?? null,
    );
  }

  private normalizePosition(
    poolAddress: string,
    info: any,
    position: any,
  ): MeteoraPositionSnapshot {
    const data = position?.positionData ?? {};
    const activeBin = numberOrNull(info?.lbPair?.activeId);
    const lowerBin = numberOrNull(data.lowerBinId);
    const upperBin = numberOrNull(data.upperBinId);
    const owner =
      publicKeyString(data.owner) ?? publicKeyString(position?.owner) ?? null;
    return {
      position: publicKeyString(position?.publicKey) ?? "",
      pool: poolAddress,
      owner,
      activeBin,
      lowerBin,
      upperBin,
      inRange:
        activeBin != null && lowerBin != null && upperBin != null
          ? activeBin >= lowerBin && activeBin <= upperBin
          : null,
      tokenX: tokenReserve(info?.tokenX),
      tokenY: tokenReserve(info?.tokenY),
      totalXRaw: integerString(data.totalXAmount),
      totalYRaw: integerString(data.totalYAmount),
      feeXRaw: integerString(data.feeX),
      feeYRaw: integerString(data.feeY),
      claimedFeeXRaw:
        data.totalClaimedFeeXAmount == null
          ? null
          : integerString(data.totalClaimedFeeXAmount),
      claimedFeeYRaw:
        data.totalClaimedFeeYAmount == null
          ? null
          : integerString(data.totalClaimedFeeYAmount),
      rewards: (safeJsonValue(data.rewardInfos ?? data.rewards ?? []) ??
        []) as unknown[],
    };
  }

  async getWalletPositions(
    wallet: string | PublicKey,
  ): Promise<MeteoraWalletPositions> {
    const owner = asPublicKey(wallet);
    const { default: DLMM } = await dlmmSdk();
    const all = await DLMM.getAllLbPairPositionsByUser(
      this.host.connection(),
      owner,
      { cluster: meteoraCluster() },
      { isParallelExecution: true },
    );
    const positions: MeteoraPositionSnapshot[] = [];
    for (const [poolAddress, info] of mapEntries(all as any)) {
      for (const position of (info as any)?.lbPairPositionsData ?? [])
        positions.push(this.normalizePosition(poolAddress, info, position));
    }
    return {
      wallet: owner.toBase58(),
      totalPositions: positions.length,
      positions,
    };
  }

  async getMyPositions(wallet: WalletRef): Promise<MeteoraWalletPositions> {
    return await this.getWalletPositions(this.host.signer(wallet).publicKey);
  }

  async getWalletPositionsForToken(
    wallet: string | PublicKey,
    tokenMint: string | PublicKey,
  ): Promise<MeteoraWalletPositions> {
    const owner = asPublicKey(wallet);
    const token = asPublicKey(tokenMint).toBase58();
    const all = await this.getWalletPositions(owner);
    const positions = all.positions.filter(
      (position) =>
        position.tokenX.mint === token || position.tokenY.mint === token,
    );
    return {
      wallet: owner.toBase58(),
      totalPositions: positions.length,
      positions,
    };
  }

  async getPoolPositions(
    poolAddress: string,
    wallet: string | PublicKey,
  ): Promise<MeteoraPositionSnapshot[]> {
    const pool = await this.rawPool(poolAddress);
    const owner = asPublicKey(wallet);
    const result = await pool.getPositionsByUserAndLbPair(owner, {
      isParallelExecution: true,
    });
    const info = {
      lbPair: pool.lbPair,
      tokenX: pool.tokenX,
      tokenY: pool.tokenY,
    };
    return (result.userPositions ?? []).map((position: any) =>
      this.normalizePosition(pool.pubkey.toBase58(), info, position),
    );
  }

  async getPosition(
    poolAddress: string,
    positionAddress: string,
  ): Promise<MeteoraPositionSnapshot> {
    const pool = await this.rawPool(poolAddress);
    const position = await pool.getPosition(asPublicKey(positionAddress));
    const info = {
      lbPair: pool.lbPair,
      tokenX: pool.tokenX,
      tokenY: pool.tokenY,
    };
    return this.normalizePosition(pool.pubkey.toBase58(), info, position);
  }

  async getPoolWalletSnapshot(
    args: MeteoraPoolWalletSnapshotArgs,
  ): Promise<MeteoraPoolWalletSnapshot> {
    const poolAddress = asPublicKey(args.pool).toBase58();
    const walletAddress = this.resolveWalletAddress(args.wallet);
    const maxDrift = Math.max(
      0,
      Math.trunc(args.consistency?.maxActiveBinDrift ?? 0),
    );
    const attempts = Math.max(
      1,
      Math.min(10, Math.trunc(args.consistency?.attempts ?? 3)),
    );
    const retryDelayMs = Math.max(
      0,
      Math.min(5_000, Math.trunc(args.consistency?.retryDelayMs ?? 150)),
    );
    const requestedPositionIds = [
      ...new Set(
        (args.positionIds ?? []).map((value) => asPublicKey(value).toBase58()),
      ),
    ];

    let last: MeteoraPoolWalletSnapshot | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const activeBefore = await this.getActiveBinSample(poolAddress, true);
      const [allPositions, balances, marketMetrics] = await Promise.all([
        this.getPoolPositions(poolAddress, walletAddress),
        this.getWalletPoolBalances({
          wallet: args.wallet,
          pool: poolAddress,
          commitment: args.commitment,
        }),
        args.includeMarketMetrics
          ? this.getPoolMarketMetrics(poolAddress, args.marketMetrics ?? {})
          : Promise.resolve(null),
      ]);
      const activeAfter = await this.getActiveBinSample(poolAddress, false);
      const drift = Math.abs(activeAfter.binId - activeBefore.binId);
      const selected = requestedPositionIds.length
        ? allPositions.filter((row) =>
            requestedPositionIds.includes(row.position),
          )
        : allPositions;
      const positionsById = Object.fromEntries(
        selected.map((row) => [row.position, row]),
      );
      const missingPositionIds = requestedPositionIds.filter(
        (position) => positionsById[position] == null,
      );
      last = {
        version: 1,
        observedAt: Date.now(),
        wallet: walletAddress,
        pool: poolAddress,
        activeBin: activeAfter.binId,
        priceYPerX: activeAfter.priceYPerX,
        slotBefore: activeBefore.slot,
        slotAfter: activeAfter.slot,
        balances,
        positions: selected,
        positionsById,
        requestedPositionIds,
        missingPositionIds,
        marketMetrics,
        consistency: {
          attempts: attempt,
          activeBinBefore: activeBefore.binId,
          activeBinAfter: activeAfter.binId,
          activeBinDrift: drift,
          maxActiveBinDrift: maxDrift,
          stable: drift <= maxDrift,
        },
      };
      if (drift <= maxDrift) {
        if (args.requireAllPositions && missingPositionIds.length) {
          throw new MeteoraError(
            `Meteora coherent snapshot is missing requested position(s): ${missingPositionIds.join(", ")}`,
            "POSITION_NOT_FOUND",
            { snapshot: last, missingPositionIds },
            true,
          );
        }
        return last;
      }
      if (attempt < attempts && retryDelayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }

    throw new MeteoraError(
      `Meteora pool/wallet snapshot remained inconsistent after ${attempts} attempt(s): active bin moved more than ${maxDrift} bin(s) during every read`,
      "SNAPSHOT_INCONSISTENT",
      { lastSnapshot: last },
      true,
    );
  }

  comparePositionSnapshots(args: {
    initial: MeteoraPositionSnapshot;
    final: MeteoraPositionSnapshot;
    initialPriceYPerX: number;
    finalPriceYPerX: number;
    quoteMint: string | PublicKey;
  }): MeteoraPositionSnapshotComparison {
    const { initial, final } = args;
    if (
      initial.pool !== final.pool ||
      initial.tokenX.mint !== final.tokenX.mint ||
      initial.tokenY.mint !== final.tokenY.mint
    ) {
      throw new MeteoraError(
        "Meteora position snapshots are not comparable: pool/token identity differs",
        "INVALID_ARGUMENT",
        {
          initialPool: initial.pool,
          finalPool: final.pool,
          initialX: initial.tokenX.mint,
          finalX: final.tokenX.mint,
          initialY: initial.tokenY.mint,
          finalY: final.tokenY.mint,
        },
      );
    }
    if (!(args.initialPriceYPerX > 0) || !(args.finalPriceYPerX > 0)) {
      throw new MeteoraError(
        "Meteora snapshot comparison requires positive initial/final Y-per-X prices",
        "INVALID_ARGUMENT",
      );
    }
    const quoteMint = asPublicKey(args.quoteMint).toBase58();
    const quoteSide =
      quoteMint === initial.tokenY.mint
        ? "y"
        : quoteMint === initial.tokenX.mint
          ? "x"
          : null;
    if (!quoteSide) {
      throw new MeteoraError(
        `Quote mint ${quoteMint} is not a pool token`,
        "INVALID_ARGUMENT",
        { quoteMint, tokenX: initial.tokenX.mint, tokenY: initial.tokenY.mint },
      );
    }
    const xDecimals = initial.tokenX.decimals;
    const yDecimals = initial.tokenY.decimals;
    const value = (
      xRaw: string,
      yRaw: string,
      priceYPerX: number,
    ): number | null => {
      const x = rawToUi(xRaw, xDecimals);
      const y = rawToUi(yRaw, yDecimals);
      if (x == null || y == null) return null;
      return quoteSide === "y" ? x * priceYPerX + y : x + y / priceYPerX;
    };
    const initialValueQuote = value(
      initial.totalXRaw,
      initial.totalYRaw,
      args.initialPriceYPerX,
    );
    const finalPrincipalValueQuote = value(
      final.totalXRaw,
      final.totalYRaw,
      args.finalPriceYPerX,
    );
    const feeDeltaX =
      bigintOrZero(final.feeXRaw) > bigintOrZero(initial.feeXRaw)
        ? bigintOrZero(final.feeXRaw) - bigintOrZero(initial.feeXRaw)
        : 0n;
    const feeDeltaY =
      bigintOrZero(final.feeYRaw) > bigintOrZero(initial.feeYRaw)
        ? bigintOrZero(final.feeYRaw) - bigintOrZero(initial.feeYRaw)
        : 0n;
    const feeValueQuote = value(
      feeDeltaX.toString(),
      feeDeltaY.toString(),
      args.finalPriceYPerX,
    );
    const holdValueQuote = value(
      initial.totalXRaw,
      initial.totalYRaw,
      args.finalPriceYPerX,
    );
    const finalValueQuote =
      finalPrincipalValueQuote == null || feeValueQuote == null
        ? null
        : finalPrincipalValueQuote + feeValueQuote;
    const pnlQuote =
      finalValueQuote == null || initialValueQuote == null
        ? null
        : finalValueQuote - initialValueQuote;
    const excessVsHoldQuote =
      finalValueQuote == null || holdValueQuote == null
        ? null
        : finalValueQuote - holdValueQuote;
    const inventoryEffectVsHoldQuote =
      finalPrincipalValueQuote == null || holdValueQuote == null
        ? null
        : finalPrincipalValueQuote - holdValueQuote;
    return {
      version: 1,
      pool: initial.pool,
      quoteMint,
      quoteSide,
      initialValueQuote,
      finalPrincipalValueQuote,
      feeDeltaXRaw: feeDeltaX.toString(),
      feeDeltaYRaw: feeDeltaY.toString(),
      feeValueQuote,
      finalValueQuote,
      pnlQuote,
      returnPct:
        pnlQuote != null && initialValueQuote != null && initialValueQuote > 0
          ? (pnlQuote / initialValueQuote) * 100
          : null,
      holdValueQuote,
      excessVsHoldQuote,
      excessVsHoldPct:
        excessVsHoldQuote != null &&
        holdValueQuote != null &&
        holdValueQuote > 0
          ? (excessVsHoldQuote / holdValueQuote) * 100
          : null,
      inventoryEffectVsHoldQuote,
    };
  }

  async findPoolForPosition(
    positionAddress: string,
    wallet: string | PublicKey,
  ): Promise<string> {
    const positions = await this.getWalletPositions(wallet);
    const found = positions.positions.find(
      (position) => position.position === positionAddress,
    );
    if (!found)
      throw new MeteoraError(
        `Meteora position ${positionAddress} was not found for wallet ${positions.wallet}`,
        "POSITION_NOT_FOUND",
        { position: positionAddress, wallet: positions.wallet },
        true,
      );
    return found.pool;
  }

  private async resolveAmounts(
    pool: DlmmPool,
    args: {
      amountXRaw?: MeteoraInteger;
      amountYRaw?: MeteoraInteger;
      amountX?: MeteoraUiAmount;
      amountY?: MeteoraUiAmount;
    },
  ): Promise<{ x: BN; y: BN }> {
    const xToken = tokenReserve(pool.tokenX);
    const yToken = tokenReserve(pool.tokenY);
    const x =
      args.amountXRaw != null
        ? toBN(args.amountXRaw, "amountXRaw")
        : args.amountX != null
          ? decimalToRaw(args.amountX, xToken.decimals ?? 9)
          : new BN(0);
    const y =
      args.amountYRaw != null
        ? toBN(args.amountYRaw, "amountYRaw")
        : args.amountY != null
          ? decimalToRaw(args.amountY, yToken.decimals ?? 9)
          : new BN(0);
    if (x.isZero() && y.isZero())
      throw new Error("Meteora liquidity amount cannot be zero on both sides");
    return { x, y };
  }

  private async resolveRange(
    pool: DlmmPool,
    args: {
      minBinId?: number;
      maxBinId?: number;
      binsBelow?: number;
      binsAbove?: number;
      downsidePct?: number;
      upsidePct?: number;
    },
  ): Promise<{ minBinId: number; maxBinId: number; activeBinId: number }> {
    const active = await pool.getActiveBin();
    const activeBinId =
      extractBinId(active) ?? numberOrNull((pool.lbPair as any)?.activeId);
    if (activeBinId == null)
      throw new Error("Meteora active bin is unavailable");

    let minBinId = numberOrNull(args.minBinId);
    let maxBinId = numberOrNull(args.maxBinId);

    if (minBinId == null && args.binsBelow != null)
      minBinId = activeBinId - Math.max(0, Math.trunc(args.binsBelow));
    if (maxBinId == null && args.binsAbove != null)
      maxBinId = activeBinId + Math.max(0, Math.trunc(args.binsAbove));

    const activePrice = Number(
      pool.fromPricePerLamport(Number((active as any).price)),
    );
    if (minBinId == null && args.downsidePct != null) {
      const pct = Number(args.downsidePct);
      if (!(pct >= 0 && pct < 100))
        throw new Error("downsidePct must be between 0 and 100");
      const target = activePrice * (1 - pct / 100);
      minBinId = pool.getBinIdFromPrice(
        Number(pool.toPricePerLamport(target)),
        true,
      );
    }
    if (maxBinId == null && args.upsidePct != null) {
      const pct = Number(args.upsidePct);
      if (!(pct >= 0)) throw new Error("upsidePct must be non-negative");
      const target = activePrice * (1 + pct / 100);
      maxBinId = pool.getBinIdFromPrice(
        Number(pool.toPricePerLamport(target)),
        false,
      );
    }

    if (minBinId == null || maxBinId == null)
      throw new Error(
        "Meteora range is required: provide minBinId/maxBinId, binsBelow/binsAbove, or downsidePct/upsidePct",
      );
    if (!Number.isInteger(minBinId) || !Number.isInteger(maxBinId))
      throw new Error("Meteora bin IDs must be integers");
    if (minBinId > maxBinId)
      throw new Error("Meteora minBinId cannot be greater than maxBinId");

    return { minBinId, maxBinId, activeBinId };
  }

  private async quoteInfrastructureForRange(
    pool: DlmmPool,
    minBinId: number,
    maxBinId: number,
    strategy: MeteoraStrategy,
    commitment: Commitment = "confirmed",
  ): Promise<MeteoraInfrastructureQuote> {
    const quoteCreatePosition = (pool as any).quoteCreatePosition;
    if (typeof quoteCreatePosition !== "function") {
      throw new MeteoraError(
        "Meteora infrastructure preflight unavailable: installed @meteora-ag/dlmm does not expose quoteCreatePosition(). Refusing to build a liquidity transaction because shared bin-array funding cannot be proven zero.",
        "SDK_INCOMPATIBLE",
      );
    }
    const sdk = (await dlmmSdk()) as unknown as Record<string, any>;
    const { StrategyType } = sdk as any;
    const strategyType = normalizeStrategy(strategy, StrategyType);
    const rawQuote = await quoteCreatePosition.call(pool, {
      strategy: { minBinId, maxBinId, strategyType },
    });
    const row = (rawQuote ?? {}) as Record<string, unknown>;

    // Current upstream quoteCreatePosition() reports the cost fields in SOL,
    // not lamports. Normalize recoverable rent explicitly at the SDK boundary.
    const positionCount =
      numberOrNull(row.positionCount ?? row.position_count) ?? null;
    const positionCostRaw =
      row.positionCost ??
      row.position_cost ??
      row.positionRent ??
      row.position_rent;
    const reallocCostRaw =
      row.positionReallocCost ??
      row.reallocPositionCost ??
      row.position_realloc_cost ??
      row.realloc_position_cost;
    const quotedPositionRent = meteoraQuotedSolCostToLamports(positionCostRaw);
    const positionFeeLamports = sdkRentConstantLamports(
      sdk,
      "POSITION_FEE_BN",
      "POSITION_FEE",
    );
    const positionCostLamports =
      positionCount != null && positionCount >= 0 && positionFeeLamports != null
        ? BigInt(Math.trunc(positionCount)) * positionFeeLamports
        : quotedPositionRent;
    const positionReallocCostLamports =
      reallocCostRaw == null
        ? 0n
        : meteoraQuotedSolCostToLamports(reallocCostRaw);
    if (positionCostLamports == null || positionReallocCostLamports == null) {
      throw new MeteoraError(
        "Meteora position-rent preflight incompatible: quoteCreatePosition() returned an unrecognized rent schema.",
        "SDK_INCOMPATIBLE",
        { rawQuote: safeJsonValue(rawQuote) },
      );
    }

    const binIdToBinArrayIndex = sdk.binIdToBinArrayIndex;
    const deriveBinArray = sdk.deriveBinArray;
    const deriveBinArrayBitmapExtension = sdk.deriveBinArrayBitmapExtension;
    const isOverflowDefaultBinArrayBitmap = sdk.isOverflowDefaultBinArrayBitmap;
    const programId = (pool as any)?.program?.programId as
      PublicKey | undefined;
    if (
      typeof binIdToBinArrayIndex !== "function" ||
      typeof deriveBinArray !== "function" ||
      typeof isOverflowDefaultBinArrayBitmap !== "function" ||
      !programId
    ) {
      throw new MeteoraError(
        "Meteora infrastructure preflight incompatible: required bin-array coverage helpers are unavailable.",
        "SDK_INCOMPATIBLE",
      );
    }

    // Mirror quoteCreatePosition() coverage exactly: it always considers at least
    // the lower bin array and the immediately following bin array.
    const lowerIndexBn = binIdToBinArrayIndex(new BN(minBinId));
    const rawUpperIndexBn = binIdToBinArrayIndex(new BN(maxBinId));
    const lowerIndex = Number(lowerIndexBn.toString());
    const rawUpperIndex = Number(rawUpperIndexBn.toString());
    const upperIndex = Math.max(rawUpperIndex, lowerIndex + 1);
    const indexes = Array.from(
      { length: upperIndex - lowerIndex + 1 },
      (_, i) => lowerIndex + i,
    );
    const keys = indexes.map((index) => {
      const [key] = deriveBinArray(pool.pubkey, new BN(index), programId) as [
        PublicKey,
        number,
      ];
      return key;
    });
    const infos = keys.length
      ? await this.host.connection().getMultipleAccountsInfo(keys, commitment)
      : [];
    const requiredBinArrays = indexes.map((index, i) => ({
      index,
      address: keys[i]!.toBase58(),
      initialized: infos[i] != null,
    }));
    const missingBinArrays = requiredBinArrays
      .filter((entry) => !entry.initialized)
      .map(({ index, address }) => ({ index, address }));

    const lowerOverflow = Boolean(
      isOverflowDefaultBinArrayBitmap(lowerIndexBn),
    );
    const upperOverflow = Boolean(
      isOverflowDefaultBinArrayBitmap(new BN(upperIndex)),
    );
    const bitmapExtensionRequired = lowerOverflow || upperOverflow;
    let bitmapExtensionAddress: string | null = null;
    let bitmapExtensionInitialized: boolean | null = null;
    if (bitmapExtensionRequired) {
      if (typeof deriveBinArrayBitmapExtension !== "function") {
        throw new MeteoraError(
          "Meteora infrastructure preflight incompatible: bitmap-extension derivation helper is unavailable.",
          "SDK_INCOMPATIBLE",
        );
      }
      const [bitmapKey] = deriveBinArrayBitmapExtension(
        pool.pubkey,
        programId,
      ) as [PublicKey, number];
      bitmapExtensionAddress = bitmapKey.toBase58();
      bitmapExtensionInitialized =
        (await this.host.connection().getAccountInfo(bitmapKey, commitment)) !=
        null;
    }

    const binArrayFeeLamports = sdkRentConstantLamports(
      sdk,
      "BIN_ARRAY_FEE_BN",
      "BIN_ARRAY_FEE",
    );
    const bitmapFeeLamports = sdkRentConstantLamports(
      sdk,
      "BIN_ARRAY_BITMAP_FEE_BN",
      "BIN_ARRAY_BITMAP_FEE",
    );
    if (binArrayFeeLamports == null || bitmapFeeLamports == null) {
      throw new MeteoraError(
        "Meteora infrastructure preflight incompatible: rent constants are unavailable.",
        "SDK_INCOMPATIBLE",
      );
    }
    const binArrayCost = BigInt(missingBinArrays.length) * binArrayFeeLamports;
    const requiresBitmapExtensionInit =
      bitmapExtensionRequired && bitmapExtensionInitialized === false;
    const bitmapExtensionCost = requiresBitmapExtensionInit
      ? bitmapFeeLamports
      : 0n;
    const nonRefundable = binArrayCost + bitmapExtensionCost;
    const txCount =
      numberOrNull(
        row.transactionCount ?? row.transaction_count ?? row.txCount,
      ) ?? null;

    return {
      pool: pool.pubkey.toBase58(),
      minBinId,
      maxBinId,
      strategy,
      binArrayCount: missingBinArrays.length,
      binArrayCostLamports: binArrayCost.toString(),
      bitmapExtensionCostLamports: bitmapExtensionCost.toString(),
      nonRefundableInfrastructureLamports: nonRefundable.toString(),
      positionCostLamports: positionCostLamports.toString(),
      positionReallocCostLamports: positionReallocCostLamports.toString(),
      transactionCount: txCount,
      requiredBinArrays,
      missingBinArrays,
      bitmapExtensionRequired,
      bitmapExtensionAddress,
      bitmapExtensionInitialized,
      requiresBinArrayInit: missingBinArrays.length > 0,
      requiresBitmapExtensionInit,
      requiresNonRefundableInfrastructure: nonRefundable > 0n,
      raw: (safeJsonValue(rawQuote) ?? {}) as Record<string, unknown>,
    };
  }

  async inspectPositionInfrastructure(args: {
    pool: string;
    minBinId: number;
    maxBinId: number;
    strategy?: MeteoraStrategy;
  }): Promise<MeteoraInfrastructureQuote> {
    if (!Number.isInteger(args.minBinId) || !Number.isInteger(args.maxBinId))
      throw new Error("Meteora bin IDs must be integers");
    if (args.minBinId > args.maxBinId)
      throw new Error("Meteora minBinId cannot be greater than maxBinId");
    const pool = await this.rawPool(args.pool, true);
    return await this.quoteInfrastructureForRange(
      pool,
      args.minBinId,
      args.maxBinId,
      args.strategy ?? "spot",
    );
  }

  private async inspectPreparedTransactionsForPreflight(
    prepared: MeteoraPreparedTransactions,
    commitment: Commitment,
  ): Promise<{
    transactionCount: number;
    requiredSignerPubkeys: string[];
    requiredSigners: Array<{
      pubkey: string;
      role: "wallet" | "generated-position" | "unknown";
    }>;
    missingRequiredSignerPubkeys: string[];
    estimatedNetworkFeeLamports: string | null;
    networkFeeEstimateComplete: boolean;
  }> {
    const connection = this.host.connection();
    const wallet = this.host.signer(prepared.wallet);
    const availableSignerPubkeys = new Set(
      [wallet, ...prepared.extraSigners].map((signer) =>
        signer.publicKey.toBase58(),
      ),
    );
    const required = new Set<string>();
    const missing = new Set<string>();
    let feeTotal = 0n;
    let feeComplete = true;
    let latestBlockhash: string | null = null;

    for (const transaction of prepared.transactions) {
      if (isLegacyTransaction(transaction)) {
        if (!transaction.feePayer) transaction.feePayer = wallet.publicKey;
        if (!transaction.recentBlockhash) {
          latestBlockhash ??= (await connection.getLatestBlockhash(commitment))
            .blockhash;
          transaction.recentBlockhash = latestBlockhash;
        }
      }
      const signerKeys = transactionRequiredSignerKeys(transaction);
      for (const key of signerKeys) {
        const text = key.toBase58();
        required.add(text);
        if (!availableSignerPubkeys.has(text)) missing.add(text);
      }
      try {
        const message = isLegacyTransaction(transaction)
          ? transaction.compileMessage()
          : transaction.message;
        const fee = await connection.getFeeForMessage(message, commitment);
        if (fee.value == null) feeComplete = false;
        else feeTotal += BigInt(fee.value);
      } catch {
        feeComplete = false;
      }
    }

    const extra = new Set(
      prepared.extraSigners.map((signer) => signer.publicKey.toBase58()),
    );
    const requiredSignerPubkeys = [...required].sort();
    return {
      transactionCount: prepared.transactions.length,
      requiredSignerPubkeys,
      requiredSigners: requiredSignerPubkeys.map((pubkey) => ({
        pubkey,
        role:
          pubkey === wallet.publicKey.toBase58()
            ? "wallet"
            : extra.has(pubkey)
              ? "generated-position"
              : "unknown",
      })),
      missingRequiredSignerPubkeys: [...missing].sort(),
      estimatedNetworkFeeLamports: feeComplete ? feeTotal.toString() : null,
      networkFeeEstimateComplete: feeComplete,
    };
  }

  async preflightOpenBatch(
    args: MeteoraOpenBatchPreflightArgs,
  ): Promise<MeteoraOpenBatchPreflight> {
    const commitment = args.commitment ?? "confirmed";
    if (!Array.isArray(args.candidates) || args.candidates.length === 0) {
      throw new MeteoraError(
        "preflightOpenBatch requires at least one candidate",
        "INVALID_ARGUMENT",
      );
    }
    const pool = await this.rawPool(args.pool, true);
    const poolAddress = pool.pubkey.toBase58();
    const walletAddress = this.resolveWalletAddress(args.wallet);
    const balances = await this.getWalletPoolBalances({
      wallet: args.wallet,
      pool: poolAddress,
      commitment,
    });
    const availableNativeLamports = BigInt(balances.nativeLamports);
    const nativeReserveLamports =
      args.nativeReserveLamports == null
        ? 0n
        : BigInt(
            toBN(args.nativeReserveLamports, "nativeReserveLamports").toString(
              10,
            ),
          );

    const candidates: MeteoraOpenBatchPreflightCandidate[] = [];
    for (const candidate of args.candidates) {
      const strategy = candidate.strategy ?? "spot";
      const width = candidate.maxBinId - candidate.minBinId + 1;
      let infrastructure: MeteoraInfrastructureQuote | null = null;
      let executable = true;
      let errorCode: MeteoraErrorCode | null = null;
      let errorMessage: string | null = null;
      let requestedAmountXRaw = "0";
      let requestedAmountYRaw = "0";
      let transactionCount: number | null = null;
      let requiredSignerPubkeys: string[] = [];
      let requiredSigners: Array<{
        pubkey: string;
        role: "wallet" | "generated-position" | "unknown";
      }> = [];
      let missingRequiredSignerPubkeys: string[] = [];
      let estimatedNetworkFeeLamports: string | null = null;
      let networkFeeEstimateComplete = false;
      let sharedInfrastructureAuthorized = false;

      try {
        requestedAmountXRaw = toBN(
          candidate.amountXRaw ?? 0,
          `${candidate.id}.amountXRaw`,
        ).toString(10);
        requestedAmountYRaw = toBN(
          candidate.amountYRaw ?? 0,
          `${candidate.id}.amountYRaw`,
        ).toString(10);
      } catch (error) {
        executable = false;
        errorCode = "INVALID_ARGUMENT";
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      if (
        executable &&
        (!Number.isInteger(candidate.minBinId) ||
          !Number.isInteger(candidate.maxBinId) ||
          candidate.minBinId > candidate.maxBinId)
      ) {
        executable = false;
        errorCode = "INVALID_ARGUMENT";
        errorMessage = `invalid range ${candidate.minBinId}..${candidate.maxBinId}`;
      } else if (
        executable &&
        width > STANDARD_POSITION_BINS &&
        (typeof (pool as any).createExtendedEmptyPosition !== "function" ||
          typeof (pool as any).addLiquidityByStrategyChunkable !== "function")
      ) {
        executable = false;
        errorCode = "SDK_INCOMPATIBLE";
        errorMessage = `range width ${width} requires Meteora extended-position support that is unavailable in the installed SDK`;
      }

      if (executable) {
        try {
          infrastructure = await this.quoteInfrastructureForRange(
            pool,
            candidate.minBinId,
            candidate.maxBinId,
            strategy,
            commitment,
          );
          try {
            this.assertInfrastructurePolicy(
              infrastructure,
              candidate.infrastructure ?? args.infrastructure,
            );
            sharedInfrastructureAuthorized =
              infrastructure.requiresNonRefundableInfrastructure;
          } catch {
            sharedInfrastructureAuthorized = false;
          }

          // Autonomous batch preflight is intentionally stricter than the generic
          // builder policy: any missing shared pool infrastructure makes the candidate
          // non-executable. It is reported, never budgeted or silently paid.
          if (infrastructure.requiresNonRefundableInfrastructure) {
            executable = false;
            errorCode = "INFRASTRUCTURE_FUNDING_REQUIRED";
            errorMessage =
              `candidate ${candidate.id} requires persistent Meteora infrastructure: ` +
              `${infrastructure.nonRefundableInfrastructureLamports} lamports`;
          }
        } catch (error) {
          executable = false;
          errorCode = error instanceof MeteoraError ? error.code : "UNKNOWN";
          errorMessage = error instanceof Error ? error.message : String(error);
        }
      }

      // Only safe-zero-infrastructure candidates reach transaction construction.
      // These are unsigned/local-RPC builds: no signatures are produced and nothing
      // is submitted to the network.
      if (executable) {
        try {
          const prepared = await this.buildOpenPosition({
            wallet: args.wallet,
            pool: poolAddress,
            strategy,
            amountXRaw: requestedAmountXRaw,
            amountYRaw: requestedAmountYRaw,
            minBinId: candidate.minBinId,
            maxBinId: candidate.maxBinId,
            slippageBps: candidate.slippageBps,
          });
          const txInspection =
            await this.inspectPreparedTransactionsForPreflight(
              prepared,
              commitment,
            );
          transactionCount = txInspection.transactionCount;
          requiredSignerPubkeys = txInspection.requiredSignerPubkeys;
          requiredSigners = txInspection.requiredSigners;
          missingRequiredSignerPubkeys =
            txInspection.missingRequiredSignerPubkeys;
          estimatedNetworkFeeLamports =
            txInspection.estimatedNetworkFeeLamports;
          networkFeeEstimateComplete = txInspection.networkFeeEstimateComplete;
          if (missingRequiredSignerPubkeys.length) {
            executable = false;
            errorCode = "MISSING_REQUIRED_SIGNER";
            errorMessage =
              `candidate ${candidate.id} requires unavailable signer(s): ` +
              missingRequiredSignerPubkeys.join(", ");
          }
        } catch (error) {
          executable = false;
          errorCode = error instanceof MeteoraError ? error.code : "UNKNOWN";
          errorMessage = error instanceof Error ? error.message : String(error);
        }
      }

      const positionRent =
        infrastructure?.positionCostLamports == null
          ? null
          : BigInt(infrastructure.positionCostLamports);
      const reallocRent =
        infrastructure?.positionReallocCostLamports == null
          ? null
          : BigInt(infrastructure.positionReallocCostLamports);
      const refundablePositionLamports =
        positionRent == null || reallocRent == null
          ? null
          : positionRent + reallocRent;
      const nonRefundableInfrastructureLamports =
        infrastructure?.nonRefundableInfrastructureLamports ?? "0";
      const requiresSharedInfrastructure =
        BigInt(nonRefundableInfrastructureLamports) > 0n;

      candidates.push({
        id: String(candidate.id),
        strategy,
        minBinId: candidate.minBinId,
        maxBinId: candidate.maxBinId,
        width,
        positionKind: width > STANDARD_POSITION_BINS ? "extended" : "standard",
        executable,
        errorCode,
        errorMessage,
        infrastructure,
        transactionCount,
        quotedTransactionCount: infrastructure?.transactionCount ?? null,
        requiredSignerPubkeys,
        requiredSigners,
        missingRequiredSignerPubkeys,
        estimatedNetworkFeeLamports,
        networkFeeEstimateComplete,
        positionRentLamports:
          positionRent == null ? null : positionRent.toString(),
        positionReallocRentLamports:
          reallocRent == null ? null : reallocRent.toString(),
        refundablePositionLamports:
          refundablePositionLamports == null
            ? null
            : refundablePositionLamports.toString(),
        positionCostLamports:
          positionRent == null ? null : positionRent.toString(),
        positionReallocCostLamports:
          reallocRent == null ? null : reallocRent.toString(),
        refundablePositionLamportsUpperBound:
          refundablePositionLamports == null
            ? null
            : refundablePositionLamports.toString(),
        nonRefundableInfrastructureLamports,
        nonRefundableInfrastructureLamportsUpperBound:
          nonRefundableInfrastructureLamports,
        requiredBinArrays: infrastructure?.requiredBinArrays ?? [],
        missingBinArrays: infrastructure?.missingBinArrays ?? [],
        bitmapExtensionRequired:
          infrastructure?.requiresBitmapExtensionInit ?? false,
        bitmapExtensionAddress: infrastructure?.bitmapExtensionAddress ?? null,
        bitmapExtensionInitialized:
          infrastructure?.bitmapExtensionInitialized ?? null,
        requiresSharedInfrastructure,
        sharedInfrastructureAuthorized,
        safeWithoutSharedInfrastructureFunding: !requiresSharedInfrastructure,
        requestedAmountXRaw,
        requestedAmountYRaw,
      });
    }

    const executableCandidates = candidates.filter((row) => row.executable);
    const rejectedCandidates = candidates.length - executableCandidates.length;
    const allCandidatesExecutable = rejectedCandidates === 0;
    const allRefundableKnown = executableCandidates.every(
      (row) => row.refundablePositionLamports != null,
    );
    const refundableTotal = allRefundableKnown
      ? executableCandidates.reduce(
          (sum, row) => sum + BigInt(row.refundablePositionLamports ?? "0"),
          0n,
        )
      : null;
    // Report the forbidden infrastructure requirement across all requested
    // candidates, but never include it in executable funding requirements.
    const nonRefundableTotal = candidates.reduce(
      (sum, row) => sum + BigInt(row.nonRefundableInfrastructureLamports),
      0n,
    );
    const networkFeeEstimateComplete = executableCandidates.every(
      (row) => row.networkFeeEstimateComplete,
    );
    const estimatedNetworkFeeTotal = networkFeeEstimateComplete
      ? executableCandidates.reduce(
          (sum, row) => sum + BigInt(row.estimatedNetworkFeeLamports ?? "0"),
          0n,
        )
      : null;
    const requiredNativeExcludingPrincipal =
      refundableTotal == null || estimatedNetworkFeeTotal == null
        ? null
        : refundableTotal + estimatedNetworkFeeTotal + nativeReserveLamports;

    const requestedPrincipalXRaw = executableCandidates.reduce(
      (sum, row) => sum + BigInt(row.requestedAmountXRaw),
      0n,
    );
    const requestedPrincipalYRaw = executableCandidates.reduce(
      (sum, row) => sum + BigInt(row.requestedAmountYRaw),
      0n,
    );
    const requestedWsolPrincipalLamports =
      balances.tokenX.mint === WSOL_MINT
        ? requestedPrincipalXRaw
        : balances.tokenY.mint === WSOL_MINT
          ? requestedPrincipalYRaw
          : 0n;
    const tokenXPrincipalSufficient =
      balances.tokenX.mint === WSOL_MINT ||
      BigInt(balances.tokenXRaw) >= requestedPrincipalXRaw;
    const tokenYPrincipalSufficient =
      balances.tokenY.mint === WSOL_MINT ||
      BigInt(balances.tokenYRaw) >= requestedPrincipalYRaw;
    const maxDeployableWsolPrincipalLamports =
      requiredNativeExcludingPrincipal == null
        ? null
        : availableNativeLamports > requiredNativeExcludingPrincipal
          ? availableNativeLamports - requiredNativeExcludingPrincipal
          : 0n;
    const nativeFundingSufficient =
      maxDeployableWsolPrincipalLamports == null
        ? null
        : maxDeployableWsolPrincipalLamports >= requestedWsolPrincipalLamports;
    const principalFundingSufficient =
      tokenXPrincipalSufficient &&
      tokenYPrincipalSufficient &&
      nativeFundingSufficient === true;
    const requiredNativeIncludingWsol =
      requiredNativeExcludingPrincipal == null
        ? null
        : requiredNativeExcludingPrincipal + requestedWsolPrincipalLamports;
    const suggestedWsolPrincipalScaleBps =
      maxDeployableWsolPrincipalLamports == null
        ? null
        : requestedWsolPrincipalLamports <= 0n
          ? 10_000
          : Number(
              (BigInt(10_000) *
                (maxDeployableWsolPrincipalLamports <
                requestedWsolPrincipalLamports
                  ? maxDeployableWsolPrincipalLamports
                  : requestedWsolPrincipalLamports)) /
                requestedWsolPrincipalLamports,
            );
    const safeToBuild = allCandidatesExecutable;
    const safeToExecute =
      safeToBuild &&
      networkFeeEstimateComplete &&
      principalFundingSufficient &&
      nativeFundingSufficient === true;

    return {
      version: 2,
      observedAt: Date.now(),
      wallet: walletAddress,
      pool: poolAddress,
      safeToBuild,
      principalFundingSufficient,
      safeToExecute,
      safeToExecuteBeforeNetworkFee: safeToExecute,
      availableNativeLamports: availableNativeLamports.toString(),
      balances,
      nativeReserveLamports: nativeReserveLamports.toString(),
      candidates,
      total: {
        executableCandidates: executableCandidates.length,
        rejectedCandidates,
        allCandidatesExecutable,
        networkFeeEstimateComplete,
        refundablePositionLamports:
          refundableTotal == null ? null : refundableTotal.toString(),
        refundablePositionLamportsUpperBound:
          refundableTotal == null ? null : refundableTotal.toString(),
        nonRefundableInfrastructureLamports: nonRefundableTotal.toString(),
        nonRefundableInfrastructureLamportsUpperBound:
          nonRefundableTotal.toString(),
        estimatedNetworkFeeLamports:
          estimatedNetworkFeeTotal == null
            ? null
            : estimatedNetworkFeeTotal.toString(),
        requiredNativeLamportsExcludingPrincipal:
          requiredNativeExcludingPrincipal == null
            ? null
            : requiredNativeExcludingPrincipal.toString(),
        requiredNativeLamportsBeforeNetworkFeeUpperBound:
          requiredNativeExcludingPrincipal == null
            ? null
            : requiredNativeExcludingPrincipal.toString(),
        requestedPrincipalXRaw: requestedPrincipalXRaw.toString(),
        requestedPrincipalYRaw: requestedPrincipalYRaw.toString(),
        requestedWsolPrincipalLamports:
          requestedWsolPrincipalLamports.toString(),
        requiredNativeLamportsIncludingWsolPrincipal:
          requiredNativeIncludingWsol == null
            ? null
            : requiredNativeIncludingWsol.toString(),
        requiredNativeLamportsIncludingWsolPrincipalBeforeNetworkFeeUpperBound:
          requiredNativeIncludingWsol == null
            ? null
            : requiredNativeIncludingWsol.toString(),
        maxDeployableWsolPrincipalLamports:
          maxDeployableWsolPrincipalLamports == null
            ? null
            : maxDeployableWsolPrincipalLamports.toString(),
        suggestedWsolPrincipalScaleBps,
        tokenXPrincipalSufficient,
        tokenYPrincipalSufficient,
        nativeFundingSufficient,
        nativeFundingSufficientBeforeNetworkFee: nativeFundingSufficient,
      },
    };
  }

  private assertInfrastructurePolicy(
    quote: MeteoraSharedInfrastructureQuote,
    policy: MeteoraInfrastructureFundingPolicy | undefined,
  ): void {
    if (!quote.requiresNonRefundableInfrastructure) return;

    const binArrayAllowed =
      !quote.requiresBinArrayInit || policy?.allowBinArrayInit === true;
    const bitmapAllowed =
      !quote.requiresBitmapExtensionInit ||
      policy?.allowBitmapExtensionInit === true;

    if (!binArrayAllowed || !bitmapAllowed) {
      const reasons: string[] = [];
      if (quote.requiresBinArrayInit && !binArrayAllowed)
        reasons.push(
          `bin-array initialization=${quote.binArrayCostLamports} lamports`,
        );
      if (quote.requiresBitmapExtensionInit && !bitmapAllowed)
        reasons.push(
          `bitmap-extension initialization=${quote.bitmapExtensionCostLamports} lamports`,
        );
      const subject =
        quote.kind === "limit-order"
          ? `limit-order bins ${quote.binIds.join(",")}`
          : `liquidity range ${quote.minBinId}..${quote.maxBinId}`;
      throw new MeteoraInfrastructureFundingRequiredError(
        `Meteora build refused: ${subject} requires caller-funded shared infrastructure (${reasons.join(
          ", ",
        )}). This is denied by default. Explicitly opt in with the corresponding infrastructure allow flag and maxNonRefundableLamports. No Meteora transaction was constructed.`,
        quote,
      );
    }

    if (policy?.maxNonRefundableLamports == null) {
      throw new MeteoraInfrastructureFundingRequiredError(
        `Meteora build refused: shared infrastructure was explicitly allowed but maxNonRefundableLamports was not provided. A hard expenditure cap is required.`,
        quote,
      );
    }
    const maximum = BigInt(
      toBN(
        policy.maxNonRefundableLamports,
        "maxNonRefundableLamports",
      ).toString(10),
    );
    const required = BigInt(quote.nonRefundableInfrastructureLamports);
    if (required > maximum) {
      throw new MeteoraInfrastructureFundingRequiredError(
        `Meteora build refused: shared infrastructure requires ${required} lamports, exceeding maxNonRefundableLamports=${maximum}. No Meteora transaction was constructed.`,
        quote,
      );
    }
  }

  private infrastructurePreflight(
    quote: MeteoraSharedInfrastructureQuote,
    policy: MeteoraInfrastructureFundingPolicy | undefined,
  ): MeteoraInfrastructurePreflight {
    return {
      checked: true,
      quote,
      authorization: {
        allowBinArrayInit: policy?.allowBinArrayInit === true,
        allowBitmapExtensionInit: policy?.allowBitmapExtensionInit === true,
        maxNonRefundableLamports:
          policy?.maxNonRefundableLamports == null
            ? null
            : toBN(
                policy.maxNonRefundableLamports,
                "maxNonRefundableLamports",
              ).toString(10),
      },
    };
  }

  private async assertLimitOrderSupported(pool: DlmmPool): Promise<void> {
    const sdk = (await dlmmSdk()) as any;
    const checker = sdk?.isSupportLimitOrder;
    if (typeof checker !== "function") {
      throw new MeteoraError(
        "Installed @meteora-ag/dlmm does not expose isSupportLimitOrder(); refusing native limit-order operations because pool capability cannot be proven.",
        "SDK_INCOMPATIBLE",
        { pool: pool.pubkey.toBase58() },
      );
    }
    if (!checker((pool as any).lbPair)) {
      throw new MeteoraError(
        `Meteora pool ${pool.pubkey.toBase58()} does not support native limit orders`,
        "LIMIT_ORDER_UNSUPPORTED",
        { pool: pool.pubkey.toBase58() },
      );
    }
    for (const method of [
      "quoteCreateLimitOrder",
      "placeLimitOrder",
      "getLimitOrder",
      "getLimitOrderByUserAndLbPair",
      "cancelLimitOrder",
      "closeLimitOrderIfEmpty",
    ]) {
      if (typeof (pool as any)[method] !== "function") {
        throw new MeteoraError(
          `Installed @meteora-ag/dlmm is missing ${method}() required for native limit orders`,
          "SDK_INCOMPATIBLE",
          { pool: pool.pubkey.toBase58(), method },
        );
      }
    }
  }

  private async maxBinsPerLimitOrder(): Promise<number> {
    const sdk = (await dlmmSdk()) as any;
    const raw = sdk?.MAX_BIN_PER_LIMIT_ORDER;
    const value = numberOrNull(raw);
    if (value != null && Number.isInteger(value) && value > 0) return value;
    throw new MeteoraError(
      "Installed @meteora-ag/dlmm does not expose MAX_BIN_PER_LIMIT_ORDER; refusing to guess the protocol limit",
      "SDK_INCOMPATIBLE",
    );
  }

  private validateLimitOrderBins(
    bins: MeteoraPlaceLimitOrderArgs["bins"],
    maximum: number,
  ): { binIds: number[]; amounts: BN[]; totalInputRaw: string } {
    if (!Array.isArray(bins) || bins.length < 1 || bins.length > maximum) {
      throw new MeteoraError(
        `Limit order must contain between 1 and ${maximum} bins`,
        "INVALID_ARGUMENT",
        { count: Array.isArray(bins) ? bins.length : null, maximum },
      );
    }
    const binIds: number[] = [];
    const amounts: BN[] = [];
    let total = 0n;
    for (let index = 0; index < bins.length; index += 1) {
      const bin = bins[index]!;
      if (!Number.isInteger(bin.binId)) {
        throw new MeteoraError(
          `Limit-order binIds must be integers (index ${index})`,
          "INVALID_ARGUMENT",
          { index, binId: bin.binId },
        );
      }
      if (index > 0 && bin.binId <= bins[index - 1]!.binId) {
        throw new MeteoraError(
          "Limit-order binIds must be strictly increasing; Solard never reorders amount-to-bin mappings implicitly",
          "INVALID_ARGUMENT",
          { binIds: bins.map((x) => x.binId) },
        );
      }
      const amount = toBN(bin.amountRaw, `bins[${index}].amountRaw`);
      if (amount.lte(new BN(0))) {
        throw new MeteoraError(
          `Limit-order amount must be positive at bin ${bin.binId}`,
          "INVALID_ARGUMENT",
          { binId: bin.binId, amountRaw: amount.toString(10) },
        );
      }
      binIds.push(bin.binId);
      amounts.push(amount);
      total += BigInt(amount.toString(10));
    }
    return { binIds, amounts, totalInputRaw: total.toString() };
  }

  private normalizeLimitOrderSnapshot(
    pool: DlmmPool,
    parsed: unknown,
    exists = true,
  ): MeteoraLimitOrderSnapshot {
    const row = recordOrNull(parsed) ?? {};
    const data = recordOrNull(row.limitOrderData) ?? row;
    const address =
      publicKeyString(row.publicKey) ??
      publicKeyString(row.limitOrder) ??
      publicKeyString(data.publicKey) ??
      "";
    const owner =
      publicKeyString(data.owner) ??
      publicKeyString(data.user) ??
      publicKeyString(data.creator) ??
      null;
    const ask = boolOrNull(data.isAskSide ?? data.askSide ?? data.is_ask_side);
    const side: MeteoraLimitOrderSide | null =
      ask == null ? null : ask ? "ask" : "bid";
    const rawBins =
      (Array.isArray(data.limitOrderBinData) ? data.limitOrderBinData : null) ??
      (Array.isArray(data.bins) ? data.bins : null) ??
      [];
    const bins = rawBins
      .map((entry: unknown) => recordOrNull(entry))
      .filter((entry): entry is Record<string, unknown> => entry != null)
      .map((entry) => {
        const binId = limitOrderBinId(entry);
        if (binId == null) return null;
        const empty = limitOrderBinEmpty(entry);
        return {
          binId,
          empty,
          status: normalizeLimitOrderStatus(entry.status),
          raw: (safeJsonValue(entry) ?? {}) as Record<string, unknown>,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry != null)
      .sort((a, b) => a.binId - b.binId);
    return {
      version: 1,
      observedAt: Date.now(),
      pool: pool.pubkey.toBase58(),
      limitOrder: address,
      exists,
      owner,
      side,
      tokenX: tokenReserve(pool.tokenX),
      tokenY: tokenReserve(pool.tokenY),
      bins,
      openBinIds: bins.filter((bin) => !bin.empty).map((bin) => bin.binId),
      raw: exists
        ? ((safeJsonValue(parsed) ?? {}) as Record<string, unknown>)
        : null,
    };
  }

  async getLimitOrder(
    poolAddress: string,
    limitOrderAddress: string,
  ): Promise<MeteoraLimitOrderSnapshot> {
    const pool = await this.rawPool(poolAddress, true);
    await this.assertLimitOrderSupported(pool);
    const pubkey = asPublicKey(limitOrderAddress);
    const account = await this.host
      .connection()
      .getAccountInfo(pubkey, "confirmed");
    if (!account) {
      return {
        version: 1,
        observedAt: Date.now(),
        pool: pool.pubkey.toBase58(),
        limitOrder: pubkey.toBase58(),
        exists: false,
        owner: null,
        side: null,
        tokenX: tokenReserve(pool.tokenX),
        tokenY: tokenReserve(pool.tokenY),
        bins: [],
        openBinIds: [],
        raw: null,
      };
    }
    try {
      const parsed = await (pool as any).getLimitOrder(pubkey);
      const normalized = this.normalizeLimitOrderSnapshot(pool, parsed, true);
      return { ...normalized, limitOrder: pubkey.toBase58() };
    } catch (cause) {
      throw new MeteoraError(
        `Failed to parse Meteora limit order ${pubkey.toBase58()}`,
        "SDK_INCOMPATIBLE",
        {
          pool: pool.pubkey.toBase58(),
          limitOrder: pubkey.toBase58(),
          cause: safeJsonValue(cause),
        },
        true,
      );
    }
  }

  async getLimitOrdersByWallet(
    poolAddress: string,
    wallet: WalletRef,
  ): Promise<MeteoraLimitOrderSnapshot[]> {
    const pool = await this.rawPool(poolAddress, true);
    await this.assertLimitOrderSupported(pool);
    const owner = asPublicKey(this.resolveWalletAddress(wallet));
    const rows = await (pool as any).getLimitOrderByUserAndLbPair(owner);
    return (Array.isArray(rows) ? rows : []).map((row: unknown) =>
      this.normalizeLimitOrderSnapshot(pool, row, true),
    );
  }

  private async quoteLimitOrderInfrastructure(
    pool: DlmmPool,
    binIds: number[],
  ): Promise<MeteoraLimitOrderInfrastructureQuote> {
    const raw = await (pool as any).quoteCreateLimitOrder({
      bins: binIds.map((id) => ({ id })),
      relativeBin: undefined,
    });
    const binArrayCount = numberOrNull(raw?.binArraysCount);
    // Current upstream quoteCreateLimitOrder() returns all four cost fields in SOL:
    // limitOrderCost is rent/1e9, while binArrayCost and bitmapExtensionCost are
    // count * SOL-denominated constants. Normalize every cost at the Solard boundary.
    const binArrayCostLamports = meteoraQuotedSolCostToLamports(
      raw?.binArrayCost,
    );
    const bitmapExtensionCostLamports = meteoraQuotedSolCostToLamports(
      raw?.bitmapExtensionCost,
    );
    const limitOrderRentLamports = meteoraQuotedSolCostToLamports(
      raw?.limitOrderCost,
    );
    if (
      binArrayCostLamports == null ||
      bitmapExtensionCostLamports == null ||
      limitOrderRentLamports == null
    ) {
      throw new MeteoraError(
        "Meteora quoteCreateLimitOrder returned an invalid cost schema",
        "SDK_INCOMPATIBLE",
        { raw: safeJsonValue(raw) },
      );
    }
    const nonRefundable = binArrayCostLamports + bitmapExtensionCostLamports;
    return {
      kind: "limit-order",
      pool: pool.pubkey.toBase58(),
      binIds: [...binIds],
      minBinId: Math.min(...binIds),
      maxBinId: Math.max(...binIds),
      binArrayCount,
      binArrayCostLamports: binArrayCostLamports.toString(),
      bitmapExtensionCostLamports: bitmapExtensionCostLamports.toString(),
      nonRefundableInfrastructureLamports: nonRefundable.toString(),
      limitOrderRentLamports: limitOrderRentLamports.toString(),
      requiresBinArrayInit:
        binArrayCostLamports > 0n || (binArrayCount ?? 0) > 0,
      requiresBitmapExtensionInit: bitmapExtensionCostLamports > 0n,
      requiresNonRefundableInfrastructure: nonRefundable > 0n,
      raw: (safeJsonValue(raw) ?? {}) as Record<string, unknown>,
    };
  }

  private infrastructurePolicyAuthorized(
    quote: MeteoraSharedInfrastructureQuote,
    policy: MeteoraInfrastructureFundingPolicy | undefined,
  ): boolean {
    try {
      this.assertInfrastructurePolicy(quote, policy);
      return true;
    } catch (error) {
      if (error instanceof MeteoraInfrastructureFundingRequiredError)
        return false;
      throw error;
    }
  }

  async preflightLimitOrder(
    args: MeteoraPlaceLimitOrderArgs,
  ): Promise<MeteoraLimitOrderPreflight> {
    const pool = await this.rawPool(args.pool, true);
    await this.assertLimitOrderSupported(pool);
    const maximum = await this.maxBinsPerLimitOrder();
    const validated = this.validateLimitOrderBins(args.bins, maximum);
    const wallet = asPublicKey(this.resolveWalletAddress(args.wallet));
    const tokenX = tokenReserve(pool.tokenX);
    const tokenY = tokenReserve(pool.tokenY);
    const inputMint = args.side === "ask" ? tokenX.mint : tokenY.mint;
    const balances = await this.getWalletPoolBalances({
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      commitment: "confirmed",
    });
    const inputBalanceRaw =
      args.side === "ask" ? balances.tokenXRaw : balances.tokenYRaw;
    const quote = await this.quoteLimitOrderInfrastructure(
      pool,
      validated.binIds,
    );
    const sharedInfrastructureAuthorized = this.infrastructurePolicyAuthorized(
      quote,
      args.infrastructure,
    );
    const inputIsNative = inputMint === WSOL_MINT;
    const requiredInput = BigInt(validated.totalInputRaw);
    const availableNative = BigInt(balances.nativeLamports);
    const sharedCost = BigInt(quote.nonRefundableInfrastructureLamports);
    const rent = BigInt(quote.limitOrderRentLamports);
    const requiredNative =
      rent + sharedCost + (inputIsNative ? requiredInput : 0n);
    const inputFundingSufficient = inputIsNative
      ? availableNative >=
        requiredInput +
          rent +
          (sharedInfrastructureAuthorized ? sharedCost : 0n)
      : BigInt(inputBalanceRaw) >= requiredInput;
    const nativeFundingSufficient =
      availableNative >=
      rent +
        (sharedInfrastructureAuthorized ? sharedCost : 0n) +
        (inputIsNative ? requiredInput : 0n);
    const safeWithoutSharedInfrastructureFunding =
      !quote.requiresNonRefundableInfrastructure;
    const executable =
      sharedInfrastructureAuthorized &&
      inputFundingSufficient &&
      nativeFundingSufficient;
    return {
      version: 1,
      observedAt: Date.now(),
      wallet: wallet.toBase58(),
      pool: pool.pubkey.toBase58(),
      side: args.side,
      inputMint,
      inputBalanceRaw,
      totalInputRaw: validated.totalInputRaw,
      binIds: validated.binIds,
      maxBinsPerOrder: maximum,
      quote,
      sharedInfrastructureAuthorized,
      safeWithoutSharedInfrastructureFunding,
      inputFundingSufficient,
      availableNativeLamports: availableNative.toString(),
      requiredNativeLamportsBeforeNetworkFee: requiredNative.toString(),
      executable,
      safeToExecuteBeforeNetworkFee: executable,
      estimatedNetworkFeeLamports: null,
      warnings: inputIsNative
        ? [
            "Input is WSOL/native mint; current Meteora path wraps native SOL, so native funding includes the full order input.",
          ]
        : [],
    };
  }

  async buildPlaceLimitOrder(
    args: MeteoraPlaceLimitOrderArgs,
  ): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    await this.assertLimitOrderSupported(pool);
    const preflight = await this.preflightLimitOrder(args);
    this.assertInfrastructurePolicy(preflight.quote, args.infrastructure);
    if (
      !preflight.inputFundingSufficient ||
      !preflight.safeToExecuteBeforeNetworkFee
    ) {
      throw new MeteoraError(
        `Insufficient funding for Meteora ${args.side} limit order before network fees`,
        "INSUFFICIENT_FUNDS",
        { preflight },
      );
    }
    const wallet = this.host.signer(args.wallet);
    const maximum = await this.maxBinsPerLimitOrder();
    const validated = this.validateLimitOrderBins(args.bins, maximum);
    const limitOrder = Keypair.generate();
    const tx = await (pool as any).placeLimitOrder({
      owner: wallet.publicKey,
      payer: wallet.publicKey,
      sender: wallet.publicKey,
      limitOrder: limitOrder.publicKey,
      params: {
        isAskSide: args.side === "ask",
        relativeBin: null,
        bins: validated.binIds.map((id, index) => ({
          id,
          amount: validated.amounts[index],
        })),
      },
    });
    return {
      kind: "place-limit-order",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      limitOrder: limitOrder.publicKey.toBase58(),
      transactions: asTxArray(tx),
      extraSigners: [limitOrder],
      infrastructurePreflight: this.infrastructurePreflight(
        preflight.quote,
        args.infrastructure,
      ),
      metadata: {
        side: args.side,
        inputMint: preflight.inputMint,
        requestedInputRaw: validated.totalInputRaw,
        binIds: validated.binIds,
        maxBinsPerOrder: preflight.maxBinsPerOrder,
      },
    };
  }

  async buildCancelLimitOrder(
    args: MeteoraCancelLimitOrderArgs,
  ): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    await this.assertLimitOrderSupported(pool);
    const wallet = this.host.signer(args.wallet);
    const snapshot = await this.getLimitOrder(
      pool.pubkey.toBase58(),
      args.limitOrder,
    );
    if (!snapshot.exists) {
      throw new MeteoraError(
        `Meteora limit order ${args.limitOrder} was not found`,
        "LIMIT_ORDER_NOT_FOUND",
        { pool: pool.pubkey.toBase58(), limitOrder: args.limitOrder },
      );
    }
    if (snapshot.owner && snapshot.owner !== wallet.publicKey.toBase58()) {
      throw new MeteoraError(
        `Meteora limit order ${args.limitOrder} is not owned by ${wallet.publicKey.toBase58()}`,
        "OWNER_MISMATCH",
        {
          expectedOwner: wallet.publicKey.toBase58(),
          actualOwner: snapshot.owner,
        },
      );
    }
    const openBins = new Set(snapshot.openBinIds);
    const requested =
      args.binIds == null ? [...snapshot.openBinIds] : [...args.binIds];
    const unique = [...new Set(requested)];
    if (
      unique.length !== requested.length ||
      unique.some((id) => !Number.isInteger(id))
    ) {
      throw new MeteoraError(
        "cancelLimitOrder binIds must be unique integers",
        "INVALID_ARGUMENT",
        { binIds: requested },
      );
    }
    const inactive = unique.filter((id) => !openBins.has(id));
    if (inactive.length) {
      throw new MeteoraError(
        `cancelLimitOrder requested binIds that are not currently open: ${inactive.join(",")}`,
        "INVALID_ARGUMENT",
        { inactiveBinIds: inactive, openBinIds: [...openBins] },
      );
    }
    unique.sort((a, b) => a - b);
    const rentReceiver = args.rentReceiver
      ? asPublicKey(args.rentReceiver)
      : wallet.publicKey;
    const cancelAll = snapshot.openBinIds.every((id) => unique.includes(id));
    const tx = unique.length
      ? await (pool as any).cancelLimitOrder({
          limitOrderPubkey: asPublicKey(args.limitOrder),
          owner: wallet.publicKey,
          rentReceiver,
          binIds: unique,
        })
      : await (pool as any).closeLimitOrderIfEmpty({
          limitOrder: asPublicKey(args.limitOrder),
          owner: wallet.publicKey,
          rentReceiver,
        });
    return {
      kind: unique.length ? "cancel-limit-order" : "close-limit-order",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      limitOrder: asPublicKey(args.limitOrder).toBase58(),
      transactions: asTxArray(tx),
      extraSigners: [],
      metadata: {
        side: snapshot.side,
        requestedCancelBinIds: unique,
        cancelAll,
        expectedClosed: cancelAll || unique.length === 0,
        owner: wallet.publicKey.toBase58(),
        rentReceiver: rentReceiver.toBase58(),
      },
    };
  }

  async buildOpenPosition(
    args: MeteoraOpenPositionArgs,
  ): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const { StrategyType } = await dlmmSdk();
    const strategy = args.strategy ?? "spot";
    const strategyType = normalizeStrategy(strategy, StrategyType);
    const { x, y } = await this.resolveAmounts(pool, args);
    const range = await this.resolveRange(pool, args);
    const infrastructure = await this.quoteInfrastructureForRange(
      pool,
      range.minBinId,
      range.maxBinId,
      strategy,
    );
    this.assertInfrastructurePolicy(infrastructure, args.infrastructure);
    // Generate the position only after the shared-infrastructure gate passes.
    const position = Keypair.generate();
    const slippageBps = Math.max(
      0,
      Math.min(10_000, Math.trunc(args.slippageBps ?? 100)),
    );
    // Meteora liquidity methods take slippage as a percentage, unlike swap
    // quotes which take slippage in BPS. Keep Solard's public API consistently BPS.
    const slippagePct = slippageBps / 100;
    const width = range.maxBinId - range.minBinId + 1;
    let transactions: Array<Transaction | VersionedTransaction>;

    if (
      width > STANDARD_POSITION_BINS &&
      typeof (pool as any).createExtendedEmptyPosition === "function" &&
      typeof (pool as any).addLiquidityByStrategyChunkable === "function"
    ) {
      const create = await (pool as any).createExtendedEmptyPosition(
        range.minBinId,
        range.maxBinId,
        position.publicKey,
        wallet.publicKey,
      );
      const add = await (pool as any).addLiquidityByStrategyChunkable({
        positionPubKey: position.publicKey,
        user: wallet.publicKey,
        totalXAmount: x,
        totalYAmount: y,
        strategy: {
          minBinId: range.minBinId,
          maxBinId: range.maxBinId,
          strategyType,
        },
        slippage: slippagePct,
      });
      transactions = [...asTxArray(create), ...asTxArray(add)];
    } else {
      const built = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: position.publicKey,
        user: wallet.publicKey,
        totalXAmount: x,
        totalYAmount: y,
        strategy: {
          minBinId: range.minBinId,
          maxBinId: range.maxBinId,
          strategyType,
        },
        slippage: slippagePct,
      });
      transactions = asTxArray(built);
    }

    return {
      kind: "open-position",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions,
      extraSigners: [position],
      position: position.publicKey.toBase58(),
      infrastructurePreflight: this.infrastructurePreflight(
        infrastructure,
        args.infrastructure,
      ),
      metadata: {
        strategy,
        minBinId: range.minBinId,
        maxBinId: range.maxBinId,
        activeBinId: range.activeBinId,
        amountXRaw: x.toString(),
        amountYRaw: y.toString(),
        slippageBps,
        infrastructure,
      },
    };
  }

  async buildAddLiquidity(
    args: MeteoraAddLiquidityArgs,
  ): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const positionKey = asPublicKey(args.position);
    const position = await pool.getPosition(positionKey);
    const data = (position as any)?.positionData ?? {};
    const { StrategyType } = await dlmmSdk();
    const strategy = args.strategy ?? "spot";
    const strategyType = normalizeStrategy(strategy, StrategyType);
    const { x, y } = await this.resolveAmounts(pool, args);
    const minBinId =
      numberOrNull(args.minBinId) ?? numberOrNull(data.lowerBinId);
    const maxBinId =
      numberOrNull(args.maxBinId) ?? numberOrNull(data.upperBinId);
    if (minBinId == null || maxBinId == null)
      throw new Error("Could not determine position bin range");
    const infrastructure = await this.quoteInfrastructureForRange(
      pool,
      minBinId,
      maxBinId,
      strategy,
    );
    this.assertInfrastructurePolicy(infrastructure, args.infrastructure);
    const slippageBps = Math.max(
      0,
      Math.min(10_000, Math.trunc(args.slippageBps ?? 100)),
    );
    const slippagePct = slippageBps / 100;

    const method =
      typeof (pool as any).addLiquidityByStrategyChunkable === "function"
        ? (pool as any).addLiquidityByStrategyChunkable.bind(pool)
        : pool.addLiquidityByStrategy.bind(pool);
    const built = await method({
      positionPubKey: positionKey,
      user: wallet.publicKey,
      totalXAmount: x,
      totalYAmount: y,
      strategy: { minBinId, maxBinId, strategyType },
      slippage: slippagePct,
    });

    return {
      kind: "add-liquidity",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      position: positionKey.toBase58(),
      infrastructurePreflight: this.infrastructurePreflight(
        infrastructure,
        args.infrastructure,
      ),
      metadata: {
        strategy,
        minBinId,
        maxBinId,
        amountXRaw: x.toString(),
        amountYRaw: y.toString(),
        slippageBps,
        infrastructure,
      },
    };
  }

  async buildRemoveLiquidity(
    args: MeteoraRemoveLiquidityArgs,
  ): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const positionKey = asPublicKey(args.position);
    const position = await pool.getPosition(positionKey);
    const data = (position as any)?.positionData ?? {};
    const fromBinId =
      numberOrNull(args.fromBinId) ?? numberOrNull(data.lowerBinId);
    const toBinId = numberOrNull(args.toBinId) ?? numberOrNull(data.upperBinId);
    if (fromBinId == null || toBinId == null)
      throw new Error("Could not determine position bin range");
    const bps = Math.trunc(args.bps ?? 10_000);
    if (bps < 1 || bps > 10_000)
      throw new Error("Meteora remove-liquidity bps must be 1..10000");

    const built = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: positionKey,
      fromBinId,
      toBinId,
      bps: new BN(bps),
      shouldClaimAndClose: args.claimAndClose ?? false,
      skipUnwrapSOL: args.skipUnwrapSol ?? false,
    });

    return {
      kind: args.claimAndClose ? "close-position" : "remove-liquidity",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      position: positionKey.toBase58(),
      metadata: {
        bps,
        fromBinId,
        toBinId,
        claimAndClose: args.claimAndClose ?? false,
      },
    };
  }

  async buildClaimFees(
    args: MeteoraPositionActionArgs,
  ): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const position = await pool.getPosition(asPublicKey(args.position));
    const built = await pool.claimSwapFee({
      owner: wallet.publicKey,
      position,
    });
    return {
      kind: "claim-fees",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      position: args.position,
    };
  }

  async buildClaimRewards(
    args: MeteoraPositionActionArgs,
  ): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const position = await pool.getPosition(asPublicKey(args.position));
    const built = await pool.claimLMReward({
      owner: wallet.publicKey,
      position,
    });
    return {
      kind: "claim-rewards",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      position: args.position,
    };
  }

  async buildClaimPositionRewards(
    args: MeteoraPositionActionArgs,
  ): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const position = await pool.getPosition(asPublicKey(args.position));
    const built = await pool.claimAllRewardsByPosition({
      owner: wallet.publicKey,
      position,
    });
    return {
      kind: "claim-position-rewards",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      position: args.position,
    };
  }

  private async poolPositionsForWallet(
    pool: DlmmPool,
    wallet: PublicKey,
  ): Promise<any[]> {
    const { userPositions } = await pool.getPositionsByUserAndLbPair(wallet, {
      isParallelExecution: true,
    });
    if (!userPositions.length)
      throw new Error("No Meteora positions found in this pool");
    return userPositions;
  }

  async buildClaimAllFees(args: {
    wallet: WalletRef;
    pool: string;
  }): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const positions = await this.poolPositionsForWallet(pool, wallet.publicKey);
    const built = await pool.claimAllSwapFee({
      owner: wallet.publicKey,
      positions,
    });
    return {
      kind: "claim-all-fees",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      metadata: { positions: positions.length },
    };
  }

  async buildClaimAllLmRewards(args: {
    wallet: WalletRef;
    pool: string;
  }): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const positions = await this.poolPositionsForWallet(pool, wallet.publicKey);
    const built = await pool.claimAllLMRewards({
      owner: wallet.publicKey,
      positions,
    });
    return {
      kind: "claim-all-lm-rewards",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      metadata: { positions: positions.length },
    };
  }

  async buildClaimAllRewards(args: {
    wallet: WalletRef;
    pool: string;
  }): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const positions = await this.poolPositionsForWallet(pool, wallet.publicKey);
    const built = await pool.claimAllRewards({
      owner: wallet.publicKey,
      positions,
    });
    return {
      kind: "claim-all-rewards",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      metadata: { positions: positions.length },
    };
  }

  async buildClosePosition(
    args: MeteoraPositionActionArgs,
  ): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const positionKey = asPublicKey(args.position);
    const position = await pool.getPosition(positionKey);
    let built:
      | Transaction
      | VersionedTransaction
      | Array<Transaction | VersionedTransaction>;

    if (positionHasLiquidity(position)) {
      const data = (position as any)?.positionData ?? {};
      const fromBinId = numberOrNull(data.lowerBinId);
      const toBinId = numberOrNull(data.upperBinId);
      if (fromBinId == null || toBinId == null)
        throw new Error("Could not determine position bin range");
      built = await pool.removeLiquidity({
        user: wallet.publicKey,
        position: positionKey,
        fromBinId,
        toBinId,
        bps: new BN(10_000),
        shouldClaimAndClose: true,
      });
    } else {
      built = await pool.closePosition({
        owner: wallet.publicKey,
        position,
      });
    }

    return {
      kind: "close-position",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      position: positionKey.toBase58(),
    };
  }

  async quoteSwapExactIn(
    args: Omit<MeteoraSwapExactInArgs, "wallet">,
  ): Promise<MeteoraSwapQuote> {
    const pool = await this.rawPool(args.pool, true);
    const x = tokenReserve(pool.tokenX);
    const y = tokenReserve(pool.tokenY);
    const input = args.swapForY ? x : y;
    const output = args.swapForY ? y : x;
    const amount =
      args.amountInRaw != null
        ? toBN(args.amountInRaw, "amountInRaw")
        : args.amountIn != null
          ? decimalToRaw(args.amountIn, input.decimals ?? 9)
          : null;
    if (!amount || amount.isZero())
      throw new Error("Meteora swap input amount must be positive");
    const slippage = new BN(
      Math.max(0, Math.min(10_000, Math.trunc(args.slippageBps ?? 100))),
    );
    const arrays = await pool.getBinArrayForSwap(args.swapForY);
    const quote = pool.swapQuote(
      amount,
      args.swapForY,
      slippage,
      arrays,
      args.allowPartialFill ?? false,
      args.maxExtraBinArrays,
    ) as any;
    return {
      pool: pool.pubkey.toBase58(),
      swapForY: args.swapForY,
      inputMint: input.mint,
      outputMint: output.mint,
      inAmountRaw: integerString(quote.consumedInAmount ?? amount),
      outAmountRaw: integerString(quote.outAmount),
      minOutAmountRaw: integerString(quote.minOutAmount),
      feeRaw: quote.fee == null ? null : integerString(quote.fee),
      protocolFeeRaw:
        quote.protocolFee == null ? null : integerString(quote.protocolFee),
      priceImpact: quote.priceImpact == null ? null : String(quote.priceImpact),
      endPrice: quote.endPrice == null ? null : String(quote.endPrice),
      binArrays: (quote.binArraysPubkey ?? []).map(
        (value: unknown) => publicKeyString(value) ?? String(value),
      ),
      raw: safeJsonValue(quote),
    };
  }

  async quoteSwapExactOut(
    args: Omit<MeteoraSwapExactOutArgs, "wallet">,
  ): Promise<MeteoraSwapQuote> {
    const pool = await this.rawPool(args.pool, true);
    const x = tokenReserve(pool.tokenX);
    const y = tokenReserve(pool.tokenY);
    const input = args.swapForY ? x : y;
    const output = args.swapForY ? y : x;
    const amount =
      args.amountOutRaw != null
        ? toBN(args.amountOutRaw, "amountOutRaw")
        : args.amountOut != null
          ? decimalToRaw(args.amountOut, output.decimals ?? 9)
          : null;
    if (!amount || amount.isZero())
      throw new Error("Meteora swap output amount must be positive");
    const slippage = new BN(
      Math.max(0, Math.min(10_000, Math.trunc(args.slippageBps ?? 100))),
    );
    const arrays = await pool.getBinArrayForSwap(args.swapForY);
    const quote = pool.swapQuoteExactOut(
      amount,
      args.swapForY,
      slippage,
      arrays,
      args.maxExtraBinArrays,
    ) as any;
    return {
      pool: pool.pubkey.toBase58(),
      swapForY: args.swapForY,
      inputMint: input.mint,
      outputMint: output.mint,
      inAmountRaw: integerString(quote.inAmount),
      outAmountRaw: integerString(quote.outAmount ?? amount),
      maxInAmountRaw: integerString(quote.maxInAmount),
      feeRaw: quote.fee == null ? null : integerString(quote.fee),
      protocolFeeRaw:
        quote.protocolFee == null ? null : integerString(quote.protocolFee),
      priceImpact: quote.priceImpact == null ? null : String(quote.priceImpact),
      endPrice: null,
      binArrays: (quote.binArraysPubkey ?? []).map(
        (value: unknown) => publicKeyString(value) ?? String(value),
      ),
      raw: safeJsonValue(quote),
    };
  }

  async buildSwapExactIn(
    args: MeteoraSwapExactInArgs,
  ): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const quote = await this.quoteSwapExactIn({
      pool: args.pool,
      swapForY: args.swapForY,
      amountInRaw: args.amountInRaw,
      amountIn: args.amountIn,
      slippageBps: args.slippageBps,
      allowPartialFill: args.allowPartialFill,
      maxExtraBinArrays: args.maxExtraBinArrays,
    });
    const x = tokenReserve(pool.tokenX);
    const y = tokenReserve(pool.tokenY);
    const built = await pool.swap({
      inToken: asPublicKey(args.swapForY ? x.mint : y.mint),
      outToken: asPublicKey(args.swapForY ? y.mint : x.mint),
      inAmount: new BN(quote.inAmountRaw, 10),
      minOutAmount: new BN(quote.minOutAmountRaw ?? quote.outAmountRaw, 10),
      lbPair: pool.pubkey,
      user: wallet.publicKey,
      binArraysPubkey: quote.binArrays.map(asPublicKey),
    });
    return {
      kind: "swap-exact-in",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      metadata: {
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        inAmountRaw: quote.inAmountRaw,
        outAmountRaw: quote.outAmountRaw,
        minOutAmountRaw: quote.minOutAmountRaw,
        priceImpact: quote.priceImpact,
      },
    };
  }

  async buildSwapExactOut(
    args: MeteoraSwapExactOutArgs,
  ): Promise<MeteoraPreparedTransactions> {
    const pool = await this.rawPool(args.pool, true);
    const wallet = this.host.signer(args.wallet);
    const quote = await this.quoteSwapExactOut({
      pool: args.pool,
      swapForY: args.swapForY,
      amountOutRaw: args.amountOutRaw,
      amountOut: args.amountOut,
      slippageBps: args.slippageBps,
      maxExtraBinArrays: args.maxExtraBinArrays,
    });
    const x = tokenReserve(pool.tokenX);
    const y = tokenReserve(pool.tokenY);
    const built = await pool.swapExactOut({
      inToken: asPublicKey(args.swapForY ? x.mint : y.mint),
      outToken: asPublicKey(args.swapForY ? y.mint : x.mint),
      outAmount: new BN(quote.outAmountRaw, 10),
      maxInAmount: new BN(quote.maxInAmountRaw ?? quote.inAmountRaw, 10),
      lbPair: pool.pubkey,
      user: wallet.publicKey,
      binArraysPubkey: quote.binArrays.map(asPublicKey),
    });
    return {
      kind: "swap-exact-out",
      wallet: args.wallet,
      pool: pool.pubkey.toBase58(),
      transactions: asTxArray(built),
      extraSigners: [],
      metadata: {
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        inAmountRaw: quote.inAmountRaw,
        maxInAmountRaw: quote.maxInAmountRaw,
        outAmountRaw: quote.outAmountRaw,
        priceImpact: quote.priceImpact,
      },
    };
  }

  private async tokenBalanceSummary(
    owner: PublicKey,
    mint: string,
    commitment: Commitment,
  ): Promise<{ raw: string; accountCount: number }> {
    const response = await this.host
      .connection()
      .getParsedTokenAccountsByOwner(
        owner,
        { mint: asPublicKey(mint) },
        { commitment },
      );
    let total = 0n;
    for (const account of response.value) {
      const amount = (account.account.data as any)?.parsed?.info?.tokenAmount
        ?.amount;
      if (typeof amount === "string" && /^\d+$/.test(amount))
        total += BigInt(amount);
    }
    return { raw: total.toString(), accountCount: response.value.length };
  }

  private async tokenBalanceRaw(
    owner: PublicKey,
    mint: string,
    commitment: Commitment,
  ): Promise<string> {
    return (await this.tokenBalanceSummary(owner, mint, commitment)).raw;
  }

  async getWalletPoolBalances(args: {
    wallet: WalletRef;
    pool: string;
    commitment?: Commitment;
  }): Promise<MeteoraWalletPoolBalances> {
    const commitment = args.commitment ?? "confirmed";
    const pool = await this.rawPool(args.pool, false);
    const tokenX = tokenReserve(pool.tokenX);
    const tokenY = tokenReserve(pool.tokenY);
    const owner = asPublicKey(this.resolveWalletAddress(args.wallet));
    const observedAt = Date.now();
    const [nativeLamports, x, y] = await Promise.all([
      this.host.connection().getBalance(owner, commitment),
      this.tokenBalanceSummary(owner, tokenX.mint, commitment),
      tokenY.mint === tokenX.mint
        ? this.tokenBalanceSummary(owner, tokenX.mint, commitment)
        : this.tokenBalanceSummary(owner, tokenY.mint, commitment),
    ]);
    return {
      version: 1,
      observedAt,
      wallet: owner.toBase58(),
      pool: pool.pubkey.toBase58(),
      nativeLamports: String(nativeLamports),
      tokenX,
      tokenY,
      tokenXRaw: x.raw,
      tokenYRaw: y.raw,
      tokenXAccountCount: x.accountCount,
      tokenYAccountCount: y.accountCount,
    };
  }

  private async walletAccountingSnapshot(
    owner: PublicKey,
    tokenXMint: string,
    tokenYMint: string,
    commitment: Commitment,
  ): Promise<MeteoraWalletAccountingSnapshot> {
    const observedAt = Date.now();
    const [nativeLamports, tokenXRaw, tokenYRaw] = await Promise.all([
      this.host.connection().getBalance(owner, commitment),
      this.tokenBalanceRaw(owner, tokenXMint, commitment),
      tokenYMint === tokenXMint
        ? this.tokenBalanceRaw(owner, tokenXMint, commitment)
        : this.tokenBalanceRaw(owner, tokenYMint, commitment),
    ]);
    return {
      observedAt,
      nativeLamports: String(nativeLamports),
      tokenXRaw,
      tokenYRaw,
    };
  }

  private async positionAccountingSnapshot(
    poolAddress: string,
    positionAddress: string,
    commitment: Commitment,
  ): Promise<MeteoraPositionAccountingSnapshot> {
    const observedAt = Date.now();
    const positionKey = asPublicKey(positionAddress);
    const account = await this.host
      .connection()
      .getAccountInfo(positionKey, commitment);
    if (!account) {
      return {
        observedAt,
        exists: false,
        accountLamports: "0",
        totalXRaw: "0",
        totalYRaw: "0",
        feeXRaw: "0",
        feeYRaw: "0",
      };
    }

    const pool = await this.rawPool(poolAddress, true);
    const position = await pool.getPosition(positionKey);
    const normalized = this.normalizePosition(
      pool.pubkey.toBase58(),
      { lbPair: pool.lbPair, tokenX: pool.tokenX, tokenY: pool.tokenY },
      position,
    );
    return {
      observedAt,
      exists: true,
      accountLamports: String(account.lamports),
      totalXRaw: normalized.totalXRaw,
      totalYRaw: normalized.totalYRaw,
      feeXRaw: normalized.feeXRaw,
      feeYRaw: normalized.feeYRaw,
    };
  }

  private async limitOrderAccountSnapshot(
    limitOrderAddress: string,
    commitment: Commitment,
  ): Promise<{ exists: boolean; accountLamports: string }> {
    const account = await this.host
      .connection()
      .getAccountInfo(asPublicKey(limitOrderAddress), commitment);
    return {
      exists: account != null,
      accountLamports: String(account?.lamports ?? 0),
    };
  }

  private async transactionNetworkFees(
    signatures: string[],
    commitment: Commitment,
  ): Promise<{ lamports: string | null; warnings: string[] }> {
    const warnings: string[] = [];
    let total = 0n;
    const readCommitment: Commitment =
      commitment === "processed" ? "confirmed" : commitment;
    for (const signature of signatures) {
      let fee: number | null = null;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          const tx = await this.host.connection().getTransaction(signature, {
            commitment: readCommitment as "confirmed" | "finalized",
            maxSupportedTransactionVersion: 0,
          });
          if (tx?.meta?.fee != null) {
            fee = tx.meta.fee;
            break;
          }
        } catch (error) {
          lastError = error;
        }
        if (attempt < 3)
          await new Promise((resolve) =>
            setTimeout(resolve, 400 * (attempt + 1)),
          );
      }
      if (fee == null) {
        warnings.push(
          `network-fee-unavailable:${signature}${lastError ? `:${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`,
        );
        return { lamports: null, warnings };
      }
      total += BigInt(fee);
    }
    return { lamports: total.toString(), warnings };
  }

  private async captureExecutionAccountingBefore(
    prepared: MeteoraPreparedTransactions,
    commitment: Commitment,
  ): Promise<MeteoraExecutionAccountingBefore> {
    const pool = await this.rawPool(prepared.pool, true);
    const tokenXMint = tokenReserve(pool.tokenX).mint;
    const tokenYMint = tokenReserve(pool.tokenY).mint;
    if (!tokenXMint || !tokenYMint)
      throw new MeteoraError(
        "Meteora accounting could not resolve pool token mints",
        "SDK_INCOMPATIBLE",
      );
    const wallet = this.host.signer(prepared.wallet).publicKey;
    const [walletSnapshot, positionSnapshot, limitOrderSnapshot] =
      await Promise.all([
        this.walletAccountingSnapshot(
          wallet,
          tokenXMint,
          tokenYMint,
          commitment,
        ),
        prepared.position
          ? this.positionAccountingSnapshot(
              prepared.pool,
              prepared.position,
              commitment,
            )
          : Promise.resolve(null),
        prepared.limitOrder
          ? this.limitOrderAccountSnapshot(prepared.limitOrder, commitment)
          : Promise.resolve(null),
      ]);
    return {
      walletAddress: wallet.toBase58(),
      tokenXMint,
      tokenYMint,
      wallet: walletSnapshot,
      position: positionSnapshot,
      limitOrder: limitOrderSnapshot,
    };
  }

  private async finalizeExecutionAccounting(
    prepared: MeteoraPreparedTransactions,
    commitment: Commitment,
    signatures: string[],
    before: MeteoraExecutionAccountingBefore,
  ): Promise<MeteoraExecutionAccounting> {
    const warnings: string[] = [];
    const owner = asPublicKey(before.walletAddress);
    let afterWallet: MeteoraWalletAccountingSnapshot | null = null;
    let afterPosition: MeteoraPositionAccountingSnapshot | null = null;
    let afterLimitOrder: { exists: boolean; accountLamports: string } | null =
      null;

    try {
      afterWallet = await this.walletAccountingSnapshot(
        owner,
        before.tokenXMint,
        before.tokenYMint,
        commitment,
      );
    } catch (error) {
      warnings.push(
        `post-wallet-accounting-unavailable:${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (prepared.position) {
      try {
        afterPosition = await this.positionAccountingSnapshot(
          prepared.pool,
          prepared.position,
          commitment,
        );
      } catch (error) {
        warnings.push(
          `post-position-accounting-unavailable:${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (prepared.limitOrder) {
      try {
        afterLimitOrder = await this.limitOrderAccountSnapshot(
          prepared.limitOrder,
          commitment,
        );
      } catch (error) {
        warnings.push(
          `post-limit-order-accounting-unavailable:${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const network = await this.transactionNetworkFees(signatures, commitment);
    warnings.push(...network.warnings);

    const bpos = before.position;
    const apos = afterPosition;
    const positionComparable = bpos != null && apos != null;
    const walletComparable = afterWallet != null;
    const tokenXDelta = afterWallet
      ? signedBigintDelta(afterWallet.tokenXRaw, before.wallet.tokenXRaw)
      : null;
    const tokenYDelta = afterWallet
      ? signedBigintDelta(afterWallet.tokenYRaw, before.wallet.tokenYRaw)
      : null;

    const infrastructure = prepared.infrastructurePreflight
      ? {
          quotedNonRefundableLamports:
            prepared.infrastructurePreflight.quote
              .nonRefundableInfrastructureLamports,
          quotedBinArrayLamports:
            prepared.infrastructurePreflight.quote.binArrayCostLamports,
          quotedBitmapExtensionLamports:
            prepared.infrastructurePreflight.quote.bitmapExtensionCostLamports,
          authorizedMaximumLamports:
            prepared.infrastructurePreflight.authorization
              .maxNonRefundableLamports,
          explicitlyAuthorized:
            prepared.infrastructurePreflight.authorization.allowBinArrayInit ||
            prepared.infrastructurePreflight.authorization
              .allowBitmapExtensionInit,
        }
      : null;

    const isSwap =
      prepared.kind === "swap-exact-in" || prepared.kind === "swap-exact-out";
    const inputMint = isSwap ? String(prepared.metadata?.inputMint ?? "") : "";
    const outputMint = isSwap
      ? String(prepared.metadata?.outputMint ?? "")
      : "";
    const deltaForMint = (mint: string): string | null => {
      if (mint === before.tokenXMint) return tokenXDelta;
      if (mint === before.tokenYMint) return tokenYDelta;
      return null;
    };
    const inputDelta = inputMint ? deltaForMint(inputMint) : null;
    const outputDelta = outputMint ? deltaForMint(outputMint) : null;
    const debitMagnitude = (delta: string | null): string | null => {
      if (delta == null) return null;
      const value = BigInt(delta);
      return (value < 0n ? -value : 0n).toString();
    };
    const positiveCredit = (delta: string | null): string | null => {
      if (delta == null) return null;
      const value = BigInt(delta);
      return (value > 0n ? value : 0n).toString();
    };
    const isLimitOrder =
      prepared.kind === "place-limit-order" ||
      prepared.kind === "cancel-limit-order" ||
      prepared.kind === "close-limit-order";
    const limitOrderInputMint = isLimitOrder
      ? String(prepared.metadata?.inputMint ?? "")
      : "";
    const limitOrderInputDelta = limitOrderInputMint
      ? deltaForMint(limitOrderInputMint)
      : null;
    const beforeLimitOrderLamports = before.limitOrder?.accountLamports ?? null;
    const afterLimitOrderLamports = afterLimitOrder?.accountLamports ?? null;
    if (
      isLimitOrder &&
      prepared.kind === "place-limit-order" &&
      limitOrderInputMint === WSOL_MINT
    ) {
      warnings.push(
        "limit-order-wsol-input-debit-not-inferred-from-native-sol: native SOL remains separate from SPL accounting",
      );
    }

    return {
      version: 1,
      complete:
        walletComparable &&
        network.lamports != null &&
        (prepared.position ? positionComparable : true) &&
        (prepared.limitOrder ? afterLimitOrder != null : true),
      wallet: before.walletAddress,
      pool: prepared.pool,
      position: prepared.position ?? null,
      tokenXMint: before.tokenXMint,
      tokenYMint: before.tokenYMint,
      before: {
        wallet: before.wallet,
        position: bpos,
      },
      after: {
        wallet: afterWallet,
        position: afterPosition,
      },
      walletDelta: {
        tokenXRaw: tokenXDelta,
        tokenYRaw: tokenYDelta,
        nativeLamports: afterWallet
          ? signedBigintDelta(
              afterWallet.nativeLamports,
              before.wallet.nativeLamports,
            )
          : null,
      },
      liquidity: {
        requestedDepositXRaw:
          prepared.kind === "open-position" || prepared.kind === "add-liquidity"
            ? integerString(prepared.metadata?.amountXRaw, "0")
            : null,
        requestedDepositYRaw:
          prepared.kind === "open-position" || prepared.kind === "add-liquidity"
            ? integerString(prepared.metadata?.amountYRaw, "0")
            : null,
        preActionPositionXRaw: bpos?.totalXRaw ?? "0",
        preActionPositionYRaw: bpos?.totalYRaw ?? "0",
        postActionPositionXRaw: apos?.totalXRaw ?? null,
        postActionPositionYRaw: apos?.totalYRaw ?? null,
        positionIncreaseXRaw: positionComparable
          ? positiveBigintDelta(apos!.totalXRaw, bpos!.totalXRaw)
          : null,
        positionIncreaseYRaw: positionComparable
          ? positiveBigintDelta(apos!.totalYRaw, bpos!.totalYRaw)
          : null,
        positionDecreaseXRaw: positionComparable
          ? negativeBigintDeltaMagnitude(apos!.totalXRaw, bpos!.totalXRaw)
          : null,
        positionDecreaseYRaw: positionComparable
          ? negativeBigintDeltaMagnitude(apos!.totalYRaw, bpos!.totalYRaw)
          : null,
      },
      positionFees: {
        preActionUnclaimedXRaw: bpos?.feeXRaw ?? null,
        preActionUnclaimedYRaw: bpos?.feeYRaw ?? null,
        postActionUnclaimedXRaw: apos?.feeXRaw ?? null,
        postActionUnclaimedYRaw: apos?.feeYRaw ?? null,
        counterIncreaseXRaw: positionComparable
          ? positiveBigintDelta(apos!.feeXRaw, bpos!.feeXRaw)
          : null,
        counterIncreaseYRaw: positionComparable
          ? positiveBigintDelta(apos!.feeYRaw, bpos!.feeYRaw)
          : null,
        counterDecreaseXRaw: positionComparable
          ? negativeBigintDeltaMagnitude(apos!.feeXRaw, bpos!.feeXRaw)
          : null,
        counterDecreaseYRaw: positionComparable
          ? negativeBigintDeltaMagnitude(apos!.feeYRaw, bpos!.feeYRaw)
          : null,
      },
      positionRent: {
        beforeLamports: bpos?.accountLamports ?? null,
        afterLamports: apos?.accountLamports ?? null,
        lockedLamports: positionComparable
          ? positiveBigintDelta(apos!.accountLamports, bpos!.accountLamports)
          : null,
        returnedLamports: positionComparable
          ? negativeBigintDeltaMagnitude(
              apos!.accountLamports,
              bpos!.accountLamports,
            )
          : null,
      },
      swap: isSwap
        ? {
            inputMint,
            outputMint,
            requestedInputRaw:
              prepared.kind === "swap-exact-in"
                ? integerString(prepared.metadata?.inAmountRaw, "0")
                : integerString(prepared.metadata?.maxInAmountRaw, "0"),
            quotedOutputRaw: integerString(
              prepared.metadata?.outAmountRaw,
              "0",
            ),
            actualInputDebitedRaw: debitMagnitude(inputDelta),
            actualOutputCreditedRaw: positiveCredit(outputDelta),
          }
        : null,
      limitOrder:
        isLimitOrder && prepared.limitOrder
          ? {
              address: prepared.limitOrder,
              side:
                prepared.metadata?.side === "ask" ||
                prepared.metadata?.side === "bid"
                  ? prepared.metadata.side
                  : null,
              inputMint: limitOrderInputMint || null,
              requestedInputRaw:
                prepared.kind === "place-limit-order"
                  ? integerString(prepared.metadata?.requestedInputRaw, "0")
                  : null,
              actualInputDebitedRaw:
                prepared.kind === "place-limit-order" &&
                limitOrderInputMint !== WSOL_MINT
                  ? debitMagnitude(limitOrderInputDelta)
                  : null,
              returnedXRaw:
                prepared.kind === "cancel-limit-order" ||
                prepared.kind === "close-limit-order"
                  ? positiveCredit(tokenXDelta)
                  : null,
              returnedYRaw:
                prepared.kind === "cancel-limit-order" ||
                prepared.kind === "close-limit-order"
                  ? positiveCredit(tokenYDelta)
                  : null,
              beforeAccountLamports: beforeLimitOrderLamports,
              afterAccountLamports: afterLimitOrderLamports,
              rentLockedLamports:
                beforeLimitOrderLamports != null &&
                afterLimitOrderLamports != null
                  ? positiveBigintDelta(
                      afterLimitOrderLamports,
                      beforeLimitOrderLamports,
                    )
                  : null,
              rentReturnedLamports:
                beforeLimitOrderLamports != null &&
                afterLimitOrderLamports != null
                  ? negativeBigintDeltaMagnitude(
                      afterLimitOrderLamports,
                      beforeLimitOrderLamports,
                    )
                  : null,
            }
          : null,
      networkFeeLamports: network.lamports,
      infrastructure,
      warnings,
    };
  }

  private verificationAttempts(options: MeteoraPositionVerificationOptions): {
    attempts: number;
    retryDelayMs: number;
    commitment: Commitment;
  } {
    return {
      attempts: Math.max(1, Math.min(10, Math.trunc(options.attempts ?? 4))),
      retryDelayMs: Math.max(
        0,
        Math.min(5_000, Math.trunc(options.retryDelayMs ?? 400)),
      ),
      commitment: options.commitment ?? "confirmed",
    };
  }

  private async verificationDelay(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private verificationExpectedOwner(wallet?: WalletRef): string | null {
    return wallet == null ? null : this.resolveWalletAddress(wallet);
  }

  private notApplicableVerification(
    prepared: MeteoraPreparedTransactions,
  ): MeteoraPositionVerification {
    return {
      kind: "not-applicable",
      ok: true,
      checkedAt: Date.now(),
      attempts: 0,
      pool: prepared.pool,
      position: prepared.position ?? null,
      expected: { owner: null, minBinId: null, maxBinId: null },
      actual: null,
      checks: {
        accountExists: null,
        accountClosed: null,
        poolMatches: null,
        ownerMatches: null,
        rangeMatches: null,
        absentFromWalletPool: null,
      },
      errors: [],
      warnings: [
        `No standardized position-state verification is defined for Meteora ${prepared.kind}`,
      ],
    };
  }

  private async verifyPositionPresentInternal(
    args: MeteoraVerifyPositionArgs,
    kind: "position-open" | "position-present",
  ): Promise<MeteoraPositionVerification> {
    const poolAddress = asPublicKey(args.pool).toBase58();
    const positionAddress = asPublicKey(args.position).toBase58();
    const positionKey = asPublicKey(positionAddress);
    const expectedOwner = this.verificationExpectedOwner(args.wallet);
    const minBinId = numberOrNull(args.minBinId);
    const maxBinId = numberOrNull(args.maxBinId);
    if ((minBinId == null) !== (maxBinId == null)) {
      throw new Error(
        "Meteora verification requires both minBinId and maxBinId when checking a range",
      );
    }
    if (minBinId != null && maxBinId != null && minBinId > maxBinId) {
      throw new Error("Meteora verification minBinId cannot exceed maxBinId");
    }

    const policy = this.verificationAttempts(args);
    let last: MeteoraPositionVerification | null = null;

    for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
      const errors: string[] = [];
      const warnings: string[] = [];
      let accountExists: boolean | null = null;
      let actual: MeteoraPositionSnapshot | null = null;
      try {
        const info = await this.host
          .connection()
          .getAccountInfo(positionKey, policy.commitment);
        accountExists = info != null;
        if (!accountExists) errors.push("position account does not exist");
      } catch (error) {
        warnings.push(
          `position-account-read-unavailable:${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (accountExists !== false) {
        try {
          const pool = await this.rawPool(poolAddress, true);
          const raw = await pool.getPosition(positionKey);
          const info = {
            lbPair: pool.lbPair,
            tokenX: pool.tokenX,
            tokenY: pool.tokenY,
          };
          actual = this.normalizePosition(pool.pubkey.toBase58(), info, raw);
        } catch (error) {
          errors.push(
            `position-not-readable-in-pool:${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const poolMatches = actual ? actual.pool === poolAddress : null;
      const ownerMatches =
        expectedOwner == null
          ? null
          : actual
            ? actual.owner === expectedOwner
            : null;
      const rangeMatches =
        minBinId == null || maxBinId == null
          ? null
          : actual
            ? actual.lowerBin === minBinId && actual.upperBin === maxBinId
            : null;

      if (poolMatches === false)
        errors.push("position pool does not match expectation");
      if (ownerMatches === false)
        errors.push("position owner does not match expectation");
      if (rangeMatches === false) {
        errors.push(
          `position range does not match expectation: expected ${minBinId}..${maxBinId}, got ${actual?.lowerBin ?? "?"}..${actual?.upperBin ?? "?"}`,
        );
      }

      const ok =
        accountExists === true &&
        actual != null &&
        poolMatches === true &&
        ownerMatches !== false &&
        rangeMatches !== false;

      last = {
        kind,
        ok,
        checkedAt: Date.now(),
        attempts: attempt,
        pool: poolAddress,
        position: positionAddress,
        expected: { owner: expectedOwner, minBinId, maxBinId },
        actual,
        checks: {
          accountExists,
          accountClosed: accountExists == null ? null : !accountExists,
          poolMatches,
          ownerMatches,
          rangeMatches,
          absentFromWalletPool: null,
        },
        errors,
        warnings,
      };
      if (ok) return last;
      if (attempt < policy.attempts)
        await this.verificationDelay(policy.retryDelayMs);
    }

    return last!;
  }

  async verifyPositionOpen(
    args: MeteoraVerifyPositionArgs,
  ): Promise<MeteoraPositionVerification> {
    return await this.verifyPositionPresentInternal(args, "position-open");
  }

  async verifyPositionRange(
    args: MeteoraVerifyPositionArgs & { minBinId: number; maxBinId: number },
  ): Promise<MeteoraPositionVerification> {
    return await this.verifyPositionPresentInternal(args, "position-open");
  }

  async verifyPositionPresent(
    args: MeteoraVerifyPositionArgs,
  ): Promise<MeteoraPositionVerification> {
    return await this.verifyPositionPresentInternal(args, "position-present");
  }

  async verifyPositionClosed(
    args: Omit<MeteoraVerifyPositionArgs, "minBinId" | "maxBinId">,
  ): Promise<MeteoraPositionVerification> {
    const poolAddress = asPublicKey(args.pool).toBase58();
    const positionAddress = asPublicKey(args.position).toBase58();
    const positionKey = asPublicKey(positionAddress);
    const expectedOwner = this.verificationExpectedOwner(args.wallet);
    const policy = this.verificationAttempts(args);
    let last: MeteoraPositionVerification | null = null;

    for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
      const errors: string[] = [];
      const warnings: string[] = [];
      let accountExists: boolean | null = null;
      let actual: MeteoraPositionSnapshot | null = null;
      let absentFromWalletPool: boolean | null = null;

      try {
        const info = await this.host
          .connection()
          .getAccountInfo(positionKey, policy.commitment);
        accountExists = info != null;
      } catch (error) {
        warnings.push(
          `position-account-read-unavailable:${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (accountExists === true) {
        try {
          const pool = await this.rawPool(poolAddress, true);
          const raw = await pool.getPosition(positionKey);
          const info = {
            lbPair: pool.lbPair,
            tokenX: pool.tokenX,
            tokenY: pool.tokenY,
          };
          actual = this.normalizePosition(pool.pubkey.toBase58(), info, raw);
        } catch (error) {
          warnings.push(
            `position-present-but-not-readable:${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (args.wallet != null) {
        try {
          const walletAddress = this.resolveWalletAddress(args.wallet);
          const positions = await this.getPoolPositions(
            poolAddress,
            walletAddress,
          );
          absentFromWalletPool = !positions.some(
            (position) => position.position === positionAddress,
          );
        } catch (error) {
          warnings.push(
            `wallet-pool-position-read-unavailable:${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const accountClosed = accountExists == null ? null : !accountExists;
      const poolMatches = actual ? actual.pool === poolAddress : null;
      const ownerMatches =
        expectedOwner == null
          ? null
          : actual
            ? actual.owner === expectedOwner
            : null;
      const ok = accountClosed === true;
      if (!ok && accountExists === true)
        errors.push("position account still exists");
      if (absentFromWalletPool === false) {
        if (accountClosed === true)
          warnings.push(
            "position-account-is-closed-but-wallet-pool-read-still-lists-it",
          );
        else errors.push("position still appears in wallet pool positions");
      }

      last = {
        kind: "position-closed",
        ok,
        checkedAt: Date.now(),
        attempts: attempt,
        pool: poolAddress,
        position: positionAddress,
        expected: { owner: expectedOwner, minBinId: null, maxBinId: null },
        actual,
        checks: {
          accountExists,
          accountClosed,
          poolMatches,
          ownerMatches,
          rangeMatches: null,
          absentFromWalletPool,
        },
        errors,
        warnings,
      };
      if (ok) return last;
      if (attempt < policy.attempts)
        await this.verificationDelay(policy.retryDelayMs);
    }

    return last!;
  }

  async verifyLimitOrderPlaced(
    args: {
      pool: string;
      limitOrder: string;
      wallet?: WalletRef;
      binIds: number[];
    } & MeteoraPositionVerificationOptions,
  ): Promise<MeteoraLimitOrderVerification> {
    const policy = this.verificationAttempts(args);
    const expectedOwner = this.verificationExpectedOwner(args.wallet);
    const expectedBins = [...new Set(args.binIds)].sort((a, b) => a - b);
    let last: MeteoraLimitOrderVerification | null = null;
    for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
      let actual: MeteoraLimitOrderSnapshot | null = null;
      const errors: string[] = [];
      const warnings: string[] = [];
      try {
        actual = await this.getLimitOrder(args.pool, args.limitOrder);
      } catch (error) {
        errors.push(
          `limit-order-read-failed:${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const accountExists = actual?.exists ?? false;
      const actualBins =
        actual?.bins.map((bin) => bin.binId).sort((a, b) => a - b) ?? [];
      const binsMatch =
        accountExists &&
        actualBins.length === expectedBins.length &&
        actualBins.every((id, index) => id === expectedBins[index]);
      const ownerMatches =
        expectedOwner == null || actual?.owner == null
          ? actual?.owner == null && expectedOwner != null
            ? null
            : true
          : actual.owner === expectedOwner;
      if (!accountExists) errors.push("limit-order-account-missing");
      if (!binsMatch) errors.push("limit-order-bin-set-mismatch");
      if (ownerMatches === false) errors.push("limit-order-owner-mismatch");
      if (ownerMatches == null)
        warnings.push("limit-order-owner-not-exposed-by-installed-sdk-parser");
      const ok = accountExists && binsMatch && ownerMatches !== false;
      last = {
        kind: "limit-order-placed",
        ok,
        checkedAt: Date.now(),
        attempts: attempt,
        pool: asPublicKey(args.pool).toBase58(),
        limitOrder: asPublicKey(args.limitOrder).toBase58(),
        expected: { owner: expectedOwner, binIds: expectedBins, closed: false },
        actual,
        checks: {
          accountExists,
          accountClosed: accountExists ? false : null,
          ownerMatches,
          binsMatch,
          requestedBinsCancelled: null,
        },
        errors,
        warnings,
      };
      if (ok) return last;
      if (attempt < policy.attempts)
        await this.verificationDelay(policy.retryDelayMs);
    }
    return last!;
  }

  async verifyLimitOrderCancelled(
    args: {
      pool: string;
      limitOrder: string;
      wallet?: WalletRef;
      cancelledBinIds: number[];
      expectClosed: boolean;
    } & MeteoraPositionVerificationOptions,
  ): Promise<MeteoraLimitOrderVerification> {
    const policy = this.verificationAttempts(args);
    const expectedOwner = this.verificationExpectedOwner(args.wallet);
    const cancelled = [...new Set(args.cancelledBinIds)].sort((a, b) => a - b);
    const orderKey = asPublicKey(args.limitOrder);
    let last: MeteoraLimitOrderVerification | null = null;
    for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
      const errors: string[] = [];
      const warnings: string[] = [];
      const account = await this.host
        .connection()
        .getAccountInfo(orderKey, policy.commitment);
      const accountClosed = account == null;
      let actual: MeteoraLimitOrderSnapshot | null = null;
      if (!accountClosed) {
        try {
          actual = await this.getLimitOrder(args.pool, args.limitOrder);
        } catch (error) {
          errors.push(
            `limit-order-read-failed:${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const accountExists = !accountClosed;
      const requestedBinsCancelled = args.expectClosed
        ? accountClosed
        : actual != null
          ? cancelled.every((id) => !actual.openBinIds.includes(id))
          : false;
      const ownerMatches =
        accountClosed || expectedOwner == null
          ? null
          : actual?.owner == null
            ? null
            : actual.owner === expectedOwner;
      if (args.expectClosed && !accountClosed)
        errors.push("limit-order-account-still-open");
      if (!args.expectClosed && !requestedBinsCancelled)
        errors.push("requested-limit-order-bins-still-open");
      if (ownerMatches === false) errors.push("limit-order-owner-mismatch");
      if (!accountClosed && ownerMatches == null && expectedOwner != null)
        warnings.push("limit-order-owner-not-exposed-by-installed-sdk-parser");
      const ok = args.expectClosed
        ? accountClosed
        : requestedBinsCancelled && ownerMatches !== false;
      last = {
        kind: "limit-order-cancelled",
        ok,
        checkedAt: Date.now(),
        attempts: attempt,
        pool: asPublicKey(args.pool).toBase58(),
        limitOrder: orderKey.toBase58(),
        expected: {
          owner: expectedOwner,
          binIds: cancelled,
          closed: args.expectClosed,
        },
        actual,
        checks: {
          accountExists,
          accountClosed,
          ownerMatches,
          binsMatch: null,
          requestedBinsCancelled,
        },
        errors,
        warnings,
      };
      if (ok) return last;
      if (attempt < policy.attempts)
        await this.verificationDelay(policy.retryDelayMs);
    }
    return last!;
  }

  private async verifyPreparedOutcome(
    prepared: MeteoraPreparedTransactions,
    options: MeteoraPositionVerificationOptions = {},
  ): Promise<MeteoraExecutionVerification> {
    if (prepared.limitOrder) {
      if (prepared.kind === "place-limit-order") {
        const binIds = Array.isArray(prepared.metadata?.binIds)
          ? prepared.metadata!.binIds!.map(Number).filter(Number.isInteger)
          : [];
        return await this.verifyLimitOrderPlaced({
          pool: prepared.pool,
          limitOrder: prepared.limitOrder,
          wallet: prepared.wallet,
          binIds,
          ...options,
        });
      }
      if (
        prepared.kind === "cancel-limit-order" ||
        prepared.kind === "close-limit-order"
      ) {
        const cancelledBinIds = Array.isArray(
          prepared.metadata?.requestedCancelBinIds,
        )
          ? prepared
              .metadata!.requestedCancelBinIds!.map(Number)
              .filter(Number.isInteger)
          : [];
        return await this.verifyLimitOrderCancelled({
          pool: prepared.pool,
          limitOrder: prepared.limitOrder,
          wallet: prepared.wallet,
          cancelledBinIds,
          expectClosed: Boolean(prepared.metadata?.expectedClosed),
          ...options,
        });
      }
    }
    if (!prepared.position) return this.notApplicableVerification(prepared);

    const base = {
      pool: prepared.pool,
      position: prepared.position,
      wallet: prepared.wallet,
      ...options,
    };
    if (prepared.kind === "close-position") {
      return await this.verifyPositionClosed(base);
    }

    const minBinId = numberOrNull(prepared.metadata?.minBinId);
    const maxBinId = numberOrNull(prepared.metadata?.maxBinId);
    if (
      (prepared.kind === "open-position" ||
        prepared.kind === "add-liquidity") &&
      minBinId != null &&
      maxBinId != null
    ) {
      return await this.verifyPositionRange({
        ...base,
        minBinId,
        maxBinId,
      });
    }

    if (
      prepared.kind === "open-position" ||
      prepared.kind === "add-liquidity" ||
      prepared.kind === "remove-liquidity" ||
      prepared.kind === "claim-fees" ||
      prepared.kind === "claim-rewards" ||
      prepared.kind === "claim-position-rewards"
    ) {
      return await this.verifyPositionPresent(base);
    }

    return this.notApplicableVerification(prepared);
  }

  private async executePreparedAndVerifyUnlocked(
    prepared: MeteoraPreparedTransactions,
    options: MeteoraExecutionOptions,
    verificationOptions: MeteoraPositionVerificationOptions = {},
  ): Promise<MeteoraExecutionResult> {
    try {
      const result = await this.executePreparedUnlocked(prepared, options);
      const verification = await this.verifyPreparedOutcome(
        prepared,
        verificationOptions,
      );
      const verifiedResult = { ...result, verification };
      if (!verification.ok) {
        throw new MeteoraVerificationError(
          `Meteora ${prepared.kind} transaction(s) confirmed but intended on-chain state could not be verified: ${verification.errors.join("; ") || "verification failed"}`,
          verifiedResult,
        );
      }
      return verifiedResult;
    } catch (error) {
      if (error instanceof MeteoraPartialExecutionError) {
        let verification: MeteoraExecutionVerification;
        try {
          verification = await this.verifyPreparedOutcome(
            prepared,
            verificationOptions,
          );
        } catch (verifyError) {
          verification = prepared.limitOrder
            ? {
                kind:
                  prepared.kind === "place-limit-order"
                    ? "limit-order-placed"
                    : "limit-order-cancelled",
                ok: false,
                checkedAt: Date.now(),
                attempts: 0,
                pool: prepared.pool,
                limitOrder: prepared.limitOrder,
                expected: { owner: null, binIds: [], closed: null },
                actual: null,
                checks: {
                  accountExists: null,
                  accountClosed: null,
                  ownerMatches: null,
                  binsMatch: null,
                  requestedBinsCancelled: null,
                },
                errors: [
                  `verification-after-partial-execution-failed:${verifyError instanceof Error ? verifyError.message : String(verifyError)}`,
                ],
                warnings: [],
              }
            : {
                kind: prepared.position ? "position-present" : "not-applicable",
                ok: false,
                checkedAt: Date.now(),
                attempts: 0,
                pool: prepared.pool,
                position: prepared.position ?? null,
                expected: { owner: null, minBinId: null, maxBinId: null },
                actual: null,
                checks: {
                  accountExists: null,
                  accountClosed: null,
                  poolMatches: null,
                  ownerMatches: null,
                  rangeMatches: null,
                  absentFromWalletPool: null,
                },
                errors: [
                  `verification-after-partial-execution-failed:${verifyError instanceof Error ? verifyError.message : String(verifyError)}`,
                ],
                warnings: [],
              };
        }
        const enriched = { ...error.result, verification };
        throw new MeteoraPartialExecutionError(
          error.message,
          enriched,
          error.cause,
        );
      }
      throw error;
    }
  }

  private async executePreparedUnlocked(
    prepared: MeteoraPreparedTransactions,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    assertLiveTradingEnabled(options);
    if (
      prepared.kind === "open-position" ||
      prepared.kind === "add-liquidity" ||
      prepared.kind === "place-limit-order"
    ) {
      const preflight = prepared.infrastructurePreflight;
      if (!preflight?.checked) {
        throw new MeteoraError(
          `Meteora ${prepared.kind} execution refused: prepared transaction lacks Solard infrastructure preflight attestation. Rebuild it with the current Solard SDK before execution.`,
          "SDK_INCOMPATIBLE",
        );
      }
      this.assertInfrastructurePolicy(preflight.quote, {
        allowBinArrayInit: preflight.authorization.allowBinArrayInit,
        allowBitmapExtensionInit:
          preflight.authorization.allowBitmapExtensionInit,
        maxNonRefundableLamports:
          preflight.authorization.maxNonRefundableLamports ?? undefined,
      });
    }
    if (prepared.transactions.length === 0) {
      throw new MeteoraError(
        `Meteora ${prepared.kind} produced no transactions`,
        "SDK_INCOMPATIBLE",
      );
    }

    const connection = this.host.connection();
    const wallet = this.host.signer(prepared.wallet);
    const signers = uniqueSigners([wallet, ...prepared.extraSigners]);
    const commitment: Commitment = options.commitment ?? "confirmed";
    const signatures: string[] = [];
    // Position-mutating writes are snapshotted before any transaction is sent.
    // If this pre-write accounting read fails, fail closed: no transaction has landed yet.
    const accountingBefore = accountingSupportedKind(prepared.kind)
      ? await this.captureExecutionAccountingBefore(prepared, commitment)
      : null;

    try {
      for (const transaction of prepared.transactions) {
        if (isLegacyTransaction(transaction)) {
          if (!transaction.feePayer) transaction.feePayer = wallet.publicKey;
          if (!transaction.recentBlockhash) {
            transaction.recentBlockhash = (
              await connection.getLatestBlockhash(commitment)
            ).blockhash;
          }
          const requiredSigners = transactionSigners(transaction, signers);
          if (requiredSigners.length)
            transaction.partialSign(...requiredSigners);
        } else {
          const requiredSigners = transactionSigners(transaction, signers);
          if (requiredSigners.length) transaction.sign(requiredSigners);
        }
        assertTransactionFullySigned(transaction);

        if (options.simulate !== false) {
          const simulation = isLegacyTransaction(transaction)
            ? await connection.simulateTransaction(transaction)
            : await connection.simulateTransaction(transaction, {
                sigVerify: false,
              });
          if (simulation.value.err) {
            throw new MeteoraError(
              `Meteora ${prepared.kind} simulation failed: ${JSON.stringify(
                simulation.value.err,
              )}\n${simulation.value.logs?.join("\n") ?? ""}`,
              "SIMULATION_FAILED",
              {
                error: simulation.value.err,
                logs: simulation.value.logs ?? [],
              },
              false,
            );
          }
        }

        const expectedSignature = signedTransactionSignature(transaction);
        let signature: string;
        try {
          signature = await connection.sendRawTransaction(
            transaction.serialize(),
            {
              skipPreflight: options.skipPreflight ?? false,
              preflightCommitment: commitment,
              maxRetries: options.maxRetries,
            },
          );
        } catch (error) {
          if (expectedSignature && transportError(error)) {
            const landed = await recoverSubmittedSignature(
              connection,
              expectedSignature,
              commitment,
            );
            if (landed) {
              signature = expectedSignature;
            } else {
              throw new MeteoraError(
                `Meteora ${prepared.kind} send response was lost and transaction ${expectedSignature} could not be confirmed on-chain: ${error instanceof Error ? error.message : String(error)}`,
                "TRANSACTION_FAILED",
                {
                  expectedSignature,
                  cause: error instanceof Error ? error.message : String(error),
                },
                true,
              );
            }
          } else {
            throw error;
          }
        }

        // From here on the signature may have landed and must never be lost from the result.
        signatures.push(signature);
        try {
          const confirmation = await connection.confirmTransaction(
            signature,
            commitment,
          );
          if (confirmation.value.err) {
            throw new MeteoraError(
              `Meteora ${prepared.kind} transaction ${signature} failed on-chain: ${JSON.stringify(confirmation.value.err)}`,
              "TRANSACTION_FAILED",
              { signature, error: confirmation.value.err },
              false,
            );
          }
        } catch (error) {
          if (!transportError(error)) throw error;
          const landed = await recoverSubmittedSignature(
            connection,
            signature,
            commitment,
          );
          if (!landed) {
            throw new MeteoraError(
              `Meteora ${prepared.kind} transaction ${signature} was submitted but confirmation remained uncertain after a transport error: ${error instanceof Error ? error.message : String(error)}`,
              "TRANSACTION_FAILED",
              {
                signature,
                cause: error instanceof Error ? error.message : String(error),
              },
              true,
            );
          }
        }
      }
    } catch (error) {
      this.clearPoolCache(prepared.pool);
      if (signatures.length > 0) {
        const accounting = accountingBefore
          ? await this.finalizeExecutionAccounting(
              prepared,
              commitment,
              signatures,
              accountingBefore,
            )
          : undefined;
        const result: MeteoraExecutionResult = {
          kind: prepared.kind,
          pool: prepared.pool,
          position: prepared.position,
          limitOrder: prepared.limitOrder,
          signatures: [...signatures],
          ...(accounting ? { accounting } : {}),
        };
        throw new MeteoraPartialExecutionError(
          `Meteora ${prepared.kind} partially executed: ${signatures.length}/${prepared.transactions.length} transaction signature(s) were submitted before failure: ${error instanceof Error ? error.message : String(error)}`,
          result,
          error,
        );
      }
      throw error;
    }

    this.clearPoolCache(prepared.pool);
    const accounting = accountingBefore
      ? await this.finalizeExecutionAccounting(
          prepared,
          commitment,
          signatures,
          accountingBefore,
        )
      : undefined;
    return {
      kind: prepared.kind,
      pool: prepared.pool,
      position: prepared.position,
      limitOrder: prepared.limitOrder,
      signatures,
      ...(accounting ? { accounting } : {}),
    };
  }

  private async buildAndExecuteLocked(
    wallet: WalletRef,
    build: () => Promise<MeteoraPreparedTransactions>,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.withWalletWriteLock(
      wallet,
      async () => await this.executePreparedUnlocked(await build(), options),
    );
  }

  private async buildExecuteVerifyLocked(
    wallet: WalletRef,
    build: () => Promise<MeteoraPreparedTransactions>,
    options: MeteoraExecutionOptions,
    verificationOptions: MeteoraPositionVerificationOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.withWalletWriteLock(
      wallet,
      async () =>
        await this.executePreparedAndVerifyUnlocked(
          await build(),
          options,
          verificationOptions,
        ),
    );
  }

  async executePrepared(
    prepared: MeteoraPreparedTransactions,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.withWalletWriteLock(
      prepared.wallet,
      async () => await this.executePreparedUnlocked(prepared, options),
    );
  }

  async executePreparedAndVerify(
    prepared: MeteoraPreparedTransactions,
    options: MeteoraExecutionOptions,
    verificationOptions: MeteoraPositionVerificationOptions = {},
  ): Promise<MeteoraExecutionResult> {
    return await this.withWalletWriteLock(
      prepared.wallet,
      async () =>
        await this.executePreparedAndVerifyUnlocked(
          prepared,
          options,
          verificationOptions,
        ),
    );
  }

  /**
   * Close one exact source position and reopen a replacement using only the X/Y
   * inventory attributable to that close. No swap is performed, native SOL is
   * never treated as WSOL principal, and fresh wallet token balances are never
   * added to the replacement principal.
   *
   * The close deliberately uses skipUnwrapSol=true so recovered WSOL is observed
   * as an SPL-token delta. This keeps refundable native position rent completely
   * outside principal attribution.
   */
  async movePositionFromSource(
    args: MeteoraMovePositionArgs,
    options: MeteoraExecutionOptions,
    verificationOptions: MeteoraPositionVerificationOptions = {},
  ): Promise<MeteoraMovePositionResult> {
    return await this.withWalletWriteLock(args.wallet, async () => {
      const walletAddress = this.resolveWalletAddress(args.wallet);
      const commitment: Commitment = options.commitment ?? "confirmed";
      const source = await this.getPosition(args.pool, args.position);
      if (
        !source.position ||
        source.position !== asPublicKey(args.position).toBase58()
      ) {
        throw new Error(
          `Meteora source position ${args.position} could not be resolved exactly`,
        );
      }
      if (source.pool !== asPublicKey(args.pool).toBase58()) {
        throw new Error(
          `Meteora source position ${args.position} belongs to pool ${source.pool}, not ${args.pool}`,
        );
      }
      if (source.owner !== walletAddress) {
        throw new Error(
          `Meteora source position ${args.position} owner mismatch: expected ${walletAddress}, received ${source.owner ?? "unknown"}`,
        );
      }

      const sourceAttributableX =
        bigintOrZero(source.totalXRaw) + bigintOrZero(source.feeXRaw);
      const sourceAttributableY =
        bigintOrZero(source.totalYRaw) + bigintOrZero(source.feeYRaw);
      const beforeCloseWallet = await this.walletAccountingSnapshot(
        walletAddress,
        source.tokenX.mint,
        source.tokenY.mint,
        commitment,
      );

      let closeResult: MeteoraExecutionResult;
      try {
        const closePrepared = await this.buildRemoveLiquidity({
          wallet: args.wallet,
          pool: args.pool,
          position: args.position,
          bps: 10_000,
          claimAndClose: true,
          skipUnwrapSol: true,
        });
        closeResult = await this.executePreparedAndVerifyUnlocked(
          closePrepared,
          options,
          verificationOptions,
        );
      } catch (cause) {
        throw new MeteoraMovePositionError({
          message: `Meteora source-only move failed while closing ${args.position}: ${cause instanceof Error ? cause.message : String(cause)}`,
          stage: "close",
          sourcePosition: args.position,
          cause,
        });
      }

      const afterCloseWallet = await this.walletAccountingSnapshot(
        walletAddress,
        source.tokenX.mint,
        source.tokenY.mint,
        commitment,
      );
      const positiveDelta = (afterRaw: string, beforeRaw: string): bigint => {
        const delta = bigintOrZero(afterRaw) - bigintOrZero(beforeRaw);
        return delta > 0n ? delta : 0n;
      };
      const observedRecoveredX = positiveDelta(
        afterCloseWallet.tokenXRaw,
        beforeCloseWallet.tokenXRaw,
      );
      const observedRecoveredY = positiveDelta(
        afterCloseWallet.tokenYRaw,
        beforeCloseWallet.tokenYRaw,
      );
      const eligibleX =
        observedRecoveredX < sourceAttributableX
          ? observedRecoveredX
          : sourceAttributableX;
      const eligibleY =
        observedRecoveredY < sourceAttributableY
          ? observedRecoveredY
          : sourceAttributableY;

      const attribution: MeteoraMoveCapitalAttribution = {
        sourcePosition: source.position,
        principalSource: "source-position-only",
        sourceAttributableXRaw: sourceAttributableX.toString(),
        sourceAttributableYRaw: sourceAttributableY.toString(),
        observedRecoveredXRaw: observedRecoveredX.toString(),
        observedRecoveredYRaw: observedRecoveredY.toString(),
        eligibleReopenXRaw: eligibleX.toString(),
        eligibleReopenYRaw: eligibleY.toString(),
        reopenedXRaw: eligibleX.toString(),
        reopenedYRaw: eligibleY.toString(),
        freshWalletPrincipalXRaw: "0",
        freshWalletPrincipalYRaw: "0",
        nativeSolUsedAsPrincipal: false,
        marketSwapPerformed: false,
        closeUsedSkipUnwrapSol: true,
      };

      if (eligibleX === 0n && eligibleY === 0n) {
        throw new MeteoraMovePositionError({
          message: `Meteora source-only move closed ${args.position}, but no attributable SPL X/Y inventory was recovered for reopening`,
          stage: "reopen",
          sourcePosition: args.position,
          closeResult,
          attribution,
        });
      }

      let openPrepared: MeteoraPreparedTransactions;
      try {
        openPrepared = await this.buildOpenPosition({
          wallet: args.wallet,
          pool: args.pool,
          strategy: args.strategy,
          amountXRaw: eligibleX.toString(),
          amountYRaw: eligibleY.toString(),
          minBinId: args.minBinId,
          maxBinId: args.maxBinId,
          binsBelow: args.binsBelow,
          binsAbove: args.binsAbove,
          downsidePct: args.downsidePct,
          upsidePct: args.upsidePct,
          slippageBps: args.slippageBps,
          infrastructure: args.infrastructure,
        });
        const openResult = await this.executePreparedAndVerifyUnlocked(
          openPrepared,
          options,
          verificationOptions,
        );
        const targetPosition = openResult.position ?? openPrepared.position;
        if (!targetPosition) {
          throw new Error("replacement open returned no position address");
        }
        return {
          version: 1,
          wallet: walletAddress,
          pool: asPublicKey(args.pool).toBase58(),
          sourcePosition: source.position,
          targetPosition,
          sourceSnapshot: source,
          attribution,
          close: closeResult,
          open: openResult,
        };
      } catch (cause) {
        throw new MeteoraMovePositionError({
          message: `Meteora source-only move closed ${args.position} but replacement open failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          stage: "reopen",
          sourcePosition: args.position,
          closeResult,
          attribution,
          cause,
        });
      }
    });
  }

  async openPositionVerifiedRegistered(
    args: MeteoraOpenPositionArgs,
    options: MeteoraExecutionOptions,
    verificationOptions: MeteoraPositionVerificationOptions = {},
    onPreparedPosition?: (position: string) => void,
  ): Promise<MeteoraExecutionResult> {
    return await this.withWalletWriteLock(args.wallet, async () => {
      const prepared = await this.buildOpenPosition(args);
      if (prepared.position) onPreparedPosition?.(prepared.position);
      return await this.executePreparedAndVerifyUnlocked(
        prepared,
        options,
        verificationOptions,
      );
    });
  }

  async placeLimitOrderVerified(
    args: MeteoraPlaceLimitOrderArgs,
    options: MeteoraExecutionOptions,
    verificationOptions: MeteoraPositionVerificationOptions = {},
  ): Promise<MeteoraExecutionResult> {
    return await this.buildExecuteVerifyLocked(
      args.wallet,
      () => this.buildPlaceLimitOrder(args),
      options,
      verificationOptions,
    );
  }

  async cancelLimitOrderVerified(
    args: MeteoraCancelLimitOrderArgs,
    options: MeteoraExecutionOptions,
    verificationOptions: MeteoraPositionVerificationOptions = {},
  ): Promise<MeteoraExecutionResult> {
    return await this.buildExecuteVerifyLocked(
      args.wallet,
      () => this.buildCancelLimitOrder(args),
      options,
      verificationOptions,
    );
  }

  async openPositionVerified(
    args: MeteoraOpenPositionArgs,
    options: MeteoraExecutionOptions,
    verificationOptions: MeteoraPositionVerificationOptions = {},
  ): Promise<MeteoraExecutionResult> {
    return await this.buildExecuteVerifyLocked(
      args.wallet,
      () => this.buildOpenPosition(args),
      options,
      verificationOptions,
    );
  }

  async addLiquidityVerified(
    args: MeteoraAddLiquidityArgs,
    options: MeteoraExecutionOptions,
    verificationOptions: MeteoraPositionVerificationOptions = {},
  ): Promise<MeteoraExecutionResult> {
    return await this.buildExecuteVerifyLocked(
      args.wallet,
      () => this.buildAddLiquidity(args),
      options,
      verificationOptions,
    );
  }

  async removeLiquidityVerified(
    args: MeteoraRemoveLiquidityArgs,
    options: MeteoraExecutionOptions,
    verificationOptions: MeteoraPositionVerificationOptions = {},
  ): Promise<MeteoraExecutionResult> {
    return await this.buildExecuteVerifyLocked(
      args.wallet,
      () => this.buildRemoveLiquidity(args),
      options,
      verificationOptions,
    );
  }

  async closePositionVerified(
    args: MeteoraPositionActionArgs,
    options: MeteoraExecutionOptions,
    verificationOptions: MeteoraPositionVerificationOptions = {},
  ): Promise<MeteoraExecutionResult> {
    return await this.buildExecuteVerifyLocked(
      args.wallet,
      () => this.buildClosePosition(args),
      options,
      verificationOptions,
    );
  }

  async swapExactInVerified(
    args: MeteoraSwapExactInArgs,
    options: MeteoraExecutionOptions,
    verificationOptions: MeteoraPositionVerificationOptions = {},
  ): Promise<MeteoraExecutionResult> {
    return await this.buildExecuteVerifyLocked(
      args.wallet,
      () => this.buildSwapExactIn(args),
      options,
      verificationOptions,
    );
  }

  async swapExactOutVerified(
    args: MeteoraSwapExactOutArgs,
    options: MeteoraExecutionOptions,
    verificationOptions: MeteoraPositionVerificationOptions = {},
  ): Promise<MeteoraExecutionResult> {
    return await this.buildExecuteVerifyLocked(
      args.wallet,
      () => this.buildSwapExactOut(args),
      options,
      verificationOptions,
    );
  }

  async placeLimitOrder(
    args: MeteoraPlaceLimitOrderArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.buildAndExecuteLocked(
      args.wallet,
      () => this.buildPlaceLimitOrder(args),
      options,
    );
  }

  async cancelLimitOrder(
    args: MeteoraCancelLimitOrderArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.buildAndExecuteLocked(
      args.wallet,
      () => this.buildCancelLimitOrder(args),
      options,
    );
  }

  async openPosition(
    args: MeteoraOpenPositionArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.buildAndExecuteLocked(
      args.wallet,
      () => this.buildOpenPosition(args),
      options,
    );
  }

  /** Agent-facing alias matching the deployment vocabulary used by LP agents. */
  async deployPosition(
    args: MeteoraOpenPositionArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.openPosition(args, options);
  }

  async addLiquidity(
    args: MeteoraAddLiquidityArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.buildAndExecuteLocked(
      args.wallet,
      () => this.buildAddLiquidity(args),
      options,
    );
  }

  async removeLiquidity(
    args: MeteoraRemoveLiquidityArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.buildAndExecuteLocked(
      args.wallet,
      () => this.buildRemoveLiquidity(args),
      options,
    );
  }

  async claimFees(
    args: MeteoraPositionActionArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.buildAndExecuteLocked(
      args.wallet,
      () => this.buildClaimFees(args),
      options,
    );
  }

  async claimRewards(
    args: MeteoraPositionActionArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.buildAndExecuteLocked(
      args.wallet,
      () => this.buildClaimRewards(args),
      options,
    );
  }

  async claimPositionRewards(
    args: MeteoraPositionActionArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.buildAndExecuteLocked(
      args.wallet,
      () => this.buildClaimPositionRewards(args),
      options,
    );
  }

  async claimAllFees(
    args: { wallet: WalletRef; pool: string },
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.buildAndExecuteLocked(
      args.wallet,
      () => this.buildClaimAllFees(args),
      options,
    );
  }

  async claimAllLmRewards(
    args: { wallet: WalletRef; pool: string },
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.buildAndExecuteLocked(
      args.wallet,
      () => this.buildClaimAllLmRewards(args),
      options,
    );
  }

  async claimAllRewards(
    args: { wallet: WalletRef; pool: string },
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.buildAndExecuteLocked(
      args.wallet,
      () => this.buildClaimAllRewards(args),
      options,
    );
  }

  async closePosition(
    args: MeteoraPositionActionArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.buildAndExecuteLocked(
      args.wallet,
      () => this.buildClosePosition(args),
      options,
    );
  }

  async swapExactIn(
    args: MeteoraSwapExactInArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.buildAndExecuteLocked(
      args.wallet,
      () => this.buildSwapExactIn(args),
      options,
    );
  }

  async swapExactOut(
    args: MeteoraSwapExactOutArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.buildAndExecuteLocked(
      args.wallet,
      () => this.buildSwapExactOut(args),
      options,
    );
  }
}

export class MeteoraManagedPositionScope {
  private readonly managed = new Set<string>();

  constructor(
    private readonly service: MeteoraDlmmService,
    readonly wallet: WalletRef,
    readonly pool: string,
  ) {}

  positionIds(): string[] {
    return [...this.managed];
  }

  has(position: string): boolean {
    return this.managed.has(asPublicKey(position).toBase58());
  }

  async openVerified(
    args: Omit<MeteoraOpenPositionArgs, "wallet" | "pool">,
    options: MeteoraExecutionOptions,
    verificationOptions: MeteoraPositionVerificationOptions = {},
  ): Promise<MeteoraExecutionResult> {
    try {
      const result = await this.service.openPositionVerifiedRegistered(
        { ...args, wallet: this.wallet, pool: this.pool },
        options,
        verificationOptions,
        (position) => this.managed.add(asPublicKey(position).toBase58()),
      );
      if (result.position)
        this.managed.add(asPublicKey(result.position).toBase58());
      return result;
    } catch (error) {
      if (
        error instanceof MeteoraPartialExecutionError ||
        error instanceof MeteoraVerificationError
      ) {
        const position = error.result.position;
        if (position) this.managed.add(asPublicKey(position).toBase58());
      }
      throw error;
    }
  }

  async closeVerified(
    position: string,
    options: MeteoraExecutionOptions,
    verificationOptions: MeteoraPositionVerificationOptions = {},
  ): Promise<MeteoraExecutionResult> {
    const normalized = asPublicKey(position).toBase58();
    if (!this.managed.has(normalized)) {
      throw new MeteoraError(
        `Meteora managed scope refuses to close unregistered position ${normalized}`,
        "INVALID_ARGUMENT",
        { pool: this.pool, position: normalized },
      );
    }
    const result = await this.service.closePositionVerified(
      { wallet: this.wallet, pool: this.pool, position: normalized },
      options,
      verificationOptions,
    );
    if (result.verification?.ok) this.managed.delete(normalized);
    return result;
  }

  async closeAllVerified(
    options: MeteoraExecutionOptions,
    verificationOptions: MeteoraPositionVerificationOptions = {},
  ): Promise<{
    closed: MeteoraExecutionResult[];
    failures: Array<{
      position: string;
      code: MeteoraErrorCode | null;
      message: string;
      error: unknown;
    }>;
    remaining: string[];
  }> {
    const closed: MeteoraExecutionResult[] = [];
    const failures: Array<{
      position: string;
      code: MeteoraErrorCode | null;
      message: string;
      error: unknown;
    }> = [];
    for (const position of [...this.managed]) {
      try {
        closed.push(
          await this.closeVerified(position, options, verificationOptions),
        );
      } catch (error) {
        failures.push({
          position,
          code: meteoraErrorCode(error),
          message: error instanceof Error ? error.message : String(error),
          error,
        });
      }
    }
    return { closed, failures, remaining: this.positionIds() };
  }
}
