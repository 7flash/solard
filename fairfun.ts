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
import { NATIVE_MINT } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  getTokenHistoryCoverage,
  loadTokenHistoryTrades,
  subscribeTokenEvents,
  type SolardTokenSwapEvent,
  type TokenHistoryTrade,
} from "@solard/core";
import {
  createSolard,
  type CumulativeEntitlement,
  type ReplayHistory,
  type ReplayItem,
  type Solard,
  type TokenRow,
} from "@solard/sdk";

type FeeContributionMode = "total" | "creator" | "protocol" | "lp";
type DistributionKind = "reward" | "bonus";

type TokenConfig = {
  mint: string;

  // Ordinary reward deposits. Each finalized observed deposit is allocated
  // by current eligible token balance.
  treasury: string;
  distributionId?: string;

  // Optional protocol/fee-gravity bonus vault. Keep this separate from
  // `treasury`, otherwise FairFun cannot know which economics a deposit uses.
  bonusTreasury?: string;
  bonusDistributionId?: string;

  quoteMint?: string;
  quoteSymbol?: string;

  // Which exact PumpSwap buy-fee component becomes active fee basis.
  // "total" = LP + protocol + creator. Holder-reward/cashback fields are not
  // added again because they can represent routing of creator-fee economics.
  feeContribution?: FeeContributionMode;

  excludedOwners?: string[];
  reserveRaw?: string;
  bonusReserveRaw?: string;

  autoDistributeRaw?: string;
  autoDistributeBonusRaw?: string;

  treasuryPollMs?: number;
  holderPollMs?: number;
  pricePollMs?: number;

  // Fail closed when historical PumpSwap buys exist without an exact fee event.
  requireExactPumpSwapFees?: boolean;
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
  tokens: TokenConfig[];
};

type TokenCheckpoint = {
  rewardTreasuryBalanceRaw?: string;
  bonusTreasuryBalanceRaw?: string;
  rewardEntitlements: Record<string, string>;
  bonusEntitlements: Record<string, string>;

  // Compatibility with the previous FairFun checkpoint.
  treasuryBalanceRaw?: string;
  entitlements?: Record<string, string>;
};

type Checkpoint = {
  version: 1;
  tokens: Record<string, TokenCheckpoint>;
};

type RuntimeToken = {
  base: TokenRow;
  quoteMint: string;
  quoteSymbol: string;
  quoteDecimals: number;
  quoteKind: "native-sol" | "spl-token";
  rewardTreasuryAddress: string;
  bonusTreasuryAddress: string | null;
  rewardDistributionId: string;
  bonusDistributionId: string | null;
  asset: "SOL" | string;
  feeContribution: FeeContributionMode;
};

type FeeInventoryRow = {
  balanceRaw: bigint;
  activeFeeBasisRaw: bigint;
  feeGravityRawMs: bigint;
  lastAtMs: number;
  exactBuyFeesRaw: bigint;
  exactBuyQuoteRaw: bigint;
  buyCount: number;
};

type PublicHolder = {
  wallet: string;
  tokenAccounts: string[];
  balanceRaw: string;
  balance: string;

  activeFeeBasisRaw: string;
  activeFeeBasis: string;
  feeGravityRawMs: string;
  feeGravityQuoteMinutes: string;
  feeGravitySharePct: number;

  exactPumpSwapBuyFeesRaw: string;
  exactPumpSwapBuyFees: string;
  exactPumpSwapBuyQuoteRaw: string;
  exactPumpSwapBuyQuote: string;
  exactPumpSwapBuys: number;

  rewardEarnedRaw: string;
  rewardPaidRaw: string;
  rewardOutstandingRaw: string;

  bonusEarnedRaw: string;
  bonusPaidRaw: string;
  bonusOutstandingRaw: string;
};

const NATIVE_SOL_MINT = NATIVE_MINT.toBase58();

