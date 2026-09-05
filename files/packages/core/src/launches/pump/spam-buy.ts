import { PublicKey, SystemProgram } from "@solana/web3.js";

import { rawAmount, SOL_ASSET } from "../../core/amounts.ts";
import type { WalletRef } from "../../core/refs.ts";
import type { TokenRow } from "../../db/schema.ts";
import type { Solard } from "../../core/solard.ts";
import type {
  PlannedTransaction,
  SenderId,
  SubmittedPlan,
} from "../../tx/types.ts";
import type {
  BuyerAllocation,
  BuyerExecutionOverride,
  ExplicitBuyerAmount,
  LaunchReporter,
  TipConfig,
} from "./token-launch.ts";

export type PumpSpamBuySettings = {
  sender: SenderId;
  tip: TipConfig;
  cuLimit: number;
  priorityMicroLamports: number;
  slippageBps: number;
  discoveryIntervalMs: number;
  retryIntervalMs: number;
  recompileIntervalMs: number;
  freshQuoteIntervalMs: number;
  timeoutMs: number;
  maxFailedAttempts: number;
};

export type PumpSpamBuyerInput = {
  wallet: WalletRef;
  amount: ExplicitBuyerAmount;
  execution?: BuyerExecutionOverride;
};

export type PumpSpamBuyerResult = {
  address: string;
  spendLamports: bigint;
  selectedBps: number | null;
  sender: string;
  status: "confirmed" | "stopped" | "failed";
  signature: string | null;
  signatures: string[];
  broadcasts: number;
  recompiles: number;
  freshQuotes: number;
  failedAttempts: number;
  lastError: string | null;
};

export type PumpSpamBuyRunResult = {
  mint: string;
  live: boolean;
  buyers: PumpSpamBuyerResult[];
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function positiveInteger(
  value: number,
  label: string,
  allowZero = false,
): void {
  if (!Number.isInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(
      `${label} must be ${allowZero ? "a non-negative" : "a positive"} integer`,
    );
  }
}

function validateSettings(settings: PumpSpamBuySettings): void {
  positiveInteger(settings.cuLimit, "cuLimit", true);
  positiveInteger(
    settings.priorityMicroLamports,
    "priorityMicroLamports",
    true,
  );
  positiveInteger(settings.slippageBps, "slippageBps", true);
  if (settings.slippageBps > 10_000)
    throw new Error("slippageBps cannot exceed 10000");
  positiveInteger(settings.discoveryIntervalMs, "discoveryIntervalMs");
  positiveInteger(settings.retryIntervalMs, "retryIntervalMs");
  positiveInteger(settings.recompileIntervalMs, "recompileIntervalMs", true);
  if (
    !Number.isInteger(settings.freshQuoteIntervalMs) ||
    settings.freshQuoteIntervalMs < -1
  ) {
    throw new Error(
      "freshQuoteIntervalMs must be -1 or a non-negative integer",
    );
  }
  positiveInteger(settings.timeoutMs, "timeoutMs", true);
  positiveInteger(settings.maxFailedAttempts, "maxFailedAttempts", true);
}

function addTip(
  builder: ReturnType<Solard["transaction"]>,
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
      meta: { lamports: tip.lamports.toString() },
    },
  );
}

function placeholderToken(slrd: Solard, mint: PublicKey): TokenRow {
  return slrd.tokens.upsert({
    mint: mint.toBase58(),
    decimals: 6,
    createKind: "create_v2",
    venueHint: "unknown",
    metadataJson: JSON.stringify({ awaitingPumpDeployment: true }),
  });
}

async function waitForPumpMarket(args: {
  slrd: Solard;
  mint: PublicKey;
  intervalMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
  reporter?: LaunchReporter;
}): Promise<TokenRow | null> {
  let token = placeholderToken(args.slrd, args.mint);
  const startedAt = Date.now();
  let lastReportAt = 0;

  while (!args.signal?.aborted) {
    if (args.timeoutMs > 0 && Date.now() - startedAt >= args.timeoutMs) {
      throw new Error(
        `Pump market did not become readable within ${args.timeoutMs}ms for ${args.mint.toBase58()}`,
      );
    }

    try {
      args.slrd.cache.invalidate();
      token = await args.slrd.refreshToken(token);
      if (token.venueHint === "pump-curve" || token.venueHint === "pumpswap") {
        args.reporter?.("pump spam-buy market ready", {
          mint: token.mint,
          venue: token.venueHint,
          creator: token.creator,
        });
        return token;
      }
    } catch (error) {
      const now = Date.now();
      if (now - lastReportAt >= 1_000) {
        lastReportAt = now;
        args.reporter?.("pump spam-buy waiting", {
          mint: args.mint.toBase58(),
          error: errorText(error),
        });
      }
    }

    await sleep(args.intervalMs, args.signal);
  }

  return null;
}

