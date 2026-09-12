import { NATIVE_MINT } from "@solana/spl-token";
import {
  PublicKey,
  type Commitment,
  type Connection,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { Buffer } from "buffer";
import { createHash } from "node:crypto";

import { readMint } from "../chain/state.ts";
import { SOL_ASSET, type QuoteAsset } from "../core/amounts.ts";
import type { TokenRow } from "../db/schema.ts";
import {
  historyTokenEvents,
  type TokenEventHistory,
  type TokenEventHistoryOptions,
} from "./token-event-history.ts";
import type { SolardTokenTransferEvent } from "./token-events.ts";
import {
  claimPhysicalId,
  type SolardCanonicalEvent,
  type SolardClaimAttribution,
  type SolardClaimEvent,
} from "./canonical-events.ts";
import { parsePumpCreateData } from "../pump/parsers/pump-create.ts";
import {
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
} from "../venues/pump/constants.ts";
import { ammCreatorVaultPda, creatorVaultPda } from "../venues/pump/pda.ts";
import { creatorRewardPayoutDelta } from "../rewards/creator-claim.ts";

const DIRECT_PUMP_CLAIMS = new Map([
  [discriminatorHex("collect_creator_fee"), "collect_creator_fee"],
  [discriminatorHex("collect_creator_fee_v2"), "collect_creator_fee_v2"],
]);
const DIRECT_AMM_CLAIMS = new Map([
  [discriminatorHex("collect_coin_creator_fee"), "collect_coin_creator_fee"],
]);
const SHARED_PUMP_CLAIMS = new Map([
  [discriminatorHex("distribute_creator_fees"), "distribute_creator_fees"],
  [
    discriminatorHex("distribute_creator_fees_v2"),
    "distribute_creator_fees_v2",
  ],
]);
const PUMP_CURVE_TRADES = new Map([
  [discriminatorHex("buy"), { kind: "buy", version: "legacy" }],
  [discriminatorHex("sell"), { kind: "sell", version: "legacy" }],
  [discriminatorHex("buy_v2"), { kind: "buy_v2", version: "v2" }],
  [
    discriminatorHex("buy_exact_quote_in_v2"),
    { kind: "buy_exact_quote_in_v2", version: "v2" },
  ],
  [discriminatorHex("sell_v2"), { kind: "sell_v2", version: "v2" }],
]);
const PUMP_AMM_TRADES = new Map([
  [discriminatorHex("buy"), "buy"],
  [discriminatorHex("sell"), "sell"],
  [discriminatorHex("buy_exact_quote_in"), "buy_exact_quote_in"],
]);

export type HistoricalCreatorRewardAttribution = SolardClaimAttribution;

export type HistoricalCreatorRewardClaimEvent = SolardClaimEvent;

export type CreatorRewardHistoryCoverage = {
  version: 1;
  tokenMint: string;
  quoteMint: string;
  recipient: string;
  originalCreator: string | null;
  creationSlot: number | null;
  status: "complete" | "partial";
  fromCreation: boolean;
  ordering: "slot-only" | "transaction";
  directAttribution: "unused" | "exclusive" | "ambiguous";
  curveVaultHistoryExhausted: boolean;
  ammVaultHistoryExhausted: boolean;
  targetHistoryExhausted: boolean;
  targetSignaturePages: number;
  curveVaultSignaturePages: number;
  ammVaultSignaturePages: number;
  fetchedTransactions: number;
  missingTransactions: number;
  exactClaims: number;
  ambiguousClaims: number;
  exactPayoutClaims: number;
  fallbackPayoutClaims: number;
  authoritativeForRewardReplay: boolean;
  warnings: string[];
};

export type CreatorRewardHistoryOptions = {
  recipient?: string | PublicKey;
  commitment?: Extract<Commitment, "confirmed" | "finalized">;
  fromSlot?: number;
  toSlot?: number;
  maxPages?: number;
  exactOrdering?: boolean;
};

export type CreatorRewardHistory =
  AsyncIterable<HistoricalCreatorRewardClaimEvent> & {
    readonly tokenMint: string;
    readonly recipient: string;
    readonly claims: readonly HistoricalCreatorRewardClaimEvent[];
    readonly coverage: CreatorRewardHistoryCoverage;
  };

export type CanonicalHistoryEvent = SolardCanonicalEvent;

export type CanonicalHistoryOptions = TokenEventHistoryOptions & {
  recipient?: string | PublicKey;
  claimMaxPages?: number;
};

export type CanonicalHistoryCoverage = {
  version: 1;
  authoritative: boolean;
  tokenBalancesAuthoritative: boolean;
  creatorRewardsAuthoritative: boolean;
  warnings: string[];
};

export type CanonicalHistory = AsyncIterable<CanonicalHistoryEvent> & {
  readonly tokenMint: string;
  readonly recipient: string;
  readonly events: readonly CanonicalHistoryEvent[];
  readonly transfers: readonly SolardTokenTransferEvent[];
  readonly claims: readonly HistoricalCreatorRewardClaimEvent[];
  readonly tokenHistory: TokenEventHistory;
  readonly claimHistory: CreatorRewardHistory;
  readonly coverage: CanonicalHistoryCoverage;
};

type InstructionRow = {
  programId: string;
  accounts: string[];
  data: Buffer | null;
  instructionIndex: number;
  innerInstructionIndex: number | null;
};

type AddressSignatureScan = {
  rows: Array<{ signature: string; slot: number }>;
  pages: number;
  exhausted: boolean;
  truncated: boolean;
};

type PumpCreation = {
  mint: string;
  creator: string;
  quoteMint: string;
  signature: string;
  slot: number;
};

type TransactionSet = {
  bySignature: Map<string, ParsedTransactionWithMeta>;
  missing: number;
};

type ClaimClassification = {
  sharedForTarget: boolean;
  directForRecipient: boolean;
  directQuoteMatches: boolean;
  claimKinds: string[];
  instructionIndex: number | null;
  innerInstructionIndex: number | null;
};

function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function discriminatorHex(name: string): string {
  return anchorDiscriminator(name).toString("hex");
}

function publicKeyText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof (value as any).toBase58 === "function") {
    return (value as any).toBase58();
  }
  if (value && typeof (value as any).pubkey?.toBase58 === "function") {
    return (value as any).pubkey.toBase58();
  }
  return null;
}

