import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
} from "@solana/web3.js";

import { rawAmount, sol } from "../core/amounts.ts";
import { loadWalletAssetPortfolio } from "./portfolio.ts";
import { resolveTokenMintForPolicy } from "./liquidation.ts";
import { findExternalContact } from "../address-book.ts";
import type { Solard } from "../core/solard.ts";
import type {
  PlannedTransaction,
  SendReceipt,
  SimulationResult,
} from "../tx/types.ts";

export type RegistrySolSweepRow = {
  walletName: string;
  walletAddress: string;
  balanceLamports: bigint;
  keepLamports: bigint;
  feeLamports: bigint;
  sendLamports: bigint;
  destination: string;
  tokenHoldingCount: number;
  tokenScanComplete: boolean;
  reserveReason?:
    | "explicit"
    | "default"
    | "token-holdings"
    | "specific-token"
    | "token-scan-uncertain";
  reserveTokenMint?: string;
  reserveTokenAmountRaw?: bigint;
  skippedReason?: string;
};

export type RegistrySolSweepOptions = {
  destination: string;
  excludeGroups?: string[];
  excludePrefixes?: string[];
  includeWallets?: string[];
  /** Only sweep wallets whose confirmed native SOL balance is strictly below this amount. */
  maxBalanceSol?: string;
  keepSolByWallet?: Record<string, string>;
  defaultKeepSol?: string;
  /** Keep this much SOL when a wallet still has any nonzero SPL/Token-2022 holding. */
  keepSolIfTokens?: string;
  /** Keep SOL only when this specific token is present, e.g. slrd=0.1. */
  keepSolIfToken?: { token: string; sol: string };
  /** Token ownership scans are public-only and never require signer decryption. */
  tokenScanConcurrency?: number;
  tokenScanDelayMs?: number;
  delayMs?: number;
  /** Maximum fresh live attempts after a prior signed transaction is proven unable to land. */
  maxAttempts?: number;
  /** Confirmation wait for each submitted signature before expiry reconciliation begins. */
  confirmationTimeoutMs?: number;
  /** Poll interval while reconciling an unresolved submitted signature. */
  confirmationPollMs?: number;
  /** Optional live/simulation progress. Observability only; must not affect execution semantics. */
  onProgress?: (event: RegistrySolSweepProgress) => void;
};

export type RegistrySolSweepProgress =
  | {
      stage: "wallet-start";
      index: number;
      total: number;
      row: RegistrySolSweepRow;
    }
  | {
      stage: "wallet-pending";
      index: number;
      total: number;
      row: RegistrySolSweepRow;
      attempt: number;
      maxAttempts: number;
      signature: string;
      reason: string;
    }
  | {
      stage: "wallet-done";
      index: number;
      total: number;
      row: RegistrySolSweepRow;
      receipt?: SendReceipt;
      remainingLamports: bigint;
      attempts: number;
    }
  | {
      stage: "wallet-error";
      index: number;
      total: number;
      row: RegistrySolSweepRow;
      error: string;
    };

export type RegistrySolSweepPlan = {
  destination: string;
  excludedWallets: string[];
  rows: RegistrySolSweepRow[];
  totalSendLamports: bigint;
};

export type RegistrySolSweepSimulation = {
  row: RegistrySolSweepRow;
  simulation?: SimulationResult;
  error?: string;
};

export type RegistrySolSweepReceipt = {
  row: RegistrySolSweepRow;
  receipt?: SendReceipt;
  error?: string;
};

