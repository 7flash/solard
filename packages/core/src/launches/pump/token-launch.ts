import bs58 from "bs58";
import {
  PublicKey,
  SystemProgram,
  type Connection,
  type Keypair,
} from "@solana/web3.js";

import { rawAmount, SOL_ASSET } from "../../core/amounts.ts";
import type { WalletRef } from "../../core/refs.ts";
import type { Solard } from "../../sdk/slrd.ts";
import { HeliusSender } from "../../tx/senders/helius-sender.ts";
import { HttpRpcSender } from "../../tx/senders/http-rpc-sender.ts";
import {
  isJitoBundleExpiredError,
  isJitoBundleGenerationRetryError,
  JitoSender,
} from "../../tx/senders/jito-sender.ts";
import type {
  PlannedTransaction,
  SendReceipt,
  SenderId,
  SubmittedPlan,
  TransactionDraft,
} from "../../tx/types.ts";
import type {
  PendingMarketState,
  PreparedPendingBuy,
  PreparedTokenDeployment,
} from "../launchpad.ts";
import {
  BUY_EXACT_QUOTE_IN_V2_D8,
  CREATE_V2_D8,
  PUMP_PROGRAM_ID,
} from "../../venues/pump/constants.ts";

export type TokenMetadata = {
  alias: string;
  name: string;
  symbol: string;
  uri: string;
  cashback?: boolean;
  mayhemMode?: boolean;
};

export type BuyerAllocation = {
  role: "creator" | "trader";
  walletRef: WalletRef;
  address: string;
  balanceLamports: bigint;
  reserveLamports: bigint;
  selectedBps: number | null;
  spendLamports: bigint;
  execution?: BuyerExecutionOverride;
};

export type TraderSubmitMode =
  | "after-deploy-confirmed"
  | "after-deploy-processed"
  | "spam-after-market-ready"
  | "blind-spam-after-submit"
  /** Human-friendly alias for blind-spam-after-submit. */
  | "fast-spam"
  /** Backwards-compatible alias for blind-spam-after-submit. */
  | "spam-after-deploy-submit"
  /** Ordered atomic deployment + buyer transactions through Jito. */
  | "jito-bundle";

export type TipConfig = { account?: string; lamports?: bigint };

export type BuyerLaunchStrategy =
  | "fast-spam"
  | "spam-after-market-ready"
  | "after-deploy-processed"
  | "after-deploy-confirmed";

export type BuyerExecutionOverride = {
  /** Optional UI label for the row. */
  label?: string;
  /** Per-wallet sender. Defaults to the policy-derived buyer lane. */
  sender?: SenderId;
  /** Per-wallet launch strategy. Defaults to the global submit mode. */
  strategy?: BuyerLaunchStrategy;
  /** Per-wallet Helius tip. Only applied when sender is helius-fast. */
  tipLamports?: bigint;
  /** Per-wallet compute-unit limit. Defaults to the launch CU limit. */
  cuLimit?: number;
  /** Per-wallet compute-unit price. Defaults to buyerPriorityMicroLamports. */
  priorityMicroLamports?: number;
  /** Per-wallet slippage. Defaults to launch slippageBps. */
  slippageBps?: number;
  /** Per-wallet retry interval. */
  retryIntervalMs?: number;
  /** Per-wallet recompile cadence. */
  recompileIntervalMs?: number;
  /** Per-wallet fresh quote delay. Use -1 to never fetch fresh quotes. */
  freshQuoteDelayMs?: number;
  /** Per-wallet maximum failed attempts. 0 means unlimited. */
  maxFailedAttempts?: number;
};

export type SpamSubmitOptions = {
  /** Delay between send/resend loops. Keep small for fast launches. */
  intervalMs: number;
  /** Overall per-buyer deadline. Use 0 for no deadline; the loop then stops only on success or terminal launch failure. */
  timeoutMs: number;
  /** Post-readiness failed landed transactions before giving up. Use 0 for unlimited. */
  maxFailedAttempts: number;
  /** Recompile/resign a buyer transaction with a fresh blockhash at this cadence while a signature is still pending. */
  recompileIntervalMs?: number;
  /**
   * Hybrid retry setting: keep using the precomputed pending-buy template for this long after launch readiness.
   * Use 0 to switch to live quote immediately after readiness; use -1 to never fetch live quotes and only refresh blockhashes.
   */
  freshQuoteDelayMs?: number;
  /** Keep Solard's cached blockhash warm in parallel so buyer recompiles usually do not wait on getLatestBlockhash. Use 0 to disable. */
  blockhashRefreshIntervalMs?: number;
  /** How long to wait for the create tx / market accounts to become visible in gated modes. Use 0 for no deadline. */
  readinessTimeoutMs?: number;
  /** Global send budget across all launch buyer loops. Use 0 for unlimited; recommended <= provider sendTransaction limit. */
  senderTps?: number;
  /** Backoff after a provider 429/rate-limit response. */
  rateLimitBackoffMs?: number;
  /** Random extra delay used to avoid all buyers retrying on the same millisecond. */
  jitterMs?: number;
};

export type BuyerLane = {
  sender: SenderId;
  tip: TipConfig;
  lane: "trader-fast" | "trader-rpc";
};

export type LaunchSenderPolicy = {
  deploymentSender: SenderId;
  evolutionSender: SenderId;
  fastTraderSender: SenderId;
  rpcTraderSender: SenderId;
  fastTraderCount: number;
  fastTip: TipConfig;
  jitoTip: TipConfig;
};

export type PumpLaunchEnvironment = {
  rpcUrl: string;
  senderUrl?: string;
  jitoUrl: string;
  policy: LaunchSenderPolicy;
  spam: SpamSubmitOptions;
  submitMode: TraderSubmitMode;
  cuLimit: number;
  priorityMicroLamports: number;
};

export type SpamBuyerReceipt = {
  role: BuyerAllocation["role"];
  address: string;
  sender: string;
  receipt: SendReceipt;
  failedAttempts: number;
  preReadyFailures: number;
  buildErrors: number;
  broadcastErrors: number;
  rateLimitErrors: number;
  resends: number;
  signatures: string[];
};

export type TraderReceiptOutcome =
  | { ok: true; index: number; address: string; result: SpamBuyerReceipt }
  | { ok: false; index: number; address: string; error: string };

export type PumpTokenLaunchPlan = {
  token: TokenMetadata;
  creatorWallet: WalletRef;
  deployment: PreparedTokenDeployment;
  creator: BuyerAllocation | null;
  traders: BuyerAllocation[];
  launchDraft: TransactionDraft;
  launchPlan: PlannedTransaction;
  slippageBps: number;
  cuLimit: number;
  buyerPriorityMicroLamports: number;
  deploymentSender: SenderId;
  traderPlans: PlannedTransaction[];
  traderLanes: BuyerLane[];
  expectedOutputByWallet: Array<{
    role: BuyerAllocation["role"];
    address: string;
    spendLamports: bigint;
    minimumOutputRaw: bigint;
    submission: string;
  }>;
};

export type PumpTokenLaunchResult =
  | {
      mode: "dry-run";
      launchSimulation: Awaited<ReturnType<Solard["simulatePlan"]>>;
      deploymentSender: string;
      buyers: PumpTokenLaunchPlan["expectedOutputByWallet"];
      note: string;
    }
  | {
      mode: TraderSubmitMode;
      launchReceipt: SendReceipt;
      traderReceipts: TraderReceiptOutcome[] | SendReceipt[];
    };

export type LaunchReporter = (label: string, value: unknown) => void;

type LaunchReadiness = "pending" | "processed" | "confirmed" | "failed";

type LaunchSenderName = "helius-fast" | "helius-rpc" | "jito";

const JITO_TIP_ACCOUNTS = [
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
] as const;

function randomJitoTipAccount(): string {
  return JITO_TIP_ACCOUNTS[
    Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)
  ]!;
}

function envString(name: string): string | undefined {
  const primary = process.env[name]?.trim();
  if (primary) return primary;
  const solwalAlias = name.startsWith("SLRD_")
    ? process.env[`SOLWAL_${name.slice("SLRD_".length)}`]?.trim()
    : undefined;
  return solwalAlias || undefined;
}

