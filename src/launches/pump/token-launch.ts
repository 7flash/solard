import { PublicKey, SystemProgram, type Connection } from "@solana/web3.js";

import { rawAmount, SOL_ASSET } from "../../core/amounts.js";
import type { WalletRef } from "../../core/refs.js";
import type { Sowl } from "../../sdk/sowl.js";
import { HeliusSender } from "../../tx/senders/helius-sender.js";
import { HttpRpcSender } from "../../tx/senders/http-rpc-sender.js";
import type {
  PlannedTransaction,
  SendReceipt,
  SenderId,
  SubmittedPlan,
  TransactionDraft,
} from "../../tx/types.js";
import type {
  PendingMarketState,
  PreparedPendingBuy,
  PreparedTokenDeployment,
} from "../launchpad.js";

export type TokenMetadata = {
  alias: string;
  name: string;
  symbol: string;
  uri: string;
};

export type BuyerAllocation = {
  role: "creator" | "trader";
  walletRef: WalletRef;
  address: string;
  balanceLamports: bigint;
  reserveLamports: bigint;
  selectedBps: number | null;
  spendLamports: bigint;
};

export type TraderSubmitMode =
  | "after-deploy-confirmed"
  | "after-deploy-processed"
  | "spam-after-market-ready"
  | "blind-spam-after-submit"
  /** Human-friendly alias for blind-spam-after-submit. */
  | "fast-spam"
  /** Backwards-compatible alias for blind-spam-after-submit. */
  | "spam-after-deploy-submit";

export type TipConfig = { account?: string; lamports?: bigint };

export type SpamSubmitOptions = {
  /** Delay between send/resend loops. Keep small for fast launches. */
  intervalMs: number;
  /** Overall per-buyer deadline. Use 0 for no deadline; the loop then stops only on success or terminal launch failure. */
  timeoutMs: number;
  /** Post-readiness failed landed transactions before giving up. Use 0 for unlimited. */
  maxFailedAttempts: number;
  /** Recompile with a fresh blockhash and fresh quote at this cadence while a signature is still pending. */
  recompileIntervalMs?: number;
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
};

export type PumpLaunchEnvironment = {
  rpcUrl: string;
  senderUrl?: string;
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
      launchSimulation: Awaited<ReturnType<Sowl["simulatePlan"]>>;
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

type LaunchSenderName = "helius-fast" | "helius-rpc";

function envString(name: string): string | undefined {
  const primary = process.env[name]?.trim();
  if (primary) return primary;
  const solwalAlias = name.startsWith("SOWL_")
    ? process.env[`SOLWAL_${name.slice("SOWL_".length)}`]?.trim()
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

  if (value !== "helius-fast" && value !== "helius-rpc") {
    throw new Error(
      `Invalid ${name}: ${value}. Expected "helius-fast" or "helius-rpc".`,
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
    value === "blind-spam-after-submit"
  ) {
    return value;
  }
  throw new Error(
    `Invalid SOWL_LAUNCH_SUBMIT_MODE: ${value}. Expected after-deploy-confirmed, after-deploy-processed, spam-after-market-ready, blind-spam-after-submit or fast-spam.`,
  );
}

export function pumpLaunchEnvironment(): PumpLaunchEnvironment {
  const rpcUrl = envString("HELIUS_RPC_URL") || requireEnv("RPC_ENDPOINT");

  const deploymentSender = senderEnv("SOWL_DEPLOYMENT_SENDER", "helius-rpc");
  const evolutionSender = senderEnv("SOWL_EVOLUTION_SENDER", "helius-rpc");
  const fastTraderSender = senderEnv("SOWL_FAST_TRADER_SENDER", "helius-rpc");
  const rpcTraderSender = senderEnv("SOWL_RPC_TRADER_SENDER", "helius-rpc");
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

  return {
    rpcUrl,
    senderUrl,
    cuLimit: intEnv("SOWL_LAUNCH_CU_LIMIT", 600_000),
    priorityMicroLamports: intEnv("HELIUS_PRIORITY_MICRO_LAMPORTS", 500_000),
    submitMode: normalizeTraderSubmitMode(envString("SOWL_LAUNCH_SUBMIT_MODE")),
    spam: {
      intervalMs: intEnv("SOWL_LAUNCH_RETRY_INTERVAL_MS", 75),
      timeoutMs: intEnv("SOWL_LAUNCH_RETRY_TIMEOUT_MS", 120_000),
      maxFailedAttempts: intEnv("SOWL_LAUNCH_MAX_FAILED_ATTEMPTS", 0),
      recompileIntervalMs: intEnv("SOWL_LAUNCH_RECOMPILE_INTERVAL_MS", 750),
      readinessTimeoutMs: intEnv("SOWL_LAUNCH_READINESS_TIMEOUT_MS", 0),
      senderTps: intEnv("SOWL_LAUNCH_SENDER_TPS", 40),
      rateLimitBackoffMs: intEnv("SOWL_LAUNCH_RATE_LIMIT_BACKOFF_MS", 350),
      jitterMs: intEnv("SOWL_LAUNCH_RETRY_JITTER_MS", 80),
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
    },
  };
}

export function installPumpLaunchSenders(
  sowl: Sowl,
  env: PumpLaunchEnvironment,
): void {
  if (env.senderUrl) {
    sowl.registerSender(new HeliusSender(env.senderUrl, "helius-fast"));
  }

  sowl.registerSender(
    new HttpRpcSender("helius-rpc", env.rpcUrl, "HELIUS_RPC_URL/RPC_ENDPOINT"),
  );
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
  builder: ReturnType<Sowl["transaction"]>,
  payer: PublicKey,
  tip: TipConfig,
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
      kind: "sender-tip",
      recipient,
      meta: { lamports: tip.lamports.toString(), sender: "helius-fast" },
    },
  );
}

