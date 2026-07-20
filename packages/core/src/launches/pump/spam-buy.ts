import { PublicKey, SystemProgram } from "@solana/web3.js";

import { rawAmount, SOL_ASSET } from "../../core/amounts.ts";
import type { WalletRef } from "../../core/refs.ts";
import type { TokenRow } from "../../db/schema.ts";
import type { Solard } from "../../sdk/slrd.ts";
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
  args.slrd.cache.invalidate();
  const token = await args.slrd.refreshToken(args.token);
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

async function signatureStates(
  slrd: Solard,
  signatures: readonly string[],
): Promise<Array<"pending" | "success" | "failed">> {
  if (signatures.length === 0) return [];
  const statuses = (
    await slrd.connection().getSignatureStatuses([...signatures], {
      searchTransactionHistory: true,
    })
  ).value;
  return statuses.map((status) => {
    if (!status) return "pending";
    if (status.err) return "failed";
    return status.confirmationStatus === "processed" ||
      status.confirmationStatus === "confirmed" ||
      status.confirmationStatus === "finalized"
      ? "success"
      : "pending";
  });
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
  const failedSignatures = new Set<string>();
  let active: PlannedTransaction | null = null;
  let lastCompileAt = 0;
  let lastQuoteAt = 0;
  let broadcasts = 0;
  let recompiles = 0;
  let freshQuotes = 0;
  let failedAttempts = 0;
  let lastError: string | null = null;

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
  });

  while (!args.signal?.aborted) {
    if (
      settings.timeoutMs > 0 &&
      Date.now() - startedAt >= settings.timeoutMs
    ) {
      lastError = `Buyer timed out after ${settings.timeoutMs}ms`;
      return result("failed", null);
    }

    if (signatures.length > 0) {
      try {
        const states = await signatureStates(args.slrd, signatures);
        for (let index = 0; index < states.length; index += 1) {
          const state = states[index]!;
          const signature = signatures[index]!;
          if (state === "success") {
            args.reporter?.("pump spam-buy landed", {
              mint: args.token.mint,
              wallet: args.buyer.address,
              signature,
              broadcasts,
              recompiles,
              freshQuotes,
            });
            return result("confirmed", signature);
          }
          if (state === "failed" && !failedSignatures.has(signature)) {
            failedSignatures.add(signature);
            failedAttempts += 1;
          }
        }
      } catch (error) {
        lastError = errorText(error);
      }
    }

    if (
      settings.maxFailedAttempts > 0 &&
      failedAttempts >= settings.maxFailedAttempts
    ) {
      lastError ??= `Reached maxFailedAttempts=${settings.maxFailedAttempts}`;
      return result("failed", null);
    }

    const now = Date.now();
    const needsFreshQuote =
      active == null ||
      (settings.freshQuoteIntervalMs > 0 &&
        now - lastQuoteAt >= settings.freshQuoteIntervalMs);
    const needsRecompile =
      active != null &&
      settings.recompileIntervalMs > 0 &&
      now - lastCompileAt >= settings.recompileIntervalMs;

    try {
      if (needsFreshQuote) {
        active = await buildLivePlan({
          slrd: args.slrd,
          token: args.token,
          buyer: args.buyer,
          settings,
        });
        lastQuoteAt = Date.now();
        lastCompileAt = lastQuoteAt;
        freshQuotes += 1;
      } else if (needsRecompile && active) {
        active = await args.slrd.compile(
          args.slrd.signer(args.buyer.walletRef),
          active.draft,
          { useAlts: false },
        );
        lastCompileAt = Date.now();
        recompiles += 1;
      }

      if (!active) throw new Error("Buyer plan was not built");

      const submitted: SubmittedPlan = await args.slrd.broadcastPlan(
        active,
        settings.sender,
        `cli:spam-buy:pump:${args.buyer.address}`,
        { skipSimulation: true, skipPreflight: true },
      );
      broadcasts += 1;
      if (!signatures.includes(submitted.signature)) {
        signatures.push(submitted.signature);
        // getSignatureStatuses accepts at most 256 signatures. Older blockhash
        // generations are no longer useful once this window is exceeded.
        if (signatures.length > 128)
          signatures.splice(0, signatures.length - 128);
      }
    } catch (error) {
      lastError = errorText(error);
      failedAttempts += 1;
      args.reporter?.("pump spam-buy attempt error", {
        mint: args.token.mint,
        wallet: args.buyer.address,
        failedAttempts,
        error: lastError,
      });
    }

    await sleep(settings.retryIntervalMs, args.signal);
  }

  return result("stopped", null);
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
