import { ACCOUNT_SIZE } from "@solana/spl-token";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { rawAmount } from "../../core/amounts.ts";
import type { Solard } from "../../core/solard.ts";
import type {
  SenderId,
  SendReceipt,
  SimulationResult,
} from "../../tx/types.ts";
import { wrappedSolAta } from "../../tx/spl.ts";
import { PUMP_PROGRAM_ID } from "./constants.ts";
import { bondingCurvePda } from "./pda.ts";

export type PumpCleanupAction = "sell-close" | "close-only";

export type PumpCleanupCandidate = {
  walletName: string;
  walletAddress: string;
  tokenAccount: string;
  mint: string;
  amountRaw: bigint;
  decimals: number;
  tokenProgram: string;
  rentLamports: bigint;
  venue: "pump-curve" | "pumpswap";
  action: PumpCleanupAction;
  isAssociated: boolean;
};

export type PumpCleanupSkipped = {
  walletName: string;
  walletAddress: string;
  tokenAccount?: string;
  mint?: string;
  reason: string;
};

export type PumpCleanupPlan = {
  excludeGroup: string;
  excludePrefixes: string[];
  protectedMints: string[];
  excludedWallets: Array<{ name: string; address: string }>;
  scannedWallets: number;
  candidates: PumpCleanupCandidate[];
  skipped: PumpCleanupSkipped[];
  refundableRentLamports: bigint;
};

export type PumpCleanupPlanOptions = {
  excludeGroup: string;
  excludePrefixes?: string[];
  protectedMints?: string[];
  delayMs?: number;
};

export type PumpCleanupExecutionOptions = {
  via?: SenderId;
  slippageBps?: number;
  cuLimit?: number;
  priorityMicroLamports?: number;
  /**
   * Optional wallet used to top up low-SOL sellers just enough to create the
   * temporary WSOL ATA required by PumpSwap. No funding occurs unless needed.
   */
  fundingWallet?: string;
  skipSimulation?: boolean;
  skipPreflight?: boolean;
  delayMs?: number;
};

export type PumpCleanupResult = {
  plan: PumpCleanupPlan;
  receipts: Array<{
    candidate: PumpCleanupCandidate;
    fundedLamports?: bigint;
    fundingReceipt?: SendReceipt;
    receipt?: SendReceipt;
    error?: string;
  }>;
  feeLamports: number;
  reclaimedRentLamportsPlanned: bigint;
};

export type PumpCleanupSimulation = {
  plan: PumpCleanupPlan;
  results: Array<{
    candidate: PumpCleanupCandidate;
    simulation?: SimulationResult;
    error?: string;
  }>;
};

const PUMP_VENUES = new Set(["pump-curve", "pumpswap"]);

function looksLikePumpCurveAccount(
  account: AccountInfo<Buffer> | null,
): "pump" | "not-pump" | "malformed-pump" {
  if (!account) return "not-pump";
  if (!account.owner.equals(PUMP_PROGRAM_ID)) return "not-pump";
  // The current decoder needs at least the discriminator + reserve fields +
  // completion byte. A Pump-owned account at the bonding-curve PDA that is
  // shorter than this is not safe to classify silently.
  if (account.data.length < 49) return "malformed-pump";
  return "pump";
}

