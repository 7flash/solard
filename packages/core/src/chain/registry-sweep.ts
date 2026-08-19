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
  for (let offset = 0; offset < candidates.length; offset += 100) {
    const batch = candidates.slice(offset, offset + 100);
    const infos = await slrd.connection().getMultipleAccountsInfo(
      batch.map((wallet) => new PublicKey(wallet.address)),
      "confirmed",
    );
    for (let index = 0; index < batch.length; index++) {
      balances.set(batch[index]!.address, BigInt(infos[index]?.lamports ?? 0));
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
      skippedReason: sendLamports > 0n ? undefined : "balance-too-low",
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
      const freshBalance = BigInt(
        await slrd
          .connection()
          .getBalance(new PublicKey(row.walletAddress), "confirmed"),
      );
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

export async function executeRegistrySolSweep(
  slrd: Solard,
  plan: RegistrySolSweepPlan,
  options: RegistrySolSweepOptions,
): Promise<RegistrySolSweepReceipt[]> {
  const destination = new PublicKey(plan.destination);
  const results: RegistrySolSweepReceipt[] = [];
  const delayMs = Math.max(0, options.delayMs ?? 100);
  for (const row of plan.rows) {
    if (row.sendLamports <= 0n || row.skippedReason) continue;
    try {
      // Refresh immediately before signing so concurrent cleanup/funding work
      // cannot make the planned transfer stale.
      const freshBalance = BigInt(
        await slrd
          .connection()
          .getBalance(new PublicKey(row.walletAddress), "confirmed"),
      );
      const built = await buildExactSweepPlan(
        slrd,
        row.walletAddress,
        destination,
        freshBalance,
        row.keepLamports,
      );
      const receipt = await slrd.sendPlan(
        built.plan,
        "rpc",
        "registry-sol-sweep",
        {
          skipSimulation: false,
          skipPreflight: false,
        },
      );
      results.push({
        row: {
          ...row,
          balanceLamports: freshBalance,
          feeLamports: built.feeLamports,
          sendLamports: built.sendLamports,
        },
        receipt,
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
