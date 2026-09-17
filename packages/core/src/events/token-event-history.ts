import bs58 from "bs58";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PublicKey,
  type Commitment,
  type Connection,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from "@solana/web3.js";

import {
  snapshotTokenHolders,
  type TokenHolderSnapshot,
} from "../chain/holders.ts";
import { readMint } from "../chain/state.ts";
import type { TokenRow } from "../db/schema.ts";
import {
  cachedHistoricalTokenAccounts,
  recordDiscoveredSignatures,
  recordHistoricalTokenAccounts,
  type CachedHistoricalTokenAccount,
} from "./raw-transaction-cache.ts";
import {
  parseTokenTransferEvents,
  type SolardTokenEventConfidence,
  type SolardTokenTransferEvent,
  type SolardTokenTransferMovement,
} from "./token-events.ts";

export type TokenEventHistoryProvider = "auto" | "solscan" | "rpc";

export type TokenEventHistoryBalanceVerification = {
  checked: boolean;
  matches: boolean | null;
  snapshotSlot: number | null;
  replayHolderCount: number;
  chainHolderCount: number | null;
  replayTotalRaw: string;
  chainTotalRaw: string | null;
  mismatches: Array<{
    owner: string;
    replayRaw: string;
    chainRaw: string;
  }>;
};

export type TokenEventHistoryCoverage = {
  version: 1;
  mint: string;
  provider: "solscan" | "rpc";
  status: "complete" | "partial";
  transferCoverage:
    | "complete-token-index"
    | "complete-token-account-index"
    | "mint-mentioned-transfers";
  ordering: "slot-only" | "transaction";
  fromCreation: boolean;
  authoritativeForBalanceReplay: boolean;
  requestedFromSlot: number | null;
  requestedToSlot: number | null;
  firstEventSlot: number | null;
  lastEventSlot: number | null;
  pages: number;
  rows: number;
  exhausted: boolean;
  truncated: boolean;
  parseErrors: number;
  balanceVerification: TokenEventHistoryBalanceVerification;
  warnings: string[];
};

export type TokenEventHistoryOptions = {
  provider?: TokenEventHistoryProvider;
  fromSlot?: number;
  toSlot?: number;
  fromTimeMs?: number;
  toTimeMs?: number;
  commitment?: Extract<Commitment, "confirmed" | "finalized">;
  maxPages?: number;
  exactOrdering?: boolean;
  verifyCurrentBalances?: boolean;
  solscanApiKey?: string;
  onProgress?: (progress: TokenEventHistoryProgress) => void;
};

export type TokenEventHistoryProgress = {
  phase:
    | "rpc-mint-signatures"
    | "rpc-mint-transactions"
    | "rpc-token-accounts"
    | "rpc-account-signatures"
    | "rpc-transactions";
  completed: number;
  total: number | null;
  address?: string;
};

export type TokenEventHistory = AsyncIterable<SolardTokenTransferEvent> & {
  readonly mint: string;
  readonly events: readonly SolardTokenTransferEvent[];
  readonly coverage: TokenEventHistoryCoverage;
};

type SolscanTransferRow = {
  block_id?: unknown;
  trans_id?: unknown;
  block_time?: unknown;
  activity_type?: unknown;
  from_address?: unknown;
  to_address?: unknown;
  token_address?: unknown;
  token_decimals?: unknown;
  amount?: unknown;
};

type SolscanTransferResponse = {
  success?: unknown;
  data?: unknown;
  errors?: { code?: unknown; message?: unknown } | unknown;
};

const SOLSCAN_TRANSFER_RETENTION_MS = 3 * 365 * 24 * 60 * 60 * 1_000;

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function movement(activity: string): SolardTokenTransferMovement | null {
  const value = activity.toUpperCase();
  if (value.includes("SET_OWNER_AUTHORITY")) return "change-owner";
  if (value.includes("_MINT")) return "mint";
  if (value.includes("_BURN")) return "burn";
  if (value.includes("_TRANSFER")) return "transfer";
  return null;
}