function requireEnv(name: string): string {
  const value = envString(name);
  if (!value) {
    throw new Error(
      `Missing ${name}. Configure shared sender settings in the environment, not launch parameters.`,
    );
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const value = envString(name);
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function bigintEnv(name: string, fallback: bigint): bigint {
  const value = envString(name);
  if (!value) return fallback;

  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new Error(`Invalid ${name}: ${value}`);
  }
}

function senderEnv(name: string, fallback: LaunchSenderName): LaunchSenderName {
  const value = envString(name);
  if (!value) return fallback;

  if (value !== "helius-fast" && value !== "helius-rpc" && value !== "jito") {
    throw new Error(
      `Invalid ${name}: ${value}. Expected "helius-fast", "helius-rpc", or "jito".`,
    );
  }

  return value;
}

export function normalizeTraderSubmitMode(
  value: string | undefined,
): TraderSubmitMode {
  if (!value) return "after-deploy-processed";
  if (value === "spam-after-deploy-submit" || value === "fast-spam")
    return "blind-spam-after-submit";
  if (
    value === "after-deploy-confirmed" ||
    value === "after-deploy-processed" ||
    value === "spam-after-market-ready" ||
    value === "blind-spam-after-submit" ||
    value === "jito-bundle"
  ) {
    return value;
  }
  throw new Error(
    `Invalid SLRD_LAUNCH_SUBMIT_MODE: ${value}. Expected after-deploy-confirmed, after-deploy-processed, spam-after-market-ready, blind-spam-after-submit, fast-spam, or jito-bundle.`,
  );
}

export function pumpLaunchEnvironment(): PumpLaunchEnvironment {
  const rpcUrl =
    envString("RPC_ENDPOINT") || "https://api.mainnet-beta.solana.com";

  const deploymentSender = senderEnv("SLRD_DEPLOYMENT_SENDER", "helius-rpc");
  const evolutionSender = senderEnv("SLRD_EVOLUTION_SENDER", "helius-rpc");
  const fastTraderSender = senderEnv("SLRD_FAST_TRADER_SENDER", "helius-rpc");
  const rpcTraderSender = senderEnv("SLRD_RPC_TRADER_SENDER", "helius-rpc");
  const fastTraderCount = intEnv("HELIUS_FAST_TRADER_COUNT", 0);

  const usesHeliusSender =
    deploymentSender === "helius-fast" ||
    evolutionSender === "helius-fast" ||
    (fastTraderCount > 0 && fastTraderSender === "helius-fast") ||
    rpcTraderSender === "helius-fast";

  const senderUrl = usesHeliusSender
    ? requireEnv("HELIUS_SENDER_URL")
    : envString("HELIUS_SENDER_URL");
  const tipAccount = usesHeliusSender
    ? requireEnv("HELIUS_TIP_ACCOUNT")
    : envString("HELIUS_TIP_ACCOUNT");
  const tipLamports = usesHeliusSender
    ? bigintEnv("HELIUS_TIP_LAMPORTS", 200_000n)
    : 0n;
  const jitoUrl = "https://mainnet.block-engine.jito.wtf";
  const configuredJitoTipAccount = envString("JITO_TIP_ACCOUNT");
  const jitoTipAccount = configuredJitoTipAccount || randomJitoTipAccount();
  const jitoTipLamports = bigintEnv("JITO_TIP_LAMPORTS", 100_000n);

  return {
    rpcUrl,
    senderUrl,
    jitoUrl,
    cuLimit: intEnv("SLRD_LAUNCH_CU_LIMIT", 600_000),
    priorityMicroLamports: intEnv("HELIUS_PRIORITY_MICRO_LAMPORTS", 500_000),
    submitMode: normalizeTraderSubmitMode(envString("SLRD_LAUNCH_SUBMIT_MODE")),
    spam: {
      intervalMs: intEnv("SLRD_LAUNCH_RETRY_INTERVAL_MS", 75),
      timeoutMs: intEnv("SLRD_LAUNCH_RETRY_TIMEOUT_MS", 120_000),
      maxFailedAttempts: intEnv("SLRD_LAUNCH_MAX_FAILED_ATTEMPTS", 0),
      recompileIntervalMs: intEnv("SLRD_LAUNCH_RECOMPILE_INTERVAL_MS", 750),
      freshQuoteDelayMs: intEnv("SLRD_LAUNCH_FRESH_QUOTE_DELAY_MS", 2_500),
      blockhashRefreshIntervalMs: intEnv(
        "SLRD_LAUNCH_BLOCKHASH_REFRESH_INTERVAL_MS",
        500,
      ),
      readinessTimeoutMs: intEnv("SLRD_LAUNCH_READINESS_TIMEOUT_MS", 0),
      senderTps: intEnv("SLRD_LAUNCH_SENDER_TPS", 40),
      rateLimitBackoffMs: intEnv("SLRD_LAUNCH_RATE_LIMIT_BACKOFF_MS", 350),
      jitterMs: intEnv("SLRD_LAUNCH_RETRY_JITTER_MS", 80),
    },
    policy: {
      deploymentSender,
      evolutionSender,
      fastTraderSender,
      rpcTraderSender,
      fastTraderCount,
      fastTip:
        usesHeliusSender && tipAccount
          ? { account: tipAccount, lamports: tipLamports }
          : {},
      jitoTip: {
        account: jitoTipAccount,
        lamports: jitoTipLamports,
      },
    },
  };
}

export function installPumpLaunchSenders(
  slrd: Solard,
  env: PumpLaunchEnvironment,
): void {
  if (env.senderUrl) {
    slrd.registerSender(new HeliusSender(env.senderUrl, "helius-fast"));
  }

  slrd.registerSender(
    new HttpRpcSender("helius-rpc", env.rpcUrl, "--rpc-url/RPC_ENDPOINT"),
  );
  slrd.registerSender(new JitoSender(env.jitoUrl));
}

function validateBps(minBps: number, maxBps: number): void {
  if (
    !Number.isInteger(minBps) ||
    !Number.isInteger(maxBps) ||
    minBps < 1 ||
    maxBps > 10_000 ||
    minBps > maxBps
  ) {
    throw new Error(
      `Expected buyer percentage range within 1..10000 bps, got ${minBps}..${maxBps}`,
    );
  }
}

function randomBps(minBps: number, maxBps: number): number {
  validateBps(minBps, maxBps);
  return minBps === maxBps
    ? minBps
    : minBps + Math.floor(Math.random() * (maxBps - minBps + 1));
}

function validateOptionalTipAddress(
  value: string | undefined,
  flag = "helius tip account",
): void {
  if (value == null) return;
  if (!value || value === "true") {
    throw new Error(
      `${flag} resolved to an empty value. Set the configured environment variable or pass a valid public key in the config file.`,
    );
  }
  try {
    new PublicKey(value);
  } catch {
    throw new Error(`Invalid ${flag} public key: ${value}`);
  }
}

export function validateHeliusTip(args: {
  tip: TipConfig;
  endpoint?: string;
  live: boolean;
  label: string;
}): void {
  validateOptionalTipAddress(args.tip.account);
  if (!args.live) return;

  const swqosOnly = Boolean(args.endpoint?.includes("swqos_only=true"));
  const minimum = swqosOnly ? 5_000n : 200_000n;

  if (!args.tip.account || args.tip.lamports == null) {
    throw new Error(
      `${args.label} through Helius Sender requires a tip account and tipLamports in live mode`,
    );
  }
  if (args.tip.lamports < minimum) {
    throw new Error(
      `${args.label} through Helius Sender requires at least ${minimum} tip lamports; got ${args.tip.lamports}`,
    );
  }
}

export function validateJitoTip(args: {
  tip: TipConfig;
  live: boolean;
  label: string;
}): void {
  validateOptionalTipAddress(args.tip.account, "Jito tip account");
  if (!args.live) return;

  if (!args.tip.account || args.tip.lamports == null) {
    throw new Error(
      `${args.label} requires a Jito tip account and tip lamports in live mode`,
    );
  }
  if (args.tip.lamports < 1_000n) {
    throw new Error(
      `${args.label} requires at least 1000 Jito tip lamports; got ${args.tip.lamports}`,
    );
  }
}

export function usesHeliusSenderForLaunch(
  env: PumpLaunchEnvironment,
  hasBuyerGroup: boolean,
): boolean {
  if (env.policy.deploymentSender === "helius-fast") return true;
  if (!hasBuyerGroup) return false;
  if (
    env.policy.fastTraderCount > 0 &&
    env.policy.fastTraderSender === "helius-fast"
  )
    return true;
  return env.policy.rpcTraderSender === "helius-fast";
}

function addTip(
  builder: ReturnType<Solard["transaction"]>,
  payer: PublicKey,
  tip: TipConfig,
  sender: "helius-fast" | "jito" = "helius-fast",
): void {
  if (!tip.account || tip.lamports == null || tip.lamports <= 0n) return;
  const recipient = new PublicKey(tip.account);
  builder.add(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: recipient,
      lamports: tip.lamports,
    }),
    {
      kind: sender === "jito" ? "jito-tip" : "sender-tip",
      recipient,
      meta: { lamports: tip.lamports.toString(), sender },
    },
  );
}

export type ExplicitBuyerAmount =
  | { kind: "exact-lamports"; lamports: bigint }
  | { kind: "exact-sol"; sol: string }
  | {
      kind: "balance-bps";
      minBps: number;
      maxBps: number;
      reserveLamports: bigint;
    };

export type ExplicitBuyerPlanRow = {
  wallet: WalletRef;
  amount: ExplicitBuyerAmount;
  execution?: BuyerExecutionOverride;
};

function solStringToLamports(value: string): bigint {
  const clean = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(clean))
    throw new Error(`Invalid SOL amount: ${value}`);
  const [whole, frac = ""] = clean.split(".");
  if (frac.length > 9)
    throw new Error(`Invalid SOL amount ${value}: max 9 decimals`);
  return (
    BigInt(whole || "0") * 1_000_000_000n + BigInt(frac.padEnd(9, "0") || "0")
  );
}

export async function loadExplicitBuyerAllocations(args: {
  slrd: Solard;
  rows: ExplicitBuyerPlanRow[];
  excludeWallet?: WalletRef;
}): Promise<BuyerAllocation[]> {
  const excluded = args.excludeWallet
    ? args.slrd.resolveWallet(args.excludeWallet).address.toBase58()
    : null;
  const allocations: BuyerAllocation[] = [];
  const seen = new Set<string>();

  for (const [index, row] of args.rows.entries()) {
    const wallet = args.slrd.resolveWallet(row.wallet);
    const address = wallet.address.toBase58();
    if (address === excluded) continue;
    if (seen.has(address))
      throw new Error(`Duplicate buyer wallet in buy plan: ${address}`);
    seen.add(address);

    const balanceLamports = BigInt(
      await args.slrd.connection().getBalance(wallet.address, "confirmed"),
    );
    let reserveLamports = 0n;
    let selectedBps: number | null = null;
    let spendLamports: bigint;

    if (row.amount.kind === "exact-lamports") {
      spendLamports = row.amount.lamports;
    } else if (row.amount.kind === "exact-sol") {
      spendLamports = solStringToLamports(row.amount.sol);
    } else {
      reserveLamports = row.amount.reserveLamports;
      validateBps(row.amount.minBps, row.amount.maxBps);
      if (balanceLamports <= reserveLamports) {
        throw new Error(
          `Buy plan row ${index + 1} wallet ${address} balance ${balanceLamports} does not exceed reserve ${reserveLamports}`,
        );
      }
      selectedBps = randomBps(row.amount.minBps, row.amount.maxBps);
      spendLamports =
        ((balanceLamports - reserveLamports) * BigInt(selectedBps)) / 10_000n;
    }

    if (spendLamports <= 0n)
      throw new Error(
        `Buy plan row ${index + 1} wallet ${address} produced zero buy amount`,
      );
    if (balanceLamports <= spendLamports + reserveLamports) {
      throw new Error(
        `Buy plan row ${index + 1} wallet ${address} has insufficient SOL: balance=${balanceLamports} spend=${spendLamports} reserve=${reserveLamports}`,
      );
    }

    allocations.push({
      role: "trader",
      walletRef: row.wallet,
      address,
      balanceLamports,
      reserveLamports,
      selectedBps,
      spendLamports,
      execution: row.execution,
    });
  }

  if (allocations.length === 0)
    throw new Error(
      "Buy plan has no eligible buyer wallets after excluding the creator",
    );
  return allocations;
}

export async function loadGroupBuyerAllocations(args: {
  slrd: Solard;
  group: string;
  minBps: number;
  maxBps: number;
  reserveLamports: bigint;
  excludeWallet?: WalletRef;
}): Promise<BuyerAllocation[]> {
  validateBps(args.minBps, args.maxBps);
  const excluded = args.excludeWallet
    ? args.slrd.resolveWallet(args.excludeWallet).address.toBase58()
    : null;
  const refs = args.slrd
    .groupWallets(args.group)
    .filter(
      (ref) => args.slrd.resolveWallet(ref).address.toBase58() !== excluded,
    );
  if (refs.length === 0)
    throw new Error(
      `Group ${args.group} has no trader wallets after excluding the deployer`,
    );

  const allocations: BuyerAllocation[] = [];
  for (const ref of refs) {
    const wallet = args.slrd.resolveWallet(ref);
    const balanceLamports = BigInt(
      await args.slrd.connection().getBalance(wallet.address, "confirmed"),
    );
    if (balanceLamports <= args.reserveLamports) {
      throw new Error(
        `Wallet ${wallet.address.toBase58()} balance ${balanceLamports} does not exceed reserve ${args.reserveLamports}`,
      );
    }
    const selectedBps = randomBps(args.minBps, args.maxBps);
    const spendLamports =
      ((balanceLamports - args.reserveLamports) * BigInt(selectedBps)) /
      10_000n;
    if (spendLamports <= 0n)
      throw new Error(
        `Wallet ${wallet.address.toBase58()} produced zero token buy amount`,
      );
    allocations.push({
      role: "trader",
      walletRef: ref,
      address: wallet.address.toBase58(),
      balanceLamports,
      reserveLamports: args.reserveLamports,
      selectedBps,
      spendLamports,
    });
  }
  return allocations;
}

