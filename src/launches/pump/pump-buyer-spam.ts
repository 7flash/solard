import { PublicKey, SystemProgram } from "@solana/web3.js";

import { rawAmount, SOL_ASSET, sol } from "../../core/amounts.js";
import type { WalletRef } from "../../core/refs.js";
import type { TokenRow } from "../../db/schema.js";
import { createTraderSowl } from "../../presets/trader.js";
import type { Sowl } from "../../sdk/sowl.js";
import { TOKEN_2022_ID } from "../../venues/pump/constants.js";
import { bondingCurvePda } from "../../venues/pump/pda.js";
import type {
  PlannedTransaction,
  SenderId,
  SubmittedPlan,
} from "../../tx/types.js";
import {
  installPumpLaunchSenders,
  signatureReadiness,
  validateHeliusTip,
  type PumpLaunchEnvironment,
  type TipConfig,
} from "./token-launch.js";
import {
  bigintFlag,
  first,
  numberFlag,
  parseArgs,
  pumpLaunchEnvironmentFromFlags,
  required,
  type Flags,
} from "./token-launch-cli.js";

export type PumpBuyerAmount =
  | { kind: "exact-lamports"; lamports: bigint }
  | {
      kind: "balance-bps";
      minBps: number;
      maxBps: number;
      reserveLamports: bigint;
    };

export type PreparedPumpSpamBuyer = {
  walletRef: WalletRef;
  address: string;
  balanceLamports: bigint;
  selectedBps: number | null;
  spendLamports: bigint;
  reserveLamports: bigint;
};

export type PumpBuyerSpamOptions = {
  mint: string;
  token: TokenRow;
  sender: SenderId;
  tip: TipConfig;
  cuLimit: number;
  priorityMicroLamports: number;
  slippageBps: number;
  retryIntervalMs: number;
  statusCheckIntervalMs: number;
  expiryCheckIntervalMs: number;
  timeoutMs: number;
  maxFailedAttempts: number;
  jitterMs: number;
  signal?: AbortSignal;
  report?: (label: string, value: unknown) => void;
};

export type PumpBuyerSpamResult = {
  address: string;
  mint: string;
  sender: string;
  signature: string;
  selectedBps: number | null;
  spendLamports: string;
  buildErrors: number;
  broadcastErrors: number;
  failedTransactions: number;
  recompiles: number;
  resends: number;
  elapsedMs: number;
};

function sleep(ms: number): Promise<void> {
  return ms > 0
    ? new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
    : Promise.resolve();
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
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
      `Expected --min-bps and --max-bps within 1..10000; got ${minBps}..${maxBps}.`,
    );
  }
}

function randomBps(minBps: number, maxBps: number): number {
  validateBps(minBps, maxBps);
  return minBps === maxBps
    ? minBps
    : minBps + Math.floor(Math.random() * (maxBps - minBps + 1));
}

function jitter(maxMs: number): number {
  return maxMs > 0 ? Math.floor(Math.random() * (maxMs + 1)) : 0;
}

function parseSender(flags: Flags): SenderId {
  const value = first(flags, "sender") ?? "helius-rpc";
  if (value !== "helius-fast" && value !== "helius-rpc") {
    throw new Error(
      `Invalid --sender: ${value}. Expected helius-fast or helius-rpc.`,
    );
  }
  return value as SenderId;
}

function optionalSolLamports(
  flags: Flags,
  solKey: string,
  lamportsKey: string,
  fallback: bigint,
): bigint {
  if (first(flags, lamportsKey) != null) {
    return bigintFlag(flags, lamportsKey, fallback);
  }
  const human = first(flags, solKey);
  return human == null ? fallback : sol(human).raw;
}