function eventSort(
  left: SolardTokenTransferEvent,
  right: SolardTokenTransferEvent,
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

function balanceMap(
  events: readonly SolardTokenTransferEvent[],
): Map<string, bigint> {
  const balances = new Map<string, bigint>();
  const add = (owner: string | null, delta: bigint) => {
    if (!owner || delta === 0n) return;
    const next = (balances.get(owner) ?? 0n) + delta;
    if (next === 0n) balances.delete(owner);
    else balances.set(owner, next);
  };
  for (const event of events) {
    if (event.movement === "mint") {
      add(event.destinationOwner, event.amountRaw);
      continue;
    }
    if (event.movement === "burn") {
      add(event.sourceOwner, -event.amountRaw);
      continue;
    }
    if (event.movement === "change-owner") {
      add(event.sourceOwner, -event.amountRaw);
      add(event.destinationOwner, event.amountRaw);
      continue;
    }
    add(event.sourceOwner, -event.amountRaw);
    const credited =
      event.amountRaw > event.feeRaw ? event.amountRaw - event.feeRaw : 0n;
    add(event.destinationOwner, credited);
  }
  for (const [owner, value] of [...balances]) {
    if (value === 0n) balances.delete(owner);
  }
  return balances;
}

function replayVerification(
  events: readonly SolardTokenTransferEvent[],
): TokenEventHistoryBalanceVerification {
  const replay = balanceMap(events);
  return {
    checked: false,
    matches: null,
    snapshotSlot: null,
    replayHolderCount: [...replay.values()].filter((value) => value > 0n)
      .length,
    chainHolderCount: null,
    replayTotalRaw: [...replay.values()]
      .filter((value) => value > 0n)
      .reduce((sum, value) => sum + value, 0n)
      .toString(),
    chainTotalRaw: null,
    mismatches: [],
  };
}

function verifyAgainstCurrentState(args: {
  events: readonly SolardTokenTransferEvent[];
  snapshot: TokenHolderSnapshot;
}): TokenEventHistoryBalanceVerification {
  const replay = balanceMap(args.events);
  const snapshot = args.snapshot;
  const chain = new Map(
    snapshot.holders.map((holder) => [holder.owner, holder.amountRaw] as const),
  );
  const owners = new Set([...replay.keys(), ...chain.keys()]);
  const mismatches: TokenEventHistoryBalanceVerification["mismatches"] = [];
  for (const owner of [...owners].sort()) {
    const replayRaw = replay.get(owner) ?? 0n;
    const chainRaw = chain.get(owner) ?? 0n;
    if (replayRaw !== chainRaw && mismatches.length < 50) {
      mismatches.push({
        owner,
        replayRaw: replayRaw.toString(),
        chainRaw: chainRaw.toString(),
      });
    }
  }
  const replayTotal = [...replay.values()]
    .filter((value) => value > 0n)
    .reduce((sum, value) => sum + value, 0n);
  return {
    checked: true,
    matches: mismatches.length === 0 && replayTotal === snapshot.totalHeldRaw,
    snapshotSlot: snapshot.slot,
    replayHolderCount: [...replay.values()].filter((value) => value > 0n)
      .length,
    chainHolderCount: snapshot.holderCount,
    replayTotalRaw: replayTotal.toString(),
    chainTotalRaw: snapshot.totalHeldRaw.toString(),
    mismatches,
  };
}

function asHistory(args: {
  mint: string;
  events: SolardTokenTransferEvent[];
  coverage: TokenEventHistoryCoverage;
}): TokenEventHistory {
  const events = args.events.sort(eventSort);
  return {
    mint: args.mint,
    events,
    coverage: args.coverage,
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

async function blockTimeSeconds(
  connection: Connection,
  slot: number | null,
): Promise<number | null> {
  if (slot == null || slot <= 0) return null;
  try {
    return await connection.getBlockTime(slot);
  } catch {
    return null;
  }
}

async function enrichTransactionIndexes(args: {
  connection: Connection;
  events: SolardTokenTransferEvent[];
  commitment: SolardTokenEventConfidence;
}): Promise<{ complete: boolean; failures: number }> {
  const bySlot = new Map<number, SolardTokenTransferEvent[]>();
  for (const event of args.events) {
    const rows = bySlot.get(event.slot) ?? [];
    rows.push(event);
    bySlot.set(event.slot, rows);
  }
  const slots = [...bySlot.keys()].sort((a, b) => a - b);
  let next = 0;
  let failures = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      const slot = slots[index];
      if (slot == null) return;
      try {
        const block = await args.connection.getBlock(slot, {
          commitment: args.commitment,
          transactionDetails: "signatures",
          rewards: false,
          maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION,
        } as any);
        const signatures = Array.isArray((block as any)?.signatures)
          ? ((block as any).signatures as string[])
          : [];
        const indexes = new Map(
          signatures.map((signature, i) => [signature, i]),
        );
        let found = false;
        for (const event of bySlot.get(slot) ?? []) {
          const txIndex = indexes.get(event.signature);
          if (txIndex == null) continue;
          event.transactionIndex = txIndex;
          found = true;
        }
        if (!found && (bySlot.get(slot)?.length ?? 0) > 0) failures += 1;
      } catch {
        failures += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, slots.length) }, worker));
  return { complete: failures === 0, failures };
}

type SolscanTokenMeta = {
  createdAtMs: number | null;
  firstMintSignature: string | null;
};

type SolscanIndexedTransfer = {
  signature: string;
  slot: number;
  movement: SolardTokenTransferMovement;
};

const SOLSCAN_ACTIVITY_TYPES = [
  "ACTIVITY_SPL_TRANSFER",
  "ACTIVITY_SPL_MINT",
  "ACTIVITY_SPL_BURN",
  "ACTIVITY_SPL_SET_OWNER_AUTHORITY",
] as const;

