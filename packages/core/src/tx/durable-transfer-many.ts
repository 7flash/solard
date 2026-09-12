import { createHash } from "node:crypto";
import { Buffer } from "buffer";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

import { SOL_ASSET, type QuoteAsset } from "../core/amounts.ts";
import type { WalletRef } from "../core/refs.ts";
import type { Solard } from "../core/solard.ts";
import {
  packTransferMany,
  type TransferManyAllocation,
} from "./transfer-batch.ts";
import type { SendReceipt, SenderId } from "./types.ts";

const STATE_PREFIX = "durable-transfer-many:v1:";

export type DurableTransferManyAllocation = {
  id: string;
  recipient: string;
  amountRaw: string;
  paid: boolean;
};

export type DurableTransferManyPending = {
  signature: string;
  sender: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  allocationIds: string[];
  signedTransactionBase64: string;
  submissionAttempts: number;
  lastSubmittedAtMs: number | null;
  createdAtMs: number;
};

export type DurableTransferManyReceipt = {
  signature: string;
  sender: string;
  allocationIds: string[];
  slot: number | null;
  feeLamports: number | null;
  confirmedAtMs: number;
};

export type DurableTransferManyState = {
  version: 1;
  id: string;
  inputHash: string;
  sourceWallet: string;
  asset: {
    kind: QuoteAsset["kind"];
    mint: string;
    tokenProgram: string;
    decimals: number;
  };
  status: "planned" | "distributing" | "complete" | "uncertain";
  totalRaw: string;
  allocations: DurableTransferManyAllocation[];
  pending: DurableTransferManyPending | null;
  receipts: DurableTransferManyReceipt[];
  lastError: string | null;
  uncertainReason: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export type DurableTransferManyExecuteOptions = {
  /** Stable application id. Reusing the id with different economic allocations is rejected. */
  id: string;
  wallet: WalletRef;
  asset: QuoteAsset;
  allocations: TransferManyAllocation[];
  via?: SenderId;
  cuLimit?: number;
  priorityMicroLamports?: number;
  maxRecipientsPerTransaction?: number;
  skipSimulation?: boolean;
  skipPreflight?: boolean;
};

export type DurableTransferManyResumeOptions = {
  via?: SenderId;
  cuLimit?: number;
  priorityMicroLamports?: number;
  maxRecipientsPerTransaction?: number;
  skipSimulation?: boolean;
  skipPreflight?: boolean;
};

type ReconcileOutcome =
  | { kind: "confirmed"; receipt: SendReceipt | null }
  | { kind: "failed"; error: string | null }
  | { kind: "seen-pending" }
  | { kind: "not-found"; currentBlockHeight: number };

function cleanId(value: string): string {
  const id = value.trim();
  if (!id) throw new Error("A stable transfer-many id is required");
  if (id.length > 240)
    throw new Error("Transfer-many id exceeds 240 characters");
  return id;
}

function stateKey(id: string): string {
  return `${STATE_PREFIX}${cleanId(id)}`;
}

function writeState(
  slrd: Solard,
  state: DurableTransferManyState,
): DurableTransferManyState {
  state.updatedAtMs = Date.now();
  const key = stateKey(state.id);
  const value = JSON.stringify(state);
  const existing = slrd.db.settings.select().where({ key }).first() as
    { id?: number } | undefined;
  if (existing) {
    slrd.db.settings
      .update({ value, updatedAtMs: state.updatedAtMs })
      .where({ key })
      .exec();
  } else {
    slrd.db.settings.insert({ key, value, updatedAtMs: state.updatedAtMs });
  }
  return state;
}

export function getDurableTransferManyState(
  slrd: Solard,
  idInput: string,
): DurableTransferManyState | null {
  const id = cleanId(idInput);
  const row = slrd.db.settings
    .select()
    .where({ key: stateKey(id) })
    .first() as { value?: string } | undefined;
  if (!row?.value) return null;
  const parsed = JSON.parse(row.value) as Omit<
    DurableTransferManyState,
    "pending"
  > & {
    pending:
      | (Omit<
          DurableTransferManyPending,
          "submissionAttempts" | "lastSubmittedAtMs"
        > & {
          submissionAttempts?: number;
          lastSubmittedAtMs?: number | null;
          broadcastAttempts?: number;
          lastBroadcastAtMs?: number | null;
        })
      | null;
  };
  if (parsed.version !== 1 || parsed.id !== id)
    throw new Error(`Unsupported durable transfer-many state for ${id}`);
  if (parsed.pending) {
    const pending = parsed.pending;
    if (!Number.isFinite(pending.submissionAttempts))
      pending.submissionAttempts = pending.broadcastAttempts ?? 0;
    if (!("lastSubmittedAtMs" in pending))
      pending.lastSubmittedAtMs = pending.lastBroadcastAtMs ?? null;
    delete pending.broadcastAttempts;
    delete pending.lastBroadcastAtMs;
  }
  return parsed as unknown as DurableTransferManyState;
}

function assetState(asset: QuoteAsset): DurableTransferManyState["asset"] {
  return {
    kind: asset.kind,
    mint: asset.mint.toBase58(),
    tokenProgram: asset.tokenProgram.toBase58(),
    decimals: asset.decimals,
  };
}

function assetFromState(value: DurableTransferManyState["asset"]): QuoteAsset {
  if (value.kind === "native-sol") return SOL_ASSET;
  return {
    kind: "spl-token",
    mint: new PublicKey(value.mint),
    tokenProgram: new PublicKey(value.tokenProgram),
    decimals: value.decimals,
  };
}

function normalizeAllocations(
  allocations: TransferManyAllocation[],
): DurableTransferManyAllocation[] {
  if (!allocations.length)
    throw new Error("At least one transfer allocation is required");
  const normalized = allocations.map((row, index) => {
    const id = row.id?.trim();
    if (!id) {
      throw new Error(
        `Durable transfer allocation ${index + 1} requires an explicit stable id`,
      );
    }
    const recipient =
      row.recipient instanceof PublicKey
        ? row.recipient.toBase58()
        : new PublicKey(row.recipient).toBase58();
    if (row.amountRaw <= 0n)
      throw new Error(`Transfer allocation ${id} amount must be positive`);
    return {
      id,
      recipient,
      amountRaw: row.amountRaw.toString(),
      paid: false,
    } satisfies DurableTransferManyAllocation;
  });

  const ids = new Set(normalized.map((row) => row.id));
  if (ids.size !== normalized.length)
    throw new Error("Durable transfer allocation ids must be unique");
  const recipients = new Set(normalized.map((row) => row.recipient));
  if (recipients.size !== normalized.length)
    throw new Error("Durable transfer recipients must be unique");

  // Stable ordering makes the intent hash and batching deterministic even if a
  // caller re-supplies the same allocations in a different array order.
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

function economicInputHash(args: {
  sourceWallet: string;
  asset: DurableTransferManyState["asset"];
  allocations: DurableTransferManyAllocation[];
}): string {
  const body = [
    "durable-transfer-many-v1",
    args.sourceWallet,
    args.asset.kind,
    args.asset.mint,
    args.asset.tokenProgram,
    String(args.asset.decimals),
    ...args.allocations.map(
      (row) => `${row.id}\t${row.recipient}\t${row.amountRaw}`,
    ),
  ].join("\n");
  return createHash("sha256").update(body).digest("hex");
}

function signedTransactionSignature(transaction: VersionedTransaction): string {
  const bytes = transaction.signatures[0];
  if (!bytes || bytes.every((value) => value === 0))
    throw new Error(
      "Compiled transfer transaction is missing the payer signature",
    );
  return bs58.encode(bytes);
}

function signedTransactionBase64(transaction: VersionedTransaction): string {
  return Buffer.from(transaction.serialize()).toString("base64");
}

function decodeSignedTransaction(base64: string): VersionedTransaction {
  return VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
}

function recordReceipt(
  state: DurableTransferManyState,
  pending: DurableTransferManyPending,
  receipt: SendReceipt | null,
): void {
  if (state.receipts.some((row) => row.signature === pending.signature)) return;
  state.receipts.push({
    signature: pending.signature,
    sender: pending.sender,
    allocationIds: [...pending.allocationIds],
    slot: receipt?.slot ?? null,
    feeLamports: receipt?.feeLamports ?? null,
    confirmedAtMs: Date.now(),
  });
}

function markPendingPaid(
  state: DurableTransferManyState,
  pending: DurableTransferManyPending,
): void {
  const paid = new Set(pending.allocationIds);
  for (const row of state.allocations) if (paid.has(row.id)) row.paid = true;
}

async function reconcilePending(
  slrd: Solard,
  pending: DurableTransferManyPending,
): Promise<ReconcileOutcome> {
  const statuses = await slrd
    .connection()
    .getSignatureStatuses([pending.signature], {
      searchTransactionHistory: true,
    });
  const status = statuses.value[0];
  if (status?.err) {
    return { kind: "failed", error: JSON.stringify(status.err) };
  }
  if (
    status?.confirmationStatus === "confirmed" ||
    status?.confirmationStatus === "finalized" ||
    status?.confirmations === null
  ) {
    const receipt = await slrd.confirmSignature(
      pending.signature,
      pending.sender,
    );
    return receipt.status === "failed"
      ? { kind: "failed", error: receipt.error ?? null }
      : { kind: "confirmed", receipt };
  }
  if (status) return { kind: "seen-pending" };

  // Independent history lookup catches RPCs whose signature-status index lags.
  const tx = await slrd.connection().getParsedTransaction(pending.signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (tx?.meta?.err)
    return { kind: "failed", error: JSON.stringify(tx.meta.err) };
  if (tx?.meta) return { kind: "confirmed", receipt: null };

  const currentBlockHeight = await slrd
    .connection()
    .getBlockHeight("confirmed");
  return { kind: "not-found", currentBlockHeight };
}

async function persistBeforeSubmission(args: {
  slrd: Solard;
  state: DurableTransferManyState;
  allocationIds: string[];
  compiled: Awaited<ReturnType<Solard["compile"]>>;
  sender: string;
}): Promise<DurableTransferManyPending> {
  const transaction = args.compiled.transaction;
  const signature = signedTransactionSignature(transaction);
  const pending: DurableTransferManyPending = {
    signature,
    sender: args.sender,
    recentBlockhash: args.compiled.recentBlockhash,
    lastValidBlockHeight: args.compiled.lastValidBlockHeight,
    allocationIds: [...args.allocationIds],
    signedTransactionBase64: signedTransactionBase64(transaction),
    submissionAttempts: 0,
    lastSubmittedAtMs: null,
    createdAtMs: Date.now(),
  };
  args.state.status = "distributing";
  args.state.pending = pending;
  args.state.lastError = null;
  args.state.uncertainReason = null;
  writeState(args.slrd, args.state);
  return pending;
}

async function submitPersistedTransaction(args: {
  slrd: Solard;
  state: DurableTransferManyState;
  pending: DurableTransferManyPending;
  via?: SenderId;
  skipPreflight?: boolean;
}): Promise<string> {
  const sender = String(args.via ?? args.pending.sender ?? "rpc");
  args.pending.sender = sender;
  args.pending.submissionAttempts += 1;
  args.pending.lastSubmittedAtMs = Date.now();
  args.state.lastError = null;
  // Persist the attempt marker before the network call as well. A process crash
  // can therefore never make a submission look like an unsent local batch.
  writeState(args.slrd, args.state);

  const transaction = decodeSignedTransaction(
    args.pending.signedTransactionBase64,
  );
  const returned = await args.slrd.senders.resolve(sender).send({
    connection: args.slrd.connection(),
    transaction,
    options: { skipPreflight: args.skipPreflight ?? true },
  });
  if (returned !== args.pending.signature) {
    args.state.status = "uncertain";
    args.state.uncertainReason = `Sender returned signature ${returned}, but persisted transaction signature is ${args.pending.signature}`;
    args.state.lastError = args.state.uncertainReason;
    writeState(args.slrd, args.state);
    throw new Error(args.state.uncertainReason);
  }
  return returned;
}

async function buildNextPending(args: {
  slrd: Solard;
  state: DurableTransferManyState;
  wallet: WalletRef;
  via: SenderId;
  cuLimit?: number;
  priorityMicroLamports?: number;
  maxRecipientsPerTransaction?: number;
  skipSimulation?: boolean;
}): Promise<DurableTransferManyPending | null> {
  const remaining = args.state.allocations.filter((row) => !row.paid);
  if (!remaining.length) return null;
  const asset = assetFromState(args.state.asset);
  const packed = await packTransferMany({
    connection: args.slrd.connection(),
    payer: args.state.sourceWallet,
    asset,
    allocations: remaining.map((row) => ({
      id: row.id,
      recipient: row.recipient,
      amountRaw: BigInt(row.amountRaw),
    })),
    altAddresses: args.slrd.alts.list().map((row) => row.address),
    cuLimit: args.cuLimit,
    priorityMicroLamports: args.priorityMicroLamports,
    maxRecipientsPerTransaction: args.maxRecipientsPerTransaction,
  });
  const next = packed.batches[0];
  if (!next)
    throw new Error("No transfer batch could be built for unpaid allocations");

  const compiled = await args.slrd.compile(
    args.slrd.signer(args.wallet),
    next.draft,
  );
  if (!args.skipSimulation) {
    const simulation = await args.slrd.simulatePlan(compiled);
    if (!simulation.success) {
      throw new Error(
        `Transfer-many simulation failed: ${JSON.stringify(simulation.error)}\n${simulation.logs.join("\n")}`,
      );
    }
  }

  return await persistBeforeSubmission({
    slrd: args.slrd,
    state: args.state,
    allocationIds: next.allocations.map((row) => row.id),
    compiled,
    sender: String(args.via),
  });
}

async function drive(args: {
  slrd: Solard;
  state: DurableTransferManyState;
  wallet: WalletRef;
  options: DurableTransferManyResumeOptions;
}): Promise<DurableTransferManyState> {
  const via = args.options.via ?? "rpc";

  // Only one signed batch may be unresolved at any moment. Reconcile it before
  // even constructing another transaction.
  if (args.state.pending) {
    const pending = args.state.pending;
    const outcome = await reconcilePending(args.slrd, pending);
    if (outcome.kind === "confirmed") {
      markPendingPaid(args.state, pending);
      recordReceipt(args.state, pending, outcome.receipt);
      args.state.pending = null;
      args.state.status = args.state.allocations.every((row) => row.paid)
        ? "complete"
        : "distributing";
      args.state.lastError = null;
      args.state.uncertainReason = null;
      writeState(args.slrd, args.state);
    } else if (outcome.kind === "failed") {
      // Definite on-chain failure is safe to rebuild later because the failed
      // transaction was atomic and moved none of these allocations.
      args.state.pending = null;
      args.state.status = "distributing";
      args.state.lastError =
        outcome.error ?? "Transfer transaction failed on-chain";
      args.state.uncertainReason = null;
      writeState(args.slrd, args.state);
      throw new Error(args.state.lastError);
    } else if (outcome.kind === "seen-pending") {
      args.state.status = "distributing";
      args.state.lastError = `Transaction ${pending.signature} is visible but not confirmed yet`;
      writeState(args.slrd, args.state);
      return args.state;
    } else if (outcome.currentBlockHeight > pending.lastValidBlockHeight) {
      // Do not construct a fresh payment transaction after an ambiguous expired
      // signature. That is precisely the double-pay case this state machine exists
      // to prevent. A later resume may still discover the historical transaction.
      args.state.status = "uncertain";
      args.state.uncertainReason =
        `Transaction ${pending.signature} was not found after blockhash expiry ` +
        `(current=${outcome.currentBlockHeight}, lastValid=${pending.lastValidBlockHeight}). ` +
        "No replacement payment will be built until this signature is proven confirmed or failed.";
      args.state.lastError = args.state.uncertainReason;
      writeState(args.slrd, args.state);
      return args.state;
    } else {
      // Not found but the exact signed transaction is still valid. Re-broadcasting
      // these exact bytes is safe: it has the same signature and cannot double-pay.
      try {
        await submitPersistedTransaction({
          slrd: args.slrd,
          state: args.state,
          pending,
          via,
          skipPreflight: args.options.skipPreflight,
        });
      } catch (error) {
        args.state.lastError =
          error instanceof Error ? error.message : String(error);
        writeState(args.slrd, args.state);
        return args.state;
      }
      const receipt = await args.slrd.confirmSignature(
        pending.signature,
        String(via),
      );
      if (receipt.status === "confirmed") {
        markPendingPaid(args.state, pending);
        recordReceipt(args.state, pending, receipt);
        args.state.pending = null;
        args.state.status = args.state.allocations.every((row) => row.paid)
          ? "complete"
          : "distributing";
        args.state.lastError = null;
        args.state.uncertainReason = null;
        writeState(args.slrd, args.state);
      } else if (receipt.status === "failed") {
        args.state.pending = null;
        args.state.status = "distributing";
        args.state.lastError =
          receipt.error ?? "Transfer transaction failed on-chain";
        writeState(args.slrd, args.state);
        throw new Error(args.state.lastError);
      } else {
        args.state.status = "distributing";
        args.state.lastError = `Transaction ${pending.signature} submitted but not yet confirmed`;
        writeState(args.slrd, args.state);
        return args.state;
      }
    }
  }

  if (args.state.status === "uncertain") {
    // Reaching this branch means the uncertain state has no pending signature,
    // which should never happen in v1. Fail closed instead of guessing.
    return args.state;
  }

  while (!args.state.allocations.every((row) => row.paid)) {
    const pending = await buildNextPending({
      slrd: args.slrd,
      state: args.state,
      wallet: args.wallet,
      via,
      cuLimit: args.options.cuLimit,
      priorityMicroLamports: args.options.priorityMicroLamports,
      maxRecipientsPerTransaction: args.options.maxRecipientsPerTransaction,
      skipSimulation: args.options.skipSimulation,
    });
    if (!pending) break;

    try {
      await submitPersistedTransaction({
        slrd: args.slrd,
        state: args.state,
        pending,
        via,
        skipPreflight: args.options.skipPreflight,
      });
    } catch (error) {
      args.state.lastError =
        error instanceof Error ? error.message : String(error);
      writeState(args.slrd, args.state);
      return args.state;
    }

    const receipt = await args.slrd.confirmSignature(
      pending.signature,
      String(via),
    );
    if (receipt.status === "confirmed") {
      markPendingPaid(args.state, pending);
      recordReceipt(args.state, pending, receipt);
      args.state.pending = null;
      args.state.status = args.state.allocations.every((row) => row.paid)
        ? "complete"
        : "distributing";
      args.state.lastError = null;
      args.state.uncertainReason = null;
      writeState(args.slrd, args.state);
      continue;
    }
    if (receipt.status === "failed") {
      args.state.pending = null;
      args.state.status = "distributing";
      args.state.lastError =
        receipt.error ?? "Transfer transaction failed on-chain";
      writeState(args.slrd, args.state);
      throw new Error(args.state.lastError);
    }

    // Confirmation timeout/ambiguity: keep the exact signed transaction pinned in
    // durable state and stop. A later resume reconciles or re-broadcasts the same
    // bytes; it never creates a replacement while this signature is unresolved.
    args.state.status = "distributing";
    args.state.lastError = `Transaction ${pending.signature} submitted but not yet confirmed`;
    writeState(args.slrd, args.state);
    return args.state;
  }

  args.state.status = "complete";
  args.state.pending = null;
  args.state.lastError = null;
  args.state.uncertainReason = null;
  return writeState(args.slrd, args.state);
}

/**
 * Execute arbitrary transfer allocations with crash-safe idempotency.
 *
 * Invariants:
 * - economic allocation ids/amounts are persisted before the first signature exists;
 * - each signed transaction + its exact allocation ids are persisted before submission;
 * - only one batch may be unresolved at a time;
 * - restart/retry reconciles that exact signature first;
 * - while still valid, only the exact same signed bytes may be resubmitted;
 * - after an ambiguous expiry the state becomes `uncertain` and no replacement is built.
 */
export async function executeDurableTransferMany(
  slrd: Solard,
  options: DurableTransferManyExecuteOptions,
): Promise<DurableTransferManyState> {
  const id = cleanId(options.id);
  const sourceWallet = slrd.resolveWallet(options.wallet).address.toBase58();
  const normalized = normalizeAllocations(options.allocations);
  const asset = assetState(options.asset);
  const inputHash = economicInputHash({
    sourceWallet,
    asset,
    allocations: normalized,
  });

  let state = getDurableTransferManyState(slrd, id);
  if (state) {
    if (state.inputHash !== inputHash) {
      throw new Error(
        `Transfer-many id ${id} already exists with different wallet/asset/allocations`,
      );
    }
  } else {
    // Validate packability before saving the durable intent, then persist the exact
    // economic allocation set before any transaction can be signed or broadcast.
    await packTransferMany({
      connection: slrd.connection(),
      payer: sourceWallet,
      asset: options.asset,
      allocations: normalized.map((row) => ({
        id: row.id,
        recipient: row.recipient,
        amountRaw: BigInt(row.amountRaw),
      })),
      altAddresses: slrd.alts.list().map((row) => row.address),
      cuLimit: options.cuLimit,
      priorityMicroLamports: options.priorityMicroLamports,
      maxRecipientsPerTransaction: options.maxRecipientsPerTransaction,
    });

    state = writeState(slrd, {
      version: 1,
      id,
      inputHash,
      sourceWallet,
      asset,
      status: "planned",
      totalRaw: normalized
        .reduce((sum, row) => sum + BigInt(row.amountRaw), 0n)
        .toString(),
      allocations: normalized,
      pending: null,
      receipts: [],
      lastError: null,
      uncertainReason: null,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
  }

  return await drive({
    slrd,
    state,
    wallet: options.wallet,
    options,
  });
}

/** Resume a persisted transfer-many distribution without re-supplying allocations. */
export async function resumeDurableTransferMany(
  slrd: Solard,
  idInput: string,
  options: DurableTransferManyResumeOptions = {},
): Promise<DurableTransferManyState> {
  const id = cleanId(idInput);
  const state = getDurableTransferManyState(slrd, id);
  if (!state) throw new Error(`Unknown transfer-many id: ${id}`);
  if (state.status === "complete") return state;

  // The source wallet address is itself a valid WalletRef for persisted Solard wallets.
  return await drive({ slrd, state, wallet: state.sourceWallet, options });
}

/** Convenience helper for clients that want a pure persisted-state status read. */
export function durableTransferManyStatus(
  slrd: Solard,
  id: string,
): DurableTransferManyState | null {
  return getDurableTransferManyState(slrd, id);
}