function instructionRows(tx: ParsedTransactionWithMeta): InstructionRow[] {
  const rows: InstructionRow[] = [];
  const top = tx.transaction.message.instructions as unknown[];
  for (let index = 0; index < top.length; index += 1) {
    const value = top[index] as any;
    const programId = publicKeyText(value?.programId);
    if (!programId) continue;
    rows.push({
      programId,
      accounts: Array.isArray(value?.accounts)
        ? (value.accounts.map(publicKeyText).filter(Boolean) as string[])
        : [],
      data: typeof value?.data === "string" ? decodeData(value.data) : null,
      instructionIndex: index,
      innerInstructionIndex: null,
    });
  }
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (let inner = 0; inner < group.instructions.length; inner += 1) {
      const value = group.instructions[inner] as any;
      const programId = publicKeyText(value?.programId);
      if (!programId) continue;
      rows.push({
        programId,
        accounts: Array.isArray(value?.accounts)
          ? (value.accounts.map(publicKeyText).filter(Boolean) as string[])
          : [],
        data: typeof value?.data === "string" ? decodeData(value.data) : null,
        instructionIndex: group.index,
        innerInstructionIndex: inner,
      });
    }
  }
  return rows;
}

function decodeData(value: string): Buffer | null {
  try {
    return Buffer.from(bs58.decode(value));
  } catch {
    return null;
  }
}

function d8(row: InstructionRow): string | null {
  return row.data && row.data.length >= 8
    ? row.data.subarray(0, 8).toString("hex")
    : null;
}

function comparePosition(
  left: { instructionIndex: number; innerInstructionIndex: number | null },
  right: { instructionIndex: number; innerInstructionIndex: number | null },
): number {
  return (
    left.instructionIndex - right.instructionIndex ||
    (left.innerInstructionIndex ?? -1) - (right.innerInstructionIndex ?? -1)
  );
}

function eventSort(
  left: HistoricalRewardReplayEvent,
  right: HistoricalRewardReplayEvent,
): number {
  return (
    left.slot - right.slot ||
    (left.transactionIndex ?? Number.MAX_SAFE_INTEGER) -
      (right.transactionIndex ?? Number.MAX_SAFE_INTEGER) ||
    (left.instructionIndex ?? Number.MAX_SAFE_INTEGER) -
      (right.instructionIndex ?? Number.MAX_SAFE_INTEGER) ||
    (left.innerInstructionIndex ?? Number.MAX_SAFE_INTEGER) -
      (right.innerInstructionIndex ?? Number.MAX_SAFE_INTEGER) ||
    left.signature.localeCompare(right.signature) ||
    left.id.localeCompare(right.id)
  );
}

function feePayer(tx: ParsedTransactionWithMeta): PublicKey | null {
  const first = tx.transaction.message.accountKeys[0];
  const text = publicKeyText(first);
  return text ? new PublicKey(text) : null;
}

function accountKeys(tx: ParsedTransactionWithMeta): string[] {
  return tx.transaction.message.accountKeys.map((row: { pubkey: PublicKey }) =>
    row.pubkey.toBase58(),
  );
}

function bigintValue(value: unknown): bigint | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  return null;
}

function parsedTransferRaw(info: Record<string, unknown>): bigint | null {
  const direct = bigintValue(info.amount);
  if (direct != null) return direct;
  if (info.tokenAmount && typeof info.tokenAmount === "object") {
    return bigintValue((info.tokenAmount as Record<string, unknown>).amount);
  }
  return null;
}

function recipientTokenAccounts(
  tx: ParsedTransactionWithMeta,
  recipient: string,
  mint: string,
): Set<string> {
  const keys = accountKeys(tx);
  const accounts = new Set<string>();
  for (const row of [
    ...(tx.meta?.preTokenBalances ?? []),
    ...(tx.meta?.postTokenBalances ?? []),
  ]) {
    if (row.owner !== recipient || row.mint !== mint) continue;
    const address = keys[row.accountIndex];
    if (address) accounts.add(address);
  }
  return accounts;
}

