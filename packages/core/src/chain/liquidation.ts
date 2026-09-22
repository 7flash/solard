import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  createBurnCheckedInstruction,
  createHarvestWithheldTokensToMintInstruction,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

import type { Solard } from "../core/solard.ts";
import type { TokenRow } from "../db/schema.ts";
import type {
  SendReceipt,
  SenderId,
  SimulationResult,
  SubmittedPlan,
} from "../tx/types.ts";
import {
  loadWalletAssetPortfolio,
  type WalletTokenHolding,
} from "./portfolio.ts";
import {
  executeJupiterTokenToSol,
  quoteJupiterTokenToSol,
  type JupiterSwapExecuteResult,
  type JupiterSwapQuote,
} from "./jupiter-swap.ts";

export type RegistryTokenLiquidationActionKind =
  | "sell"
  | "jupiter-sell"
  | "unwrap-wsol"
  | "close-empty"
  | "keep-protected"
  | "skip-unsupported";

export type RegistryTokenLiquidationAction = {
  kind: RegistryTokenLiquidationActionKind;
  walletName: string;
  walletAddress: string;
  mint: string;
  name: string | null;
  symbol: string | null;
  decimals: number;
  amountRaw: bigint;
  amountUi: string;
  venue?: string;
  reason?: string;
  jupiterQuote?: JupiterSwapQuote;
  /** Exact token-account metadata for zero-balance rent cleanup. */
  tokenAccount?: string;
  tokenProgram?: string;
  rentLamports?: bigint;
  /** Ephemeral routing metadata; never contains secret key material. */
  token?: TokenRow;
};

export type RegistryTokenLiquidationPlan = {
  protectedMints: string[];
  actions: RegistryTokenLiquidationAction[];
  totals: {
    wallets: number;
    sell: number;
    jupiterSell: number;
    unwrapWsol: number;
    closeEmpty: number;
    keepProtected: number;
    skipUnsupported: number;
  };
};

export type RegistryTokenLiquidationProgress =
  | { stage: "portfolio-start" }
  | {
      stage: "portfolio-done";
      wallets: number;
      holdings: number;
      distinctMints: number;
    }
  | {
      stage: "route";
      index: number;
      total: number;
      mint: string;
    }
  | {
      stage: "action-start";
      index: number;
      total: number;
      action: RegistryTokenLiquidationAction;
    }
  | {
      stage: "action-done";
      index: number;
      total: number;
      action: RegistryTokenLiquidationAction;
    }
  | {
      stage: "action-pending";
      index: number;
      total: number;
      action: RegistryTokenLiquidationAction;
      attempt: number;
      maxAttempts: number;
      signature: string | null;
      reason: string;
    }
  | {
      stage: "action-error";
      index: number;
      total: number;
      action: RegistryTokenLiquidationAction;
      error: string;
    };

export type RegistryTokenLiquidationOptions = {
  except?: string[];
  walletRefs?: string[];
  exceptWalletRefs?: string[];
  slippageBps?: number;
  via?: SenderId;
  delayMs?: number;
  routeDelayMs?: number;
  portfolioConcurrency?: number;
  portfolioDelayMs?: number;
  /** Try Jupiter when native routing/build/execution fails. */
  jupiterFallback?: boolean;
  /** Explicitly destroy unprotected unsellable balances so their accounts can close. */
  burnUnsellable?: boolean;
  onProgress?: (event: RegistryTokenLiquidationProgress) => void;
};

export type RegistryTokenLiquidationResult = {
  action: RegistryTokenLiquidationAction;
  simulation?: SimulationResult;
  receipt?: SendReceipt;
  jupiter?: JupiterSwapExecuteResult | JupiterSwapQuote;
  error?: string;
};