async function loadCreatorAllocation(args: {
  slrd: Solard;
  wallet: WalletRef;
  spendLamports: bigint;
  reserveLamports: bigint;
}): Promise<BuyerAllocation | null> {
  if (args.spendLamports <= 0n) return null;
  const wallet = args.slrd.resolveWallet(args.wallet);
  const balanceLamports = BigInt(
    await args.slrd.connection().getBalance(wallet.address, "confirmed"),
  );
  if (balanceLamports < args.spendLamports + args.reserveLamports) {
    throw new Error(
      `Creator wallet ${wallet.address.toBase58()} cannot perform initial buy ${args.spendLamports}; balance=${balanceLamports} reserve=${args.reserveLamports}`,
    );
  }
  return {
    role: "creator",
    walletRef: args.wallet,
    address: wallet.address.toBase58(),
    balanceLamports,
    reserveLamports: args.reserveLamports,
    selectedBps: null,
    spendLamports: args.spendLamports,
  };
}

function launchBuilder(args: {
  slrd: Solard;
  deployment: PreparedTokenDeployment;
  creatorWallet: WalletRef;
  kind: string;
  alias: string;
  symbol: string;
  cuLimit: number;
  priorityMicroLamports: number;
  senderTip: TipConfig;
  senderTipSender?: "helius-fast" | "jito";
  useAlts?: boolean;
  initialBuy?: PreparedPendingBuy | null;
  initialBuyer?: BuyerAllocation | null;
}) {
  const builder = args.slrd.transaction(args.creatorWallet);

  // The create transaction should be cheap by default. It only gets compute
  // budget instructions when the caller explicitly asks for a CU limit or
  // priority price. Buyer transactions have their own high-priority path.
  if (args.cuLimit > 0 || args.priorityMicroLamports > 0) {
    builder.priorityFee({
      cuLimit: args.cuLimit > 0 ? args.cuLimit : 600_000,
      microLamports:
        args.priorityMicroLamports > 0 ? args.priorityMicroLamports : undefined,
    });
  }

  builder
    .addMany(args.deployment.instructions, {
      kind: args.kind,
      mint: args.deployment.mint.publicKey,
      meta: { alias: args.alias, symbol: args.symbol },
    })
    .withSigner(args.deployment.mint);

  if (args.initialBuy && args.initialBuyer) {
    builder.addMany(args.initialBuy.instructions, {
      kind: `${args.kind}:initial-buy`,
      mint: args.deployment.mint.publicKey,
      meta: {
        role: "creator",
        buyer: args.initialBuyer.address,
        spendLamports: args.initialBuyer.spendLamports.toString(),
        minimumOutputRaw: args.initialBuy.minimumOutputRaw.toString(),
      },
    });
  }

  addTip(
    builder,
    args.slrd.signer(args.creatorWallet).publicKey,
    args.senderTip,
    args.senderTipSender,
  );
  return builder;
}

async function compileLaunch(
  args: Parameters<typeof launchBuilder>[0],
): Promise<{ draft: TransactionDraft; plan: PlannedTransaction }> {
  const draft = launchBuilder(args).snapshot();
  const hasStaticTip = Boolean(
    args.senderTip.account &&
    args.senderTip.lamports != null &&
    args.senderTip.lamports > 0n,
  );
  try {
    return {
      draft,
      plan: await args.slrd.compile(
        args.slrd.signer(args.creatorWallet),
        draft,
        hasStaticTip || args.useAlts === false ? { useAlts: false } : undefined,
      ),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      /too large|overrun|packet/i.test(error.message)
    ) {
      const altAdvice = hasStaticTip
        ? "Create + sender tip does not fit while keeping the tip account static. Reduce the launch transaction size or tip instructions."
        : "Create + creator initial buy does not fit without a registered launch ALT. Run: slrd run prepare-pump-launch-alt --creator <wallet> --name <name> --symbol <symbol> --alias <alias> --creator-buy-sol <amount> --create --live.";
      throw new Error(`${altAdvice} Original error: ${error.message}`);
    }
    throw error;
  }
}

async function buildPendingBuyPlan(args: {
  slrd: Solard;
  deployment: PreparedTokenDeployment;
  buyer: BuyerAllocation;
  buy: PreparedPendingBuy;
  cuLimit: number;
  priorityMicroLamports: number;
  senderTip: TipConfig;
  senderTipSender?: "helius-fast" | "jito";
  kind: string;
  lane: BuyerLane;
}): Promise<PlannedTransaction> {
  const builder = args.slrd
    .transaction(args.buyer.walletRef)
    .priorityFee({
      cuLimit: args.cuLimit,
      microLamports: args.priorityMicroLamports,
    })
    .addMany(args.buy.instructions, {
      kind: args.kind,
      mint: args.deployment.mint.publicKey,
      meta: {
        role: args.buyer.role,
        buyer: args.buyer.address,
        sender: String(args.lane.sender),
        lane: args.lane.lane,
        spendLamports: args.buyer.spendLamports.toString(),
        minimumOutputRaw: args.buy.minimumOutputRaw.toString(),
        quoteBasis: "creator-plus-all-other-traders-first",
      },
    });

  addTip(
    builder,
    args.slrd.signer(args.buyer.walletRef).publicKey,
    args.senderTip,
    args.senderTipSender,
  );
  return await args.slrd.compile(
    args.slrd.signer(args.buyer.walletRef),
    builder.snapshot(),
    { useAlts: false },
  );
}

async function prepareWorstCaseBuys(args: {
  slrd: Solard;
  deployment: PreparedTokenDeployment;
  traders: BuyerAllocation[];
  initialState: PendingMarketState;
  slippageBps: number;
}): Promise<PreparedPendingBuy[]> {
  const output: PreparedPendingBuy[] = [];
  for (let index = 0; index < args.traders.length; index += 1) {
    let state = args.initialState;
    for (
      let otherIndex = 0;
      otherIndex < args.traders.length;
      otherIndex += 1
    ) {
      if (otherIndex === index) continue;
      const other = args.traders[otherIndex]!;
      const prior = await args.slrd.preparePendingBuy(
        "pump",
        args.deployment,
        other.walletRef,
        rawAmount(other.spendLamports, SOL_ASSET),
        state,
        { slippageBps: args.slippageBps },
      );
      state = prior.nextState;
    }
    const trader = args.traders[index]!;
    output.push(
      await args.slrd.preparePendingBuy(
        "pump",
        args.deployment,
        trader.walletRef,
        rawAmount(trader.spendLamports, SOL_ASSET),
        state,
        { slippageBps: args.slippageBps },
      ),
    );
  }
  return output;
}

export async function preparePumpTokenLaunch(args: {
  slrd: Solard;
  token: TokenMetadata;
  creatorWallet: WalletRef;
  traders: BuyerAllocation[];
  creatorBuyLamports: bigint;
  creatorReserveLamports: bigint;
  slippageBps: number;
  cuLimit: number;
  priorityMicroLamports: number;
  buyerPriorityMicroLamports: number;
  senderPolicy: LaunchSenderPolicy;
  mint?: Keypair;
  cashback?: boolean;
  mayhemMode?: boolean;
}): Promise<PumpTokenLaunchPlan> {
  // A zero CU limit is not "automatic" once it reaches the transaction draft:
  // the assembler emits setComputeUnitLimit(0), so even that instruction cannot
  // execute. Treat zero as the launch default before compiling or saving drafts.
  const deploymentCuLimit =
    Number.isFinite(args.cuLimit) && args.cuLimit > 0
      ? Math.trunc(args.cuLimit)
      : 600_000;

  const deployment = await args.slrd.prepareTokenDeployment(
    "pump",
    args.creatorWallet,
    {
      name: args.token.name,
      symbol: args.token.symbol,
      uri: args.token.uri,
      creator: args.slrd.signer(args.creatorWallet).publicKey,
      mint: args.mint,
      mayhemMode: args.mayhemMode ?? args.token.mayhemMode ?? false,
      cashback: args.cashback ?? args.token.cashback ?? false,
    },
  );

  const creator = await loadCreatorAllocation({
    slrd: args.slrd,
    wallet: args.creatorWallet,
    spendLamports: args.creatorBuyLamports,
    reserveLamports: args.creatorReserveLamports,
  });

  let state = await args.slrd.initialPendingMarketState("pump", deployment);
  let initialBuy: PreparedPendingBuy | null = null;
  if (creator) {
    initialBuy = await args.slrd.preparePendingBuy(
      "pump",
      deployment,
      args.creatorWallet,
      rawAmount(creator.spendLamports, SOL_ASSET),
      state,
      { slippageBps: args.slippageBps },
    );
    state = initialBuy.nextState;
  }

  const deploymentSender = String(args.senderPolicy.deploymentSender);
  // Jito bundle tips belong in the final buyer transaction. Keeping the
  // deployment transaction untipped reduces standalone-tip exposure if bundle
  // transactions are ever rebroadcast outside normal bundle execution.
  const launchSenderTip: TipConfig =
    deploymentSender === "helius-fast" ? args.senderPolicy.fastTip : {};

  const launch = await compileLaunch({
    ...args,
    cuLimit: deploymentCuLimit,
    senderTipSender: "helius-fast",
    deployment,
    kind: "launch-pump-token",
    alias: args.token.alias,
    symbol: args.token.symbol,
    senderTip: launchSenderTip,
    useAlts: deploymentSender === "jito" ? false : undefined,
    initialBuy,
    initialBuyer: creator,
  });

  const finalTraderIndex = args.traders.length - 1;
  const tipForSender = (
    sender: SenderId,
    trader: BuyerAllocation,
    index: number,
  ): TipConfig => {
    if (String(sender) === "jito") {
      return index === finalTraderIndex ? args.senderPolicy.jitoTip : {};
    }
    if (String(sender) !== "helius-fast") return {};
    const explicitTip = trader.execution?.tipLamports;
    return explicitTip != null
      ? { ...args.senderPolicy.fastTip, lamports: explicitTip }
      : args.senderPolicy.fastTip;
  };
  const traderLanes = args.traders.map((trader, index) => {
    const policySender =
      index < args.senderPolicy.fastTraderCount
        ? args.senderPolicy.fastTraderSender
        : args.senderPolicy.rpcTraderSender;
    const sender = trader.execution?.sender ?? policySender;
    const lane =
      String(sender) === "helius-fast" ||
      index < args.senderPolicy.fastTraderCount
        ? ("trader-fast" as const)
        : ("trader-rpc" as const);
    return { sender, tip: tipForSender(sender, trader, index), lane };
  });

  const pendingBuys = await prepareWorstCaseBuys({
    slrd: args.slrd,
    deployment,
    traders: args.traders,
    initialState: state,
    slippageBps: args.slippageBps,
  });

  const traderPlans: PlannedTransaction[] = [];
  for (let index = 0; index < args.traders.length; index += 1) {
    const lane = traderLanes[index]!;
    traderPlans.push(
      await buildPendingBuyPlan({
        ...args,
        deployment,
        buyer: args.traders[index]!,
        cuLimit: args.traders[index]!.execution?.cuLimit ?? deploymentCuLimit,
        buy: pendingBuys[index]!,
        kind: "buy-pump-token-group",
        senderTip: lane.tip,
        senderTipSender:
          String(lane.sender) === "jito" ? "jito" : "helius-fast",
        lane,
        priorityMicroLamports:
          args.traders[index]!.execution?.priorityMicroLamports ??
          args.buyerPriorityMicroLamports,
      }),
    );
  }

  return {
    token: args.token,
    creatorWallet: args.creatorWallet,
    deployment,
    creator,
    traders: args.traders,
    launchDraft: launch.draft,
    launchPlan: launch.plan,
    slippageBps: args.slippageBps,
    cuLimit: deploymentCuLimit,
    buyerPriorityMicroLamports: args.buyerPriorityMicroLamports,
    deploymentSender: args.senderPolicy.deploymentSender,
    traderPlans,
    traderLanes,
    expectedOutputByWallet: [
      ...(creator && initialBuy
        ? [
            {
              role: creator.role,
              address: creator.address,
              spendLamports: creator.spendLamports,
              minimumOutputRaw: initialBuy.minimumOutputRaw,
              submission: `initial-buy-in-create:${String(args.senderPolicy.deploymentSender)}`,
            },
          ]
        : []),
      ...pendingBuys.map((buy, index) => ({
        role: args.traders[index]!.role,
        address: args.traders[index]!.address,
        spendLamports: args.traders[index]!.spendLamports,
        minimumOutputRaw: buy.minimumOutputRaw,
        submission: `${traderLanes[index]!.lane}:${String(traderLanes[index]!.sender)}`,
      })),
    ],
  };
}