function amountFromFlags(flags: Flags): PumpBuyerAmount {
  const mode = (first(flags, "amount-mode") ?? "range-bps")
    .trim()
    .toLowerCase();

  if (mode === "exact-sol" || mode === "exact") {
    const lamports = sol(required(flags, "amount-sol")).raw;
    if (lamports <= 0n) throw new Error("--amount-sol must be positive.");
    return { kind: "exact-lamports", lamports };
  }

  if (mode === "exact-lamports" || mode === "lamports") {
    const lamports = bigintFlag(flags, "amount-lamports", 0n);
    if (lamports <= 0n) throw new Error("--amount-lamports must be positive.");
    return { kind: "exact-lamports", lamports };
  }

  if (mode !== "range-bps" && mode !== "balance-bps") {
    throw new Error(
      `Invalid --amount-mode: ${mode}. Expected range-bps, exact-sol, or exact-lamports.`,
    );
  }

  const minBps = numberFlag(flags, "min-bps", Number.NaN);
  const maxBps = numberFlag(flags, "max-bps", Number.NaN);
  validateBps(minBps, maxBps);

  const reserveLamports = optionalSolLamports(
    flags,
    "reserve-sol",
    "reserve-lamports",
    20_000_000n,
  );
  if (reserveLamports < 0n)
    throw new Error("Buyer reserve cannot be negative.");

  return {
    kind: "balance-bps",
    minBps,
    maxBps,
    reserveLamports,
  };
}