const pause = (ms: number) =>
  ms > 0
    ? new Promise<void>((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function liveMintAccounts(slrd: Solard, wallet: string, mint: string) {
  return (await slrd.tokenAccounts(wallet)).filter(
    (account) => account.mint === mint && account.amountRaw > 0n,
  );
}

async function associatedSellableAmount(
  slrd: Solard,
  wallet: string,
  mint: string,
): Promise<bigint> {
  const accounts = await liveMintAccounts(slrd, wallet, mint);
  return accounts
    .filter((account) => account.isAssociated)
    .reduce((sum, account) => sum + account.amountRaw, 0n);
}

type MintLiquidationBalance = {
  totalRaw: bigint;
  associatedRaw: bigint;
  nonAssociatedRaw: bigint;
  accounts: Awaited<ReturnType<Solard["tokenAccounts"]>>;
};

async function mintLiquidationBalance(
  slrd: Solard,
  wallet: string,
  mint: string,
): Promise<MintLiquidationBalance> {
  const accounts = (await slrd.tokenAccounts(wallet)).filter(
    (account) => account.mint === mint && account.amountRaw > 0n,
  );
  const associatedRaw = accounts
    .filter((account) => account.isAssociated)
    .reduce((sum, account) => sum + account.amountRaw, 0n);
  const nonAssociatedRaw = accounts
    .filter((account) => !account.isAssociated)
    .reduce((sum, account) => sum + account.amountRaw, 0n);
  return {
    totalRaw: associatedRaw + nonAssociatedRaw,
    associatedRaw,
    nonAssociatedRaw,
    accounts,
  };
}

function mintLiquidationBalanceText(balance: MintLiquidationBalance): string {
  if (!balance.accounts.length) return "zero";
  return balance.accounts
    .map(
      (account) =>
        `${account.address}=${account.amountRaw.toString()}${account.isAssociated ? ":ATA" : ":non-ATA"}`,
    )
    .join(", ");
}

async function waitForMintLiquidationBalance(args: {
  slrd: Solard;
  action: RegistryTokenLiquidationAction;
  index: number;
  total: number;
  signature?: string | null;
  attempts?: number;
  delayMs?: number;
  onProgress?: RegistryTokenLiquidationOptions["onProgress"];
}): Promise<MintLiquidationBalance> {
  const attempts = Math.max(1, args.attempts ?? 10);
  const delayMs = Math.max(100, args.delayMs ?? 600);
  let balance = await mintLiquidationBalance(
    args.slrd,
    args.action.walletAddress,
    args.action.mint,
  );
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (balance.totalRaw <= 0n) return balance;
    if (balance.associatedRaw <= 0n && balance.nonAssociatedRaw > 0n)
      return balance;
    if (attempt >= attempts) return balance;
    args.onProgress?.({
      stage: "action-pending",
      index: args.index,
      total: args.total,
      action: args.action,
      attempt,
      maxAttempts: attempts,
      signature: args.signature ?? null,
      reason:
        `waiting for liquidation settlement; remaining=${balance.totalRaw.toString()} raw ` +
        `ata=${balance.associatedRaw.toString()} nonAta=${balance.nonAssociatedRaw.toString()}`,
    });
    await pause(delayMs);
    balance = await mintLiquidationBalance(
      args.slrd,
      args.action.walletAddress,
      args.action.mint,
    );
  }
  return balance;
}

async function settledSendReceipt(
  slrd: Solard,
  receipt: SendReceipt,
): Promise<SendReceipt> {
  if (receipt.status === "failed") {
    throw new Error(
      `Liquidation transaction ${receipt.signature} failed: ${receipt.error ?? "transaction failed"}`,
    );
  }
  if (receipt.status !== "submitted") return receipt;
  const confirmed = await slrd.confirmSignature(
    receipt.signature,
    receipt.sender,
    15_000,
  );
  if (confirmed.status === "failed") {
    throw new Error(
      `Liquidation transaction ${confirmed.signature} failed: ${confirmed.error ?? "transaction failed"}`,
    );
  }
  if (confirmed.status === "submitted") {
    throw new Error(
      `Liquidation transaction ${confirmed.signature} is still unresolved; refusing to mark the token sold or submit a duplicate sell`,
    );
  }
  return confirmed;
}

function incompleteLiquidationError(
  action: RegistryTokenLiquidationAction,
  balance: MintLiquidationBalance,
): Error {
  return new Error(
    `Liquidation incomplete for ${action.mint}: ${balance.totalRaw.toString()} raw token units remain ` +
      `(ATA=${balance.associatedRaw.toString()}, non-ATA=${balance.nonAssociatedRaw.toString()}). ` +
      `Accounts: ${mintLiquidationBalanceText(balance)}. ` +
      (balance.nonAssociatedRaw > 0n
        ? "Native/Jupiter sells spend the associated token account only; move the balance into the ATA or re-run with --burn-unsellable if destroying the unprotected residual is intended."
        : "The sell transaction did not settle the full associated-token-account balance."),
  );
}

async function burnUnsellableMint(
  slrd: Solard,
  action: RegistryTokenLiquidationAction,
  via: SenderId,
): Promise<SendReceipt[]> {
  const signer = slrd.signer(action.walletAddress);
  const receipts: SendReceipt[] = [];
  const priorityMicroLamports = await cleanupPriorityMicroLamports(slrd);

  for (let sweep = 0; sweep < 4; sweep += 1) {
    const accounts = await liveMintAccounts(
      slrd,
      action.walletAddress,
      action.mint,
    );
    if (!accounts.length) return receipts;

    for (const candidate of accounts) {
      const current = (await slrd.tokenAccounts(action.walletAddress)).find(
        (account) => account.address === candidate.address,
      );
      if (!current || current.amountRaw <= 0n) continue;
      if (current.mint !== action.mint) {
        throw new Error(
          `Refusing burn because token account ${current.address} now contains mint ${current.mint}, expected ${action.mint}`,
        );
      }

      const composer = slrd.tx(action.walletAddress).priorityFee({
        cuLimit: 50_000,
        microLamports: priorityMicroLamports,
      });
      composer.add(
        createBurnCheckedInstruction(
          new PublicKey(current.address),
          new PublicKey(action.mint),
          signer.publicKey,
          current.amountRaw,
          current.decimals,
          [],
          new PublicKey(current.tokenProgram),
        ),
        {
          kind: "burn-token",
          mint: new PublicKey(action.mint),
          meta: {
            reason: "registry-liquidation-unsellable",
            tokenAccount: current.address,
            amountRaw: current.amountRaw.toString(),
          },
        },
      );

      try {
        let receipt = await composer.send({
          via,
          kind: "registry-token-liquidation:burn-unsellable",
          skipSimulation: false,
          skipPreflight: false,
        });
        if (receipt.status === "failed") {
          throw new Error(
            `Burn failed on-chain account=${current.address} signature=${receipt.signature}: ${receipt.error ?? "transaction failed"}`,
          );
        }

        let after = (await slrd.tokenAccounts(action.walletAddress)).find(
          (account) => account.address === current.address,
        );
        if (after && after.amountRaw > 0n && receipt.status === "submitted") {
          receipt = await slrd.confirmSignature(
            receipt.signature,
            receipt.sender,
            5_000,
          );
          if (receipt.status === "failed") {
            throw new Error(
              `Burn failed on-chain account=${current.address} signature=${receipt.signature}: ${receipt.error ?? "transaction failed"}`,
            );
          }
          after = (await slrd.tokenAccounts(action.walletAddress)).find(
            (account) => account.address === current.address,
          );
        }
        receipts.push(receipt);
        if (after && after.amountRaw > 0n && sweep === 3) {
          throw new Error(
            `Burn not verified account=${current.address}: ${after.amountRaw.toString()} raw token units remain`,
          );
        }
      } catch (error) {
        const after = (await slrd.tokenAccounts(action.walletAddress)).find(
          (account) => account.address === current.address,
        );
        if (!after || after.amountRaw <= 0n) continue;
        if (isAccountGoneError(errorMessage(error)) && sweep < 3) continue;
        throw error;
      }
    }
  }

  const remaining = await liveMintAccounts(
    slrd,
    action.walletAddress,
    action.mint,
  );
  if (remaining.length) {
    throw new Error(
      `Burn cleanup did not converge for ${action.mint}: ${remaining.map((account) => `${account.address}=${account.amountRaw.toString()}`).join(", ")}`,
    );
  }
  return receipts;
}

function isWithheldFeeCloseError(message: string): boolean {
  return /withheld fee balance|harvest fees to the mint|custom program error: 0x23|Custom\":35/i.test(
    message,
  );
}

