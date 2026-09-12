import { Buffer } from "buffer";
import { createHash } from "node:crypto";
import { NATIVE_MINT } from "@solana/spl-token";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

import { readMint, readTokenAmount } from "../chain/state.ts";
import { SOL_ASSET, type QuoteAsset } from "../core/amounts.ts";
import type { WalletRef } from "../core/refs.ts";
import type { Solard } from "../core/solard.ts";
import {
  packTransferMany,
  type TransferManyAllocation,
} from "../tx/transfer-batch.ts";
import type { SendReceipt, SenderId } from "../tx/types.ts";

const STATE_PREFIX = "cumulative-distribution:v1:";
const DEFAULT_CANDIDATES = 64;
const PENDING_POLL_MS = 1_000;

type RawIntegerInput = bigint | string;

export type CumulativeEntitlement = {
  recipient: string | PublicKey;
  entitledRaw: RawIntegerInput;
};

export type CumulativeDistributionInput = {
  id: string;
  from: WalletRef;
  asset: "SOL" | string | PublicKey;
  entitlements: CumulativeEntitlement[];
  reserveRaw?: bigint;
  maxRecipientsPerTransaction?: number;
};

export type CumulativeDistributionExecuteOptions =
  CumulativeDistributionInput & {
    via?: SenderId;
    skipSimulation?: boolean;
    skipPreflight?: boolean;
  };

export type CumulativeDistributionRecipient = {
  recipient: string;
  entitledRaw: string;
  confirmedPaidRaw: string;
};

export type CumulativeDistributionPending = {
  signature: string;
  sender: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  payments: Array<{ recipient: string; amountRaw: string }>;
  signedTransactionBase64: string;
  submissionAttempts: number;
  lastSubmittedAtMs: number | null;
  createdAtMs: number;
};

export type CumulativeDistributionState = {
  version: 1;
  id: string;
  sourceWallet: string;
  asset: {
    kind: QuoteAsset["kind"];
    mint: string;
    tokenProgram: string;
    decimals: number;
  };
  status:
    "ready" | "distributing" | "complete" | "funding-required" | "uncertain";
  recipients: CumulativeDistributionRecipient[];
  entitlementHash: string;
  pending: CumulativeDistributionPending | null;
  receipts: Array<{
    signature: string;
    sender: string;
    payments: Array<{ recipient: string; amountRaw: string }>;
    slot: number | null;
    feeLamports: number | null;
    confirmedAtMs: number;
  }>;
  reserveRaw: string;
  lastError: string | null;
  uncertainReason: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export type CumulativeDistributionPlan = {
  id: string;
  sourceWallet: string;
  asset: CumulativeDistributionState["asset"];
  totalEntitledRaw: bigint;
  totalConfirmedPaidRaw: bigint;
  totalOutstandingRaw: bigint;
  sourceBalanceRaw: bigint;
  availableRaw: bigint;
  reserveRaw: bigint;
  outstanding: Array<{
    recipient: string;
    entitledRaw: bigint;
    confirmedPaidRaw: bigint;
    outstandingRaw: bigint;
  }>;
  nextPayments: Array<{ id: string; recipient: string; amountRaw: bigint }>;
  pending: CumulativeDistributionPending | null;
};

type ReconcileOutcome =
  | { kind: "confirmed"; receipt: SendReceipt | null }
  | { kind: "failed"; error: string | null }
  | { kind: "seen-pending" }
  | { kind: "not-found"; currentBlockHeight: number };

function rawInteger(value: RawIntegerInput, label: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${label} cannot be negative`);
    return value;
  }
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be a raw integer`);
  return BigInt(text);
}

function distributionId(value: string): string {
  const id = value.trim();
  if (!id) throw new Error("distribution id is required");
  if (id.length > 200) throw new Error("distribution id is too long");
  return id;
}

function stateKey(id: string): string {
  return `${STATE_PREFIX}${id}`;
}

function readSetting(slrd: Solard, key: string): string | null {
  const row = slrd.db.settings.select().where({ key }).first() as
    { value?: string } | undefined;
  return row?.value ?? null;
}

function writeSetting(slrd: Solard, key: string, value: string): void {
  const now = Date.now();
  const row = slrd.db.settings.select().where({ key }).first() as
    { id?: number } | undefined;
  if (row)
    slrd.db.settings.update({ value, updatedAtMs: now }).where({ key }).exec();
  else slrd.db.settings.insert({ key, value, updatedAtMs: now });
}

