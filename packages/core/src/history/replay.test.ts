import { describe, expect, test } from "bun:test";

import {
  compareReplayItems,
  mergeReplayHistories,
  normalizeReplayEvent,
  normalizeReplayEvents,
  subscribeReplayEvents,
  type ReplayCoverage,
  type ReplayHistory,
  type ReplayItem,
} from "./replay.ts";
import type { SolardCanonicalEvent } from "../events/canonical-events.ts";

function transfer(
  id: string,
  slot: number,
  sourceOwner: string | null = "a",
  destinationOwner: string | null = "b",
  amountRaw = 10n,
): Extract<SolardCanonicalEvent, { type: "transfer" }> {
  return {
    id,
    type: "transfer",
    mint: "mint",
    signature: `sig-${id}`,
    slot,
    observedAtMs: slot * 1_000,
    blockTimeMs: slot * 1_000,
    confidence: "finalized",
    movement: "transfer",
    source: "rpc-history",
    sourceTokenAccount: "source",
    destinationTokenAccount: "destination",
    sourceOwner,
    destinationOwner,
    authority: sourceOwner,
    amountRaw,
    feeRaw: 0n,
    decimals: 6,
    instructionType: "transferChecked",
    transactionIndex: 1,
    instructionIndex: 0,
    innerInstructionIndex: null,
  };
}

function mint(
  id: string,
  slot: number,
  owner: string,
  amountRaw: bigint,
): Extract<SolardCanonicalEvent, { type: "transfer" }> {
  return {
    ...transfer(id, slot, null, owner, amountRaw),
    movement: "mint",
    sourceOwner: null,
    sourceTokenAccount: null,
  };
}

describe("neutral replay", () => {
  test("normalizes claim payouts", () => {
    const claim: SolardCanonicalEvent = {
      id: "claim",
      type: "claim",
      program: "pump",
      tokenMint: "mint",
      payout: { assetMint: "quote", recipient: "claimer", amountRaw: 123n },
      signature: "sig",
      slot: 4,
      transactionIndex: 2,
      instructionIndex: 3,
      innerInstructionIndex: null,
      blockTimeMs: 4_000,
      observedAtMs: 4_000,
      confidence: "finalized",
      attribution: "exact-token",
      claimKinds: ["collect_creator_fee_v2"],
      exactTokenInstruction: true,
      payoutEvidence: "claim-instruction-transfer",
    };
    const item = normalizeReplayEvent("mint", claim);
    expect(item.trx).toBe("claim");
    expect(item.beforeBalance.size).toBe(0);
    expect(item.postBalance.size).toBe(0);
    expect(item.payouts).toEqual([
      { assetMint: "quote", recipient: "claimer", amountRaw: 123n },
    ]);
  });

  test("builds affected-owner before and post balances", () => {
    const rows = normalizeReplayEvents("mint", [
      mint("m", 1, "alice", 100n),
      transfer("t", 2, "alice", "bob", 25n),
    ]);
    expect(rows[0]!.trx).toBe("mint");
    expect(rows[0]!.beforeBalance.get("alice")).toBe(0n);
    expect(rows[0]!.postBalance.get("alice")).toBe(100n);
    expect(rows[1]!.beforeBalance.get("alice")).toBe(100n);
    expect(rows[1]!.postBalance.get("alice")).toBe(75n);
    expect(rows[1]!.beforeBalance.get("bob")).toBe(0n);
    expect(rows[1]!.postBalance.get("bob")).toBe(25n);
  });

  test("merges chronologically and deduplicates", () => {
    const state = new Map<string, bigint>([["a", 20n]]);
    const a = normalizeReplayEvent("mint", transfer("a", 2), state);
    const b = normalizeReplayEvent(
      "mint",
      transfer("b", 1),
      new Map([["a", 20n]]),
    );
    const merged = mergeReplayHistories([
      {
        *[Symbol.iterator]() {
          yield a;
          yield b;
        },
      },
      {
        *[Symbol.iterator]() {
          yield a;
        },
      },
    ]);
    expect(merged.map((item) => item.id)).toEqual([b.id, a.id]);
    expect(compareReplayItems(b, a)).toBeLessThan(0);
  });
});

function replayHistory(
  items: readonly ReplayItem[],
  finalizedThroughSlot: number,
): ReplayHistory {
  const coverage: ReplayCoverage = {
    version: 1,
    mint: "mint",
    fromCreation: true,
    throughSlot: finalizedThroughSlot,
    complete: true,
    warnings: [],
    updatedAtMs: 0,
  };
  return {
    mint: "mint",
    items,
    coverage,
    *[Symbol.iterator]() {
      yield* items;
    },
  };
}

