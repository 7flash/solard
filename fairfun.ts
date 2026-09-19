#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Connection } from "@solana/web3.js";
import { configure, createMeasure } from "measure-fn";
import {
  getTokenHistoryCoverage,
  loadTokenHistoryTrades,
  parsePumpHistoryTransaction,
  subscribeTokenEvents,
  type TokenHistoryTrade,
} from "@solard/core";
import {
  createSolard,
  type CumulativeEntitlement,
  type MarketHistory,
  type ReplayItem,
  type Solard,
  type TokenRow,
} from "@solard/sdk";

configure({ silent: false });
const measure = createMeasure("slrd:fairfun", { maxResultLength: 1600 });

const MINUTE_MS = 60_000;
const PRICE_SCALE_DIGITS = 24;
const PRICE_SCALE = 10n ** BigInt(PRICE_SCALE_DIGITS);

type TokenConfig = {
  mint: string;
  treasury: string;
  distributionId?: string;
  quoteMint?: string;
  quoteSymbol?: string;
  gravityStartAtMs?: number;
  excludedOwners?: string[];
  reserveRaw?: string;
  autoDistributeRaw?: string;
  treasuryPollMs?: number;
  livePriceGraceMs?: number;
  rewardWeight?: "gravity" | "pumpswap-buy-quote";
};

type HttpConfig = {
  enabled?: boolean;
  host?: string;
  port?: number;
  corsOrigin?: string;
  adminTokenEnv?: string;
};

type Config = {
  version: 1;
  checkpoint: string;
  rpcUrl?: string;
  dbPath?: string;
  sender?: string;
  http?: HttpConfig;
  chartWindowMinutes?: number;
  tokens: TokenConfig[];
};

type TokenCheckpoint = {
  rewardStartedAtMs: number;
  treasuryBalanceRaw?: string;
  entitlements: Record<string, string>;
};

type Checkpoint = {
  version: 1;
  tokens: Record<string, TokenCheckpoint>;
};

type GravityRow = {
  gravityQ: bigint;
  remainder: bigint;
};

type RuntimeToken = {
  base: TokenRow;
  baseSymbol: string;
  quoteMint: string;
  quoteSymbol: string;
  quoteDecimals: number;
  quoteKind: "native-sol" | "spl-token";
  treasuryAddress: string;
  distributionId: string;
  asset: "SOL" | string;
  initialPriceText: string;
  initialPriceQ: bigint;
  initialPriceAtMs: number;
  rewardWeight: "gravity" | "pumpswap-buy-quote";
};

type ChartPoint = {
  atMs: number;
  priceQ: bigint;
  gravityQ: bigint;
};

type PumpSwapContribution = {
  buyQuoteRaw: bigint;
  sellQuoteRaw: bigint;
  boughtTokenRaw: bigint;
  soldTokenRaw: bigint;
  buys: number;
  sells: number;
};

type PublicHolder = {
  wallet: string;
  tokenAccounts: string[];
  balanceRaw: string;
  balance: string;
  value: string;
  gravity: string;
  gravitySharePct: number;
  verifiedPumpSwapBuyQuoteRaw: string;
  verifiedPumpSwapBuyQuote: string;
  verifiedPumpSwapBuySharePct: number;
  verifiedPumpSwapBoughtTokenRaw: string;
  verifiedPumpSwapBuys: number;
  verifiedPumpSwapSellQuoteRaw: string;
  verifiedPumpSwapSellQuote: string;
  verifiedPumpSwapSoldTokenRaw: string;
  verifiedPumpSwapSells: number;
  earnedRaw: string;
  earned: string;
  paidRaw: string;
  paid: string;
  outstandingRaw: string;
  outstanding: string;
  claimableRaw: string;
  claimable: string;
  now: boolean;
};

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
    if (inline != null) out.set(key!, inline);
    else if (argv[index + 1] && !argv[index + 1]!.startsWith("--"))
      out.set(key!, argv[++index]!);
    else out.set(key!, "true");
  }
  return out;
}

function required(flags: Map<string, string>, key: string): string {
  const value = flags.get(key);
  if (!value || value === "true") throw new Error(`Missing --${key} <value>`);
  return value;
}

function loadConfig(path: string): Config {
  const parsed = JSON.parse(readFileSync(resolve(path), "utf8")) as Config;
  if (parsed.version !== 1)
    throw new Error(
      `Unsupported config version ${String((parsed as any).version)}`,
    );
  if (!Array.isArray(parsed.tokens) || parsed.tokens.length === 0)
    throw new Error("Config must contain at least one token");
  return parsed;
}

function loadCheckpoint(path: string): Checkpoint {
  if (!existsSync(path)) return { version: 1, tokens: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Checkpoint;
  if (parsed.version !== 1)
    throw new Error(
      `Unsupported checkpoint version ${String((parsed as any).version)}`,
    );
  return parsed;
}

function saveCheckpoint(path: string, checkpoint: Checkpoint): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

function floorMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

function ceilMinute(ms: number): number {
  return Math.ceil(ms / MINUTE_MS) * MINUTE_MS;
}

function decimalToScaled(
  input: string | number,
  digits = PRICE_SCALE_DIGITS,
): bigint {
  let text = String(input).trim().toLowerCase();
  if (!text) throw new Error("Empty decimal");
  let sign = 1n;
  if (text.startsWith("-")) {
    sign = -1n;
    text = text.slice(1);
  } else if (text.startsWith("+")) text = text.slice(1);
  const exponentIndex = text.indexOf("e");
  let exponent = 0;
  if (exponentIndex >= 0) {
    exponent = Number(text.slice(exponentIndex + 1));
    text = text.slice(0, exponentIndex);
    if (!Number.isInteger(exponent))
      throw new Error(`Invalid decimal exponent ${input}`);
  }
  const [wholeRaw, fractionRaw = ""] = text.split(".", 2);
  const whole = wholeRaw || "0";
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fractionRaw))
    throw new Error(`Invalid decimal ${input}`);
  let digitsText = `${whole}${fractionRaw}`.replace(/^0+(?=\d)/, "") || "0";
  let decimalPlaces = fractionRaw.length - exponent;
  if (decimalPlaces < 0) {
    digitsText += "0".repeat(-decimalPlaces);
    decimalPlaces = 0;
  }
  const targetShift = digits - decimalPlaces;
  if (targetShift >= 0)
    return sign * BigInt(digitsText) * 10n ** BigInt(targetShift);
  const divisor = 10n ** BigInt(-targetShift);
  const raw = BigInt(digitsText);
  const quotient = raw / divisor;
  const remainder = raw % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  return sign * rounded;
}

