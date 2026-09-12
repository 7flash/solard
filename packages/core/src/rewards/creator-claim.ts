import { Buffer } from "buffer";
import { createHash } from "node:crypto";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  PublicKey,
  VersionedTransaction,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import bs58 from "bs58";

import type { ClaimPlan } from "../claims/claim-source.ts";
import { SOL_ASSET, type QuoteAsset } from "../core/amounts.ts";
import type { TokenRef, WalletRef } from "../core/refs.ts";
import type { Solard } from "../core/solard.ts";
import type { SenderId, SendReceipt } from "../tx/types.ts";

const CLAIM_STATE_PREFIX = "creator-reward-claim:v1:";
const CHECKPOINT_PREFIX = "creator-reward-checkpoint:v1:";

type StoredQuoteAsset = {
  kind: QuoteAsset["kind"];
  mint: string;
  tokenProgram: string;
  decimals: number;
};

export type RewardEntitlementBasisInput = {
  id: string;
  slot: number;
  hash: string;
  observedAtMs?: number | null;
};

export type RewardEntitlementBasis = {
  id: string;
  slot: number;
  hash: string;
  observedAtMs: number | null;
};

export type CreatorRewardClaimPayout = {
  address: string;
  amountRaw: bigint;
  shareBps: number | null;
};

export type CreatorRewardClaimCheckpoint = {
  version: 1;
  claimId: string | null;
  tokenMint: string;
  source: string;
  feePayer: string;
  quoteAsset: StoredQuoteAsset;
  estimatedClaimRaw: string;
  claimedRaw: string;
  payouts: Array<{
    address: string;
    amountRaw: string;
    shareBps: number | null;
  }>;
  claimSignature: string;
  claimSlot: number;
  blockTimeMs: number | null;
  observedAtMs: number;
  basis: RewardEntitlementBasis | null;
};

export type DurableCreatorRewardClaimPending = {
  signature: string;
  sender: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  signedTransactionBase64: string;
  broadcastAttempts: number;
  lastBroadcastAtMs: number | null;
  createdAtMs: number;
};