function claimInstructionPayoutRaw(args: {
  tx: ParsedTransactionWithMeta;
  recipient: string;
  asset: QuoteAsset;
  parentInstructionIndexes: ReadonlySet<number>;
}): bigint | null {
  if (!args.parentInstructionIndexes.size) return null;
  const tokenAccounts =
    args.asset.kind === "spl-token"
      ? recipientTokenAccounts(
          args.tx,
          args.recipient,
          args.asset.mint.toBase58(),
        )
      : new Set<string>();
  let total = 0n;
  let found = false;
  for (const group of args.tx.meta?.innerInstructions ?? []) {
    if (!args.parentInstructionIndexes.has(group.index)) continue;
    for (const instruction of group.instructions as any[]) {
      if (!("parsed" in instruction)) continue;
      const parsed = instruction.parsed as
        { type?: unknown; info?: Record<string, unknown> } | undefined;
      const type = String(parsed?.type ?? "");
      const info = parsed?.info ?? {};
      if (!/^transfer(?:Checked|CheckedWithFee)?$/i.test(type)) continue;
      if (args.asset.kind === "native-sol") {
        if (instruction.program !== "system") continue;
        if (info.destination !== args.recipient) continue;
        const lamports = bigintValue(info.lamports);
        if (lamports == null || lamports <= 0n) continue;
        total += lamports;
        found = true;
        continue;
      }
      const destination =
        typeof info.destination === "string" ? info.destination : null;
      if (!destination || !tokenAccounts.has(destination)) continue;
      const raw = parsedTransferRaw(info);
      if (raw == null || raw <= 0n) continue;
      total += raw;
      found = true;
    }
  }
  return found && total > 0n ? total : null;
}

function ownerTokenRaw(
  tx: ParsedTransactionWithMeta,
  owner: string,
  mint: string,
  phase: "pre" | "post",
): bigint | null {
  const rows =
    phase === "pre" ? tx.meta?.preTokenBalances : tx.meta?.postTokenBalances;
  if (!rows) return null;
  let total = 0n;
  let seen = false;
  for (const row of rows) {
    if (row.owner !== owner || row.mint !== mint) continue;
    total += BigInt(row.uiTokenAmount.amount);
    seen = true;
  }
  return seen ? total : null;
}

function sourceVaultPayoutRaw(args: {
  tx: ParsedTransactionWithMeta;
  sourceOwners: readonly string[];
  asset: QuoteAsset;
}): bigint | null {
  let total = 0n;
  let found = false;
  if (args.asset.kind === "native-sol") {
    const keys = accountKeys(args.tx);
    for (const owner of args.sourceOwners) {
      const index = keys.indexOf(owner);
      if (index < 0) continue;
      const before = BigInt(args.tx.meta?.preBalances[index] ?? 0);
      const after = BigInt(args.tx.meta?.postBalances[index] ?? 0);
      if (before <= after) continue;
      total += before - after;
      found = true;
    }
  } else {
    const mint = args.asset.mint.toBase58();
    for (const owner of args.sourceOwners) {
      const before = ownerTokenRaw(args.tx, owner, mint, "pre");
      const after = ownerTokenRaw(args.tx, owner, mint, "post");
      if (before == null || after == null || before <= after) continue;
      total += before - after;
      found = true;
    }
  }
  return found && total > 0n ? total : null;
}

async function quoteAsset(
  connection: Connection,
  token: TokenRow,
): Promise<QuoteAsset> {
  const quote = token.quoteMint?.trim();
  if (!quote || quote === NATIVE_MINT.toBase58()) return SOL_ASSET;
  const mint = new PublicKey(quote);
  const info = await readMint(connection, mint);
  return {
    kind: "spl-token",
    mint,
    tokenProgram: info.tokenProgram,
    decimals: info.decimals,
  };
}

async function scanAddressSignatures(args: {
  connection: Connection;
  address: PublicKey;
  commitment: "confirmed" | "finalized";
  fromSlot?: number;
  toSlot?: number;
  maxPages?: number;
}): Promise<AddressSignatureScan> {
  const rows: AddressSignatureScan["rows"] = [];
  let pages = 0;
  let before: string | undefined;
  let exhausted = false;
  let truncated = false;
  const maxPages =
    args.maxPages == null ? null : Math.max(1, Math.trunc(args.maxPages));
  while (true) {
    if (maxPages != null && pages >= maxPages) {
      truncated = true;
      break;
    }
    const batch = await args.connection.getSignaturesForAddress(
      args.address,
      { before, limit: 1_000 },
      args.commitment,
    );
    pages += 1;
    if (!batch.length) {
      exhausted = true;
      break;
    }
    let crossedStart = false;
    for (const row of batch) {
      if (row.err) continue;
      if (args.toSlot != null && row.slot > args.toSlot) continue;
      if (args.fromSlot != null && row.slot < args.fromSlot) {
        crossedStart = true;
        continue;
      }
      rows.push({ signature: row.signature, slot: row.slot });
    }
    const oldest = batch.at(-1)!;
    if (
      args.fromSlot != null &&
      (crossedStart || oldest.slot < args.fromSlot)
    ) {
      exhausted = true;
      break;
    }
    if (batch.length < 1_000) {
      exhausted = true;
      break;
    }
    before = oldest.signature;
  }
  const unique = new Map<string, { signature: string; slot: number }>();
  for (const row of rows) unique.set(row.signature, row);
  return {
    rows: [...unique.values()].sort(
      (left, right) =>
        left.slot - right.slot || left.signature.localeCompare(right.signature),
    ),
    pages,
    exhausted,
    truncated,
  };
}