function formatScaled(value: bigint, decimals: number): string {
  const sign = value < 0n ? "-" : "";
  const raw = value < 0n ? -value : value;
  const unit = 10n ** BigInt(decimals);
  const whole = raw / unit;
  const fraction = (raw % unit)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

function percent(numerator: bigint, denominator: bigint): number {
  if (numerator <= 0n || denominator <= 0n) return 0;
  const scaled = (numerator * 1_000_000n) / denominator;
  return Number(scaled) / 10_000;
}

function priceChangePct(current: bigint, previous: bigint): number | null {
  if (current <= 0n || previous <= 0n) return null;
  const scaled = ((current - previous) * 1_000_000n) / previous;
  return Number(scaled) / 10_000;
}

function shortAddress(value: unknown): string {
  const text = String(value ?? "");
  return text.length <= 14 ? text : `${text.slice(0, 6)}…${text.slice(-4)}`;
}

function humanProgress(value: Record<string, unknown>): string {
  const token = value.token ? `${shortAddress(value.token)} ` : "";
  switch (value.type) {
    case "startup":
      return `Fairfun starting (${String(value.tokens)} token${value.tokens === 1 ? "" : "s"})`;
    case "bootstrap": {
      const stage = String(value.stage);
      if (stage === "holder-history")
        return `${token}[1/4] Holder history: replaying and catching up`;
      if (stage === "market-history")
        return `${token}[2/4] Market history: reading/backfilling Solard DB`;
      if (stage === "gravity")
        return `${token}[3/4] Gravity: rebuilding minute-by-minute`;
      if (stage === "treasury")
        return `${token}[4/4] Treasury: taking reward baseline`;
      return `${token}${stage}`;
    }
    case "heartbeat":
      return `${token}${String(value.stage)} still running (${String(value.elapsedSec)}s)`;
    case "holder-backfill": {
      const phase = String(value.phase);
      if (phase === "rpc-mint-signatures")
        return `${token}Holder backfill: ${String(value.completed)} mint-linked transaction(s) discovered`;
      if (phase === "rpc-mint-transactions")
        return `${token}Holder backfill: reading mint transactions ${String(value.completed)}/${String(value.total)}`;
      if (phase === "rpc-token-accounts")
        return `${token}Holder backfill: ${String(value.completed)} historical token account(s) discovered`;
      if (phase === "rpc-account-signatures")
        return `${token}Holder backfill: scanning token accounts ${String(value.completed)}/${String(value.total)}`;
      if (phase === "rpc-transactions")
        return `${token}Holder backfill: reading transfer transactions ${String(value.completed)}/${String(value.total)}`;
      return `${token}Holder backfill: ${phase}`;
    }
    case "holder-history-complete":
      return `${token}Holder history ready: ${String(value.events)} events, verified through slot ${String(value.throughSlot)}`;
    case "market-backfill": {
      const phase = String(value.phase);
      if (phase === "signatures")
        return `${token}Market backfill: signatures ${String(value.signatures)} across ${String(value.pages)} page(s)`;
      if (phase === "transactions" || phase === "parse" || phase === "store")
        return `${token}Market backfill: ${phase} ${String(value.completed)}/${String(value.total)}`;
      if (phase === "candles")
        return `${token}Market backfill: ${String(value.trades)} trades → ${String(value.candles)} 1s candles`;
      if (phase === "retry")
        return `${token}Market backfill retry ${String(value.attempt)}/${String(value.maxAttempts)}: ${String(value.error)}`;
      if (phase === "throttle")
        return `${token}Market backfill throttled for ${String(value.waitMs)}ms`;
      if (phase === "rpc-error")
        return `${token}Market backfill RPC error: ${String(value.error)}`;
      return `${token}Market backfill: ${phase}`;
    }
    case "verified-pumpswap-history":
      return `${token}Verified PumpSwap history: ${String(value.trades)} exact trade(s), ${String(value.contributors)} contributor(s), buy quote raw=${String(value.buyQuoteRaw)}, skipped inexact=${String(value.skippedInexact)}`;
    case "gravity-complete":
      return `${token}Gravity ready: ${String(value.holders)} holder(s), through ${new Date(Number(value.throughMinuteMs)).toISOString()}`;
    case "token-ready":
      return `${token}READY — holders=${String(value.holders)} gravity-holders=${String(value.gravityHolders)} gravity=${String(value.gravity)} treasury=${shortAddress(value.treasury)}`;
    case "minute":
      return `${token}Gravity minute — holders=${String(value.holders)} price=${String(value.price)} ${shortAddress(value.quoteMint)} slot=${String(value.slot)}`;
    case "reward-deposit":
      return `${token}Reward deposit ${String(value.depositRaw)} raw units → ${String(value.allocations)} holder(s); outstanding=${String(value.outstandingRaw)}`;
    case "distribution":
      return `${token}Distribution ${String(value.status)} — recipients=${String(value.recipients)} paid=${String(value.confirmedPaidRaw)} raw`;
    case "ready":
      return `Fairfun live. Commands: status | distribute [mint] | quit`;
    case "server":
      return `Fairfun API ${String(value.url)} — SSE ${String(value.stream)}`;
    default:
      return `${token}${JSON.stringify(value)}`;
  }
}

function emit(value: Record<string, unknown>): void {
  const event = { ...value, atMs: Date.now() };
  measure.note({
    start: () => humanProgress(event),
    meta: event,
    maxResultLength: 1600,
  });
}

async function withHeartbeat<T>(args: {
  token: string;
  stage: string;
  work: () => Promise<T>;
  everyMs?: number;
}): Promise<T> {
  const startedAtMs = Date.now();
  const timer = setInterval(
    () => {
      emit({
        type: "heartbeat",
        token: args.token,
        stage: args.stage,
        elapsedSec: Math.floor((Date.now() - startedAtMs) / 1_000),
      });
    },
    Math.max(1_000, args.everyMs ?? 10_000),
  );
  try {
    return await args.work();
  } finally {
    clearInterval(timer);
  }
}

function candleClosePrice(candle: unknown): string | number {
  const row = candle as Record<string, unknown>;
  const value =
    row.closePriceQuotePerToken ?? row.closePrice ?? row.closePriceSol;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("Stored market candle has no close price");
  }
  return value;
}

function minutePriceMap(
  market: MarketHistory,
  startMinute: number,
  endMinute: number,
): Map<number, bigint> {
  const candles = [...market.candles1s].sort(
    (a, b) => a.bucketAtMs - b.bucketAtMs,
  );
  const out = new Map<number, bigint>();
  let candleIndex = 0;
  let lastPriceQ: bigint | null = null;
  while (
    candleIndex < candles.length &&
    candles[candleIndex]!.bucketAtMs < startMinute
  ) {
    lastPriceQ = decimalToScaled(candleClosePrice(candles[candleIndex]!));
    candleIndex += 1;
  }
  for (let minute = startMinute; minute <= endMinute; minute += MINUTE_MS) {
    const through = minute + MINUTE_MS - 1;
    while (
      candleIndex < candles.length &&
      candles[candleIndex]!.bucketAtMs <= through
    ) {
      lastPriceQ = decimalToScaled(candleClosePrice(candles[candleIndex]!));
      candleIndex += 1;
    }
    if (lastPriceQ == null || lastPriceQ <= 0n) {
      throw new Error(
        `No stored market price at or before ${new Date(through).toISOString()} for ${market.mint}`,
      );
    }
    out.set(minute, lastPriceQ);
  }
  return out;
}

function quoteMatches(
  configured: string | undefined,
  actual: string,
  nativeSol: boolean,
): boolean {
  if (!configured) return true;
  if (nativeSol && configured.trim().toUpperCase() === "SOL") return true;
  return configured.trim() === actual;
}

function walletAddress(slrd: Solard, ref: string): string {
  const clean = ref.startsWith("@") ? ref.slice(1) : ref;
  const rows = slrd.listWallets();
  const byAddress = rows.find((row) => row.address === clean);
  if (byAddress) return byAddress.address;
  const byName = rows.find((row) => row.name === clean);
  if (byName) return byName.address;
  throw new Error(`Treasury wallet ${ref} is not in the Solard vault`);
}

async function ensureToken(slrd: Solard, mint: string): Promise<TokenRow> {
  try {
    return slrd.resolveToken(mint);
  } catch {
    return await slrd.addToken(mint);
  }
}

function replayTimestampMs(item: ReplayItem): number {
  if (item.timestampSec == null)
    throw new Error(`Replay event ${item.id} has no block timestamp`);
  return item.timestampSec * 1_000;
}

function applyReplayBalances(
  balances: Map<string, bigint>,
  item: ReplayItem,
): void {
  for (const [owner, amount] of item.postBalance) {
    if (amount === 0n) balances.delete(owner);
    else balances.set(owner, amount);
  }
}

function sortedEntitlements(map: Map<string, bigint>): CumulativeEntitlement[] {
  return [...map]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([recipient, entitledRaw]) => ({ recipient, entitledRaw }));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    const abort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function liveGate(): boolean {
  return [
    process.env.SOLARD_ENABLE_LIVE_TRADES,
    process.env.SLRD_ENABLE_LIVE_TRADES,
  ].some((value) => /^(1|true|yes)$/i.test(value?.trim() ?? ""));
}