export async function simulatePumpTokenLaunch(args: {
  slrd: Solard;
  prepared: PumpTokenLaunchPlan;
}) {
  return await args.slrd.simulatePlan(args.prepared.launchPlan);
}

export async function signatureReadiness(
  connection: Connection,
  signature: string,
): Promise<LaunchReadiness> {
  const status = (
    await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    })
  ).value[0];
  if (!status) return "pending";
  if (status.err) return "failed";
  if (
    status.confirmationStatus === "confirmed" ||
    status.confirmationStatus === "finalized"
  )
    return "confirmed";
  if (status.confirmationStatus === "processed") return "processed";
  return "pending";
}

function hasDeadline(timeoutMs: number): boolean {
  return timeoutMs > 0;
}

function beforeDeadline(startedAt: number, timeoutMs: number): boolean {
  return !hasDeadline(timeoutMs) || Date.now() - startedAt < timeoutMs;
}

function jitter(maxMs: number | undefined): number {
  const limit = maxMs ?? 0;
  return limit > 0 ? Math.floor(Math.random() * (limit + 1)) : 0;
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function isRateLimitError(error: unknown): boolean {
  return /\b429\b|rate.?limit|too many requests/i.test(errorText(error));
}

function isStructuralSenderError(error: unknown): boolean {
  return /invalid request|invalid params|must send a tip|transaction must send a tip|tip of at least|insufficient funds|blockhash not found|signature verification failed/i.test(
    errorText(error),
  );
}

function isTransientSenderError(error: unknown): boolean {
  if (isStructuralSenderError(error)) return false;
  return (
    isRateLimitError(error) ||
    /\b5\d\d\b|timeout|timed out|fetch failed|network|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket/i.test(
      errorText(error),
    )
  );
}

class SenderRateLimiter {
  private nextAvailableAt = 0;
  private backoffUntil = 0;

  constructor(
    private readonly options: SpamSubmitOptions,
    private readonly reporter?: LaunchReporter,
  ) {}

  async wait(sender: SenderId): Promise<void> {
    const tps = this.options.senderTps ?? 0;
    if (tps <= 0) return;

    const now = Date.now();
    const spacingMs = Math.max(1, Math.ceil(1000 / tps));
    const waitUntil = Math.max(this.nextAvailableAt, this.backoffUntil, now);
    const delayMs = Math.max(0, waitUntil - now);
    this.nextAvailableAt = waitUntil + spacingMs;

    if (delayMs > 0) {
      this.reporter?.("pump sender throttle", {
        sender: String(sender),
        delayMs,
        senderTps: tps,
      });
      await sleep(delayMs);
    }
  }

  async backoff(sender: SenderId, error: unknown): Promise<void> {
    const baseMs = this.options.rateLimitBackoffMs ?? 350;
    const delayMs = baseMs + jitter(this.options.jitterMs);
    this.backoffUntil = Math.max(this.backoffUntil, Date.now() + delayMs);
    this.reporter?.("pump sender backoff", {
      sender: String(sender),
      delayMs,
      error: errorText(error),
    });
    await sleep(delayMs);
  }
}

function startBlockhashWarmer(
  slrd: Solard,
  intervalMs: number | undefined,
  reporter?: LaunchReporter,
): () => void {
  const ms = intervalMs ?? 0;
  if (ms <= 0) return () => {};

  const cache = (
    slrd as unknown as {
      blockhash?: {
        invalidate: () => void;
        get: (connection: Connection) => Promise<unknown>;
      };
    }
  ).blockhash;
  if (!cache) return () => {};

  let stopped = false;
  const run = async () => {
    while (!stopped) {
      try {
        cache.invalidate();
        await cache.get(slrd.connection());
      } catch (error) {
        reporter?.("pump blockhash warm error", { error: errorText(error) });
      }
      await sleep(ms);
    }
  };
  void run();
  return () => {
    stopped = true;
  };
}

function deploymentReadinessAddresses(
  deployment: PreparedTokenDeployment,
): Array<{ label: string; address: PublicKey }> {
  const addresses: Array<{ label: string; address: PublicKey }> = [
    { label: "mint", address: deployment.mint.publicKey },
  ];

  const bondingCurve =
    typeof deployment.token.bondingCurve === "string"
      ? deployment.token.bondingCurve
      : null;
  if (bondingCurve) {
    try {
      addresses.push({
        label: "bondingCurve",
        address: new PublicKey(bondingCurve),
      });
    } catch {
      // Ignore malformed optional metadata; the mint readiness check still protects the critical path.
    }
  }

  return addresses;
}

function isTransientMarketReadinessError(error: unknown): boolean {
  return /not found|account.*missing|mint account|bonding curve|curve.*not|market.*not|failed to get account/i.test(
    errorText(error),
  );
}

export async function waitForSignatureAtLeastProcessed(args: {
  connection: Connection;
  signature: string;
  timeoutMs: number;
  intervalMs?: number;
}): Promise<"processed" | "confirmed"> {
  const startedAt = Date.now();
  const intervalMs = args.intervalMs ?? 50;

  while (beforeDeadline(startedAt, args.timeoutMs)) {
    const state = await signatureReadiness(args.connection, args.signature);
    if (state === "failed")
      throw new Error(`Launch transaction failed: ${args.signature}`);
    if (state === "confirmed") return "confirmed";
    if (state === "processed") return "processed";
    await sleep(intervalMs);
  }

  throw new Error(
    `Launch transaction was not processed within ${args.timeoutMs}ms: ${args.signature}`,
  );
}

export async function waitForAccountExists(args: {
  connection: Connection;
  address: PublicKey;
  timeoutMs: number;
  intervalMs?: number;
}): Promise<void> {
  const startedAt = Date.now();
  const intervalMs = args.intervalMs ?? 50;

  while (beforeDeadline(startedAt, args.timeoutMs)) {
    const account = await args.connection.getAccountInfo(
      args.address,
      "processed",
    );
    if (account) return;
    await sleep(intervalMs);
  }

  throw new Error(
    `Account was not visible within ${args.timeoutMs}ms: ${args.address.toBase58()}`,
  );
}

async function waitForLaunchReady(args: {
  slrd: Solard;
  prepared: PumpTokenLaunchPlan;
  launchSignature: string;
  mode: TraderSubmitMode;
  spam: SpamSubmitOptions;
  reporter?: LaunchReporter;
}): Promise<void> {
  const mode = normalizeTraderSubmitMode(args.mode);
  if (mode === "blind-spam-after-submit") return;

  const timeoutMs = args.spam.readinessTimeoutMs ?? args.spam.timeoutMs;
  const processed = await waitForSignatureAtLeastProcessed({
    connection: args.slrd.connection(),
    signature: args.launchSignature,
    timeoutMs,
    intervalMs: Math.min(args.spam.intervalMs, 100),
  });
  args.reporter?.("pump launch readiness", {
    signature: args.launchSignature,
    signatureState: processed,
  });

  if (mode === "spam-after-market-ready") {
    for (const item of deploymentReadinessAddresses(args.prepared.deployment)) {
      await waitForAccountExists({
        connection: args.slrd.connection(),
        address: item.address,
        timeoutMs,
        intervalMs: Math.min(args.spam.intervalMs, 100),
      });
      args.reporter?.("pump market readiness", {
        mint: args.prepared.deployment.mint.publicKey.toBase58(),
        account: item.label,
        address: item.address.toBase58(),
      });
    }
  }
}

async function signatureState(
  slrd: Solard,
  signature: string,
): Promise<"pending" | "success" | "failed"> {
  const state = await signatureReadiness(slrd.connection(), signature);
  if (state === "failed") return "failed";
  if (state === "processed" || state === "confirmed") return "success";
  return "pending";
}

function strategyToSubmitMode(
  strategy: BuyerLaunchStrategy | TraderSubmitMode | undefined,
  fallback: TraderSubmitMode,
): TraderSubmitMode {
  return normalizeTraderSubmitMode(strategy ?? fallback);
}

async function waitForBuyerStartMode(args: {
  slrd: Solard;
  prepared: PumpTokenLaunchPlan;
  launchSignature: string;
  mode: TraderSubmitMode;
  spam: SpamSubmitOptions;
  reporter?: LaunchReporter;
  wallet: string;
}): Promise<boolean> {
  const mode = normalizeTraderSubmitMode(args.mode);
  if (mode === "blind-spam-after-submit") return false;
  const timeoutMs = args.spam.readinessTimeoutMs ?? args.spam.timeoutMs;
  const processed = await waitForSignatureAtLeastProcessed({
    connection: args.slrd.connection(),
    signature: args.launchSignature,
    timeoutMs,
    intervalMs: Math.min(args.spam.intervalMs, 100),
  });
  args.reporter?.("pump buyer start gate", {
    wallet: args.wallet,
    mode,
    signatureState: processed,
  });

  if (mode === "after-deploy-confirmed") {
    const startedAt = Date.now();
    while (beforeDeadline(startedAt, timeoutMs)) {
      const state = await signatureReadiness(
        args.slrd.connection(),
        args.launchSignature,
      );
      if (state === "failed")
        throw new Error(
          `Launch failed before buyer ${args.wallet}: ${args.launchSignature}`,
        );
      if (state === "confirmed") break;
      await sleep(Math.min(args.spam.intervalMs, 100));
    }
    if (
      (await signatureReadiness(
        args.slrd.connection(),
        args.launchSignature,
      )) !== "confirmed"
    ) {
      throw new Error(
        `Launch was not confirmed before buyer ${args.wallet}: ${args.launchSignature}`,
      );
    }
  }

  if (mode === "spam-after-market-ready") {
    for (const item of deploymentReadinessAddresses(args.prepared.deployment)) {
      await waitForAccountExists({
        connection: args.slrd.connection(),
        address: item.address,
        timeoutMs,
        intervalMs: Math.min(args.spam.intervalMs, 100),
      });
      args.reporter?.("pump buyer market gate", {
        wallet: args.wallet,
        account: item.label,
        address: item.address.toBase58(),
      });
    }
  }

  return true;
}

async function spamDependentBuy(args: {
  slrd: Solard;
  template: PlannedTransaction;
  participant: BuyerAllocation;
  lane: BuyerLane;
  kind: string;
  options: SpamSubmitOptions & { launchSignature?: string };
  startMode?: TraderSubmitMode;
  prepared?: PumpTokenLaunchPlan;
  /** Builds a normal post-launch buy with a fresh quote. Used as soon as the market is visible. */
  buildReadyPlan?: () => Promise<PlannedTransaction>;
  sendLimiter?: SenderRateLimiter;
  reporter?: LaunchReporter;
}): Promise<SpamBuyerReceipt> {
  const startedAt = Date.now();
  const signatures: string[] = [];
  const recompileIntervalMs = args.options.recompileIntervalMs ?? 750;
  let failedAttempts = 0;
  let preReadyFailures = 0;
  let buildErrors = 0;
  let broadcastErrors = 0;
  let rateLimitErrors = 0;
  let resends = 0;
  let active: SubmittedPlan | null = null;
  let activeSince = 0;
  let launchReady = !args.options.launchSignature;
  let launchReadyAt: number | null = launchReady ? Date.now() : null;

  if (args.startMode && args.prepared && args.options.launchSignature) {
    const gatedReady = await waitForBuyerStartMode({
      slrd: args.slrd,
      prepared: args.prepared,
      launchSignature: args.options.launchSignature,
      mode: args.startMode,
      spam: args.options,
      reporter: args.reporter,
      wallet: args.participant.address,
    });
    if (gatedReady) {
      launchReady = true;
      launchReadyAt = Date.now();
    }
  }

  const shouldUseFreshQuote = () => {
    if (!launchReady || !args.buildReadyPlan) return false;
    const delayMs = args.options.freshQuoteDelayMs ?? 2_500;
    if (delayMs < 0) return false;
    if (delayMs === 0) return true;
    return launchReadyAt != null && Date.now() - launchReadyAt >= delayMs;
  };

  while (beforeDeadline(startedAt, args.options.timeoutMs)) {
    if (!launchReady && args.options.launchSignature) {
      const launchState = await signatureReadiness(
        args.slrd.connection(),
        args.options.launchSignature,
      );
      if (launchState === "failed") {
        throw new Error(
          `Launch failed before trader buy could land: ${args.options.launchSignature}`,
        );
      }
      const nextLaunchReady =
        launchState === "processed" || launchState === "confirmed";
      if (nextLaunchReady && !launchReady) launchReadyAt = Date.now();
      launchReady = nextLaunchReady;
    }

    if (!active) {
      if (
        launchReady &&
        args.options.maxFailedAttempts > 0 &&
        failedAttempts >= args.options.maxFailedAttempts
      ) {
        throw new Error(
          `trader ${args.participant.address} exhausted ${failedAttempts} post-readiness failed attempts`,
        );
      }

      let freshPlan: PlannedTransaction;
      let planSource:
        "pending-template" | "fresh-ready-quote" | "pending-template-fallback" =
        "pending-template";
      try {
        if (shouldUseFreshQuote()) {
          planSource = "fresh-ready-quote";
          freshPlan = await args.buildReadyPlan!();
        } else {
          freshPlan = await args.slrd.compile(
            args.slrd.signer(args.participant.walletRef),
            args.template.draft,
            { useAlts: false },
          );
        }
      } catch (error) {
        if (
          planSource === "fresh-ready-quote" &&
          isTransientMarketReadinessError(error)
        ) {
          try {
            planSource = "pending-template-fallback";
            freshPlan = await args.slrd.compile(
              args.slrd.signer(args.participant.walletRef),
              args.template.draft,
              { useAlts: false },
            );
          } catch (fallbackError) {
            buildErrors += 1;
            failedAttempts += launchReady ? 1 : 0;
            preReadyFailures += launchReady ? 0 : 1;
            args.reporter?.("pump buyer build retry", {
              lane: args.lane.lane,
              sender: String(args.lane.sender),
              wallet: args.participant.address,
              launchReady,
              failedAttempts,
              preReadyFailures,
              buildErrors,
              planSource,
              error: errorText(fallbackError),
            });
            await sleep(args.options.intervalMs);
            continue;
          }
        } else {
          buildErrors += 1;
          if (!launchReady || isTransientMarketReadinessError(error))
            preReadyFailures += 1;
          else failedAttempts += 1;
          args.reporter?.("pump buyer build retry", {
            lane: args.lane.lane,
            sender: String(args.lane.sender),
            wallet: args.participant.address,
            launchReady,
            failedAttempts,
            preReadyFailures,
            buildErrors,
            planSource,
            error: errorText(error),
          });
          await sleep(args.options.intervalMs);
          continue;
        }
      }

      try {
        await args.sendLimiter?.wait(args.lane.sender);
        active = await args.slrd.broadcastPlan(
          freshPlan,
          args.lane.sender,
          `${args.kind}:attempt:${failedAttempts + preReadyFailures + broadcastErrors + 1}`,
          { skipSimulation: true, skipPreflight: true },
        );
      } catch (error) {
        broadcastErrors += 1;
        if (isRateLimitError(error)) {
          rateLimitErrors += 1;
          args.reporter?.("pump buyer rate-limit retry", {
            lane: args.lane.lane,
            sender: String(args.lane.sender),
            wallet: args.participant.address,
            launchReady,
            rateLimitErrors,
            broadcastErrors,
            error: errorText(error),
          });
          await args.sendLimiter?.backoff(args.lane.sender, error);
          continue;
        }
        if (isTransientSenderError(error)) {
          args.reporter?.("pump buyer transient-send retry", {
            lane: args.lane.lane,
            sender: String(args.lane.sender),
            wallet: args.participant.address,
            launchReady,
            broadcastErrors,
            error: errorText(error),
          });
          await sleep(args.options.intervalMs + jitter(args.options.jitterMs));
          continue;
        }
        if (launchReady) failedAttempts += 1;
        else preReadyFailures += 1;
        args.reporter?.("pump buyer broadcast retry", {
          lane: args.lane.lane,
          sender: String(args.lane.sender),
          wallet: args.participant.address,
          launchReady,
          failedAttempts,
          preReadyFailures,
          broadcastErrors,
          error: errorText(error),
        });
        await sleep(args.options.intervalMs + jitter(args.options.jitterMs));
        continue;
      }

      activeSince = Date.now();
      signatures.push(active.signature);
      args.reporter?.("pump buyer attempt", {
        lane: args.lane.lane,
        sender: String(args.lane.sender),
        wallet: args.participant.address,
        launchReady,
        planSource,
        failedAttempts,
        preReadyFailures,
        signature: active.signature,
      });
    } else {
      const state = await signatureState(args.slrd, active.signature);
      if (state === "success") {
        const receipt = await args.slrd.confirmSubmitted(active, 15_000);
        return {
          role: "trader",
          address: args.participant.address,
          sender: String(args.lane.sender),
          receipt,
          failedAttempts,
          preReadyFailures,
          buildErrors,
          broadcastErrors,
          rateLimitErrors,
          resends,
          signatures,
        };
      }

      if (state === "failed") {
        if (launchReady) failedAttempts += 1;
        else preReadyFailures += 1;

        args.reporter?.("pump buyer retry", {
          lane: args.lane.lane,
          sender: String(args.lane.sender),
          wallet: args.participant.address,
          failedSignature: active.signature,
          launchReady,
          failedAttempts,
          preReadyFailures,
        });

        active = null;
        continue;
      }

      if (
        recompileIntervalMs > 0 &&
        Date.now() - activeSince >= recompileIntervalMs
      ) {
        args.reporter?.("pump buyer recompile", {
          lane: args.lane.lane,
          sender: String(args.lane.sender),
          wallet: args.participant.address,
          oldSignature: active.signature,
          ageMs: Date.now() - activeSince,
        });
        active = null;
        continue;
      }

      try {
        await args.sendLimiter?.wait(args.lane.sender);
        const signature = await args.slrd.senders
          .resolve(args.lane.sender)
          .send({
            connection: args.slrd.connection(),
            transaction: active.plan.transaction,
            options: { skipPreflight: true, skipSimulation: true },
          });

        if (signature !== active.signature) {
          throw new Error(
            `${String(args.lane.sender)} resend changed signature for ${args.participant.address}`,
          );
        }
        resends += 1;
      } catch (error) {
        if (isRateLimitError(error)) {
          rateLimitErrors += 1;
          args.reporter?.("pump buyer resend rate-limited", {
            lane: args.lane.lane,
            sender: String(args.lane.sender),
            wallet: args.participant.address,
            signature: active.signature,
            rateLimitErrors,
            error: errorText(error),
          });
          await args.sendLimiter?.backoff(args.lane.sender, error);
          continue;
        }
        if (isTransientSenderError(error)) {
          args.reporter?.("pump buyer resend transient-error", {
            lane: args.lane.lane,
            sender: String(args.lane.sender),
            wallet: args.participant.address,
            signature: active.signature,
            error: errorText(error),
          });
          await sleep(args.options.intervalMs + jitter(args.options.jitterMs));
          continue;
        }
        throw error;
      }
    }

    await sleep(args.options.intervalMs + jitter(args.options.jitterMs));
  }

  if (active) {
    const receipt = await args.slrd.confirmSubmitted(active, 5_000);
    if (receipt.status === "confirmed") {
      return {
        role: "trader",
        address: args.participant.address,
        sender: String(args.lane.sender),
        receipt,
        failedAttempts,
        preReadyFailures,
        buildErrors,
        broadcastErrors,
        rateLimitErrors,
        resends,
        signatures,
      };
    }
  }

  throw new Error(
    `trader ${args.participant.address} did not confirm within ${args.options.timeoutMs}ms; signatures=${signatures.join(",")}`,
  );
}

async function broadcastLaunchWithRetry(args: {
  slrd: Solard;
  plan: PlannedTransaction;
  sender: SenderId;
  kind: string;
  skipSimulation: boolean;
  spam: SpamSubmitOptions;
  sendLimiter: SenderRateLimiter;
  reporter?: LaunchReporter;
}): Promise<SubmittedPlan> {
  const startedAt = Date.now();
  let attempts = 0;
  let rateLimitErrors = 0;
  let transientErrors = 0;

  while (beforeDeadline(startedAt, args.spam.timeoutMs)) {
    attempts += 1;
    try {
      await args.sendLimiter.wait(args.sender);
      const submitted = await args.slrd.broadcastPlan(
        args.plan,
        args.sender,
        `${args.kind}:attempt:${attempts}`,
        { skipSimulation: args.skipSimulation, skipPreflight: true },
      );
      args.reporter?.("pump launch submit", {
        sender: String(args.sender),
        attempts,
        signature: submitted.signature,
      });
      return submitted;
    } catch (error) {
      if (isRateLimitError(error)) {
        rateLimitErrors += 1;
        args.reporter?.("pump launch rate-limit retry", {
          sender: String(args.sender),
          attempts,
          rateLimitErrors,
          error: errorText(error),
        });
        await args.sendLimiter.backoff(args.sender, error);
        continue;
      }
      if (isTransientSenderError(error)) {
        transientErrors += 1;
        args.reporter?.("pump launch transient-send retry", {
          sender: String(args.sender),
          attempts,
          transientErrors,
          error: errorText(error),
        });
        await sleep(args.spam.intervalMs + jitter(args.spam.jitterMs));
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `Launch transaction could not be submitted within ${args.spam.timeoutMs}ms`,
  );
}

export async function executeArmedPumpBuyers(args: {
  slrd: Solard;
  prepared: PumpTokenLaunchPlan;
  spam: SpamSubmitOptions;
  kind: string;
  reporter?: LaunchReporter;
}): Promise<TraderReceiptOutcome[]> {
  if (args.prepared.traders.length === 0) {
    throw new Error("Armed buyer plan has no traders.");
  }

  const sendLimiter = new SenderRateLimiter(args.spam, args.reporter);
  const stopBlockhashWarmer = startBlockhashWarmer(
    args.slrd,
    args.spam.blockhashRefreshIntervalMs ?? 500,
    args.reporter,
  );
  const mintRef = args.prepared.deployment.mint.publicKey.toBase58();
  let tokenPersisted = false;
  const ensureTokenPersisted = () => {
    if (tokenPersisted) return;
    args.slrd.persistPreparedDeployment(
      args.prepared.deployment,
      args.prepared.token.alias,
    );
    tokenPersisted = true;
  };

  try {
    args.reporter?.("pump armed buyer spam start", {
      mint: mintRef,
      buyers: args.prepared.traders.length,
    });

    const settled = await Promise.allSettled(
      args.prepared.traderPlans.map((plan, index) => {
        const participant = args.prepared.traders[index]!;
        return spamDependentBuy({
          slrd: args.slrd,
          template: plan,
          participant,
          lane: args.prepared.traderLanes[index]!,
          kind: `${args.kind}:trader:${index + 1}`,
          options: {
            ...args.spam,
            intervalMs:
              participant.execution?.retryIntervalMs ?? args.spam.intervalMs,
            recompileIntervalMs:
              participant.execution?.recompileIntervalMs ??
              args.spam.recompileIntervalMs,
            freshQuoteDelayMs:
              participant.execution?.freshQuoteDelayMs ??
              args.spam.freshQuoteDelayMs,
            maxFailedAttempts:
              participant.execution?.maxFailedAttempts ??
              args.spam.maxFailedAttempts,
          },
          // FIRE is deliberately before deployment broadcast. No signature gate.
          startMode: "blind-spam-after-submit",
          prepared: args.prepared,
          buildReadyPlan: async () => {
            ensureTokenPersisted();
            const builder = args.slrd
              .tx(participant.walletRef)
              .priorityFee({
                cuLimit: args.prepared.cuLimit,
                microLamports:
                  participant.execution?.priorityMicroLamports ??
                  args.prepared.buyerPriorityMicroLamports,
              })
              .buy(mintRef, rawAmount(participant.spendLamports, SOL_ASSET), {
                slippageBps:
                  participant.execution?.slippageBps ??
                  args.prepared.slippageBps,
              });

            addTip(
              builder as unknown as ReturnType<Solard["transaction"]>,
              args.slrd.signer(participant.walletRef).publicKey,
              String(args.prepared.traderLanes[index]!.sender) ===
                "helius-fast" && participant.execution?.tipLamports != null
                ? {
                    ...args.prepared.traderLanes[index]!.tip,
                    lamports: participant.execution.tipLamports,
                  }
                : args.prepared.traderLanes[index]!.tip,
            );
            const draft = await builder.materializedDraft();
            return await args.slrd.compile(
              args.slrd.signer(participant.walletRef),
              draft,
              { useAlts: false },
            );
          },
          sendLimiter,
          reporter: args.reporter,
        });
      }),
    );

    const outcomes: TraderReceiptOutcome[] = settled.map((item, index) =>
      item.status === "fulfilled"
        ? {
            ok: true,
            index,
            address: args.prepared.traders[index]!.address,
            result: item.value,
          }
        : {
            ok: false,
            index,
            address: args.prepared.traders[index]!.address,
            error:
              item.reason instanceof Error
                ? item.reason.message
                : String(item.reason),
          },
    );

    args.reporter?.("pump armed buyer spam complete", {
      mint: mintRef,
      succeeded: outcomes.filter((item) => item.ok).length,
      failed: outcomes.filter((item) => !item.ok).length,
    });
    return outcomes;
  } finally {
    stopBlockhashWarmer();
  }
}

function instructionHasDiscriminator(
  data: Buffer,
  discriminator: Buffer,
): boolean {
  return (
    data.length >= discriminator.length &&
    data.subarray(0, discriminator.length).equals(discriminator)
  );
}

function assertJitoPumpBundleLayout(args: {
  prepared: PumpTokenLaunchPlan;
  plans: PlannedTransaction[];
}): void {
  if (args.plans.length < 2 || args.plans.length > 5) {
    throw new Error(
      `Pump Jito bundle must contain deployment plus 1..4 buyers; got ${args.plans.length} transactions.`,
    );
  }

  const blockhashes = new Set(args.plans.map((plan) => plan.recentBlockhash));
  if (blockhashes.size !== 1) {
    throw new Error(
      `Pump Jito bundle transactions must share one recent blockhash; got ${blockhashes.size}.`,
    );
  }

  for (const [index, plan] of args.plans.entries()) {
    if (plan.lookupTables.length !== 0) {
      throw new Error(
        `Pump Jito transaction ${index + 1} unexpectedly uses ` +
          `${plan.lookupTables.length} address lookup table(s). ` +
          `This launch path requires fully static account keys.`,
      );
    }
    if (plan.serializedSize > 1_232) {
      throw new Error(
        `Pump Jito transaction ${index + 1} is ${plan.serializedSize} bytes; ` +
          `the Solana packet limit is 1232 bytes.`,
      );
    }
  }

  const createInstruction = args.plans[0]!.draft.instructions.find(
    (instruction) =>
      instruction.programId.equals(PUMP_PROGRAM_ID) &&
      instructionHasDiscriminator(instruction.data, CREATE_V2_D8),
  );
  if (!createInstruction) {
    throw new Error("Pump deployment transaction is missing create_v2.");
  }
  if (createInstruction.keys.length !== 16) {
    throw new Error(
      `SOL-paired Pump create_v2 must have 16 accounts; got ` +
        `${createInstruction.keys.length}.`,
    );
  }

  for (let index = 1; index < args.plans.length; index += 1) {
    const buyInstruction = args.plans[index]!.draft.instructions.find(
      (instruction) =>
        instruction.programId.equals(PUMP_PROGRAM_ID) &&
        instructionHasDiscriminator(instruction.data, BUY_EXACT_QUOTE_IN_V2_D8),
    );
    if (!buyInstruction) {
      throw new Error(
        `Pump buyer transaction ${index + 1} is missing buy_exact_quote_in_v2.`,
      );
    }

    // Pump's current public IDL defines exactly 27 mandatory accounts for
    // buy_exact_quote_in_v2. There are no optional or trailing accounts.
    if (buyInstruction.keys.length !== 27) {
      throw new Error(
        `Pump buyer transaction ${index + 1} must have the official ` +
          `27-account buy_exact_quote_in_v2 layout; got ` +
          `${buyInstruction.keys.length}.`,
      );
    }

    const user = buyInstruction.keys[13];
    const systemProgram = buyInstruction.keys[24];
    const program = buyInstruction.keys[26];

    if (!user?.isSigner || !user.isWritable) {
      throw new Error(
        `Pump buyer transaction ${index + 1} must mark account 14 ` +
          `(user) writable and signer.`,
      );
    }
    if (!systemProgram?.pubkey.equals(SystemProgram.programId)) {
      throw new Error(
        `Pump buyer transaction ${index + 1} has the wrong account 25 ` +
          `(system_program).`,
      );
    }
    if (!program?.pubkey.equals(PUMP_PROGRAM_ID)) {
      throw new Error(
        `Pump buyer transaction ${index + 1} has the wrong account 27 ` +
          `(program).`,
      );
    }
  }
}

type BundleSimulationTransactionResult = {
  err?: unknown;
  logs?: string[] | null;
  unitsConsumed?: number | null;
};

type BundleSimulationResponse = {
  context?: {
    slot?: number;
    apiVersion?: string;
  };
  value?: {
    summary?: unknown;
    transactionResults?: BundleSimulationTransactionResult[];
  };
};

function requiredBundleSimulationRpcUrl(): string {
  const value = process.env.JITO_BUNDLE_SIMULATION_RPC_URL?.trim();
  if (!value) {
    throw new Error(
      "Atomic Jito bundle simulation is required before submission. " +
        "Configure -BundleSimulationRpcUrl in the interactive launcher with " +
        "a Jito-enabled RPC that supports simulateBundle. A normal public " +
        "Solana RPC cannot simulate state across ordered transactions.",
    );
  }

  try {
    new URL(value);
  } catch {
    throw new Error(
      "JITO_BUNDLE_SIMULATION_RPC_URL must be a valid HTTP(S) URL.",
    );
  }

  return value;
}

function safeEndpointLabel(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "configured bundle simulation RPC";
  }
}

function simulationSummarySucceeded(summary: unknown): boolean {
  return (
    typeof summary === "string" && summary.trim().toLowerCase() === "succeeded"
  );
}

type AtomicBundleSimulationResult = {
  unitsConsumed: Array<number | null>;
  slot: number | null;
};

async function simulateAtomicJitoBundle(args: {
  plans: PlannedTransaction[];
  reporter?: LaunchReporter;
  generation: number;
  pass: "baseline" | "optimized";
}): Promise<AtomicBundleSimulationResult> {
  const endpoint = requiredBundleSimulationRpcUrl();
  const encodedTransactions = args.plans.map((plan) =>
    Buffer.from(plan.transaction.serialize()).toString("base64"),
  );
  const accountConfigs = args.plans.map(() => null);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "simulateBundle",
        params: [
          { encodedTransactions },
          {
            preExecutionAccountsConfigs: accountConfigs,
            postExecutionAccountsConfigs: accountConfigs,
            skipSigVerify: false,
            simulationBank: {
              commitment: { commitment: "processed" },
            },
            transactionEncoding: "base64",
            replaceRecentBlockhash: false,
          },
        ],
      }),
    });
  } catch (error) {
    throw new Error(
      `simulateBundle request failed through ${safeEndpointLabel(endpoint)}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const raw = await response.text();
  let payload: {
    result?: BundleSimulationResponse;
    error?: unknown;
  } | null = null;
  try {
    payload = JSON.parse(raw) as {
      result?: BundleSimulationResponse;
      error?: unknown;
    };
  } catch {
    // Preserve raw text in the error below.
  }

  if (!response.ok || payload?.error || !payload?.result?.value) {
    const detail = JSON.stringify(
      payload?.error ?? raw.slice(0, 1_000) ?? response.status,
    );
    const unsupported =
      /method not found|unsupported|unauthorized|forbidden|upgrade/i.test(
        detail,
      );

    throw new Error(
      `Atomic bundle simulation failed through ` +
        `${safeEndpointLabel(endpoint)} with HTTP ${response.status}: ${detail}` +
        (unsupported
          ? " Configure -BundleSimulationRpcUrl with a Jito-enabled RPC " +
            "that supports simulateBundle. sendBundle still goes directly " +
            "to Jito."
          : ""),
    );
  }

  const value = payload.result.value;
  const transactionResults = value.transactionResults ?? [];
  const normalizedResults = args.plans.map((plan, index) => {
    const result = transactionResults[index] ?? {};
    return {
      transactionIndex: index + 1,
      role: index === 0 ? "deployment" : `buyer-${index}`,
      signature: bs58.encode(plan.transaction.signatures[0]!),
      success: result.err == null,
      error: result.err ?? null,
      unitsConsumed: result.unitsConsumed ?? null,
      lastLogs: (result.logs ?? []).slice(-20),
    };
  });

  const firstFailure = normalizedResults.find((result) => !result.success);
  const success =
    simulationSummarySucceeded(value.summary) &&
    firstFailure == null &&
    transactionResults.length === args.plans.length;

  args.reporter?.("pump jito atomic bundle simulation", {
    generation: args.generation,
    pass: args.pass,
    endpoint: safeEndpointLabel(endpoint),
    slot: payload.result.context?.slot ?? null,
    apiVersion: payload.result.context?.apiVersion ?? null,
    summary: value.summary ?? null,
    success,
    transactionCount: args.plans.length,
    transactions: normalizedResults,
  });

  if (!success) {
    const failure = firstFailure ?? normalizedResults.at(-1);
    const logs = failure?.lastLogs ?? [];
    throw new Error(
      `Atomic Jito bundle simulation failed before submission. ` +
        `Transaction ${failure?.transactionIndex ?? "unknown"} ` +
        `(${failure?.role ?? "unknown"}) error: ` +
        `${JSON.stringify(failure?.error ?? value.summary ?? "unknown")}` +
        (logs.length > 0 ? `\n${logs.join("\n")}` : ""),
    );
  }

  return {
    unitsConsumed: normalizedResults.map(
      (result) => result.unitsConsumed ?? null,
    ),
    slot: payload.result.context?.slot ?? null,
  };
}

async function validateJitoBundleGeneration(args: {
  slrd: Solard;
  prepared: PumpTokenLaunchPlan;
  plans: PlannedTransaction[];
  reporter?: LaunchReporter;
  generation: number;
  pass: "baseline" | "optimized";
}): Promise<AtomicBundleSimulationResult> {
  assertJitoPumpBundleLayout({
    prepared: args.prepared,
    plans: args.plans,
  });

  return await simulateAtomicJitoBundle({
    plans: args.plans,
    reporter: args.reporter,
    generation: args.generation,
    pass: args.pass,
  });
}

function bundleNumberSetting(
  name: string,
  fallback: number,
  minimum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be at least ${minimum}; got ${raw}`);
  }
  return value;
}