function walletRefsFromFlags(sowl: Sowl, flags: Flags): WalletRef[] {
  const wallets = (flags.get("wallet") ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  const group = first(flags, "group")?.trim();

  if (wallets.length > 0 && group) {
    throw new Error("Use either --wallet or --group, not both.");
  }
  if (wallets.length === 0 && !group) {
    throw new Error("Provide --wallet <wallet-ref> or --group <wallet-group>.");
  }

  const refs = group ? sowl.groupWallets(group) : (wallets as WalletRef[]);
  if (refs.length === 0) {
    throw new Error(group ? `Wallet group ${group} is empty.` : "No wallets.");
  }

  const seen = new Set<string>();
  return refs.filter((ref) => {
    const address = sowl.resolveWallet(ref).address.toBase58();
    if (seen.has(address)) return false;
    seen.add(address);
    return true;
  });
}

async function prepareBuyer(
  sowl: Sowl,
  walletRef: WalletRef,
  amount: PumpBuyerAmount,
): Promise<PreparedPumpSpamBuyer> {
  const wallet = sowl.resolveWallet(walletRef);
  const balanceLamports = BigInt(
    await sowl.connection().getBalance(wallet.address, "confirmed"),
  );

  let selectedBps: number | null = null;
  let reserveLamports = 0n;
  let spendLamports: bigint;

  if (amount.kind === "exact-lamports") {
    spendLamports = amount.lamports;
  } else {
    reserveLamports = amount.reserveLamports;
    if (balanceLamports <= reserveLamports) {
      throw new Error(
        `Wallet ${wallet.address.toBase58()} balance ${balanceLamports} does not exceed reserve ${reserveLamports}.`,
      );
    }
    selectedBps = randomBps(amount.minBps, amount.maxBps);
    spendLamports =
      ((balanceLamports - reserveLamports) * BigInt(selectedBps)) / 10_000n;
  }

  if (spendLamports <= 0n) {
    throw new Error(
      `Wallet ${wallet.address.toBase58()} produced a zero buy amount.`,
    );
  }
  if (balanceLamports < spendLamports + reserveLamports) {
    throw new Error(
      `Wallet ${wallet.address.toBase58()} has insufficient SOL: balance=${balanceLamports} spend=${spendLamports} reserve=${reserveLamports}.`,
    );
  }

  return {
    walletRef,
    address: wallet.address.toBase58(),
    balanceLamports,
    selectedBps,
    spendLamports,
    reserveLamports,
  };
}

function pendingPumpToken(mint: PublicKey): TokenRow {
  const now = Date.now();

  return {
    id: 0,
    mint: mint.toBase58(),
    name: null,
    symbol: null,
    decimals: 6,
    createKind: "create_v2",
    creator: null,
    quoteMint: SOL_ASSET.mint.toBase58(),
    quoteTokenProgram: SOL_ASSET.tokenProgram.toBase58(),
    baseTokenProgram: TOKEN_2022_ID.toBase58(),
    bondingCurve: bondingCurvePda(mint).toBase58(),
    pool: null,
    sharingConfig: null,
    venueHint: "pump-curve",
    metadataJson: JSON.stringify({ pendingDeployment: true }),
    refreshedAtMs: null,
    createdAtMs: now,
    updatedAtMs: now,
  };
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

async function buildBuyerPlan(args: {
  sowl: Sowl;
  buyer: PreparedPumpSpamBuyer;
  options: PumpBuyerSpamOptions;
}): Promise<PlannedTransaction> {
  const builder = args.sowl
    .tx(args.buyer.walletRef)
    .priorityFee({
      cuLimit: args.options.cuLimit,
      microLamports: args.options.priorityMicroLamports,
    })
    .buy(args.options.token, rawAmount(args.buyer.spendLamports, SOL_ASSET), {
      slippageBps: args.options.slippageBps,
    });

  if (String(args.options.sender) === "helius-fast") {
    addTip(
      builder as unknown as ReturnType<Sowl["transaction"]>,
      args.sowl.signer(args.buyer.walletRef).publicKey,
      args.options.tip,
    );
  }

  const draft = await builder.materializedDraft();
  return await args.sowl.compile(
    args.sowl.signer(args.buyer.walletRef),
    draft,
    { useAlts: false },
  );
}

function beforeDeadline(startedAt: number, timeoutMs: number): boolean {
  return timeoutMs <= 0 || Date.now() - startedAt < timeoutMs;
}

async function resendSubmitted(args: {
  sowl: Sowl;
  sender: SenderId;
  active: SubmittedPlan;
}): Promise<void> {
  const signature = await args.sowl.senders.resolve(args.sender).send({
    connection: args.sowl.connection(),
    transaction: args.active.plan.transaction,
    options: { skipPreflight: true, skipSimulation: true },
  });
  if (signature !== args.active.signature) {
    throw new Error(
      `${String(args.sender)} resend changed signature from ${args.active.signature} to ${signature}.`,
    );
  }
}

export async function spamPumpBuyer(args: {
  sowl: Sowl;
  buyer: PreparedPumpSpamBuyer;
  options: PumpBuyerSpamOptions;
  index: number;
}): Promise<PumpBuyerSpamResult> {
  const startedAt = Date.now();
  let active: SubmittedPlan | null = null;
  let processed = false;
  let nextStatusCheckAt = 0;
  let nextExpiryCheckAt = 0;
  let buildErrors = 0;
  let broadcastErrors = 0;
  let failedTransactions = 0;
  let recompiles = 0;
  let resends = 0;
  const report = args.options.report;

  report?.("pump standalone buyer start", {
    index: args.index,
    wallet: args.buyer.address,
    mint: args.options.mint,
    sender: String(args.options.sender),
    selectedBps: args.buyer.selectedBps,
    spendLamports: args.buyer.spendLamports,
  });

  while (
    !args.options.signal?.aborted &&
    beforeDeadline(startedAt, args.options.timeoutMs)
  ) {
    if (
      args.options.maxFailedAttempts > 0 &&
      failedTransactions >= args.options.maxFailedAttempts
    ) {
      throw new Error(
        `Buyer ${args.buyer.address} exhausted ${failedTransactions} failed transactions.`,
      );
    }

    if (!active) {
      let plan: PlannedTransaction;
      try {
        // Missing mint/bonding-curve state before deployment is a normal retry.
        plan = await buildBuyerPlan({
          sowl: args.sowl,
          buyer: args.buyer,
          options: args.options,
        });
      } catch (error) {
        buildErrors++;
        report?.("pump standalone buyer build retry", {
          index: args.index,
          wallet: args.buyer.address,
          mint: args.options.mint,
          buildErrors,
          error: errorText(error),
        });
        await sleep(
          args.options.retryIntervalMs + jitter(args.options.jitterMs),
        );
        continue;
      }

      try {
        active = await args.sowl.broadcastPlan(
          plan,
          args.options.sender,
          `cli:pump:standalone-buyer:${args.index}:attempt:${failedTransactions + broadcastErrors + 1}`,
          { skipSimulation: true, skipPreflight: true },
        );
      } catch (error) {
        broadcastErrors++;
        report?.("pump standalone buyer broadcast retry", {
          index: args.index,
          wallet: args.buyer.address,
          mint: args.options.mint,
          broadcastErrors,
          error: errorText(error),
        });
        await sleep(
          args.options.retryIntervalMs + jitter(args.options.jitterMs),
        );
        continue;
      }

      nextStatusCheckAt = 0;
      nextExpiryCheckAt = 0;
      processed = false;
      report?.("pump standalone buyer attempt", {
        index: args.index,
        wallet: args.buyer.address,
        mint: args.options.mint,
        signature: active.signature,
        recentBlockhash: active.plan.recentBlockhash,
        lastValidBlockHeight: active.plan.lastValidBlockHeight,
      });
    } else {
      const now = Date.now();
      let readiness: "pending" | "processed" | "confirmed" | "failed" =
        "pending";

      if (now >= nextStatusCheckAt) {
        nextStatusCheckAt = now + args.options.statusCheckIntervalMs;
        try {
          readiness = await signatureReadiness(
            args.sowl.connection(),
            active.signature,
          );
        } catch (error) {
          report?.("pump standalone buyer status retry", {
            index: args.index,
            wallet: args.buyer.address,
            signature: active.signature,
            error: errorText(error),
          });
        }
      }

      if (readiness === "confirmed") {
        const result: PumpBuyerSpamResult = {
          address: args.buyer.address,
          mint: args.options.mint,
          sender: String(args.options.sender),
          signature: active.signature,
          selectedBps: args.buyer.selectedBps,
          spendLamports: args.buyer.spendLamports.toString(),
          buildErrors,
          broadcastErrors,
          failedTransactions,
          recompiles,
          resends,
          elapsedMs: Date.now() - startedAt,
        };
        report?.("pump standalone buyer confirmed", result);
        return result;
      }

      if (readiness === "processed") {
        // Never compile a second buy after the first signature is processed.
        processed = true;
      }

      if (readiness === "failed") {
        failedTransactions++;
        report?.("pump standalone buyer transaction failed", {
          index: args.index,
          wallet: args.buyer.address,
          signature: active.signature,
          failedTransactions,
        });
        active = null;
        continue;
      }

      if (!processed && Date.now() >= nextExpiryCheckAt) {
        nextExpiryCheckAt = Date.now() + args.options.expiryCheckIntervalMs;

        try {
          const currentBlockHeight = await args.sowl
            .connection()
            .getBlockHeight("confirmed");

          if (currentBlockHeight > active.plan.lastValidBlockHeight) {
            recompiles++;
            report?.("pump standalone buyer blockhash expired", {
              index: args.index,
              wallet: args.buyer.address,
              oldSignature: active.signature,
              recentBlockhash: active.plan.recentBlockhash,
              lastValidBlockHeight: active.plan.lastValidBlockHeight,
              currentBlockHeight,
              recompiles,
            });
            active = null;
            continue;
          }
        } catch (error) {
          report?.("pump standalone buyer expiry check retry", {
            index: args.index,
            wallet: args.buyer.address,
            signature: active.signature,
            error: errorText(error),
          });
        }
      }

      try {
        await resendSubmitted({
          sowl: args.sowl,
          sender: args.options.sender,
          active,
        });
        resends++;
      } catch (error) {
        broadcastErrors++;
        report?.("pump standalone buyer resend retry", {
          index: args.index,
          wallet: args.buyer.address,
          signature: active.signature,
          processed,
          broadcastErrors,
          error: errorText(error),
        });
      }
    }

    await sleep(args.options.retryIntervalMs + jitter(args.options.jitterMs));
  }

  if (args.options.signal?.aborted) {
    throw new Error(`Buyer ${args.buyer.address} stopped.`);
  }
  throw new Error(
    `Buyer ${args.buyer.address} did not confirm within ${args.options.timeoutMs}ms.`,
  );
}

function tipFromFlags(
  flags: Flags,
  env: PumpLaunchEnvironment,
  sender: SenderId,
): TipConfig {
  if (String(sender) !== "helius-fast") return {};
  return {
    account:
      first(flags, "tip-account") ??
      first(flags, "helius-tip-account") ??
      env.policy.fastTip.account,
    lamports: optionalSolLamports(
      flags,
      "tip-sol",
      "tip-lamports",
      env.policy.fastTip.lamports ?? 1_000_000n,
    ),
  };
}

function defaultReport(label: string, value: unknown): void {
  console.log(`${label}: ${json(value)}`);
}

export async function runPumpBuyerSpamFromArgs(
  argv: string[],
  input: {
    signal?: AbortSignal;
    report?: PumpBuyerSpamOptions["report"];
  } = {},
): Promise<PumpBuyerSpamResult[]> {
  const { flags } = parseArgs(argv);
  const mint = required(flags, "mint").trim();
  let mintPublicKey: PublicKey;
  try {
    mintPublicKey = new PublicKey(mint);
  } catch {
    throw new Error(`Invalid --mint public key: ${mint}`);
  }

  /**
   * Pass a local Pump create_v2 TokenRow into TransactionComposer.buy().
   * A raw mint string is resolved through the persistent token registry and
   * would remain UnknownToken forever when the buyer starts before deployment.
   * This local descriptor lets venue routing poll the derived bonding curve
   * directly without registering or persisting a token that does not exist yet.
   */
  const token = pendingPumpToken(mintPublicKey);

  const env = pumpLaunchEnvironmentFromFlags(flags);
  const sender = parseSender(flags);
  if (String(sender) === "helius-fast" && !env.senderUrl) {
    throw new Error(
      "Helius fast sender requires --helius-sender-url or HELIUS_SENDER_URL.",
    );
  }

  const tip = tipFromFlags(flags, env, sender);
  if (String(sender) === "helius-fast") {
    validateHeliusTip({
      tip,
      endpoint: env.senderUrl ?? "",
      live: true,
      label: "Standalone Pump buyer",
    });
  }

  const amount = amountFromFlags(flags);
  const sowl = createTraderSowl({ rpcUrl: env.rpcUrl });
  installPumpLaunchSenders(sowl, env);

  try {
    const refs = walletRefsFromFlags(sowl, flags);
    const buyers = await Promise.all(
      refs.map((ref) => prepareBuyer(sowl, ref, amount)),
    );
    const report = input.report ?? defaultReport;

    report("pump standalone buyers prepared", {
      mint,
      sender: String(sender),
      buyers: buyers.map((buyer) => ({
        address: buyer.address,
        balanceLamports: buyer.balanceLamports,
        selectedBps: buyer.selectedBps,
        spendLamports: buyer.spendLamports,
        reserveLamports: buyer.reserveLamports,
      })),
    });

    const settled = await Promise.allSettled(
      buyers.map((buyer, index) =>
        spamPumpBuyer({
          sowl,
          buyer,
          index,
          options: {
            mint,
            token,
            sender,
            tip,
            cuLimit: numberFlag(flags, "cu-limit", env.cuLimit),
            priorityMicroLamports: numberFlag(
              flags,
              "priority-micro-lamports",
              1_500_000,
            ),
            slippageBps: numberFlag(flags, "slippage-bps", 2_500),
            retryIntervalMs: numberFlag(flags, "retry-interval-ms", 100),
            statusCheckIntervalMs: Math.max(
              100,
              numberFlag(flags, "status-check-interval-ms", 1_000),
            ),
            expiryCheckIntervalMs: Math.max(
              250,
              numberFlag(flags, "expiry-check-interval-ms", 1_000),
            ),
            timeoutMs: numberFlag(flags, "timeout-ms", 0),
            maxFailedAttempts: numberFlag(flags, "max-failed-attempts", 0),
            jitterMs: numberFlag(flags, "jitter-ms", 0),
            signal: input.signal,
            report,
          },
        }),
      ),
    );

    const failures = settled
      .map((item, index) => ({ item, buyer: buyers[index]! }))
      .filter((entry) => entry.item.status === "rejected");

    if (failures.length > 0) {
      throw new Error(
        failures
          .map((entry) =>
            entry.item.status === "rejected"
              ? `${entry.buyer.address}: ${errorText(entry.item.reason)}`
              : entry.buyer.address,
          )
          .join("\n"),
      );
    }

    return settled.map(
      (item) => (item as PromiseFulfilledResult<PumpBuyerSpamResult>).value,
    );
  } finally {
    sowl.close();
  }
}