class TokenEngine {
  private runtime!: RuntimeToken;
  private readonly balances = new Map<string, bigint>();
  private readonly holderAccounts = new Map<string, string[]>();
  private readonly gravity = new Map<string, GravityRow>();
  private readonly pumpSwapContribution = new Map<
    string,
    PumpSwapContribution
  >();
  private readonly verifiedPumpSwapTradeKeys = new Set<string>();
  private verifiedPumpSwapSkippedInexact = 0;
  private verifiedPumpSwapThroughMs = 0;
  private readonly entitlements = new Map<string, bigint>();
  private readonly excluded = new Set<string>();
  private readonly chart: ChartPoint[] = [];
  private lastAccruedMinuteMs = -1;
  private lastTreasuryBalanceRaw = 0n;
  private currentSupplyRaw = 0n;
  private latestPriceQ = 0n;
  private latestPriceText = "0";
  private latestPriceAtMs = 0;
  private phase = "starting";
  private readonly pendingTreasuryDeposits: Array<{
    amountRaw: bigint;
    requiredMinuteMs: number;
    balanceAfterRaw: bigint;
  }> = [];
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly slrd: Solard,
    private readonly connection: Connection,
    private readonly root: Config,
    private readonly config: TokenConfig,
    private readonly checkpointPath: string,
    private readonly checkpoint: Checkpoint,
    private readonly signal: AbortSignal,
    private readonly onChange: (
      engine: TokenEngine,
      reason: string,
    ) => void = () => {},
  ) {}

  private serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private checkpointRow(): TokenCheckpoint {
    let row = this.checkpoint.tokens[this.config.mint];
    if (!row) {
      const existing = this.slrd.distributions.status(
        this.runtime.distributionId,
      );
      row = {
        rewardStartedAtMs: Date.now(),
        entitlements: Object.fromEntries(
          (existing?.recipients ?? []).map((recipient) => [
            recipient.recipient,
            recipient.entitledRaw,
          ]),
        ),
      };
      this.checkpoint.tokens[this.config.mint] = row;
      saveCheckpoint(this.checkpointPath, this.checkpoint);
    }
    return row;
  }

  private saveRuntimeCheckpoint(treasuryBalanceRaw?: bigint): void {
    const row = this.checkpointRow();
    if (treasuryBalanceRaw != null)
      row.treasuryBalanceRaw = treasuryBalanceRaw.toString();
    row.entitlements = Object.fromEntries(
      [...this.entitlements]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([wallet, amount]) => [wallet, amount.toString()]),
    );
    saveCheckpoint(this.checkpointPath, this.checkpoint);
  }

  private gravityRow(owner: string): GravityRow {
    let row = this.gravity.get(owner);
    if (!row) {
      row = { gravityQ: 0n, remainder: 0n };
      this.gravity.set(owner, row);
    }
    return row;
  }

  private contributionRow(owner: string): PumpSwapContribution {
    let row = this.pumpSwapContribution.get(owner);
    if (!row) {
      row = {
        buyQuoteRaw: 0n,
        sellQuoteRaw: 0n,
        boughtTokenRaw: 0n,
        soldTokenRaw: 0n,
        buys: 0,
        sells: 0,
      };
      this.pumpSwapContribution.set(owner, row);
    }
    return row;
  }

  private applyVerifiedPumpSwapTrade(trade: TokenHistoryTrade): boolean {
    if (trade.mint !== this.runtime.base.mint) return false;
    if (!trade.owner || this.excluded.has(trade.owner)) return false;
    if (trade.confidence !== "finalized") return false;
    if (trade.history.venue !== "pumpswap") return false;
    if (trade.source !== "history:pumpswap") return false;
    if (this.verifiedPumpSwapTradeKeys.has(trade.eventKey)) return false;

    const quoteText = trade.history.economicQuoteDeltaLamports;
    if (
      trade.history.pricingStatus !== "native-wsol-corrected" ||
      quoteText == null
    ) {
      this.verifiedPumpSwapSkippedInexact += 1;
      return false;
    }

    const quoteDelta = BigInt(quoteText);
    const tokenDelta = BigInt(trade.history.ownerTokenDeltaRaw);
    if (
      quoteDelta === 0n ||
      tokenDelta === 0n ||
      (trade.side === "buy" && (quoteDelta >= 0n || tokenDelta <= 0n)) ||
      (trade.side === "sell" && (quoteDelta <= 0n || tokenDelta >= 0n))
    ) {
      return false;
    }

    const row = this.contributionRow(trade.owner);
    if (trade.side === "buy") {
      row.buyQuoteRaw += -quoteDelta;
      row.boughtTokenRaw += tokenDelta;
      row.buys += 1;
    } else {
      row.sellQuoteRaw += quoteDelta;
      row.soldTokenRaw += -tokenDelta;
      row.sells += 1;
    }
    this.verifiedPumpSwapTradeKeys.add(trade.eventKey);
    this.verifiedPumpSwapThroughMs = Math.max(
      this.verifiedPumpSwapThroughMs,
      trade.tradedAtMs,
    );
    return true;
  }

  private rebuildVerifiedPumpSwapAccounting(): void {
    this.pumpSwapContribution.clear();
    this.verifiedPumpSwapTradeKeys.clear();
    this.verifiedPumpSwapSkippedInexact = 0;
    this.verifiedPumpSwapThroughMs = 0;

    const coverage = getTokenHistoryCoverage(this.runtime.base.mint);
    if (!coverage?.fromCreation || !coverage.complete) {
      throw new Error(
        `Verified PumpSwap accounting requires complete market history from creation for ${this.runtime.base.mint}`,
      );
    }

    for (const trade of loadTokenHistoryTrades(this.runtime.base.mint)) {
      this.applyVerifiedPumpSwapTrade(trade);
    }
  }

  private totalVerifiedPumpSwapBuyQuoteRaw(): bigint {
    let total = 0n;
    for (const [owner, row] of this.pumpSwapContribution) {
      if (!this.excluded.has(owner)) total += row.buyQuoteRaw;
    }
    return total;
  }

  private totalVerifiedPumpSwapSellQuoteRaw(): bigint {
    let total = 0n;
    for (const [owner, row] of this.pumpSwapContribution) {
      if (!this.excluded.has(owner)) total += row.sellQuoteRaw;
    }
    return total;
  }

  private allocationWeights(): Array<{ recipient: string; weight: bigint }> {
    if (this.runtime.rewardWeight === "pumpswap-buy-quote") {
      return [...this.pumpSwapContribution]
        .filter(
          ([owner, row]) => !this.excluded.has(owner) && row.buyQuoteRaw > 0n,
        )
        .map(([recipient, row]) => ({ recipient, weight: row.buyQuoteRaw }));
    }
    return [...this.gravity]
      .filter(([owner, row]) => !this.excluded.has(owner) && row.gravityQ > 0n)
      .map(([recipient, row]) => ({ recipient, weight: row.gravityQ }));
  }

  private async verifiedPumpSwapLoop(): Promise<void> {
    if (this.runtime.quoteKind !== "native-sol") return;

    const stream = await subscribeTokenEvents({
      connection: this.connection,
      token: this.runtime.base,
      options: {
        swaps: true,
        transfers: false,
        creates: false,
        commitment: "finalized",
        signal: this.signal,
      },
    });

    try {
      for await (const event of stream) {
        if (this.signal.aborted || this.stopped) break;
        if (event.type !== "swap" || event.venue !== "pumpswap") continue;

        const tx = await this.connection.getParsedTransaction(event.signature, {
          commitment: "finalized",
          maxSupportedTransactionVersion: 0,
        });
        if (!tx || tx.meta?.err) continue;

        const parsed = parsePumpHistoryTransaction({
          tx,
          signature: event.signature,
          mint: this.runtime.base.mint,
          decimals: this.runtime.base.decimals!,
          supplyUi: 0,
          historyOrder: 0,
          scanAddress:
            this.runtime.base.pool ??
            this.runtime.base.bondingCurve ??
            this.runtime.base.mint,
          scanKind: "pool",
          confidence: "finalized",
          updatedAtMs: event.observedAtMs,
        });

        let changed = false;
        await this.serial(() => {
          for (const trade of parsed.trades) {
            if (this.applyVerifiedPumpSwapTrade(trade)) changed = true;
          }
        });
        if (changed) this.onChange(this, "verified-pumpswap-trade");
      }
    } finally {
      await stream.close();
    }
  }

  private accrueOwner(
    owner: string,
    balanceRaw: bigint,
    priceSumQ: bigint,
  ): void {
    if (balanceRaw <= 0n || priceSumQ <= 0n || this.excluded.has(owner)) return;
    const row = this.gravityRow(owner);
    const baseDecimals = this.runtime.base.decimals;
    if (baseDecimals == null)
      throw new Error(`Token ${this.runtime.base.mint} has unknown decimals`);
    const numerator =
      balanceRaw * priceSumQ * 10n ** BigInt(this.runtime.quoteDecimals) +
      row.remainder;
    const denominator = 10n ** BigInt(baseDecimals);
    row.gravityQ += numerator / denominator;
    row.remainder = numerator % denominator;
  }

  private accrueMinute(priceQ: bigint): void {
    for (const [owner, balanceRaw] of this.balances)
      this.accrueOwner(owner, balanceRaw, priceQ);
  }

  private gravityTotal(): bigint {
    let total = 0n;
    for (const [owner, row] of this.gravity)
      if (!this.excluded.has(owner) && row.gravityQ > 0n) total += row.gravityQ;
    return total;
  }

  private allocateDeposit(
    amountRaw: bigint,
  ): Array<{ recipient: string; amountRaw: bigint }> {
    if (amountRaw <= 0n) return [];
    const rows = this.allocationWeights();
    const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0n);
    if (totalWeight <= 0n)
      throw new Error(
        `Treasury deposit ${amountRaw} arrived for ${this.config.mint} before any ${this.runtime.rewardWeight} weight existed`,
      );
    const shares = rows.map((row) => {
      const numerator = amountRaw * row.weight;
      return {
        recipient: row.recipient,
        amountRaw: numerator / totalWeight,
        remainder: numerator % totalWeight,
      };
    });
    let assigned = shares.reduce((sum, row) => sum + row.amountRaw, 0n);
    let remainderUnits = amountRaw - assigned;
    shares.sort((left, right) => {
      if (left.remainder === right.remainder)
        return left.recipient.localeCompare(right.recipient);
      return left.remainder > right.remainder ? -1 : 1;
    });
    for (let index = 0; remainderUnits > 0n; index += 1) {
      shares[index % shares.length]!.amountRaw += 1n;
      remainderUnits -= 1n;
    }
    const allocations = shares
      .filter((row) => row.amountRaw > 0n)
      .map(({ recipient, amountRaw }) => ({ recipient, amountRaw }));
    for (const allocation of allocations)
      this.entitlements.set(
        allocation.recipient,
        (this.entitlements.get(allocation.recipient) ?? 0n) +
          allocation.amountRaw,
      );
    return allocations;
  }

  private async persistDistributionPlan() {
    this.saveRuntimeCheckpoint();
    return await this.slrd.distributions.plan({
      id: this.runtime.distributionId,
      from: this.config.treasury,
      asset: this.runtime.asset,
      entitlements: sortedEntitlements(this.entitlements),
      reserveRaw: BigInt(this.config.reserveRaw ?? "0"),
    });
  }

  private async readTreasuryBalanceRaw(): Promise<bigint> {
    if (this.runtime.quoteKind === "native-sol") {
      return (await this.slrd.walletBalances(this.config.treasury, []))
        .solLamports;
    }
    const accounts = await this.slrd.tokenAccounts(
      this.runtime.treasuryAddress,
    );
    return accounts
      .filter((account) => account.mint === this.runtime.quoteMint)
      .reduce((sum, account) => sum + account.amountRaw, 0n);
  }

  private async processTreasuryDeposit(
    amountRaw: bigint,
    balanceAfterRaw: bigint,
  ): Promise<void> {
    const allocations = this.allocateDeposit(amountRaw);
    this.lastTreasuryBalanceRaw = balanceAfterRaw;
    const plan = await this.persistDistributionPlan();
    emit({
      type: "reward-deposit",
      token: this.runtime.base.mint,
      quoteMint: this.runtime.quoteMint,
      depositRaw: amountRaw.toString(),
      allocations: allocations.length,
      cumulativeEntitledRaw: plan.totalEntitledRaw.toString(),
      outstandingRaw: plan.totalOutstandingRaw.toString(),
    });
    const threshold = BigInt(this.config.autoDistributeRaw ?? "0");
    if (threshold > 0n && plan.totalOutstandingRaw >= threshold)
      await this.executeDistributionLocked();
  }

  private async flushTreasuryDeposits(): Promise<void> {
    while (this.pendingTreasuryDeposits.length) {
      const next = this.pendingTreasuryDeposits[0]!;
      if (next.requiredMinuteMs > this.lastAccruedMinuteMs) return;
      await this.processTreasuryDeposit(next.amountRaw, next.balanceAfterRaw);
      this.pendingTreasuryDeposits.shift();
      this.onChange(this, "reward-deposit");
    }
  }

  private historicalGravity(
    history: Awaited<ReturnType<Solard["history"]["replay"]>>,
    market: MarketHistory,
    endMinute: number,
  ): void {
    const events = history.items.filter((item) => item.postBalance.size > 0);
    if (!events.length) {
      this.lastAccruedMinuteMs = endMinute;
      return;
    }
    const earliestEventMs = replayTimestampMs(events[0]!);
    const startMinute =
      this.config.gravityStartAtMs == null
        ? ceilMinute(earliestEventMs)
        : ceilMinute(this.config.gravityStartAtMs);
    if (startMinute > endMinute) {
      for (const item of history.items)
        applyReplayBalances(this.balances, item);
      this.lastAccruedMinuteMs = endMinute;
      return;
    }
    const prices = minutePriceMap(market, startMinute, endMinute);
    const pricePrefix = new Map<number, bigint>();
    let running = 0n;
    pricePrefix.set(startMinute, 0n);
    for (let minute = startMinute; minute <= endMinute; minute += MINUTE_MS) {
      running += prices.get(minute)!;
      pricePrefix.set(minute + MINUTE_MS, running);
    }
    const nextMinute = new Map<string, number>();
    const settle = (owner: string, untilExclusive: number) => {
      const from = nextMinute.get(owner) ?? startMinute;
      if (untilExclusive <= from) return;
      const left = pricePrefix.get(from);
      const right = pricePrefix.get(untilExclusive);
      if (left == null || right == null)
        throw new Error(
          `Historical gravity price range is not contiguous for ${owner}`,
        );
      this.accrueOwner(owner, this.balances.get(owner) ?? 0n, right - left);
      nextMinute.set(owner, untilExclusive);
    };
    for (const item of history.items) {
      if (item.postBalance.size === 0) continue;
      const eventMs = replayTimestampMs(item);
      const effectMinute = ceilMinute(eventMs);
      if (effectMinute < startMinute) {
        applyReplayBalances(this.balances, item);
        continue;
      }
      if (effectMinute > endMinute) continue;
      for (const owner of item.postBalance.keys()) settle(owner, effectMinute);
      applyReplayBalances(this.balances, item);
      for (const owner of item.postBalance.keys())
        nextMinute.set(owner, effectMinute);
    }
    for (const owner of this.balances.keys())
      settle(owner, endMinute + MINUTE_MS);
    for (const item of history.items) {
      if (item.postBalance.size === 0) continue;
      const effectMinute = ceilMinute(replayTimestampMs(item));
      if (effectMinute > endMinute) applyReplayBalances(this.balances, item);
    }
    this.lastAccruedMinuteMs = endMinute;
  }

  private chartPointLimit(): number {
    return Math.max(
      60,
      Math.min(10_080, Math.trunc(this.root.chartWindowMinutes ?? 1_440)),
    );
  }

  private appendChartPoint(point: ChartPoint): void {
    const previous = this.chart[this.chart.length - 1];
    if (previous?.atMs === point.atMs)
      this.chart[this.chart.length - 1] = point;
    else this.chart.push(point);
    const excess = this.chart.length - this.chartPointLimit();
    if (excess > 0) this.chart.splice(0, excess);
  }

  private buildHistoricalChart(
    history: Awaited<ReturnType<Solard["history"]["replay"]>>,
    market: MarketHistory,
    endMinute: number,
  ): void {
    this.chart.length = 0;
    const events = history.items.filter((item) => item.postBalance.size > 0);
    if (!events.length) return;
    const earliestEventMs = replayTimestampMs(events[0]!);
    const startMinute =
      this.config.gravityStartAtMs == null
        ? ceilMinute(earliestEventMs)
        : ceilMinute(this.config.gravityStartAtMs);
    if (startMinute > endMinute) return;
    const prices = minutePriceMap(market, startMinute, endMinute);
    const scheduled = events
      .map((item) => ({ item, minute: ceilMinute(replayTimestampMs(item)) }))
      .sort((left, right) =>
        left.minute === right.minute
          ? left.item.slot - right.item.slot
          : left.minute - right.minute,
      );
    const balances = new Map<string, bigint>();
    let eligibleTotalRaw = 0n;
    let eventIndex = 0;
    let gravityQ = 0n;
    let remainder = 0n;
    const baseDecimals = this.runtime.base.decimals;
    if (baseDecimals == null)
      throw new Error(`Token ${this.runtime.base.mint} has unknown decimals`);
    const denominator = 10n ** BigInt(baseDecimals);
    const quoteScale = 10n ** BigInt(this.runtime.quoteDecimals);
    const firstChartMinute = Math.max(
      startMinute,
      endMinute - (this.chartPointLimit() - 1) * MINUTE_MS,
    );
    const apply = (item: ReplayItem) => {
      for (const [owner, next] of item.postBalance) {
        const previous = balances.get(owner) ?? 0n;
        if (!this.excluded.has(owner)) eligibleTotalRaw += next - previous;
        if (next === 0n) balances.delete(owner);
        else balances.set(owner, next);
      }
    };
    for (let minute = startMinute; minute <= endMinute; minute += MINUTE_MS) {
      while (
        eventIndex < scheduled.length &&
        scheduled[eventIndex]!.minute <= minute
      ) {
        apply(scheduled[eventIndex]!.item);
        eventIndex += 1;
      }
      const priceQ = prices.get(minute)!;
      const numerator = eligibleTotalRaw * priceQ * quoteScale + remainder;
      gravityQ += numerator / denominator;
      remainder = numerator % denominator;
      if (minute >= firstChartMinute)
        this.chart.push({ atMs: minute, priceQ, gravityQ });
    }
    const correction = this.gravityTotal() - gravityQ;
    if (correction !== 0n) {
      for (const point of this.chart) {
        point.gravityQ += correction;
        if (point.gravityQ < 0n) point.gravityQ = 0n;
      }
    }
  }

  private async recordLiveMinute(minuteMs: number): Promise<void> {
    const excludeOwners = [
      this.runtime.treasuryAddress,
      ...(this.config.excludedOwners ?? []),
    ];
    const [snapshot, sampled] = await Promise.all([
      this.slrd.snapshotHolders(this.runtime.base.mint, {
        commitment: "finalized",
        excludeOwners,
        minimumRaw: 1n,
      }),
      this.slrd.samplePrice(this.runtime.base.mint),
    ]);
    const sampledQuote = sampled.quoteAsset.mint.toBase58();
    if (sampledQuote !== this.runtime.quoteMint) {
      throw new Error(
        `Quote asset changed for ${this.runtime.base.mint}: expected ${this.runtime.quoteMint}, got ${sampledQuote}`,
      );
    }
    const priceText = sampled.priceQuotePerToken.toString();
    const priceQ = decimalToScaled(priceText);
    if (priceQ <= 0n) {
      throw new Error(
        `Invalid live price ${priceText} for ${this.runtime.base.mint}`,
      );
    }
    await this.serial(async () => {
      this.balances.clear();
      this.holderAccounts.clear();
      for (const holder of snapshot.holders) {
        this.balances.set(holder.owner, holder.amountRaw);
        this.holderAccounts.set(holder.owner, [...holder.tokenAccounts]);
      }
      this.currentSupplyRaw = snapshot.supplyRaw;
      this.latestPriceQ = priceQ;
      this.latestPriceText = priceText;
      this.latestPriceAtMs = sampled.capturedAtMs;
      this.accrueMinute(priceQ);
      this.lastAccruedMinuteMs = minuteMs;
      this.appendChartPoint({
        atMs: minuteMs,
        priceQ,
        gravityQ: this.gravityTotal(),
      });
      await this.flushTreasuryDeposits();
    });
    emit({
      type: "minute",
      token: this.runtime.base.mint,
      minuteMs,
      slot: snapshot.slot,
      holders: snapshot.holders.length,
      price: priceText,
      quoteMint: this.runtime.quoteMint,
    });
    this.onChange(this, "minute");
  }

  private async treasuryLoop(): Promise<void> {
    const pollMs = Math.max(
      250,
      Math.trunc(this.config.treasuryPollMs ?? 2_000),
    );
    while (!this.signal.aborted && !this.stopped) {
      await this.serial(async () => {
        const current = await this.readTreasuryBalanceRaw();
        if (current > this.lastTreasuryBalanceRaw) {
          this.pendingTreasuryDeposits.push({
            amountRaw: current - this.lastTreasuryBalanceRaw,
            requiredMinuteMs: floorMinute(Date.now()),
            balanceAfterRaw: current,
          });
          this.lastTreasuryBalanceRaw = current;
        } else if (current < this.lastTreasuryBalanceRaw) {
          this.lastTreasuryBalanceRaw = current;
          this.saveRuntimeCheckpoint(current);
        }
        await this.flushTreasuryDeposits();
      });
      await sleep(pollMs, this.signal);
    }
  }

  private async minuteLoop(): Promise<void> {
    const graceMs = Math.max(
      0,
      Math.trunc(this.config.livePriceGraceMs ?? 12_000),
    );
    while (!this.signal.aborted && !this.stopped) {
      const now = Date.now();
      const minute = floorMinute(now) + MINUTE_MS;
      const delay = Math.max(0, minute + graceMs - now);
      await sleep(delay, this.signal);
      if (this.signal.aborted || this.stopped) break;
      await measure(`minute:${this.runtime.base.mint.slice(0, 8)}`, () =>
        this.recordLiveMinute(minute),
      );
    }
  }

  async bootstrap(): Promise<void> {
    this.runtime = await measure(
      `bootstrap:${this.config.mint.slice(0, 8)}`,
      async () => {
        const base = await ensureToken(this.slrd, this.config.mint);
        if (base.decimals == null)
          throw new Error(`Unknown decimals for ${base.mint}`);
        const sample = await this.slrd.samplePrice(base.mint);
        const quoteMint = sample.quoteAsset.mint.toBase58();
        if (
          !quoteMatches(
            this.config.quoteMint,
            quoteMint,
            sample.quoteAsset.kind === "native-sol",
          )
        )
          throw new Error(
            `Configured quote mint ${this.config.quoteMint} does not match market quote ${quoteMint} for ${base.mint}`,
          );
        const quoteDecimals = sample.quoteAsset.decimals;
        const treasuryAddress = walletAddress(this.slrd, this.config.treasury);
        const rewardWeight = this.config.rewardWeight ?? "pumpswap-buy-quote";
        if (
          rewardWeight === "pumpswap-buy-quote" &&
          sample.quoteAsset.kind !== "native-sol"
        ) {
          throw new Error(
            `Verified PumpSwap quote-spend accounting currently requires a native SOL quote for ${base.mint}; do not infer custom-quote spend from transfers`,
          );
        }
        const distributionId =
          this.config.distributionId ??
          `fairfun:${base.mint}:${rewardWeight}:v2`;
        let quoteSymbol = this.config.quoteSymbol?.trim() || "";
        if (!quoteSymbol) {
          if (sample.quoteAsset.kind === "native-sol") quoteSymbol = "SOL";
          else {
            try {
              quoteSymbol =
                this.slrd.resolveToken(quoteMint).symbol?.trim() ||
                shortAddress(quoteMint);
            } catch {
              quoteSymbol = shortAddress(quoteMint);
            }
          }
        }
        const initialPriceText = sample.priceQuotePerToken.toString();
        return {
          base,
          baseSymbol: base.symbol?.trim() || shortAddress(base.mint),
          quoteMint,
          quoteSymbol,
          quoteDecimals,
          quoteKind: sample.quoteAsset.kind,
          treasuryAddress,
          distributionId,
          asset: sample.quoteAsset.kind === "native-sol" ? "SOL" : quoteMint,
          initialPriceText,
          initialPriceQ: decimalToScaled(initialPriceText),
          initialPriceAtMs: sample.capturedAtMs,
          rewardWeight,
        };
      },
    );
    this.latestPriceQ = this.runtime.initialPriceQ;
    this.latestPriceText = this.runtime.initialPriceText;
    this.latestPriceAtMs = this.runtime.initialPriceAtMs;
    this.excluded.add(this.runtime.treasuryAddress);
    if (this.runtime.base.bondingCurve)
      this.excluded.add(this.runtime.base.bondingCurve);
    if (this.runtime.base.pool) this.excluded.add(this.runtime.base.pool);
    if (this.runtime.base.sharingConfig)
      this.excluded.add(this.runtime.base.sharingConfig);
    for (const owner of this.config.excludedOwners ?? [])
      this.excluded.add(owner);
    const checkpoint = this.checkpointRow();
    for (const [recipient, raw] of Object.entries(checkpoint.entitlements))
      this.entitlements.set(recipient, BigInt(raw));
    this.phase = "holder-history";
    emit({
      type: "bootstrap",
      token: this.runtime.base.mint,
      stage: "holder-history",
    });
    const history = await withHeartbeat({
      token: this.runtime.base.mint,
      stage: "Holder history",
      work: () =>
        measure(`history:${this.config.mint.slice(0, 8)}`, () =>
          this.slrd.history.replay(this.runtime.base.mint, {
            provider: "rpc",
            onProgress: (progress) => {
              if (
                progress.phase === "rpc-account-signatures" &&
                progress.total != null &&
                progress.completed !== progress.total &&
                progress.completed % 25 !== 0
              )
                return;
              if (
                (progress.phase === "rpc-mint-transactions" ||
                  progress.phase === "rpc-transactions") &&
                progress.total != null &&
                progress.completed !== progress.total &&
                progress.completed % 500 !== 0
              )
                return;
              emit({
                type: "holder-backfill",
                token: this.runtime.base.mint,
                ...progress,
              });
            },
          }),
        ),
    });
    if (!history.coverage.fromCreation || !history.coverage.complete)
      throw new Error(
        `Incomplete holder history for ${this.runtime.base.mint}: ${history.coverage.warnings.join("; ")}`,
      );
    emit({
      type: "holder-history-complete",
      token: this.runtime.base.mint,
      events: history.items.length,
      throughSlot: history.coverage.throughSlot,
    });
    this.phase = "market-history";
    emit({
      type: "bootstrap",
      token: this.runtime.base.mint,
      stage: "market-history",
    });
    const market = await this.slrd.history.market(this.runtime.base.mint, {
      backfill: true,
      onProgress: (progress) => {
        if (
          progress.phase === "transactions" &&
          progress.completed !== progress.total &&
          progress.completed % 500 !== 0
        )
          return;
        if (
          progress.phase === "parse" &&
          progress.completed !== progress.total &&
          progress.completed % 1000 !== 0
        )
          return;
        emit({
          type: "market-backfill",
          token: this.runtime.base.mint,
          ...progress,
        });
      },
    });
    if (!market.coverage.fromCreation || !market.coverage.complete)
      throw new Error(
        `Incomplete market history for ${this.runtime.base.mint}`,
      );
    if (market.quoteMint !== this.runtime.quoteMint)
      throw new Error(
        `Stored market quote ${market.quoteMint} does not match live quote ${this.runtime.quoteMint}`,
      );
    this.rebuildVerifiedPumpSwapAccounting();
    emit({
      type: "verified-pumpswap-history",
      token: this.runtime.base.mint,
      trades: this.verifiedPumpSwapTradeKeys.size,
      contributors: this.pumpSwapContribution.size,
      buyQuoteRaw: this.totalVerifiedPumpSwapBuyQuoteRaw().toString(),
      skippedInexact: this.verifiedPumpSwapSkippedInexact,
      throughMs: this.verifiedPumpSwapThroughMs,
    });
    const endMinute = floorMinute(Date.now()) - MINUTE_MS;
    this.phase = "gravity";
    emit({
      type: "bootstrap",
      token: this.runtime.base.mint,
      stage: "gravity",
    });
    this.historicalGravity(history, market, endMinute);
    this.buildHistoricalChart(history, market, endMinute);
    emit({
      type: "gravity-complete",
      token: this.runtime.base.mint,
      holders: [...this.gravity.values()].filter((row) => row.gravityQ > 0n)
        .length,
      throughMinuteMs: this.lastAccruedMinuteMs,
    });
    await this.persistDistributionPlan();
    this.phase = "treasury";
    emit({
      type: "bootstrap",
      token: this.runtime.base.mint,
      stage: "treasury",
    });
    const currentTreasuryBalanceRaw = await this.readTreasuryBalanceRaw();
    if (checkpoint.treasuryBalanceRaw == null) {
      this.lastTreasuryBalanceRaw = currentTreasuryBalanceRaw;
      this.saveRuntimeCheckpoint(currentTreasuryBalanceRaw);
    } else {
      const previousTreasuryBalanceRaw = BigInt(checkpoint.treasuryBalanceRaw);
      this.lastTreasuryBalanceRaw = currentTreasuryBalanceRaw;
      if (currentTreasuryBalanceRaw > previousTreasuryBalanceRaw) {
        this.pendingTreasuryDeposits.push({
          amountRaw: currentTreasuryBalanceRaw - previousTreasuryBalanceRaw,
          requiredMinuteMs: endMinute,
          balanceAfterRaw: currentTreasuryBalanceRaw,
        });
        await this.flushTreasuryDeposits();
      } else if (currentTreasuryBalanceRaw !== previousTreasuryBalanceRaw) {
        this.saveRuntimeCheckpoint(currentTreasuryBalanceRaw);
      }
    }
    const excludeOwners = [
      this.runtime.treasuryAddress,
      ...(this.config.excludedOwners ?? []),
    ];
    const [snapshot, currentPrice] = await Promise.all([
      this.slrd.snapshotHolders(this.runtime.base.mint, {
        commitment: "finalized",
        excludeOwners,
        minimumRaw: 1n,
      }),
      this.slrd.samplePrice(this.runtime.base.mint),
    ]);
    this.balances.clear();
    this.holderAccounts.clear();
    for (const holder of snapshot.holders) {
      this.balances.set(holder.owner, holder.amountRaw);
      this.holderAccounts.set(holder.owner, [...holder.tokenAccounts]);
    }
    this.currentSupplyRaw = snapshot.supplyRaw;
    this.latestPriceText = currentPrice.priceQuotePerToken.toString();
    this.latestPriceQ = decimalToScaled(this.latestPriceText);
    this.latestPriceAtMs = currentPrice.capturedAtMs;
    this.phase = "ready";
    emit({
      type: "token-ready",
      token: this.runtime.base.mint,
      quoteMint: this.runtime.quoteMint,
      treasury: this.runtime.treasuryAddress,
      holders: this.balances.size,
      gravityHolders: [...this.gravity.values()].filter(
        (row) => row.gravityQ > 0n,
      ).length,
      gravity: formatScaled(
        this.gravityTotal(),
        PRICE_SCALE_DIGITS + this.runtime.quoteDecimals,
      ),
      rewardStartedAtMs: checkpoint.rewardStartedAtMs,
      lastAccruedMinuteMs: this.lastAccruedMinuteMs,
      distributionId: this.runtime.distributionId,
    });
    this.onChange(this, "ready");
  }

  async run(): Promise<void> {
    await Promise.all([
      this.treasuryLoop(),
      this.minuteLoop(),
      this.verifiedPumpSwapLoop(),
    ]);
  }

  private async executeDistributionLocked(): Promise<void> {
    if (!liveGate())
      throw new Error(
        "Distribution requires SOLARD_ENABLE_LIVE_TRADES=1 or SLRD_ENABLE_LIVE_TRADES=1",
      );
    const state = await this.slrd.distributions.execute({
      id: this.runtime.distributionId,
      from: this.config.treasury,
      asset: this.runtime.asset,
      entitlements: sortedEntitlements(this.entitlements),
      reserveRaw: BigInt(this.config.reserveRaw ?? "0"),
      via: (this.root.sender ?? "rpc") as any,
    });
    this.lastTreasuryBalanceRaw = await this.readTreasuryBalanceRaw();
    this.saveRuntimeCheckpoint(this.lastTreasuryBalanceRaw);
    emit({
      type: "distribution",
      token: this.runtime.base.mint,
      distributionId: state.id,
      status: state.status,
      recipients: state.recipients.length,
      confirmedPaidRaw: state.recipients
        .reduce((sum, row) => sum + BigInt(row.confirmedPaidRaw), 0n)
        .toString(),
    });
    this.onChange(this, "distribution");
  }

  async distribute(): Promise<void> {
    await this.serial(() => this.executeDistributionLocked());
  }

  mint(): string {
    return this.config.mint;
  }

  publicState(wallet?: string) {
    const distribution = this.slrd.distributions.status(
      this.runtime.distributionId,
    );
    const paidByWallet = new Map(
      (distribution?.recipients ?? []).map((row) => [
        row.recipient,
        BigInt(row.confirmedPaidRaw),
      ]),
    );
    const totalGravityQ = this.gravityTotal();
    const baseDecimals = this.runtime.base.decimals ?? 0;
    const gravityDecimals = PRICE_SCALE_DIGITS + this.runtime.quoteDecimals;
    const holder = (address: string): PublicHolder => {
      const balanceRaw = this.balances.get(address) ?? 0n;
      const gravityQ = this.gravity.get(address)?.gravityQ ?? 0n;
      const contribution = this.pumpSwapContribution.get(address) ?? {
        buyQuoteRaw: 0n,
        sellQuoteRaw: 0n,
        boughtTokenRaw: 0n,
        soldTokenRaw: 0n,
        buys: 0,
        sells: 0,
      };
      const totalBuyQuoteRaw = this.totalVerifiedPumpSwapBuyQuoteRaw();
      const earnedRaw = this.entitlements.get(address) ?? 0n;
      const paidRaw = paidByWallet.get(address) ?? 0n;
      const outstandingRaw = earnedRaw > paidRaw ? earnedRaw - paidRaw : 0n;
      const valueQ =
        baseDecimals >= 0
          ? (balanceRaw * this.latestPriceQ) / 10n ** BigInt(baseDecimals)
          : 0n;
      return {
        wallet: address,
        tokenAccounts: this.holderAccounts.get(address) ?? [],
        balanceRaw: balanceRaw.toString(),
        balance: formatScaled(balanceRaw, baseDecimals),
        value: formatScaled(valueQ, PRICE_SCALE_DIGITS),
        gravity: formatScaled(gravityQ, gravityDecimals),
        gravitySharePct: percent(gravityQ, totalGravityQ),
        verifiedPumpSwapBuyQuoteRaw: contribution.buyQuoteRaw.toString(),
        verifiedPumpSwapBuyQuote: formatScaled(
          contribution.buyQuoteRaw,
          this.runtime.quoteDecimals,
        ),
        verifiedPumpSwapBuySharePct: percent(
          contribution.buyQuoteRaw,
          totalBuyQuoteRaw,
        ),
        verifiedPumpSwapBoughtTokenRaw: contribution.boughtTokenRaw.toString(),
        verifiedPumpSwapBuys: contribution.buys,
        verifiedPumpSwapSellQuoteRaw: contribution.sellQuoteRaw.toString(),
        verifiedPumpSwapSellQuote: formatScaled(
          contribution.sellQuoteRaw,
          this.runtime.quoteDecimals,
        ),
        verifiedPumpSwapSoldTokenRaw: contribution.soldTokenRaw.toString(),
        verifiedPumpSwapSells: contribution.sells,
        earnedRaw: earnedRaw.toString(),
        earned: formatScaled(earnedRaw, this.runtime.quoteDecimals),
        paidRaw: paidRaw.toString(),
        paid: formatScaled(paidRaw, this.runtime.quoteDecimals),
        outstandingRaw: outstandingRaw.toString(),
        outstanding: formatScaled(outstandingRaw, this.runtime.quoteDecimals),
        claimableRaw: outstandingRaw.toString(),
        claimable: formatScaled(outstandingRaw, this.runtime.quoteDecimals),
        now: balanceRaw > 0n,
      };
    };
    const holders = [...this.balances.keys()]
      .filter((address) => !this.excluded.has(address))
      .map(holder)
      .sort((left, right) => {
        const leftGravity = this.gravity.get(left.wallet)?.gravityQ ?? 0n;
        const rightGravity = this.gravity.get(right.wallet)?.gravityQ ?? 0n;
        return leftGravity === rightGravity
          ? left.wallet.localeCompare(right.wallet)
          : leftGravity > rightGravity
            ? -1
            : 1;
      });
    const totalEntitledRaw = [...this.entitlements.values()].reduce(
      (sum, value) => sum + value,
      0n,
    );
    const totalPaidRaw = [...paidByWallet.values()].reduce(
      (sum, value) => sum + value,
      0n,
    );
    const totalOutstandingRaw =
      totalEntitledRaw > totalPaidRaw ? totalEntitledRaw - totalPaidRaw : 0n;
    const marketCapQ =
      (this.currentSupplyRaw * this.latestPriceQ) / 10n ** BigInt(baseDecimals);
    const twentyFourHoursAgo = Date.now() - 24 * 60 * MINUTE_MS;
    const previousPrice =
      this.chart.find((point) => point.atMs >= twentyFourHoursAgo)?.priceQ ??
      this.chart[0]?.priceQ ??
      0n;
    const requestedWallet = wallet?.trim() || null;
    const walletState = requestedWallet ? holder(requestedWallet) : null;
    return {
      version: 1,
      mint: this.runtime.base.mint,
      pair: `${this.runtime.baseSymbol}/${this.runtime.quoteSymbol}`,
      symbol: this.runtime.baseSymbol,
      quoteMint: this.runtime.quoteMint,
      quoteSymbol: this.runtime.quoteSymbol,
      active: this.phase === "ready" && !this.stopped,
      phase: this.phase,
      price: {
        value: this.latestPriceText,
        quoteSymbol: this.runtime.quoteSymbol,
        capturedAtMs: this.latestPriceAtMs,
        change24hPct: priceChangePct(this.latestPriceQ, previousPrice),
      },
      marketCap: {
        value: formatScaled(marketCapQ, PRICE_SCALE_DIGITS),
        quoteSymbol: this.runtime.quoteSymbol,
      },
      supply: {
        raw: this.currentSupplyRaw.toString(),
        value: formatScaled(this.currentSupplyRaw, baseDecimals),
      },
      holderCount: holders.length,
      gravity: {
        value: formatScaled(totalGravityQ, gravityDecimals),
        unit: `${this.runtime.quoteSymbol}·min`,
        throughMinuteMs: this.lastAccruedMinuteMs,
      },
      verifiedPumpSwap: {
        source: "canonical-pump-amm-instructions",
        confidence: "finalized",
        exactQuoteOnly: true,
        trades: this.verifiedPumpSwapTradeKeys.size,
        contributors: this.pumpSwapContribution.size,
        totalBuyQuoteRaw: this.totalVerifiedPumpSwapBuyQuoteRaw().toString(),
        totalBuyQuote: formatScaled(
          this.totalVerifiedPumpSwapBuyQuoteRaw(),
          this.runtime.quoteDecimals,
        ),
        totalSellQuoteRaw: this.totalVerifiedPumpSwapSellQuoteRaw().toString(),
        totalSellQuote: formatScaled(
          this.totalVerifiedPumpSwapSellQuoteRaw(),
          this.runtime.quoteDecimals,
        ),
        skippedInexact: this.verifiedPumpSwapSkippedInexact,
        throughMs: this.verifiedPumpSwapThroughMs,
      },
      rewards: {
        weightMode: this.runtime.rewardWeight,
        rewardStartedAtMs: this.checkpointRow().rewardStartedAtMs,
        depositedRaw: totalEntitledRaw.toString(),
        deposited: formatScaled(totalEntitledRaw, this.runtime.quoteDecimals),
        paidRaw: totalPaidRaw.toString(),
        paid: formatScaled(totalPaidRaw, this.runtime.quoteDecimals),
        outstandingRaw: totalOutstandingRaw.toString(),
        outstanding: formatScaled(
          totalOutstandingRaw,
          this.runtime.quoteDecimals,
        ),
        assetMint: this.runtime.quoteMint,
        assetSymbol: this.runtime.quoteSymbol,
      },
      treasury: {
        wallet: this.runtime.treasuryAddress,
        balanceRaw: this.lastTreasuryBalanceRaw.toString(),
        balance: formatScaled(
          this.lastTreasuryBalanceRaw,
          this.runtime.quoteDecimals,
        ),
      },
      distribution: distribution
        ? {
            id: distribution.id,
            status: distribution.status,
            pendingSignature: distribution.pending?.signature ?? null,
            lastError: distribution.lastError,
            uncertainReason: distribution.uncertainReason,
            updatedAtMs: distribution.updatedAtMs,
          }
        : null,
      chart: this.chart.map((point) => ({
        atMs: point.atMs,
        price: formatScaled(point.priceQ, PRICE_SCALE_DIGITS),
        gravity: formatScaled(point.gravityQ, gravityDecimals),
      })),
      holders,
      wallet: walletState,
    };
  }

  status() {
    const state = this.publicState();
    return {
      token: state.mint,
      pair: state.pair,
      phase: state.phase,
      holders: state.holderCount,
      price: state.price,
      gravity: state.gravity,
      rewards: state.rewards,
      distribution: state.distribution,
      lastAccruedMinuteMs: this.lastAccruedMinuteMs,
    };
  }

  stop(): void {
    this.stopped = true;
  }
}

