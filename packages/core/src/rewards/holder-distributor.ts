import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "buffer";
import { NATIVE_MINT } from "@solana/spl-token";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

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

const STATE_PREFIX = "holder-reward-distribution:v4:";
const RUN_PREFIX = "holder-reward-run:v1:";
const DEFAULT_CANDIDATE_RECIPIENTS = 64;
const PENDING_POLL_MS = 1_000;

type RawIntegerInput = bigint | string;

export type HolderRewardEntitlementInput = {
  wallet: string | PublicKey;
  entitledRaw: RawIntegerInput;
};

export type HolderRewardEntitlementSnapshotInput =
  | HolderRewardEntitlementInput[]
  | {
      recipients: HolderRewardEntitlementInput[];
      totalEntitledRaw?: RawIntegerInput;
      observedAtMs?: number | null;
    };

export type HolderRewardRecipientState = {
  wallet: string;
  entitledRaw: string;
  confirmedPaidRaw: string;
};

export type HolderRewardAllocation = HolderRewardRecipientState;

export type HolderRewardPayment = {
  wallet: string;
  amountRaw: string;
};

export type HolderRewardPendingTransaction = {
  kind: "distribution";
  signature: string;
  sender: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  payments: HolderRewardPayment[];
  signedTransactionBase64: string;
  broadcastAttempts: number;
  lastBroadcastAtMs: number | null;
  createdAtMs: number;
};

export type HolderRewardSnapshotState = {
  hash: string;
  totalEntitledRaw: string;
  recipientCount: number;
  observedAtMs: number | null;
  acceptedAtMs: number;
};

export type HolderRewardEntitlementEvent = {
  snapshotHash: string;
  wallet: string;
  previousEntitledRaw: string;
  entitledRaw: string;
  deltaRaw: string;
  acceptedAtMs: number;
};