async function buildLivePlan(args: {
  slrd: Solard;
  token: TokenRow;
  buyer: BuyerAllocation;
  settings: PumpSpamBuySettings;
}): Promise<PlannedTransaction> {
  // waitForPumpMarket() already returned a fully refreshed routable token.
  // Avoid one redundant refresh RPC per buyer at the latency-critical edge.
  args.slrd.cache.invalidate();
  const token = args.token;
  const builder = args.slrd.tx(args.buyer.walletRef);

  if (args.settings.cuLimit > 0 || args.settings.priorityMicroLamports > 0) {
    builder.priorityFee({
      cuLimit: args.settings.cuLimit,
      microLamports: args.settings.priorityMicroLamports,
    });
  }

  builder.buy(token, rawAmount(args.buyer.spendLamports, SOL_ASSET), {
    slippageBps: args.settings.slippageBps,
  });

  addTip(
    builder,
    args.slrd.signer(args.buyer.walletRef).publicKey,
    args.settings.tip,
  );

  return await args.slrd.compile(
    args.slrd.signer(args.buyer.walletRef),
    await builder.materializedDraft(),
    { useAlts: false },
  );
}

function effectiveSettings(
  shared: PumpSpamBuySettings,
  buyer: BuyerAllocation,
): PumpSpamBuySettings {
  const sender = buyer.execution?.sender ?? shared.sender;
  const configuredTip =
    buyer.execution?.tipLamports == null
      ? shared.tip
      : { ...shared.tip, lamports: buyer.execution.tipLamports };
  return {
    ...shared,
    sender,
    tip: String(sender) === "helius-fast" ? configuredTip : {},
    priorityMicroLamports:
      buyer.execution?.priorityMicroLamports ?? shared.priorityMicroLamports,
    slippageBps: buyer.execution?.slippageBps ?? shared.slippageBps,
    retryIntervalMs: buyer.execution?.retryIntervalMs ?? shared.retryIntervalMs,
    recompileIntervalMs:
      buyer.execution?.recompileIntervalMs ?? shared.recompileIntervalMs,
    freshQuoteIntervalMs:
      buyer.execution?.freshQuoteDelayMs ?? shared.freshQuoteIntervalMs,
    maxFailedAttempts:
      buyer.execution?.maxFailedAttempts ?? shared.maxFailedAttempts,
  };
}

type SignatureState = "pending" | "processed" | "confirmed" | "failed";

async function signatureState(
  slrd: Solard,
  signature: string,
): Promise<SignatureState> {
  const status = (
    await slrd.connection().getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    })
  ).value[0];
  if (!status) return "pending";
  if (status.err) return "failed";
  if (
    status.confirmationStatus === "confirmed" ||
    status.confirmationStatus === "finalized"
  ) {
    return "confirmed";
  }
  return status.confirmationStatus === "processed" ? "processed" : "pending";
}

async function resendSubmitted(args: {
  slrd: Solard;
  sender: SenderId;
  active: SubmittedPlan;
}): Promise<void> {
  // Resend the exact signed bytes. This cannot create a second buy generation:
  // Solana transaction identity is the signature over this exact message.
  const signature = await args.slrd.senders.resolve(args.sender).send({
    connection: args.slrd.connection(),
    transaction: args.active.plan.transaction,
    options: { skipPreflight: true, skipSimulation: true },
  });
  if (signature !== args.active.signature) {
    throw new Error(
      `${String(args.sender)} resend changed signature from ${args.active.signature} to ${signature}.`,
    );
  }
}

