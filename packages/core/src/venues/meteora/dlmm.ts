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
import type {
  MeteoraActiveBin,
  MeteoraActiveBinSample,
  MeteoraAddLiquidityArgs,
  MeteoraDiscoverPoolsArgs,
  MeteoraExecutionOptions,
  MeteoraExecutionResult,
  MeteoraInteger,
  MeteoraInfrastructureFundingPolicy,
  MeteoraInfrastructurePreflight,
  MeteoraInfrastructureQuote,
  MeteoraLiquidityDepthMetrics,
  MeteoraMicrostructureMetrics,
  MeteoraOhlcvArgs,
  MeteoraOhlcvResponse,
  MeteoraCandleRegimeMetrics,
  MeteoraOracleObservation,
  MeteoraOracleSnapshot,
  MeteoraOracleSnapshotArgs,
  MeteoraOracleTwapWindow,
  MeteoraPoolMarketMetrics,
  MeteoraPoolProfileMetrics,
  MeteoraRangePathMetrics,
  MeteoraRollingPoolMetrics,
  MeteoraOpenPositionArgs,
  MeteoraPoolSearchResult,
  MeteoraPoolState,
  MeteoraPoolToken,
  MeteoraPositionActionArgs,
  MeteoraPositionSnapshot,
  MeteoraPreparedTransactions,
  MeteoraRemoveLiquidityArgs,
  MeteoraStrategy,
  MeteoraSwapExactInArgs,
  MeteoraSwapExactOutArgs,
  MeteoraSwapQuote,
  MeteoraTimeframe,
  MeteoraUiAmount,
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
        throw new Error(
          `Meteora transaction ${signature} failed on-chain: ${JSON.stringify(status.err)}`,
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
    throw new Error("Meteora write refused: execution requires { live: true }");

  const enabled =
    envEnabled("SOLARD_ENABLE_LIVE_TRADES") ||
    envEnabled("SOLWAL_ENABLE_LIVE_TRADES") ||
    envEnabled("SLRD_ENABLE_LIVE_TRADES");
  if (!enabled) {
    throw new Error(
      "Meteora write refused: set SOLARD_ENABLE_LIVE_TRADES=1 to enable live transactions",
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

export class MeteoraInfrastructureFundingRequiredError extends Error {
  readonly quote: MeteoraInfrastructureQuote;

  constructor(message: string, quote: MeteoraInfrastructureQuote) {
    super(message);
    this.name = "MeteoraInfrastructureFundingRequiredError";
    this.quote = quote;
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

export class MeteoraDlmmService {
  private readonly pools = new Map<string, Promise<DlmmPool>>();

  constructor(private readonly host: MeteoraDlmmHost) {}

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
    const url = new URL(`${this.dataApiBase()}/pools`);
    url.searchParams.set("query", normalized);
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Meteora pool search HTTP ${response.status}`);
    const body = (await response.json()) as any;
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
    const response = await fetch(`${this.dataApiBase()}/pools/${pool}`);
    if (!response.ok)
      throw new Error(`Meteora indexed pool HTTP ${response.status}`);
    return (safeJsonValue(await response.json()) ?? {}) as Record<
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
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Meteora pool detail HTTP ${response.status}`);
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

    const response = await fetch(url);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Meteora pool discovery HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
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
    const response = await fetch(url);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Meteora Data API ${path} HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    return safeJsonValue(await response.json());
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
    const url = new URL(`${this.dataApiBase()}/positions/${pool}/pnl`);
    url.searchParams.set("user", wallet);
    url.searchParams.set("status", args.status ?? "open");
    url.searchParams.set("page_size", "100");
    url.searchParams.set("page", "1");
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Meteora position PnL HTTP ${response.status}`);
    const body = (await response.json()) as any;
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

  async findPoolForPosition(
    positionAddress: string,
    wallet: string | PublicKey,
  ): Promise<string> {
    const positions = await this.getWalletPositions(wallet);
    const found = positions.positions.find(
      (position) => position.position === positionAddress,
    );
    if (!found)
      throw new Error(
        `Meteora position ${positionAddress} was not found for wallet ${positions.wallet}`,
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
  ): Promise<MeteoraInfrastructureQuote> {
    const quoteCreatePosition = (pool as any).quoteCreatePosition;
    if (typeof quoteCreatePosition !== "function") {
      throw new Error(
        "Meteora infrastructure preflight unavailable: installed @meteora-ag/dlmm does not expose quoteCreatePosition(). Refusing to build a liquidity transaction because shared bin-array funding cannot be proven zero.",
      );
    }
    const { StrategyType } = await dlmmSdk();
    const strategyType = normalizeStrategy(strategy, StrategyType);
    const rawQuote = await quoteCreatePosition.call(pool, {
      strategy: { minBinId, maxBinId, strategyType },
    });
    const row = (rawQuote ?? {}) as Record<string, unknown>;
    const own = (key: string): boolean =>
      Object.prototype.hasOwnProperty.call(row, key);
    const binCostKeys = [
      "binArrayCost",
      "bin_array_cost",
      "binArraysCost",
      "bin_arrays_cost",
    ];
    const bitmapCostKeys = [
      "bitmapExtensionCost",
      "bitmap_extension_cost",
      "binArrayBitmapExtensionCost",
      "bin_array_bitmap_extension_cost",
    ];
    if (!binCostKeys.some(own) || !bitmapCostKeys.some(own)) {
      throw new Error(
        "Meteora infrastructure preflight incompatible: quoteCreatePosition() returned an unrecognized cost schema. Refusing to build liquidity because bin-array/bitmap funding cannot be proven zero.",
      );
    }
    const binArrayCost = bigintOrZero(
      row.binArrayCost ??
        row.bin_array_cost ??
        row.binArraysCost ??
        row.bin_arrays_cost,
    );
    const bitmapExtensionCost = bigintOrZero(
      row.bitmapExtensionCost ??
        row.bitmap_extension_cost ??
        row.binArrayBitmapExtensionCost ??
        row.bin_array_bitmap_extension_cost,
    );
    const positionCostRaw =
      row.positionCost ??
      row.position_cost ??
      row.positionRent ??
      row.position_rent;
    const reallocCostRaw =
      row.reallocPositionCost ??
      row.positionReallocCost ??
      row.position_realloc_cost ??
      row.realloc_position_cost;
    const count =
      numberOrNull(
        row.binArrayCount ?? row.bin_array_count ?? row.binArraysCount,
      ) ?? null;
    const txCount =
      numberOrNull(
        row.transactionCount ?? row.transaction_count ?? row.txCount,
      ) ?? null;
    const nonRefundable = binArrayCost + bitmapExtensionCost;
    return {
      pool: pool.pubkey.toBase58(),
      minBinId,
      maxBinId,
      strategy,
      binArrayCount: count,
      binArrayCostLamports: binArrayCost.toString(),
      bitmapExtensionCostLamports: bitmapExtensionCost.toString(),
      nonRefundableInfrastructureLamports: nonRefundable.toString(),
      positionCostLamports:
        positionCostRaw == null
          ? null
          : bigintOrZero(positionCostRaw).toString(),
      positionReallocCostLamports:
        reallocCostRaw == null ? null : bigintOrZero(reallocCostRaw).toString(),
      transactionCount: txCount,
      requiresBinArrayInit: binArrayCost > 0n,
      requiresBitmapExtensionInit: bitmapExtensionCost > 0n,
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

  private assertInfrastructurePolicy(
    quote: MeteoraInfrastructureQuote,
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
      throw new MeteoraInfrastructureFundingRequiredError(
        `Meteora liquidity build refused: requested range ${quote.minBinId}..${quote.maxBinId} requires caller-funded shared infrastructure (${reasons.join(
          ", ",
        )}). This is denied by default. Explicitly opt in with the corresponding infrastructure allow flag and maxNonRefundableLamports. No Meteora transaction was constructed.`,
        quote,
      );
    }

    if (policy?.maxNonRefundableLamports == null) {
      throw new MeteoraInfrastructureFundingRequiredError(
        `Meteora liquidity build refused: shared infrastructure was explicitly allowed but maxNonRefundableLamports was not provided. A hard expenditure cap is required.`,
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
        `Meteora liquidity build refused: shared infrastructure requires ${required} lamports, exceeding maxNonRefundableLamports=${maximum}. No Meteora transaction was constructed.`,
        quote,
      );
    }
  }

  private infrastructurePreflight(
    quote: MeteoraInfrastructureQuote,
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

  async executePrepared(
    prepared: MeteoraPreparedTransactions,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    assertLiveTradingEnabled(options);
    if (
      prepared.kind === "open-position" ||
      prepared.kind === "add-liquidity"
    ) {
      const preflight = prepared.infrastructurePreflight;
      if (!preflight?.checked) {
        throw new Error(
          `Meteora ${prepared.kind} execution refused: prepared liquidity transaction lacks Solard infrastructure preflight attestation. Rebuild it with the current Solard SDK before execution.`,
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
      throw new Error(`Meteora ${prepared.kind} produced no transactions`);
    }

    const connection = this.host.connection();
    const wallet = this.host.signer(prepared.wallet);
    const signers = uniqueSigners([wallet, ...prepared.extraSigners]);
    const commitment: Commitment = options.commitment ?? "confirmed";
    const signatures: string[] = [];

    for (const transaction of prepared.transactions) {
      if (isLegacyTransaction(transaction)) {
        if (!transaction.feePayer) transaction.feePayer = wallet.publicKey;
        if (!transaction.recentBlockhash) {
          transaction.recentBlockhash = (
            await connection.getLatestBlockhash(commitment)
          ).blockhash;
        }
        transaction.partialSign(...signers);
      } else {
        transaction.sign(signers);
      }

      if (options.simulate !== false) {
        const simulation = isLegacyTransaction(transaction)
          ? await connection.simulateTransaction(transaction)
          : await connection.simulateTransaction(transaction, {
              sigVerify: false,
            });
        if (simulation.value.err) {
          throw new Error(
            `Meteora ${prepared.kind} simulation failed: ${JSON.stringify(
              simulation.value.err,
            )}\n${simulation.value.logs?.join("\n") ?? ""}`,
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
            throw new Error(
              `Meteora ${prepared.kind} send response was lost and transaction ${expectedSignature} could not be confirmed on-chain: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        } else {
          throw error;
        }
      }

      try {
        await connection.confirmTransaction(signature, commitment);
      } catch (error) {
        if (!transportError(error)) throw error;
        const landed = await recoverSubmittedSignature(
          connection,
          signature,
          commitment,
        );
        if (!landed) {
          throw new Error(
            `Meteora ${prepared.kind} transaction ${signature} was submitted but confirmation remained uncertain after a transport error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      signatures.push(signature);
    }

    this.clearPoolCache(prepared.pool);
    return {
      kind: prepared.kind,
      pool: prepared.pool,
      position: prepared.position,
      signatures,
    };
  }

  async openPosition(
    args: MeteoraOpenPositionArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildOpenPosition(args),
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
    return await this.executePrepared(
      await this.buildAddLiquidity(args),
      options,
    );
  }

  async removeLiquidity(
    args: MeteoraRemoveLiquidityArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildRemoveLiquidity(args),
      options,
    );
  }

  async claimFees(
    args: MeteoraPositionActionArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(await this.buildClaimFees(args), options);
  }

  async claimRewards(
    args: MeteoraPositionActionArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildClaimRewards(args),
      options,
    );
  }

  async claimPositionRewards(
    args: MeteoraPositionActionArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildClaimPositionRewards(args),
      options,
    );
  }

  async claimAllFees(
    args: { wallet: WalletRef; pool: string },
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildClaimAllFees(args),
      options,
    );
  }

  async claimAllLmRewards(
    args: { wallet: WalletRef; pool: string },
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildClaimAllLmRewards(args),
      options,
    );
  }

  async claimAllRewards(
    args: { wallet: WalletRef; pool: string },
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildClaimAllRewards(args),
      options,
    );
  }

  async closePosition(
    args: MeteoraPositionActionArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildClosePosition(args),
      options,
    );
  }

  async swapExactIn(
    args: MeteoraSwapExactInArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildSwapExactIn(args),
      options,
    );
  }

  async swapExactOut(
    args: MeteoraSwapExactOutArgs,
    options: MeteoraExecutionOptions,
  ): Promise<MeteoraExecutionResult> {
    return await this.executePrepared(
      await this.buildSwapExactOut(args),
      options,
    );
  }
}
