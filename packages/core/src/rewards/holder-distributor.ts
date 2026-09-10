import { createHash } from "node:crypto";
import { NATIVE_MINT } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import {
  snapshotTokenHolders,
  type TokenHolderSnapshot,
} from "../chain/holders.ts";
import { readMint, readTokenAmount } from "../chain/state.ts";
import { SOL_ASSET, type QuoteAsset } from "../core/amounts.ts";
import type { TokenRef, WalletRef } from "../core/refs.ts";
import type { Solard } from "../core/solard.ts";
import {
  packTransferMany,
  type PackedTransferPlan,
  type TransferManyAllocation,
} from "../tx/transfer-batch.ts";
import type { SendReceipt, SenderId } from "../tx/types.ts";

const STATE_PREFIX = "holder-reward-distribution:v1:";

export type HolderRewardAllocation = {
  id: string;
  owner: string;
  holderAmountRaw: string;
  rewardAmountRaw: string;
  paid: boolean;
};

export type HolderRewardPendingTransaction = {
  kind: "claim" | "distribution";
  signature: string;
  lastValidBlockHeight: number;
  allocationIds: string[];
  createdAtMs: number;
};

export type HolderRewardDistributionState = {
  version: 1;
  id: string;
  tokenMint: string;
  sourceWallet: string;
  rewardAsset: {
    kind: QuoteAsset["kind"];
    mint: string;
    tokenProgram: string;
    decimals: number;
  };
  status: "claiming" | "planned" | "distributing" | "complete";
  claimFirst: boolean;
  claimSignature: string | null;
  claimBeforeRaw: string | null;
  rewardAmountRaw: string | null;
  reserveRaw: string;
  snapshot: {
    slot: number;
    observedAtMs: number;
    holderCount: number;
    eligibleHolderCount: number;
    eligibleTotalRaw: string;
    excludedTotalRaw: string;
  } | null;
  allocations: HolderRewardAllocation[];
  pending: HolderRewardPendingTransaction | null;
  receipts: Array<{
    kind: "claim" | "distribution";
    signature: string;
    allocationIds: string[];
    slot: number | null;
    feeLamports: number | null;
    confirmedAtMs: number;
  }>;
  createdAtMs: number;
  updatedAtMs: number;
};

export type HolderRewardPlanOptions = {
  token: TokenRef;
  wallet: WalletRef;
  /** Explicit reward asset. Defaults to the token's quote mint. */
  rewardMint?: string | PublicKey;
  /** Amount to distribute when claimFirst=false. */
  amountRaw?: bigint;
  /** Inspect/claim Pump creator rewards first and distribute the actual wallet delta. */
  claimFirst?: boolean;
  reserveRaw?: bigint;
  excludeOwners?: Iterable<string | PublicKey>;
  minimumHolderRaw?: bigint;
  maxRecipientsPerTransaction?: number;
};

export type HolderRewardDistributionPlan = {
  version: 1;
  id: string;
  tokenMint: string;
  sourceWallet: string;
  claimFirst: boolean;
  rewardAsset: HolderRewardDistributionState["rewardAsset"];
  rewardAmountRaw: bigint;
  reserveRaw: bigint;
  snapshot: TokenHolderSnapshot;
  allocations: Array<{
    id: string;
    owner: string;
    holderAmountRaw: bigint;
    rewardAmountRaw: bigint;
  }>;
  undistributedRemainderRaw: bigint;
  transferPlan: PackedTransferPlan;
};

export type ExecuteHolderRewardDistributionOptions = HolderRewardPlanOptions & {
  /** Stable application/epoch id. Required for live idempotent execution. */
  id: string;
  via?: SenderId;
  skipSimulation?: boolean;
  skipPreflight?: boolean;
};

function stateKey(id: string): string {
  return `${STATE_PREFIX}${id}`;
}

function readState(
  slrd: Solard,
  id: string,
): HolderRewardDistributionState | null {
  const row = slrd.db.settings
    .select()
    .where({ key: stateKey(id) })
    .first() as { value?: string } | undefined;
  if (!row?.value) return null;
  const parsed = JSON.parse(row.value) as HolderRewardDistributionState;
  if (parsed.version !== 1 || parsed.id !== id)
    throw new Error(`Unsupported holder reward state for ${id}`);
  return parsed;
}