async function fetchTransactions(args: {
  connection: Connection;
  signatures: readonly string[];
  commitment: "confirmed" | "finalized";
}): Promise<TransactionSet> {
  const bySignature = new Map<string, ParsedTransactionWithMeta>();
  let missing = 0;
  for (let offset = 0; offset < args.signatures.length; offset += 100) {
    const chunk = args.signatures.slice(offset, offset + 100);
    let txs: Awaited<ReturnType<Connection["getParsedTransactions"]>>;
    try {
      txs = await args.connection.getParsedTransactions([...chunk], {
        commitment: args.commitment,
        maxSupportedTransactionVersion: 0,
      });
    } catch {
      missing += chunk.length;
      continue;
    }
    for (let index = 0; index < chunk.length; index += 1) {
      const tx = txs[index];
      if (!tx || tx.meta?.err) {
        missing += 1;
        continue;
      }
      bySignature.set(chunk[index]!, tx);
    }
  }
  return { bySignature, missing };
}

function parseCreations(
  tx: ParsedTransactionWithMeta,
  signature: string,
): PumpCreation[] {
  const output: PumpCreation[] = [];
  for (const row of instructionRows(tx)) {
    if (row.programId !== PUMP_PROGRAM_ID.toBase58() || !row.data) continue;
    let decoded: ReturnType<typeof parsePumpCreateData> = null;
    try {
      decoded = parsePumpCreateData(bs58.encode(row.data));
    } catch {
      decoded = null;
    }
    if (!decoded || typeof decoded.creator !== "string") continue;
    const mint = row.accounts[0];
    if (!mint) continue;
    const createKind = String(decoded.createKind ?? "");
    const quoteMint =
      createKind === "create_v2" &&
      row.accounts.length >= 19 &&
      row.accounts[16]
        ? row.accounts[16]!
        : NATIVE_MINT.toBase58();
    output.push({
      mint,
      creator: decoded.creator,
      quoteMint,
      signature,
      slot: tx.slot,
    });
  }
  return output;
}

const CREATOR_MUTATIONS = new Set([
  discriminatorHex("set_creator"),
  discriminatorHex("set_metaplex_creator"),
]);

type RewardSource = "curve" | "amm";

type TradeContribution = {
  source: RewardSource;
  mint: string;
  quoteMint: string;
};

type DirectClaimInstruction = {
  source: RewardSource;
  kind: string;
  quoteMint: string;
  recipient: string;
  row: InstructionRow;
};

type SharedClaimInstruction = {
  kind: string;
  mint: string | null;
  quoteMint: string;
  row: InstructionRow;
};

type OrderedTransaction = {
  signature: string;
  tx: ParsedTransactionWithMeta;
  transactionIndex: number | null;
};

function hasTargetCreatorMutation(
  tx: ParsedTransactionWithMeta,
  targetMint: string,
): boolean {
  for (const row of instructionRows(tx)) {
    if (row.programId !== PUMP_PROGRAM_ID.toBase58()) continue;
    const kind = d8(row);
    if (!kind || !CREATOR_MUTATIONS.has(kind)) continue;
    if (row.accounts.includes(targetMint)) return true;
  }
  return false;
}

function directQuoteMint(row: InstructionRow, kind: string): string | null {
  if (kind === "collect_creator_fee_v2") return row.accounts[4] ?? null;
  if (kind === "collect_coin_creator_fee") return row.accounts[0] ?? null;
  if (kind === "collect_creator_fee") return NATIVE_MINT.toBase58();
  return null;
}

function directRecipient(row: InstructionRow, kind: string): string | null {
  if (kind === "collect_creator_fee_v2" || kind === "collect_creator_fee") {
    return row.accounts[0] ?? null;
  }
  if (kind === "collect_coin_creator_fee") return row.accounts[2] ?? null;
  return null;
}

function directClaimInstruction(
  row: InstructionRow,
): DirectClaimInstruction | null {
  const kindHex = d8(row);
  if (!kindHex) return null;
  if (row.programId === PUMP_PROGRAM_ID.toBase58()) {
    const kind = DIRECT_PUMP_CLAIMS.get(kindHex);
    if (!kind) return null;
    const quoteMint = directQuoteMint(row, kind);
    const recipient = directRecipient(row, kind);
    return quoteMint && recipient
      ? { source: "curve", kind, quoteMint, recipient, row }
      : null;
  }
  if (row.programId === PUMP_AMM_PROGRAM_ID.toBase58()) {
    const kind = DIRECT_AMM_CLAIMS.get(kindHex);
    if (!kind) return null;
    const quoteMint = directQuoteMint(row, kind);
    const recipient = directRecipient(row, kind);
    return quoteMint && recipient
      ? { source: "amm", kind, quoteMint, recipient, row }
      : null;
  }
  return null;
}