const pause = (ms: number) =>
  ms > 0
    ? new Promise<void>((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

function sweepSourceBlockedReason(
  info: { owner: PublicKey; data: Uint8Array } | null,
): string | null {
  if (!info) return null;
  if (!info.owner.equals(SystemProgram.programId))
    return "source-not-system-owned";
  if (info.data.length !== 0) return "source-account-has-data";
  return null;
}

function requireSweepableSource(
  walletAddress: string,
  info: { owner: PublicKey; data: Uint8Array } | null,
): void {
  if (!info) throw new Error(`source account ${walletAddress} does not exist`);
  const reason = sweepSourceBlockedReason(info);
  if (reason) {
    throw new Error(
      `source account ${walletAddress} is not sweepable by SystemProgram.transfer: ${reason}`,
    );
  }
}

function resolveDestination(slrd: Solard, value: string): PublicKey {
  const input = value.trim();
  if (!input) throw new Error("Sweep destination is required.");

  try {
    return slrd.resolveWallet(input).address;
  } catch {
    // Not a signing-wallet ref; external contacts and raw addresses are valid.
  }

  const contact = findExternalContact(input);
  if (contact) return new PublicKey(contact.address);

  try {
    return new PublicKey(input);
  } catch {
    throw new Error(
      `Unknown sweep destination "${input}". ` +
        `Use a valid Solana address, a stored wallet name, or register it first with ` +
        `slrd contact add <name> <address>.`,
    );
  }
}

function explicitKeepLamportsFor(
  wallet: { name: string; address: string },
  options: RegistrySolSweepOptions,
): { lamports: bigint; explicit: boolean } {
  const map = options.keepSolByWallet ?? {};
  const explicit = map[wallet.name] ?? map[wallet.address];
  if (explicit != null) return { lamports: sol(explicit).raw, explicit: true };
  return {
    lamports: sol(options.defaultKeepSol ?? "0").raw,
    explicit: false,
  };
}

async function quoteSharedSweepFee(
  slrd: Solard,
  payer: PublicKey,
  destination: PublicKey,
): Promise<bigint> {
  const connection = slrd.connection();
  const latest = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: latest.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 10_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
      // Fee depends on message/signature shape, not the transfer amount.
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: destination,
        lamports: 1,
      }),
    ],
  }).compileToV0Message();

  const quote = await connection.getFeeForMessage(message, "confirmed");
  if (quote.value == null) {
    throw new Error("RPC returned no fee quote for SOL sweep");
  }
  return BigInt(quote.value);
}

async function buildExactSweepPlan(
  slrd: Solard,
  walletRef: string,
  destination: PublicKey,
  balanceLamports: bigint,
  keepLamports: bigint,
): Promise<{
  plan: PlannedTransaction;
  feeLamports: bigint;
  sendLamports: bigint;
}> {
  // Fee does not depend on transfer amount, but it does depend on the compiled
  // message. Iterate once if the quoted fee differs from the initial base-fee
  // estimate, then send the exact plan whose message was quoted.
  let feeLamports = 5_000n;
  let finalPlan: PlannedTransaction | null = null;
  let sendLamports = 0n;

  for (let attempt = 0; attempt < 3; attempt++) {
    sendLamports = balanceLamports - keepLamports - feeLamports;
    if (sendLamports <= 0n)
      throw new Error("balance does not exceed reserve plus fee");

    finalPlan = await slrd
      .tx(walletRef)
      .transferSol(destination, rawAmount(sendLamports))
      .priorityFee({ cuLimit: 10_000, microLamports: 0 })
      .build();

    const quoted = await slrd
      .connection()
      .getFeeForMessage(finalPlan.transaction.message, "confirmed");
    if (quoted.value == null)
      throw new Error("RPC returned no fee quote for sweep transaction");
    const nextFee = BigInt(quoted.value);
    if (nextFee === feeLamports)
      return { plan: finalPlan, feeLamports, sendLamports };
    feeLamports = nextFee;
  }

  if (!finalPlan) throw new Error("failed to build sweep transaction");
  sendLamports = balanceLamports - keepLamports - feeLamports;
  if (sendLamports <= 0n)
    throw new Error("balance does not exceed reserve plus fee");
  finalPlan = await slrd
    .tx(walletRef)
    .transferSol(destination, rawAmount(sendLamports))
    .priorityFee({ cuLimit: 10_000, microLamports: 0 })
    .build();
  return { plan: finalPlan, feeLamports, sendLamports };
}

function selectedWallets(slrd: Solard, options: RegistrySolSweepOptions) {
  let wallets = slrd.wallets.list();
  const included = options.includeWallets?.length
    ? new Set(
        options.includeWallets.map((ref) =>
          slrd.resolveWallet(ref).address.toBase58(),
        ),
      )
    : null;
  if (included)
    wallets = wallets.filter((wallet) => included.has(wallet.address));

  const excluded = new Set<string>();
  for (const group of options.excludeGroups ?? []) {
    const exists = slrd.groups.list().some((row) => row.name === group);
    if (!exists) throw new Error(`Unknown group: ${group}`);
    for (const row of slrd.groups.wallets(group))
      excluded.add(row.walletAddress);
  }
  const prefixes = (options.excludePrefixes ?? []).map((value) =>
    value.toLowerCase(),
  );
  for (const wallet of wallets) {
    if (prefixes.some((prefix) => wallet.name.toLowerCase().startsWith(prefix)))
      excluded.add(wallet.address);
  }
  return { wallets, excluded };
}