export type HolderRewardDistributionState = {
  version: 4;
  tokenMint: string;
  sourceWallet: string;
  rewardAsset: {
    kind: QuoteAsset["kind"];
    mint: string;
    tokenProgram: string;
    decimals: number;
  };
  status:
    | "ready"
    | "distributing"
    | "complete"
    | "stopped"
    | "funding-required"
    | "uncertain";
  recipients: HolderRewardRecipientState[];
  snapshots: HolderRewardSnapshotState[];
  entitlementEvents: HolderRewardEntitlementEvent[];
  pending: HolderRewardPendingTransaction | null;
  receipts: Array<{
    kind: "distribution";
    signature: string;
    sender: string;
    payments: HolderRewardPayment[];
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

export type HolderRewardOutstandingRecipient = {
  wallet: string;
  entitledRaw: bigint;
  confirmedPaidRaw: bigint;
  outstandingRaw: bigint;
};

export type HolderRewardPlanOptions = {
  token: TokenRef;
  wallet: WalletRef;
  rewardMint?: string | PublicKey;
  snapshot: HolderRewardEntitlementSnapshotInput;
  reserveRaw?: bigint;
  maxRecipientsPerTransaction?: number;
};

export type HolderRewardDistributionPlan = {
  version: 4;
  tokenMint: string;
  sourceWallet: string;
  rewardAsset: HolderRewardDistributionState["rewardAsset"];
  snapshotHash: string;
  totalEntitledRaw: bigint;
  totalConfirmedPaidRaw: bigint;
  totalOutstandingRaw: bigint;
  sourceBalanceRaw: bigint;
  availableRaw: bigint;
  reserveRaw: bigint;
  outstanding: HolderRewardOutstandingRecipient[];
  nextPayments: Array<{ id: string; recipient: string; amountRaw: bigint }>;
  transferPlan: PackedTransferPlan | null;
  pending: HolderRewardPendingTransaction | null;
};

export type ExecuteHolderRewardDistributionOptions = HolderRewardPlanOptions & {
  via?: SenderId;
  skipSimulation?: boolean;
  skipPreflight?: boolean;
};

export type HolderRewardRecipientAudit = {
  wallet: string;
  entitledRaw: string;
  confirmedPaidRaw: string;
  outstandingRaw: string;
  entitlementEvents: HolderRewardEntitlementEvent[];
  payments: Array<{
    signature: string;
    amountRaw: string;
    slot: number | null;
    confirmedAtMs: number;
  }>;
};

export type HolderRewardDistributionAudit = {
  version: 4;
  tokenMint: string;
  sourceWallet: string;
  rewardAsset: HolderRewardDistributionState["rewardAsset"];
  status: HolderRewardDistributionState["status"];
  totalEntitledRaw: string;
  totalConfirmedPaidRaw: string;
  totalOutstandingRaw: string;
  pending: HolderRewardPendingTransaction | null;
  snapshots: HolderRewardSnapshotState[];
  recipients: HolderRewardRecipientAudit[];
  receipts: HolderRewardDistributionState["receipts"];
  lastError: string | null;
  uncertainReason: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export type HolderRewardRunState = {
  version: 1;
  tokenMint: string;
  runId: string;
  pid: number;
  startedAtMs: number;
  heartbeatAtMs: number;
  stopRequested: boolean;
};

export type HolderRewardStopResult = {
  tokenMint: string;
  running: boolean;
  stopRequested: boolean;
  staleLockCleared: boolean;
  runId: string | null;
  pid: number | null;
};

type NormalizedSnapshot = {
  recipients: Array<{ wallet: string; entitledRaw: bigint }>;
  totalEntitledRaw: bigint;
  observedAtMs: number | null;
  hash: string;
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

function stateKey(tokenMint: string): string {
  return `${STATE_PREFIX}${tokenMint}`;
}

function runKey(tokenMint: string): string {
  return `${RUN_PREFIX}${tokenMint}`;
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
  if (row) {
    slrd.db.settings.update({ value, updatedAtMs: now }).where({ key }).exec();
  } else {
    slrd.db.settings.insert({ key, value, updatedAtMs: now });
  }
}

function cloneState(
  state: HolderRewardDistributionState,
): HolderRewardDistributionState {
  return JSON.parse(JSON.stringify(state)) as HolderRewardDistributionState;
}

function migrateLegacyState(
  slrd: Solard,
  tokenMint: string,
): HolderRewardDistributionState | null {
  const rows = slrd.db.settings.select().all() as Array<{
    key: string;
    value: string;
  }>;
  const matches = rows
    .filter((row) => row.key.startsWith("holder-reward-distribution:v3:"))
    .map((row) => {
      try {
        return JSON.parse(row.value) as any;
      } catch {
        return null;
      }
    })
    .filter(
      (row): row is any => row?.version === 3 && row.tokenMint === tokenMint,
    );
  if (!matches.length) return null;
  if (matches.length > 1) {
    throw new Error(
      `Token ${tokenMint} has multiple legacy reward distribution states. ` +
        "They cannot be merged automatically into the single per-token distribution state.",
    );
  }
  const legacy = matches[0]!;
  const state: HolderRewardDistributionState = {
    version: 4,
    tokenMint,
    sourceWallet: String(legacy.sourceWallet),
    rewardAsset: legacy.rewardAsset,
    status:
      legacy.status === "complete" ||
      legacy.status === "distributing" ||
      legacy.status === "funding-required" ||
      legacy.status === "uncertain"
        ? legacy.status
        : "ready",
    recipients: Array.isArray(legacy.recipients)
      ? legacy.recipients.map((row: any) => ({
          wallet: String(row.wallet),
          entitledRaw: String(row.entitledRaw),
          confirmedPaidRaw: String(row.confirmedPaidRaw),
        }))
      : [],
    snapshots: Array.isArray(legacy.snapshots)
      ? legacy.snapshots.map((row: any) => ({
          hash: String(row.hash),
          totalEntitledRaw: String(
            row.totalEntitledRaw ?? row.totalClaimedRaw ?? "0",
          ),
          recipientCount: Number(row.recipientCount ?? 0),
          observedAtMs:
            row.observedAtMs == null ? null : Number(row.observedAtMs),
          acceptedAtMs: Number(row.acceptedAtMs ?? Date.now()),
        }))
      : [],
    entitlementEvents: Array.isArray(legacy.entitlementEvents)
      ? legacy.entitlementEvents.map((row: any) => ({
          snapshotHash: String(row.snapshotHash ?? "legacy"),
          wallet: String(row.wallet),
          previousEntitledRaw: String(row.previousEntitledRaw),
          entitledRaw: String(row.entitledRaw),
          deltaRaw: String(row.deltaRaw),
          acceptedAtMs: Number(row.acceptedAtMs ?? Date.now()),
        }))
      : [],
    pending: legacy.pending ?? null,
    receipts: Array.isArray(legacy.receipts) ? legacy.receipts : [],
    reserveRaw: String(legacy.reserveRaw ?? "0"),
    lastError: legacy.lastError ?? null,
    uncertainReason: legacy.uncertainReason ?? null,
    createdAtMs: Number(legacy.createdAtMs ?? Date.now()),
    updatedAtMs: Number(legacy.updatedAtMs ?? Date.now()),
  };
  writeState(slrd, state);
  return state;
}

function readState(
  slrd: Solard,
  tokenMint: string,
): HolderRewardDistributionState | null {
  const raw = readSetting(slrd, stateKey(tokenMint));
  if (!raw) return migrateLegacyState(slrd, tokenMint);
  const parsed = JSON.parse(raw) as HolderRewardDistributionState;
  if (parsed.version !== 4 || parsed.tokenMint !== tokenMint)
    throw new Error(`Unsupported holder reward state for token ${tokenMint}`);
  return parsed;
}

function writeState(
  slrd: Solard,
  state: HolderRewardDistributionState,
): HolderRewardDistributionState {
  state.updatedAtMs = Date.now();
  writeSetting(slrd, stateKey(state.tokenMint), JSON.stringify(state));
  return state;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    return code === "EPERM";
  }
}

function readRun(slrd: Solard, tokenMint: string): HolderRewardRunState | null {
  const raw = readSetting(slrd, runKey(tokenMint));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as HolderRewardRunState;
  return parsed.version === 1 && parsed.tokenMint === tokenMint ? parsed : null;
}

function deleteRunIfMatches(
  slrd: Solard,
  tokenMint: string,
  runId: string,
): boolean {
  const key = runKey(tokenMint);
  const raw = readSetting(slrd, key);
  if (!raw) return false;
  const current = JSON.parse(raw) as HolderRewardRunState;
  if (current.runId !== runId) return false;
  slrd.db.settings.delete().where({ key, value: raw }).exec();
  return true;
}

function acquireRun(slrd: Solard, tokenMint: string): HolderRewardRunState {
  const key = runKey(tokenMint);
  const existingRaw = readSetting(slrd, key);
  if (existingRaw) {
    const existing = JSON.parse(existingRaw) as HolderRewardRunState;
    if (processAlive(existing.pid)) {
      throw new Error(
        `Reward distribution is already running for token ${tokenMint} ` +
          `(pid=${existing.pid}, run=${existing.runId}). Stop it first with: ` +
          `slrd rewards stop ${tokenMint}`,
      );
    }
    slrd.db.settings.delete().where({ key, value: existingRaw }).exec();
  }

  const now = Date.now();
  const run: HolderRewardRunState = {
    version: 1,
    tokenMint,
    runId: randomUUID(),
    pid: process.pid,
    startedAtMs: now,
    heartbeatAtMs: now,
    stopRequested: false,
  };
  try {
    slrd.db.settings.insert({
      key,
      value: JSON.stringify(run),
      updatedAtMs: now,
    });
    return run;
  } catch {
    const winner = readRun(slrd, tokenMint);
    if (winner) {
      throw new Error(
        `Reward distribution is already running for token ${tokenMint} ` +
          `(pid=${winner.pid}, run=${winner.runId}). Stop it first with: ` +
          `slrd rewards stop ${tokenMint}`,
      );
    }
    throw new Error(
      `Could not acquire reward distribution lock for ${tokenMint}`,
    );
  }
}

function heartbeatRun(
  slrd: Solard,
  run: HolderRewardRunState,
): HolderRewardRunState {
  const current = readRun(slrd, run.tokenMint);
  if (!current || current.runId !== run.runId) {
    throw new Error(
      `Reward distribution lock for ${run.tokenMint} was lost while the distribution was running`,
    );
  }
  current.heartbeatAtMs = Date.now();
  writeSetting(slrd, runKey(run.tokenMint), JSON.stringify(current));
  return current;
}

function stopRequested(slrd: Solard, run: HolderRewardRunState): boolean {
  return heartbeatRun(slrd, run).stopRequested;
}

export function requestHolderRewardDistributionStop(
  slrd: Solard,
  tokenRef: TokenRef,
): HolderRewardStopResult {
  const tokenMint = slrd.resolveToken(tokenRef).mint;
  const key = runKey(tokenMint);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const raw = readSetting(slrd, key);
    if (!raw) {
      return {
        tokenMint,
        running: false,
        stopRequested: false,
        staleLockCleared: false,
        runId: null,
        pid: null,
      };
    }
    const current = JSON.parse(raw) as HolderRewardRunState;
    if (!processAlive(current.pid)) {
      slrd.db.settings.delete().where({ key, value: raw }).exec();
      return {
        tokenMint,
        running: false,
        stopRequested: false,
        staleLockCleared: true,
        runId: current.runId,
        pid: current.pid,
      };
    }
    current.stopRequested = true;
    current.heartbeatAtMs = Date.now();
    slrd.db.settings
      .update({
        value: JSON.stringify(current),
        updatedAtMs: current.heartbeatAtMs,
      })
      .where({ key, value: raw })
      .exec();
    const verified = readRun(slrd, tokenMint);
    if (verified?.runId === current.runId && verified.stopRequested) {
      return {
        tokenMint,
        running: true,
        stopRequested: true,
        staleLockCleared: false,
        runId: current.runId,
        pid: current.pid,
      };
    }
  }
  throw new Error(
    `Could not request stop for reward distribution ${tokenMint}`,
  );
}

export function getHolderRewardDistributionRun(
  slrd: Solard,
  tokenRef: TokenRef,
): HolderRewardRunState | null {
  const tokenMint = slrd.resolveToken(tokenRef).mint;
  const run = readRun(slrd, tokenMint);
  if (!run) return null;
  if (!processAlive(run.pid)) {
    deleteRunIfMatches(slrd, tokenMint, run.runId);
    return null;
  }
  return run;
}

export function getHolderRewardDistributionState(
  slrd: Solard,
  tokenRef: TokenRef,
): HolderRewardDistributionState | null {
  const tokenMint = slrd.resolveToken(tokenRef).mint;
  return readState(slrd, tokenMint);
}

export function getHolderRewardDistributionAudit(
  slrd: Solard,
  tokenRef: TokenRef,
  holderInput?: string | PublicKey,
): HolderRewardDistributionAudit | null {
  const state = getHolderRewardDistributionState(slrd, tokenRef);
  if (!state) return null;
  const holder =
    holderInput == null
      ? null
      : holderInput instanceof PublicKey
        ? holderInput.toBase58()
        : new PublicKey(String(holderInput).trim()).toBase58();
  const currentTotals = totals(state);
  const recipients = state.recipients
    .filter((row) => holder == null || row.wallet === holder)
    .map((row): HolderRewardRecipientAudit => {
      const entitledRaw = BigInt(row.entitledRaw);
      const confirmedPaidRaw = BigInt(row.confirmedPaidRaw);
      return {
        wallet: row.wallet,
        entitledRaw: row.entitledRaw,
        confirmedPaidRaw: row.confirmedPaidRaw,
        outstandingRaw: (entitledRaw - confirmedPaidRaw).toString(),
        entitlementEvents: state.entitlementEvents
          .filter((event) => event.wallet === row.wallet)
          .map((event) => ({ ...event })),
        payments: state.receipts.flatMap((receipt) =>
          receipt.payments
            .filter((payment) => payment.wallet === row.wallet)
            .map((payment) => ({
              signature: receipt.signature,
              amountRaw: payment.amountRaw,
              slot: receipt.slot,
              confirmedAtMs: receipt.confirmedAtMs,
            })),
        ),
      };
    });
  return {
    version: 4,
    tokenMint: state.tokenMint,
    sourceWallet: state.sourceWallet,
    rewardAsset: { ...state.rewardAsset },
    status: state.status,
    totalEntitledRaw: currentTotals.totalEntitledRaw.toString(),
    totalConfirmedPaidRaw: currentTotals.totalConfirmedPaidRaw.toString(),
    totalOutstandingRaw: currentTotals.totalOutstandingRaw.toString(),
    pending: state.pending
      ? {
          ...state.pending,
          payments: state.pending.payments.map((row) => ({ ...row })),
        }
      : null,
    snapshots: state.snapshots.map((row) => ({ ...row })),
    recipients,
    receipts: state.receipts.map((receipt) => ({
      ...receipt,
      payments: receipt.payments.map((row) => ({ ...row })),
    })),
    lastError: state.lastError,
    uncertainReason: state.uncertainReason,
    createdAtMs: state.createdAtMs,
    updatedAtMs: state.updatedAtMs,
  };
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

function sameAssetState(
  left: HolderRewardDistributionState["rewardAsset"],
  right: HolderRewardDistributionState["rewardAsset"],
): boolean {
  return (
    left.kind === right.kind &&
    left.mint === right.mint &&
    left.tokenProgram === right.tokenProgram &&
    left.decimals === right.decimals
  );
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

function normalizeSnapshot(
  input: HolderRewardEntitlementSnapshotInput,
): NormalizedSnapshot {
  const inputRecipients = Array.isArray(input) ? input : input.recipients;
  if (!Array.isArray(inputRecipients))
    throw new Error("snapshot recipients must be an array");
  const recipients = inputRecipients.map((row, index) => {
    if (!row) throw new Error(`snapshot recipient ${index + 1} is required`);
    const wallet =
      row.wallet instanceof PublicKey
        ? row.wallet.toBase58()
        : new PublicKey(String(row.wallet).trim()).toBase58();
    return {
      wallet,
      entitledRaw: rawInteger(
        row.entitledRaw,
        `snapshot.recipients[${index}].entitledRaw`,
      ),
    };
  });
  const unique = new Set(recipients.map((row) => row.wallet));
  if (unique.size !== recipients.length)
    throw new Error("snapshot.recipients contains duplicate wallets");
  recipients.sort((left, right) => left.wallet.localeCompare(right.wallet));
  const derivedTotal = recipients.reduce(
    (sum, row) => sum + row.entitledRaw,
    0n,
  );
  const totalInput = Array.isArray(input) ? undefined : input.totalEntitledRaw;
  const totalEntitledRaw =
    totalInput == null
      ? derivedTotal
      : rawInteger(totalInput, "snapshot.totalEntitledRaw");
  if (totalEntitledRaw !== derivedTotal) {
    throw new Error(
      `snapshot.totalEntitledRaw ${totalEntitledRaw} does not equal the sum of recipient entitlements ${derivedTotal}`,
    );
  }
  const observedInput = Array.isArray(input) ? null : input.observedAtMs;
  const observedAtMs = observedInput == null ? null : Number(observedInput);
  if (
    observedAtMs != null &&
    (!Number.isFinite(observedAtMs) || observedAtMs < 0)
  )
    throw new Error("snapshot.observedAtMs must be a non-negative number");
  const canonical = JSON.stringify({
    recipients: recipients.map((row) => ({
      wallet: row.wallet,
      entitledRaw: row.entitledRaw.toString(),
    })),
    totalEntitledRaw: totalEntitledRaw.toString(),
    observedAtMs,
  });
  return {
    recipients,
    totalEntitledRaw,
    observedAtMs,
    hash: createHash("sha256").update(canonical).digest("hex"),
  };
}

function totals(state: HolderRewardDistributionState): {
  totalEntitledRaw: bigint;
  totalConfirmedPaidRaw: bigint;
  totalOutstandingRaw: bigint;
} {
  let totalEntitledRaw = 0n;
  let totalConfirmedPaidRaw = 0n;
  for (const row of state.recipients) {
    totalEntitledRaw += BigInt(row.entitledRaw);
    totalConfirmedPaidRaw += BigInt(row.confirmedPaidRaw);
  }
  return {
    totalEntitledRaw,
    totalConfirmedPaidRaw,
    totalOutstandingRaw: totalEntitledRaw - totalConfirmedPaidRaw,
  };
}

function outstandingRecipients(
  state: HolderRewardDistributionState,
): HolderRewardOutstandingRecipient[] {
  const rows: HolderRewardOutstandingRecipient[] = [];
  for (const row of state.recipients) {
    const entitledRaw = BigInt(row.entitledRaw);
    const confirmedPaidRaw = BigInt(row.confirmedPaidRaw);
    if (confirmedPaidRaw > entitledRaw) {
      throw new Error(
        `Reward state corruption for ${row.wallet}: confirmed paid exceeds entitlement`,
      );
    }
    const outstandingRaw = entitledRaw - confirmedPaidRaw;
    if (outstandingRaw <= 0n) continue;
    rows.push({
      wallet: row.wallet,
      entitledRaw,
      confirmedPaidRaw,
      outstandingRaw,
    });
  }
  rows.sort((left, right) => {
    if (left.outstandingRaw > right.outstandingRaw) return -1;
    if (left.outstandingRaw < right.outstandingRaw) return 1;
    return left.wallet.localeCompare(right.wallet);
  });
  return rows;
}

function refreshStatus(state: HolderRewardDistributionState): void {
  if (state.status === "uncertain") return;
  if (state.pending) {
    state.status = "distributing";
    return;
  }
  state.status = outstandingRecipients(state).length ? "ready" : "complete";
}

function applySnapshot(
  state: HolderRewardDistributionState,
  snapshot: NormalizedSnapshot,
): void {
  const alreadyAccepted = state.snapshots.find(
    (row) => row.hash === snapshot.hash,
  );
  if (alreadyAccepted) return;

  const snapshotWallets = new Set(snapshot.recipients.map((row) => row.wallet));
  const missingExisting = state.recipients
    .map((row) => row.wallet)
    .filter((wallet) => !snapshotWallets.has(wallet));
  if (missingExisting.length) {
    throw new Error(
      `Cumulative reward snapshot must include every previously entitled wallet; missing ${missingExisting.join(", ")}`,
    );
  }

  const nextRecipients = state.recipients.map((row) => ({ ...row }));
  const byWallet = new Map(nextRecipients.map((row) => [row.wallet, row]));
  const acceptedAtMs = Date.now();
  const events: HolderRewardEntitlementEvent[] = [];

  for (const input of snapshot.recipients) {
    const existing = byWallet.get(input.wallet);
    const previous = existing ? BigInt(existing.entitledRaw) : 0n;
    if (input.entitledRaw < previous) {
      throw new Error(
        `Cumulative entitlement for ${input.wallet} cannot decrease from ${previous} to ${input.entitledRaw}`,
      );
    }
    if (!existing) {
      const row: HolderRewardRecipientState = {
        wallet: input.wallet,
        entitledRaw: input.entitledRaw.toString(),
        confirmedPaidRaw: "0",
      };
      nextRecipients.push(row);
      byWallet.set(input.wallet, row);
    } else {
      existing.entitledRaw = input.entitledRaw.toString();
    }
    const deltaRaw = input.entitledRaw - previous;
    if (deltaRaw > 0n) {
      events.push({
        snapshotHash: snapshot.hash,
        wallet: input.wallet,
        previousEntitledRaw: previous.toString(),
        entitledRaw: input.entitledRaw.toString(),
        deltaRaw: deltaRaw.toString(),
        acceptedAtMs,
      });
    }
  }

  nextRecipients.sort((left, right) => left.wallet.localeCompare(right.wallet));
  const totalEntitledRaw = nextRecipients.reduce(
    (sum, row) => sum + BigInt(row.entitledRaw),
    0n,
  );
  if (totalEntitledRaw !== snapshot.totalEntitledRaw) {
    throw new Error(
      `Cumulative holder entitlements ${totalEntitledRaw} do not match snapshot total ${snapshot.totalEntitledRaw}`,
    );
  }
  const totalConfirmedPaidRaw = nextRecipients.reduce(
    (sum, row) => sum + BigInt(row.confirmedPaidRaw),
    0n,
  );
  if (totalConfirmedPaidRaw > totalEntitledRaw) {
    throw new Error(
      `Reward state corruption: confirmed paid ${totalConfirmedPaidRaw} exceeds entitlement ${totalEntitledRaw}`,
    );
  }

  state.recipients = nextRecipients;
  state.entitlementEvents.push(...events);
  state.snapshots.push({
    hash: snapshot.hash,
    totalEntitledRaw: snapshot.totalEntitledRaw.toString(),
    recipientCount: snapshot.recipients.length,
    observedAtMs: snapshot.observedAtMs,
    acceptedAtMs,
  });
  state.lastError = null;
  state.uncertainReason = null;
  refreshStatus(state);
}

function paymentCandidates(
  rows: HolderRewardOutstandingRecipient[],
  availableRaw: bigint,
  recipientLimit = DEFAULT_CANDIDATE_RECIPIENTS,
): TransferManyAllocation[] {
  let remaining = availableRaw;
  const allocations: TransferManyAllocation[] = [];
  const limit = Math.max(1, Math.trunc(recipientLimit));
  for (
    let index = 0;
    index < rows.length && remaining > 0n && allocations.length < limit;
    index += 1
  ) {
    const row = rows[index]!;
    const amountRaw =
      row.outstandingRaw < remaining ? row.outstandingRaw : remaining;
    if (amountRaw <= 0n) continue;
    allocations.push({
      id: `outstanding-${index + 1}`,
      recipient: row.wallet,
      amountRaw,
    });
    remaining -= amountRaw;
  }
  return allocations;
}

async function ensureState(args: {
  slrd: Solard;
  tokenMint: string;
  sourceWallet: string;
  rewardAsset: QuoteAsset;
  reserveRaw: bigint;
}): Promise<HolderRewardDistributionState> {
  const existing = readState(args.slrd, args.tokenMint);
  const rewardAsset = assetState(args.rewardAsset);
  if (existing) {
    if (existing.sourceWallet !== args.sourceWallet) {
      throw new Error(
        `Token ${args.tokenMint} reward distribution already belongs to source wallet ${existing.sourceWallet}, not ${args.sourceWallet}`,
      );
    }
    if (!sameAssetState(existing.rewardAsset, rewardAsset)) {
      throw new Error(
        `Token ${args.tokenMint} reward distribution already uses reward mint ${existing.rewardAsset.mint}`,
      );
    }
    existing.reserveRaw = args.reserveRaw.toString();
    return existing;
  }
  const now = Date.now();
  return {
    version: 4,
    tokenMint: args.tokenMint,
    sourceWallet: args.sourceWallet,
    rewardAsset,
    status: "complete",
    recipients: [],
    snapshots: [],
    entitlementEvents: [],
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
    throw new Error("Compiled transaction is missing the payer signature");
  return bs58.encode(bytes);
}

async function reconcileSignature(
  slrd: Solard,
  pending: HolderRewardPendingTransaction,
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
  const currentBlockHeight = await slrd
    .connection()
    .getBlockHeight("confirmed");
  return { kind: "not-found", currentBlockHeight };
}

function signedTransactionBase64(transaction: VersionedTransaction): string {
  return Buffer.from(transaction.serialize()).toString("base64");
}

function decodeSignedTransaction(base64: string): VersionedTransaction {
  return VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
}

async function broadcastPersistedTransaction(args: {
  slrd: Solard;
  state: HolderRewardDistributionState;
  pending: HolderRewardPendingTransaction;
  via?: SenderId;
  skipPreflight?: boolean;
}): Promise<void> {
  const sender = String(args.via ?? args.pending.sender ?? "rpc");
  args.pending.sender = sender;
  args.pending.broadcastAttempts += 1;
  args.pending.lastBroadcastAtMs = Date.now();
  args.state.lastError = null;
  writeState(args.slrd, args.state);
  const transaction = decodeSignedTransaction(
    args.pending.signedTransactionBase64,
  );
  const returned = await args.slrd.senders.resolve(sender).send({
    connection: args.slrd.connection(),
    transaction,
    options: { skipPreflight: args.skipPreflight },
  });
  if (returned !== args.pending.signature) {
    args.state.status = "uncertain";
    args.state.uncertainReason = `Sender returned signature ${returned}, but persisted reward transaction signature is ${args.pending.signature}`;
    args.state.lastError = args.state.uncertainReason;
    writeState(args.slrd, args.state);
    throw new Error(args.state.uncertainReason);
  }
}

function applyConfirmedPayments(
  state: HolderRewardDistributionState,
  payments: HolderRewardPayment[],
): void {
  const byWallet = new Map(state.recipients.map((row) => [row.wallet, row]));
  for (const payment of payments) {
    const row = byWallet.get(payment.wallet);
    if (!row)
      throw new Error(
        `Reward state corruption: payment recipient ${payment.wallet} has no entitlement row`,
      );
    const next = BigInt(row.confirmedPaidRaw) + BigInt(payment.amountRaw);
    const entitled = BigInt(row.entitledRaw);
    if (next > entitled) {
      throw new Error(
        `Reward state corruption for ${payment.wallet}: confirmed payment would exceed entitlement`,
      );
    }
    row.confirmedPaidRaw = next.toString();
  }
  refreshStatus(state);
}

function recordReceipt(
  state: HolderRewardDistributionState,
  pending: HolderRewardPendingTransaction,
  receipt: SendReceipt | null,
): void {
  state.receipts.push({
    kind: "distribution",
    signature: pending.signature,
    sender: pending.sender,
    payments: pending.payments.map((row) => ({ ...row })),
    slot: receipt?.slot ?? null,
    feeLamports: receipt?.feeLamports ?? null,
    confirmedAtMs: Date.now(),
  });
}

async function buildPlan(args: {
  slrd: Solard;
  state: HolderRewardDistributionState;
  snapshotHash: string;
  maxRecipientsPerTransaction?: number;
}): Promise<HolderRewardDistributionPlan> {
  const rewardAsset = assetFromState(args.state.rewardAsset);
  const source = new PublicKey(args.state.sourceWallet);
  const sourceBalanceRaw = await assetBalance(args.slrd, source, rewardAsset);
  const reserveRaw = BigInt(args.state.reserveRaw);
  const availableRaw =
    sourceBalanceRaw > reserveRaw ? sourceBalanceRaw - reserveRaw : 0n;
  const outstanding = outstandingRecipients(args.state);
  const currentTotals = totals(args.state);
  let nextPayments: HolderRewardDistributionPlan["nextPayments"] = [];
  let transferPlan: PackedTransferPlan | null = null;
  if (
    !args.state.pending &&
    args.state.status !== "uncertain" &&
    outstanding.length &&
    availableRaw > 0n
  ) {
    const allocations = paymentCandidates(
      outstanding,
      availableRaw,
      args.maxRecipientsPerTransaction ?? DEFAULT_CANDIDATE_RECIPIENTS,
    );
    if (allocations.length) {
      transferPlan = await packTransferMany({
        connection: args.slrd.connection(),
        payer: source,
        asset: rewardAsset,
        allocations,
        altAddresses: args.slrd.alts.list().map((row) => row.address),
        priorityMicroLamports: 0,
        maxRecipientsPerTransaction: args.maxRecipientsPerTransaction,
      });
      nextPayments =
        transferPlan.batches[0]?.allocations.map((row) => ({
          id: row.id,
          recipient: row.recipient,
          amountRaw: row.amountRaw,
        })) ?? [];
    }
  }
  return {
    version: 4,
    tokenMint: args.state.tokenMint,
    sourceWallet: args.state.sourceWallet,
    rewardAsset: args.state.rewardAsset,
    snapshotHash: args.snapshotHash,
    totalEntitledRaw: currentTotals.totalEntitledRaw,
    totalConfirmedPaidRaw: currentTotals.totalConfirmedPaidRaw,
    totalOutstandingRaw: currentTotals.totalOutstandingRaw,
    sourceBalanceRaw,
    availableRaw,
    reserveRaw,
    outstanding,
    nextPayments,
    transferPlan,
    pending: args.state.pending,
  };
}

export async function planHolderRewardDistribution(
  slrd: Solard,
  options: HolderRewardPlanOptions,
): Promise<HolderRewardDistributionPlan> {
  const token = slrd.resolveToken(options.token);
  const source = slrd.resolveWallet(options.wallet).address;
  const reserveRaw = options.reserveRaw ?? 0n;
  if (reserveRaw < 0n) throw new Error("reserveRaw cannot be negative");
  const rewardAsset = await resolveRewardAsset(
    slrd,
    token.mint,
    options.rewardMint,
  );
  const current = await ensureState({
    slrd,
    tokenMint: token.mint,
    sourceWallet: source.toBase58(),
    rewardAsset,
    reserveRaw,
  });
  const preview = cloneState(current);
  const snapshot = normalizeSnapshot(options.snapshot);
  applySnapshot(preview, snapshot);
  return await buildPlan({
    slrd,
    state: preview,
    snapshotHash: snapshot.hash,
    maxRecipientsPerTransaction: options.maxRecipientsPerTransaction,
  });
}

async function waitForPending(args: {
  slrd: Solard;
  state: HolderRewardDistributionState;
  run: HolderRewardRunState;
  via?: SenderId;
  skipPreflight?: boolean;
}): Promise<"confirmed" | "stopped"> {
  const pending = args.state.pending;
  if (!pending)
    throw new Error("Internal reward state error: no pending transaction");

  while (true) {
    if (stopRequested(args.slrd, args.run)) {
      args.state.status = "stopped";
      writeState(args.slrd, args.state);
      return "stopped";
    }

    const outcome = await reconcileSignature(args.slrd, pending);
    if (outcome.kind === "confirmed") {
      applyConfirmedPayments(args.state, pending.payments);
      recordReceipt(args.state, pending, outcome.receipt);
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
        outcome.error ?? "Reward transaction failed on-chain";
      args.state.uncertainReason = null;
      writeState(args.slrd, args.state);
      throw new Error(args.state.lastError);
    }
    if (outcome.kind === "not-found") {
      if (outcome.currentBlockHeight > pending.lastValidBlockHeight) {
        args.state.status = "uncertain";
        args.state.uncertainReason =
          `Reward transaction ${pending.signature} was not found after blockhash expiry ` +
          `(current=${outcome.currentBlockHeight}, lastValid=${pending.lastValidBlockHeight}). ` +
          "No replacement payment will be built until that signature is resolved.";
        args.state.lastError = args.state.uncertainReason;
        writeState(args.slrd, args.state);
        throw new Error(args.state.uncertainReason);
      }
      if (
        pending.broadcastAttempts === 0 ||
        pending.lastBroadcastAtMs == null ||
        Date.now() - pending.lastBroadcastAtMs >= PENDING_POLL_MS
      ) {
        await broadcastPersistedTransaction({
          slrd: args.slrd,
          state: args.state,
          pending,
          via: args.via,
          skipPreflight: args.skipPreflight,
        });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, PENDING_POLL_MS));
  }
}

async function driveDistribution(args: {
  slrd: Solard;
  state: HolderRewardDistributionState;
  run: HolderRewardRunState;
  wallet: WalletRef;
  via?: SenderId;
  maxRecipientsPerTransaction?: number;
  skipSimulation?: boolean;
  skipPreflight?: boolean;
}): Promise<HolderRewardDistributionState> {
  const source = args.slrd.resolveWallet(args.wallet).address;
  if (source.toBase58() !== args.state.sourceWallet) {
    throw new Error(
      `Token ${args.state.tokenMint} reward distribution belongs to source wallet ${args.state.sourceWallet}, not ${source.toBase58()}`,
    );
  }
  const rewardAsset = assetFromState(args.state.rewardAsset);
  const reserveRaw = BigInt(args.state.reserveRaw);

  if (args.state.pending) {
    const result = await waitForPending({
      slrd: args.slrd,
      state: args.state,
      run: args.run,
      via: args.via,
      skipPreflight: args.skipPreflight,
    });
    if (result === "stopped") return args.state;
  }

  while (true) {
    if (stopRequested(args.slrd, args.run)) {
      args.state.status = "stopped";
      writeState(args.slrd, args.state);
      return args.state;
    }

    const outstanding = outstandingRecipients(args.state);
    if (!outstanding.length) {
      args.state.status = "complete";
      args.state.lastError = null;
      writeState(args.slrd, args.state);
      return args.state;
    }

    const balanceRaw = await assetBalance(args.slrd, source, rewardAsset);
    const availableRaw = balanceRaw > reserveRaw ? balanceRaw - reserveRaw : 0n;
    if (availableRaw <= 0n) {
      args.state.status = "funding-required";
      const remaining = totals(args.state).totalOutstandingRaw;
      args.state.lastError =
        `Reward distribution for ${args.state.tokenMint} still owes ${remaining} raw units, ` +
        `but source wallet ${args.state.sourceWallet} has no distributable ${args.state.rewardAsset.mint} balance.`;
      writeState(args.slrd, args.state);
      throw new Error(args.state.lastError);
    }

    const allocations = paymentCandidates(
      outstanding,
      availableRaw,
      args.maxRecipientsPerTransaction ?? DEFAULT_CANDIDATE_RECIPIENTS,
    );
    const packed = await packTransferMany({
      connection: args.slrd.connection(),
      payer: source,
      asset: rewardAsset,
      allocations,
      altAddresses: args.slrd.alts.list().map((row) => row.address),
      priorityMicroLamports: 0,
      maxRecipientsPerTransaction: args.maxRecipientsPerTransaction,
    });
    const next = packed.batches[0];
    if (!next)
      throw new Error(
        "No transfer batch could be built for outstanding rewards",
      );

    const compiled = await args.slrd.compile(
      args.slrd.signer(args.wallet),
      next.draft,
    );
    if (!args.skipSimulation) {
      const simulation = await args.slrd.simulatePlan(compiled);
      if (!simulation.success) {
        throw new Error(
          `Reward distribution simulation failed: ${JSON.stringify(simulation.error)}\n${simulation.logs.join("\n")}`,
        );
      }
    }

    if (stopRequested(args.slrd, args.run)) {
      args.state.status = "stopped";
      writeState(args.slrd, args.state);
      return args.state;
    }

    const signature = signedPlanSignature(compiled);
    const pending: HolderRewardPendingTransaction = {
      kind: "distribution",
      signature,
      sender: String(args.via ?? "rpc"),
      recentBlockhash: compiled.recentBlockhash,
      lastValidBlockHeight: compiled.lastValidBlockHeight,
      payments: next.allocations.map((row) => ({
        wallet: row.recipient,
        amountRaw: row.amountRaw.toString(),
      })),
      signedTransactionBase64: signedTransactionBase64(compiled.transaction),
      broadcastAttempts: 0,
      lastBroadcastAtMs: null,
      createdAtMs: Date.now(),
    };
    args.state.status = "distributing";
    args.state.pending = pending;
    args.state.lastError = null;
    args.state.uncertainReason = null;
    writeState(args.slrd, args.state);

    if (stopRequested(args.slrd, args.run)) {
      args.state.status = "stopped";
      writeState(args.slrd, args.state);
      return args.state;
    }

    await broadcastPersistedTransaction({
      slrd: args.slrd,
      state: args.state,
      pending,
      via: args.via,
      skipPreflight: args.skipPreflight,
    });

    const result = await waitForPending({
      slrd: args.slrd,
      state: args.state,
      run: args.run,
      via: args.via,
      skipPreflight: args.skipPreflight,
    });
    if (result === "stopped") return args.state;
  }
}

export async function executeHolderRewardDistribution(
  slrd: Solard,
  options: ExecuteHolderRewardDistributionOptions,
): Promise<HolderRewardDistributionState> {
  const token = slrd.resolveToken(options.token);
  const run = acquireRun(slrd, token.mint);
  try {
    const source = slrd.resolveWallet(options.wallet).address;
    const reserveRaw = options.reserveRaw ?? 0n;
    if (reserveRaw < 0n) throw new Error("reserveRaw cannot be negative");
    const rewardAsset = await resolveRewardAsset(
      slrd,
      token.mint,
      options.rewardMint,
    );
    const state = await ensureState({
      slrd,
      tokenMint: token.mint,
      sourceWallet: source.toBase58(),
      rewardAsset,
      reserveRaw,
    });
    const snapshot = normalizeSnapshot(options.snapshot);
    applySnapshot(state, snapshot);
    writeState(slrd, state);
    return await driveDistribution({
      slrd,
      state,
      run,
      wallet: options.wallet,
      via: options.via,
      maxRecipientsPerTransaction: options.maxRecipientsPerTransaction,
      skipSimulation: options.skipSimulation,
      skipPreflight: options.skipPreflight,
    });
  } finally {
    deleteRunIfMatches(slrd, token.mint, run.runId);
  }
}
