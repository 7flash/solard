import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import bs58 from "bs58";

import { closeDatabase, openDatabase } from "../db/database.ts";
import type { SolardDatabase } from "../db/schema.ts";
import {
  claimPhysicalId,
  type SolardCanonicalEvent,
} from "../events/canonical-events.ts";
import {
  cacheParsedTransaction,
  createRawTransactionCachingConnection,
} from "../events/raw-transaction-cache.ts";
import {
  UnsupportedTokenAccountingSemanticsError,
  reduceTokenAccountTransaction,
} from "../events/token-account-reducer.ts";
import { parseTokenTransferEvents } from "../events/token-events.ts";
import {
  commitReplayForTest,
  mergeReplayHistories,
  normalizeReplayEvent,
  normalizeReplayEvents,
  replayWindowMatches,
  subscribeReplayEvents,
  type ReplayCoverage,
  type ReplayHistory,
  type ReplayItem,
} from "../history/replay.ts";
import {
  executeCumulativeDistribution,
  getCumulativeDistributionState,
  planCumulativeDistribution,
  type CumulativeDistributionExecuteOptions,
} from "../distributions/cumulative.ts";
import type { Solard } from "../core/solard.ts";
import type { TransactionDraft } from "../tx/types.ts";
import {
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_ID,
} from "../venues/pump/constants.ts";