function isAccountGoneError(message: string): boolean {
  return /AccountNotFound|account not found|could not find account/i.test(
    message,
  );
}

async function tokenAccountExistsConfirmed(
  slrd: Solard,
  address: string,
): Promise<boolean> {
  return (
    (await slrd
      .connection()
      .getAccountInfo(new PublicKey(address), "confirmed")) != null
  );
}

type PendingCloseSubmission = {
  action: RegistryTokenLiquidationAction;
  submission: SubmittedPlan;
  receipt: SendReceipt;
  harvest: boolean;
  index: number;
  total: number;
};

type CloseEmptyAccountOutcome =
  | { state: "closed"; receipt?: SendReceipt }
  | {
      state: "pending";
      pending: PendingCloseSubmission | null;
      harvest: boolean;
      reason: string;
    };

function broadcastReceipt(submission: SubmittedPlan): SendReceipt {
  return {
    signature: submission.signature,
    slot: null,
    sender: submission.sender,
    status: "submitted",
  };
}

function isExpiredSubmissionError(message: string): boolean {
  return /blockhash not found|block height exceeded|expired|transactionexpired/i.test(
    message,
  );
}

async function cleanupPriorityMicroLamports(slrd: Solard): Promise<number> {
  try {
    const rows = (await slrd
      .connection()
      .getRecentPrioritizationFees()) as Array<{
      prioritizationFee: number;
    }>;
    const fees = rows
      .map((row: { prioritizationFee: number }) => row.prioritizationFee)
      .filter((value: number) => Number.isSafeInteger(value) && value >= 0)
      .sort((left: number, right: number) => left - right);
    if (!fees.length) return 10_000;
    const index = Math.min(
      fees.length - 1,
      Math.floor((fees.length - 1) * 0.75),
    );
    return Math.max(10_000, Math.min(250_000, fees[index]!));
  } catch {
    return 10_000;
  }
}

async function currentClosableAccount(
  slrd: Solard,
  action: RegistryTokenLiquidationAction,
) {
  if (!action.tokenAccount)
    throw new Error("Missing zero-balance token-account metadata");
  const current = (await slrd.tokenAccounts(action.walletAddress)).find(
    (account) => account.address === action.tokenAccount,
  );
  if (!current) {
    return (await tokenAccountExistsConfirmed(slrd, action.tokenAccount))
      ? undefined
      : null;
  }
  if (current.amountRaw !== 0n)
    throw new Error(
      `Refusing to close non-empty token account ${action.tokenAccount}`,
    );
  if (current.closeAuthority && current.closeAuthority !== action.walletAddress)
    throw new Error(
      `Refusing token account with different close authority ${current.closeAuthority}`,
    );
  return current;
}

async function reconcilePendingClose(
  slrd: Solard,
  action: RegistryTokenLiquidationAction,
  pending: PendingCloseSubmission,
  currentBlockHeight: number | null,
): Promise<CloseEmptyAccountOutcome> {
  if (!action.tokenAccount)
    throw new Error("Missing zero-balance token-account metadata");
  if (!(await tokenAccountExistsConfirmed(slrd, action.tokenAccount))) {
    return { state: "closed", receipt: pending.receipt };
  }

  const receipt = await slrd.confirmSignature(
    pending.submission.signature,
    pending.submission.sender,
    1,
  );
  pending.receipt = receipt;

  if (!(await tokenAccountExistsConfirmed(slrd, action.tokenAccount))) {
    return { state: "closed", receipt };
  }

  if (receipt.status === "failed") {
    return {
      state: "pending",
      pending: null,
      harvest: pending.harvest || isWithheldFeeCloseError(receipt.error ?? ""),
      reason: `previous close failed on-chain: ${receipt.error ?? "transaction failed"}`,
    };
  }

  if (receipt.status === "confirmed") {
    return {
      state: "pending",
      pending: null,
      harvest: pending.harvest,
      reason:
        "close confirmed but the exact account still exists; rebuilding from fresh state",
    };
  }

  if (
    currentBlockHeight != null &&
    currentBlockHeight > pending.submission.plan.lastValidBlockHeight
  ) {
    return {
      state: "pending",
      pending: null,
      harvest: pending.harvest,
      reason: "close submission expired before the account disappeared",
    };
  }

  try {
    const returned = await slrd.senders
      .resolve(pending.submission.sender)
      .send({
        connection: slrd.connection(),
        transaction: pending.submission.plan.transaction,
        options: { skipPreflight: true },
      });
    if (returned !== pending.submission.signature) {
      throw new Error(
        `Close rebroadcast returned signature ${returned}, expected ${pending.submission.signature}`,
      );
    }
  } catch (error) {
    if (!(await tokenAccountExistsConfirmed(slrd, action.tokenAccount))) {
      return { state: "closed", receipt };
    }
    const message = errorMessage(error);
    if (isExpiredSubmissionError(message)) {
      return {
        state: "pending",
        pending: null,
        harvest: pending.harvest,
        reason: message,
      };
    }
    if (!isAccountGoneError(message)) throw error;
  }

  return {
    state: "pending",
    pending,
    harvest: pending.harvest,
    reason:
      "close submission is still unconfirmed; the same signed transaction was rebroadcast",
  };
}