function sharedClaimInstruction(
  row: InstructionRow,
): SharedClaimInstruction | null {
  if (row.programId !== PUMP_PROGRAM_ID.toBase58()) return null;
  const kindHex = d8(row);
  if (!kindHex) return null;
  const kind = SHARED_PUMP_CLAIMS.get(kindHex);
  if (!kind) return null;
  const mint = row.accounts[1] ?? null;
  const quoteMint =
    kind === "distribute_creator_fees_v2"
      ? (row.accounts[9] ?? NATIVE_MINT.toBase58())
      : NATIVE_MINT.toBase58();
  return { kind, mint, quoteMint, row };
}

function tradeContribution(args: {
  row: InstructionRow;
  curveVault: string | null;
  ammVault: string | null;
}): TradeContribution | null {
  const kindHex = d8(args.row);
  if (!kindHex) return null;
  if (args.row.programId === PUMP_PROGRAM_ID.toBase58()) {
    const trade = PUMP_CURVE_TRADES.get(kindHex);
    if (
      !trade ||
      !args.curveVault ||
      !args.row.accounts.includes(args.curveVault)
    ) {
      return null;
    }
    const mint =
      trade.version === "v2" ? args.row.accounts[1] : args.row.accounts[2];
    const quoteMint =
      trade.version === "v2" ? args.row.accounts[2] : NATIVE_MINT.toBase58();
    return mint && quoteMint ? { source: "curve", mint, quoteMint } : null;
  }
  if (args.row.programId === PUMP_AMM_PROGRAM_ID.toBase58()) {
    if (
      !PUMP_AMM_TRADES.has(kindHex) ||
      !args.ammVault ||
      !args.row.accounts.includes(args.ammVault)
    ) {
      return null;
    }
    const mint = args.row.accounts[3];
    const quoteMint = args.row.accounts[4];
    return mint && quoteMint ? { source: "amm", mint, quoteMint } : null;
  }
  return null;
}

function contributorKey(source: RewardSource, quoteMint: string): string {
  return `${source}:${quoteMint}`;
}

function exactTargetOnly(
  contributors: Map<string, Set<string>>,
  source: RewardSource,
  quoteMint: string,
  targetMint: string,
): boolean {
  const set = contributors.get(contributorKey(source, quoteMint));
  return set?.size === 1 && set.has(targetMint);
}

function clearContributors(
  contributors: Map<string, Set<string>>,
  source: RewardSource,
  quoteMint: string,
): void {
  contributors.delete(contributorKey(source, quoteMint));
}

async function transactionIndexes(args: {
  connection: Connection;
  transactions: ReadonlyMap<string, ParsedTransactionWithMeta>;
  commitment: "confirmed" | "finalized";
}): Promise<{
  indexes: Map<string, number>;
  complete: boolean;
  failures: number;
}> {
  const bySlot = new Map<number, string[]>();
  for (const [signature, tx] of args.transactions) {
    const rows = bySlot.get(tx.slot) ?? [];
    rows.push(signature);
    bySlot.set(tx.slot, rows);
  }
  const indexes = new Map<string, number>();
  let failures = 0;
  let cursor = 0;
  const slots = [...bySlot.keys()].sort((a, b) => a - b);
  const worker = async () => {
    while (true) {
      const slot = slots[cursor++];
      if (slot == null) return;
      try {
        const block = await args.connection.getBlock(slot, {
          commitment: args.commitment,
          transactionDetails: "signatures",
          rewards: false,
          maxSupportedTransactionVersion: 0,
        } as any);
        const signatures = Array.isArray((block as any)?.signatures)
          ? ((block as any).signatures as string[])
          : [];
        const inBlock = new Map(
          signatures.map((signature, index) => [signature, index]),
        );
        for (const signature of bySlot.get(slot) ?? []) {
          const index = inBlock.get(signature);
          if (index == null) failures += 1;
          else indexes.set(signature, index);
        }
      } catch {
        failures += bySlot.get(slot)?.length ?? 1;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(8, slots.length || 1) }, worker),
  );
  return { indexes, complete: failures === 0, failures };
}

function orderedTransactions(args: {
  transactions: ReadonlyMap<string, ParsedTransactionWithMeta>;
  indexes: ReadonlyMap<string, number>;
}): OrderedTransaction[] {
  return [...args.transactions.entries()]
    .map(([signature, tx]) => ({
      signature,
      tx,
      transactionIndex: args.indexes.get(signature) ?? null,
    }))
    .sort(
      (left, right) =>
        left.tx.slot - right.tx.slot ||
        (left.transactionIndex ?? Number.MAX_SAFE_INTEGER) -
          (right.transactionIndex ?? Number.MAX_SAFE_INTEGER) ||
        left.signature.localeCompare(right.signature),
    );
}

function asClaimHistory(args: {
  tokenMint: string;
  recipient: string;
  claims: HistoricalCreatorRewardClaimEvent[];
  coverage: CreatorRewardHistoryCoverage;
}): CreatorRewardHistory {
  const claims = args.claims.sort(eventSort);
  return {
    tokenMint: args.tokenMint,
    recipient: args.recipient,
    claims,
    coverage: args.coverage,
    async *[Symbol.asyncIterator]() {
      for (const claim of claims) yield claim;
    },
  };
}