function tempDatabase(prefix: string) {
  const path = join(
    tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random()}.sqlite`,
  );
  return {
    path,
    open: () => openDatabase(path),
    close: () => closeDatabase(path),
    cleanup: () => {
      closeDatabase(path);
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    },
  };
}

function transferEvent(args: {
  id: string;
  mint: string;
  slot: number;
  sourceOwner: string | null;
  destinationOwner: string | null;
  amountRaw: bigint;
  instructionIndex?: number;
}): Extract<SolardCanonicalEvent, { type: "transfer" }> {
  return {
    id: args.id,
    type: "transfer",
    mint: args.mint,
    signature: `sig-${args.id}`,
    slot: args.slot,
    observedAtMs: args.slot * 1_000,
    blockTimeMs: args.slot * 1_000,
    confidence: "finalized",
    movement: args.sourceOwner == null ? "mint" : "transfer",
    source: "rpc-history",
    sourceTokenAccount: args.sourceOwner == null ? null : `source-${args.id}`,
    destinationTokenAccount: `destination-${args.id}`,
    sourceOwner: args.sourceOwner,
    destinationOwner: args.destinationOwner,
    authority: args.sourceOwner,
    amountRaw: args.amountRaw,
    feeRaw: 0n,
    decimals: 6,
    instructionType:
      args.sourceOwner == null ? "mintToChecked" : "transferChecked",
    transactionIndex: 0,
    instructionIndex: args.instructionIndex ?? 0,
    innerInstructionIndex: null,
  };
}

function claimEvent(args: {
  id: string;
  slot: number;
  tokenMint: string | null;
  assetMint: string;
  recipient: string;
  amountRaw: bigint;
}): Extract<SolardCanonicalEvent, { type: "claim" }> {
  return {
    id: args.id,
    type: "claim",
    program: "pump",
    tokenMint: args.tokenMint,
    payout: {
      assetMint: args.assetMint,
      recipient: args.recipient,
      amountRaw: args.amountRaw,
    },
    signature: `sig-${args.id}`,
    slot: args.slot,
    transactionIndex: 0,
    instructionIndex: 0,
    innerInstructionIndex: null,
    blockTimeMs: args.slot * 1_000,
    observedAtMs: args.slot * 1_000,
    confidence: "finalized",
    attribution:
      args.tokenMint == null ? "creator-aggregate-ambiguous" : "exact-token",
    claimKinds: ["collect_creator_fee_v2"],
    exactTokenInstruction: args.tokenMint != null,
    payoutEvidence: "claim-instruction-transfer",
  };
}

function replayHistory(
  mint: string,
  items: readonly ReplayItem[],
  throughSlot: number,
): ReplayHistory {
  const coverage: ReplayCoverage = {
    version: 1,
    mint,
    fromCreation: true,
    throughSlot,
    complete: true,
    warnings: [],
    updatedAtMs: 0,
  };
  return {
    mint,
    items,
    coverage,
    *[Symbol.iterator]() {
      yield* items;
    },
  };
}

type FairfunCheckpoint = {
  balances: Array<[string, string]>;
  payouts: Array<[string, string]>;
  seen: string[];
};

class FairfunAcceptanceReducer {
  private readonly balances = new Map<string, bigint>();
  private readonly payouts = new Map<string, bigint>();
  private readonly seen = new Set<string>();

  static restore(checkpoint: FairfunCheckpoint): FairfunAcceptanceReducer {
    const reducer = new FairfunAcceptanceReducer();
    for (const [owner, amount] of checkpoint.balances)
      reducer.balances.set(owner, BigInt(amount));
    for (const [key, amount] of checkpoint.payouts)
      reducer.payouts.set(key, BigInt(amount));
    for (const id of checkpoint.seen) reducer.seen.add(id);
    return reducer;
  }

  reduce(item: ReplayItem): void {
    if (this.seen.has(item.id)) return;
    this.seen.add(item.id);
    for (const [owner, amount] of item.postBalance) {
      if (amount === 0n) this.balances.delete(owner);
      else this.balances.set(owner, amount);
    }
    for (const payout of item.payouts) {
      const key = `${payout.assetMint}:${payout.recipient}`;
      this.payouts.set(key, (this.payouts.get(key) ?? 0n) + payout.amountRaw);
    }
  }

  checkpoint(): FairfunCheckpoint {
    return {
      balances: [...this.balances]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([owner, amount]) => [owner, amount.toString()]),
      payouts: [...this.payouts]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, amount]) => [key, amount.toString()]),
      seen: [...this.seen].sort(),
    };
  }
}

function parsedInstruction(
  programId: PublicKey,
  type: string,
  info: Record<string, unknown>,
) {
  return { programId, parsed: { type, info } } as any;
}

function tokenTransaction(args: {
  mint: string;
  pre: Array<{ address: string; owner: string; amount: bigint }>;
  post: Array<{ address: string; owner: string; amount: bigint }>;
  outer: any[];
  inner?: Array<{ index: number; instructions: any[] }>;
}): ParsedTransactionWithMeta {
  const addresses = [
    ...new Set([...args.pre, ...args.post].map((row) => row.address)),
  ];
  const index = new Map(addresses.map((address, i) => [address, i]));
  return {
    slot: 10,
    blockTime: 100,
    meta: {
      err: null,
      fee: 5_000,
      preBalances: addresses.map(() => 0),
      postBalances: addresses.map(() => 0),
      preTokenBalances: args.pre.map((row) => ({
        accountIndex: index.get(row.address)!,
        mint: args.mint,
        owner: row.owner,
        uiTokenAmount: {
          amount: row.amount.toString(),
          decimals: 6,
          uiAmount: null,
          uiAmountString: "0",
        },
      })),
      postTokenBalances: args.post.map((row) => ({
        accountIndex: index.get(row.address)!,
        mint: args.mint,
        owner: row.owner,
        uiTokenAmount: {
          amount: row.amount.toString(),
          decimals: 6,
          uiAmount: null,
          uiAmountString: "0",
        },
      })),
      innerInstructions: args.inner ?? [],
      logMessages: [],
      rewards: [],
      loadedAddresses: { readonly: [], writable: [] },
      computeUnitsConsumed: 1,
    },
    transaction: {
      message: {
        accountKeys: addresses.map((address) => ({
          pubkey: new PublicKey(address),
          signer: false,
          writable: true,
        })),
        instructions: args.outer,
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
      } as any,
      signatures: ["signature"],
    },
  } as ParsedTransactionWithMeta;
}

type DistributionChainState = "not-found" | "pending" | "confirmed" | "failed";
type DistributionSendMode =
  "accept" | "throw-before" | "accept-then-throw" | "forbid";

function distributionFixture(args: {
  database: SolardDatabase;
  source: Keypair;
  chainState?: DistributionChainState;
  sendMode?: DistributionSendMode;
  balance?: bigint;
}) {
  let chainState: DistributionChainState = args.chainState ?? "not-found";
  let sends = 0;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const connection = {
    getBalance: async () => Number(args.balance ?? 10_000_000n),
    getLatestBlockhash: async () => ({
      blockhash,
      lastValidBlockHeight: 1_000,
    }),
    getSignatureStatuses: async () => ({
      value: [
        chainState === "not-found"
          ? null
          : chainState === "pending"
            ? {
                slot: 9,
                err: null,
                confirmations: 1,
                confirmationStatus: "processed",
              }
            : chainState === "confirmed"
              ? {
                  slot: 10,
                  err: null,
                  confirmations: null,
                  confirmationStatus: "finalized",
                }
              : {
                  slot: 10,
                  err: { InstructionError: [0, "Custom"] },
                  confirmations: null,
                  confirmationStatus: "finalized",
                },
      ],
    }),
    getParsedTransaction: async () =>
      chainState === "confirmed"
        ? ({ meta: { err: null } } as any)
        : chainState === "failed"
          ? ({ meta: { err: { InstructionError: [0, "Custom"] } } } as any)
          : null,
    getBlockHeight: async () => 100,
  } as unknown as Connection;

  const compile = async (payer: Keypair, draft: TransactionDraft) => {
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: draft.instructions,
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([payer, ...draft.signers]);
    return {
      transaction,
      draft,
      lookupTables: [],
      serializedSize: transaction.serialize().length,
      payer: payer.publicKey,
      recentBlockhash: blockhash,
      lastValidBlockHeight: 1_000,
    };
  };

  const slrd = {
    db: args.database,
    resolveWallet: () => ({ address: args.source.publicKey }),
    signer: () => args.source,
    connection: () => connection,
    alts: { list: () => [] },
    compile,
    simulatePlan: async () => ({ success: true, logs: [] }),
    confirmSignature: async (signature: string, sender: string) => ({
      signature,
      sender,
      slot: chainState === "confirmed" ? 10 : null,
      status:
        chainState === "confirmed"
          ? ("confirmed" as const)
          : chainState === "failed"
            ? ("failed" as const)
            : ("submitted" as const),
      ...(chainState === "failed" ? { error: "on-chain failure" } : {}),
    }),
    senders: {
      resolve: () => ({
        send: async ({
          transaction,
        }: {
          transaction: VersionedTransaction;
        }) => {
          sends += 1;
          const signature = bs58.encode(transaction.signatures[0]!);
          const mode = args.sendMode ?? "accept";
          if (mode === "forbid") throw new Error("submission forbidden");
          if (mode === "throw-before")
            throw new Error("transport failed before acceptance");
          if (mode === "accept-then-throw") {
            chainState = "confirmed";
            throw new Error("transport response lost after acceptance");
          }
          chainState = "confirmed";
          return signature;
        },
      }),
    },
  } as unknown as Solard;

  return {
    slrd,
    sends: () => sends,
    setChainState: (value: DistributionChainState) => {
      chainState = value;
    },
  };
}

function distributionOptions(
  id: string,
  recipient: PublicKey,
): CumulativeDistributionExecuteOptions {
  return {
    id,
    from: "source",
    asset: "SOL",
    entitlements: [{ recipient, entitledRaw: 1_000n }],
    via: "rpc",
    skipSimulation: true,
  };
}

function rewindLastSubmission(database: SolardDatabase, id: string): void {
  const key = `cumulative-distribution:v1:${id}`;
  const row = database.settings.select().where({ key }).first() as
    { value?: string } | undefined;
  if (!row?.value) throw new Error(`missing distribution state ${id}`);
  const state = JSON.parse(row.value) as {
    pending?: { lastSubmittedAtMs?: number | null } | null;
  };
  if (!state.pending)
    throw new Error(`missing pending distribution state ${id}`);
  state.pending.lastSubmittedAtMs = 0;
  database.settings
    .update({ value: JSON.stringify(state), updatedAtMs: Date.now() })
    .where({ key })
    .exec();
}

describe("Fairfun V49 acceptance", () => {
  test("full replay equals checkpoint restart", () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const quote = Keypair.generate().publicKey.toBase58();
    const alice = Keypair.generate().publicKey.toBase58();
    const bob = Keypair.generate().publicKey.toBase58();
    const events: SolardCanonicalEvent[] = [
      transferEvent({
        id: "mint",
        mint,
        slot: 1,
        sourceOwner: null,
        destinationOwner: alice,
        amountRaw: 100n,
      }),
      transferEvent({
        id: "transfer-1",
        mint,
        slot: 2,
        sourceOwner: alice,
        destinationOwner: bob,
        amountRaw: 25n,
      }),
      claimEvent({
        id: "claim",
        slot: 3,
        tokenMint: mint,
        assetMint: quote,
        recipient: alice,
        amountRaw: 7n,
      }),
      transferEvent({
        id: "transfer-2",
        mint,
        slot: 4,
        sourceOwner: bob,
        destinationOwner: alice,
        amountRaw: 5n,
      }),
    ];
    const items = normalizeReplayEvents(mint, events);
    const full = new FairfunAcceptanceReducer();
    for (const item of items) full.reduce(item);
    const prefix = new FairfunAcceptanceReducer();
    for (const item of items.slice(0, 2)) prefix.reduce(item);
    const restarted = FairfunAcceptanceReducer.restore(prefix.checkpoint());
    for (const item of items.slice(2)) restarted.reduce(item);
    expect(restarted.checkpoint()).toEqual(full.checkpoint());
  });

  test("historical plus live equals a later full replay", async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const alice = Keypair.generate().publicKey.toBase58();
    const bob = Keypair.generate().publicKey.toBase58();
    const events = [
      transferEvent({
        id: "m",
        mint,
        slot: 1,
        sourceOwner: null,
        destinationOwner: alice,
        amountRaw: 100n,
      }),
      transferEvent({
        id: "a",
        mint,
        slot: 2,
        sourceOwner: alice,
        destinationOwner: bob,
        amountRaw: 10n,
      }),
      transferEvent({
        id: "b",
        mint,
        slot: 3,
        sourceOwner: alice,
        destinationOwner: bob,
        amountRaw: 10n,
      }),
      transferEvent({
        id: "c",
        mint,
        slot: 4,
        sourceOwner: bob,
        destinationOwner: alice,
        amountRaw: 5n,
      }),
    ];
    const items = normalizeReplayEvents(mint, events);
    const historical = items.slice(0, 2);
    const reducer = new FairfunAcceptanceReducer();
    for (const item of historical) reducer.reduce(item);
    const stream = await subscribeReplayEvents({
      mint,
      initialThroughSlot: 2,
      options: { pollMs: 250 },
      replay: async () => replayHistory(mint, items, 4),
    });
    const iterator = stream[Symbol.asyncIterator]();
    for (let index = 0; index < 2; index += 1) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      reducer.reduce(next.value!);
    }
    await stream.close();
    await iterator.next();
    const laterFull = new FairfunAcceptanceReducer();
    for (const item of items) laterFull.reduce(item);
    expect(reducer.checkpoint()).toEqual(laterFull.checkpoint());
  });

  test("delayed discovery repairs only the unissued tail", () => {
    const db = tempDatabase("solard-fairfun-late");
    const database = db.open();
    const mint = Keypair.generate().publicKey.toBase58();
    const alice = Keypair.generate().publicKey.toBase58();
    const bob = Keypair.generate().publicKey.toBase58();
    try {
      const initial = normalizeReplayEvents(mint, [
        transferEvent({
          id: "m",
          mint,
          slot: 1,
          sourceOwner: null,
          destinationOwner: alice,
          amountRaw: 100n,
        }),
        transferEvent({
          id: "a",
          mint,
          slot: 4,
          sourceOwner: alice,
          destinationOwner: bob,
          amountRaw: 10n,
        }),
      ]);
      const coverage5 = {
        version: 1 as const,
        mint,
        parserVersion: "neutral-replay-v4",
        recipient: null,
        originalCreator: null,
        creationSlot: 1,
        finalizedThroughSlot: 5,
        attemptedThroughSlot: 5,
        authoritative: true,
        tokenBalancesAuthoritative: true,
        creatorRewardsAuthoritative: true,
        complete: true,
        warnings: [],
        updatedAtMs: Date.now(),
      };
      commitReplayForTest({
        database,
        items: initial,
        coverage: coverage5,
        replaceFromSlot: 0,
      });
      const repaired = normalizeReplayEvents(mint, [
        transferEvent({
          id: "m",
          mint,
          slot: 1,
          sourceOwner: null,
          destinationOwner: alice,
          amountRaw: 100n,
        }),
        transferEvent({
          id: "a",
          mint,
          slot: 4,
          sourceOwner: alice,
          destinationOwner: bob,
          amountRaw: 10n,
        }),
        transferEvent({
          id: "late",
          mint,
          slot: 6,
          sourceOwner: alice,
          destinationOwner: bob,
          amountRaw: 5n,
        }),
      ]);
      expect(
        replayWindowMatches(
          initial.filter((item) => item.slot <= 5),
          repaired.filter((item) => item.slot <= 5),
        ),
      ).toBe(true);
      commitReplayForTest({
        database,
        items: repaired,
        coverage: {
          ...coverage5,
          finalizedThroughSlot: 8,
          attemptedThroughSlot: 8,
        },
        replaceFromSlot: 0,
      });
      const stored = database.historyReplayItems
        .select()
        .where({ mint })
        .all() as Array<{ signature: string }>;
      expect(stored.some((row) => row.signature === "sig-late")).toBe(true);
      const coverage = database.historyReplayCoverage
        .select()
        .where({ mint })
        .first() as { finalizedThroughSlot: number };
      expect(coverage.finalizedThroughSlot).toBe(8);
      const historicalRevision = normalizeReplayEvents(mint, [
        transferEvent({
          id: "m",
          mint,
          slot: 1,
          sourceOwner: null,
          destinationOwner: alice,
          amountRaw: 100n,
        }),
        transferEvent({
          id: "too-late",
          mint,
          slot: 3,
          sourceOwner: alice,
          destinationOwner: bob,
          amountRaw: 1n,
        }),
        transferEvent({
          id: "a",
          mint,
          slot: 4,
          sourceOwner: alice,
          destinationOwner: bob,
          amountRaw: 10n,
        }),
      ]);
      expect(replayWindowMatches(initial, historicalRevision)).toBe(false);
    } finally {
      db.cleanup();
    }
  });

  test("duplicate cross-mint physical claims reduce once", () => {
    const mintA = Keypair.generate().publicKey.toBase58();
    const mintB = Keypair.generate().publicKey.toBase58();
    const recipient = Keypair.generate().publicKey.toBase58();
    const quote = Keypair.generate().publicKey.toBase58();
    const id = claimPhysicalId({
      signature: "physical-claim",
      positions: [{ instructionIndex: 4, innerInstructionIndex: 1 }],
    });
    const claim = claimEvent({
      id,
      slot: 7,
      tokenMint: null,
      assetMint: quote,
      recipient,
      amountRaw: 55n,
    });
    const left = normalizeReplayEvent(mintA, claim);
    const right = normalizeReplayEvent(mintB, claim);
    const merged = mergeReplayHistories([[left], [right]]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe(id);
  });

  test("multiple token accounts aggregate at the owner layer", () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const alice = Keypair.generate().publicKey.toBase58();
    const bob = Keypair.generate().publicKey.toBase58();
    const sourceA = Keypair.generate().publicKey.toBase58();
    const sourceB = Keypair.generate().publicKey.toBase58();
    const destination = Keypair.generate().publicKey.toBase58();
    const tx = tokenTransaction({
      mint,
      pre: [
        { address: sourceA, owner: alice, amount: 60n },
        { address: sourceB, owner: alice, amount: 40n },
        { address: destination, owner: bob, amount: 0n },
      ],
      post: [
        { address: sourceA, owner: alice, amount: 50n },
        { address: sourceB, owner: alice, amount: 40n },
        { address: destination, owner: bob, amount: 10n },
      ],
      outer: [
        parsedInstruction(SPL_TOKEN_PROGRAM_ID, "transfer", {
          source: sourceA,
          destination,
          authority: alice,
          amount: "10",
        }),
      ],
    });
    const reduced = reduceTokenAccountTransaction({
      tx,
      signature: "aggregate",
      mint,
      decimals: 6,
      confidence: "finalized",
    });
    expect(reduced.ownerBalancesBefore.get(alice)).toBe(100n);
    expect(reduced.ownerBalancesAfter.get(alice)).toBe(90n);
    expect(reduced.ownerBalancesAfter.get(bob)).toBe(10n);
  });

  test("owner changes affect subsequent instructions in the same transaction", () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const alice = Keypair.generate().publicKey.toBase58();
    const bob = Keypair.generate().publicKey.toBase58();
    const carol = Keypair.generate().publicKey.toBase58();
    const source = Keypair.generate().publicKey.toBase58();
    const destination = Keypair.generate().publicKey.toBase58();
    const tx = tokenTransaction({
      mint,
      pre: [
        { address: source, owner: alice, amount: 100n },
        { address: destination, owner: bob, amount: 0n },
      ],
      post: [
        { address: source, owner: carol, amount: 75n },
        { address: destination, owner: bob, amount: 25n },
      ],
      outer: [
        parsedInstruction(SPL_TOKEN_PROGRAM_ID, "setAuthority", {
          account: source,
          authority: alice,
          authorityType: "accountOwner",
          newAuthority: carol,
        }),
        parsedInstruction(SPL_TOKEN_PROGRAM_ID, "transfer", {
          source,
          destination,
          authority: carol,
          amount: "25",
        }),
      ],
    });
    const reduced = reduceTokenAccountTransaction({
      tx,
      signature: "owner-change",
      mint,
      decimals: 6,
      confidence: "finalized",
    });
    expect(reduced.events.map((event) => event.movement)).toEqual([
      "change-owner",
      "transfer",
    ]);
    expect(reduced.events[1]!.sourceOwner).toBe(carol);
    expect(reduced.ownerBalancesAfter.get(carol)).toBe(75n);
    expect(reduced.ownerBalancesAfter.get(bob)).toBe(25n);
  });

  test("unsupported Token-2022 accounting semantics fail strict replay", () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const alice = Keypair.generate().publicKey.toBase58();
    const source = Keypair.generate().publicKey.toBase58();
    const tx = tokenTransaction({
      mint,
      pre: [{ address: source, owner: alice, amount: 100n }],
      post: [{ address: source, owner: alice, amount: 100n }],
      outer: [
        parsedInstruction(TOKEN_2022_ID, "syncNative", { account: source }),
      ],
    });
    expect(() =>
      reduceTokenAccountTransaction({
        tx,
        signature: "unsupported",
        mint,
        decimals: 6,
        confidence: "finalized",
      }),
    ).toThrow(UnsupportedTokenAccountingSemanticsError);
  });

  test("parser output rebuilds from the global raw cache with networking disabled", async () => {
    const db = tempDatabase("solard-fairfun-cache");
    const database = db.open();
    const mint = Keypair.generate().publicKey.toBase58();
    const alice = Keypair.generate().publicKey.toBase58();
    const bob = Keypair.generate().publicKey.toBase58();
    const source = Keypair.generate().publicKey.toBase58();
    const destination = Keypair.generate().publicKey.toBase58();
    const tx = tokenTransaction({
      mint,
      pre: [
        { address: source, owner: alice, amount: 100n },
        { address: destination, owner: bob, amount: 0n },
      ],
      post: [
        { address: source, owner: alice, amount: 75n },
        { address: destination, owner: bob, amount: 25n },
      ],
      outer: [
        parsedInstruction(SPL_TOKEN_PROGRAM_ID, "transferChecked", {
          source,
          destination,
          mint,
          authority: alice,
          tokenAmount: { amount: "25", decimals: 6 },
        }),
      ],
    });
    try {
      cacheParsedTransaction({
        database,
        signature: "cached-signature",
        transaction: tx,
        confidence: "finalized",
      });
      let networkCalls = 0;
      const target = new Proxy(
        {},
        {
          get() {
            return async () => {
              networkCalls += 1;
              throw new Error("network disabled");
            };
          },
        },
      ) as Connection;
      const offline = createRawTransactionCachingConnection({
        connection: target,
        database,
        network: false,
      });
      const cached = await offline.getParsedTransaction("cached-signature", {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
      expect(cached).not.toBeNull();
      const rebuilt = parseTokenTransferEvents({
        tx: cached!,
        signature: "cached-signature",
        mint,
        decimals: 6,
        confidence: "finalized",
      });
      expect(networkCalls).toBe(0);
      expect(rebuilt).toHaveLength(1);
      expect(rebuilt[0]!.amountRaw).toBe(25n);
    } finally {
      db.cleanup();
    }
  });

  test("ambiguous payment submission reconciles before any retry", async () => {
    const db = tempDatabase("solard-fairfun-ambiguous");
    const source = Keypair.generate();
    const recipient = Keypair.generate().publicKey;
    const id = "fairfun:ambiguous";
    try {
      let database = db.open();
      const first = distributionFixture({
        database,
        source,
        sendMode: "accept-then-throw",
      });
      await expect(
        executeCumulativeDistribution(
          first.slrd,
          distributionOptions(id, recipient),
        ),
      ).rejects.toThrow("transport response lost after acceptance");
      const pending = getCumulativeDistributionState(first.slrd, id)!;
      expect(pending.pending).not.toBeNull();
      expect(pending.recipients[0]!.confirmedPaidRaw).toBe("0");
      db.close();

      database = db.open();
      const restarted = distributionFixture({
        database,
        source,
        chainState: "confirmed",
        sendMode: "forbid",
      });
      const state = await executeCumulativeDistribution(
        restarted.slrd,
        distributionOptions(id, recipient),
      );
      expect(state.status).toBe("complete");
      expect(state.recipients[0]!.confirmedPaidRaw).toBe("1000");
      expect(restarted.sends()).toBe(0);
    } finally {
      db.cleanup();
    }
  });

  test("process restart is safe at every cumulative-distribution durable boundary", async () => {
    const db = tempDatabase("solard-fairfun-restart");
    const source = Keypair.generate();
    const recipient = Keypair.generate().publicKey;
    try {
      let database = db.open();
      const intentId = "fairfun:restart:intent";
      const intent = distributionFixture({ database, source });
      await planCumulativeDistribution(
        intent.slrd,
        distributionOptions(intentId, recipient),
      );
      db.close();
      database = db.open();
      const intentRestart = distributionFixture({
        database,
        source,
        sendMode: "accept",
      });
      const intentComplete = await executeCumulativeDistribution(
        intentRestart.slrd,
        distributionOptions(intentId, recipient),
      );
      expect(intentComplete.status).toBe("complete");
      expect(intentComplete.recipients[0]!.confirmedPaidRaw).toBe("1000");
      db.close();

      database = db.open();
      const pendingId = "fairfun:restart:pending";
      const pending = distributionFixture({
        database,
        source,
        sendMode: "throw-before",
      });
      await expect(
        executeCumulativeDistribution(
          pending.slrd,
          distributionOptions(pendingId, recipient),
        ),
      ).rejects.toThrow("transport failed before acceptance");
      expect(
        getCumulativeDistributionState(pending.slrd, pendingId)!.pending,
      ).not.toBeNull();
      rewindLastSubmission(database, pendingId);
      db.close();
      database = db.open();
      const pendingRestart = distributionFixture({
        database,
        source,
        chainState: "not-found",
        sendMode: "accept",
      });
      const pendingComplete = await executeCumulativeDistribution(
        pendingRestart.slrd,
        distributionOptions(pendingId, recipient),
      );
      expect(pendingComplete.status).toBe("complete");
      expect(pendingComplete.recipients[0]!.confirmedPaidRaw).toBe("1000");
      db.close();

      database = db.open();
      const confirmedId = "fairfun:restart:confirmed-before-accounting";
      const confirmed = distributionFixture({
        database,
        source,
        sendMode: "accept-then-throw",
      });
      await expect(
        executeCumulativeDistribution(
          confirmed.slrd,
          distributionOptions(confirmedId, recipient),
        ),
      ).rejects.toThrow("transport response lost after acceptance");
      db.close();
      database = db.open();
      const confirmedRestart = distributionFixture({
        database,
        source,
        chainState: "confirmed",
        sendMode: "forbid",
      });
      const confirmedComplete = await executeCumulativeDistribution(
        confirmedRestart.slrd,
        distributionOptions(confirmedId, recipient),
      );
      expect(confirmedComplete.status).toBe("complete");
      expect(confirmedRestart.sends()).toBe(0);
      db.close();

      database = db.open();
      const accountingRestart = distributionFixture({
        database,
        source,
        chainState: "confirmed",
        sendMode: "forbid",
      });
      const afterAccounting = await executeCumulativeDistribution(
        accountingRestart.slrd,
        distributionOptions(confirmedId, recipient),
      );
      expect(afterAccounting.status).toBe("complete");
      expect(afterAccounting.recipients[0]!.confirmedPaidRaw).toBe("1000");
      expect(accountingRestart.sends()).toBe(0);
    } finally {
      db.cleanup();
    }
  });
});