async function closeEmptyAccountRobust(
  slrd: Solard,
  action: RegistryTokenLiquidationAction,
  via: SenderId,
  args: {
    pending?: PendingCloseSubmission;
    harvest: boolean;
    currentBlockHeight: number | null;
    priorityMicroLamports: number;
    index: number;
    total: number;
  },
): Promise<CloseEmptyAccountOutcome> {
  if (!action.tokenAccount || !action.tokenProgram)
    throw new Error("Missing zero-balance token-account metadata");

  const current = await currentClosableAccount(slrd, action);
  if (current === null) {
    return { state: "closed", receipt: args.pending?.receipt };
  }
  if (current === undefined) {
    return {
      state: "pending",
      pending: args.pending ?? null,
      harvest: args.harvest,
      reason:
        "wallet token-account scan no longer sees the account but confirmed state has not converged yet",
    };
  }

  if (args.pending) {
    return await reconcilePendingClose(
      slrd,
      action,
      args.pending,
      args.currentBlockHeight,
    );
  }

  const submit = async (
    harvest: boolean,
  ): Promise<CloseEmptyAccountOutcome> => {
    const composer = slrd.tx(action.walletAddress).priorityFee({
      cuLimit: 50_000,
      microLamports: args.priorityMicroLamports,
    });
    if (harvest) {
      composer.add(
        createHarvestWithheldTokensToMintInstruction(
          new PublicKey(action.mint),
          [new PublicKey(action.tokenAccount!)],
          TOKEN_2022_PROGRAM_ID,
        ),
        { kind: "harvest-withheld-fees", mint: new PublicKey(action.mint) },
      );
    }
    composer.closeTokenAccountAddress(
      action.tokenAccount!,
      current.tokenProgram ?? action.tokenProgram!,
    );
    try {
      const submission = await slrd.submitPlan(
        await composer.build(),
        via,
        harvest
          ? "registry-token-liquidation:harvest-close-empty"
          : "registry-token-liquidation:close-empty",
        { skipSimulation: false, skipPreflight: false },
      );
      const receipt = broadcastReceipt(submission);
      if (!(await tokenAccountExistsConfirmed(slrd, action.tokenAccount!))) {
        return { state: "closed", receipt };
      }
      return {
        state: "pending",
        pending: {
          action,
          submission,
          receipt,
          harvest,
          index: args.index,
          total: args.total,
        },
        harvest,
        reason:
          "close submitted; waiting for the exact token account to disappear",
      };
    } catch (error) {
      const message = errorMessage(error);
      if (isAccountGoneError(message)) {
        if (!(await tokenAccountExistsConfirmed(slrd, action.tokenAccount!))) {
          return { state: "closed" };
        }
        return {
          state: "pending",
          pending: null,
          harvest,
          reason: message,
        };
      }
      if (
        !harvest &&
        current.tokenProgram === TOKEN_2022_PROGRAM_ID.toBase58() &&
        isWithheldFeeCloseError(message)
      ) {
        return await submit(true);
      }
      throw error;
    }
  };

  return await submit(args.harvest);
}