function readState(
  slrd: Solard,
  id: string,
): CumulativeDistributionState | null {
  const raw = readSetting(slrd, stateKey(id));
  if (!raw) return null;
  const state = JSON.parse(raw) as CumulativeDistributionState;
  if (state.version !== 1 || state.id !== id)
    throw new Error(`Unsupported cumulative distribution state for ${id}`);
  return state;
}

function writeState(slrd: Solard, state: CumulativeDistributionState): void {
  state.updatedAtMs = Date.now();
  writeSetting(slrd, stateKey(state.id), JSON.stringify(state));
}

function assetState(asset: QuoteAsset): CumulativeDistributionState["asset"] {
  return {
    kind: asset.kind,
    mint: asset.mint.toBase58(),
    tokenProgram: asset.tokenProgram.toBase58(),
    decimals: asset.decimals,
  };
}

function assetFromState(
  value: CumulativeDistributionState["asset"],
): QuoteAsset {
  if (value.kind === "native-sol") return SOL_ASSET;
  return {
    kind: "spl-token",
    mint: new PublicKey(value.mint),
    tokenProgram: new PublicKey(value.tokenProgram),
    decimals: value.decimals,
  };
}

function sameAsset(
  left: CumulativeDistributionState["asset"],
  right: CumulativeDistributionState["asset"],
): boolean {
  return (
    left.kind === right.kind &&
    left.mint === right.mint &&
    left.tokenProgram === right.tokenProgram &&
    left.decimals === right.decimals
  );
}

async function resolveAsset(
  slrd: Solard,
  input: "SOL" | string | PublicKey,
): Promise<QuoteAsset> {
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

function normalizeEntitlements(input: readonly CumulativeEntitlement[]): {
  rows: Array<{ recipient: string; entitledRaw: bigint }>;
  hash: string;
} {
  if (!Array.isArray(input)) throw new Error("entitlements must be an array");
  const rows = input.map((row, index) => ({
    recipient:
      row.recipient instanceof PublicKey
        ? row.recipient.toBase58()
        : new PublicKey(String(row.recipient).trim()).toBase58(),
    entitledRaw: rawInteger(
      row.entitledRaw,
      `entitlements[${index}].entitledRaw`,
    ),
  }));
  rows.sort((a, b) => a.recipient.localeCompare(b.recipient));
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index - 1]!.recipient === rows[index]!.recipient)
      throw new Error(
        `duplicate entitlement recipient ${rows[index]!.recipient}`,
      );
  }
  const canonical = JSON.stringify(
    rows.map((row) => ({
      recipient: row.recipient,
      entitledRaw: row.entitledRaw.toString(),
    })),
  );
  return { rows, hash: createHash("sha256").update(canonical).digest("hex") };
}

function applyEntitlements(
  state: CumulativeDistributionState,
  entitlements: ReturnType<typeof normalizeEntitlements>,
): void {
  const existing = new Map(state.recipients.map((row) => [row.recipient, row]));
  const incoming = new Set(entitlements.rows.map((row) => row.recipient));
  const missing = state.recipients.filter(
    (row) => !incoming.has(row.recipient),
  );
  if (missing.length)
    throw new Error(
      `cumulative entitlements omitted existing recipients: ${missing.map((row) => row.recipient).join(", ")}`,
    );
  for (const input of entitlements.rows) {
    const row = existing.get(input.recipient);
    if (!row) {
      state.recipients.push({
        recipient: input.recipient,
        entitledRaw: input.entitledRaw.toString(),
        confirmedPaidRaw: "0",
      });
      continue;
    }
    const previous = BigInt(row.entitledRaw);
    if (input.entitledRaw < previous)
      throw new Error(
        `cumulative entitlement for ${input.recipient} cannot decrease from ${previous} to ${input.entitledRaw}`,
      );
    if (input.entitledRaw < BigInt(row.confirmedPaidRaw))
      throw new Error(
        `entitlement for ${input.recipient} cannot be below confirmed paid`,
      );
    row.entitledRaw = input.entitledRaw.toString();
  }
  state.recipients.sort((a, b) => a.recipient.localeCompare(b.recipient));
  state.entitlementHash = entitlements.hash;
  state.lastError = null;
  state.uncertainReason = null;
  refreshStatus(state);
}