async function solscanTokenMeta(args: {
  mint: string;
  apiKey: string;
}): Promise<SolscanTokenMeta> {
  const url = new URL("https://pro-api.solscan.io/v2.0/token/meta");
  url.searchParams.set("address", args.mint);
  const response = await fetch(url, {
    headers: { accept: "application/json", token: args.apiKey },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Solscan token metadata HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
  }
  const body = (await response.json()) as {
    success?: unknown;
    data?: Record<string, unknown>;
    errors?: unknown;
  };
  if (body.success === false) {
    throw new Error(
      `Solscan token metadata request failed: ${JSON.stringify(body.errors ?? body)}`,
    );
  }
  const createdTime = positiveInteger(body.data?.created_time);
  const firstMintTime = positiveInteger(body.data?.first_mint_time);
  return {
    createdAtMs:
      createdTime == null
        ? firstMintTime == null
          ? null
          : firstMintTime * 1_000
        : createdTime * 1_000,
    firstMintSignature: text(body.data?.first_mint_tx),
  };
}

function movementCounts(
  rows: readonly { movement: SolardTokenTransferMovement }[],
): Map<SolardTokenTransferMovement, number> {
  const out = new Map<SolardTokenTransferMovement, number>();
  for (const row of rows)
    out.set(row.movement, (out.get(row.movement) ?? 0) + 1);
  return out;
}

async function parseIndexedTransactions(args: {
  connection: Connection;
  mint: string;
  decimals: number;
  indexed: readonly SolscanIndexedTransfer[];
  commitment: SolardTokenEventConfidence;
}): Promise<{ events: SolardTokenTransferEvent[]; parseErrors: number }> {
  const bySignature = new Map<string, SolscanIndexedTransfer[]>();
  for (const row of args.indexed) {
    const rows = bySignature.get(row.signature) ?? [];
    rows.push(row);
    bySignature.set(row.signature, rows);
  }
  const signatures = [...bySignature.entries()]
    .map(([signature, rows]) => ({
      signature,
      slot: Math.min(...rows.map((row) => row.slot)),
    }))
    .sort(
      (left, right) =>
        left.slot - right.slot || left.signature.localeCompare(right.signature),
    );
  const events: SolardTokenTransferEvent[] = [];
  let parseErrors = 0;
  for (let offset = 0; offset < signatures.length; offset += 100) {
    const chunk = signatures.slice(offset, offset + 100);
    let txs: Awaited<ReturnType<Connection["getParsedTransactions"]>>;
    try {
      txs = await args.connection.getParsedTransactions(
        chunk.map((row) => row.signature),
        {
          commitment: args.commitment,
          maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION,
        },
      );
    } catch {
      parseErrors += chunk.reduce(
        (sum, row) => sum + (bySignature.get(row.signature)?.length ?? 1),
        0,
      );
      continue;
    }
    for (let index = 0; index < chunk.length; index += 1) {
      const signature = chunk[index]!.signature;
      const expectedRows = bySignature.get(signature) ?? [];
      const tx = txs[index];
      if (!tx || tx.meta?.err) {
        parseErrors += Math.max(1, expectedRows.length);
        continue;
      }
      const parsed = parseTokenTransferEvents({
        tx,
        signature,
        mint: args.mint,
        decimals: args.decimals,
        confidence: args.commitment,
        source: "solscan-token-index",
      });
      const expected = movementCounts(expectedRows);
      const actual = movementCounts(parsed);
      for (const movementType of [
        "transfer",
        "mint",
        "burn",
        "change-owner",
      ] as const) {
        const difference = Math.abs(
          (expected.get(movementType) ?? 0) - (actual.get(movementType) ?? 0),
        );
        parseErrors += difference;
      }
      events.push(...parsed);
    }
  }
  const deduped = new Map<string, SolardTokenTransferEvent>();
  for (const event of events) deduped.set(event.id, event);
  return { events: [...deduped.values()], parseErrors };
}

async function solscanHistory(args: {
  connection: Connection;
  token: TokenRow;
  options: TokenEventHistoryOptions;
  commitment: SolardTokenEventConfidence;
  apiKey: string;
  snapshotSlot: number | null;
  currentSnapshot: TokenHolderSnapshot | null;
}): Promise<TokenEventHistory> {
  const mint = new PublicKey(args.token.mint).toBase58();
  const mintInfo =
    typeof args.token.decimals === "number"
      ? { decimals: args.token.decimals }
      : await readMint(args.connection, new PublicKey(mint));
  const warnings: string[] = [];
  let providerMeta: SolscanTokenMeta = {
    createdAtMs: null,
    firstMintSignature: null,
  };
  try {
    providerMeta = await solscanTokenMeta({ mint, apiKey: args.apiKey });
  } catch (error) {
    warnings.push(
      `Could not resolve indexed token creation metadata: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const createdAtMs =
    providerMeta.createdAtMs ??
    (args.token.createdAtMs > 0 ? args.token.createdAtMs : null);
  const indexed: SolscanIndexedTransfer[] = [];
  const pageSize = 100;
  const maxPages =
    args.options.maxPages == null
      ? null
      : Math.max(1, Math.trunc(args.options.maxPages));
  const explicitStart =
    args.options.fromSlot != null || args.options.fromTimeMs != null;
  const explicitEnd =
    args.options.toSlot != null || args.options.toTimeMs != null;
  const retentionStart = Date.now() - SOLSCAN_TRANSFER_RETENTION_MS;
  const fromCreation =
    !explicitStart && createdAtMs != null && createdAtMs >= retentionStart;
  if (!explicitStart && createdAtMs == null) {
    warnings.push(
      "Token creation time is unknown, so historical balance replay cannot be certified from creation.",
    );
  }
  if (!explicitStart && createdAtMs != null && createdAtMs < retentionStart) {
    warnings.push(
      "Solscan transfer-history retention does not reach this token's creation time.",
    );
  }
  const fromTimeSec =
    args.options.fromTimeMs == null
      ? createdAtMs == null
        ? null
        : Math.max(0, Math.floor(createdAtMs / 1_000) - 5)
      : Math.max(0, Math.floor(args.options.fromTimeMs / 1_000));
  let toTimeSec =
    args.options.toTimeMs == null
      ? await blockTimeSeconds(
          args.connection,
          args.options.toSlot ?? args.snapshotSlot,
        )
      : Math.floor(args.options.toTimeMs / 1_000);
  if (toTimeSec != null) toTimeSec += 2;
  if (fromTimeSec != null && toTimeSec != null && fromTimeSec > toTimeSec) {
    throw new Error("Historical event start time is after the end time");
  }

  let page = 1;
  let pages = 0;
  let rows = 0;
  let providerParseErrors = 0;
  let exhausted = false;
  let truncated = false;

  while (true) {
    if (maxPages != null && pages >= maxPages) {
      truncated = true;
      break;
    }
    const url = new URL("https://pro-api.solscan.io/v2.0/token/transfer");
    url.searchParams.set("address", mint);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(pageSize));
    url.searchParams.set("sort_by", "block_time");
    url.searchParams.set("sort_order", "asc");
    for (const activity of SOLSCAN_ACTIVITY_TYPES) {
      url.searchParams.append("activity_type[]", activity);
    }
    if (fromTimeSec != null)
      url.searchParams.set("from_time", String(fromTimeSec));
    if (toTimeSec != null) url.searchParams.set("to_time", String(toTimeSec));
    const response = await fetch(url, {
      headers: { accept: "application/json", token: args.apiKey },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Solscan token history HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    const body = (await response.json()) as SolscanTransferResponse;
    if (body.success === false) {
      throw new Error(
        `Solscan token history request failed: ${JSON.stringify(body.errors ?? body)}`,
      );
    }
    const pageRows = Array.isArray(body.data)
      ? (body.data as SolscanTransferRow[])
      : [];
    pages += 1;
    rows += pageRows.length;
    for (const row of pageRows) {
      const signature = text(row.trans_id);
      const slot = positiveInteger(row.block_id);
      const activity = text(row.activity_type);
      const rowMint = text(row.token_address);
      if (!signature || slot == null || !activity || rowMint !== mint) {
        providerParseErrors += 1;
        continue;
      }
      if (args.options.fromSlot != null && slot < args.options.fromSlot)
        continue;
      const upperSlot = args.options.toSlot ?? args.snapshotSlot;
      if (upperSlot != null && slot > upperSlot) continue;
      const eventMovement = movement(activity);
      if (!eventMovement) {
        providerParseErrors += 1;
        continue;
      }
      indexed.push({ signature, slot, movement: eventMovement });
    }
    if (pageRows.length < pageSize) {
      exhausted = true;
      break;
    }
    page += 1;
  }

  recordDiscoveredSignatures(
    args.connection,
    mint,
    indexed.map((row) => ({ signature: row.signature, slot: row.slot })),
  );
  const parsed = await parseIndexedTransactions({
    connection: args.connection,
    mint,
    decimals: mintInfo.decimals,
    indexed,
    commitment: args.commitment,
  });
  const events = parsed.events;
  let parseErrors = providerParseErrors + parsed.parseErrors;
  if (fromCreation && providerMeta.firstMintSignature) {
    const hasFirstMint = events.some(
      (event) =>
        event.signature === providerMeta.firstMintSignature &&
        event.movement === "mint",
    );
    if (!hasFirstMint) {
      parseErrors += 1;
      warnings.push(
        "The indexed first-mint transaction was not reconstructed from transfer history.",
      );
    }
  }
  if (parseErrors > 0) {
    warnings.push(
      `${parseErrors} indexed movement(s) could not be reconstructed exactly from their transactions.`,
    );
  }
  if (truncated) {
    warnings.push(
      "History stopped at maxPages before the indexed result set was exhausted.",
    );
  }

  let ordering: TokenEventHistoryCoverage["ordering"] = "slot-only";
  if ((args.options.exactOrdering ?? true) && events.length) {
    const order = await enrichTransactionIndexes({
      connection: args.connection,
      events,
      commitment: args.commitment,
    });
    if (order.complete) ordering = "transaction";
    else {
      warnings.push(
        `Exact transaction ordering could not be resolved for ${order.failures} slot(s).`,
      );
    }
  }
  events.sort(eventSort);

  let verification = replayVerification(events);
  const fullToCurrent =
    !explicitEnd && args.snapshotSlot != null && args.currentSnapshot != null;
  if (
    (args.options.verifyCurrentBalances ?? true) &&
    fromCreation &&
    fullToCurrent &&
    exhausted &&
    !truncated &&
    parseErrors === 0
  ) {
    verification = verifyAgainstCurrentState({
      events,
      snapshot: args.currentSnapshot!,
    });
    if (!verification.matches) {
      warnings.push(
        "Historical replay does not match the current on-chain holder snapshot; coverage is not authoritative.",
      );
    }
  }

  const rangeComplete = exhausted && !truncated && parseErrors === 0;
  const authoritativeForBalanceReplay =
    rangeComplete &&
    fromCreation &&
    fullToCurrent &&
    ordering === "transaction" &&
    verification.checked &&
    verification.matches === true;
  const coverage: TokenEventHistoryCoverage = {
    version: 1,
    mint,
    provider: "solscan",
    status: rangeComplete ? "complete" : "partial",
    transferCoverage: "complete-token-index",
    ordering,
    fromCreation,
    authoritativeForBalanceReplay,
    requestedFromSlot: args.options.fromSlot ?? null,
    requestedToSlot: args.options.toSlot ?? args.snapshotSlot,
    firstEventSlot: events[0]?.slot ?? null,
    lastEventSlot: events.at(-1)?.slot ?? null,
    pages,
    rows,
    exhausted,
    truncated,
    parseErrors,
    balanceVerification: verification,
    warnings,
  };
  return asHistory({ mint, events, coverage });
}

type RpcSignatureRow = { signature: string; slot: number };

type RpcAddressScan = {
  rows: RpcSignatureRow[];
  pages: number;
  exhausted: boolean;
  truncated: boolean;
  oldestObservedSlot: number | null;
};

const MAX_SUPPORTED_TRANSACTION_VERSION = 1;
const TOKEN_PROGRAM_IDS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);
const ASSOCIATED_TOKEN_PROGRAM = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();

function keyText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (
    value &&
    typeof (value as { toBase58?: unknown }).toBase58 === "function"
  ) {
    return (value as { toBase58(): string }).toBase58();
  }
  return null;
}

function transactionAccountKeys(tx: ParsedTransactionWithMeta): string[] {
  const rows = (tx.transaction.message as any).accountKeys as any[];
  const keys = rows
    .map((row) => keyText(row?.pubkey ?? row))
    .filter((value): value is string => value != null);
  const hasResolvedLookupKeys = rows.some(
    (row) => row && typeof row === "object" && row.source === "lookupTable",
  );
  if (hasResolvedLookupKeys) return keys;
  const loaded = tx.meta?.loadedAddresses;
  if (!loaded) return keys;
  for (const value of [...loaded.writable, ...loaded.readonly]) {
    const address = keyText(value);
    if (address) keys.push(address);
  }
  return keys;
}

function transactionInstructionRows(
  tx: ParsedTransactionWithMeta,
): Array<ParsedInstruction | PartiallyDecodedInstruction> {
  const rows: Array<ParsedInstruction | PartiallyDecodedInstruction> = [
    ...(tx.transaction.message.instructions as Array<
      ParsedInstruction | PartiallyDecodedInstruction
    >),
  ];
  for (const group of tx.meta?.innerInstructions ?? []) {
    rows.push(
      ...(group.instructions as Array<
        ParsedInstruction | PartiallyDecodedInstruction
      >),
    );
  }
  return rows;
}

function parsedInstruction(
  instruction: ParsedInstruction | PartiallyDecodedInstruction,
): { type: string; info: Record<string, unknown> } | null {
  if (!("parsed" in instruction)) return null;
  const parsed = instruction.parsed as
    { type?: unknown; info?: Record<string, unknown> } | undefined;
  return {
    type: String(parsed?.type ?? ""),
    info: parsed?.info ?? {},
  };
}

function instructionKey(value: unknown): string | null {
  return keyText(value);
}

function instructionAccounts(
  instruction: ParsedInstruction | PartiallyDecodedInstruction,
): string[] {
  if (!("accounts" in instruction) || !Array.isArray(instruction.accounts))
    return [];
  return instruction.accounts
    .map((value: unknown) => keyText(value))
    .filter((value: string | null): value is string => value != null);
}

function instructionData(
  instruction: ParsedInstruction | PartiallyDecodedInstruction,
): Uint8Array | null {
  if (!("data" in instruction) || typeof instruction.data !== "string")
    return null;
  try {
    return bs58.decode(instruction.data);
  } catch {
    return null;
  }
}

function mergeHistoricalAccount(
  target: Map<string, CachedHistoricalTokenAccount>,
  next: CachedHistoricalTokenAccount,
): void {
  const current = target.get(next.address);
  const incarnations = new Map<string, { slot: number; signature: string }>();
  const addIncarnation = (slot: number | null, signature: string | null) => {
    if (slot == null || !signature) return;
    const existing = incarnations.get(signature);
    if (!existing || slot < existing.slot)
      incarnations.set(signature, { slot, signature });
  };
  if (current) {
    addIncarnation(current.initializedAtSlot, current.initializedBySignature);
    for (const row of current.incarnations ?? [])
      addIncarnation(row.slot, row.signature);
  }
  addIncarnation(next.initializedAtSlot, next.initializedBySignature);
  for (const row of next.incarnations ?? [])
    addIncarnation(row.slot, row.signature);
  const ordered = [...incarnations.values()].sort(
    (a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature),
  );
  const first = ordered[0] ?? null;
  target.set(next.address, {
    address: next.address,
    initializedAtSlot: first?.slot ?? current?.initializedAtSlot ?? null,
    initializedBySignature:
      first?.signature ?? current?.initializedBySignature ?? null,
    incarnations: ordered,
  });
}

function tokenAccountsInTransaction(args: {
  tx: ParsedTransactionWithMeta;
  signature: string;
  mint: string;
}): CachedHistoricalTokenAccount[] {
  const out = new Map<string, CachedHistoricalTokenAccount>();
  const keys = transactionAccountKeys(args.tx);
  const preAccounts = new Set<string>();
  const postAccounts = new Set<string>();
  for (const row of args.tx.meta?.preTokenBalances ?? []) {
    if (row.mint !== args.mint) continue;
    const address = keys[row.accountIndex];
    if (address) preAccounts.add(address);
  }
  for (const row of args.tx.meta?.postTokenBalances ?? []) {
    if (row.mint !== args.mint) continue;
    const address = keys[row.accountIndex];
    if (address) postAccounts.add(address);
  }
  const createdInTransaction = (address: string | null): boolean =>
    address != null && !preAccounts.has(address) && postAccounts.has(address);
  const add = (address: string | null, initialized: boolean) => {
    if (!address) return;
    const incarnation = initialized
      ? [{ slot: args.tx.slot, signature: args.signature }]
      : [];
    mergeHistoricalAccount(out, {
      address,
      initializedAtSlot: initialized ? args.tx.slot : null,
      initializedBySignature: initialized ? args.signature : null,
      incarnations: incarnation,
    });
  };
  for (const balance of [
    ...(args.tx.meta?.preTokenBalances ?? []),
    ...(args.tx.meta?.postTokenBalances ?? []),
  ]) {
    if (balance.mint !== args.mint) continue;
    add(keys[balance.accountIndex] ?? null, false);
  }
  for (const instruction of transactionInstructionRows(args.tx)) {
    const programId = instruction.programId.toBase58();
    const parsed = parsedInstruction(instruction);
    if (parsed) {
      const mint = instructionKey(parsed.info.mint);
      if (
        mint === args.mint &&
        /^initializeAccount(?:2|3)?$/i.test(parsed.type) &&
        TOKEN_PROGRAM_IDS.has(programId)
      ) {
        add(instructionKey(parsed.info.account), true);
        continue;
      }
      if (
        mint === args.mint &&
        /^(create|createIdempotent)$/i.test(parsed.type) &&
        programId === ASSOCIATED_TOKEN_PROGRAM
      ) {
        const account =
          instructionKey(parsed.info.account) ??
          instructionKey(parsed.info.associatedAccount);
        add(
          account,
          /^create$/i.test(parsed.type) || createdInTransaction(account),
        );
        continue;
      }
      if (mint !== args.mint) continue;
      if (/^transfer(?:Checked|CheckedWithFee)?$/i.test(parsed.type)) {
        add(instructionKey(parsed.info.source), false);
        add(instructionKey(parsed.info.destination), false);
        continue;
      }
      if (/^mintTo(?:Checked)?$/i.test(parsed.type)) {
        add(
          instructionKey(parsed.info.account) ??
            instructionKey(parsed.info.destination),
          false,
        );
        continue;
      }
      if (/^burn(?:Checked)?$/i.test(parsed.type)) {
        add(
          instructionKey(parsed.info.account) ??
            instructionKey(parsed.info.source),
          false,
        );
      }
      continue;
    }
    const accounts = instructionAccounts(instruction);
    const data = instructionData(instruction);
    if (TOKEN_PROGRAM_IDS.has(programId) && data && data.length > 0) {
      const discriminator = data[0];
      if (
        (discriminator === 1 || discriminator === 16 || discriminator === 18) &&
        accounts[1] === args.mint
      ) {
        add(accounts[0] ?? null, true);
      }
      continue;
    }
    if (programId === ASSOCIATED_TOKEN_PROGRAM && accounts[3] === args.mint) {
      const discriminator = data?.[0] ?? 0;
      const account = accounts[1] ?? null;
      if (discriminator === 0) add(account, true);
      if (discriminator === 1) add(account, createdInTransaction(account));
    }
  }
  return [...out.values()];
}

function initializesMint(tx: ParsedTransactionWithMeta, mint: string): boolean {
  for (const instruction of transactionInstructionRows(tx)) {
    const programId = instruction.programId.toBase58();
    if (!TOKEN_PROGRAM_IDS.has(programId)) continue;
    const parsed = parsedInstruction(instruction);
    if (parsed) {
      if (
        /^initializeMint2?$/i.test(parsed.type) &&
        instructionKey(parsed.info.mint) === mint
      )
        return true;
      continue;
    }
    const accounts = instructionAccounts(instruction);
    const data = instructionData(instruction);
    if (
      data &&
      data.length > 0 &&
      (data[0] === 0 || data[0] === 20) &&
      accounts[0] === mint
    )
      return true;
  }
  return false;
}

async function rpcMinimumLedgerSlot(
  connection: Connection,
): Promise<number | null> {
  const candidate = connection as unknown as {
    getFirstAvailableBlock?: () => Promise<number>;
    minimumLedgerSlot?: () => Promise<number>;
  };
  try {
    if (typeof candidate.getFirstAvailableBlock === "function") {
      const value = await candidate.getFirstAvailableBlock();
      return Number.isInteger(value) && value >= 0 ? value : null;
    }
  } catch {}
  try {
    if (typeof candidate.minimumLedgerSlot === "function") {
      const value = await candidate.minimumLedgerSlot();
      return Number.isInteger(value) && value >= 0 ? value : null;
    }
  } catch {}
  return null;
}

async function scanRpcAddress(args: {
  connection: Connection;
  address: PublicKey;
  commitment: SolardTokenEventConfidence;
  fromSlot?: number;
  toSlot?: number | null;
  maxPages: number | null;
}): Promise<RpcAddressScan> {
  const rows: RpcSignatureRow[] = [];
  let before: string | undefined;
  let pages = 0;
  let exhausted = false;
  let truncated = false;
  let oldestObservedSlot: number | null = null;
  while (true) {
    if (args.maxPages != null && pages >= args.maxPages) {
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
    for (const row of batch) {
      if (row.err) continue;
      if (args.toSlot != null && row.slot > args.toSlot) continue;
      if (args.fromSlot != null && row.slot < args.fromSlot) continue;
      rows.push({ signature: row.signature, slot: row.slot });
    }
    const oldest = batch.at(-1)!;
    oldestObservedSlot =
      oldestObservedSlot == null
        ? oldest.slot
        : Math.min(oldestObservedSlot, oldest.slot);
    if (args.fromSlot != null && oldest.slot < args.fromSlot) {
      exhausted = true;
      break;
    }
    if (batch.length < 1_000) {
      exhausted = true;
      break;
    }
    before = oldest.signature;
  }
  recordDiscoveredSignatures(args.connection, args.address, rows);
  return { rows, pages, exhausted, truncated, oldestObservedSlot };
}

async function fetchRpcTransactions(args: {
  connection: Connection;
  signatures: readonly RpcSignatureRow[];
  commitment: SolardTokenEventConfidence;
  progress?: TokenEventHistoryOptions["onProgress"];
  phase: "rpc-mint-transactions" | "rpc-transactions";
}): Promise<{
  transactions: Map<string, ParsedTransactionWithMeta>;
  missing: number;
  failed: number;
  missingSignatures: string[];
  failedSignatures: string[];
}> {
  const transactions = new Map<string, ParsedTransactionWithMeta>();
  const missingSignatures: string[] = [];
  const failedSignatures: string[] = [];
  let missing = 0;
  let failed = 0;
  for (let offset = 0; offset < args.signatures.length; offset += 100) {
    const chunk = args.signatures.slice(offset, offset + 100);
    let txs: Awaited<ReturnType<Connection["getParsedTransactions"]>>;
    try {
      txs = await args.connection.getParsedTransactions(
        chunk.map((row) => row.signature),
        {
          commitment: args.commitment,
          maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION,
        },
      );
    } catch {
      missing += chunk.length;
      missingSignatures.push(...chunk.map((row) => row.signature));
      args.progress?.({
        phase: args.phase,
        completed: Math.min(offset + chunk.length, args.signatures.length),
        total: args.signatures.length,
      });
      continue;
    }
    for (let index = 0; index < chunk.length; index += 1) {
      const row = chunk[index]!;
      const tx = txs[index];
      if (!tx) {
        missing += 1;
        missingSignatures.push(row.signature);
        continue;
      }
      if (tx.meta?.err) {
        failed += 1;
        failedSignatures.push(row.signature);
        continue;
      }
      transactions.set(row.signature, tx);
    }
    args.progress?.({
      phase: args.phase,
      completed: Math.min(offset + chunk.length, args.signatures.length),
      total: args.signatures.length,
    });
  }
  return {
    transactions,
    missing,
    failed,
    missingSignatures,
    failedSignatures,
  };
}

async function rpcHistory(args: {
  connection: Connection;
  token: TokenRow;
  options: TokenEventHistoryOptions;
  commitment: SolardTokenEventConfidence;
  snapshotSlot: number | null;
  currentSnapshot: TokenHolderSnapshot | null;
}): Promise<TokenEventHistory> {
  const mint = new PublicKey(args.token.mint);
  const mintText = mint.toBase58();
  const mintInfo =
    typeof args.token.decimals === "number"
      ? { decimals: args.token.decimals }
      : await readMint(args.connection, mint);
  const maxPages =
    args.options.maxPages == null
      ? null
      : Math.max(1, Math.trunc(args.options.maxPages));
  const requestedToSlot = args.options.toSlot ?? args.snapshotSlot;
  const historyFloorSlot = await rpcMinimumLedgerSlot(args.connection);
  const knownAccounts = new Map<string, CachedHistoricalTokenAccount>();
  for (const account of cachedHistoricalTokenAccounts(
    args.connection,
    mintText,
  ))
    mergeHistoricalAccount(knownAccounts, account);

  const discoveryFromSlot =
    args.options.fromSlot != null && knownAccounts.size > 0
      ? args.options.fromSlot
      : undefined;
  const mintScan = await scanRpcAddress({
    connection: args.connection,
    address: mint,
    commitment: args.commitment,
    fromSlot: discoveryFromSlot,
    toSlot: requestedToSlot,
    maxPages,
  });
  args.options.onProgress?.({
    phase: "rpc-mint-signatures",
    completed: mintScan.rows.length,
    total: mintScan.rows.length,
    address: mintText,
  });

  const mintFetched = await fetchRpcTransactions({
    connection: args.connection,
    signatures: mintScan.rows,
    commitment: args.commitment,
    progress: args.options.onProgress,
    phase: "rpc-mint-transactions",
  });
  const mintInitializations = mintScan.rows
    .flatMap((row) => {
      const tx = mintFetched.transactions.get(row.signature);
      return tx && initializesMint(tx, mintText)
        ? [{ slot: row.slot, signature: row.signature }]
        : [];
    })
    .sort((a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature));
  const currentMintInitialization = mintInitializations.at(-1) ?? null;
  const mintIncarnationStartSlot = currentMintInitialization?.slot ?? null;
  for (const row of mintScan.rows) {
    if (mintIncarnationStartSlot != null && row.slot < mintIncarnationStartSlot)
      continue;
    const tx = mintFetched.transactions.get(row.signature);
    if (!tx) continue;
    for (const account of tokenAccountsInTransaction({
      tx,
      signature: row.signature,
      mint: mintText,
    })) {
      mergeHistoricalAccount(knownAccounts, account);
    }
  }
  recordHistoricalTokenAccounts(args.connection, mintText, [
    ...knownAccounts.values(),
  ]);
  for (const account of cachedHistoricalTokenAccounts(
    args.connection,
    mintText,
  ))
    mergeHistoricalAccount(knownAccounts, account);
  args.options.onProgress?.({
    phase: "rpc-token-accounts",
    completed: knownAccounts.size,
    total: knownAccounts.size,
  });

  const accounts = [...knownAccounts.values()]
    .flatMap((account) => {
      if (mintIncarnationStartSlot == null) return [account];
      const incarnations = (account.incarnations ?? []).filter(
        (row) => row.slot >= mintIncarnationStartSlot,
      );
      if (incarnations.length === 0) return [];
      const first = incarnations[0]!;
      return [
        {
          ...account,
          initializedAtSlot: first.slot,
          initializedBySignature: first.signature,
          incarnations,
        },
      ];
    })
    .sort((a, b) => a.address.localeCompare(b.address));
  const accountScans = new Map<string, RpcAddressScan>();
  let nextAccount = 0;
  let completedAccounts = 0;
  const worker = async () => {
    while (true) {
      const index = nextAccount++;
      const account = accounts[index];
      if (!account) return;
      const scan = await scanRpcAddress({
        connection: args.connection,
        address: new PublicKey(account.address),
        commitment: args.commitment,
        fromSlot:
          args.options.fromSlot == null
            ? (mintIncarnationStartSlot ?? undefined)
            : mintIncarnationStartSlot == null
              ? args.options.fromSlot
              : Math.max(args.options.fromSlot, mintIncarnationStartSlot),
        toSlot: requestedToSlot,
        maxPages,
      });
      accountScans.set(account.address, scan);
      completedAccounts += 1;
      args.options.onProgress?.({
        phase: "rpc-account-signatures",
        completed: completedAccounts,
        total: accounts.length,
        address: account.address,
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, Math.max(1, accounts.length)) }, worker),
  );

  const union = new Map<string, RpcSignatureRow>();
  const addRow = (row: RpcSignatureRow) => {
    if (mintIncarnationStartSlot != null && row.slot < mintIncarnationStartSlot)
      return;
    if (args.options.fromSlot != null && row.slot < args.options.fromSlot)
      return;
    if (requestedToSlot != null && row.slot > requestedToSlot) return;
    const current = union.get(row.signature);
    if (!current || row.slot < current.slot) union.set(row.signature, row);
  };
  for (const row of mintScan.rows) addRow(row);
  for (const scan of accountScans.values())
    for (const row of scan.rows) addRow(row);
  const signatures = [...union.values()].sort(
    (a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature),
  );
  const fetched = await fetchRpcTransactions({
    connection: args.connection,
    signatures,
    commitment: args.commitment,
    progress: args.options.onProgress,
    phase: "rpc-transactions",
  });

  const deduped = new Map<string, SolardTokenTransferEvent>();
  const missingRequiredSignatures = new Set([
    ...mintFetched.missingSignatures,
    ...fetched.missingSignatures,
  ]);
  let parseErrors = missingRequiredSignatures.size;
  for (const row of signatures) {
    const tx = fetched.transactions.get(row.signature);
    if (!tx) continue;
    const parsed = parseTokenTransferEvents({
      tx,
      signature: row.signature,
      mint: mintText,
      decimals: mintInfo.decimals,
      confidence: args.commitment,
      source: "rpc-history",
    });
    for (const event of parsed) deduped.set(event.id, event);
  }
  const events = [...deduped.values()].sort(eventSort);

  const warnings: string[] = [];
  const scans = [...accountScans.values()];
  const truncated = mintScan.truncated || scans.some((scan) => scan.truncated);
  const exhausted = mintScan.exhausted && scans.every((scan) => scan.exhausted);
  if (truncated) {
    warnings.push(
      "RPC history stopped at maxPages before every address range was exhausted.",
    );
  }
  if (parseErrors > 0) {
    warnings.push(
      `${parseErrors} RPC transaction(s) required for exact token history could not be fetched.`,
    );
  }

  let accountInitializationComplete = true;
  if (args.options.fromSlot == null) {
    const missingInitialization = new Map<string, string[]>();
    for (const account of accounts) {
      const incarnations = account.incarnations ?? [];
      if (incarnations.length === 0) {
        missingInitialization.set(account.address, ["unknown"]);
        continue;
      }
      const scan = accountScans.get(account.address);
      const observed = new Set(scan?.rows.map((row) => row.signature) ?? []);
      const missing = incarnations
        .filter((row) => !observed.has(row.signature))
        .map((row) => row.signature);
      if (missing.length > 0)
        missingInitialization.set(account.address, missing);
    }
    accountInitializationComplete = missingInitialization.size === 0;
    if (!currentMintInitialization) {
      warnings.push(
        historyFloorSlot == null
          ? "RPC history did not reach a successful mint initialization transaction."
          : `RPC history did not reach a successful mint initialization transaction; this endpoint reports retained ledger starting near slot ${historyFloorSlot}.`,
      );
    }
    if (!accountInitializationComplete) {
      const missingCycles = [...missingInitialization.values()].reduce(
        (sum, rows) => sum + rows.length,
        0,
      );
      warnings.push(
        `RPC history did not reach ${missingCycles} initialization incarnation(s) across ${missingInitialization.size} discovered token account address(es).`,
      );
    }
  }

  if ((args.options.exactOrdering ?? true) && events.length) {
    const order = await enrichTransactionIndexes({
      connection: args.connection,
      events,
      commitment: args.commitment,
    });
    if (!order.complete) {
      warnings.push(
        `Exact transaction ordering could not be resolved for ${order.failures} slot(s).`,
      );
    }
  }
  const ordering: TokenEventHistoryCoverage["ordering"] = events.every(
    (event) => event.transactionIndex != null,
  )
    ? "transaction"
    : events.length === 0
      ? "transaction"
      : "slot-only";

  const fromCreation =
    args.options.fromSlot == null &&
    currentMintInitialization != null &&
    accountInitializationComplete &&
    exhausted &&
    !truncated &&
    parseErrors === 0;
  let verification = replayVerification(events);
  const explicitEnd =
    args.options.toSlot != null || args.options.toTimeMs != null;
  const fullToCurrent =
    !explicitEnd && args.snapshotSlot != null && args.currentSnapshot != null;
  if (
    (args.options.verifyCurrentBalances ?? true) &&
    fromCreation &&
    fullToCurrent &&
    ordering === "transaction"
  ) {
    verification = verifyAgainstCurrentState({
      events,
      snapshot: args.currentSnapshot!,
    });
    if (!verification.matches) {
      warnings.push(
        "RPC replay does not match the current on-chain holder snapshot; coverage is not authoritative.",
      );
    }
  }

  const rangeComplete = exhausted && !truncated && parseErrors === 0;
  const authoritativeForBalanceReplay =
    rangeComplete &&
    fromCreation &&
    fullToCurrent &&
    ordering === "transaction" &&
    verification.checked &&
    verification.matches === true;
  return asHistory({
    mint: mintText,
    events,
    coverage: {
      version: 1,
      mint: mintText,
      provider: "rpc",
      status: rangeComplete ? "complete" : "partial",
      transferCoverage: "complete-token-account-index",
      ordering,
      fromCreation,
      authoritativeForBalanceReplay,
      requestedFromSlot: args.options.fromSlot ?? null,
      requestedToSlot,
      firstEventSlot: events[0]?.slot ?? null,
      lastEventSlot: events.at(-1)?.slot ?? null,
      pages: mintScan.pages + scans.reduce((sum, scan) => sum + scan.pages, 0),
      rows: signatures.length,
      exhausted,
      truncated,
      parseErrors,
      balanceVerification: verification,
      warnings,
    },
  });
}

export async function historyTokenEvents(args: {
  connection: Connection;
  token: TokenRow;
  options?: TokenEventHistoryOptions;
}): Promise<TokenEventHistory> {
  const options = args.options ?? {};
  const commitment = options.commitment ?? "finalized";
  const solscanApiKey =
    options.solscanApiKey?.trim() || process.env.SOLSCAN_API_KEY?.trim();
  const requested = options.provider ?? "auto";
  if (!new Set(["auto", "solscan", "rpc"]).has(requested)) {
    throw new Error(
      `Unsupported historical token-event provider: ${String(requested)}`,
    );
  }
  const provider =
    requested === "auto" ? (solscanApiKey ? "solscan" : "rpc") : requested;
  if (provider === "solscan" && !solscanApiKey) {
    throw new Error(
      "Historical token-wide transfer reconstruction requires SOLSCAN_API_KEY when provider=solscan.",
    );
  }

  let snapshotSlot: number | null = null;
  let currentSnapshot: TokenHolderSnapshot | null = null;
  const explicitEnd = options.toSlot != null || options.toTimeMs != null;
  if (!explicitEnd && (options.verifyCurrentBalances ?? true)) {
    currentSnapshot = await snapshotTokenHolders(
      args.connection,
      args.token.mint,
      {
        commitment,
        minimumRaw: 1n,
      },
    );
    snapshotSlot = currentSnapshot.slot;
  } else if (options.toSlot != null) {
    snapshotSlot = options.toSlot;
  }

  if (provider === "solscan") {
    return await solscanHistory({
      connection: args.connection,
      token: args.token,
      options,
      commitment,
      apiKey: solscanApiKey!,
      snapshotSlot,
      currentSnapshot,
    });
  }
  return await rpcHistory({
    connection: args.connection,
    token: args.token,
    options,
    commitment,
    snapshotSlot,
    currentSnapshot,
  });
}

export function replayTokenBalances(
  events: readonly SolardTokenTransferEvent[],
): Map<string, bigint> {
  return balanceMap(events);
}