function emit(value: unknown): void {
  process.stdout.write(
    `${JSON.stringify(value, (_, item) =>
      typeof item === "bigint" ? item.toString() : item,
    )}\n`,
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Config;
  if (parsed.version !== 1) throw new Error("FairFun config version must be 1");
  if (!parsed.tokens?.length) throw new Error("Config contains no tokens");
  return parsed;
}

function loadCheckpoint(path: string): Checkpoint {
  if (!existsSync(path)) return { version: 1, tokens: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Checkpoint;
  if (parsed.version !== 1)
    throw new Error(`Unsupported checkpoint version ${String(parsed.version)}`);
  return parsed;
}

function saveCheckpoint(path: string, value: Checkpoint): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

function formatRaw(value: bigint, decimals: number): string {
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

function pct(numerator: bigint, denominator: bigint): number {
  if (numerator <= 0n || denominator <= 0n) return 0;
  return Number((numerator * 1_000_000n) / denominator) / 10_000;
}

function replayAtMs(item: ReplayItem): number {
  if (item.timestampSec == null)
    throw new Error(`Replay item ${item.id} has no block timestamp`);
  return item.timestampSec * 1_000;
}

function liveGate(): boolean {
  return [
    process.env.SOLARD_ENABLE_LIVE_TRADES,
    process.env.SLRD_ENABLE_LIVE_TRADES,
  ].some((value) => /^(1|true|yes)$/i.test(value?.trim() ?? ""));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const abort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(undefined);
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function walletAddress(slrd: Solard, ref: string): string {
  const clean = ref.startsWith("@") ? ref.slice(1) : ref;
  const rows = slrd.listWallets();
  const byAddress = rows.find((row) => row.address === clean);
  if (byAddress) return byAddress.address;
  const byName = rows.find((row) => row.name === clean);
  if (byName) return byName.address;
  throw new Error(`Wallet ${ref} is not in the Solard wallet registry`);
}

async function ensureToken(slrd: Solard, mint: string): Promise<TokenRow> {
  try {
    return slrd.resolveToken(mint);
  } catch {
    return await slrd.addToken(mint);
  }
}

function sortedEntitlements(
  values: ReadonlyMap<string, bigint>,
): CumulativeEntitlement[] {
  return [...values]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([recipient, entitledRaw]) => ({ recipient, entitledRaw }));
}

function largestRemainderAllocation(
  amountRaw: bigint,
  weights: readonly { recipient: string; weight: bigint }[],
): Array<{ recipient: string; amountRaw: bigint }> {
  if (amountRaw <= 0n) return [];
  const positive = weights.filter((row) => row.weight > 0n);
  const total = positive.reduce((sum, row) => sum + row.weight, 0n);
  if (total <= 0n) return [];

  const rows = positive.map((row) => {
    const numerator = amountRaw * row.weight;
    return {
      recipient: row.recipient,
      amountRaw: numerator / total,
      remainder: numerator % total,
    };
  });

  let assigned = rows.reduce((sum, row) => sum + row.amountRaw, 0n);
  let residual = amountRaw - assigned;

  rows.sort((left, right) => {
    if (left.remainder === right.remainder)
      return left.recipient.localeCompare(right.recipient);
    return left.remainder > right.remainder ? -1 : 1;
  });

  for (let index = 0; residual > 0n; index += 1) {
    rows[index % rows.length]!.amountRaw += 1n;
    residual -= 1n;
  }

  return rows
    .filter((row) => row.amountRaw > 0n)
    .map(({ recipient, amountRaw }) => ({ recipient, amountRaw }));
}

function exactPumpSwapBuyFeeRaw(
  trade: TokenHistoryTrade,
  mode: FeeContributionMode,
): bigint | null {
  if (trade.side !== "buy") return null;
  const fees = trade.history.pumpSwapFees;
  if (!fees || fees.source !== "anchor-event") return null;

  const lp = BigInt(fees.lpFeeQuoteRaw);
  const protocol = BigInt(fees.protocolFeeQuoteRaw);
  const creator =
    fees.creatorFeeQuoteRaw == null ? null : BigInt(fees.creatorFeeQuoteRaw);

  if (mode === "lp") return lp;
  if (mode === "protocol") return protocol;
  if (mode === "creator") return creator;
  if (creator == null) return null;

  // Pump documents LP + protocol + creator as the primary trade-fee components.
  // Do not add holderRewards/cashback again: those can represent creator-fee routing.
  return lp + protocol + creator;
}

function exactLivePumpSwapBuyFeeRaw(
  event: SolardTokenSwapEvent,
  mode: FeeContributionMode,
): bigint | null {
  if (event.side !== "buy" || event.venue !== "pumpswap" || !event.fees)
    return null;
  const fees = event.fees;
  if (mode === "lp") return fees.lpFeeQuoteRaw;
  if (mode === "protocol") return fees.protocolFeeQuoteRaw;
  if (mode === "creator") return fees.creatorFeeQuoteRaw;
  if (fees.creatorFeeQuoteRaw == null) return null;
  return (
    fees.lpFeeQuoteRaw + fees.protocolFeeQuoteRaw + fees.creatorFeeQuoteRaw
  );
}

function historicalTradeIdentity(trade: TokenHistoryTrade): string {
  return `${trade.signature}:${trade.owner ?? ""}:${trade.side}`;
}

function liveTradeIdentity(event: SolardTokenSwapEvent): string {
  return `${event.signature}:${event.trader ?? ""}:${event.side}`;
}

function replayOwnerDelta(items: readonly ReplayItem[], owner: string): bigint {
  let total = 0n;
  for (const item of items) {
    const before = item.beforeBalance.get(owner);
    const post = item.postBalance.get(owner);
    if (before == null || post == null) continue;
    total += BigInt(post) - BigInt(before);
  }
  return total;
}

class TokenEngine {
  private runtime!: RuntimeToken;

  private readonly balances = new Map<string, bigint>();
  private readonly holderAccounts = new Map<string, string[]>();
  private readonly feeInventory = new Map<string, FeeInventoryRow>();
  private readonly exactTradeIds = new Set<string>();

  private readonly rewardEntitlements = new Map<string, bigint>();
  private readonly bonusEntitlements = new Map<string, bigint>();
  private readonly excluded = new Set<string>();

  private rewardTreasuryBalanceRaw = 0n;
  private bonusTreasuryBalanceRaw = 0n;

  private exactPumpSwapBuys = 0;
  private missingExactPumpSwapFees = 0;
  private rejectedPumpSwapTrades = 0;
  private feeHistoryThroughMs = 0;

  private latestPrice: {
    value: string | null;
    capturedAtMs: number | null;
    error: string | null;
  } = {
    value: null,
    capturedAtMs: null,
    error: null,
  };

  private phase = "starting";
  private stopped = false;
  private queue: Promise<unknown> = Promise.resolve();

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

  mint(): string {
    return this.config.mint;
  }

  private serial<T>(operation: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private checkpointRow(): TokenCheckpoint {
    let row = this.checkpoint.tokens[this.config.mint];
    if (!row) {
      row = {
        rewardEntitlements: {},
        bonusEntitlements: {},
      };
      this.checkpoint.tokens[this.config.mint] = row;
    }

    // One-time migration from the previous FairFun script.
    if (
      Object.keys(row.rewardEntitlements ?? {}).length === 0 &&
      row.entitlements
    ) {
      row.rewardEntitlements = { ...row.entitlements };
    }
    if (
      row.rewardTreasuryBalanceRaw == null &&
      row.treasuryBalanceRaw != null
    ) {
      row.rewardTreasuryBalanceRaw = row.treasuryBalanceRaw;
    }
    row.rewardEntitlements ??= {};
    row.bonusEntitlements ??= {};
    return row;
  }

  private saveCheckpoint(): void {
    const row = this.checkpointRow();
    row.rewardTreasuryBalanceRaw = this.rewardTreasuryBalanceRaw.toString();
    if (this.runtime.bonusTreasuryAddress)
      row.bonusTreasuryBalanceRaw = this.bonusTreasuryBalanceRaw.toString();

    row.rewardEntitlements = Object.fromEntries(
      [...this.rewardEntitlements]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([wallet, value]) => [wallet, value.toString()]),
    );
    row.bonusEntitlements = Object.fromEntries(
      [...this.bonusEntitlements]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([wallet, value]) => [wallet, value.toString()]),
    );
    saveCheckpoint(this.checkpointPath, this.checkpoint);
  }

  private feeRow(owner: string, atMs: number): FeeInventoryRow {
    let row = this.feeInventory.get(owner);
    if (!row) {
      row = {
        balanceRaw: 0n,
        activeFeeBasisRaw: 0n,
        feeGravityRawMs: 0n,
        lastAtMs: atMs,
        exactBuyFeesRaw: 0n,
        exactBuyQuoteRaw: 0n,
        buyCount: 0,
      };
      this.feeInventory.set(owner, row);
    }
    return row;
  }

  private settleFeeRow(row: FeeInventoryRow, atMs: number): void {
    if (atMs <= row.lastAtMs) return;
    if (row.activeFeeBasisRaw > 0n)
      row.feeGravityRawMs +=
        row.activeFeeBasisRaw * BigInt(atMs - row.lastAtMs);
    row.lastAtMs = atMs;
  }

  private settleAllFeeGravity(atMs: number): void {
    for (const row of this.feeInventory.values()) this.settleFeeRow(row, atMs);
  }

  private applyBalanceToFeeInventory(
    owner: string,
    nextBalanceRaw: bigint,
    atMs: number,
  ): void {
    if (this.excluded.has(owner)) return;
    const row = this.feeRow(owner, atMs);
    this.settleFeeRow(row, atMs);

    const previous = row.balanceRaw;
    if (nextBalanceRaw < previous && previous > 0n) {
      // Disposal destroys contribution basis and already accumulated Fee Gravity
      // in the same proportion as the inventory that left the wallet.
      row.activeFeeBasisRaw =
        (row.activeFeeBasisRaw * nextBalanceRaw) / previous;
      row.feeGravityRawMs = (row.feeGravityRawMs * nextBalanceRaw) / previous;
    }

    // Incoming ordinary transfers/mints add tokens but no new fee basis.
    // This naturally dilutes fee basis per token.
    row.balanceRaw = nextBalanceRaw;
  }

  private addExactBuyContribution(
    owner: string,
    tokenAmountRaw: bigint,
    quoteAmountRaw: bigint,
    feeRaw: bigint,
    atMs: number,
  ): void {
    if (
      this.excluded.has(owner) ||
      tokenAmountRaw <= 0n ||
      quoteAmountRaw <= 0n ||
      feeRaw < 0n
    )
      return;

    const row = this.feeRow(owner, atMs);
    this.settleFeeRow(row, atMs);
    row.activeFeeBasisRaw += feeRaw;
    row.exactBuyFeesRaw += feeRaw;
    row.exactBuyQuoteRaw += quoteAmountRaw;
    row.buyCount += 1;
    this.exactPumpSwapBuys += 1;
  }

  private feeGravityTotal(atMs = Date.now()): bigint {
    this.settleAllFeeGravity(atMs);
    let total = 0n;
    for (const [owner, row] of this.feeInventory) {
      if (!this.excluded.has(owner) && row.feeGravityRawMs > 0n)
        total += row.feeGravityRawMs;
    }
    return total;
  }

  private activeFeeBasisTotal(atMs = Date.now()): bigint {
    this.settleAllFeeGravity(atMs);
    let total = 0n;
    for (const [owner, row] of this.feeInventory) {
      if (!this.excluded.has(owner) && row.activeFeeBasisRaw > 0n)
        total += row.activeFeeBasisRaw;
    }
    return total;
  }

  private balanceWeights(): Array<{ recipient: string; weight: bigint }> {
    return [...this.balances]
      .filter(([owner, balance]) => balance > 0n && !this.excluded.has(owner))
      .map(([recipient, weight]) => ({ recipient, weight }));
  }

  private feeGravityWeights(
    atMs: number,
  ): Array<{ recipient: string; weight: bigint }> {
    this.settleAllFeeGravity(atMs);
    return [...this.feeInventory]
      .filter(
        ([owner, row]) => !this.excluded.has(owner) && row.feeGravityRawMs > 0n,
      )
      .map(([recipient, row]) => ({
        recipient,
        weight: row.feeGravityRawMs,
      }));
  }

  private applyAllocations(
    target: Map<string, bigint>,
    allocations: readonly { recipient: string; amountRaw: bigint }[],
  ): void {
    for (const row of allocations) {
      target.set(
        row.recipient,
        (target.get(row.recipient) ?? 0n) + row.amountRaw,
      );
    }
  }

  private async readTreasuryBalanceRaw(address: string): Promise<bigint> {
    const owner = new PublicKey(address);

    if (this.runtime.quoteKind === "native-sol")
      return BigInt(await this.connection.getBalance(owner, "finalized"));

    const accounts = await this.connection.getParsedTokenAccountsByOwner(
      owner,
      { mint: new PublicKey(this.runtime.quoteMint) },
      "finalized",
    );
    let total = 0n;
    for (const row of accounts.value) {
      const amount = (row.account.data as any)?.parsed?.info?.tokenAmount
        ?.amount;
      if (typeof amount === "string") total += BigInt(amount);
    }
    return total;
  }

  private async refreshFinalizedHolders(atMs = Date.now()): Promise<void> {
    const snapshot = await this.slrd.snapshotHolders(this.runtime.base.mint, {
      commitment: "finalized",
      excludeOwners: [...this.excluded],
      minimumRaw: 1n,
    });

    const next = new Map(
      snapshot.holders.map(
        (holder) => [holder.owner, holder.amountRaw] as const,
      ),
    );
    const owners = new Set([...this.balances.keys(), ...next.keys()]);

    for (const ownerValue of owners) {
      const owner = String(ownerValue);
      const balance = BigInt(String(next.get(ownerValue) ?? 0));
      this.applyBalanceToFeeInventory(owner, balance, atMs);
      if (balance === 0n) this.balances.delete(owner);
      else this.balances.set(owner, balance);
    }

    this.holderAccounts.clear();
    for (const holder of snapshot.holders)
      this.holderAccounts.set(holder.owner, [...holder.tokenAccounts]);
  }

  private historicalFeeAccounting(
    replay: ReplayHistory,
    trades: readonly TokenHistoryTrade[],
  ): void {
    this.feeInventory.clear();
    this.exactTradeIds.clear();
    this.exactPumpSwapBuys = 0;
    this.missingExactPumpSwapFees = 0;
    this.rejectedPumpSwapTrades = 0;
    this.feeHistoryThroughMs = 0;

    const relevant = trades.filter(
      (trade) =>
        trade.mint === this.runtime.base.mint &&
        trade.confidence === "finalized" &&
        trade.history.venue === "pumpswap" &&
        trade.source === "history:pumpswap" &&
        trade.side === "buy" &&
        trade.owner != null,
    );

    const bySignature = new Map<string, TokenHistoryTrade[]>();
    for (const trade of relevant) {
      const list = bySignature.get(trade.signature) ?? [];
      list.push(trade);
      bySignature.set(trade.signature, list);
    }

    const ordered = [...replay.items].sort((left, right) => {
      return (
        left.slot - right.slot ||
        (left.transactionIndex ?? Number.MAX_SAFE_INTEGER) -
          (right.transactionIndex ?? Number.MAX_SAFE_INTEGER) ||
        (left.instructionIndex ?? Number.MAX_SAFE_INTEGER) -
          (right.instructionIndex ?? Number.MAX_SAFE_INTEGER) ||
        left.signature.localeCompare(right.signature) ||
        left.id.localeCompare(right.id)
      );
    });

    let index = 0;
    while (index < ordered.length) {
      const signature = ordered[index]!.signature;
      const group: ReplayItem[] = [];
      while (
        index < ordered.length &&
        ordered[index]!.signature === signature
      ) {
        group.push(ordered[index++]!);
      }

      const atMs = Math.max(...group.map(replayAtMs));

      for (const item of group) {
        for (const [owner, nextBalance] of item.postBalance)
          this.applyBalanceToFeeInventory(owner, nextBalance, atMs);
      }

      for (const trade of bySignature.get(signature) ?? []) {
        const owner = trade.owner!;
        const tradeId = historicalTradeIdentity(trade);
        if (this.exactTradeIds.has(tradeId)) continue;

        const tokenDeltaRaw = BigInt(trade.history.ownerTokenDeltaRaw);
        const replayDelta = replayOwnerDelta(group, owner);
        const feeRaw = exactPumpSwapBuyFeeRaw(
          trade,
          this.runtime.feeContribution,
        );

        if (
          tokenDeltaRaw <= 0n ||
          replayDelta <= 0n ||
          replayDelta !== tokenDeltaRaw
        ) {
          this.rejectedPumpSwapTrades += 1;
          continue;
        }

        if (feeRaw == null) {
          this.missingExactPumpSwapFees += 1;
          continue;
        }

        const fees = trade.history.pumpSwapFees!;
        if (fees.quoteMint !== this.runtime.quoteMint) {
          this.rejectedPumpSwapTrades += 1;
          continue;
        }
        const quoteAmountRaw = BigInt(fees.userQuoteAmountRaw);
        if (quoteAmountRaw <= 0n) {
          this.rejectedPumpSwapTrades += 1;
          continue;
        }

        this.addExactBuyContribution(
          owner,
          tokenDeltaRaw,
          quoteAmountRaw,
          feeRaw,
          trade.tradedAtMs,
        );
        this.exactTradeIds.add(tradeId);
        this.feeHistoryThroughMs = Math.max(
          this.feeHistoryThroughMs,
          trade.tradedAtMs,
        );
      }
    }

    if (
      (this.config.requireExactPumpSwapFees ?? true) &&
      this.missingExactPumpSwapFees > 0
    ) {
      throw new Error(
        `${this.missingExactPumpSwapFees} finalized PumpSwap buy(s) for ${this.runtime.base.mint} lack exact AMM fee events. ` +
          `After installing the Solard exact-fee patch, rebuild with: slrd token backfill ${this.runtime.base.mint} --replace`,
      );
    }
  }

  private async ensureExactFeeHistory(): Promise<readonly TokenHistoryTrade[]> {
    let trades = loadTokenHistoryTrades(this.runtime.base.mint);
    const hasPumpSwapBuy = trades.some(
      (trade) =>
        trade.confidence === "finalized" &&
        trade.history.venue === "pumpswap" &&
        trade.side === "buy",
    );
    const missing = trades.some(
      (trade) =>
        trade.confidence === "finalized" &&
        trade.history.venue === "pumpswap" &&
        trade.side === "buy" &&
        !trade.history.pumpSwapFees,
    );

    if (hasPumpSwapBuy && missing) {
      emit({
        type: "market-history-rebuild",
        token: this.runtime.base.mint,
        reason: "stored PumpSwap trades predate exact-fee parser",
      });
      await this.slrd.history.market(this.runtime.base.mint, {
        backfill: true,
        replace: true,
      });
      trades = loadTokenHistoryTrades(this.runtime.base.mint);
    }
    return trades;
  }

  private async persistPlan(kind: DistributionKind) {
    if (kind === "reward") {
      return await this.slrd.distributions.plan({
        id: this.runtime.rewardDistributionId,
        from: this.config.treasury,
        asset: this.runtime.asset,
        entitlements: sortedEntitlements(this.rewardEntitlements),
        reserveRaw: BigInt(this.config.reserveRaw ?? "0"),
      });
    }

    if (!this.config.bonusTreasury || !this.runtime.bonusDistributionId)
      throw new Error("Bonus treasury is not configured");

    return await this.slrd.distributions.plan({
      id: this.runtime.bonusDistributionId,
      from: this.config.bonusTreasury,
      asset: this.runtime.asset,
      entitlements: sortedEntitlements(this.bonusEntitlements),
      reserveRaw: BigInt(this.config.bonusReserveRaw ?? "0"),
    });
  }

  private async handleDeposit(
    kind: DistributionKind,
    amountRaw: bigint,
    balanceAfterRaw: bigint,
  ): Promise<void> {
    if (amountRaw <= 0n) return;

    // Reconcile against a finalized holder snapshot at the observation boundary.
    // This is deliberately independent from price.
    const atMs = Date.now();
    await this.refreshFinalizedHolders(atMs);

    const weights =
      kind === "reward" ? this.balanceWeights() : this.feeGravityWeights(atMs);

    const allocations = largestRemainderAllocation(amountRaw, weights);
    if (!allocations.length)
      throw new Error(
        `${kind} deposit ${amountRaw} has no eligible ${kind === "reward" ? "holder-balance" : "Fee Gravity"} weight`,
      );

    if (kind === "reward") {
      this.applyAllocations(this.rewardEntitlements, allocations);
      this.rewardTreasuryBalanceRaw = balanceAfterRaw;
    } else {
      this.applyAllocations(this.bonusEntitlements, allocations);
      this.bonusTreasuryBalanceRaw = balanceAfterRaw;
    }

    // Persist entitlement debt before attempting any payout.
    this.saveCheckpoint();
    const plan = await this.persistPlan(kind);

    emit({
      type: `${kind}-deposit`,
      token: this.runtime.base.mint,
      amountRaw: amountRaw.toString(),
      allocations: allocations.length,
      distributionId: plan.id,
      totalEntitledRaw: plan.totalEntitledRaw.toString(),
      totalOutstandingRaw: plan.totalOutstandingRaw.toString(),
    });
    this.onChange(this, `${kind}-deposit`);

    const threshold = BigInt(
      kind === "reward"
        ? (this.config.autoDistributeRaw ?? "0")
        : (this.config.autoDistributeBonusRaw ?? "0"),
    );
    if (threshold > 0n && plan.totalOutstandingRaw >= threshold)
      await this.executeDistributionLocked(kind);
  }

  private async treasuryLoop(kind: DistributionKind): Promise<void> {
    const address =
      kind === "reward"
        ? this.runtime.rewardTreasuryAddress
        : this.runtime.bonusTreasuryAddress;
    if (!address) return;

    const pollMs = Math.max(
      500,
      Math.trunc(this.config.treasuryPollMs ?? 2_000),
    );

    while (!this.signal.aborted && !this.stopped) {
      try {
        await this.serial(async () => {
          const current = await this.readTreasuryBalanceRaw(address);
          const previous =
            kind === "reward"
              ? this.rewardTreasuryBalanceRaw
              : this.bonusTreasuryBalanceRaw;

          if (current > previous) {
            await this.handleDeposit(kind, current - previous, current);
          } else if (current < previous) {
            // A payout or external withdrawal happened. Entitlements remain debt;
            // only the observed treasury baseline changes.
            if (kind === "reward") this.rewardTreasuryBalanceRaw = current;
            else this.bonusTreasuryBalanceRaw = current;
            this.saveCheckpoint();
          }
        });
      } catch (error) {
        emit({
          type: "treasury-error",
          token: this.runtime.base.mint,
          kind,
          error: message(error),
        });
      }
      await sleep(pollMs, this.signal);
    }
  }

  private async holderReplayLoop(): Promise<void> {
    const stream = await this.slrd.events(this.runtime.base.mint, {
      pollMs: Math.max(500, Math.trunc(this.config.holderPollMs ?? 2_000)),
      signal: this.signal,
    });

    try {
      for await (const item of stream) {
        if (this.signal.aborted || this.stopped) break;
        if (item.postBalance.size === 0) continue;

        const atMs =
          item.timestampSec == null ? Date.now() : item.timestampSec * 1_000;

        await this.serial(() => {
          for (const [owner, balance] of item.postBalance) {
            this.applyBalanceToFeeInventory(owner, balance, atMs);
            if (balance === 0n) this.balances.delete(owner);
            else this.balances.set(owner, balance);
          }
        });
        this.onChange(this, "holder-change");
      }
    } finally {
      await stream.close();
    }
  }

  private async exactSwapLoop(): Promise<void> {
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
        if (
          this.signal.aborted ||
          this.stopped ||
          event.type !== "swap" ||
          event.venue !== "pumpswap" ||
          event.side !== "buy" ||
          !event.trader ||
          event.confidence !== "finalized"
        )
          continue;

        const id = liveTradeIdentity(event);
        if (this.exactTradeIds.has(id)) continue;

        const feeRaw = exactLivePumpSwapBuyFeeRaw(
          event,
          this.runtime.feeContribution,
        );

        if (
          !event.fees ||
          feeRaw == null ||
          event.quoteMint !== this.runtime.quoteMint ||
          event.tokenAmountRaw <= 0n ||
          event.fees.userQuoteAmountRaw <= 0n
        ) {
          await this.serial(() => {
            this.missingExactPumpSwapFees += 1;
          });
          emit({
            type: "pumpswap-buy-rejected",
            token: this.runtime.base.mint,
            signature: event.signature,
            reason: "missing exact PumpSwap fee event or quote economics",
          });
          continue;
        }

        await this.serial(() => {
          if (this.exactTradeIds.has(id)) return;
          this.addExactBuyContribution(
            event.trader!,
            event.tokenAmountRaw,
            event.fees!.userQuoteAmountRaw,
            feeRaw,
            event.blockTimeMs ?? event.observedAtMs,
          );
          this.exactTradeIds.add(id);
          this.feeHistoryThroughMs = Math.max(
            this.feeHistoryThroughMs,
            event.blockTimeMs ?? event.observedAtMs,
          );
        });
        this.onChange(this, "exact-pumpswap-buy");
      }
    } finally {
      await stream.close();
    }
  }

  private async priceLoop(): Promise<void> {
    const pollMs = Math.max(
      2_000,
      Math.trunc(this.config.pricePollMs ?? 15_000),
    );
    while (!this.signal.aborted && !this.stopped) {
      try {
        const sampled = await this.slrd.samplePrice(this.runtime.base.mint);
        const mint = sampled.quoteAsset.mint.toBase58();
        if (mint !== this.runtime.quoteMint)
          throw new Error(
            `Price quote changed from ${this.runtime.quoteMint} to ${mint}`,
          );
        this.latestPrice = {
          value: sampled.priceQuotePerToken.toString(),
          capturedAtMs: sampled.capturedAtMs,
          error: null,
        };
        this.onChange(this, "price");
      } catch (error) {
        this.latestPrice = {
          ...this.latestPrice,
          error: message(error),
        };
      }
      await sleep(pollMs, this.signal);
    }
  }

  private async executeDistributionLocked(
    kind: DistributionKind,
  ): Promise<void> {
    if (!liveGate())
      throw new Error(
        "Distribution requires SOLARD_ENABLE_LIVE_TRADES=1 or SLRD_ENABLE_LIVE_TRADES=1",
      );

    const isReward = kind === "reward";
    const id = isReward
      ? this.runtime.rewardDistributionId
      : this.runtime.bonusDistributionId;
    const from = isReward ? this.config.treasury : this.config.bonusTreasury;
    const entitlements = isReward
      ? this.rewardEntitlements
      : this.bonusEntitlements;
    const reserveRaw = BigInt(
      isReward
        ? (this.config.reserveRaw ?? "0")
        : (this.config.bonusReserveRaw ?? "0"),
    );

    if (!id || !from) throw new Error(`${kind} distribution is not configured`);

    const state = await this.slrd.distributions.execute({
      id,
      from,
      asset: this.runtime.asset,
      entitlements: sortedEntitlements(entitlements),
      reserveRaw,
      via: (this.root.sender ?? "rpc") as any,
    });

    if (isReward) {
      this.rewardTreasuryBalanceRaw = await this.readTreasuryBalanceRaw(
        this.runtime.rewardTreasuryAddress,
      );
    } else if (this.runtime.bonusTreasuryAddress) {
      this.bonusTreasuryBalanceRaw = await this.readTreasuryBalanceRaw(
        this.runtime.bonusTreasuryAddress,
      );
    }
    this.saveCheckpoint();

    emit({
      type: `${kind}-distribution`,
      token: this.runtime.base.mint,
      id: state.id,
      status: state.status,
      recipients: state.recipients.length,
    });
    this.onChange(this, `${kind}-distribution`);
  }

  async distribute(kind: DistributionKind = "reward"): Promise<void> {
    await this.serial(() => this.executeDistributionLocked(kind));
  }

  async bootstrap(): Promise<void> {
    this.phase = "token";
    const base = await ensureToken(this.slrd, this.config.mint);
    if (base.decimals == null)
      throw new Error(`Token ${base.mint} has unknown decimals`);

    const rewardTreasuryAddress = walletAddress(
      this.slrd,
      this.config.treasury,
    );
    const bonusTreasuryAddress = this.config.bonusTreasury
      ? walletAddress(this.slrd, this.config.bonusTreasury)
      : null;

    if (
      bonusTreasuryAddress &&
      bonusTreasuryAddress === rewardTreasuryAddress
    ) {
      throw new Error(
        `Reward treasury and bonus treasury must be different for ${base.mint}`,
      );
    }

    this.excluded.add(rewardTreasuryAddress);
    if (bonusTreasuryAddress) this.excluded.add(bonusTreasuryAddress);
    if (base.bondingCurve) this.excluded.add(base.bondingCurve);
    if (base.pool) this.excluded.add(base.pool);
    if (base.sharingConfig) this.excluded.add(base.sharingConfig);
    for (const owner of this.config.excludedOwners ?? [])
      this.excluded.add(owner);

    this.phase = "holder-history";
    emit({
      type: "bootstrap",
      token: base.mint,
      stage: this.phase,
    });

    const replay = await this.slrd.history.replay(base.mint, {
      provider: "rpc",
      onProgress: (progress) => {
        if (
          progress.total != null &&
          progress.completed !== progress.total &&
          progress.completed % 250 !== 0
        )
          return;
        emit({
          type: "holder-history-progress",
          token: base.mint,
          ...progress,
        });
      },
    });

    if (!replay.coverage.fromCreation || !replay.coverage.complete)
      throw new Error(
        `Holder replay for ${base.mint} is incomplete: ${replay.coverage.warnings.join("; ")}`,
      );

    this.phase = "market-history";
    emit({
      type: "bootstrap",
      token: base.mint,
      stage: this.phase,
    });

    const market = await this.slrd.history.market(base.mint, {
      backfill: true,
      onProgress: (progress) => {
        if (
          progress.total != null &&
          progress.completed !== progress.total &&
          progress.completed % 500 !== 0
        )
          return;
        emit({
          type: "market-history-progress",
          token: base.mint,
          ...progress,
        });
      },
    });

    if (!market.coverage.fromCreation || !market.coverage.complete)
      throw new Error(`Market history for ${base.mint} is incomplete`);

    const quoteMint = market.quoteMint;
    if (
      this.config.quoteMint &&
      this.config.quoteMint !== quoteMint &&
      !(
        this.config.quoteMint.toUpperCase() === "SOL" &&
        quoteMint === NATIVE_SOL_MINT
      )
    ) {
      throw new Error(
        `Configured quote ${this.config.quoteMint} does not match ${quoteMint}`,
      );
    }

    let quoteDecimals = 9;
    let quoteKind: "native-sol" | "spl-token" = "native-sol";
    if (quoteMint !== NATIVE_SOL_MINT) {
      const quote = await ensureToken(this.slrd, quoteMint);
      if (quote.decimals == null)
        throw new Error(`Quote token ${quoteMint} has unknown decimals`);
      quoteDecimals = quote.decimals;
      quoteKind = "spl-token";
    }

    this.runtime = {
      base,
      quoteMint,
      quoteSymbol:
        this.config.quoteSymbol?.trim() ||
        (quoteKind === "native-sol" ? "SOL" : quoteMint.slice(0, 8)),
      quoteDecimals,
      quoteKind,
      rewardTreasuryAddress,
      bonusTreasuryAddress,
      rewardDistributionId:
        this.config.distributionId ?? `fairfun:${base.mint}:reward:v3`,
      bonusDistributionId: bonusTreasuryAddress
        ? (this.config.bonusDistributionId ??
          `fairfun:${base.mint}:fee-gravity:v3`)
        : null,
      asset: quoteKind === "native-sol" ? "SOL" : quoteMint,
      feeContribution: this.config.feeContribution ?? "total",
    };

    // Ensure stored history was parsed by the exact-fee Solard version.
    const trades = await this.ensureExactFeeHistory();
    const coverage = getTokenHistoryCoverage(base.mint);
    if (!coverage?.fromCreation || !coverage.complete)
      throw new Error(
        `Verified trade coverage for ${base.mint} is not complete from creation`,
      );

    this.phase = "fee-gravity";
    this.historicalFeeAccounting(replay, trades);

    // Bring current holder balances/account lists to an authoritative finalized snapshot.
    await this.refreshFinalizedHolders(Date.now());

    const row = this.checkpointRow();
    for (const [wallet, raw] of Object.entries(row.rewardEntitlements))
      this.rewardEntitlements.set(wallet, BigInt(raw));
    for (const [wallet, raw] of Object.entries(row.bonusEntitlements))
      this.bonusEntitlements.set(wallet, BigInt(raw));

    // Establish treasury baselines. Existing funds are not retroactively treated
    // as a new deposit on first boot.
    const currentReward = await this.readTreasuryBalanceRaw(
      rewardTreasuryAddress,
    );
    if (row.rewardTreasuryBalanceRaw == null) {
      this.rewardTreasuryBalanceRaw = currentReward;
    } else {
      this.rewardTreasuryBalanceRaw = BigInt(row.rewardTreasuryBalanceRaw);
      if (currentReward < this.rewardTreasuryBalanceRaw)
        this.rewardTreasuryBalanceRaw = currentReward;
    }

    if (bonusTreasuryAddress) {
      const currentBonus =
        await this.readTreasuryBalanceRaw(bonusTreasuryAddress);
      if (row.bonusTreasuryBalanceRaw == null) {
        this.bonusTreasuryBalanceRaw = currentBonus;
      } else {
        this.bonusTreasuryBalanceRaw = BigInt(row.bonusTreasuryBalanceRaw);
        if (currentBonus < this.bonusTreasuryBalanceRaw)
          this.bonusTreasuryBalanceRaw = currentBonus;
      }
    }

    this.saveCheckpoint();
    await this.persistPlan("reward");
    if (bonusTreasuryAddress) await this.persistPlan("bonus");

    this.phase = "ready";
    emit({
      type: "token-ready",
      token: base.mint,
      quoteMint,
      holders: this.balances.size,
      exactPumpSwapBuys: this.exactPumpSwapBuys,
      missingExactPumpSwapFees: this.missingExactPumpSwapFees,
      rejectedPumpSwapTrades: this.rejectedPumpSwapTrades,
      feeContribution: this.runtime.feeContribution,
      rewardDistributionId: this.runtime.rewardDistributionId,
      bonusDistributionId: this.runtime.bonusDistributionId,
    });
    this.onChange(this, "ready");
  }

  async run(): Promise<void> {
    await Promise.all([
      this.treasuryLoop("reward"),
      this.treasuryLoop("bonus"),
      this.holderReplayLoop(),
      this.exactSwapLoop(),
      this.priceLoop(),
    ]);
  }

  private paidByWallet(kind: DistributionKind): Map<string, bigint> {
    const id =
      kind === "reward"
        ? this.runtime.rewardDistributionId
        : this.runtime.bonusDistributionId;
    if (!id) return new Map();
    const state = this.slrd.distributions.status(id);
    return new Map(
      (state?.recipients ?? []).map((row) => [
        row.recipient,
        BigInt(row.confirmedPaidRaw),
      ]),
    );
  }

  publicState(wallet?: string) {
    const now = Date.now();
    this.settleAllFeeGravity(now);

    const rewardPaid = this.paidByWallet("reward");
    const bonusPaid = this.paidByWallet("bonus");
    const feeGravityTotal = this.feeGravityTotal(now);
    const baseDecimals = this.runtime.base.decimals ?? 0;

    const holder = (address: string): PublicHolder => {
      const balanceRaw = this.balances.get(address) ?? 0n;
      const fee = this.feeInventory.get(address) ?? {
        balanceRaw,
        activeFeeBasisRaw: 0n,
        feeGravityRawMs: 0n,
        lastAtMs: now,
        exactBuyFeesRaw: 0n,
        exactBuyQuoteRaw: 0n,
        buyCount: 0,
      };

      const rewardEarned = this.rewardEntitlements.get(address) ?? 0n;
      const rewardPaidRaw = rewardPaid.get(address) ?? 0n;
      const rewardOutstanding =
        rewardEarned > rewardPaidRaw ? rewardEarned - rewardPaidRaw : 0n;

      const bonusEarned = this.bonusEntitlements.get(address) ?? 0n;
      const bonusPaidRaw = bonusPaid.get(address) ?? 0n;
      const bonusOutstanding =
        bonusEarned > bonusPaidRaw ? bonusEarned - bonusPaidRaw : 0n;

      return {
        wallet: address,
        tokenAccounts: this.holderAccounts.get(address) ?? [],
        balanceRaw: balanceRaw.toString(),
        balance: formatRaw(balanceRaw, baseDecimals),

        activeFeeBasisRaw: fee.activeFeeBasisRaw.toString(),
        activeFeeBasis: formatRaw(
          fee.activeFeeBasisRaw,
          this.runtime.quoteDecimals,
        ),
        feeGravityRawMs: fee.feeGravityRawMs.toString(),
        feeGravityQuoteMinutes: formatRaw(
          fee.feeGravityRawMs / 60_000n,
          this.runtime.quoteDecimals,
        ),
        feeGravitySharePct: pct(fee.feeGravityRawMs, feeGravityTotal),

        exactPumpSwapBuyFeesRaw: fee.exactBuyFeesRaw.toString(),
        exactPumpSwapBuyFees: formatRaw(
          fee.exactBuyFeesRaw,
          this.runtime.quoteDecimals,
        ),
        exactPumpSwapBuyQuoteRaw: fee.exactBuyQuoteRaw.toString(),
        exactPumpSwapBuyQuote: formatRaw(
          fee.exactBuyQuoteRaw,
          this.runtime.quoteDecimals,
        ),
        exactPumpSwapBuys: fee.buyCount,

        rewardEarnedRaw: rewardEarned.toString(),
        rewardPaidRaw: rewardPaidRaw.toString(),
        rewardOutstandingRaw: rewardOutstanding.toString(),

        bonusEarnedRaw: bonusEarned.toString(),
        bonusPaidRaw: bonusPaidRaw.toString(),
        bonusOutstandingRaw: bonusOutstanding.toString(),
      };
    };

    const addresses = new Set([
      ...this.balances.keys(),
      ...this.feeInventory.keys(),
      ...this.rewardEntitlements.keys(),
      ...this.bonusEntitlements.keys(),
    ]);

    const holders = [...addresses]
      .filter((address) => !this.excluded.has(address))
      .map(holder)
      .sort((left, right) => {
        const a = BigInt(left.balanceRaw);
        const b = BigInt(right.balanceRaw);
        return a === b
          ? left.wallet.localeCompare(right.wallet)
          : a > b
            ? -1
            : 1;
      });

    const rewardState = this.slrd.distributions.status(
      this.runtime.rewardDistributionId,
    );
    const bonusState = this.runtime.bonusDistributionId
      ? this.slrd.distributions.status(this.runtime.bonusDistributionId)
      : null;

    const requested = wallet?.trim() || null;

    return {
      version: 3,
      mint: this.runtime.base.mint,
      symbol: this.runtime.base.symbol ?? null,
      quoteMint: this.runtime.quoteMint,
      quoteSymbol: this.runtime.quoteSymbol,
      phase: this.phase,
      active: this.phase === "ready" && !this.stopped,

      price: {
        ...this.latestPrice,
        quoteSymbol: this.runtime.quoteSymbol,
        role: "display-only",
      },

      holders: {
        count: [...this.balances].filter(
          ([owner, amount]) => amount > 0n && !this.excluded.has(owner),
        ).length,
        rows: holders,
      },

      feeGravity: {
        source: "verified-finalized-pumpswap-buy-events",
        contributionMode: this.runtime.feeContribution,
        totalRawMs: feeGravityTotal.toString(),
        totalQuoteMinutes: formatRaw(
          feeGravityTotal / 60_000n,
          this.runtime.quoteDecimals,
        ),
        activeFeeBasisRaw: this.activeFeeBasisTotal(now).toString(),
        exactPumpSwapBuys: this.exactPumpSwapBuys,
        missingExactPumpSwapFees: this.missingExactPumpSwapFees,
        rejectedPumpSwapTrades: this.rejectedPumpSwapTrades,
        throughMs: this.feeHistoryThroughMs,
        inventoryRule:
          "buy adds exact fee basis; incoming transfer adds no basis; disposal destroys basis and accumulated Fee Gravity proportionally",
      },

      rewards: {
        allocation: "eligible-current-balance",
        treasury: this.runtime.rewardTreasuryAddress,
        balanceRaw: this.rewardTreasuryBalanceRaw.toString(),
        distributionId: this.runtime.rewardDistributionId,
        distributionStatus: rewardState?.status ?? null,
      },

      bonus: this.runtime.bonusTreasuryAddress
        ? {
            allocation: "fee-gravity",
            treasury: this.runtime.bonusTreasuryAddress,
            balanceRaw: this.bonusTreasuryBalanceRaw.toString(),
            distributionId: this.runtime.bonusDistributionId,
            distributionStatus: bonusState?.status ?? null,
          }
        : null,

      wallet: requested ? holder(requested) : null,
    };
  }

  status() {
    const state = this.publicState();
    return {
      mint: state.mint,
      phase: state.phase,
      holders: state.holders.count,
      feeGravity: state.feeGravity,
      rewards: state.rewards,
      bonus: state.bonus,
      price: state.price,
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
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

    return new ReadableStream<Uint8Array>({
      start: (next) => {
        controller = next;
        this.clients.add(next);
        next.enqueue(
          this.packet("snapshot", {
            tokens: engines.map((engine) => engine.publicState()),
          }),
        );
      },
      cancel: () => {
        if (controller) this.clients.delete(controller);
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
        if (!expected)
          return jsonResponse(
            config,
            {
              error: `${adminTokenEnv} is not configured; HTTP distribution is disabled`,
            },
            403,
          );

        if (
          (request.headers.get("authorization") ?? "") !== `Bearer ${expected}`
        )
          return jsonResponse(config, { error: "unauthorized" }, 401);

        const kind =
          url.searchParams.get("kind") === "bonus" ? "bonus" : "reward";

        try {
          await engine.distribute(kind);
          return jsonResponse(config, engine.publicState());
        } catch (error) {
          return jsonResponse(config, { error: message(error) }, 500);
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
    throw new Error("FairFun requires config.rpcUrl or RPC_ENDPOINT");

  const connection = new Connection(rpcUrl, "finalized");
  const checkpointPath = resolve(dirname(configPath), config.checkpoint);
  const checkpoint = loadCheckpoint(checkpointPath);
  const slrd = createSolard({
    rpcUrl,
    dbPath: config.dbPath,
  });

  const abort = new AbortController();
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
        abort.signal,
        (engine, reason) => hub.publish(reason, engine),
      ),
  );

  let server: ReturnType<typeof Bun.serve> | null = null;

  try {
    emit({
      type: "startup",
      config: configPath,
      tokens: engines.length,
    });

    for (const engine of engines) await engine.bootstrap();

    server = startHttpServer(config, engines, hub);
    emit({ type: "ready", tokens: engines.length });

    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    readline.on("line", (line) => {
      const [command, token, requestedKind] = line.trim().split(/\s+/, 3);

      if (command === "status") {
        process.stdout.write(
          `${JSON.stringify(
            engines.map((engine) => engine.status()),
            null,
            2,
          )}\n`,
        );
        return;
      }

      if (command === "distribute") {
        const kind: DistributionKind =
          requestedKind === "bonus" || token === "bonus" ? "bonus" : "reward";
        const mint =
          token === "bonus" || token === "reward" ? undefined : token;
        const selected = mint
          ? engines.filter((engine) => engine.mint() === mint)
          : engines;

        void Promise.all(
          selected.map((engine) => engine.distribute(kind)),
        ).catch((error) => process.stderr.write(`${message(error)}\n`));
        return;
      }

      if (command === "quit" || command === "exit") {
        abort.abort();
        for (const engine of engines) engine.stop();
        readline.close();
      }
    });

    const stop = () => {
      abort.abort();
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