function optimizedJitoCuLimit(
  consumed: number | null,
  current: number | undefined,
): number {
  const currentLimit =
    current != null && Number.isFinite(current) && current > 0
      ? Math.trunc(current)
      : 600_000;
  if (consumed == null || !Number.isFinite(consumed) || consumed <= 0) {
    return currentLimit;
  }

  const multiplier = bundleNumberSetting(
    "JITO_BUNDLE_CU_SAFETY_MULTIPLIER",
    1.3,
    1,
  );
  const padding = Math.trunc(
    bundleNumberSetting("JITO_BUNDLE_CU_PADDING", 30_000, 0),
  );
  const minimum = Math.trunc(
    bundleNumberSetting("JITO_BUNDLE_CU_MINIMUM", 150_000, 1),
  );
  const raw = Math.ceil(consumed * multiplier + padding);
  const rounded = Math.ceil(raw / 10_000) * 10_000;
  return Math.min(currentLimit, Math.max(minimum, rounded));
}

async function optimizeJitoBundleForAuction(args: {
  slrd: Solard;
  prepared: PumpTokenLaunchPlan;
  plans: PlannedTransaction[];
  simulation: AtomicBundleSimulationResult;
  reporter?: LaunchReporter;
  generation: number;
}): Promise<{
  changed: boolean;
  plans: PlannedTransaction[];
}> {
  const optimizedLimits = args.plans.map((plan, index) =>
    optimizedJitoCuLimit(
      args.simulation.unitsConsumed[index] ?? null,
      plan.draft.cuLimit,
    ),
  );

  const changed = args.plans.some(
    (plan, index) =>
      plan.draft.cuLimit !== optimizedLimits[index] ||
      plan.draft.cuPriceMicroLamports !== 0,
  );
  if (!changed) {
    return { changed: false, plans: args.plans };
  }

  const optimizedDrafts = args.plans.map((plan, index) => ({
    ...plan.draft,
    instructions: [...plan.draft.instructions],
    signers: [...plan.draft.signers],
    actions: [...plan.draft.actions],
    trackedAccounts: [...plan.draft.trackedAccounts],
    cuLimit: optimizedLimits[index],
    // Jito's sendBundle auction uses the Jito tip. A CU price only spends
    // additional lamports and does not improve bundle auction ranking.
    cuPriceMicroLamports: 0,
  }));

  const launchPlan = await args.slrd.compile(
    args.slrd.signer(args.prepared.creatorWallet),
    optimizedDrafts[0]!,
    { useAlts: false },
  );
  const traderPlans = await Promise.all(
    optimizedDrafts.slice(1).map((draft, index) => {
      const trader = args.prepared.traders[index];
      if (!trader) {
        throw new Error(
          `Missing trader allocation for Jito transaction ${index + 2}`,
        );
      }
      return args.slrd.compile(args.slrd.signer(trader.walletRef), draft, {
        useAlts: false,
      });
    }),
  );

  args.prepared.launchDraft = optimizedDrafts[0]!;
  args.prepared.launchPlan = launchPlan;
  args.prepared.traderPlans = traderPlans;

  const beforeTotal = args.plans.reduce(
    (sum, plan) => sum + (plan.draft.cuLimit ?? 600_000),
    0,
  );
  const afterTotal = optimizedLimits.reduce((sum, value) => sum + value, 0);

  args.reporter?.("pump jito auction compute optimization", {
    generation: args.generation,
    measuredUnits: args.simulation.unitsConsumed,
    requestedBefore: args.plans.map((plan) => plan.draft.cuLimit ?? 600_000),
    requestedAfter: optimizedLimits,
    totalRequestedBefore: beforeTotal,
    totalRequestedAfter: afterTotal,
    auctionEfficiencyGain:
      afterTotal > 0 ? Number((beforeTotal / afterTotal).toFixed(3)) : null,
    priorityMicroLamportsAfter: 0,
  });

  return {
    changed: true,
    plans: [launchPlan, ...traderPlans],
  };
}