async function batchPumpMintProbe(
  slrd: Solard,
  mints: string[],
): Promise<Map<string, "pump" | "not-pump" | "malformed-pump">> {
  const result = new Map<string, "pump" | "not-pump" | "malformed-pump">();
  const chain = slrd.connection();

  for (let offset = 0; offset < mints.length; offset += 100) {
    const batch = mints.slice(offset, offset + 100);
    const pdas = batch.map((mint) => bondingCurvePda(new PublicKey(mint)));
    const accounts = await chain.getMultipleAccountsInfo(pdas, "confirmed");
    for (let index = 0; index < batch.length; index++) {
      result.set(
        batch[index]!,
        looksLikePumpCurveAccount(accounts[index] ?? null),
      );
    }
  }

  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pause(ms: number): Promise<void> {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a liquidation/rent-recovery plan from actual on-chain token accounts.
 * No transaction is built, signed, simulated or sent by this function.
 */
export async function planPumpCleanup(
  slrd: Solard,
  options: PumpCleanupPlanOptions,
): Promise<PumpCleanupPlan> {
  const delayMs = Math.max(0, options.delayMs ?? 150);
  const group = slrd.groups
    .list()
    .find((row) => row.name === options.excludeGroup);
  if (!group)
    throw new Error(
      `Excluded group does not exist: ${options.excludeGroup}. Refusing cleanup without the exclusion guard.`,
    );
  const groupMembers = slrd.groups.wallets(options.excludeGroup);
  if (!groupMembers.length)
    throw new Error(
      `Excluded group is empty: ${options.excludeGroup}. Refusing cleanup without verified excluded wallets.`,
    );

  const protectedMints = Array.from(new Set(options.protectedMints ?? []));
  const protectedSet = new Set(protectedMints);
  const prefixes = Array.from(
    new Set(
      (options.excludePrefixes ?? []).map((value) => value.toLowerCase()),
    ),
  );
  const excludedAddresses = new Set(
    groupMembers.map((row) => row.walletAddress),
  );
  const allWallets = slrd.wallets.list();
  for (const wallet of allWallets) {
    const name = wallet.name.toLowerCase();
    if (prefixes.some((prefix) => name.startsWith(prefix)))
      excludedAddresses.add(wallet.address);
  }

  const excludedWallets = allWallets
    .filter((wallet) => excludedAddresses.has(wallet.address))
    .map((wallet) => ({ name: wallet.name, address: wallet.address }));
  const wallets = allWallets.filter(
    (wallet) => !excludedAddresses.has(wallet.address),
  );

  const discovered: Array<{
    walletName: string;
    walletAddress: string;
    account: Awaited<ReturnType<Solard["tokenAccounts"]>>[number];
  }> = [];
  const skipped: PumpCleanupSkipped[] = [];

  for (const wallet of wallets) {
    try {
      const accounts = await slrd.tokenAccounts(wallet.address);
      for (const account of accounts) {
        if (protectedSet.has(account.mint)) {
          skipped.push({
            walletName: wallet.name,
            walletAddress: wallet.address,
            tokenAccount: account.address,
            mint: account.mint,
            reason: "protected-mint",
          });
          continue;
        }
        discovered.push({
          walletName: wallet.name,
          walletAddress: wallet.address,
          account,
        });
      }
    } catch (error) {
      skipped.push({
        walletName: wallet.name,
        walletAddress: wallet.address,
        reason: `token-account-scan-failed: ${errorMessage(error)}`,
      });
    }
    await pause(delayMs);
  }

  const mintClassification = new Map<
    string,
    { venue: "pump-curve" | "pumpswap" } | { error: string }
  >();
  const uniqueMints = Array.from(
    new Set(discovered.map((row) => row.account.mint)),
  );

  // First reuse venue information already stored in the canonical DB. This is
  // especially important for cleanup retries: we should not rediscover the
  // same Pump token with several RPC calls every time.
  const cachedByMint = new Map(
    slrd.tokens.list().map((token) => [token.mint, token] as const),
  );
  const needsProbe: string[] = [];
  for (const mint of uniqueMints) {
    const cached = cachedByMint.get(mint);
    if (cached && PUMP_VENUES.has(cached.venueHint)) {
      mintClassification.set(mint, {
        venue: cached.venueHint as "pump-curve" | "pumpswap",
      });
    } else {
      needsProbe.push(mint);
    }
  }

  // Probe bonding-curve PDAs in batches before calling addToken(). Every Pump
  // token retains its Pump bonding-curve PDA after graduation, while ordinary
  // SPL tokens should not be sent through the full Pump inspector at all.
  let probe = new Map<string, "pump" | "not-pump" | "malformed-pump">();
  if (needsProbe.length) {
    try {
      probe = await batchPumpMintProbe(slrd, needsProbe);
    } catch (error) {
      const message = errorMessage(error);
      for (const mint of needsProbe) {
        mintClassification.set(mint, {
          error: `pump-batch-probe-failed: ${message}`,
        });
      }
    }
  }

  for (const mint of needsProbe) {
    if (mintClassification.has(mint)) continue;
    const classification = probe.get(mint) ?? "not-pump";
    if (classification === "not-pump") {
      mintClassification.set(mint, { error: "not-pump-venue" });
      continue;
    }
    if (classification === "malformed-pump") {
      mintClassification.set(mint, {
        error:
          "pump-classification-failed: malformed Pump-owned bonding-curve account",
      });
      continue;
    }

    // Only confirmed Pump candidates pay the cost of mint/venue inspection.
    try {
      const token = await slrd.addToken(mint);
      if (PUMP_VENUES.has(token.venueHint)) {
        mintClassification.set(mint, {
          venue: token.venueHint as "pump-curve" | "pumpswap",
        });
      } else {
        mintClassification.set(mint, { error: "not-pump-venue" });
      }
    } catch (error) {
      mintClassification.set(mint, {
        error: `pump-classification-failed: ${errorMessage(error)}`,
      });
    }
    await pause(delayMs);
  }

  const candidates: PumpCleanupCandidate[] = [];
  for (const row of discovered) {
    const classification = mintClassification.get(row.account.mint);
    if (!classification || "error" in classification) {
      skipped.push({
        walletName: row.walletName,
        walletAddress: row.walletAddress,
        tokenAccount: row.account.address,
        mint: row.account.mint,
        reason:
          classification && "error" in classification
            ? classification.error
            : "not-pump-venue",
      });
      continue;
    }

    if (row.account.amountRaw > 0n && !row.account.isAssociated) {
      skipped.push({
        walletName: row.walletName,
        walletAddress: row.walletAddress,
        tokenAccount: row.account.address,
        mint: row.account.mint,
        reason: "non-associated-token-account-with-balance",
      });
      continue;
    }

    if (
      row.account.closeAuthority &&
      row.account.closeAuthority !== row.walletAddress
    ) {
      skipped.push({
        walletName: row.walletName,
        walletAddress: row.walletAddress,
        tokenAccount: row.account.address,
        mint: row.account.mint,
        reason: `different-close-authority:${row.account.closeAuthority}`,
      });
      continue;
    }

    candidates.push({
      walletName: row.walletName,
      walletAddress: row.walletAddress,
      tokenAccount: row.account.address,
      mint: row.account.mint,
      amountRaw: row.account.amountRaw,
      decimals: row.account.decimals,
      tokenProgram: row.account.tokenProgram,
      rentLamports: row.account.lamports,
      venue: classification.venue,
      action: row.account.amountRaw > 0n ? "sell-close" : "close-only",
      isAssociated: row.account.isAssociated,
    });
  }

  return {
    excludeGroup: options.excludeGroup,
    excludePrefixes: options.excludePrefixes ?? [],
    protectedMints,
    excludedWallets,
    scannedWallets: wallets.length,
    candidates,
    skipped,
    refundableRentLamports: candidates.reduce(
      (sum, item) => sum + item.rentLamports,
      0n,
    ),
  };
}

function cleanupComposer(
  slrd: Solard,
  candidate: PumpCleanupCandidate,
  options: PumpCleanupExecutionOptions,
) {
  const composer = slrd.tx(candidate.walletAddress);
  if (candidate.action === "sell-close") {
    composer.sell(candidate.mint, {
      bps: 10_000,
      slippageBps: options.slippageBps ?? 1_500,
    });

    // PumpSwap pays native-SOL markets into the user's WSOL ATA. Close it in
    // the same transaction so proceeds are unwrapped to native SOL and the
    // temporary ATA rent is immediately recovered.
    if (candidate.venue === "pumpswap") {
      composer.unwrapWsol();
    }
  }
  composer.closeTokenAccountAddress(
    candidate.tokenAccount,
    candidate.tokenProgram,
  );
  composer.priorityFee({
    cuLimit: options.cuLimit ?? 600_000,
    microLamports: options.priorityMicroLamports ?? 0,
  });
  return composer;
}

function orderedCandidates(plan: PumpCleanupPlan): PumpCleanupCandidate[] {
  const rank = (candidate: PumpCleanupCandidate): number => {
    if (candidate.action === "close-only") return 0;
    if (candidate.venue === "pump-curve") return 1;
    return 2; // PumpSwap last; it may need a WSOL ATA rent float.
  };
  return [...plan.candidates].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const byWallet = a.walletName.localeCompare(b.walletName);
    if (byWallet !== 0) return byWallet;
    return a.mint.localeCompare(b.mint);
  });
}

