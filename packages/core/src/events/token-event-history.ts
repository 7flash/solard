import { PublicKey, type Commitment, type Connection } from "@solana/web3.js";

import {
  snapshotTokenHolders,
  type TokenHolderSnapshot,
} from "../chain/holders.ts";
import { readMint } from "../chain/state.ts";
import type { TokenRow } from "../db/schema.ts";
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
  transferCoverage: "complete-token-index" | "mint-mentioned-transfers";
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
          maxSupportedTransactionVersion: 0,
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
          maxSupportedTransactionVersion: 0,
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
  const mintInfo = await readMint(args.connection, new PublicKey(mint));
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

async function rpcHistory(args: {
  connection: Connection;
  token: TokenRow;
  options: TokenEventHistoryOptions;
  commitment: SolardTokenEventConfidence;
  snapshotSlot: number | null;
}): Promise<TokenEventHistory> {
  const mint = new PublicKey(args.token.mint);
  const mintInfo = await readMint(args.connection, mint);
  const maxPages =
    args.options.maxPages == null
      ? null
      : Math.max(1, Math.trunc(args.options.maxPages));
  const signatures: Array<{ signature: string; slot: number }> = [];
  let before: string | undefined;
  let pages = 0;
  let exhausted = false;
  let truncated = false;
  while (true) {
    if (maxPages != null && pages >= maxPages) {
      truncated = true;
      break;
    }
    const batch = await args.connection.getSignaturesForAddress(
      mint,
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
      if (args.options.toSlot != null && row.slot > args.options.toSlot)
        continue;
      if (args.snapshotSlot != null && row.slot > args.snapshotSlot) continue;
      if (args.options.fromSlot != null && row.slot < args.options.fromSlot)
        continue;
      signatures.push({ signature: row.signature, slot: row.slot });
    }
    const oldest = batch.at(-1)!;
    if (args.options.fromSlot != null && oldest.slot < args.options.fromSlot) {
      exhausted = true;
      break;
    }
    if (batch.length < 1_000) {
      exhausted = true;
      break;
    }
    before = oldest.signature;
  }

  signatures.sort(
    (a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature),
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
          maxSupportedTransactionVersion: 0,
        },
      );
    } catch {
      txs = [];
    }
    if (!txs.length) {
      parseErrors += chunk.length;
      continue;
    }
    for (let index = 0; index < chunk.length; index += 1) {
      const tx = txs[index];
      if (!tx || tx.meta?.err) {
        parseErrors += 1;
        continue;
      }
      events.push(
        ...parseTokenTransferEvents({
          tx,
          signature: chunk[index]!.signature,
          mint: mint.toBase58(),
          decimals: mintInfo.decimals,
          confidence: args.commitment,
          source: "rpc-history",
        }),
      );
    }
  }
  events.sort(eventSort);
  const warnings = [
    "RPC history only sees transactions that mention the mint account; plain SPL Transfer instructions may be absent.",
  ];
  if (truncated)
    warnings.push(
      "History stopped at maxPages before the RPC result set was exhausted.",
    );
  if (parseErrors)
    warnings.push(
      `${parseErrors} mint-mentioned transactions could not be parsed.`,
    );
  let ordering: TokenEventHistoryCoverage["ordering"] = "slot-only";
  if ((args.options.exactOrdering ?? true) && events.length) {
    const order = await enrichTransactionIndexes({
      connection: args.connection,
      events,
      commitment: args.commitment,
    });
    if (order.complete) ordering = "transaction";
    else
      warnings.push(
        `Exact transaction ordering could not be resolved for ${order.failures} slot(s).`,
      );
  }
  const verification = replayVerification(events);
  const coverage: TokenEventHistoryCoverage = {
    version: 1,
    mint: mint.toBase58(),
    provider: "rpc",
    status: "partial",
    transferCoverage: "mint-mentioned-transfers",
    ordering,
    fromCreation: false,
    authoritativeForBalanceReplay: false,
    requestedFromSlot: args.options.fromSlot ?? null,
    requestedToSlot: args.options.toSlot ?? args.snapshotSlot,
    firstEventSlot: events[0]?.slot ?? null,
    lastEventSlot: events.at(-1)?.slot ?? null,
    pages,
    rows: signatures.length,
    exhausted,
    truncated,
    parseErrors,
    balanceVerification: verification,
    warnings,
  };
  return asHistory({ mint: mint.toBase58(), events, coverage });
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
  });
}

export function replayTokenBalances(
  events: readonly SolardTokenTransferEvent[],
): Map<string, bigint> {
  return balanceMap(events);
}