function outstanding(
  state: CumulativeDistributionState,
): CumulativeDistributionPlan["outstanding"] {
  const rows = state.recipients
    .map((row) => {
      const entitledRaw = BigInt(row.entitledRaw);
      const confirmedPaidRaw = BigInt(row.confirmedPaidRaw);
      if (confirmedPaidRaw > entitledRaw)
        throw new Error(
          `distribution state corruption for ${row.recipient}: confirmed paid exceeds entitlement`,
        );
      return {
        recipient: row.recipient,
        entitledRaw,
        confirmedPaidRaw,
        outstandingRaw: entitledRaw - confirmedPaidRaw,
      };
    })
    .filter((row) => row.outstandingRaw > 0n);
  rows.sort((a, b) =>
    a.outstandingRaw === b.outstandingRaw
      ? a.recipient.localeCompare(b.recipient)
      : a.outstandingRaw > b.outstandingRaw
        ? -1
        : 1,
  );
  return rows;
}

function totals(state: CumulativeDistributionState) {
  const totalEntitledRaw = state.recipients.reduce(
    (sum, row) => sum + BigInt(row.entitledRaw),
    0n,
  );
  const totalConfirmedPaidRaw = state.recipients.reduce(
    (sum, row) => sum + BigInt(row.confirmedPaidRaw),
    0n,
  );
  return {
    totalEntitledRaw,
    totalConfirmedPaidRaw,
    totalOutstandingRaw: totalEntitledRaw - totalConfirmedPaidRaw,
  };
}

function refreshStatus(state: CumulativeDistributionState): void {
  if (state.status === "uncertain") return;
  if (state.pending) state.status = "distributing";
  else state.status = outstanding(state).length ? "ready" : "complete";
}

function paymentCandidates(
  rows: CumulativeDistributionPlan["outstanding"],
  availableRaw: bigint,
  limit: number,
): TransferManyAllocation[] {
  const allocations: TransferManyAllocation[] = [];
  let remaining = availableRaw;
  for (const row of rows) {
    if (remaining <= 0n || allocations.length >= limit) break;
    const amountRaw =
      row.outstandingRaw < remaining ? row.outstandingRaw : remaining;
    if (amountRaw <= 0n) continue;
    allocations.push({
      id: `${row.recipient}:${row.entitledRaw.toString()}`,
      recipient: row.recipient,
      amountRaw,
    });
    remaining -= amountRaw;
  }
  return allocations;
}