function isPublicKey(value: string): boolean {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Policy-facing token resolution is intentionally a little friendlier than
 * TokenRepo.resolve(). "slrd" is accepted as shorthand for the registered
 * SOLARD token symbol, while raw mint addresses always work.
 */
export function resolveTokenMintForPolicy(slrd: Solard, ref: string): string {
  const value = ref.trim().replace(/^\$/, "");
  if (!value) throw new Error("Token reference is required.");

  if (isPublicKey(value)) return new PublicKey(value).toBase58();

  try {
    return slrd.resolveToken(value).mint;
  } catch {
    // Continue with case-insensitive/read-only fallback below.
  }

  const lowered = value.toLowerCase();
  const aliases =
    lowered === "slrd" ? new Set(["slrd", "solard"]) : new Set([lowered]);

  const match = slrd.tokens.list().find((row) => {
    const name = String(row.name ?? "")
      .replace(/^\$/, "")
      .toLowerCase();
    const symbol = String(row.symbol ?? "")
      .replace(/^\$/, "")
      .toLowerCase();
    return aliases.has(name) || aliases.has(symbol);
  });

  if (match) return match.mint;

  throw new Error(
    `Unknown token policy reference "${ref}". Use a registered token name/symbol or raw mint address.`,
  );
}

function aggregateHoldings(
  holdings: WalletTokenHolding[],
): WalletTokenHolding[] {
  const byMint = new Map<string, WalletTokenHolding>();
  for (const holding of holdings) {
    if (holding.amountRaw <= 0n) continue;
    const existing = byMint.get(holding.mint);
    if (existing) {
      existing.amountRaw += holding.amountRaw;
      // amountUi is presentation only; recompute below.
      existing.amountUi = formatRaw(existing.amountRaw, existing.decimals);
    } else {
      byMint.set(holding.mint, { ...holding });
    }
  }
  return [...byMint.values()];
}

function formatRaw(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const unit = 10n ** BigInt(decimals);
  const whole = raw / unit;
  const fraction = (raw % unit)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

function ephemeralToken(
  holding: WalletTokenHolding,
  inspected: Partial<TokenRow> | null,
): TokenRow {
  return {
    mint: holding.mint,
    decimals: holding.decimals,
    baseTokenProgram: holding.programId,
    ...(inspected ?? {}),
  } as TokenRow;
}

function emptyAccountAction(args: {
  walletName: string;
  walletAddress: string;
  account: Awaited<ReturnType<Solard["tokenAccounts"]>>[number];
  token?: TokenRow | null;
}): RegistryTokenLiquidationAction {
  return {
    kind: "close-empty",
    walletName: args.walletName,
    walletAddress: args.walletAddress,
    mint: args.account.mint,
    name: args.token?.name ?? null,
    symbol: args.token?.symbol ?? null,
    decimals: args.account.decimals,
    amountRaw: 0n,
    amountUi: "0",
    tokenAccount: args.account.address,
    tokenProgram: args.account.tokenProgram,
    rentLamports: args.account.lamports,
  };
}

async function discoverEmptyTokenAccountActions(
  slrd: Solard,
  walletRows: Array<{ walletName: string; walletAddress: string }>,
  protectedMints: ReadonlySet<string>,
): Promise<RegistryTokenLiquidationAction[]> {
  const out: RegistryTokenLiquidationAction[] = [];
  const tokenByMint = new Map(
    slrd.tokens.list().map((token) => [token.mint, token] as const),
  );
  for (const row of walletRows) {
    const accounts = await slrd.tokenAccounts(row.walletAddress);
    for (const account of accounts) {
      if (account.amountRaw !== 0n) continue;
      if (protectedMints.has(account.mint)) continue;
      // The wallet must be able to authorize account closure. A different explicit
      // close authority is intentionally left alone.
      if (
        account.closeAuthority &&
        account.closeAuthority !== row.walletAddress
      )
        continue;
      out.push(
        emptyAccountAction({
          walletName: row.walletName,
          walletAddress: row.walletAddress,
          account,
          token: tokenByMint.get(account.mint) ?? null,
        }),
      );
    }
  }
  return out;
}

export async function planRegistryTokenLiquidation(
  slrd: Solard,
  options: RegistryTokenLiquidationOptions = {},
): Promise<RegistryTokenLiquidationPlan> {
  const protectedMints = new Set(
    (options.except ?? []).map((ref) => resolveTokenMintForPolicy(slrd, ref)),
  );

  options.onProgress?.({ stage: "portfolio-start" });
  const portfolio = await loadWalletAssetPortfolio(slrd, {
    walletRefs: options.walletRefs,
    excludeWalletRefs: options.exceptWalletRefs,
    concurrency: options.portfolioConcurrency ?? 1,
    requestDelayMs: options.portfolioDelayMs ?? 100,
  });
  options.onProgress?.({
    stage: "portfolio-done",
    wallets: portfolio.rows.length,
    holdings: portfolio.tokenHoldingCount,
    distinctMints: portfolio.distinctTokenCount,
  });

  const routeDelayMs = Math.max(0, options.routeDelayMs ?? 100);
  const mintRoutes = new Map<
    string,
    {
      token?: TokenRow;
      venue?: string;
      jupiterQuote?: JupiterSwapQuote;
      error?: string;
    }
  >();

  // Resolve each distinct non-protected/non-WSOL mint once. This is read-only:
  // no TokenRepo upserts, so liquidation planning does not rewrite metadata.
  const routeCandidates = new Map<string, WalletTokenHolding>();
  for (const row of portfolio.rows) {
    for (const holding of aggregateHoldings(row.tokenHoldings)) {
      if (
        protectedMints.has(holding.mint) ||
        holding.mint === NATIVE_MINT.toBase58()
      ) {
        continue;
      }
      const existing = routeCandidates.get(holding.mint);
      if (!existing || holding.amountRaw > existing.amountRaw) {
        routeCandidates.set(holding.mint, holding);
      }
    }
  }

  let routeIndex = 0;
  for (const holding of routeCandidates.values()) {
    routeIndex += 1;
    options.onProgress?.({
      stage: "route",
      index: routeIndex,
      total: routeCandidates.size,
      mint: holding.mint,
    });
    let nativeError: string | null = null;
    try {
      const mint = new PublicKey(holding.mint);
      const inspected = await slrd.venues.inspect(slrd.connection(), mint);
      const token = ephemeralToken(holding, inspected);
      const routed = await slrd.route(token, PublicKey.default);
      mintRoutes.set(holding.mint, {
        token,
        venue: String(routed.market.venue),
      });
    } catch (error) {
      nativeError = error instanceof Error ? error.message : String(error);
    }

    if (!mintRoutes.has(holding.mint) && options.jupiterFallback !== false) {
      try {
        const jupiterQuote = await quoteJupiterTokenToSol({
          inputMint: holding.mint,
          amountRaw: holding.amountRaw,
        });
        mintRoutes.set(holding.mint, {
          venue: `jupiter:${jupiterQuote.router ?? "auto"}`,
          jupiterQuote,
        });
      } catch (error) {
        const jupiterError =
          error instanceof Error ? error.message : String(error);
        mintRoutes.set(holding.mint, {
          error: nativeError
            ? `${nativeError}; Jupiter: ${jupiterError}`
            : `Jupiter: ${jupiterError}`,
        });
      }
    } else if (!mintRoutes.has(holding.mint)) {
      mintRoutes.set(holding.mint, {
        error: nativeError ?? "No supported Solard trading venue",
      });
    }
    await pause(routeDelayMs);
  }

  const actions: RegistryTokenLiquidationAction[] = [];
  for (const row of portfolio.rows) {
    for (const holding of aggregateHoldings(row.tokenHoldings)) {
      const common = {
        walletName: row.walletName,
        walletAddress: row.walletAddress,
        mint: holding.mint,
        name: holding.name,
        symbol: holding.symbol,
        decimals: holding.decimals,
        amountRaw: holding.amountRaw,
        amountUi: holding.amountUi,
      };

      if (protectedMints.has(holding.mint)) {
        actions.push({ ...common, kind: "keep-protected" });
        continue;
      }

      if (holding.mint === NATIVE_MINT.toBase58()) {
        actions.push({
          ...common,
          kind: "unwrap-wsol",
          name: "Wrapped SOL",
          symbol: "WSOL",
        });
        continue;
      }

      const route = mintRoutes.get(holding.mint);
      if (route?.token && route.venue) {
        actions.push({
          ...common,
          kind: "sell",
          token: route.token,
          venue: route.venue,
        });
      } else if (route?.jupiterQuote) {
        actions.push({
          ...common,
          kind: "jupiter-sell",
          venue: route.venue ?? "jupiter",
          jupiterQuote: route.jupiterQuote,
        });
      } else {
        actions.push({
          ...common,
          kind: "skip-unsupported",
          reason: route?.error ?? "No supported Solard trading venue",
        });
      }
    }
  }

  // Zero-balance token accounts require no route. Include them even when their
  // mint is unsupported so `slrd liquidate tokens` also reclaims dead-account rent.
  const existingEmptyAccounts = await discoverEmptyTokenAccountActions(
    slrd,
    portfolio.rows.map((row) => ({
      walletName: row.walletName,
      walletAddress: row.walletAddress,
    })),
    protectedMints,
  );
  const seenEmpty = new Set<string>();
  for (const action of existingEmptyAccounts) {
    if (!action.tokenAccount || seenEmpty.has(action.tokenAccount)) continue;
    seenEmpty.add(action.tokenAccount);
    actions.push(action);
  }

  const count = (kind: RegistryTokenLiquidationActionKind) =>
    actions.filter((action) => action.kind === kind).length;

  return {
    protectedMints: [...protectedMints],
    actions,
    totals: {
      wallets: portfolio.rows.length,
      sell: count("sell"),
      jupiterSell: count("jupiter-sell"),
      unwrapWsol: count("unwrap-wsol"),
      closeEmpty: count("close-empty"),
      keepProtected: count("keep-protected"),
      skipUnsupported: count("skip-unsupported"),
    },
  };
}

async function simulateAction(
  slrd: Solard,
  action: RegistryTokenLiquidationAction,
  options: RegistryTokenLiquidationOptions,
): Promise<RegistryTokenLiquidationResult> {
  try {
    if (action.kind === "sell") {
      if (!action.token) throw new Error("Missing routed token metadata");
      const plan = await slrd
        .tx(action.walletAddress)
        .sell(action.token, {
          bps: 10_000,
          slippageBps: options.slippageBps ?? 1_500,
        })
        .build();
      return { action, simulation: await slrd.simulatePlan(plan) };
    }

    if (action.kind === "jupiter-sell") {
      const quote = await quoteJupiterTokenToSol({
        inputMint: action.mint,
        amountRaw: action.amountRaw,
      });
      return { action, jupiter: quote };
    }

    if (action.kind === "unwrap-wsol") {
      const plan = await slrd
        .tx(action.walletAddress)
        .unwrapWsol({ skipMissing: true })
        .build();
      return { action, simulation: await slrd.simulatePlan(plan) };
    }

    if (action.kind === "close-empty") {
      if (!action.tokenAccount || !action.tokenProgram)
        throw new Error("Missing zero-balance token-account metadata");
      // Re-read before even simulating. Planning data may already be stale.
      const current = (await slrd.tokenAccounts(action.walletAddress)).find(
        (account) => account.address === action.tokenAccount,
      );
      if (!current) return { action };
      if (current.amountRaw !== 0n)
        throw new Error(
          `Refusing to close non-empty token account ${action.tokenAccount}`,
        );
      const plan = await slrd
        .tx(action.walletAddress)
        .closeTokenAccountAddress(action.tokenAccount, action.tokenProgram)
        .build();
      return { action, simulation: await slrd.simulatePlan(plan) };
    }

    return { action };
  } catch (error) {
    return {
      action,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function executionProtectedMints(
  slrd: Solard,
  plan: RegistryTokenLiquidationPlan,
  options: RegistryTokenLiquidationOptions,
): Set<string> {
  const protectedMints = new Set(plan.protectedMints);
  for (const ref of options.except ?? []) {
    protectedMints.add(resolveTokenMintForPolicy(slrd, ref));
  }
  return protectedMints;
}

function assertNoProtectedDestructiveActions(
  plan: RegistryTokenLiquidationPlan,
  protectedMints: ReadonlySet<string>,
  burnUnsellable: boolean,
): void {
  const conflicts = plan.actions.filter((action) => {
    if (!protectedMints.has(action.mint)) return false;
    return (
      action.kind === "sell" ||
      action.kind === "jupiter-sell" ||
      action.kind === "unwrap-wsol" ||
      action.kind === "close-empty" ||
      (burnUnsellable && action.kind === "skip-unsupported")
    );
  });
  if (!conflicts.length) return;

  const detail = conflicts
    .slice(0, 8)
    .map(
      (action) =>
        `${action.kind}:${action.mint}@${action.walletName || action.walletAddress}`,
    )
    .join(", ");
  throw new Error(
    `Liquidation safety invariant violated: protected mint(s) appear in destructive action(s): ${detail}. Refusing all execution before broadcast. Rebuild the liquidation plan.`,
  );
}

export async function simulateRegistryTokenLiquidation(
  slrd: Solard,
  plan: RegistryTokenLiquidationPlan,
  options: RegistryTokenLiquidationOptions = {},
): Promise<RegistryTokenLiquidationResult[]> {
  const protectedMints = executionProtectedMints(slrd, plan, options);
  assertNoProtectedDestructiveActions(
    plan,
    protectedMints,
    options.burnUnsellable === true,
  );
  const out: RegistryTokenLiquidationResult[] = [];
  const delayMs = Math.max(0, options.delayMs ?? 150);

  const executable = plan.actions.filter(
    (action) =>
      action.kind === "sell" ||
      action.kind === "jupiter-sell" ||
      action.kind === "unwrap-wsol" ||
      action.kind === "close-empty",
  );
  for (let index = 0; index < executable.length; index += 1) {
    const action = executable[index]!;
    options.onProgress?.({
      stage: "action-start",
      index: index + 1,
      total: executable.length,
      action,
    });
    const result = await simulateAction(slrd, action, options);
    out.push(result);
    if (result.error) {
      options.onProgress?.({
        stage: "action-error",
        index: index + 1,
        total: executable.length,
        action,
        error: result.error,
      });
    } else {
      options.onProgress?.({
        stage: "action-done",
        index: index + 1,
        total: executable.length,
        action,
      });
    }
    await pause(delayMs);
  }
  return out;
}

export async function executeRegistryTokenLiquidation(
  slrd: Solard,
  plan: RegistryTokenLiquidationPlan,
  options: RegistryTokenLiquidationOptions = {},
): Promise<RegistryTokenLiquidationResult[]> {
  // Re-resolve --except at execution time and union it with the plan attestation.
  // A protected mint is a hard no-touch invariant, not merely a planning hint.
  const protectedMints = executionProtectedMints(slrd, plan, options);
  assertNoProtectedDestructiveActions(
    plan,
    protectedMints,
    options.burnUnsellable === true,
  );

  const out: RegistryTokenLiquidationResult[] = [];
  const delayMs = Math.max(0, options.delayMs ?? 250);
  const via = options.via ?? "rpc";

  // Phase 1 changes balances. Do not attempt account closure until every sell /
  // unwrap has finished, then derive cleanup candidates from fresh on-chain state.
  const primary = plan.actions.filter(
    (action) =>
      action.kind === "sell" ||
      action.kind === "jupiter-sell" ||
      action.kind === "unwrap-wsol" ||
      (options.burnUnsellable && action.kind === "skip-unsupported"),
  );

  for (let index = 0; index < primary.length; index += 1) {
    const action = primary[index]!;
    options.onProgress?.({
      stage: "action-start",
      index: index + 1,
      total: primary.length,
      action,
    });

    try {
      if (action.kind === "sell" || action.kind === "jupiter-sell") {
        let result: RegistryTokenLiquidationResult | null = null;
        let signature: string | null = null;
        let routeError: unknown = null;

        if (action.kind === "sell") {
          if (!action.token) throw new Error("Missing routed token metadata");
          try {
            const submitted = await slrd
              .tx(action.walletAddress)
              .sell(action.token, {
                bps: 10_000,
                slippageBps: options.slippageBps ?? 1_500,
              })
              .send({
                via,
                kind: "registry-token-liquidation",
                skipSimulation: false,
                skipPreflight: false,
              });
            const receipt = await settledSendReceipt(slrd, submitted);
            signature = receipt.signature;
            result = { action, receipt };
          } catch (error) {
            routeError = error;
            if (options.jupiterFallback !== false) {
              const amountRaw = await associatedSellableAmount(
                slrd,
                action.walletAddress,
                action.mint,
              );
              if (amountRaw > 0n) {
                try {
                  const jupiter = await executeJupiterTokenToSol({
                    inputMint: action.mint,
                    amountRaw,
                    signer: slrd.signer(action.walletAddress),
                  });
                  signature = jupiter.signature ?? null;
                  result = {
                    action: {
                      ...action,
                      kind: "jupiter-sell",
                      amountRaw,
                      amountUi: formatRaw(amountRaw, action.decimals),
                      venue: "jupiter:fallback",
                    },
                    jupiter,
                  };
                  routeError = null;
                } catch (jupiterError) {
                  routeError = new Error(
                    `Native sell failed: ${errorMessage(error)}; Jupiter fallback failed: ${errorMessage(jupiterError)}`,
                  );
                }
              }
            }
          }
        } else {
          const amountRaw = await associatedSellableAmount(
            slrd,
            action.walletAddress,
            action.mint,
          );
          if (amountRaw > 0n) {
            try {
              const jupiter = await executeJupiterTokenToSol({
                inputMint: action.mint,
                amountRaw,
                signer: slrd.signer(action.walletAddress),
              });
              signature = jupiter.signature ?? null;
              result = {
                action: {
                  ...action,
                  amountRaw,
                  amountUi: formatRaw(amountRaw, action.decimals),
                },
                jupiter,
              };
            } catch (error) {
              routeError = error;
            }
          }
        }

        let residual = await waitForMintLiquidationBalance({
          slrd,
          action,
          index: index + 1,
          total: primary.length,
          signature,
          onProgress: options.onProgress,
        });

        if (residual.totalRaw > 0n && options.burnUnsellable) {
          const receipts = await burnUnsellableMint(slrd, action, via);
          residual = await waitForMintLiquidationBalance({
            slrd,
            action,
            index: index + 1,
            total: primary.length,
            signature: receipts.at(-1)?.signature ?? signature,
            attempts: 6,
            onProgress: options.onProgress,
          });
          if (!result) {
            result = {
              action: {
                ...action,
                reason: `burned unsellable residual after route failure (${receipts.length} account(s))${routeError ? `: ${errorMessage(routeError)}` : ""}`,
              },
              receipt: receipts.at(-1),
            };
          }
        }

        if (residual.totalRaw > 0n) {
          const incomplete = incompleteLiquidationError(action, residual);
          if (routeError) {
            throw new Error(
              `${errorMessage(routeError)}; ${incomplete.message}`,
            );
          }
          throw incomplete;
        }

        if (!result) {
          result = routeError
            ? {
                action: {
                  ...action,
                  reason: `on-chain token balance reached zero despite route error: ${errorMessage(routeError)}`,
                },
              }
            : { action };
        }
        out.push(result);
      } else if (action.kind === "skip-unsupported") {
        if (!options.burnUnsellable)
          throw new Error(action.reason ?? "Unsupported token");
        const remaining = await liveMintAccounts(
          slrd,
          action.walletAddress,
          action.mint,
        );
        if (!remaining.length) {
          out.push({ action });
        } else {
          const receipts = await burnUnsellableMint(slrd, action, via);
          out.push({
            action: {
              ...action,
              reason: `burned unsupported unprotected balance from ${receipts.length} account(s): ${action.reason ?? "no route"}`,
            },
            receipt: receipts.at(-1),
          });
        }
      } else {
        const receipt = await slrd.unwrapWsol(action.walletAddress, {
          via,
          skipMissing: true,
          skipSimulation: false,
          skipPreflight: false,
        });
        out.push({ action, receipt });
      }

      options.onProgress?.({
        stage: "action-done",
        index: index + 1,
        total: primary.length,
        action,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      out.push({ action, error: message });
      options.onProgress?.({
        stage: "action-error",
        index: index + 1,
        total: primary.length,
        action,
        error: message,
      });
    }

    await pause(delayMs);
  }

  const walletRows = Array.from(
    new Map(
      plan.actions.map(
        (action) =>
          [
            action.walletAddress,
            {
              walletName: action.walletName,
              walletAddress: action.walletAddress,
            },
          ] as const,
      ),
    ).values(),
  );
  const cleanupAttempts = 6;
  const priorityMicroLamports = await cleanupPriorityMicroLamports(slrd);
  const pendingClose = new Map<string, PendingCloseSubmission>();
  const harvestClose = new Set<string>();
  const attemptedClose = new Map<
    string,
    { action: RegistryTokenLiquidationAction; index: number; total: number }
  >();
  const cleanupResults = new Map<string, RegistryTokenLiquidationResult>();
  const lastCloseError = new Map<string, string>();

  const recordClosed = (
    account: string,
    action: RegistryTokenLiquidationAction,
    index: number,
    total: number,
    receipt?: SendReceipt,
  ) => {
    if (cleanupResults.has(account)) return;
    cleanupResults.set(account, {
      action,
      ...(receipt ? { receipt } : {}),
    });
    pendingClose.delete(account);
    harvestClose.delete(account);
    lastCloseError.delete(account);
    options.onProgress?.({
      stage: "action-done",
      index,
      total,
      action,
    });
  };

  const reconcileMissingAttempts = async (
    cleanup: RegistryTokenLiquidationAction[],
  ) => {
    const live = new Set(
      cleanup
        .map((action) => action.tokenAccount)
        .filter((value): value is string => Boolean(value)),
    );
    for (const [account, previous] of attemptedClose) {
      if (cleanupResults.has(account) || live.has(account)) continue;
      if (await tokenAccountExistsConfirmed(slrd, account)) continue;
      recordClosed(
        account,
        previous.action,
        previous.index,
        previous.total,
        pendingClose.get(account)?.receipt,
      );
    }
  };

  for (let attempt = 1; attempt <= cleanupAttempts; attempt += 1) {
    const cleanup = await discoverEmptyTokenAccountActions(
      slrd,
      walletRows,
      protectedMints,
    );
    await reconcileMissingAttempts(cleanup);
    if (!cleanup.length) break;

    const currentBlockHeight = pendingClose.size
      ? await slrd
          .connection()
          .getBlockHeight("confirmed")
          .catch(() => null)
      : null;

    for (let index = 0; index < cleanup.length; index += 1) {
      const action = cleanup[index]!;
      const account = action.tokenAccount;
      if (!account || cleanupResults.has(account)) continue;
      attemptedClose.set(account, {
        action,
        index: index + 1,
        total: cleanup.length,
      });
      options.onProgress?.({
        stage: "action-start",
        index: index + 1,
        total: cleanup.length,
        action,
      });

      try {
        const outcome = await closeEmptyAccountRobust(slrd, action, via, {
          pending: pendingClose.get(account),
          harvest: harvestClose.has(account),
          currentBlockHeight,
          priorityMicroLamports,
          index: index + 1,
          total: cleanup.length,
        });
        if (outcome.state === "closed") {
          recordClosed(
            account,
            action,
            index + 1,
            cleanup.length,
            outcome.receipt,
          );
        } else {
          if (outcome.pending) pendingClose.set(account, outcome.pending);
          else pendingClose.delete(account);
          if (outcome.harvest) harvestClose.add(account);
          else harvestClose.delete(account);
          lastCloseError.delete(account);
          options.onProgress?.({
            stage: "action-pending",
            index: index + 1,
            total: cleanup.length,
            action,
            attempt,
            maxAttempts: cleanupAttempts,
            signature: outcome.pending?.submission.signature ?? null,
            reason: outcome.reason,
          });
        }
      } catch (error) {
        if (!(await tokenAccountExistsConfirmed(slrd, account))) {
          recordClosed(
            account,
            action,
            index + 1,
            cleanup.length,
            pendingClose.get(account)?.receipt,
          );
        } else {
          pendingClose.delete(account);
          const message = errorMessage(error);
          lastCloseError.set(account, message);
          if (
            action.tokenProgram === TOKEN_2022_PROGRAM_ID.toBase58() &&
            isWithheldFeeCloseError(message)
          ) {
            harvestClose.add(account);
          }
          if (attempt < cleanupAttempts) {
            options.onProgress?.({
              stage: "action-pending",
              index: index + 1,
              total: cleanup.length,
              action,
              attempt,
              maxAttempts: cleanupAttempts,
              signature: null,
              reason: message,
            });
          }
        }
      }
      await pause(delayMs);
    }

    if (attempt < cleanupAttempts) await pause(Math.max(100, delayMs));
  }

  const remainingCleanup = await discoverEmptyTokenAccountActions(
    slrd,
    walletRows,
    protectedMints,
  );
  await reconcileMissingAttempts(remainingCleanup);
  for (let index = 0; index < remainingCleanup.length; index += 1) {
    const action = remainingCleanup[index]!;
    const account = action.tokenAccount;
    if (!account || cleanupResults.has(account)) continue;
    if (!(await tokenAccountExistsConfirmed(slrd, account))) {
      recordClosed(account, action, index + 1, remainingCleanup.length);
      continue;
    }
    const pending = pendingClose.get(account);
    const message =
      lastCloseError.get(account) ??
      (pending
        ? `Cleanup did not converge for token account ${account}; submission ${pending.submission.signature} remains unresolved`
        : `Cleanup did not converge for token account ${account}; the account still exists after ${cleanupAttempts} fresh-state attempts`);
    cleanupResults.set(account, { action, error: message });
    options.onProgress?.({
      stage: "action-error",
      index: index + 1,
      total: remainingCleanup.length,
      action,
      error: message,
    });
  }

  out.push(...cleanupResults.values());

  return out;
}