export async function loadGroupBuyerAllocations(args: {
  sowl: Sowl;
  group: string;
  minBps: number;
  maxBps: number;
  reserveLamports: bigint;
  excludeWallet?: WalletRef;
}): Promise<BuyerAllocation[]> {
  validateBps(args.minBps, args.maxBps);
  const excluded = args.excludeWallet
    ? args.sowl.resolveWallet(args.excludeWallet).address.toBase58()
    : null;
  const refs = args.sowl
    .groupWallets(args.group)
    .filter(
      (ref) => args.sowl.resolveWallet(ref).address.toBase58() !== excluded,
    );
  if (refs.length === 0)
    throw new Error(
      `Group ${args.group} has no trader wallets after excluding the deployer`,
    );

  const allocations: BuyerAllocation[] = [];
  for (const ref of refs) {
    const wallet = args.sowl.resolveWallet(ref);
    const balanceLamports = BigInt(
      await args.sowl.connection().getBalance(wallet.address, "confirmed"),
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
  sowl: Sowl;
  wallet: WalletRef;
  spendLamports: bigint;
  reserveLamports: bigint;
}): Promise<BuyerAllocation | null> {
  if (args.spendLamports <= 0n) return null;
  const wallet = args.sowl.resolveWallet(args.wallet);
  const balanceLamports = BigInt(
    await args.sowl.connection().getBalance(wallet.address, "confirmed"),
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
  sowl: Sowl;
  deployment: PreparedTokenDeployment;
  creatorWallet: WalletRef;
  kind: string;
  alias: string;
  symbol: string;
  cuLimit: number;
  priorityMicroLamports: number;
  senderTip: TipConfig;
  initialBuy?: PreparedPendingBuy | null;
  initialBuyer?: BuyerAllocation | null;
}) {
  const builder = args.sowl.transaction(args.creatorWallet);

  // The create transaction should be cheap by default. It only gets compute
  // budget instructions when the caller explicitly asks for a CU limit or
  // priority price. Buyer transactions have their own high-priority path.
  if (args.cuLimit > 0 || args.priorityMicroLamports > 0) {
    builder.priorityFee({
      cuLimit: args.cuLimit,
      microLamports: args.priorityMicroLamports,
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
    args.sowl.signer(args.creatorWallet).publicKey,
    args.senderTip,
  );
  return builder;
}

async function compileLaunch(
  args: Parameters<typeof launchBuilder>[0],
): Promise<{ draft: TransactionDraft; plan: PlannedTransaction }> {
  const draft = launchBuilder(args).snapshot();
  const hasHeliusTip = Boolean(
    args.senderTip.account &&
    args.senderTip.lamports != null &&
    args.senderTip.lamports > 0n,
  );
  try {
    return {
      draft,
      plan: await args.sowl.compile(
        args.sowl.signer(args.creatorWallet),
        draft,
        hasHeliusTip ? { useAlts: false } : undefined,
      ),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      /too large|overrun|packet/i.test(error.message)
    ) {
      const altAdvice = hasHeliusTip
        ? "Create + Helius Sender tip does not fit while keeping the tip account static. Use a non-Helius deployment sender for this launch transaction."
        : "Create + creator initial buy does not fit without a registered launch ALT. Run: sowl run prepare-pump-launch-alt --creator <wallet> --name <name> --symbol <symbol> --alias <alias> --creator-buy-sol <amount> --create --live.";
      throw new Error(`${altAdvice} Original error: ${error.message}`);
    }
    throw error;
  }
}

async function buildPendingBuyPlan(args: {
  sowl: Sowl;
  deployment: PreparedTokenDeployment;
  buyer: BuyerAllocation;
  buy: PreparedPendingBuy;
  cuLimit: number;
  priorityMicroLamports: number;
  senderTip: TipConfig;
  kind: string;
  lane: BuyerLane;
}): Promise<PlannedTransaction> {
  const builder = args.sowl
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
    args.sowl.signer(args.buyer.walletRef).publicKey,
    args.senderTip,
  );
  return await args.sowl.compile(
    args.sowl.signer(args.buyer.walletRef),
    builder.snapshot(),
    { useAlts: false },
  );
}

async function prepareWorstCaseBuys(args: {
  sowl: Sowl;
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
      const prior = await args.sowl.preparePendingBuy(
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
      await args.sowl.preparePendingBuy(
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
  sowl: Sowl;
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
}): Promise<PumpTokenLaunchPlan> {
  const deployment = await args.sowl.prepareTokenDeployment(
    "pump",
    args.creatorWallet,
    {
      name: args.token.name,
      symbol: args.token.symbol,
      uri: args.token.uri,
      creator: args.sowl.signer(args.creatorWallet).publicKey,
      mayhemMode: false,
      cashback: false,
    },
  );

  const creator = await loadCreatorAllocation({
    sowl: args.sowl,
    wallet: args.creatorWallet,
    spendLamports: args.creatorBuyLamports,
    reserveLamports: args.creatorReserveLamports,
  });

  let state = await args.sowl.initialPendingMarketState("pump", deployment);
  let initialBuy: PreparedPendingBuy | null = null;
  if (creator) {
    initialBuy = await args.sowl.preparePendingBuy(
      "pump",
      deployment,
      args.creatorWallet,
      rawAmount(creator.spendLamports, SOL_ASSET),
      state,
      { slippageBps: args.slippageBps },
    );
    state = initialBuy.nextState;
  }

  const launchSenderTip: TipConfig =
    String(args.senderPolicy.deploymentSender) === "helius-fast"
      ? args.senderPolicy.fastTip
      : {};

  const launch = await compileLaunch({
    ...args,
    deployment,
    kind: "launch-pump-token",
    alias: args.token.alias,
    symbol: args.token.symbol,
    senderTip: launchSenderTip,
    initialBuy,
    initialBuyer: creator,
  });

  const tipForSender = (sender: SenderId): TipConfig =>
    String(sender) === "helius-fast" ? args.senderPolicy.fastTip : {};
  const traderLanes = args.traders.map((_trader, index) => {
    const sender =
      index < args.senderPolicy.fastTraderCount
        ? args.senderPolicy.fastTraderSender
        : args.senderPolicy.rpcTraderSender;
    return index < args.senderPolicy.fastTraderCount
      ? { sender, tip: tipForSender(sender), lane: "trader-fast" as const }
      : { sender, tip: tipForSender(sender), lane: "trader-rpc" as const };
  });

  const pendingBuys = await prepareWorstCaseBuys({
    sowl: args.sowl,
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
        buy: pendingBuys[index]!,
        kind: "buy-pump-token-group",
        senderTip: lane.tip,
        lane,
        priorityMicroLamports: args.buyerPriorityMicroLamports,
      }),
    );
  }

  return {
    token: args.token,
    deployment,
    creator,
    traders: args.traders,
    launchDraft: launch.draft,
    launchPlan: launch.plan,
    slippageBps: args.slippageBps,
    cuLimit: args.cuLimit,
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
  sowl: Sowl;
  prepared: PumpTokenLaunchPlan;
}) {
  return await args.sowl.simulatePlan(args.prepared.launchPlan);
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

function isTransientSenderError(error: unknown): boolean {
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
  sowl: Sowl;
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
    connection: args.sowl.connection(),
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
        connection: args.sowl.connection(),
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
  sowl: Sowl,
  signature: string,
): Promise<"pending" | "success" | "failed"> {
  const state = await signatureReadiness(sowl.connection(), signature);
  if (state === "failed") return "failed";
  if (state === "processed" || state === "confirmed") return "success";
  return "pending";
}

async function spamDependentBuy(args: {
  sowl: Sowl;
  template: PlannedTransaction;
  participant: BuyerAllocation;
  lane: BuyerLane;
  kind: string;
  options: SpamSubmitOptions & { launchSignature?: string };
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

  while (beforeDeadline(startedAt, args.options.timeoutMs)) {
    if (!launchReady && args.options.launchSignature) {
      const launchState = await signatureReadiness(
        args.sowl.connection(),
        args.options.launchSignature,
      );
      if (launchState === "failed") {
        throw new Error(
          `Launch failed before trader buy could land: ${args.options.launchSignature}`,
        );
      }
      launchReady = launchState === "processed" || launchState === "confirmed";
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
      try {
        freshPlan =
          launchReady && args.buildReadyPlan
            ? await args.buildReadyPlan()
            : await args.sowl.compile(
                args.sowl.signer(args.participant.walletRef),
                args.template.draft,
                { useAlts: false },
              );
      } catch (error) {
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
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(args.options.intervalMs);
        continue;
      }

      try {
        await args.sendLimiter?.wait(args.lane.sender);
        active = await args.sowl.broadcastPlan(
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
        failedAttempts,
        preReadyFailures,
        signature: active.signature,
      });
    } else {
      const state = await signatureState(args.sowl, active.signature);
      if (state === "success") {
        const receipt = await args.sowl.confirmSubmitted(active, 15_000);
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
        const signature = await args.sowl.senders
          .resolve(args.lane.sender)
          .send({
            connection: args.sowl.connection(),
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
    const receipt = await args.sowl.confirmSubmitted(active, 5_000);
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
  sowl: Sowl;
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
      const submitted = await args.sowl.broadcastPlan(
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

export async function executePumpTokenLaunch(args: {
  sowl: Sowl;
  prepared: PumpTokenLaunchPlan;
  live: boolean;
  traderSubmitMode: TraderSubmitMode;
  skipSimulation: boolean;
  spam: SpamSubmitOptions;
  kind: string;
  reporter?: LaunchReporter;
}): Promise<PumpTokenLaunchResult> {
  const submitMode = normalizeTraderSubmitMode(args.traderSubmitMode);

  if (!args.live) {
    return {
      mode: "dry-run",
      launchSimulation: await simulatePumpTokenLaunch({
        sowl: args.sowl,
        prepared: args.prepared,
      }),
      deploymentSender: String(args.prepared.deploymentSender),
      buyers: args.prepared.expectedOutputByWallet,
      note: "Create and creator initial buy are simulated in one transaction; trader buys are compiled against the pending Pump market and sent after deployment readiness in live mode.",
    };
  }

  const sendLimiter = new SenderRateLimiter(args.spam, args.reporter);
  const launch = await broadcastLaunchWithRetry({
    sowl: args.sowl,
    plan: args.prepared.launchPlan,
    sender: args.prepared.deploymentSender,
    kind: `${args.kind}:create-and-creator-buy`,
    skipSimulation: args.skipSimulation,
    spam: args.spam,
    sendLimiter,
    reporter: args.reporter,
  });

  if (submitMode === "after-deploy-confirmed") {
    const launchReceipt = await args.sowl.confirmSubmitted(launch);
    if (launchReceipt.status !== "confirmed") {
      throw new Error(
        `Token create + creator initial buy did not confirm: ${launchReceipt.status}`,
      );
    }

    const traderReceipts = await Promise.all(
      args.prepared.traderPlans.map((plan, index) =>
        args.sowl.sendPlan(
          plan,
          args.prepared.traderLanes[index]!.sender,
          `${args.kind}:trader:${index + 1}`,
          { skipSimulation: false, skipPreflight: true },
        ),
      ),
    );

    return { mode: submitMode, launchReceipt, traderReceipts };
  }

  await waitForLaunchReady({
    sowl: args.sowl,
    prepared: args.prepared,
    launchSignature: launch.signature,
    mode: submitMode,
    spam: args.spam,
    reporter: args.reporter,
  });

  const mintRef = args.prepared.deployment.mint.publicKey.toBase58();
  let tokenPersisted = false;
  const ensureTokenPersisted = () => {
    if (!tokenPersisted) {
      args.sowl.persistPreparedDeployment(
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
        sowl: args.sowl,
        template: plan,
        participant,
        lane: args.prepared.traderLanes[index]!,
        kind: `${args.kind}:trader:${index + 1}`,
        options: { ...args.spam, launchSignature: launch.signature },
        buildReadyPlan: async () => {
          ensureTokenPersisted();
          const builder = args.sowl
            .tx(participant.walletRef)
            .priorityFee({
              cuLimit: args.prepared.cuLimit,
              microLamports: args.prepared.buyerPriorityMicroLamports,
            })
            .buy(mintRef, rawAmount(participant.spendLamports, SOL_ASSET), {
              slippageBps: args.prepared.slippageBps,
            });
          addTip(
            builder as unknown as ReturnType<Sowl["transaction"]>,
            args.sowl.signer(participant.walletRef).publicKey,
            args.prepared.traderLanes[index]!.tip,
          );
          return await builder.build();
        },
        sendLimiter,
        reporter: args.reporter,
      });
    }),
  );

  const launchReceipt = await args.sowl.confirmSubmitted(launch);
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
}

function sleep(ms: number): Promise<void> {
  return ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();
}