function bundleTipEscalationMultiplier(): number {
  return bundleNumberSetting("JITO_BUNDLE_TIP_ESCALATION_MULTIPLIER", 2, 1);
}

function bundleTipMaximumLamports(): bigint {
  const raw = process.env.JITO_BUNDLE_TIP_MAX_LAMPORTS?.trim();
  if (!raw) return 100_000_000n;
  try {
    const value = BigInt(raw);
    if (value < 1_000n) {
      throw new Error("below minimum");
    }
    return value;
  } catch {
    throw new Error(
      `JITO_BUNDLE_TIP_MAX_LAMPORTS must be an integer of at least 1000; got ${raw}`,
    );
  }
}

function escalateJitoTipForRefresh(args: {
  prepared: PumpTokenLaunchPlan;
  refresh: number;
  reporter?: LaunchReporter;
}): boolean {
  const finalIndex = args.prepared.traderPlans.length - 1;
  const finalPlan = args.prepared.traderPlans[finalIndex];
  const trader = args.prepared.traders[finalIndex];
  if (!finalPlan || !trader) {
    throw new Error("Cannot escalate Jito tip without a final buyer.");
  }

  const actionIndex = finalPlan.draft.actions.findIndex(
    (action) => action.kind === "jito-tip",
  );
  const action = finalPlan.draft.actions[actionIndex];
  const recipient = action?.recipient;
  const currentRaw = action?.meta?.lamports;
  if (
    actionIndex < 0 ||
    !recipient ||
    typeof currentRaw !== "string" ||
    !/^\d+$/.test(currentRaw)
  ) {
    throw new Error(
      "Cannot escalate Jito tip because the final buyer tip metadata is missing.",
    );
  }

  const current = BigInt(currentRaw);
  const maximum = bundleTipMaximumLamports();
  const multiplier = bundleTipEscalationMultiplier();
  const multiplied = BigInt(Math.ceil(Number(current) * multiplier));
  const next = multiplied > maximum ? maximum : multiplied;
  if (next <= current) {
    args.reporter?.("pump jito tip escalation", {
      refresh: args.refresh,
      currentLamports: current.toString(),
      nextLamports: current.toString(),
      maximumLamports: maximum.toString(),
      changed: false,
    });
    return false;
  }

  let instructionIndex = -1;
  for (
    let index = finalPlan.draft.instructions.length - 1;
    index >= 0;
    index -= 1
  ) {
    const instruction = finalPlan.draft.instructions[index]!;
    if (
      instruction.programId.equals(SystemProgram.programId) &&
      instruction.keys.some((key) => key.pubkey.equals(recipient))
    ) {
      instructionIndex = index;
      break;
    }
  }
  if (instructionIndex < 0) {
    throw new Error(
      "Cannot escalate Jito tip because its System Program transfer was not found.",
    );
  }

  const instructions = [...finalPlan.draft.instructions];
  instructions[instructionIndex] = SystemProgram.transfer({
    fromPubkey: finalPlan.payer,
    toPubkey: recipient,
    lamports: next,
  });

  const actions = finalPlan.draft.actions.map((candidate, index) =>
    index === actionIndex
      ? {
          ...candidate,
          meta: {
            ...(candidate.meta ?? {}),
            lamports: next.toString(),
          },
        }
      : candidate,
  );

  finalPlan.draft = {
    ...finalPlan.draft,
    instructions,
    actions,
  };

  args.reporter?.("pump jito tip escalation", {
    refresh: args.refresh,
    currentLamports: current.toString(),
    nextLamports: next.toString(),
    maximumLamports: maximum.toString(),
    multiplier,
    changed: true,
  });

  return true;
}