describe("durable replay subscription", () => {
  test("never emits an item beyond the persisted finalized cursor", async () => {
    const items = normalizeReplayEvents("mint", [
      mint("m", 1, "alice", 100n),
      transfer("unsafe", 6, "alice", "bob", 10n),
    ]);
    const stream = await subscribeReplayEvents({
      mint: "mint",
      initialThroughSlot: 0,
      options: { pollMs: 250 },
      replay: async () => replayHistory(items, 5),
    });
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.slot).toBe(1);
    await stream.close();
    const done = await iterator.next();
    expect(done.done).toBe(true);
    expect(stream.watermark).toBe(5);
  });

  test("replay-to-live handoff emits the verified tail exactly once", async () => {
    const first = normalizeReplayEvents("mint", [
      mint("m", 1, "alice", 100n),
      transfer("a", 6, "alice", "bob", 10n),
      transfer("b", 7, "alice", "bob", 10n),
    ]);
    const second = normalizeReplayEvents("mint", [
      mint("m", 1, "alice", 100n),
      transfer("a", 6, "alice", "bob", 10n),
      transfer("b", 7, "alice", "bob", 10n),
      transfer("c", 8, "alice", "bob", 10n),
    ]);
    let calls = 0;
    const stream = await subscribeReplayEvents({
      mint: "mint",
      initialThroughSlot: 5,
      options: { pollMs: 250 },
      replay: async () => {
        calls += 1;
        return calls === 1 ? replayHistory(first, 7) : replayHistory(second, 8);
      },
    });
    const iterator = stream[Symbol.asyncIterator]();
    const slots: number[] = [];
    slots.push((await iterator.next()).value!.slot);
    slots.push((await iterator.next()).value!.slot);
    slots.push((await iterator.next()).value!.slot);
    await stream.close();
    expect(slots).toEqual([6, 7, 8]);
    expect(stream.watermark).toBe(7);
    await iterator.next();
    expect(stream.watermark).toBe(8);
  });
});

import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDatabase, closeDatabase } from "../db/database.ts";
import { commitReplayForTest, replayWindowMatches } from "./replay.ts";

describe("replay persistence invariants", () => {
  test("event rows and cursor advancement roll back together on injected crash", () => {
    const path = join(
      tmpdir(),
      `solard-replay-crash-${process.pid}-${Date.now()}-${Math.random()}.sqlite`,
    );
    const database = openDatabase(path);
    try {
      const items = normalizeReplayEvents("mint", [
        mint("m", 1, "alice", 100n),
      ]);
      const coverage = {
        version: 1 as const,
        mint: "mint",
        parserVersion: "neutral-replay-v4",
        recipient: null,
        originalCreator: null,
        creationSlot: 1,
        finalizedThroughSlot: 1,
        attemptedThroughSlot: 1,
        authoritative: true,
        tokenBalancesAuthoritative: true,
        creatorRewardsAuthoritative: true,
        complete: true,
        warnings: [],
        updatedAtMs: 0,
      };
      expect(() =>
        commitReplayForTest({
          database,
          items,
          coverage,
          replaceFromSlot: 0,
          crashBeforeCoverage: true,
        }),
      ).toThrow("injected replay commit crash");
      expect(database.historyReplayItems.select().all()).toHaveLength(0);
      expect(database.historyReplayCoverage.select().all()).toHaveLength(0);
    } finally {
      closeDatabase(path);
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    }
  });

  test("late discovery beyond the issued cursor is repairable", () => {
    const previous = normalizeReplayEvents("mint", [
      mint("m", 1, "alice", 100n),
      transfer("a", 4, "alice", "bob", 10n),
    ]);
    const next = normalizeReplayEvents("mint", [
      mint("m", 1, "alice", 100n),
      transfer("a", 4, "alice", "bob", 10n),
      transfer("late", 6, "alice", "bob", 5n),
    ]);
    expect(
      replayWindowMatches(
        previous.filter((item) => item.slot <= 5),
        next.filter((item) => item.slot <= 5),
      ),
    ).toBe(true);
  });

  test("late discovery behind the issued cursor is a historical revision", () => {
    const previous = normalizeReplayEvents("mint", [
      mint("m", 1, "alice", 100n),
      transfer("a", 4, "alice", "bob", 10n),
    ]);
    const next = normalizeReplayEvents("mint", [
      mint("m", 1, "alice", 100n),
      transfer("late", 3, "alice", "bob", 5n),
      transfer("a", 4, "alice", "bob", 10n),
    ]);
    expect(replayWindowMatches(previous, next)).toBe(false);
  });
});