export async function historyCreatorRewards(args: {
  connection: Connection;
  token: TokenRow;
  options?: CreatorRewardHistoryOptions;
}): Promise<CreatorRewardHistory> {
  const options = args.options ?? {};
  const commitment = options.commitment ?? "finalized";
  const targetMint = new PublicKey(args.token.mint).toBase58();
  const asset = await quoteAsset(args.connection, args.token);
  const quoteMint = asset.mint.toBase58();
  const warnings: string[] = [];

  const targetScan = await scanAddressSignatures({
    connection: args.connection,
    address: new PublicKey(targetMint),
    commitment,
    fromSlot: options.fromSlot,
    toSlot: options.toSlot,
    maxPages: options.maxPages,
  });
  const targetTxs = await fetchTransactions({
    connection: args.connection,
    signatures: targetScan.rows.map((row) => row.signature),
    commitment,
  });
  const targetCreations = [...targetTxs.bySignature.entries()]
    .flatMap(([signature, tx]) => parseCreations(tx, signature))
    .filter((row) => row.mint === targetMint)
    .sort((left, right) => left.slot - right.slot);
  const targetCreation = targetCreations[0] ?? null;
  const originalCreator = targetCreation?.creator ?? args.token.creator ?? null;
  const recipient = new PublicKey(
    options.recipient ??
      originalCreator ??
      (() => {
        throw new Error(
          `Could not determine the creator reward recipient for ${targetMint}; pass options.recipient explicitly.`,
        );
      })(),
  ).toBase58();
  if (!targetCreation && options.fromSlot == null) {
    warnings.push(
      "The Pump creation transaction could not be reconstructed, so creator-reward history cannot be certified from creation.",
    );
  }

  const creatorKey = originalCreator ? new PublicKey(originalCreator) : null;
  const curveVault = creatorKey ? creatorVaultPda(creatorKey) : null;
  const ammVault = creatorKey ? ammCreatorVaultPda(creatorKey) : null;
  const emptyScan = (): AddressSignatureScan => ({
    rows: [],
    pages: 0,
    exhausted: creatorKey == null,
    truncated: false,
  });
  const curveVaultScan = curveVault
    ? await scanAddressSignatures({
        connection: args.connection,
        address: curveVault,
        commitment,
        fromSlot: options.fromSlot,
        toSlot: options.toSlot,
        maxPages: options.maxPages,
      })
    : emptyScan();
  const ammVaultScan = ammVault
    ? await scanAddressSignatures({
        connection: args.connection,
        address: ammVault,
        commitment,
        fromSlot: options.fromSlot,
        toSlot: options.toSlot,
        maxPages: options.maxPages,
      })
    : emptyScan();

  const union = new Set<string>();
  for (const row of [
    ...targetScan.rows,
    ...curveVaultScan.rows,
    ...ammVaultScan.rows,
  ]) {
    union.add(row.signature);
  }
  const fetched = await fetchTransactions({
    connection: args.connection,
    signatures: [...union],
    commitment,
  });
  const ordering = await transactionIndexes({
    connection: args.connection,
    transactions: fetched.bySignature,
    commitment,
  });
  if (!ordering.complete) {
    warnings.push(
      `Exact transaction ordering could not be resolved for ${ordering.failures} creator-vault transaction(s).`,
    );
  }

  const creatorMutationObserved = [...targetTxs.bySignature.values()].some(
    (tx) => hasTargetCreatorMutation(tx, targetMint),
  );
  if (creatorMutationObserved) {
    warnings.push(
      "Creator mutation was observed for this token; historical direct-vault attribution is conservatively non-authoritative across that mutation.",
    );
  }

  const contributors = new Map<string, Set<string>>();
  const claims: HistoricalCreatorRewardClaimEvent[] = [];
  let ambiguousClaims = 0;
  let exactClaims = 0;
  let exactPayoutClaims = 0;
  let fallbackPayoutClaims = 0;
  let directUsed = false;
  const curveVaultText = curveVault?.toBase58() ?? null;
  const ammVaultText = ammVault?.toBase58() ?? null;
  const fromSlot = options.fromSlot ?? targetCreation?.slot ?? null;

  for (const ordered of orderedTransactions({
    transactions: fetched.bySignature,
    indexes: ordering.indexes,
  })) {
    const { signature, tx, transactionIndex } = ordered;
    if (targetCreation && tx.slot < targetCreation.slot) continue;
    if (options.toSlot != null && tx.slot > options.toSlot) continue;
    const rows = instructionRows(tx).sort(comparePosition);
    const directClaims: Array<{
      claim: DirectClaimInstruction;
      exactAtDrain: boolean;
    }> = [];
    const sharedClaims: SharedClaimInstruction[] = [];
    const contributionKeysInTransaction = new Set<string>();

    for (const row of rows) {
      const contribution = tradeContribution({
        row,
        curveVault: curveVaultText,
        ammVault: ammVaultText,
      });
      if (contribution) {
        const key = contributorKey(contribution.source, contribution.quoteMint);
        contributionKeysInTransaction.add(key);
        const set = contributors.get(key) ?? new Set<string>();
        set.add(contribution.mint);
        contributors.set(key, set);
      }
      const direct = directClaimInstruction(row);
      const monitoredDirect =
        direct &&
        ((direct.source === "curve" &&
          curveVaultText != null &&
          row.accounts.includes(curveVaultText)) ||
          (direct.source === "amm" &&
            ammVaultText != null &&
            row.accounts.includes(ammVaultText)))
          ? direct
          : null;
      if (monitoredDirect) {
        directClaims.push({
          claim: monitoredDirect,
          exactAtDrain: exactTargetOnly(
            contributors,
            monitoredDirect.source,
            monitoredDirect.quoteMint,
            targetMint,
          ),
        });
        clearContributors(
          contributors,
          monitoredDirect.source,
          monitoredDirect.quoteMint,
        );
      }
      const shared = sharedClaimInstruction(row);
      if (shared) sharedClaims.push(shared);
    }

    const sameQuoteDirect = directClaims.filter(
      ({ claim }) =>
        claim.quoteMint === quoteMint && claim.recipient === recipient,
    );
    const targetShared = sharedClaims.filter(
      (claim) =>
        claim.mint === targetMint &&
        claim.quoteMint === quoteMint &&
        claim.row.accounts.includes(recipient),
    );
    const otherSharedToRecipient = sharedClaims.some(
      (claim) =>
        claim.mint !== targetMint &&
        claim.quoteMint === quoteMint &&
        claim.row.accounts.includes(recipient),
    );

    let directExact = true;
    if (sameQuoteDirect.length) {
      directUsed = true;
      for (const row of sameQuoteDirect) {
        if (!row.exactAtDrain) directExact = false;
      }
    }

    const relevant = sameQuoteDirect.length > 0 || targetShared.length > 0;
    if (relevant && (fromSlot == null || tx.slot >= fromSlot)) {
      const positions = [
        ...sameQuoteDirect.map((row) => row.claim.row),
        ...targetShared.map((row) => row.row),
      ].sort(comparePosition);
      const parentInstructionIndexes = new Set(
        positions
          .filter((row) => row.innerInstructionIndex == null)
          .map((row) => row.instructionIndex),
      );
      const instructionPayout =
        positions.length > 0 &&
        positions.every((row) => row.innerInstructionIndex == null)
          ? claimInstructionPayoutRaw({
              tx,
              recipient,
              asset,
              parentInstructionIndexes,
            })
          : null;
      const sourceOwners = [
        ...new Set(
          sameQuoteDirect
            .map(({ claim }) =>
              claim.source === "curve" ? curveVaultText : ammVaultText,
            )
            .filter((value): value is string => value != null),
        ),
      ];
      const sourceHasSameTransactionContribution = sameQuoteDirect.some(
        ({ claim }) =>
          contributionKeysInTransaction.has(
            contributorKey(claim.source, claim.quoteMint),
          ),
      );
      const sourcePayout =
        targetShared.length === 0 &&
        sourceOwners.length > 0 &&
        !sourceHasSameTransactionContribution
          ? sourceVaultPayoutRaw({ tx, sourceOwners, asset })
          : null;
      const payer = feePayer(tx);
      const fallbackPayout = payer
        ? creatorRewardPayoutDelta(tx, new PublicKey(recipient), payer, asset)
        : 0n;
      const payoutEvidence =
        instructionPayout != null
          ? "claim-instruction-transfer"
          : sourcePayout != null
            ? "source-vault-delta"
            : "transaction-delta-fallback";
      const amountRaw = instructionPayout ?? sourcePayout ?? fallbackPayout;
      const payoutExact = payoutEvidence !== "transaction-delta-fallback";
      if (payoutExact) exactPayoutClaims += 1;
      else fallbackPayoutClaims += 1;
      if (!payer && !payoutExact) {
        warnings.push(
          `Could not identify fee payer for creator reward claim ${signature}.`,
        );
      }
      if (!payoutExact) {
        warnings.push(
          `Creator reward claim ${signature} uses transaction-delta payout evidence and is not authoritative for reward replay.`,
        );
      }
      if (amountRaw > 0n) {
        const exact =
          payoutExact &&
          !creatorMutationObserved &&
          !otherSharedToRecipient &&
          (sameQuoteDirect.length === 0 || directExact);
        if (exact) exactClaims += 1;
        else ambiguousClaims += 1;
        const kinds = new Set([
          ...sameQuoteDirect.map((row) => row.claim.kind),
          ...targetShared.map((row) => row.kind),
        ]);
        claims.push({
          id: claimPhysicalId({ signature, positions }),
          type: "claim",
          program: "pump",
          tokenMint: targetMint,
          payout: { assetMint: quoteMint, recipient, amountRaw },
          signature,
          slot: tx.slot,
          transactionIndex,
          instructionIndex: positions[0]?.instructionIndex ?? null,
          innerInstructionIndex: positions[0]?.innerInstructionIndex ?? null,
          blockTimeMs: tx.blockTime == null ? null : tx.blockTime * 1_000,
          observedAtMs: Date.now(),
          confidence: commitment,
          attribution: exact ? "exact-token" : "creator-aggregate-ambiguous",
          claimKinds: [...kinds].sort(),
          exactTokenInstruction: targetShared.length > 0,
          payoutEvidence,
        });
      }
    }
  }

  if (ambiguousClaims > 0) {
    warnings.push(
      `${ambiguousClaims} creator-reward claim(s) could not be attributed uniquely to ${targetMint}; authoritative retroactive attribution is unavailable for them.`,
    );
  }
  if (
    targetScan.truncated ||
    curveVaultScan.truncated ||
    ammVaultScan.truncated
  ) {
    warnings.push(
      "Creator reward history stopped at maxPages before the token/creator-vault signature history was exhausted.",
    );
  }
  if (fetched.missing > 0) {
    warnings.push(
      `${fetched.missing} historical transaction fetch(es) were unavailable; reward history is partial.`,
    );
  }
  const fromCreation =
    targetCreation != null &&
    (options.fromSlot == null || options.fromSlot <= targetCreation.slot);
  const discoveryComplete =
    targetScan.exhausted &&
    curveVaultScan.exhausted &&
    ammVaultScan.exhausted &&
    !targetScan.truncated &&
    !curveVaultScan.truncated &&
    !ammVaultScan.truncated &&
    fetched.missing === 0;
  const exactOrderingRequired = options.exactOrdering ?? true;
  const authoritativeForRewardReplay =
    discoveryComplete &&
    fromCreation &&
    targetCreation != null &&
    !creatorMutationObserved &&
    ambiguousClaims === 0 &&
    fallbackPayoutClaims === 0 &&
    exactOrderingRequired &&
    ordering.complete;
  const coverage: CreatorRewardHistoryCoverage = {
    version: 1,
    tokenMint: targetMint,
    quoteMint,
    recipient,
    originalCreator,
    creationSlot: targetCreation?.slot ?? null,
    status: discoveryComplete ? "complete" : "partial",
    fromCreation,
    ordering: ordering.complete ? "transaction" : "slot-only",
    directAttribution: !directUsed
      ? "unused"
      : ambiguousClaims > 0
        ? "ambiguous"
        : "exclusive",
    curveVaultHistoryExhausted: curveVaultScan.exhausted,
    ammVaultHistoryExhausted: ammVaultScan.exhausted,
    targetHistoryExhausted: targetScan.exhausted,
    targetSignaturePages: targetScan.pages,
    curveVaultSignaturePages: curveVaultScan.pages,
    ammVaultSignaturePages: ammVaultScan.pages,
    fetchedTransactions: fetched.bySignature.size,
    missingTransactions: fetched.missing,
    exactClaims,
    ambiguousClaims,
    exactPayoutClaims,
    fallbackPayoutClaims,
    authoritativeForRewardReplay,
    warnings: [...new Set(warnings)],
  };
  return asClaimHistory({ tokenMint: targetMint, recipient, claims, coverage });
}