function writeState(
  slrd: Solard,
  state: HolderRewardDistributionState,
): HolderRewardDistributionState {
  state.updatedAtMs = Date.now();
  const value = JSON.stringify(state);
  const row = slrd.db.settings
    .select()
    .where({ key: stateKey(state.id) })
    .first() as { value?: string; updatedAtMs?: number } | undefined;
  if (row) {
    row.value = value;
    row.updatedAtMs = state.updatedAtMs;
  } else {
    slrd.db.settings.insert({
      key: stateKey(state.id),
      value,
      updatedAtMs: state.updatedAtMs,
    });
  }
  return state;
}

export function getHolderRewardDistributionState(
  slrd: Solard,
  id: string,
): HolderRewardDistributionState | null {
  return readState(slrd, id);
}

function assetState(
  asset: QuoteAsset,
): HolderRewardDistributionState["rewardAsset"] {
  return {
    kind: asset.kind,
    mint: asset.mint.toBase58(),
    tokenProgram: asset.tokenProgram.toBase58(),
    decimals: asset.decimals,
  };
}

function assetFromState(
  value: HolderRewardDistributionState["rewardAsset"],
): QuoteAsset {
  return value.kind === "native-sol"
    ? SOL_ASSET
    : {
        kind: "spl-token",
        mint: new PublicKey(value.mint),
        tokenProgram: new PublicKey(value.tokenProgram),
        decimals: value.decimals,
      };
}

async function resolveRewardAsset(
  slrd: Solard,
  tokenMint: string,
  rewardMint?: string | PublicKey,
): Promise<QuoteAsset> {
  const input =
    rewardMint ?? slrd.resolveToken(tokenMint).quoteMint ?? NATIVE_MINT;
  const raw =
    input instanceof PublicKey ? input.toBase58() : String(input).trim();
  if (!raw || raw.toUpperCase() === "SOL" || raw === NATIVE_MINT.toBase58())
    return SOL_ASSET;
  const mint = new PublicKey(raw);
  const info = await readMint(slrd.connection(), mint);
  return {
    kind: "spl-token",
    mint,
    tokenProgram: info.tokenProgram,
    decimals: info.decimals,
  };
}

async function assetBalance(
  slrd: Solard,
  owner: PublicKey,
  asset: QuoteAsset,
): Promise<bigint> {
  if (asset.kind === "native-sol")
    return BigInt(await slrd.connection().getBalance(owner, "confirmed"));
  return await readTokenAmount(
    slrd.connection(),
    owner,
    asset.mint,
    asset.tokenProgram,
  );
}

function planId(args: {
  tokenMint: string;
  sourceWallet: string;
  rewardMint: string;
  rewardAmountRaw: bigint;
  snapshotSlot: number;
}): string {
  return createHash("sha256")
    .update(
      [
        "holder-reward-v1",
        args.tokenMint,
        args.sourceWallet,
        args.rewardMint,
        args.rewardAmountRaw.toString(),
        String(args.snapshotSlot),
      ].join(":"),
    )
    .digest("hex")
    .slice(0, 24);
}

function allocationsFromSnapshot(
  snapshot: TokenHolderSnapshot,
  rewardAmountRaw: bigint,
): {
  allocations: HolderRewardDistributionPlan["allocations"];
  remainderRaw: bigint;
} {
  if (snapshot.eligibleTotalRaw <= 0n)
    throw new Error("Holder snapshot has no eligible token balance to reward");
  const allocations: HolderRewardDistributionPlan["allocations"] = [];
  let distributed = 0n;
  for (let index = 0; index < snapshot.holders.length; index += 1) {
    const holder = snapshot.holders[index]!;
    const reward =
      (rewardAmountRaw * holder.amountRaw) / snapshot.eligibleTotalRaw;
    if (reward <= 0n) continue;
    distributed += reward;
    allocations.push({
      id: `holder-${index + 1}`,
      owner: holder.owner,
      holderAmountRaw: holder.amountRaw,
      rewardAmountRaw: reward,
    });
  }
  if (!allocations.length)
    throw new Error(
      "Reward amount is too small to allocate at least one raw unit",
    );
  return { allocations, remainderRaw: rewardAmountRaw - distributed };
}