async function pumpSwapFundingShortfall(
  slrd: Solard,
  candidate: PumpCleanupCandidate,
): Promise<bigint> {
  if (candidate.action !== "sell-close" || candidate.venue !== "pumpswap")
    return 0n;

  const connection = slrd.connection();
  const owner = new PublicKey(candidate.walletAddress);
  const wsol = wrappedSolAta(owner);
  const existing = await connection.getAccountInfo(wsol, "confirmed");
  if (existing) return 0n;

  const [rent, balance] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, "confirmed"),
    connection.getBalance(owner, "confirmed"),
  ]);

  // Reserve a small amount for the transaction's base fee. Priority defaults
  // to zero for cleanup, so this is intentionally conservative without being
  // excessive.
  const required = BigInt(rent) + 10_000n;
  const available = BigInt(balance);
  return available >= required ? 0n : required - available;
}

async function fundPumpSwapShortfall(
  slrd: Solard,
  candidate: PumpCleanupCandidate,
  options: PumpCleanupExecutionOptions,
): Promise<{ fundedLamports?: bigint; fundingReceipt?: SendReceipt }> {
  const shortfall = await pumpSwapFundingShortfall(slrd, candidate);
  if (shortfall <= 0n) return {};

  const fundingWallet = options.fundingWallet;
  if (!fundingWallet) {
    throw new Error(
      `insufficient SOL for PumpSwap WSOL ATA: ${candidate.walletName} needs ${shortfall} additional lamports; rerun with --funding-wallet <wallet>`,
    );
  }

  const fundingAddress = slrd.resolveWallet(fundingWallet).address.toBase58();
  if (fundingAddress === candidate.walletAddress) {
    throw new Error(
      `Funding wallet ${fundingWallet} is the same as low-SOL wallet ${candidate.walletName}`,
    );
  }

  const fundingReceipt = await slrd
    .tx(fundingWallet)
    .transferSol(candidate.walletAddress, rawAmount(shortfall))
    .priorityFee({ cuLimit: 10_000, microLamports: 0 })
    .send({
      via: "rpc",
      kind: "pump-cleanup:rent-funding",
    });

  return { fundedLamports: shortfall, fundingReceipt };
}