export async function planRegistrySolSweep(
  slrd: Solard,
  options: RegistrySolSweepOptions,
): Promise<RegistrySolSweepPlan> {
  const destination = resolveDestination(slrd, options.destination);
  const destinationAddress = destination.toBase58();
  const { wallets, excluded } = selectedWallets(slrd, options);
  excluded.add(destinationAddress);

  const candidates = wallets.filter((wallet) => !excluded.has(wallet.address));

  const maxBalanceLamports =
    options.maxBalanceSol != null ? sol(options.maxBalanceSol).raw : null;
  if (maxBalanceLamports != null && maxBalanceLamports <= 0n) {
    throw new Error("maxBalanceSol must be greater than zero");
  }

  if (options.keepSolIfTokens != null && options.keepSolIfToken != null) {
    throw new Error("Use either keepSolIfTokens or keepSolIfToken, not both.");
  }

  const conditionalKeep =
    options.keepSolIfTokens != null ? sol(options.keepSolIfTokens).raw : null;
  const specificKeep =
    options.keepSolIfToken != null
      ? {
          mint: resolveTokenMintForPolicy(slrd, options.keepSolIfToken.token),
          lamports: sol(options.keepSolIfToken.sol).raw,
        }
      : null;

  const portfolio =
    conditionalKeep != null || specificKeep != null
      ? await loadWalletAssetPortfolio(slrd, {
          walletRefs: candidates.map((wallet) => wallet.address),
          concurrency: options.tokenScanConcurrency ?? 1,
          requestDelayMs: options.tokenScanDelayMs ?? 75,
        })
      : null;
  const portfolioByAddress = new Map(
    (portfolio?.rows ?? []).map((row) => [row.walletAddress, row] as const),
  );

  const balances = new Map<string, bigint>();
  const sourceBlockedReasons = new Map<string, string>();
  for (let offset = 0; offset < candidates.length; offset += 100) {
    const batch = candidates.slice(offset, offset + 100);
    const infos = await slrd.connection().getMultipleAccountsInfo(
      batch.map((wallet) => new PublicKey(wallet.address)),
      "confirmed",
    );
    for (let index = 0; index < batch.length; index++) {
      const wallet = batch[index]!;
      const info = infos[index] ?? null;
      balances.set(wallet.address, BigInt(info?.lamports ?? 0));
      const blocked = sweepSourceBlockedReason(info);
      if (blocked) sourceBlockedReasons.set(wallet.address, blocked);
    }
  }

  const sharedFeeLamports =
    candidates.length > 0
      ? await quoteSharedSweepFee(
          slrd,
          new PublicKey(candidates[0]!.address),
          destination,
        )
      : 0n;

  const rows: RegistrySolSweepRow[] = [];
  for (const wallet of candidates) {
    const balanceLamports = balances.get(wallet.address) ?? 0n;
    const sourceBlockedReason = sourceBlockedReasons.get(wallet.address);
    const excludedByMaxBalance =
      maxBalanceLamports != null && balanceLamports >= maxBalanceLamports;
    const configured = explicitKeepLamportsFor(wallet, options);
    const portfolioRow = portfolioByAddress.get(wallet.address);
    const tokenHoldingCount =
      portfolioRow?.tokenHoldings.filter((holding) => holding.amountRaw > 0n)
        .length ?? 0;
    const tokenScanComplete = portfolioRow?.tokenScanComplete ?? true;

    let keepLamports = configured.lamports;
    let reserveReason: RegistrySolSweepRow["reserveReason"] =
      configured.explicit ? "explicit" : "default";
    let reserveTokenMint: string | undefined;
    let reserveTokenAmountRaw: bigint | undefined;

    if (!configured.explicit && conditionalKeep != null) {
      if (!tokenScanComplete) {
        keepLamports =
          conditionalKeep > keepLamports ? conditionalKeep : keepLamports;
        reserveReason = "token-scan-uncertain";
      } else if (tokenHoldingCount > 0) {
        keepLamports =
          conditionalKeep > keepLamports ? conditionalKeep : keepLamports;
        reserveReason = "token-holdings";
      }
    }

    if (!configured.explicit && specificKeep != null) {
      const matching =
        portfolioRow?.tokenHoldings.filter(
          (holding) =>
            holding.mint === specificKeep.mint && holding.amountRaw > 0n,
        ) ?? [];
      const matchingRaw = matching.reduce(
        (sum, holding) => sum + holding.amountRaw,
        0n,
      );

      reserveTokenMint = specificKeep.mint;
      reserveTokenAmountRaw = matchingRaw;

      if (!tokenScanComplete) {
        keepLamports =
          specificKeep.lamports > keepLamports
            ? specificKeep.lamports
            : keepLamports;
        reserveReason = "token-scan-uncertain";
      } else if (matchingRaw > 0n) {
        keepLamports =
          specificKeep.lamports > keepLamports
            ? specificKeep.lamports
            : keepLamports;
        reserveReason = "specific-token";
      }
    }

    const sendLamports =
      !sourceBlockedReason &&
      !excludedByMaxBalance &&
      balanceLamports > keepLamports + sharedFeeLamports
        ? balanceLamports - keepLamports - sharedFeeLamports
        : 0n;

    rows.push({
      walletName: wallet.name,
      walletAddress: wallet.address,
      balanceLamports,
      keepLamports,
      feeLamports: sendLamports > 0n ? sharedFeeLamports : 0n,
      sendLamports,
      destination: destinationAddress,
      tokenHoldingCount,
      tokenScanComplete,
      reserveReason,
      reserveTokenMint,
      reserveTokenAmountRaw,
      skippedReason: sourceBlockedReason
        ? sourceBlockedReason
        : excludedByMaxBalance
          ? "balance-at-or-above-max"
          : sendLamports > 0n
            ? undefined
            : "balance-too-low",
    });
  }

  rows.sort((a, b) => {
    if (a.sendLamports === b.sendLamports)
      return a.walletName.localeCompare(b.walletName);
    return a.sendLamports > b.sendLamports ? -1 : 1;
  });

  return {
    destination: destinationAddress,
    excludedWallets: [...excluded].sort(),
    rows,
    totalSendLamports: rows.reduce((sum, row) => sum + row.sendLamports, 0n),
  };
}