async function buildPlanFromAmount(args: {
  slrd: Solard;
  tokenMint: string;
  sourceWallet: string;
  rewardAsset: QuoteAsset;
  rewardAmountRaw: bigint;
  reserveRaw: bigint;
  excludeOwners?: Iterable<string | PublicKey>;
  minimumHolderRaw?: bigint;
  maxRecipientsPerTransaction?: number;
  id?: string;
}): Promise<HolderRewardDistributionPlan> {
  if (args.rewardAmountRaw <= 0n)
    throw new Error("Reward amount must be positive");
  const token = args.slrd.resolveToken(args.tokenMint);
  const snapshot = await snapshotTokenHolders(
    args.slrd.connection(),
    token.mint,
    {
      token,
      excludeOwners: args.excludeOwners,
      minimumRaw: args.minimumHolderRaw,
    },
  );
  const { allocations, remainderRaw } = allocationsFromSnapshot(
    snapshot,
    args.rewardAmountRaw,
  );
  const transferPlan = await packTransferMany({
    connection: args.slrd.connection(),
    payer: args.sourceWallet,
    asset: args.rewardAsset,
    allocations: allocations.map((row): TransferManyAllocation => ({
      id: row.id,
      recipient: row.owner,
      amountRaw: row.rewardAmountRaw,
    })),
    altAddresses: args.slrd.alts.list().map((row) => row.address),
    priorityMicroLamports: 0,
    maxRecipientsPerTransaction: args.maxRecipientsPerTransaction,
  });
  const id =
    args.id ??
    planId({
      tokenMint: token.mint,
      sourceWallet: args.sourceWallet,
      rewardMint: args.rewardAsset.mint.toBase58(),
      rewardAmountRaw: args.rewardAmountRaw,
      snapshotSlot: snapshot.slot,
    });
  return {
    version: 1,
    id,
    tokenMint: token.mint,
    sourceWallet: args.sourceWallet,
    claimFirst: false,
    rewardAsset: assetState(args.rewardAsset),
    rewardAmountRaw: args.rewardAmountRaw,
    reserveRaw: args.reserveRaw,
    snapshot,
    allocations,
    undistributedRemainderRaw: remainderRaw,
    transferPlan,
  };
}

/** Read-only plan. claimFirst uses the amount currently estimated as spendable by this wallet. */
export async function planHolderRewardDistribution(
  slrd: Solard,
  options: HolderRewardPlanOptions,
): Promise<HolderRewardDistributionPlan> {
  const token = slrd.resolveToken(options.token);
  const source = slrd.resolveWallet(options.wallet).address;
  const reserveRaw = options.reserveRaw ?? 0n;
  if (reserveRaw < 0n) throw new Error("reserveRaw cannot be negative");

  let rewardAsset: QuoteAsset;
  let rewardAmountRaw: bigint;
  if (options.claimFirst) {
    const claim = await slrd.resolveClaim(token, source);
    if (claim.spendableByUserRaw <= reserveRaw) {
      throw new Error(
        `Claim is not spendable by ${source.toBase58()} after reserve. ` +
          `The Pump beneficiary must be the distribution wallet (or use a Fairfun distributor PDA).`,
      );
    }
    rewardAsset = claim.quoteAsset;
    rewardAmountRaw = claim.spendableByUserRaw - reserveRaw;
  } else {
    rewardAsset = await resolveRewardAsset(
      slrd,
      token.mint,
      options.rewardMint,
    );
    if (options.amountRaw == null)
      throw new Error("amountRaw is required when claimFirst=false");
    if (options.amountRaw <= reserveRaw)
      throw new Error("Reward amount does not exceed reserveRaw");
    rewardAmountRaw = options.amountRaw - reserveRaw;
  }

  const plan = await buildPlanFromAmount({
    slrd,
    tokenMint: token.mint,
    sourceWallet: source.toBase58(),
    rewardAsset,
    rewardAmountRaw,
    reserveRaw,
    excludeOwners: options.excludeOwners,
    minimumHolderRaw: options.minimumHolderRaw,
    maxRecipientsPerTransaction: options.maxRecipientsPerTransaction,
  });
  return { ...plan, claimFirst: options.claimFirst === true };
}

