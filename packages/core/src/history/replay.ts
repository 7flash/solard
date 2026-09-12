import type { Connection, PublicKey } from "@solana/web3.js";

import type { SolardDatabase, TokenRow } from "../db/schema.ts";
import {
  historyCreatorRewards,
  historyRewardReplay,
  type HistoricalCreatorRewardClaimEvent,
  type HistoricalRewardReplayEvent,
} from "../rewards/creator-reward-history.ts";

export const REPLAY_PARSER_VERSION = "neutral-replay-v3";
const REPLAY_OVERLAP_SLOTS = 2_000;

export type ReplayTransaction =
  "mint" | "burn" | "transfer" | "change_owner" | "claim_v2";

export type ReplayClaimAttribution =
  "exact-token" | "creator-aggregate-ambiguous";

export type ReplayItem = {
  id: string;
  mint: string;
  signature: string;
  slot: number;
  timestampSec: number | null;
  transactionIndex: number | null;
  instructionIndex: number | null;
  innerInstructionIndex: number | null;
  trx: ReplayTransaction;
  beforeBalance: ReadonlyMap<string, bigint>;
  postBalance: ReadonlyMap<string, bigint>;
  payouts: ReadonlyMap<string, bigint>;
  quoteMint: string | null;
  claimAttribution: ReplayClaimAttribution | null;
  raw: HistoricalRewardReplayEvent;
};

export type ReplayCoverage = {
  version: 1;
  mint: string;
  parserVersion: string;
  recipient: string | null;
  originalCreator: string | null;
  creationSlot: number | null;
  finalizedThroughSlot: number;
  authoritative: boolean;
  tokenBalancesAuthoritative: boolean;
  creatorRewardsAuthoritative: boolean;
  complete: boolean;
  warnings: string[];
  updatedAtMs: number;
};

type ReplayCoverageState = ReplayCoverage & {
  attemptedThroughSlot: number;
};

export type ReplayHistory = Iterable<ReplayItem> & {
  readonly mint: string;
  readonly items: readonly ReplayItem[];
  readonly coverage: ReplayCoverage;
};

export type ReplayOptions = {
  recipient?: string | PublicKey;
  provider?: "auto" | "solscan" | "rpc";
  maxPages?: number;
  claimMaxPages?: number;
};

export type ReplayEventsOptions = ReplayOptions & {
  pollMs?: number;
  signal?: AbortSignal;
};

export type ReplayEventSubscription = AsyncIterable<ReplayItem> & {
  readonly mint: string;
  readonly watermark: number;
  close(): Promise<void>;
};

export type MergedReplayEventStream = AsyncIterable<ReplayItem> & {
  close(): Promise<void>;
};

type StoredReplayRow = {
  id: number;
  replayKey: string;
  mint: string;
  signature: string;
  slot: number;
  timestampSec: number | null;
  transactionIndex: number | null;
  instructionIndex: number | null;
  innerInstructionIndex: number | null;
  kind: string;
  trxJson: string;
  beforeBalanceRaw: string | null;
  postBalanceRaw: string | null;
  payoutsJson: string;
  quoteMint: string | null;
  claimAttribution: ReplayClaimAttribution | null;
  parserVersion: string;
  observedAtMs: number;
  updatedAtMs: number;
};

type StoredCoverageRow = {
  id: number;
  mint: string;
  parserVersion: string;
  recipient: string | null;
  originalCreator: string | null;
  creationSlot: number | null;
  finalizedThroughSlot: number;
  attemptedThroughSlot: number;
  authoritative: number;
  tokenBalancesAuthoritative: number;
  creatorRewardsAuthoritative: number;
  complete: number;
  warningsJson: string;
  updatedAtMs: number;
};

const replayQueues = new WeakMap<
  SolardDatabase,
  Map<string, Promise<ReplayHistory>>
>();

function json(value: unknown): string {
  return JSON.stringify(value, (_, item) =>
    typeof item === "bigint" ? { $solardBigInt: item.toString() } : item,
  );
}

function parseJson<T>(value: string): T {
  return JSON.parse(value, (_, item) => {
    if (
      item &&
      typeof item === "object" &&
      Object.keys(item).length === 1 &&
      typeof item.$solardBigInt === "string" &&
      /^-?\d+$/.test(item.$solardBigInt)
    ) {
      return BigInt(item.$solardBigInt);
    }
    return item;
  }) as T;
}