async function ensureState(args: {
  slrd: Solard;
  id: string;
  sourceWallet: string;
  asset: QuoteAsset;
  reserveRaw: bigint;
}): Promise<CumulativeDistributionState> {
  const existing = readState(args.slrd, args.id);
  const asset = assetState(args.asset);
  if (existing) {
    if (existing.sourceWallet !== args.sourceWallet)
      throw new Error(
        `distribution ${args.id} belongs to source wallet ${existing.sourceWallet}`,
      );
    if (!sameAsset(existing.asset, asset))
      throw new Error(
        `distribution ${args.id} already uses asset ${existing.asset.mint}`,
      );
    existing.reserveRaw = args.reserveRaw.toString();
    return existing;
  }
  const now = Date.now();
  return {
    version: 1,
    id: args.id,
    sourceWallet: args.sourceWallet,
    asset,
    status: "complete",
    recipients: [],
    entitlementHash: createHash("sha256").update("[]").digest("hex"),
    pending: null,
    receipts: [],
    reserveRaw: args.reserveRaw.toString(),
    lastError: null,
    uncertainReason: null,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

function signedPlanSignature(plan: {
  transaction: { signatures: Uint8Array[] };
}): string {
  const bytes = plan.transaction.signatures[0];
  if (!bytes || bytes.every((value) => value === 0))
    throw new Error("compiled transaction is missing the payer signature");
  return bs58.encode(bytes);
}

function signedTransactionBase64(transaction: VersionedTransaction): string {
  return Buffer.from(transaction.serialize()).toString("base64");
}

function decodeSignedTransaction(base64: string): VersionedTransaction {
  return VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
}

async function reconcileSignature(
  slrd: Solard,
  pending: CumulativeDistributionPending,
): Promise<ReconcileOutcome> {
  const statuses = await slrd
    .connection()
    .getSignatureStatuses([pending.signature], {
      searchTransactionHistory: true,
    });
  const status = statuses.value[0];
  if (status?.err) return { kind: "failed", error: JSON.stringify(status.err) };
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
  const tx = await slrd.connection().getParsedTransaction(pending.signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (tx?.meta?.err)
    return { kind: "failed", error: JSON.stringify(tx.meta.err) };
  if (tx?.meta) return { kind: "confirmed", receipt: null };
  return {
    kind: "not-found",
    currentBlockHeight: await slrd.connection().getBlockHeight("confirmed"),
  };
}

async function submitPersisted(args: {
  slrd: Solard;
  state: CumulativeDistributionState;
  pending: CumulativeDistributionPending;
  via?: SenderId;
  skipPreflight?: boolean;
}): Promise<void> {
  const sender = String(args.via ?? args.pending.sender ?? "rpc");
  args.pending.sender = sender;
  args.pending.submissionAttempts += 1;
  args.pending.lastSubmittedAtMs = Date.now();
  writeState(args.slrd, args.state);
  const signature = await args.slrd.senders.resolve(sender).send({
    connection: args.slrd.connection(),
    transaction: decodeSignedTransaction(args.pending.signedTransactionBase64),
    options: { skipPreflight: args.skipPreflight },
  });
  if (signature !== args.pending.signature) {
    args.state.status = "uncertain";
    args.state.uncertainReason = `sender returned signature ${signature}, expected persisted signature ${args.pending.signature}`;
    args.state.lastError = args.state.uncertainReason;
    writeState(args.slrd, args.state);
    throw new Error(args.state.uncertainReason);
  }
}

function applyConfirmed(
  state: CumulativeDistributionState,
  pending: CumulativeDistributionPending,
): void {
  const byRecipient = new Map(
    state.recipients.map((row) => [row.recipient, row]),
  );
  for (const payment of pending.payments) {
    const row = byRecipient.get(payment.recipient);
    if (!row)
      throw new Error(
        `distribution state has no recipient ${payment.recipient}`,
      );
    const next = BigInt(row.confirmedPaidRaw) + BigInt(payment.amountRaw);
    if (next > BigInt(row.entitledRaw))
      throw new Error(
        `confirmed payment exceeds entitlement for ${payment.recipient}`,
      );
    row.confirmedPaidRaw = next.toString();
  }
}

async function reconcilePending(args: {
  slrd: Solard;
  state: CumulativeDistributionState;
  via?: SenderId;
  skipPreflight?: boolean;
}): Promise<"confirmed" | "pending"> {
  const pending = args.state.pending;
  if (!pending) return "confirmed";
  const outcome = await reconcileSignature(args.slrd, pending);
  if (outcome.kind === "confirmed") {
    applyConfirmed(args.state, pending);
    args.state.receipts.push({
      signature: pending.signature,
      sender: pending.sender,
      payments: pending.payments.map((row) => ({ ...row })),
      slot: outcome.receipt?.slot ?? null,
      feeLamports: outcome.receipt?.feeLamports ?? null,
      confirmedAtMs: Date.now(),
    });
    args.state.pending = null;
    args.state.lastError = null;
    args.state.uncertainReason = null;
    refreshStatus(args.state);
    writeState(args.slrd, args.state);
    return "confirmed";
  }
  if (outcome.kind === "failed") {
    args.state.pending = null;
    args.state.status = "ready";
    args.state.lastError =
      outcome.error ?? "distribution transaction failed on-chain";
    args.state.uncertainReason = null;
    writeState(args.slrd, args.state);
    throw new Error(args.state.lastError);
  }
  if (outcome.kind === "not-found") {
    if (outcome.currentBlockHeight > pending.lastValidBlockHeight) {
      args.state.status = "uncertain";
      args.state.uncertainReason = `distribution transaction ${pending.signature} is unresolved after blockhash expiry; replacement is blocked until reconciled`;
      args.state.lastError = args.state.uncertainReason;
      writeState(args.slrd, args.state);
      throw new Error(args.state.uncertainReason);
    }
    if (
      pending.submissionAttempts === 0 ||
      pending.lastSubmittedAtMs == null ||
      Date.now() - pending.lastSubmittedAtMs >= PENDING_POLL_MS
    )
      await submitPersisted({ ...args, pending });
  }
  return "pending";
}

async function prepare(args: {
  slrd: Solard;
  input: CumulativeDistributionInput;
}): Promise<{
  state: CumulativeDistributionState;
  asset: QuoteAsset;
  source: PublicKey;
}> {
  const id = distributionId(args.input.id);
  const source = args.slrd.resolveWallet(args.input.from).address;
  const reserveRaw = args.input.reserveRaw ?? 0n;
  if (reserveRaw < 0n) throw new Error("reserveRaw cannot be negative");
  const asset = await resolveAsset(args.slrd, args.input.asset);
  const state = await ensureState({
    slrd: args.slrd,
    id,
    sourceWallet: source.toBase58(),
    asset,
    reserveRaw,
  });
  applyEntitlements(state, normalizeEntitlements(args.input.entitlements));
  writeState(args.slrd, state);
  return { state, asset, source };
}

export function getCumulativeDistributionState(
  slrd: Solard,
  idInput: string,
): CumulativeDistributionState | null {
  return readState(slrd, distributionId(idInput));
}

export async function planCumulativeDistribution(
  slrd: Solard,
  input: CumulativeDistributionInput,
): Promise<CumulativeDistributionPlan> {
  const { state, asset, source } = await prepare({ slrd, input });
  const sourceBalanceRaw = await assetBalance(slrd, source, asset);
  const reserveRaw = BigInt(state.reserveRaw);
  const availableRaw =
    sourceBalanceRaw > reserveRaw ? sourceBalanceRaw - reserveRaw : 0n;
  const pending = state.pending;
  const rows = outstanding(state);
  const allocations =
    pending || state.status === "uncertain" || availableRaw <= 0n
      ? []
      : paymentCandidates(
          rows,
          availableRaw,
          Math.max(
            1,
            Math.trunc(input.maxRecipientsPerTransaction ?? DEFAULT_CANDIDATES),
          ),
        );
  const current = totals(state);
  return {
    id: state.id,
    sourceWallet: state.sourceWallet,
    asset: state.asset,
    ...current,
    sourceBalanceRaw,
    availableRaw,
    reserveRaw,
    outstanding: rows,
    nextPayments: allocations.map((row) => ({
      id: row.id ?? row.recipient.toString(),
      recipient: row.recipient.toString(),
      amountRaw: row.amountRaw,
    })),
    pending,
  };
}

export async function executeCumulativeDistribution(
  slrd: Solard,
  options: CumulativeDistributionExecuteOptions,
): Promise<CumulativeDistributionState> {
  const prepared = await prepare({ slrd, input: options });
  const { state, asset, source } = prepared;
  if (state.status === "uncertain")
    throw new Error(state.uncertainReason ?? "distribution is uncertain");
  while (true) {
    if (state.pending) {
      const result = await reconcilePending({
        slrd,
        state,
        via: options.via,
        skipPreflight: options.skipPreflight,
      });
      if (result === "pending") {
        await new Promise((resolve) => setTimeout(resolve, PENDING_POLL_MS));
        continue;
      }
    }
    const rows = outstanding(state);
    if (!rows.length) {
      state.status = "complete";
      state.lastError = null;
      writeState(slrd, state);
      return state;
    }
    const reserveRaw = BigInt(state.reserveRaw);
    const sourceBalanceRaw = await assetBalance(slrd, source, asset);
    const availableRaw =
      sourceBalanceRaw > reserveRaw ? sourceBalanceRaw - reserveRaw : 0n;
    if (availableRaw <= 0n) {
      state.status = "funding-required";
      state.lastError = `distribution ${state.id} has ${totals(state).totalOutstandingRaw} raw units outstanding with no distributable balance`;
      writeState(slrd, state);
      throw new Error(state.lastError);
    }
    const allocations = paymentCandidates(
      rows,
      availableRaw,
      Math.max(
        1,
        Math.trunc(options.maxRecipientsPerTransaction ?? DEFAULT_CANDIDATES),
      ),
    );
    const packed = await packTransferMany({
      connection: slrd.connection(),
      payer: source,
      asset,
      allocations,
      altAddresses: slrd.alts.list().map((row) => row.address),
      priorityMicroLamports: 0,
      maxRecipientsPerTransaction: options.maxRecipientsPerTransaction,
    });
    const batch = packed.batches[0];
    if (!batch) throw new Error("no transfer batch could be built");
    const compiled = await slrd.compile(slrd.signer(options.from), batch.draft);
    if (!options.skipSimulation) {
      const simulation = await slrd.simulatePlan(compiled);
      if (!simulation.success)
        throw new Error(
          `distribution simulation failed: ${JSON.stringify(simulation.error)}\n${simulation.logs.join("\n")}`,
        );
    }
    const pending: CumulativeDistributionPending = {
      signature: signedPlanSignature(compiled),
      sender: String(options.via ?? "rpc"),
      recentBlockhash: compiled.recentBlockhash,
      lastValidBlockHeight: compiled.lastValidBlockHeight,
      payments: batch.allocations.map((row) => ({
        recipient: row.recipient,
        amountRaw: row.amountRaw.toString(),
      })),
      signedTransactionBase64: signedTransactionBase64(compiled.transaction),
      submissionAttempts: 0,
      lastSubmittedAtMs: null,
      createdAtMs: Date.now(),
    };
    state.pending = pending;
    state.status = "distributing";
    state.lastError = null;
    state.uncertainReason = null;
    writeState(slrd, state);
    await submitPersisted({
      slrd,
      state,
      pending,
      via: options.via,
      skipPreflight: options.skipPreflight,
    });
  }
}