function positiveBundleGenerationLimit(): number {
  const raw = process.env.JITO_BUNDLE_MAX_GENERATIONS?.trim();
  if (!raw) return 5;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error(
      `JITO_BUNDLE_MAX_GENERATIONS must be an integer from 1 to 100; got ${raw}`,
    );
  }
  return parsed;
}

async function rebuildJitoBundlePlans(args: {
  slrd: Solard;
  prepared: PumpTokenLaunchPlan;
  refresh: number;
  reporter?: LaunchReporter;
}): Promise<PlannedTransaction[]> {
  const tipChanged = escalateJitoTipForRefresh({
    prepared: args.prepared,
    refresh: args.refresh,
    reporter: args.reporter,
  });
  if (!tipChanged) {
    throw new Error(
      "The Jito tip has reached its configured maximum without landing. " +
        "No additional generation was submitted.",
    );
  }

  args.slrd.blockhash.invalidate();

  const launchPlan = await args.slrd.compile(
    args.slrd.signer(args.prepared.creatorWallet),
    args.prepared.launchDraft,
    { useAlts: false },
  );

  const traderPlans = await Promise.all(
    args.prepared.traderPlans.map((plan, index) => {
      const trader = args.prepared.traders[index];
      if (!trader) {
        throw new Error(
          `Missing trader allocation for Jito bundle transaction ${index + 2}`,
        );
      }
      return args.slrd.compile(args.slrd.signer(trader.walletRef), plan.draft, {
        useAlts: false,
      });
    }),
  );

  args.prepared.launchPlan = launchPlan;
  args.prepared.traderPlans = traderPlans;
  return [launchPlan, ...traderPlans];
}