export type DurableCreatorRewardClaimState = {
  version: 1;
  id: string;
  tokenMint: string;
  source: string;
  feePayer: string;
  quoteAsset: StoredQuoteAsset;
  estimatedClaimRaw: string;
  payoutTargets: Array<{
    address: string;
    shareBps: number | null;
  }>;
  basis: RewardEntitlementBasis | null;
  status: "prepared" | "broadcast" | "confirmed" | "failed" | "uncertain";
  pending: DurableCreatorRewardClaimPending | null;
  checkpoint: CreatorRewardClaimCheckpoint | null;
  lastError: string | null;
  uncertainReason: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export type CreatorRewardClaimResult = {
  version: 2;
  claimId: string | null;
  tokenMint: string;
  source: string;
  feePayer: string;
  quoteAsset: StoredQuoteAsset;
  estimatedClaimRaw: bigint;
  claimedRaw: bigint | null;
  payouts: CreatorRewardClaimPayout[];
  receipt: SendReceipt;
  claimSignature: string;
  claimSlot: number | null;
  blockTimeMs: number | null;
  observedAtMs: number;
  basis: RewardEntitlementBasis | null;
};

export type ClaimCreatorRewardsOptions = {
  id?: string;
  basis?: RewardEntitlementBasisInput;
  via?: SenderId;
  skipSimulation?: boolean;
  skipPreflight?: boolean;
};

function claimStateKey(id: string): string {
  return `${CLAIM_STATE_PREFIX}${id}`;
}

function checkpointKey(signature: string): string {
  return `${CHECKPOINT_PREFIX}${signature}`;
}

function settingValue(slrd: Solard, key: string): string | null {
  const row = slrd.db.settings.select().where({ key }).first() as
    { value?: string } | undefined;
  return row?.value ?? null;
}

function writeSetting(slrd: Solard, key: string, value: unknown): void {
  const encoded = JSON.stringify(value);
  const row = slrd.db.settings.select().where({ key }).first() as
    { id?: number } | undefined;
  if (row) {
    slrd.db.settings
      .update({ value: encoded, updatedAtMs: Date.now() })
      .where({ key })
      .exec();
  } else {
    slrd.db.settings.insert({
      key,
      value: encoded,
      updatedAtMs: Date.now(),
    });
  }
}

function readClaimState(
  slrd: Solard,
  id: string,
): DurableCreatorRewardClaimState | null {
  const raw = settingValue(slrd, claimStateKey(id));
  if (!raw) return null;
  const state = JSON.parse(raw) as DurableCreatorRewardClaimState;
  if (state.version !== 1 || state.id !== id)
    throw new Error(`Unsupported creator reward claim state for ${id}`);
  return state;
}

function writeClaimState(
  slrd: Solard,
  state: DurableCreatorRewardClaimState,
): DurableCreatorRewardClaimState {
  state.updatedAtMs = Date.now();
  writeSetting(slrd, claimStateKey(state.id), state);
  return state;
}

export function getCreatorRewardClaimState(
  slrd: Solard,
  idInput: string,
): DurableCreatorRewardClaimState | null {
  const id = idInput.trim();
  if (!id) throw new Error("A creator reward claim id is required");
  return readClaimState(slrd, id);
}

export function getCreatorRewardClaimCheckpoint(
  slrd: Solard,
  signatureInput: string,
): CreatorRewardClaimCheckpoint | null {
  const signature = signatureInput.trim();
  if (!signature) throw new Error("A claim signature is required");
  const raw = settingValue(slrd, checkpointKey(signature));
  if (!raw) return null;
  const checkpoint = JSON.parse(raw) as CreatorRewardClaimCheckpoint;
  if (checkpoint.version !== 1 || checkpoint.claimSignature !== signature)
    throw new Error(`Unsupported creator reward checkpoint for ${signature}`);
  return checkpoint;
}

export function normalizeRewardEntitlementBasis(
  input: RewardEntitlementBasisInput,
): RewardEntitlementBasis {
  const id = String(input.id ?? "").trim();
  if (!id) throw new Error("basis.id is required");
  const slot = Number(input.slot);
  if (!Number.isInteger(slot) || slot < 0)
    throw new Error("basis.slot must be a non-negative integer");
  const hash = String(input.hash ?? "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash))
    throw new Error("basis.hash must be a SHA-256 hex digest");
  const observedAtMs =
    input.observedAtMs == null ? null : Number(input.observedAtMs);
  if (
    observedAtMs != null &&
    (!Number.isFinite(observedAtMs) || observedAtMs < 0)
  ) {
    throw new Error("basis.observedAtMs must be a non-negative number");
  }
  return { id, slot, hash, observedAtMs };
}

export function hashRewardEntitlementBasis(payload: unknown): string {
  const canonical = canonicalJson(payload);
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value == null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Basis payload contains a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    const keys = Object.keys(row).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
      .join(",")}}`;
  }
  throw new Error(`Unsupported basis payload value: ${typeof value}`);
}

function quoteState(asset: QuoteAsset): StoredQuoteAsset {
  return {
    kind: asset.kind,
    mint: asset.mint.toBase58(),
    tokenProgram: asset.tokenProgram.toBase58(),
    decimals: asset.decimals,
  };
}

function quoteFromState(asset: StoredQuoteAsset): QuoteAsset {
  return asset.kind === "native-sol"
    ? SOL_ASSET
    : {
        kind: "spl-token",
        mint: new PublicKey(asset.mint),
        tokenProgram: new PublicKey(asset.tokenProgram),
        decimals: asset.decimals,
      };
}

function payoutRows(
  plan: ClaimPlan,
  fallbackAddress: string | null,
): Array<{ address: PublicKey; shareBps: number | null }> {
  const rows = plan.payouts?.length
    ? plan.payouts.map((row) => ({
        address: row.address,
        shareBps: row.shareBps ?? null,
      }))
    : [];
  if (!rows.length) {
    const metaAddresses = Array.isArray(plan.meta?.payoutAddresses)
      ? plan.meta.payoutAddresses
      : [];
    for (const input of metaAddresses) {
      if (typeof input !== "string" || !input.trim()) continue;
      rows.push({ address: new PublicKey(input), shareBps: null });
    }
  }
  if (!rows.length && typeof plan.meta?.payoutAddress === "string") {
    rows.push({
      address: new PublicKey(plan.meta.payoutAddress),
      shareBps: null,
    });
  }
  if (!rows.length && fallbackAddress) {
    rows.push({ address: new PublicKey(fallbackAddress), shareBps: null });
  }
  const unique = new Map<
    string,
    { address: PublicKey; shareBps: number | null }
  >();
  for (const row of rows) {
    const key = row.address.toBase58();
    if (!unique.has(key)) unique.set(key, row);
  }
  return [...unique.values()];
}

function accountKeys(tx: ParsedTransactionWithMeta): string[] {
  return tx.transaction.message.accountKeys.map((row) => row.pubkey.toBase58());
}

function rawTokenAmount(
  tx: ParsedTransactionWithMeta,
  address: PublicKey,
  asset: QuoteAsset,
  phase: "pre" | "post",
): bigint {
  const rows =
    phase === "pre" ? tx.meta?.preTokenBalances : tx.meta?.postTokenBalances;
  if (!rows?.length) return 0n;
  const owner = address.toBase58();
  const ata = getAssociatedTokenAddressSync(
    asset.mint,
    address,
    true,
    asset.tokenProgram,
  ).toBase58();
  const keys = accountKeys(tx);
  let total = 0n;
  for (const row of rows) {
    if (row.mint !== asset.mint.toBase58()) continue;
    const matchesOwner = row.owner === owner;
    const matchesAta = keys[row.accountIndex] === ata;
    if (!matchesOwner && !matchesAta) continue;
    const raw = row.uiTokenAmount.amount;
    if (/^\d+$/.test(raw)) total += BigInt(raw);
  }
  return total;
}

export function creatorRewardPayoutDelta(
  tx: ParsedTransactionWithMeta,
  payout: PublicKey,
  feePayer: PublicKey,
  asset: QuoteAsset,
): bigint {
  if (!tx.meta) return 0n;
  if (asset.kind === "spl-token") {
    const before = rawTokenAmount(tx, payout, asset, "pre");
    const after = rawTokenAmount(tx, payout, asset, "post");
    return after > before ? after - before : 0n;
  }
  const keys = accountKeys(tx);
  const index = keys.indexOf(payout.toBase58());
  if (index < 0) return 0n;
  const before = BigInt(tx.meta.preBalances[index] ?? 0);
  const after = BigInt(tx.meta.postBalances[index] ?? 0);
  let delta = after - before;
  if (payout.equals(feePayer)) delta += BigInt(tx.meta.fee ?? 0);
  return delta > 0n ? delta : 0n;
}

export async function confirmedCreatorRewardTransaction(
  slrd: Solard,
  signature: string,
): Promise<ParsedTransactionWithMeta | null> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tx = await slrd.connection().getParsedTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx) return tx;
    if (attempt < 7)
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
  }
  return null;
}

function upsertClaimRow(args: {
  slrd: Solard;
  signature: string;
  feePayer: string;
  tokenMint: string;
  quoteMint: string;
  source: string;
  estimatedClaimRaw: bigint;
  claimedRaw: bigint;
}): void {
  const existing = args.slrd.db.claims
    .select()
    .where({ signature: args.signature })
    .first() as { id: number } | undefined;
  const values = {
    walletAddress: args.feePayer,
    mint: args.tokenMint,
    quoteMint: args.quoteMint,
    path: args.source,
    estimatedClaimRaw: args.estimatedClaimRaw.toString(),
    claimedRaw: args.claimedRaw.toString(),
    signature: args.signature,
    status: "confirmed" as const,
    updatedAtMs: Date.now(),
  };
  if (existing) {
    args.slrd.db.claims.update(values).where({ id: existing.id }).exec();
  } else {
    args.slrd.db.claims.insert({
      ...values,
      createdAtMs: Date.now(),
    });
  }
}

function signedPlanSignature(plan: {
  transaction: { signatures: Uint8Array[] };
}): string {
  const bytes = plan.transaction.signatures[0];
  if (!bytes || bytes.every((value) => value === 0))
    throw new Error(
      "Compiled creator reward claim is missing the payer signature",
    );
  return bs58.encode(bytes);
}

function signedTransactionBase64(transaction: VersionedTransaction): string {
  return Buffer.from(transaction.serialize()).toString("base64");
}

function decodeSignedTransaction(base64: string): VersionedTransaction {
  return VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
}

type ClaimReconcileOutcome =
  | { kind: "confirmed"; receipt: SendReceipt }
  | { kind: "failed"; error: string | null }
  | { kind: "seen-pending" }
  | { kind: "not-found"; currentBlockHeight: number };

async function reconcileClaim(
  slrd: Solard,
  pending: DurableCreatorRewardClaimPending,
): Promise<ClaimReconcileOutcome> {
  const status = (
    await slrd.connection().getSignatureStatuses([pending.signature], {
      searchTransactionHistory: true,
    })
  ).value[0];
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
  const tx = await confirmedCreatorRewardTransaction(slrd, pending.signature);
  if (tx?.meta?.err)
    return { kind: "failed", error: JSON.stringify(tx.meta.err) };
  if (tx?.meta) {
    const receipt = await slrd.confirmSignature(
      pending.signature,
      pending.sender,
    );
    return { kind: "confirmed", receipt };
  }
  return {
    kind: "not-found",
    currentBlockHeight: await slrd.connection().getBlockHeight("confirmed"),
  };
}

function provisionalResult(
  state: DurableCreatorRewardClaimState,
): CreatorRewardClaimResult {
  const pending = state.pending;
  if (!pending) throw new Error(`Claim ${state.id} has no pending transaction`);
  return {
    version: 2,
    claimId: state.id,
    tokenMint: state.tokenMint,
    source: state.source,
    feePayer: state.feePayer,
    quoteAsset: state.quoteAsset,
    estimatedClaimRaw: BigInt(state.estimatedClaimRaw),
    claimedRaw: null,
    payouts: state.payoutTargets.map((row) => ({
      address: row.address,
      amountRaw: 0n,
      shareBps: row.shareBps,
    })),
    receipt: {
      signature: pending.signature,
      slot: null,
      sender: pending.sender,
      status: "broadcast",
    },
    claimSignature: pending.signature,
    claimSlot: null,
    blockTimeMs: null,
    observedAtMs: Date.now(),
    basis: state.basis,
  };
}

function resultFromCheckpoint(
  checkpoint: CreatorRewardClaimCheckpoint,
  receipt?: SendReceipt,
): CreatorRewardClaimResult {
  return {
    version: 2,
    claimId: checkpoint.claimId,
    tokenMint: checkpoint.tokenMint,
    source: checkpoint.source,
    feePayer: checkpoint.feePayer,
    quoteAsset: checkpoint.quoteAsset,
    estimatedClaimRaw: BigInt(checkpoint.estimatedClaimRaw),
    claimedRaw: BigInt(checkpoint.claimedRaw),
    payouts: checkpoint.payouts.map((row) => ({
      address: row.address,
      amountRaw: BigInt(row.amountRaw),
      shareBps: row.shareBps,
    })),
    receipt: receipt ?? {
      signature: checkpoint.claimSignature,
      slot: checkpoint.claimSlot,
      sender: "rpc",
      status: "confirmed",
    },
    claimSignature: checkpoint.claimSignature,
    claimSlot: checkpoint.claimSlot,
    blockTimeMs: checkpoint.blockTimeMs,
    observedAtMs: checkpoint.observedAtMs,
    basis: checkpoint.basis,
  };
}

async function finalizeConfirmedClaim(args: {
  slrd: Solard;
  claimId: string | null;
  tokenMint: string;
  source: string;
  feePayer: string;
  quoteAsset: StoredQuoteAsset;
  estimatedClaimRaw: bigint;
  payoutTargets: Array<{ address: string; shareBps: number | null }>;
  basis: RewardEntitlementBasis | null;
  signature: string;
  receipt: SendReceipt;
}): Promise<CreatorRewardClaimResult | null> {
  const tx = await confirmedCreatorRewardTransaction(args.slrd, args.signature);
  if (!tx?.meta || tx.meta.err) return null;
  if (args.basis && args.basis.slot > tx.slot) {
    throw new Error(
      `Reward basis slot ${args.basis.slot} is after confirmed claim slot ${tx.slot}`,
    );
  }
  const asset = quoteFromState(args.quoteAsset);
  const feePayer = new PublicKey(args.feePayer);
  const payouts = args.payoutTargets.map((row) => ({
    address: row.address,
    amountRaw: creatorRewardPayoutDelta(
      tx,
      new PublicKey(row.address),
      feePayer,
      asset,
    ),
    shareBps: row.shareBps,
  }));
  const claimedRaw = payouts.reduce((sum, row) => sum + row.amountRaw, 0n);
  const checkpoint: CreatorRewardClaimCheckpoint = {
    version: 1,
    claimId: args.claimId,
    tokenMint: args.tokenMint,
    source: args.source,
    feePayer: args.feePayer,
    quoteAsset: args.quoteAsset,
    estimatedClaimRaw: args.estimatedClaimRaw.toString(),
    claimedRaw: claimedRaw.toString(),
    payouts: payouts.map((row) => ({
      address: row.address,
      amountRaw: row.amountRaw.toString(),
      shareBps: row.shareBps,
    })),
    claimSignature: args.signature,
    claimSlot: tx.slot,
    blockTimeMs: tx.blockTime == null ? null : tx.blockTime * 1_000,
    observedAtMs: Date.now(),
    basis: args.basis,
  };
  writeSetting(args.slrd, checkpointKey(args.signature), checkpoint);
  upsertClaimRow({
    slrd: args.slrd,
    signature: args.signature,
    feePayer: args.feePayer,
    tokenMint: args.tokenMint,
    quoteMint: args.quoteAsset.mint,
    source: args.source,
    estimatedClaimRaw: args.estimatedClaimRaw,
    claimedRaw,
  });
  if (args.claimId) {
    const state = readClaimState(args.slrd, args.claimId);
    if (!state)
      throw new Error(`Creator reward claim state ${args.claimId} disappeared`);
    state.status = "confirmed";
    state.pending = null;
    state.checkpoint = checkpoint;
    state.lastError = null;
    state.uncertainReason = null;
    writeClaimState(args.slrd, state);
  }
  return resultFromCheckpoint(checkpoint, {
    ...args.receipt,
    slot: tx.slot,
    status: "confirmed",
  });
}

function sameBasis(
  left: RewardEntitlementBasis | null,
  right: RewardEntitlementBasis | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateExistingState(args: {
  state: DurableCreatorRewardClaimState;
  tokenMint: string;
  feePayer: string;
  requestedBasis: RewardEntitlementBasis | null;
}): RewardEntitlementBasis | null {
  const { state } = args;
  if (state.tokenMint !== args.tokenMint || state.feePayer !== args.feePayer)
    throw new Error(
      `Claim id ${state.id} already belongs to another token or fee payer`,
    );
  if (args.requestedBasis && !sameBasis(state.basis, args.requestedBasis)) {
    throw new Error(
      `Claim id ${state.id} is already bound to a different reward basis`,
    );
  }
  return state.basis;
}

async function rebroadcastPending(args: {
  slrd: Solard;
  state: DurableCreatorRewardClaimState;
  skipPreflight?: boolean;
}): Promise<void> {
  const pending = args.state.pending;
  if (!pending)
    throw new Error(`Claim ${args.state.id} has no pending transaction`);
  pending.broadcastAttempts += 1;
  pending.lastBroadcastAtMs = Date.now();
  pending.sender = pending.sender || "rpc";
  args.state.status = "broadcast";
  args.state.lastError = null;
  writeClaimState(args.slrd, args.state);
  const returned = await args.slrd.senders.resolve(pending.sender).send({
    connection: args.slrd.connection(),
    transaction: decodeSignedTransaction(pending.signedTransactionBase64),
    options: { skipPreflight: args.skipPreflight ?? true },
  });
  if (returned !== pending.signature) {
    args.state.status = "uncertain";
    args.state.uncertainReason = `Sender returned signature ${returned}, but persisted claim signature is ${pending.signature}`;
    args.state.lastError = args.state.uncertainReason;
    writeClaimState(args.slrd, args.state);
    throw new Error(args.state.uncertainReason);
  }
}

async function resumeDurableCreatorRewardClaim(args: {
  slrd: Solard;
  state: DurableCreatorRewardClaimState;
  skipPreflight?: boolean;
}): Promise<CreatorRewardClaimResult> {
  const { slrd, state } = args;
  if (state.checkpoint && state.status === "confirmed")
    return resultFromCheckpoint(state.checkpoint);
  if (state.status === "failed" && !state.pending)
    throw new Error(
      `Claim ${state.id} previously failed. Freeze a fresh reward basis and use a new stable claim id before claiming again.`,
    );
  const pending = state.pending;
  if (!pending)
    throw new Error(
      `Claim ${state.id} has status ${state.status} but no persisted pending transaction`,
    );

  const outcome = await reconcileClaim(slrd, pending);
  if (outcome.kind === "confirmed") {
    const exact = await finalizeConfirmedClaim({
      slrd,
      claimId: state.id,
      tokenMint: state.tokenMint,
      source: state.source,
      feePayer: state.feePayer,
      quoteAsset: state.quoteAsset,
      estimatedClaimRaw: BigInt(state.estimatedClaimRaw),
      payoutTargets: state.payoutTargets,
      basis: state.basis,
      signature: pending.signature,
      receipt: outcome.receipt,
    });
    if (exact) return exact;
    state.lastError = `Claim ${pending.signature} confirmed but transaction metadata is not available yet`;
    writeClaimState(slrd, state);
    return provisionalResult(state);
  }

  if (outcome.kind === "failed") {
    state.pending = null;
    state.status = "failed";
    state.lastError = outcome.error ?? "Creator reward claim failed on-chain";
    writeClaimState(slrd, state);
    throw new Error(
      `${state.lastError}. Freeze a fresh reward basis and use a new stable claim id before claiming again.`,
    );
  }

  if (outcome.kind === "seen-pending") {
    state.status = "broadcast";
    writeClaimState(slrd, state);
    return provisionalResult(state);
  }

  if (outcome.currentBlockHeight > pending.lastValidBlockHeight) {
    state.status = "uncertain";
    state.uncertainReason =
      `Claim ${pending.signature} was not found after blockhash expiry ` +
      `(current=${outcome.currentBlockHeight}, lastValid=${pending.lastValidBlockHeight}). ` +
      "The stable claim id will not build another claim until this signature is resolved.";
    state.lastError = state.uncertainReason;
    writeClaimState(slrd, state);
    throw new Error(state.uncertainReason);
  }

  try {
    await rebroadcastPending({
      slrd,
      state,
      skipPreflight: args.skipPreflight,
    });
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    writeClaimState(slrd, state);
    return provisionalResult(state);
  }

  const receipt = await slrd.confirmSignature(
    pending.signature,
    pending.sender,
  );
  if (receipt.status === "confirmed") {
    const exact = await finalizeConfirmedClaim({
      slrd,
      claimId: state.id,
      tokenMint: state.tokenMint,
      source: state.source,
      feePayer: state.feePayer,
      quoteAsset: state.quoteAsset,
      estimatedClaimRaw: BigInt(state.estimatedClaimRaw),
      payoutTargets: state.payoutTargets,
      basis: state.basis,
      signature: pending.signature,
      receipt,
    });
    if (exact) return exact;
    state.lastError = `Claim ${pending.signature} confirmed but transaction metadata is not available yet`;
    writeClaimState(slrd, state);
    return provisionalResult(state);
  }
  if (receipt.status === "failed") {
    state.pending = null;
    state.status = "failed";
    state.lastError = receipt.error ?? "Creator reward claim failed on-chain";
    writeClaimState(slrd, state);
    throw new Error(
      `${state.lastError}. Freeze a fresh reward basis and use a new stable claim id before claiming again.`,
    );
  }
  return provisionalResult(state);
}

export async function claimCreatorRewards(
  slrd: Solard,
  tokenRef: TokenRef,
  wallet: WalletRef,
  options: ClaimCreatorRewardsOptions = {},
): Promise<CreatorRewardClaimResult> {
  const token = slrd.resolveToken(tokenRef);
  const feePayer = slrd.resolveWallet(wallet).address;
  const id = options.id?.trim() || null;
  const requestedBasis = options.basis
    ? normalizeRewardEntitlementBasis(options.basis)
    : null;
  if (requestedBasis && !id)
    throw new Error(
      "A stable claim id is required when binding a reward basis",
    );

  if (id) {
    const existing = readClaimState(slrd, id);
    if (existing) {
      validateExistingState({
        state: existing,
        tokenMint: token.mint,
        feePayer: feePayer.toBase58(),
        requestedBasis,
      });
      return await resumeDurableCreatorRewardClaim({
        slrd,
        state: existing,
        skipPreflight: options.skipPreflight,
      });
    }
  }

  if (requestedBasis) {
    const currentSlot = await slrd.connection().getSlot("confirmed");
    if (requestedBasis.slot > currentSlot)
      throw new Error(
        `Reward basis slot ${requestedBasis.slot} is ahead of the current confirmed slot ${currentSlot}`,
      );
  }

  const plan = await slrd.resolveClaim(token, feePayer);
  const payouts = payoutRows(plan, token.creator ?? null);
  if (!payouts.length)
    throw new Error(
      `Claim source ${plan.source} did not expose any payout addresses for ${token.mint}`,
    );
  const asset = quoteState(plan.quoteAsset);
  const payoutTargets = payouts.map((row) => ({
    address: row.address.toBase58(),
    shareBps: row.shareBps,
  }));

  const builder = slrd.transaction(wallet).addMany(plan.instructions, {
    kind: "claim",
    mint: new PublicKey(token.mint),
    meta: {
      source: plan.source,
      quoteMint: plan.quoteAsset.mint.toBase58(),
      estimatedClaimRaw: plan.estimatedClaimRaw.toString(),
      spendableByUserRaw: plan.spendableByUserRaw.toString(),
      ...plan.meta,
    },
  });
  const compiled = await builder.build();
  if (!options.skipSimulation) {
    const simulation = await slrd.simulatePlan(compiled);
    if (!simulation.success) {
      throw new Error(
        `Creator reward claim simulation failed: ${JSON.stringify(simulation.error)}\n${simulation.logs.join("\n")}`,
      );
    }
  }
  const signature = signedPlanSignature(compiled);
  const via = options.via ?? "rpc";

  if (id) {
    const now = Date.now();
    const state = writeClaimState(slrd, {
      version: 1,
      id,
      tokenMint: token.mint,
      source: plan.source,
      feePayer: feePayer.toBase58(),
      quoteAsset: asset,
      estimatedClaimRaw: plan.estimatedClaimRaw.toString(),
      payoutTargets,
      basis: requestedBasis,
      status: "prepared",
      pending: {
        signature,
        sender: String(via),
        recentBlockhash: compiled.recentBlockhash,
        lastValidBlockHeight: compiled.lastValidBlockHeight,
        signedTransactionBase64: signedTransactionBase64(compiled.transaction),
        broadcastAttempts: 0,
        lastBroadcastAtMs: null,
        createdAtMs: now,
      },
      checkpoint: null,
      lastError: null,
      uncertainReason: null,
      createdAtMs: now,
      updatedAtMs: now,
    });

    state.pending!.broadcastAttempts += 1;
    state.pending!.lastBroadcastAtMs = Date.now();
    state.status = "broadcast";
    writeClaimState(slrd, state);

    let submission;
    try {
      submission = await slrd.broadcastPlan(
        compiled,
        via,
        `creator-reward-claim:${id}`,
        {
          skipSimulation: true,
          skipPreflight: options.skipPreflight,
        },
      );
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      writeClaimState(slrd, state);
      return provisionalResult(state);
    }
    if (submission.signature !== signature) {
      state.status = "uncertain";
      state.uncertainReason = `Sender returned signature ${submission.signature}, but persisted claim signature is ${signature}`;
      state.lastError = state.uncertainReason;
      writeClaimState(slrd, state);
      throw new Error(state.uncertainReason);
    }
    const receipt = await slrd.confirmSubmitted(submission);
    if (receipt.status === "confirmed") {
      const exact = await finalizeConfirmedClaim({
        slrd,
        claimId: id,
        tokenMint: token.mint,
        source: plan.source,
        feePayer: feePayer.toBase58(),
        quoteAsset: asset,
        estimatedClaimRaw: plan.estimatedClaimRaw,
        payoutTargets,
        basis: requestedBasis,
        signature,
        receipt,
      });
      if (exact) return exact;
      state.lastError = `Claim ${signature} confirmed but transaction metadata is not available yet`;
      writeClaimState(slrd, state);
      return provisionalResult(state);
    }
    if (receipt.status === "failed") {
      state.pending = null;
      state.status = "failed";
      state.lastError = receipt.error ?? "Creator reward claim failed on-chain";
      writeClaimState(slrd, state);
      throw new Error(
        `${state.lastError}. Freeze a fresh reward basis and use a new stable claim id before claiming again.`,
      );
    }
    return provisionalResult(state);
  }

  const receipt = await slrd.sendPlan(compiled, via, "creator-reward-claim", {
    skipSimulation: true,
    skipPreflight: options.skipPreflight,
  });
  if (receipt.status === "confirmed") {
    const exact = await finalizeConfirmedClaim({
      slrd,
      claimId: null,
      tokenMint: token.mint,
      source: plan.source,
      feePayer: feePayer.toBase58(),
      quoteAsset: asset,
      estimatedClaimRaw: plan.estimatedClaimRaw,
      payoutTargets,
      basis: null,
      signature: receipt.signature,
      receipt,
    });
    if (exact) return exact;
  }
  return {
    version: 2,
    claimId: null,
    tokenMint: token.mint,
    source: plan.source,
    feePayer: feePayer.toBase58(),
    quoteAsset: asset,
    estimatedClaimRaw: plan.estimatedClaimRaw,
    claimedRaw: null,
    payouts: payoutTargets.map((row) => ({
      address: row.address,
      amountRaw: 0n,
      shareBps: row.shareBps,
    })),
    receipt,
    claimSignature: receipt.signature,
    claimSlot: receipt.slot,
    blockTimeMs: null,
    observedAtMs: Date.now(),
    basis: null,
  };
}