class StateHub {
  private readonly clients = new Set<
    ReadableStreamDefaultController<Uint8Array>
  >();
  private readonly encoder = new TextEncoder();

  private packet(event: string, value: unknown): Uint8Array {
    return this.encoder.encode(
      `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`,
    );
  }

  publish(reason: string, engine: TokenEngine): void {
    const packet = this.packet("token", {
      reason,
      token: engine.mint(),
      state: engine.publicState(),
    });
    for (const client of [...this.clients]) {
      try {
        client.enqueue(packet);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  stream(engines: readonly TokenEngine[]): ReadableStream<Uint8Array> {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        controllerRef = controller;
        this.clients.add(controller);
        controller.enqueue(
          this.packet("snapshot", {
            tokens: engines.map((engine) => engine.publicState()),
          }),
        );
      },
      cancel: () => {
        if (controllerRef) this.clients.delete(controllerRef);
      },
    });
  }
}

function corsHeaders(config: Config): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": config.http?.corsOrigin ?? "*",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function jsonResponse(config: Config, value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(config),
    },
  });
}

function startHttpServer(
  config: Config,
  engines: readonly TokenEngine[],
  hub: StateHub,
) {
  if (config.http?.enabled === false) return null;
  const hostname = config.http?.host ?? "127.0.0.1";
  const port = Math.max(
    1,
    Math.min(65_535, Math.trunc(config.http?.port ?? 8787)),
  );
  const byMint = new Map(engines.map((engine) => [engine.mint(), engine]));
  const adminTokenEnv = config.http?.adminTokenEnv ?? "FAIRFUN_ADMIN_TOKEN";
  const server = Bun.serve({
    hostname,
    port,
    async fetch(request) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(config),
        });
      }
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse(config, {
          ok: true,
          tokens: engines.length,
          atMs: Date.now(),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/tokens") {
        return jsonResponse(config, {
          tokens: engines.map((engine) => engine.publicState()),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/stream") {
        return new Response(hub.stream(engines), {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            ...corsHeaders(config),
          },
        });
      }
      const match = url.pathname.match(
        /^\/api\/tokens\/([^/]+)(?:\/(distribute))?$/,
      );
      if (!match) return jsonResponse(config, { error: "not found" }, 404);
      const mint = decodeURIComponent(match[1]!);
      const engine = byMint.get(mint);
      if (!engine) return jsonResponse(config, { error: "unknown token" }, 404);
      if (request.method === "GET" && !match[2]) {
        return jsonResponse(
          config,
          engine.publicState(url.searchParams.get("wallet") ?? undefined),
        );
      }
      if (request.method === "POST" && match[2] === "distribute") {
        const expected = process.env[adminTokenEnv]?.trim();
        if (!expected) {
          return jsonResponse(
            config,
            {
              error: `${adminTokenEnv} is not configured; HTTP distribution is disabled`,
            },
            403,
          );
        }
        const authorization = request.headers.get("authorization") ?? "";
        if (authorization !== `Bearer ${expected}`) {
          return jsonResponse(config, { error: "unauthorized" }, 401);
        }
        try {
          await engine.distribute();
          return jsonResponse(config, engine.publicState());
        } catch (error) {
          return jsonResponse(
            config,
            { error: error instanceof Error ? error.message : String(error) },
            500,
          );
        }
      }
      return jsonResponse(config, { error: "method not allowed" }, 405);
    },
  });
  emit({
    type: "server",
    url: `http://${hostname}:${server.port}`,
    stream: `http://${hostname}:${server.port}/api/stream`,
  });
  return server;
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const configPath = resolve(required(flags, "config"));
  const config = loadConfig(configPath);
  if (config.dbPath && !process.env.SLRD_DB_PATH)
    process.env.SLRD_DB_PATH = resolve(config.dbPath);
  if (config.rpcUrl && !process.env.RPC_ENDPOINT)
    process.env.RPC_ENDPOINT = config.rpcUrl;
  const rpcUrl =
    config.rpcUrl ??
    process.env.RPC_ENDPOINT ??
    process.env.SOLANA_RPC_URL ??
    process.env.HELIUS_RPC_URL;
  if (!rpcUrl)
    throw new Error("Fairfun requires config.rpcUrl or RPC_ENDPOINT");
  const connection = new Connection(rpcUrl, "finalized");
  const checkpointPath = resolve(dirname(configPath), config.checkpoint);
  const checkpoint = loadCheckpoint(checkpointPath);
  emit({ type: "startup", config: configPath, tokens: config.tokens.length });
  const slrd = createSolard({ rpcUrl: config.rpcUrl, dbPath: config.dbPath });
  const controller = new AbortController();
  const hub = new StateHub();
  const engines = config.tokens.map(
    (token) =>
      new TokenEngine(
        slrd,
        connection,
        config,
        token,
        checkpointPath,
        checkpoint,
        controller.signal,
        (engine, reason) => hub.publish(reason, engine),
      ),
  );
  let server: ReturnType<typeof Bun.serve> | null = null;
  try {
    for (const engine of engines) await engine.bootstrap();
    server = startHttpServer(config, engines, hub);
    emit({ type: "ready", tokens: engines.length });
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
    readline.on("line", (line: string) => {
      const [command, token] = line.trim().split(/\s+/, 2);
      if (command === "status") {
        process.stdout.write(
          `${JSON.stringify(
            engines.map((engine) => engine.status()),
            null,
            2,
          )}\n`,
        );
      } else if (command === "distribute") {
        const selected = token
          ? engines.filter((engine) => engine.status().token === token)
          : engines;
        void Promise.all(selected.map((engine) => engine.distribute())).catch(
          (error) =>
            process.stderr.write(
              `${error instanceof Error ? error.message : String(error)}\n`,
            ),
        );
      } else if (command === "quit" || command === "exit") {
        controller.abort();
        for (const engine of engines) engine.stop();
        readline.close();
      }
    });
    const stop = () => {
      controller.abort();
      for (const engine of engines) engine.stop();
      readline.close();
      void server?.stop(true);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await Promise.all(engines.map((engine) => engine.run()));
  } finally {
    await server?.stop(true);
    slrd.close();
  }
}

await main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