export async function simulateRegistrySolSweep(
  slrd: Solard,
  plan: RegistrySolSweepPlan,
  options: RegistrySolSweepOptions,
): Promise<RegistrySolSweepSimulation[]> {
  const destination = new PublicKey(plan.destination);
  const results: RegistrySolSweepSimulation[] = [];
  const delayMs = Math.max(0, options.delayMs ?? 100);
  for (const row of plan.rows) {
    if (row.sendLamports <= 0n || row.skippedReason) continue;
    try {
      const sourceKey = new PublicKey(row.walletAddress);
      const sourceInfo = await slrd
        .connection()
        .getAccountInfo(sourceKey, "confirmed");
      requireSweepableSource(row.walletAddress, sourceInfo);
      const freshBalance = BigInt(sourceInfo!.lamports);
      const built = await buildExactSweepPlan(
        slrd,
        row.walletAddress,
        destination,
        freshBalance,
        row.keepLamports,
      );
      results.push({
        row: {
          ...row,
          balanceLamports: freshBalance,
          feeLamports: built.feeLamports,
          sendLamports: built.sendLamports,
        },
        simulation: await slrd.simulatePlan(built.plan),
      });
    } catch (error) {
      results.push({
        row,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await pause(delayMs);
  }
  return results;
}

async function currentSweepSourceInfo(slrd: Solard, walletAddress: string) {
  return await slrd
    .connection()
    .getAccountInfo(new PublicKey(walletAddress), "confirmed");
}

async function waitForSweepSubmissionToSettle(args: {
  slrd: Solard;
  submission: Awaited<ReturnType<Solard["submitPlan"]>>;
  row: RegistrySolSweepRow;
  index: number;
  total: number;
  attempt: number;
  maxAttempts: number;
  confirmationTimeoutMs: number;
  confirmationPollMs: number;
  onProgress?: RegistrySolSweepOptions["onProgress"];
}): Promise<SendReceipt> {
  let receipt = await args.slrd.confirmSubmission(
    args.submission,
    args.confirmationTimeoutMs,
  );
  if (receipt.status !== "submitted") return receipt;

  args.onProgress?.({
    stage: "wallet-pending",
    index: args.index,
    total: args.total,
    row: args.row,
    attempt: args.attempt,
    maxAttempts: args.maxAttempts,
    signature: args.submission.signature,
    reason:
      "confirmation-timeout; waiting until confirmed/failed or blockhash expiry",
  });

  // A timed-out signature is NOT safe to rebuild immediately: it may still land.
  // Reconcile it until it confirms/fails or the original blockhash is expired.
  while (true) {
    const status = (
      await args.slrd
        .connection()
        .getSignatureStatuses([args.submission.signature], {
          searchTransactionHistory: true,
        })
    ).value[0];

    if (status?.err) {
      return {
        signature: args.submission.signature,
        slot: status.slot ?? null,
        sender: args.submission.sender,
        status: "failed",
        error: JSON.stringify(status.err),
      };
    }

    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized" ||
      status?.confirmations === null
    ) {
      receipt = await args.slrd.confirmSignature(
        args.submission.signature,
        args.submission.sender,
        5_000,
      );
      if (receipt.status !== "submitted") return receipt;
    }

    const blockHeight = await args.slrd
      .connection()
      .getBlockHeight("confirmed");
    if (blockHeight > args.submission.plan.lastValidBlockHeight) {
      return {
        signature: args.submission.signature,
        slot: status?.slot ?? null,
        sender: args.submission.sender,
        status: "submitted",
        error: "blockhash-expired-without-confirmation",
      };
    }

    await pause(args.confirmationPollMs);
  }
}

export async function executeRegistrySolSweep(
  slrd: Solard,
  plan: RegistrySolSweepPlan,
  options: RegistrySolSweepOptions,
): Promise<RegistrySolSweepReceipt[]> {
  const destination = new PublicKey(plan.destination);
  const results: RegistrySolSweepReceipt[] = [];
  const delayMs = Math.max(0, options.delayMs ?? 100);
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? 3));
  const confirmationTimeoutMs = Math.max(
    1_000,
    Math.trunc(options.confirmationTimeoutMs ?? 15_000),
  );
  const confirmationPollMs = Math.max(
    250,
    Math.trunc(options.confirmationPollMs ?? 750),
  );
  const maxBalanceLamports =
    options.maxBalanceSol != null ? sol(options.maxBalanceSol).raw : null;

  const executable = plan.rows.filter(
    (row) => row.sendLamports > 0n && !row.skippedReason,
  );

  for (let index = 0; index < executable.length; index += 1) {
    const plannedRow = executable[index]!;
    options.onProgress?.({
      stage: "wallet-start",
      index: index + 1,
      total: executable.length,
      row: plannedRow,
    });

    let finalReceipt: SendReceipt | undefined;
    let completedRow = plannedRow;
    let success = false;
    let lastError: string | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const sourceInfo = await currentSweepSourceInfo(
          slrd,
          plannedRow.walletAddress,
        );

        // Already drained by a prior attempt/process is a converged state.
        if (!sourceInfo) {
          completedRow = {
            ...plannedRow,
            balanceLamports: 0n,
            feeLamports: 0n,
            sendLamports: 0n,
          };
          success = true;
          break;
        }

        requireSweepableSource(plannedRow.walletAddress, sourceInfo);
        const freshBalance = BigInt(sourceInfo.lamports);

        // Re-enforce the ceiling at execution time. A wallet funded above the
        // threshold after planning must never be drained because of a stale plan.
        if (maxBalanceLamports != null && freshBalance >= maxBalanceLamports) {
          throw new Error(
            `fresh balance ${freshBalance.toString()} is at-or-above sweep ceiling ${maxBalanceLamports.toString()}; refusing stale planned sweep`,
          );
        }

        if (freshBalance <= plannedRow.keepLamports) {
          completedRow = {
            ...plannedRow,
            balanceLamports: freshBalance,
            feeLamports: 0n,
            sendLamports: 0n,
          };
          success = true;
          break;
        }

        const built = await buildExactSweepPlan(
          slrd,
          plannedRow.walletAddress,
          destination,
          freshBalance,
          plannedRow.keepLamports,
        );
        completedRow = {
          ...plannedRow,
          balanceLamports: freshBalance,
          feeLamports: built.feeLamports,
          sendLamports: built.sendLamports,
        };

        const submission = await slrd.submitPlan(
          built.plan,
          "rpc",
          "registry-sol-sweep",
          {
            skipSimulation: false,
            skipPreflight: false,
          },
        );

        const receipt = await waitForSweepSubmissionToSettle({
          slrd,
          submission,
          row: completedRow,
          index: index + 1,
          total: executable.length,
          attempt,
          maxAttempts,
          confirmationTimeoutMs,
          confirmationPollMs,
          onProgress: options.onProgress,
        });
        finalReceipt = receipt;

        const afterInfo = await currentSweepSourceInfo(
          slrd,
          plannedRow.walletAddress,
        );
        const remainingLamports = BigInt(afterInfo?.lamports ?? 0);

        if (receipt.status === "confirmed") {
          if (remainingLamports <= plannedRow.keepLamports) {
            success = true;
            break;
          }

          // The transaction confirmed but new SOL may have arrived meanwhile.
          // Retry only if the fresh balance still satisfies the ceiling.
          if (
            maxBalanceLamports != null &&
            remainingLamports >= maxBalanceLamports
          ) {
            throw new Error(
              `sweep confirmed but wallet was re-funded to ${remainingLamports.toString()} lamports, at-or-above the configured ceiling`,
            );
          }

          lastError =
            `sweep ${receipt.signature} confirmed but ` +
            `${remainingLamports.toString()} lamports remain above reserve ` +
            `${plannedRow.keepLamports.toString()}`;
          if (attempt < maxAttempts) continue;
          break;
        }

        if (receipt.status === "failed") {
          lastError =
            `sweep ${receipt.signature} failed` +
            `${receipt.error ? `: ${receipt.error}` : ""}`;
          if (attempt < maxAttempts) continue;
          break;
        }

        // "submitted" here means the original blockhash expired without a
        // confirmed/failed status. It is now safe to rebuild a fresh transaction.
        if (remainingLamports <= plannedRow.keepLamports) {
          lastError =
            `signature ${receipt.signature} became unresolved, although the source ` +
            `balance reached the requested reserve; refusing to label it confirmed`;
          break;
        }

        lastError =
          `signature ${receipt.signature} expired without confirmation; ` +
          `${remainingLamports.toString()} lamports remain`;
        if (attempt < maxAttempts) {
          options.onProgress?.({
            stage: "wallet-pending",
            index: index + 1,
            total: executable.length,
            row: completedRow,
            attempt,
            maxAttempts,
            signature: receipt.signature,
            reason:
              "expired-unconfirmed; rebuilding from fresh on-chain balance",
          });
          continue;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);

        // Simulation/build/account-eligibility errors are not ambiguous
        // submissions. A fresh attempt is only useful for transient failures.
        if (
          /source-account-has-data|source-not-system-owned|at-or-above sweep ceiling|Simulation failed/i.test(
            lastError,
          )
        ) {
          break;
        }

        if (attempt < maxAttempts) {
          await pause(confirmationPollMs);
          continue;
        }
      }
    }

    const afterInfo = await currentSweepSourceInfo(
      slrd,
      plannedRow.walletAddress,
    );
    const remainingLamports = BigInt(afterInfo?.lamports ?? 0);

    if (success) {
      results.push({
        row: completedRow,
        receipt: finalReceipt,
      });
      options.onProgress?.({
        stage: "wallet-done",
        index: index + 1,
        total: executable.length,
        row: completedRow,
        receipt: finalReceipt,
        remainingLamports,
        attempts: maxAttempts,
      });
    } else {
      const errorText =
        lastError ??
        `sweep did not converge: ${remainingLamports.toString()} lamports remain`;
      results.push({
        row: completedRow,
        receipt: finalReceipt,
        error: errorText,
      });
      options.onProgress?.({
        stage: "wallet-error",
        index: index + 1,
        total: executable.length,
        row: completedRow,
        error: errorText,
      });
    }

    await pause(delayMs);
  }

  return results;
}