function mapJson(value: ReadonlyMap<string, bigint>): string {
  return JSON.stringify(
    [...value].map(([address, amount]) => [address, amount.toString()]),
  );
}

function parseBalanceMap(value: string | null): Map<string, bigint> {
  if (!value) return new Map();
  const rows = JSON.parse(value) as Array<[string, string]>;
  return new Map(rows.map(([address, amount]) => [address, BigInt(amount)]));
}

function replayKey(mint: string, event: HistoricalRewardReplayEvent): string {
  return `${mint}:${event.id}`;
}

function replayTransaction(
  event: HistoricalRewardReplayEvent,
): ReplayTransaction {
  if (event.type === "creator-reward-claim") return "claim_v2";
  if (event.movement === "change-owner") return "change_owner";
  return event.movement;
}

function compareRawEvents(
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

function applyBalanceDelta(args: {
  balances: Map<string, bigint>;
  before: Map<string, bigint>;
  post: Map<string, bigint>;
  owner: string | null;
  delta: bigint;
  event: HistoricalRewardReplayEvent;
}): void {
  if (!args.owner || args.delta === 0n) return;
  const current = args.balances.get(args.owner) ?? 0n;
  if (!args.before.has(args.owner)) args.before.set(args.owner, current);
  const next = current + args.delta;
  if (next < 0n) {
    throw new Error(
      `Replay balance underflow for ${args.owner} at ${args.event.signature}`,
    );
  }
  if (next === 0n) args.balances.delete(args.owner);
  else args.balances.set(args.owner, next);
  args.post.set(args.owner, next);
}

export function normalizeReplayEvent(
  mint: string,
  event: HistoricalRewardReplayEvent,
  balances: Map<string, bigint> = new Map(),
): ReplayItem {
  const beforeBalance = new Map<string, bigint>();
  const postBalance = new Map<string, bigint>();
  const claim =
    event.type === "creator-reward-claim"
      ? (event as HistoricalCreatorRewardClaimEvent)
      : null;

  if (event.type === "transfer") {
    if (event.movement === "mint") {
      applyBalanceDelta({
        balances,
        before: beforeBalance,
        post: postBalance,
        owner: event.destinationOwner,
        delta: event.amountRaw,
        event,
      });
    } else if (event.movement === "burn") {
      applyBalanceDelta({
        balances,
        before: beforeBalance,
        post: postBalance,
        owner: event.sourceOwner,
        delta: -event.amountRaw,
        event,
      });
    } else if (event.movement === "change-owner") {
      applyBalanceDelta({
        balances,
        before: beforeBalance,
        post: postBalance,
        owner: event.sourceOwner,
        delta: -event.amountRaw,
        event,
      });
      applyBalanceDelta({
        balances,
        before: beforeBalance,
        post: postBalance,
        owner: event.destinationOwner,
        delta: event.amountRaw,
        event,
      });
    } else {
      applyBalanceDelta({
        balances,
        before: beforeBalance,
        post: postBalance,
        owner: event.sourceOwner,
        delta: -event.amountRaw,
        event,
      });
      applyBalanceDelta({
        balances,
        before: beforeBalance,
        post: postBalance,
        owner: event.destinationOwner,
        delta:
          event.amountRaw > event.feeRaw ? event.amountRaw - event.feeRaw : 0n,
        event,
      });
    }
  }

  return {
    id: replayKey(mint, event),
    mint,
    signature: event.signature,
    slot: event.slot,
    timestampSec:
      event.blockTimeMs == null ? null : Math.floor(event.blockTimeMs / 1_000),
    transactionIndex: event.transactionIndex,
    instructionIndex: event.instructionIndex,
    innerInstructionIndex: event.innerInstructionIndex,
    trx: replayTransaction(event),
    beforeBalance,
    postBalance,
    payouts: new Map(
      claim ? [[claim.recipient, claim.amountRaw] as const] : [],
    ),
    quoteMint: claim?.quoteMint ?? null,
    claimAttribution: claim?.attribution ?? null,
    raw: event,
  };
}

export function normalizeReplayEvents(
  mint: string,
  events: readonly HistoricalRewardReplayEvent[],
  seed: ReadonlyMap<string, bigint> = new Map(),
): ReplayItem[] {
  const balances = new Map(seed);
  const unique = new Map<string, HistoricalRewardReplayEvent>();
  for (const event of events) unique.set(replayKey(mint, event), event);
  return [...unique.values()]
    .sort(compareRawEvents)
    .map((event) => normalizeReplayEvent(mint, event, balances));
}

export function compareReplayItems(
  left: ReplayItem,
  right: ReplayItem,
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

function rowFromItem(item: ReplayItem): Omit<StoredReplayRow, "id"> {
  return {
    replayKey: item.id,
    mint: item.mint,
    signature: item.signature,
    slot: item.slot,
    timestampSec: item.timestampSec,
    transactionIndex: item.transactionIndex,
    instructionIndex: item.instructionIndex,
    innerInstructionIndex: item.innerInstructionIndex,
    kind: item.trx,
    trxJson: json(item.raw),
    beforeBalanceRaw: mapJson(item.beforeBalance),
    postBalanceRaw: mapJson(item.postBalance),
    payoutsJson: mapJson(item.payouts),
    quoteMint: item.quoteMint,
    claimAttribution: item.claimAttribution,
    parserVersion: REPLAY_PARSER_VERSION,
    observedAtMs: item.raw.observedAtMs,
    updatedAtMs: Date.now(),
  };
}

function itemFromRow(row: StoredReplayRow): ReplayItem {
  return {
    id: row.replayKey,
    mint: row.mint,
    signature: row.signature,
    slot: row.slot,
    timestampSec: row.timestampSec,
    transactionIndex: row.transactionIndex,
    instructionIndex: row.instructionIndex,
    innerInstructionIndex: row.innerInstructionIndex,
    trx: row.kind as ReplayTransaction,
    beforeBalance: parseBalanceMap(row.beforeBalanceRaw),
    postBalance: parseBalanceMap(row.postBalanceRaw),
    payouts: parseBalanceMap(row.payoutsJson),
    quoteMint: row.quoteMint,
    claimAttribution: row.claimAttribution,
    raw: parseJson<HistoricalRewardReplayEvent>(row.trxJson),
  };
}

function loadItems(database: SolardDatabase, mint: string): ReplayItem[] {
  const rows = database.historyReplayItems
    .select()
    .where({ mint })
    .all() as StoredReplayRow[];
  return rows.map(itemFromRow).sort(compareReplayItems);
}

function loadItemsBefore(
  database: SolardDatabase,
  mint: string,
  slot: number,
): ReplayItem[] {
  const rows = database.historyReplayItems
    .select()
    .where({ mint, slot: { $lt: slot } })
    .all() as StoredReplayRow[];
  return rows.map(itemFromRow).sort(compareReplayItems);
}

function loadItemsFrom(
  database: SolardDatabase,
  mint: string,
  slot: number,
): ReplayItem[] {
  const rows = database.historyReplayItems
    .select()
    .where({ mint, slot: { $gte: slot } })
    .all() as StoredReplayRow[];
  return rows.map(itemFromRow).sort(compareReplayItems);
}

function balancesFromItems(items: readonly ReplayItem[]): Map<string, bigint> {
  const balances = new Map<string, bigint>();
  for (const item of [...items].sort(compareReplayItems)) {
    for (const [owner, amount] of item.postBalance) {
      if (amount === 0n) balances.delete(owner);
      else balances.set(owner, amount);
    }
  }
  return balances;
}

function loadCoverage(
  database: SolardDatabase,
  mint: string,
): ReplayCoverageState | null {
  const row = database.historyReplayCoverage
    .select()
    .where({ mint })
    .first() as StoredCoverageRow | undefined;
  if (!row) return null;
  return {
    version: 1,
    mint: row.mint,
    parserVersion: row.parserVersion,
    recipient: row.recipient,
    originalCreator: row.originalCreator,
    creationSlot: row.creationSlot,
    finalizedThroughSlot: row.finalizedThroughSlot,
    attemptedThroughSlot: row.attemptedThroughSlot ?? row.finalizedThroughSlot,
    authoritative: row.authoritative === 1,
    tokenBalancesAuthoritative: row.tokenBalancesAuthoritative === 1,
    creatorRewardsAuthoritative: row.creatorRewardsAuthoritative === 1,
    complete: row.complete === 1,
    warnings: JSON.parse(row.warningsJson) as string[],
    updatedAtMs: row.updatedAtMs,
  };
}

function publicCoverage(
  coverage: ReplayCoverageState,
  attemptWarnings: readonly string[] = [],
): ReplayCoverage {
  const { attemptedThroughSlot, ...stored } = coverage;
  const caughtUp = stored.finalizedThroughSlot >= attemptedThroughSlot;
  const warnings = [...stored.warnings, ...attemptWarnings];
  if (!caughtUp) {
    warnings.push(
      `Verified replay stops at slot ${stored.finalizedThroughSlot}; latest attempted finalized head is ${attemptedThroughSlot}.`,
    );
  }
  return {
    ...stored,
    authoritative: stored.authoritative && caughtUp,
    tokenBalancesAuthoritative: stored.tokenBalancesAuthoritative && caughtUp,
    creatorRewardsAuthoritative: stored.creatorRewardsAuthoritative && caughtUp,
    complete: stored.complete && caughtUp,
    warnings: [...new Set(warnings)],
  };
}

export function replayCoverageThroughSlot(
  database: SolardDatabase,
  mint: string,
): number | null {
  const coverage = loadCoverage(database, mint);
  return coverage?.parserVersion === REPLAY_PARSER_VERSION
    ? coverage.finalizedThroughSlot
    : null;
}

function saveCoverage(
  database: SolardDatabase,
  coverage: ReplayCoverageState,
): void {
  const values = {
    mint: coverage.mint,
    parserVersion: coverage.parserVersion,
    recipient: coverage.recipient,
    originalCreator: coverage.originalCreator,
    creationSlot: coverage.creationSlot,
    finalizedThroughSlot: coverage.finalizedThroughSlot,
    attemptedThroughSlot: coverage.attemptedThroughSlot,
    authoritative: coverage.authoritative ? 1 : 0,
    tokenBalancesAuthoritative: coverage.tokenBalancesAuthoritative ? 1 : 0,
    creatorRewardsAuthoritative: coverage.creatorRewardsAuthoritative ? 1 : 0,
    complete: coverage.complete ? 1 : 0,
    warningsJson: JSON.stringify(coverage.warnings),
    updatedAtMs: coverage.updatedAtMs,
  };
  database.historyReplayCoverage.upsert(values, {
    on: "mint",
    merge: (table) => ({
      parserVersion: table.excluded("parserVersion"),
      recipient: table.excluded("recipient"),
      originalCreator: table.excluded("originalCreator"),
      creationSlot: table.excluded("creationSlot"),
      finalizedThroughSlot: table.max("finalizedThroughSlot", 0),
      attemptedThroughSlot: table.max("attemptedThroughSlot", 0),
      authoritative: table.excluded("authoritative"),
      tokenBalancesAuthoritative: table.excluded("tokenBalancesAuthoritative"),
      creatorRewardsAuthoritative: table.excluded(
        "creatorRewardsAuthoritative",
      ),
      complete: table.excluded("complete"),
      warningsJson: table.excluded("warningsJson"),
      updatedAtMs: table.max("updatedAtMs", 0),
    }),
  });
}

function persistItemsUnlocked(
  database: SolardDatabase,
  items: readonly ReplayItem[],
): void {
  for (const item of items) {
    const values = rowFromItem(item);
    database.historyReplayItems.upsert(values, {
      on: "replayKey",
      merge: (table) => ({
        mint: table.excluded("mint"),
        signature: table.excluded("signature"),
        slot: table.excluded("slot"),
        timestampSec: table.excluded("timestampSec"),
        transactionIndex: table.excluded("transactionIndex"),
        instructionIndex: table.excluded("instructionIndex"),
        innerInstructionIndex: table.excluded("innerInstructionIndex"),
        kind: table.excluded("kind"),
        trxJson: table.excluded("trxJson"),
        beforeBalanceRaw: table.excluded("beforeBalanceRaw"),
        postBalanceRaw: table.excluded("postBalanceRaw"),
        payoutsJson: table.excluded("payoutsJson"),
        quoteMint: table.excluded("quoteMint"),
        claimAttribution: table.excluded("claimAttribution"),
        parserVersion: table.excluded("parserVersion"),
        observedAtMs: table.excluded("observedAtMs"),
        updatedAtMs: table.max("updatedAtMs", 0),
      }),
    });
  }
}

function commitReplay(args: {
  database: SolardDatabase;
  items: readonly ReplayItem[];
  coverage: ReplayCoverageState;
  replaceFromSlot?: number;
}): void {
  args.database.transaction(() => {
    if (args.replaceFromSlot != null) {
      args.database.historyReplayItems
        .delete()
        .where({
          mint: args.coverage.mint,
          slot: { $gte: args.replaceFromSlot },
        })
        .exec();
    }
    persistItemsUnlocked(args.database, args.items);
    saveCoverage(args.database, args.coverage);
  });
}

function clearReplay(database: SolardDatabase, mint: string): void {
  database.transaction(() => {
    database.historyReplayItems.delete().where({ mint }).exec();
    database.historyReplayCoverage.delete().where({ mint }).exec();
  });
}

function historyResult(
  mint: string,
  items: readonly ReplayItem[],
  coverage: ReplayCoverageState,
  attemptWarnings: readonly string[] = [],
): ReplayHistory {
  const verified = items.filter(
    (item) => item.slot <= coverage.finalizedThroughSlot,
  );
  return {
    mint,
    items: verified,
    coverage: publicCoverage(coverage, attemptWarnings),
    *[Symbol.iterator]() {
      yield* verified;
    },
  };
}

function requestedRecipient(options: ReplayOptions): string | null {
  if (options.recipient == null) return null;
  return typeof options.recipient === "string"
    ? options.recipient.trim()
    : options.recipient.toBase58();
}

function tokenTailSafe(
  replay: Awaited<ReturnType<typeof historyRewardReplay>>,
): boolean {
  const coverage = replay.tokenHistory.coverage;
  return (
    coverage.status === "complete" &&
    (coverage.ordering === "transaction" ||
      replay.tokenHistory.events.length === 0) &&
    coverage.exhausted &&
    !coverage.truncated &&
    coverage.parseErrors === 0
  );
}

function claimCoverageSafe(
  coverage: Awaited<ReturnType<typeof historyCreatorRewards>>["coverage"],
): boolean {
  return (
    coverage.status === "complete" &&
    coverage.ordering === "transaction" &&
    coverage.missingTransactions === 0 &&
    coverage.ambiguousClaims === 0 &&
    coverage.fallbackPayoutClaims === 0 &&
    coverage.targetHistoryExhausted &&
    coverage.curveVaultHistoryExhausted &&
    coverage.ammVaultHistoryExhausted
  );
}

function claimTailSafe(
  replay: Awaited<ReturnType<typeof historyRewardReplay>>,
): boolean {
  return claimCoverageSafe(replay.claimHistory.coverage);
}

function replayFactsSafe(
  events: readonly HistoricalRewardReplayEvent[],
): boolean {
  return events.every(
    (event) =>
      event.blockTimeMs != null &&
      event.transactionIndex != null &&
      event.instructionIndex != null,
  );
}

function stableReplayFact(event: HistoricalRewardReplayEvent): string {
  return JSON.stringify(event, (key, value) => {
    if (key === "observedAtMs" || key === "source") return undefined;
    return typeof value === "bigint"
      ? { $solardBigInt: value.toString() }
      : value;
  });
}

function replayWindowMatches(
  previous: readonly ReplayItem[],
  next: readonly ReplayItem[],
): boolean {
  if (previous.length !== next.length) return false;
  const left = new Map(
    previous.map((item) => [item.id, stableReplayFact(item.raw)]),
  );
  for (const item of next) {
    if (left.get(item.id) !== stableReplayFact(item.raw)) return false;
  }
  return true;
}

function replayFactWarnings(
  events: readonly HistoricalRewardReplayEvent[],
): string[] {
  const missingTimestamp = events.filter(
    (event) => event.blockTimeMs == null,
  ).length;
  const missingOrder = events.filter(
    (event) => event.transactionIndex == null || event.instructionIndex == null,
  ).length;
  const warnings: string[] = [];
  if (missingTimestamp > 0) {
    warnings.push(
      `${missingTimestamp} replay event(s) are missing block timestamps.`,
    );
  }
  if (missingOrder > 0) {
    warnings.push(
      `${missingOrder} replay event(s) are missing exact transaction/instruction ordering.`,
    );
  }
  return warnings;
}

async function replayTokenHistoryUnlocked(args: {
  connection: Connection;
  database: SolardDatabase;
  token: TokenRow;
  options?: ReplayOptions;
}): Promise<ReplayHistory> {
  const options = args.options ?? {};
  const mint = args.token.mint;
  const head = await args.connection.getSlot("finalized");
  let coverage = loadCoverage(args.database, mint);
  const desiredRecipient = requestedRecipient(options);

  if (
    coverage &&
    (coverage.parserVersion !== REPLAY_PARSER_VERSION ||
      (desiredRecipient != null && coverage.recipient !== desiredRecipient))
  ) {
    clearReplay(args.database, mint);
    coverage = null;
  }

  if (!coverage || coverage.finalizedThroughSlot <= 0) {
    const replay = await historyRewardReplay({
      connection: args.connection,
      token: args.token,
      options: {
        recipient: options.recipient ?? coverage?.recipient ?? undefined,
        provider: options.provider,
        maxPages: options.maxPages,
        claimMaxPages: options.claimMaxPages,
        exactOrdering: true,
        verifyCurrentBalances: true,
        commitment: "finalized",
      },
    });
    const attemptedThroughSlot =
      replay.tokenHistory.coverage.requestedToSlot ??
      replay.tokenHistory.coverage.balanceVerification.snapshotSlot ??
      head;
    const factsSafe = replayFactsSafe(replay.events);
    const safe =
      tokenTailSafe(replay) &&
      replay.tokenHistory.coverage.fromCreation &&
      claimTailSafe(replay) &&
      replay.claimHistory.coverage.fromCreation &&
      factsSafe;
    const attemptWarnings = [
      ...new Set([
        ...replay.coverage.warnings,
        ...replayFactWarnings(replay.events),
      ]),
    ];
    const nextCoverage: ReplayCoverageState = {
      version: 1,
      mint,
      parserVersion: REPLAY_PARSER_VERSION,
      recipient: replay.recipient,
      originalCreator: replay.claimHistory.coverage.originalCreator,
      creationSlot:
        replay.claimHistory.coverage.creationSlot ??
        replay.tokenHistory.coverage.firstEventSlot,
      finalizedThroughSlot: safe ? attemptedThroughSlot : 0,
      attemptedThroughSlot,
      authoritative: safe && replay.coverage.authoritative,
      tokenBalancesAuthoritative:
        safe && replay.coverage.tokenBalancesAuthoritative,
      creatorRewardsAuthoritative:
        safe && replay.coverage.creatorRewardsAuthoritative,
      complete: safe,
      warnings: safe ? attemptWarnings : [],
      updatedAtMs: Date.now(),
    };
    const items = safe ? normalizeReplayEvents(mint, replay.events) : [];
    commitReplay({
      database: args.database,
      items,
      coverage: nextCoverage,
      replaceFromSlot: 0,
    });
    return historyResult(
      mint,
      loadItems(args.database, mint),
      nextCoverage,
      safe ? [] : attemptWarnings,
    );
  }

  if (head <= coverage.finalizedThroughSlot) {
    return historyResult(mint, loadItems(args.database, mint), coverage);
  }

  const fromSlot = Math.max(
    0,
    coverage.creationSlot ?? 0,
    coverage.finalizedThroughSlot - REPLAY_OVERLAP_SLOTS + 1,
  );
  const prefix = loadItemsBefore(args.database, mint, fromSlot);
  const seed = balancesFromItems(prefix);
  const token = coverage.originalCreator
    ? { ...args.token, creator: coverage.originalCreator }
    : args.token;
  const replay = await historyRewardReplay({
    connection: args.connection,
    token,
    options: {
      recipient: options.recipient ?? coverage.recipient ?? undefined,
      provider: options.provider,
      fromSlot,
      toSlot: head,
      maxPages: options.maxPages,
      claimMaxPages: options.claimMaxPages,
      exactOrdering: true,
      verifyCurrentBalances: false,
      commitment: "finalized",
    },
  });

  let claimEvents: readonly HistoricalCreatorRewardClaimEvent[] = replay.claims;
  let claimCoverage = replay.claimHistory.coverage;
  let claimWarnings = claimCoverage.warnings;
  let claimPreservesAuthoritative = claimCoverageSafe(claimCoverage);
  const needsClaimRebuild = replay.claims.some(
    (claim) => claim.attribution !== "exact-token",
  );
  if (needsClaimRebuild) {
    const claimHistory = await historyCreatorRewards({
      connection: args.connection,
      token,
      options: {
        recipient: options.recipient ?? coverage.recipient ?? undefined,
        toSlot: head,
        maxPages: options.claimMaxPages,
        exactOrdering: true,
        commitment: "finalized",
      },
    });
    claimEvents = claimHistory.claims.filter((claim) => claim.slot >= fromSlot);
    claimCoverage = claimHistory.coverage;
    claimWarnings = claimCoverage.warnings;
    claimPreservesAuthoritative =
      claimCoverage.authoritativeForRewardReplay &&
      claimCoverageSafe(claimCoverage);
  }

  const events: HistoricalRewardReplayEvent[] = [
    ...replay.transfers,
    ...claimEvents,
  ];
  const factsSafe = replayFactsSafe(events);
  const rangeSafe =
    tokenTailSafe(replay) && claimCoverageSafe(claimCoverage) && factsSafe;
  const attemptWarnings = [
    ...new Set([
      ...replay.tokenHistory.coverage.warnings,
      ...claimWarnings,
      ...replayFactWarnings(events),
    ]),
  ];

  if (!rangeSafe) {
    const attemptedCoverage: ReplayCoverageState = {
      ...coverage,
      attemptedThroughSlot: Math.max(coverage.attemptedThroughSlot, head),
      updatedAtMs: Date.now(),
    };
    coverage = attemptedCoverage;
    args.database.transaction(() =>
      saveCoverage(args.database, attemptedCoverage),
    );
    return historyResult(
      mint,
      loadItems(args.database, mint),
      attemptedCoverage,
      attemptWarnings,
    );
  }

  const items = normalizeReplayEvents(mint, events, seed);
  const previousOverlap = loadItemsFrom(args.database, mint, fromSlot).filter(
    (item) => item.slot <= coverage.finalizedThroughSlot,
  );
  const nextOverlap = items.filter(
    (item) => item.slot <= coverage.finalizedThroughSlot,
  );
  if (!replayWindowMatches(previousOverlap, nextOverlap)) {
    clearReplay(args.database, mint);
    throw new Error(
      `Replay history changed at or before the durable cursor for ${mint}; cached replay was cleared and the caller must restart from a full replay.`,
    );
  }
  const tokenBalancesAuthoritative =
    coverage.tokenBalancesAuthoritative && tokenTailSafe(replay);
  const creatorRewardsAuthoritative =
    coverage.creatorRewardsAuthoritative && claimPreservesAuthoritative;
  coverage = {
    ...coverage,
    finalizedThroughSlot: head,
    attemptedThroughSlot: Math.max(coverage.attemptedThroughSlot, head),
    authoritative:
      coverage.authoritative &&
      tokenBalancesAuthoritative &&
      creatorRewardsAuthoritative &&
      factsSafe,
    tokenBalancesAuthoritative,
    creatorRewardsAuthoritative,
    complete: coverage.complete && rangeSafe,
    warnings: [
      ...new Set([
        ...coverage.warnings,
        ...replay.tokenHistory.coverage.warnings,
        ...claimWarnings,
        ...replayFactWarnings(events),
      ]),
    ],
    updatedAtMs: Date.now(),
  };
  commitReplay({
    database: args.database,
    items,
    coverage,
    replaceFromSlot: fromSlot,
  });
  return historyResult(mint, loadItems(args.database, mint), coverage);
}

export async function replayTokenHistory(args: {
  connection: Connection;
  database: SolardDatabase;
  token: TokenRow;
  options?: ReplayOptions;
}): Promise<ReplayHistory> {
  let byMint = replayQueues.get(args.database);
  if (!byMint) {
    byMint = new Map();
    replayQueues.set(args.database, byMint);
  }
  const previous = byMint.get(args.token.mint);
  const run = previous
    ? previous.then(
        () => replayTokenHistoryUnlocked(args),
        () => replayTokenHistoryUnlocked(args),
      )
    : replayTokenHistoryUnlocked(args);
  byMint.set(args.token.mint, run);
  try {
    return await run;
  } finally {
    if (byMint.get(args.token.mint) === run) byMint.delete(args.token.mint);
  }
}

function mergeIdentity(item: ReplayItem): string {
  if (item.trx !== "claim_v2") return item.id;
  const recipient = [...item.payouts.keys()].sort().join(",");
  return [
    "claim",
    item.signature,
    item.transactionIndex ?? "?",
    item.instructionIndex ?? "?",
    item.innerInstructionIndex ?? "?",
    recipient,
    item.quoteMint ?? "?",
  ].join(":");
}

export function mergeReplayHistories(
  histories: readonly (ReplayHistory | Iterable<ReplayItem>)[],
): ReplayItem[] {
  const deduped = new Map<string, ReplayItem>();
  for (const history of histories) {
    for (const item of history) deduped.set(mergeIdentity(item), item);
  }
  return [...deduped.values()].sort(compareReplayItems);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function subscribeReplayEvents(args: {
  mint: string;
  initialThroughSlot: number | null;
  options?: ReplayEventsOptions;
  replay: (options: ReplayOptions) => Promise<ReplayHistory>;
}): Promise<ReplayEventSubscription> {
  const options = args.options ?? {};
  const controller = new AbortController();
  const externalAbort = () => controller.abort();
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const baseOptions: ReplayOptions = {
    recipient: options.recipient,
    provider: options.provider,
    maxPages: options.maxPages,
    claimMaxPages: options.claimMaxPages,
  };
  const initial = await args.replay(baseOptions);
  let through =
    args.initialThroughSlot == null
      ? initial.coverage.finalizedThroughSlot
      : args.initialThroughSlot;
  let watermark = through;
  const initialTargetWatermark = initial.coverage.finalizedThroughSlot;
  const pending = initial.items.filter(
    (item) => item.slot > through && item.slot <= initialTargetWatermark,
  );
  const pollMs = Math.max(250, Math.trunc(options.pollMs ?? 2_000));

  return {
    mint: args.mint,
    get watermark() {
      return watermark;
    },
    async close() {
      controller.abort();
      options.signal?.removeEventListener("abort", externalAbort);
    },
    async *[Symbol.asyncIterator]() {
      try {
        for (const item of pending) yield item;
        through = Math.max(through, initialTargetWatermark);
        watermark = through;
        while (!controller.signal.aborted) {
          await abortableDelay(pollMs, controller.signal);
          if (controller.signal.aborted) break;
          const next = await args.replay(baseOptions);
          const targetWatermark = next.coverage.finalizedThroughSlot;
          for (const item of next.items) {
            if (item.slot > through && item.slot <= targetWatermark) yield item;
          }
          through = Math.max(through, targetWatermark);
          watermark = through;
        }
      } finally {
        options.signal?.removeEventListener("abort", externalAbort);
      }
    },
  };
}

export function mergeReplayEventSubscriptions(
  streams: readonly ReplayEventSubscription[],
): MergedReplayEventStream {
  const controller = new AbortController();
  const buffered: ReplayItem[] = [];
  const emitted = new Set<string>();
  let wake: (() => void) | null = null;
  let pumpsStarted = false;
  let pumpPromise: Promise<void> | null = null;
  let pumpError: unknown = null;
  let completedPumps = 0;
  let closed = false;

  const notify = () => {
    const current = wake;
    wake = null;
    current?.();
  };

  const startPumps = () => {
    if (pumpsStarted) return;
    pumpsStarted = true;
    pumpPromise = Promise.all(
      streams.map(async (stream) => {
        try {
          for await (const item of stream) {
            if (controller.signal.aborted) break;
            buffered.push(item);
            notify();
          }
        } catch (error) {
          if (pumpError == null) pumpError = error;
        } finally {
          completedPumps += 1;
          notify();
        }
      }),
    ).then(() => undefined);
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    controller.abort();
    await Promise.all(streams.map((stream) => stream.close().catch(() => {})));
    notify();
    await pumpPromise?.catch(() => {});
  };

  return {
    close,
    async *[Symbol.asyncIterator]() {
      startPumps();
      try {
        while (!controller.signal.aborted) {
          if (pumpError != null) throw pumpError;
          if (completedPumps === streams.length && buffered.length === 0) break;
          buffered.sort(compareReplayItems);
          const watermark = streams.length
            ? Math.min(...streams.map((stream) => stream.watermark))
            : Number.MAX_SAFE_INTEGER;
          let yielded = false;
          while (buffered.length && buffered[0]!.slot <= watermark) {
            const item = buffered.shift()!;
            const key = mergeIdentity(item);
            if (emitted.has(key)) continue;
            emitted.add(key);
            yielded = true;
            yield item;
          }
          if (controller.signal.aborted) break;
          if (!yielded) {
            await Promise.race([
              new Promise<void>((resolve) => {
                wake = resolve;
              }),
              new Promise<void>((resolve) => setTimeout(resolve, 50)),
            ]);
          }
        }
      } finally {
        await close();
      }
    },
  };
}