async function runBuyerLoop(args: {
  slrd: Solard;
  token: TokenRow;
  buyer: BuyerAllocation;
  shared: PumpSpamBuySettings;
  signal?: AbortSignal;
  reporter?: LaunchReporter;
}): Promise<PumpSpamBuyerResult> {
  const settings = effectiveSettings(args.shared, args.buyer);
  validateSettings(settings);

  const startedAt = Date.now();
  const signatures: string[] = [];
  let active: SubmittedPlan | null = null;
  let processed = false;
  let nextStatusCheckAt = 0;
  let nextExpiryCheckAt = 0;
  let broadcasts = 0;
  let recompiles = 0;
  let freshQuotes = 0;
  let failedAttempts = 0;
  let lastError: string | null = null;

  // RPC starts are globally rate limited elsewhere. These intervals prevent the
  // buyer loop itself from manufacturing pointless status/expiry pressure while
  // retaining fast identical-byte resends.
  const statusCheckIntervalMs = Math.max(250, settings.retryIntervalMs);
  const expiryCheckIntervalMs = Math.max(500, settings.retryIntervalMs);

  const result = (
    status: PumpSpamBuyerResult["status"],
    signature: string | null,
  ): PumpSpamBuyerResult => ({
    address: args.buyer.address,
    spendLamports: args.buyer.spendLamports,
    selectedBps: args.buyer.selectedBps,
    sender: String(settings.sender),
    status,
    signature,
    signatures,
    broadcasts,
    recompiles,
    freshQuotes,
    failedAttempts,
    lastError,
  });

  args.reporter?.("pump spam-buy buyer start", {
    mint: args.token.mint,
    wallet: args.buyer.address,
    spendLamports: args.buyer.spendLamports,
    selectedBps: args.buyer.selectedBps,
    sender: String(settings.sender),
    safety: "single-live-generation",
  });

  while (!args.signal?.aborted) {
    if (
      settings.timeoutMs > 0 &&
      Date.now() - startedAt >= settings.timeoutMs
    ) {
      lastError = `Buyer timed out after ${settings.timeoutMs}ms`;
      return result("failed", null);
    }

    if (
      settings.maxFailedAttempts > 0 &&
      failedAttempts >= settings.maxFailedAttempts
    ) {
      lastError ??= `Reached maxFailedAttempts=${settings.maxFailedAttempts}`;
      return result("failed", null);
    }

    if (!active) {
      try {
        // A fresh quote/blockhash is allowed only when there is no live
        // generation. The prior generation must have failed or expired first.
        const plan = await buildLivePlan({
          slrd: args.slrd,
          token: args.token,
          buyer: args.buyer,
          settings,
        });
        freshQuotes += 1;

        active = await args.slrd.broadcastPlan(
          plan,
          settings.sender,
          `cli:spam-buy:pump:${args.buyer.address}:generation:${signatures.length + 1}`,
          { skipSimulation: true, skipPreflight: true },
        );
        broadcasts += 1;
        signatures.push(active.signature);
        processed = false;
        nextStatusCheckAt = 0;
        nextExpiryCheckAt = 0;
        lastError = null;

        args.reporter?.("pump spam-buy generation", {
          mint: args.token.mint,
          wallet: args.buyer.address,
          generation: signatures.length,
          signature: active.signature,
          recentBlockhash: active.plan.recentBlockhash,
          lastValidBlockHeight: active.plan.lastValidBlockHeight,
        });
      } catch (error) {
        lastError = errorText(error);
        failedAttempts += 1;
        args.reporter?.("pump spam-buy build/broadcast retry", {
          mint: args.token.mint,
          wallet: args.buyer.address,
          failedAttempts,
          error: lastError,
        });
        await sleep(settings.retryIntervalMs, args.signal);
        continue;
      }
    } else {
      const now = Date.now();

      if (now >= nextStatusCheckAt) {
        nextStatusCheckAt = now + statusCheckIntervalMs;
        try {
          const state = await signatureState(args.slrd, active.signature);

          if (state === "confirmed") {
            args.reporter?.("pump spam-buy confirmed", {
              mint: args.token.mint,
              wallet: args.buyer.address,
              signature: active.signature,
              broadcasts,
              generations: signatures.length,
              freshQuotes,
            });
            return result("confirmed", active.signature);
          }

          if (state === "processed") {
            // Safety invariant: after any node has observed the transaction as
            // processed, never construct a second buy generation for this wallet.
            processed = true;
          } else if (state === "failed") {
            failedAttempts += 1;
            args.reporter?.("pump spam-buy transaction failed", {
              mint: args.token.mint,
              wallet: args.buyer.address,
              signature: active.signature,
              failedAttempts,
            });
            active = null;
            processed = false;
            continue;
          }
        } catch (error) {
          lastError = errorText(error);
          args.reporter?.("pump spam-buy status retry", {
            mint: args.token.mint,
            wallet: args.buyer.address,
            signature: active.signature,
            error: lastError,
          });
        }
      }

      // A transaction that has already been observed as processed is never
      // replaced, even if its blockhash subsequently ages out. This chooses
      // no-double-buy safety over aggressive recovery from a rare fork/drop.
      if (!processed && Date.now() >= nextExpiryCheckAt) {
        nextExpiryCheckAt = Date.now() + expiryCheckIntervalMs;
        try {
          const currentBlockHeight = await args.slrd
            .connection()
            .getBlockHeight("confirmed");
          if (currentBlockHeight > active.plan.lastValidBlockHeight) {
            const expiredSignature = active.signature;
            recompiles += 1;
            args.reporter?.("pump spam-buy blockhash expired", {
              mint: args.token.mint,
              wallet: args.buyer.address,
              signature: expiredSignature,
              currentBlockHeight,
              lastValidBlockHeight: active.plan.lastValidBlockHeight,
              nextGeneration: signatures.length + 1,
            });
            active = null;
            processed = false;
            continue;
          }
        } catch (error) {
          lastError = errorText(error);
          args.reporter?.("pump spam-buy expiry retry", {
            mint: args.token.mint,
            wallet: args.buyer.address,
            signature: active.signature,
            error: lastError,
          });
        }
      }

      try {
        await resendSubmitted({
          slrd: args.slrd,
          sender: settings.sender,
          active,
        });
        broadcasts += 1;
      } catch (error) {
        // A resend transport failure does not invalidate the live transaction
        // and therefore must never trigger a second transaction generation.
        lastError = errorText(error);
        args.reporter?.("pump spam-buy resend retry", {
          mint: args.token.mint,
          wallet: args.buyer.address,
          signature: active.signature,
          processed,
          error: lastError,
        });
      }
    }

    await sleep(settings.retryIntervalMs, args.signal);
  }

  return result("stopped", active?.signature ?? null);
}