function signedPlanSignature(plan: {
  transaction: { signatures: Uint8Array[] };
}): string {
  const bytes = plan.transaction.signatures[0];
  if (!bytes || bytes.every((value) => value === 0))
    throw new Error("Compiled transaction is missing the payer signature");
  return bs58.encode(bytes);
}

async function reconcileSignature(
  slrd: Solard,
  pending: HolderRewardPendingTransaction,
): Promise<"confirmed" | "failed" | "pending"> {
  const statuses = await slrd
    .connection()
    .getSignatureStatuses([pending.signature], {
      searchTransactionHistory: true,
    });
  const status = statuses.value[0];
  if (status?.err) return "failed";
  if (
    status?.confirmationStatus === "confirmed" ||
    status?.confirmationStatus === "finalized" ||
    status?.confirmations === null
  )
    return "confirmed";

  // A second proof path catches RPCs where signature-status history lags.
  const tx = await slrd.connection().getParsedTransaction(pending.signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (tx?.meta?.err) return "failed";
  if (tx?.meta) return "confirmed";
  return "pending";
}

function recordReceipt(
  state: HolderRewardDistributionState,
  pending: HolderRewardPendingTransaction,
  receipt: SendReceipt | null,
): void {
  state.receipts.push({
    kind: pending.kind,
    signature: pending.signature,
    allocationIds: [...pending.allocationIds],
    slot: receipt?.slot ?? null,
    feeLamports: receipt?.feeLamports ?? null,
    confirmedAtMs: Date.now(),
  });
}

async function initializeDistributionAfterClaim(args: {
  slrd: Solard;
  state: HolderRewardDistributionState;
  excludeOwners?: Iterable<string | PublicKey>;
  minimumHolderRaw?: bigint;
}): Promise<void> {
  const amountRaw = BigInt(args.state.rewardAmountRaw ?? "0");
  if (amountRaw <= 0n) {
    args.state.status = "complete";
    writeState(args.slrd, args.state);
    return;
  }
  const token = args.slrd.resolveToken(args.state.tokenMint);
  const snapshot = await snapshotTokenHolders(
    args.slrd.connection(),
    token.mint,
    {
      token,
      excludeOwners: args.excludeOwners,
      minimumRaw: args.minimumHolderRaw,
    },
  );
  const { allocations } = allocationsFromSnapshot(snapshot, amountRaw);
  args.state.snapshot = {
    slot: snapshot.slot,
    observedAtMs: snapshot.observedAtMs,
    holderCount: snapshot.holderCount,
    eligibleHolderCount: snapshot.eligibleHolderCount,
    eligibleTotalRaw: snapshot.eligibleTotalRaw.toString(),
    excludedTotalRaw: snapshot.excludedTotalRaw.toString(),
  };
  args.state.allocations = allocations.map((row) => ({
    id: row.id,
    owner: row.owner,
    holderAmountRaw: row.holderAmountRaw.toString(),
    rewardAmountRaw: row.rewardAmountRaw.toString(),
    paid: false,
  }));
  args.state.status = "planned";
  writeState(args.slrd, args.state);
}

/**
 * Idempotent claim -> snapshot -> batched distribution executor.
 *
 * A stable caller-supplied id is mandatory. Before every broadcast the signed
 * transaction signature and exact allocation ids are persisted. On restart we
 * reconcile that signature before any new payment can be built, preventing a
 * crash between landing and local bookkeeping from double-paying holders.
 */
export async function executeHolderRewardDistribution(
  slrd: Solard,
  options: ExecuteHolderRewardDistributionOptions,
): Promise<HolderRewardDistributionState> {
  const id = options.id.trim();
  if (!id) throw new Error("A stable distribution id is required");
  const token = slrd.resolveToken(options.token);
  const wallet = slrd.resolveWallet(options.wallet);
  const source = wallet.address;
  const reserveRaw = options.reserveRaw ?? 0n;
  if (reserveRaw < 0n) throw new Error("reserveRaw cannot be negative");

  let state = readState(slrd, id);
  if (state) {
    if (
      state.tokenMint !== token.mint ||
      state.sourceWallet !== source.toBase58()
    ) {
      throw new Error(
        `Distribution id ${id} already belongs to another token/source wallet`,
      );
    }
  } else if (options.claimFirst) {
    const claim = await slrd.resolveClaim(token, source);
    if (claim.spendableByUserRaw <= 0n) {
      throw new Error(
        `Pump claim output is not spendable by ${source.toBase58()}. ` +
          `Use the configured beneficiary as --wallet, or a Fairfun distributor PDA for unattended payouts.`,
      );
    }
    const beforeRaw = await assetBalance(slrd, source, claim.quoteAsset);
    state = writeState(slrd, {
      version: 1,
      id,
      tokenMint: token.mint,
      sourceWallet: source.toBase58(),
      rewardAsset: assetState(claim.quoteAsset),
      status: "claiming",
      claimFirst: true,
      claimSignature: null,
      claimBeforeRaw: beforeRaw.toString(),
      rewardAmountRaw: null,
      reserveRaw: reserveRaw.toString(),
      snapshot: null,
      allocations: [],
      pending: null,
      receipts: [],
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
  } else {
    const rewardAsset = await resolveRewardAsset(
      slrd,
      token.mint,
      options.rewardMint,
    );
    if (options.amountRaw == null || options.amountRaw <= reserveRaw)
      throw new Error("A positive amountRaw above reserveRaw is required");
    const amountRaw = options.amountRaw - reserveRaw;
    const balance = await assetBalance(slrd, source, rewardAsset);
    if (balance < amountRaw)
      throw new Error(
        `Reward wallet balance ${balance} is below requested distribution ${amountRaw}`,
      );
    const plan = await buildPlanFromAmount({
      slrd,
      tokenMint: token.mint,
      sourceWallet: source.toBase58(),
      rewardAsset,
      rewardAmountRaw: amountRaw,
      reserveRaw,
      excludeOwners: options.excludeOwners,
      minimumHolderRaw: options.minimumHolderRaw,
      maxRecipientsPerTransaction: options.maxRecipientsPerTransaction,
      id,
    });
    state = writeState(slrd, {
      version: 1,
      id,
      tokenMint: token.mint,
      sourceWallet: source.toBase58(),
      rewardAsset: plan.rewardAsset,
      status: "planned",
      claimFirst: false,
      claimSignature: null,
      claimBeforeRaw: null,
      rewardAmountRaw: plan.rewardAmountRaw.toString(),
      reserveRaw: reserveRaw.toString(),
      snapshot: {
        slot: plan.snapshot.slot,
        observedAtMs: plan.snapshot.observedAtMs,
        holderCount: plan.snapshot.holderCount,
        eligibleHolderCount: plan.snapshot.eligibleHolderCount,
        eligibleTotalRaw: plan.snapshot.eligibleTotalRaw.toString(),
        excludedTotalRaw: plan.snapshot.excludedTotalRaw.toString(),
      },
      allocations: plan.allocations.map((row) => ({
        id: row.id,
        owner: row.owner,
        holderAmountRaw: row.holderAmountRaw.toString(),
        rewardAmountRaw: row.rewardAmountRaw.toString(),
        paid: false,
      })),
      pending: null,
      receipts: [],
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
  }

  // Reconcile any transaction whose signature was persisted before a prior process exited.
  if (state.pending) {
    const outcome = await reconcileSignature(slrd, state.pending);
    if (outcome === "pending") {
      throw new Error(
        `Distribution ${id} is waiting for transaction ${state.pending.signature}; ` +
          "no new transfer will be submitted until its outcome is known.",
      );
    }
    if (outcome === "confirmed") {
      if (state.pending.kind === "claim") {
        state.claimSignature = state.pending.signature;
      } else {
        const paid = new Set(state.pending.allocationIds);
        for (const allocation of state.allocations)
          if (paid.has(allocation.id)) allocation.paid = true;
      }
      recordReceipt(state, state.pending, null);
    }
    // Failed on-chain transactions did not move reward funds and may be rebuilt.
    state.pending = null;
    writeState(slrd, state);
  }

  if (state.status === "claiming") {
    if (!state.claimSignature) {
      const claimTx = await slrd.tx(options.wallet).claimFees(token).build();
      const signature = signedPlanSignature(claimTx);
      state.pending = {
        kind: "claim",
        signature,
        lastValidBlockHeight: claimTx.lastValidBlockHeight,
        allocationIds: [],
        createdAtMs: Date.now(),
      };
      writeState(slrd, state);
      const receipt = await slrd.sendPlan(
        claimTx,
        options.via ?? "rpc",
        `holder-reward:${id}:claim`,
        {
          skipSimulation: options.skipSimulation,
          skipPreflight: options.skipPreflight,
        },
      );
      if (receipt.status !== "confirmed") {
        throw new Error(
          `Reward claim ${signature} did not confirm: ${receipt.error ?? receipt.status}`,
        );
      }
      state.claimSignature = signature;
      recordReceipt(state, state.pending, receipt);
      state.pending = null;
      writeState(slrd, state);
    }

    const rewardAsset = assetFromState(state.rewardAsset);
    const afterRaw = await assetBalance(slrd, source, rewardAsset);
    const beforeRaw = BigInt(state.claimBeforeRaw ?? "0");
    const delta = afterRaw - beforeRaw;
    const usable = delta - BigInt(state.reserveRaw);
    if (usable <= 0n) {
      throw new Error(
        `Claim ${state.claimSignature} confirmed but produced no distributable wallet delta after reserve`,
      );
    }
    state.rewardAmountRaw = usable.toString();
    await initializeDistributionAfterClaim({
      slrd,
      state,
      excludeOwners: options.excludeOwners,
      minimumHolderRaw: options.minimumHolderRaw,
    });
  }

  while (state.status !== "complete") {
    const remaining = state.allocations.filter((row) => !row.paid);
    if (!remaining.length) {
      state.status = "complete";
      writeState(slrd, state);
      break;
    }
    const rewardAsset = assetFromState(state.rewardAsset);
    const packed = await packTransferMany({
      connection: slrd.connection(),
      payer: source,
      asset: rewardAsset,
      allocations: remaining.map((row) => ({
        id: row.id,
        recipient: row.owner,
        amountRaw: BigInt(row.rewardAmountRaw),
      })),
      altAddresses: slrd.alts.list().map((row) => row.address),
      priorityMicroLamports: 0,
      maxRecipientsPerTransaction: options.maxRecipientsPerTransaction,
    });
    const next = packed.batches[0];
    if (!next)
      throw new Error("No transfer batch could be built for unpaid holders");
    const compiled = await slrd.compile(
      slrd.signer(options.wallet),
      next.draft,
    );
    const signature = signedPlanSignature(compiled);
    const allocationIds = next.allocations.map((row) => row.id);
    state.status = "distributing";
    state.pending = {
      kind: "distribution",
      signature,
      lastValidBlockHeight: compiled.lastValidBlockHeight,
      allocationIds,
      createdAtMs: Date.now(),
    };
    writeState(slrd, state);

    const receipt = await slrd.sendPlan(
      compiled,
      options.via ?? "rpc",
      `holder-reward:${id}:distribution`,
      {
        skipSimulation: options.skipSimulation,
        skipPreflight: options.skipPreflight,
      },
    );
    if (receipt.status !== "confirmed") {
      throw new Error(
        `Reward distribution transaction ${signature} did not confirm: ${receipt.error ?? receipt.status}`,
      );
    }
    const paid = new Set(allocationIds);
    for (const allocation of state.allocations)
      if (paid.has(allocation.id)) allocation.paid = true;
    recordReceipt(state, state.pending, receipt);
    state.pending = null;
    state.status = state.allocations.every((row) => row.paid)
      ? "complete"
      : "distributing";
    writeState(slrd, state);
  }

  return state;
}