export async function executePumpTokenLaunch(args: {
  slrd: Solard;
  prepared: PumpTokenLaunchPlan;
  live: boolean;
  traderSubmitMode: TraderSubmitMode;
  skipSimulation: boolean;
  spam: SpamSubmitOptions;
  kind: string;
  reporter?: LaunchReporter;
  /** Runs immediately before the first deployment broadcast attempt. */
  beforeDeploymentBroadcast?: () => Promise<void>;
  /** Runs only when deployment could not be broadcast. */
  onDeploymentBroadcastFailure?: (error: unknown) => Promise<void>;
}): Promise<PumpTokenLaunchResult> {
  const submitMode = normalizeTraderSubmitMode(args.traderSubmitMode);

  if (!args.live) {
    return {
      mode: "dry-run",
      launchSimulation: await simulatePumpTokenLaunch({
        slrd: args.slrd,
        prepared: args.prepared,
      }),
      deploymentSender: String(args.prepared.deploymentSender),
      buyers: args.prepared.expectedOutputByWallet,
      note: "Create and creator initial buy are simulated in one transaction; trader buys are compiled against the pending Pump market and sent after deployment readiness in live mode.",
    };
  }

  if (submitMode === "jito-bundle") {
    let plans = [args.prepared.launchPlan, ...args.prepared.traderPlans];
    if (args.prepared.traders.length > 4) {
      throw new Error(
        `jito-bundle supports deployment plus at most 4 buyers; got ${args.prepared.traders.length} buyers.`,
      );
    }
    const launchHasJitoTip = args.prepared.launchPlan.draft.actions.some(
      (action) => action.kind === "jito-tip",
    );
    const finalTraderPlan = args.prepared.traderPlans.at(-1);
    const finalBuyerHasJitoTip = Boolean(
      finalTraderPlan?.draft.actions.some(
        (action) => action.kind === "jito-tip",
      ),
    );
    const jitoTipCount = plans.reduce(
      (count, plan) =>
        count +
        plan.draft.actions.filter((action) => action.kind === "jito-tip")
          .length,
      0,
    );
    if (launchHasJitoTip || !finalBuyerHasJitoTip || jitoTipCount !== 1) {
      throw new Error(
        "jito-bundle requires exactly one Jito tip in the final buyer transaction and no tip in the deployment transaction.",
      );
    }

    args.reporter?.("pump jito bundle submit", {
      mint: args.prepared.deployment.mint.publicKey.toBase58(),
      transactions: plans.length,
      buyers: args.prepared.traders.length,
      tipTransactionIndex: plans.length,
    });

    const maxGenerations = positiveBundleGenerationLimit();
    let completedGenerations = 0;
    let batch: Awaited<ReturnType<Solard["sendBatchPlans"]>>;

    while (true) {
      const generation = completedGenerations + 1;
      const baselineSimulation = await validateJitoBundleGeneration({
        slrd: args.slrd,
        prepared: args.prepared,
        plans,
        reporter: args.reporter,
        generation,
        pass: "baseline",
      });

      const optimized = await optimizeJitoBundleForAuction({
        slrd: args.slrd,
        prepared: args.prepared,
        plans,
        simulation: baselineSimulation,
        reporter: args.reporter,
        generation,
      });
      plans = optimized.plans;

      if (optimized.changed) {
        await validateJitoBundleGeneration({
          slrd: args.slrd,
          prepared: args.prepared,
          plans,
          reporter: args.reporter,
          generation,
          pass: "optimized",
        });
      }

      try {
        batch = await args.slrd.sendBatchPlans(
          plans,
          "jito",
          `${args.kind}:jito-bundle:generation-${generation}`,
          { skipSimulation: true, skipPreflight: true },
        );
        break;
      } catch (error) {
        const expired = isJitoBundleExpiredError(error);
        const retryGeneration = isJitoBundleGenerationRetryError(error);

        if (!expired && !retryGeneration) {
          throw error;
        }

        const reason = error instanceof Error ? error.message : String(error);

        args.reporter?.("pump jito generation not landed", {
          mint: args.prepared.deployment.mint.publicKey.toBase58(),
          generation,
          reasonType: expired ? "blockhash-expired" : "landing-window-closed",
          reason,
        });

        if (generation >= maxGenerations) {
          throw new Error(
            `Jito bundle did not land after ${maxGenerations} fresh ` +
              `tip generation(s). Last error: ${reason}`,
          );
        }

        completedGenerations += 1;

        args.reporter?.("pump jito fresh generation", {
          mint: args.prepared.deployment.mint.publicKey.toBase58(),
          completedGeneration: generation,
          nextGeneration: completedGenerations + 1,
          maximumGenerations: maxGenerations,
          newBlockhash: true,
          newSignatures: true,
          identicalByteResubmission: false,
          reason,
        });

        plans = await rebuildJitoBundlePlans({
          slrd: args.slrd,
          prepared: args.prepared,
          refresh: completedGenerations,
          reporter: args.reporter,
        });

        args.reporter?.("pump jito bundle rebuilt", {
          mint: args.prepared.deployment.mint.publicKey.toBase58(),
          escalation: completedGenerations,
          generation: completedGenerations + 1,
          recentBlockhash: plans[0]!.recentBlockhash,
          lastValidBlockHeight: Math.min(
            ...plans.map((plan) => plan.lastValidBlockHeight),
          ),
          signaturesChanged: true,
          transactionCount: plans.length,
        });
      }
    }

    const [launchReceipt, ...traderReceipts] = batch.receipts;
    if (!launchReceipt) {
      throw new Error("Jito bundle returned no deployment receipt.");
    }

    return {
      mode: submitMode,
      launchReceipt,
      traderReceipts,
    };
  }

  const sendLimiter = new SenderRateLimiter(args.spam, args.reporter);
  const stopBlockhashWarmer = startBlockhashWarmer(
    args.slrd,
    args.spam.blockhashRefreshIntervalMs ?? 500,
    args.reporter,
  );
  try {
    if (args.beforeDeploymentBroadcast) {
      args.reporter?.("pump armed buyer release before deployment", {
        mint: args.prepared.deployment.mint.publicKey.toBase58(),
      });
      await args.beforeDeploymentBroadcast();
    }

    let launch: SubmittedPlan;
    try {
      launch = await broadcastLaunchWithRetry({
        slrd: args.slrd,
        plan: args.prepared.launchPlan,
        sender: args.prepared.deploymentSender,
        kind: `${args.kind}:create-and-creator-buy`,
        skipSimulation: args.skipSimulation,
        spam: args.spam,
        sendLimiter,
        reporter: args.reporter,
      });
    } catch (error) {
      await args.onDeploymentBroadcastFailure?.(error);
      throw error;
    }

    if (submitMode === "after-deploy-confirmed") {
      const launchReceipt = await args.slrd.confirmSubmitted(launch);
      if (launchReceipt.status !== "confirmed") {
        throw new Error(
          `Token create + creator initial buy did not confirm: ${launchReceipt.status}`,
        );
      }

      const traderReceipts = await Promise.all(
        args.prepared.traderPlans.map((plan, index) =>
          args.slrd.sendPlan(
            plan,
            args.prepared.traderLanes[index]!.sender,
            `${args.kind}:trader:${index + 1}`,
            { skipSimulation: false, skipPreflight: true },
          ),
        ),
      );

      return { mode: submitMode, launchReceipt, traderReceipts };
    }

    const hasPerBuyerStrategy = args.prepared.traders.some(
      (trader) => trader.execution?.strategy,
    );
    if (!hasPerBuyerStrategy) {
      await waitForLaunchReady({
        slrd: args.slrd,
        prepared: args.prepared,
        launchSignature: launch.signature,
        mode: submitMode,
        spam: args.spam,
        reporter: args.reporter,
      });
    }

    const mintRef = args.prepared.deployment.mint.publicKey.toBase58();
    let tokenPersisted = false;
    const ensureTokenPersisted = () => {
      if (!tokenPersisted) {
        args.slrd.persistPreparedDeployment(
          args.prepared.deployment,
          args.prepared.token.alias,
        );
        tokenPersisted = true;
      }
    };

    const settled = await Promise.allSettled(
      args.prepared.traderPlans.map((plan, index) => {
        const participant = args.prepared.traders[index]!;
        return spamDependentBuy({
          slrd: args.slrd,
          template: plan,
          participant,
          lane: args.prepared.traderLanes[index]!,
          kind: `${args.kind}:trader:${index + 1}`,
          options: {
            ...args.spam,
            launchSignature: launch.signature,
            intervalMs:
              participant.execution?.retryIntervalMs ?? args.spam.intervalMs,
            recompileIntervalMs:
              participant.execution?.recompileIntervalMs ??
              args.spam.recompileIntervalMs,
            freshQuoteDelayMs:
              participant.execution?.freshQuoteDelayMs ??
              args.spam.freshQuoteDelayMs,
            maxFailedAttempts:
              participant.execution?.maxFailedAttempts ??
              args.spam.maxFailedAttempts,
          },
          startMode: strategyToSubmitMode(
            participant.execution?.strategy,
            submitMode,
          ),
          prepared: args.prepared,
          buildReadyPlan: async () => {
            ensureTokenPersisted();
            const builder = args.slrd
              .tx(participant.walletRef)
              .priorityFee({
                cuLimit: args.prepared.cuLimit,
                microLamports:
                  participant.execution?.priorityMicroLamports ??
                  args.prepared.buyerPriorityMicroLamports,
              })
              .buy(mintRef, rawAmount(participant.spendLamports, SOL_ASSET), {
                slippageBps:
                  participant.execution?.slippageBps ??
                  args.prepared.slippageBps,
              });

            // Helius Sender validates that the transaction contains a static SOL
            // transfer to one of its tip accounts. Do not use builder.build() here:
            // the default compiler may use ALTs, which can make the tip account
            // invisible to Sender's preflight validator. The pre-launch template
            // path already compiles with useAlts:false; the post-readiness fresh
            // quote path must do the same.
            addTip(
              builder as unknown as ReturnType<Solard["transaction"]>,
              args.slrd.signer(participant.walletRef).publicKey,
              String(args.prepared.traderLanes[index]!.sender) ===
                "helius-fast" && participant.execution?.tipLamports != null
                ? {
                    ...args.prepared.traderLanes[index]!.tip,
                    lamports: participant.execution.tipLamports,
                  }
                : args.prepared.traderLanes[index]!.tip,
            );
            const draft = await builder.materializedDraft();
            return await args.slrd.compile(
              args.slrd.signer(participant.walletRef),
              draft,
              { useAlts: false },
            );
          },
          sendLimiter,
          reporter: args.reporter,
        });
      }),
    );

    const launchReceipt = await args.slrd.confirmSubmitted(launch);
    const traderReceipts: TraderReceiptOutcome[] = settled.map((item, index) =>
      item.status === "fulfilled"
        ? {
            ok: true,
            index,
            address: args.prepared.traders[index]!.address,
            result: item.value,
          }
        : {
            ok: false,
            index,
            address: args.prepared.traders[index]!.address,
            error:
              item.reason instanceof Error
                ? item.reason.message
                : String(item.reason),
          },
    );

    return { mode: submitMode, launchReceipt, traderReceipts };
  } finally {
    stopBlockhashWarmer();
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();
}