export async function runPumpSpamBuyers(args: {
  slrd: Solard;
  mint: string | PublicKey;
  buyers: BuyerAllocation[];
  settings: PumpSpamBuySettings;
  live: boolean;
  signal?: AbortSignal;
  reporter?: LaunchReporter;
}): Promise<PumpSpamBuyRunResult> {
  validateSettings(args.settings);
  const mint =
    args.mint instanceof PublicKey ? args.mint : new PublicKey(args.mint);
  if (args.buyers.length === 0) throw new Error("No buyer wallets selected");

  if (!args.live) {
    return {
      mint: mint.toBase58(),
      live: false,
      buyers: args.buyers.map((buyer) => ({
        address: buyer.address,
        spendLamports: buyer.spendLamports,
        selectedBps: buyer.selectedBps,
        sender: String(buyer.execution?.sender ?? args.settings.sender),
        status: "stopped",
        signature: null,
        signatures: [],
        broadcasts: 0,
        recompiles: 0,
        freshQuotes: 0,
        failedAttempts: 0,
        lastError: null,
      })),
    };
  }

  const token = await waitForPumpMarket({
    slrd: args.slrd,
    mint,
    intervalMs: args.settings.discoveryIntervalMs,
    timeoutMs: args.settings.timeoutMs,
    signal: args.signal,
    reporter: args.reporter,
  });

  if (!token) {
    return {
      mint: mint.toBase58(),
      live: true,
      buyers: args.buyers.map((buyer) => ({
        address: buyer.address,
        spendLamports: buyer.spendLamports,
        selectedBps: buyer.selectedBps,
        sender: String(buyer.execution?.sender ?? args.settings.sender),
        status: "stopped",
        signature: null,
        signatures: [],
        broadcasts: 0,
        recompiles: 0,
        freshQuotes: 0,
        failedAttempts: 0,
        lastError: null,
      })),
    };
  }

  const settled = await Promise.allSettled(
    args.buyers.map((buyer) =>
      runBuyerLoop({
        slrd: args.slrd,
        token,
        buyer,
        shared: args.settings,
        signal: args.signal,
        reporter: args.reporter,
      }),
    ),
  );

  return {
    mint: mint.toBase58(),
    live: true,
    buyers: settled.map((item, index) =>
      item.status === "fulfilled"
        ? item.value
        : {
            address: args.buyers[index]!.address,
            spendLamports: args.buyers[index]!.spendLamports,
            selectedBps: args.buyers[index]!.selectedBps,
            sender: String(
              args.buyers[index]!.execution?.sender ?? args.settings.sender,
            ),
            status: "failed",
            signature: null,
            signatures: [],
            broadcasts: 0,
            recompiles: 0,
            freshQuotes: 0,
            failedAttempts: 1,
            lastError: errorText(item.reason),
          },
    ),
  };
}