export async function simulatePumpCleanup(
  slrd: Solard,
  plan: PumpCleanupPlan,
  options: PumpCleanupExecutionOptions = {},
): Promise<PumpCleanupSimulation> {
  const results: PumpCleanupSimulation["results"] = [];
  const delayMs = Math.max(0, options.delayMs ?? 150);
  for (const candidate of orderedCandidates(plan)) {
    try {
      const shortfall = await pumpSwapFundingShortfall(slrd, candidate);
      if (shortfall > 0n) {
        results.push({
          candidate,
          error: `simulation-needs-funding:${shortfall.toString()} lamports`,
        });
        await pause(delayMs);
        continue;
      }
      const simulation = await cleanupComposer(
        slrd,
        candidate,
        options,
      ).simulate();
      results.push({ candidate, simulation });
    } catch (error) {
      results.push({ candidate, error: errorMessage(error) });
    }
    await pause(delayMs);
  }
  return { plan, results };
}

/** Executes each sell+close atomically; failures are collected and do not broaden scope. */
export async function executePumpCleanup(
  slrd: Solard,
  plan: PumpCleanupPlan,
  options: PumpCleanupExecutionOptions = {},
): Promise<PumpCleanupResult> {
  const receipts: PumpCleanupResult["receipts"] = [];
  const delayMs = Math.max(0, options.delayMs ?? 150);
  let feeLamports = 0;
  for (const candidate of orderedCandidates(plan)) {
    try {
      const funding = await fundPumpSwapShortfall(slrd, candidate, options);
      if (funding.fundingReceipt)
        feeLamports += funding.fundingReceipt.feeLamports ?? 0;

      const receipt = await cleanupComposer(slrd, candidate, options).send({
        via: options.via ?? "rpc",
        kind: `pump-cleanup:${candidate.action}`,
        skipSimulation: options.skipSimulation,
        skipPreflight: options.skipPreflight,
      });
      feeLamports += receipt.feeLamports ?? 0;
      receipts.push({ candidate, ...funding, receipt });
    } catch (error) {
      receipts.push({ candidate, error: errorMessage(error) });
    }
    await pause(delayMs);
  }
  return {
    plan,
    receipts,
    feeLamports,
    reclaimedRentLamportsPlanned: plan.refundableRentLamports,
  };
}