export async function historyCanonicalEvents(args: {
  connection: Connection;
  token: TokenRow;
  options?: CanonicalHistoryOptions;
}): Promise<CanonicalHistory> {
  const options = args.options ?? {};
  const tokenHistory = await historyTokenEvents({
    connection: args.connection,
    token: args.token,
    options,
  });
  const claimToSlot =
    options.toSlot ??
    tokenHistory.coverage.balanceVerification.snapshotSlot ??
    undefined;
  const claimHistory = await historyCreatorRewards({
    connection: args.connection,
    token: args.token,
    options: {
      recipient: options.recipient,
      commitment: options.commitment,
      fromSlot: options.fromSlot,
      toSlot: claimToSlot,
      maxPages: options.claimMaxPages,
      exactOrdering: options.exactOrdering,
    },
  });
  const warnings = [
    ...tokenHistory.coverage.warnings,
    ...claimHistory.coverage.warnings,
  ];
  const tokenBalancesAuthoritative =
    tokenHistory.coverage.authoritativeForBalanceReplay;
  const creatorRewardsAuthoritative =
    claimHistory.coverage.authoritativeForRewardReplay;
  const coverage: CanonicalHistoryCoverage = {
    version: 1,
    authoritative: tokenBalancesAuthoritative && creatorRewardsAuthoritative,
    tokenBalancesAuthoritative,
    creatorRewardsAuthoritative,
    warnings: [...new Set(warnings)],
  };
  const events: CanonicalHistoryEvent[] = [
    ...tokenHistory.events,
    ...claimHistory.claims,
  ].sort(eventSort);
  return {
    tokenMint: args.token.mint,
    recipient: claimHistory.recipient,
    events,
    transfers: tokenHistory.events,
    claims: claimHistory.claims,
    tokenHistory,
    claimHistory,
    coverage,
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}
export type HistoricalRewardReplayEvent = CanonicalHistoryEvent;
export type HistoricalRewardReplayOptions = CanonicalHistoryOptions;
export type HistoricalRewardReplayCoverage = CanonicalHistoryCoverage;
export type HistoricalRewardReplay = CanonicalHistory;
export const historyRewardReplay = historyCanonicalEvents;
