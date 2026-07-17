// SQD holder tracker: holder deltas for selected SPL / Token-2022 mints.
// Portal tokenBalances catches trades and plain transfers without
// logsSubscribe/getTransaction. For exact current balances, replay from each
// mint's creation slot. If starting mid-history, seed a snapshot first.
//
// Changes vs original:
// - Defaults to HOT stream (SQD_FINALIZED=0) so recent buys appear immediately
// - Much better visibility: logs when tokenBalances arrive, empty batches, etc.
// - Safer FROM_SLOT / LOOKBACK handling + clearer startup warning
// - Explicit support note for Token-2022 (create_v2) mints
// - Still accepts multiple mints on CLI
//
// Usage:
//   SQD_FINALIZED=0 bun run src/holder-tracker.ts <MINT> [MINT2 ...]
//   FROM_SLOT=433300000 bun run src/holder-tracker.ts <MINT>
//   LOOKBACK_SLOTS=3000 bun run src/holder-tracker.ts <MINT>
import { Database } from "bun:sqlite";
import {
  getPortalHead,
  measure,
  type PortalBlock,
  type PortalQuery,
  type PortalTokenBalance,
  runPortal,
  timestampMs,
  transactionMap,
} from "../src/shared/portal.js";

export type HolderEventType = "NEW_HOLDER" | "INCREASE" | "DECREASE" | "EXIT";

function bigintValue(value: string | number | undefined): bigint {
  return value === undefined ? 0n : BigInt(value);
}

export function classifyHolderChange(
  previous: bigint,
  next: bigint,
): HolderEventType {
  if (previous === 0n && next > 0n) return "NEW_HOLDER";
  if (next === 0n) return "EXIT";
  return next > previous ? "INCREASE" : "DECREASE";
}

export class HolderLedger {
  readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS holders (
        mint TEXT NOT NULL,
        owner TEXT NOT NULL,
        balance TEXT NOT NULL,
        updated_slot INTEGER NOT NULL,
        first_seen_ts INTEGER NOT NULL,
        PRIMARY KEY (mint, owner)
      );
      CREATE TABLE IF NOT EXISTS holder_changes (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        slot INTEGER NOT NULL,
        signature TEXT NOT NULL,
        mint TEXT NOT NULL,
        owner TEXT NOT NULL,
        delta TEXT NOT NULL,
        balance_after TEXT NOT NULL,
        event TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_holder_changes_mint_owner_slot
        ON holder_changes(mint, owner, slot);
      CREATE TABLE IF NOT EXISTS checkpoint (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_slot INTEGER NOT NULL
      );
    `);
  }

  checkpoint(): number | null {
    const row = this.db
      .query<{ next_slot: number }, []>(
        "SELECT next_slot FROM checkpoint WHERE id = 1",
      )
      .get();
    return row?.next_slot ?? null;
  }

  setCheckpoint(nextSlot: number): void {
    this.db.run(
      `INSERT INTO checkpoint (id, next_slot) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET next_slot = MAX(checkpoint.next_slot, excluded.next_slot)`,
      [nextSlot],
    );
  }

  balance(mint: string, owner: string): bigint {
    const row = this.db
      .query<{ balance: string }, [string, string]>(
        "SELECT balance FROM holders WHERE mint = ? AND owner = ?",
      )
      .get(mint, owner);
    return row ? BigInt(row.balance) : 0n;
  }

  applyDelta(context: {
    id: string;
    ts: number;
    slot: number;
    signature: string;
    mint: string;
    owner: string;
    delta: bigint;
  }): { event: HolderEventType; balance: bigint } | null {
    if (context.delta === 0n) return null;
    if (
      this.db.query("SELECT 1 FROM holder_changes WHERE id = ?").get(context.id)
    ) {
      return null;
    }
    const previous = this.balance(context.mint, context.owner);
    const calculated = previous + context.delta;
    // Missing history or provider anomalies can create a negative reconstructed
    // balance. Clamp current state, but preserve the raw delta in history.
    const next = calculated < 0n ? 0n : calculated;
    const event = classifyHolderChange(previous, next);
    const transaction = this.db.transaction(() => {
      if (next === 0n) {
        this.db.run("DELETE FROM holders WHERE mint = ? AND owner = ?", [
          context.mint,
          context.owner,
        ]);
      } else {
        this.db.run(
          `INSERT INTO holders (mint, owner, balance, updated_slot, first_seen_ts)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(mint, owner) DO UPDATE SET
             balance = excluded.balance,
             updated_slot = excluded.updated_slot
           WHERE excluded.updated_slot >= holders.updated_slot`,
          [
            context.mint,
            context.owner,
            next.toString(),
            context.slot,
            context.ts,
          ],
        );
      }
      this.db.run(
        `INSERT INTO holder_changes
           (id, ts, slot, signature, mint, owner, delta, balance_after, event)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          context.id,
          context.ts,
          context.slot,
          context.signature,
          context.mint,
          context.owner,
          context.delta.toString(),
          next.toString(),
          event,
        ],
      );
    });
    transaction();
    return { event, balance: next };
  }

  top(mint: string, count = 10): { owner: string; balance: bigint }[] {
    return this.db
      .query<{ owner: string; balance: string }, [string]>(
        "SELECT owner, balance FROM holders WHERE mint = ?",
      )
      .all(mint)
      .map((row) => ({ owner: row.owner, balance: BigInt(row.balance) }))
      .sort((left, right) =>
        right.balance > left.balance
          ? 1
          : right.balance < left.balance
            ? -1
            : 0,
      )
      .slice(0, count);
  }

  holderCount(mint: string): number {
    const row = this.db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM holders WHERE mint = ?",
      )
      .get(mint);
    return row?.count ?? 0;
  }
}

interface MintOwnerDelta {
  mint: string;
  owner: string;
  delta: bigint;
}

export function aggregateHolderDeltas(
  rows: PortalTokenBalance[],
  watchedMints: ReadonlySet<string>,
): MintOwnerDelta[] {
  const deltas = new Map<string, MintOwnerDelta>();
  const add = (mint: string, owner: string, delta: bigint) => {
    if (!watchedMints.has(mint) || delta === 0n) return;
    const key = `${mint}:${owner}`;
    const current = deltas.get(key);
    if (current) current.delta += delta;
    else deltas.set(key, { mint, owner, delta });
  };
  for (const row of rows) {
    if (row.preMint && row.preOwner) {
      add(row.preMint, row.preOwner, -bigintValue(row.preAmount));
    }
    if (row.postMint && row.postOwner) {
      add(row.postMint, row.postOwner, bigintValue(row.postAmount));
    }
  }
  return [...deltas.values()].filter((item) => item.delta !== 0n);
}

export function buildHolderQuery(mints: string[], cursor: number): PortalQuery {
  return {
    type: "solana",
    fromBlock: cursor,
    fields: {
      block: {
        number: true,
        hash: true,
        parentNumber: true,
        parentHash: true,
        height: true,
        timestamp: true,
      },
      transaction: {
        transactionIndex: true,
        signatures: true,
        err: true,
      },
      tokenBalance: {
        transactionIndex: true,
        account: true,
        preMint: true,
        postMint: true,
        preOwner: true,
        postOwner: true,
        preAmount: true,
        postAmount: true,
        preDecimals: true,
        postDecimals: true,
      },
    },
    // Both pre and post so we catch pure transfers as well as buy/sell that
    // only appear on one side.
    tokenBalances: [
      { preMint: mints, transaction: true },
      { postMint: mints, transaction: true },
    ],
  };
}

async function main(): Promise<void> {
  const mints = process.argv
    .slice(2)
    .filter((value) => !value.startsWith("--"));
  if (mints.length === 0) {
    throw new Error(
      "usage: SQD_FINALIZED=0 bun run src/holder-tracker.ts <MINT> [MINT2 ...]",
    );
  }
  const mintSet = new Set(mints);
  const ledger = new HolderLedger(process.env.DB_PATH ?? "sqd-holders.db");
  const portal =
    process.env.PORTAL_URL ?? "https://portal.sqd.dev/datasets/solana-mainnet";

  // IMPORTANT: default to HOT so recent buys show up.
  // Set SQD_FINALIZED=1 only when you want authoritative / delayed data.
  const finalized = process.env.SQD_FINALIZED === "1";

  const head = await getPortalHead(portal, finalized);
  const explicitFrom = Number(process.env.FROM_SLOT ?? "");
  const checkpoint = ledger.checkpoint();

  if (checkpoint === null && !Number.isSafeInteger(explicitFrom)) {
    console.warn(
      "[holder] No checkpoint and no FROM_SLOT. " +
        "Starting from LOOKBACK_SLOTS creates a partial holder state. " +
        "For exact state set FROM_SLOT to the mint creation slot (or a few slots before).",
    );
  }

  const lookback = Number(process.env.LOOKBACK_SLOTS ?? 5_000); // smaller default for live testing
  const from =
    checkpoint ??
    (Number.isSafeInteger(explicitFrom) && explicitFrom >= 0
      ? explicitFrom
      : Math.max(0, head.number - lookback));

  console.log(
    `[holder] start mints=${mints.length} from=${from} head=${head.number} ` +
      `finalized=${finalized} lookback=${lookback} portal=${portal}`,
  );
  console.log(`[holder] watching: ${mints.join(", ")}`);

  let blocksSeen = 0;
  let tokenBalanceRowsSeen = 0;
  let deltasApplied = 0;
  let lastLogSlot = 0;

  await runPortal({
    name: "holder",
    portalUrl: portal,
    finalized,
    from,
    buildQuery: (cursor) => buildHolderQuery(mints, cursor),
    onBlock: async (block: PortalBlock) => {
      blocksSeen++;
      const allRows = block.tokenBalances ?? [];
      tokenBalanceRowsSeen += allRows.length;

      // Visibility: every ~50 blocks or whenever we actually get token balance rows
      if (
        allRows.length > 0 ||
        block.header.number - lastLogSlot >= 50 ||
        blocksSeen <= 3
      ) {
        console.log(
          `[holder] slot=${block.header.number} tokenBalances=${allRows.length} ` +
            `(total rows so far=${tokenBalanceRowsSeen})`,
        );
        lastLogSlot = block.header.number;
      }

      const txs = transactionMap(block);
      const rowsByTx = new Map<number, PortalTokenBalance[]>();
      for (const row of allRows) {
        const rows = rowsByTx.get(row.transactionIndex) ?? [];
        rows.push(row);
        rowsByTx.set(row.transactionIndex, rows);
      }

      for (const transactionIndex of [...rowsByTx.keys()].sort(
        (a, b) => a - b,
      )) {
        const tx = txs.get(transactionIndex);
        if (!tx || tx.err) continue;
        const signature = tx.signatures?.[0];
        if (!signature) continue;

        for (const item of aggregateHolderDeltas(
          rowsByTx.get(transactionIndex)!,
          mintSet,
        )) {
          const result = ledger.applyDelta({
            id: `${signature}:${item.mint}:${item.owner}`,
            ts: timestampMs(block.header.timestamp),
            slot: block.header.number,
            signature,
            mint: item.mint,
            owner: item.owner,
            delta: item.delta,
          });
          if (result) {
            deltasApplied++;
            console.log(
              `[holder] ${item.mint.slice(0, 8)}… ${result.event} ` +
                `${item.owner.slice(0, 8)}… delta=${item.delta} balance=${result.balance} ` +
                `sig=${signature.slice(0, 12)}… slot=${block.header.number}`,
            );
          }
        }
      }

      ledger.setCheckpoint(block.header.number + 1);
    },
  });

  console.log(
    `[holder] finished blocks=${blocksSeen} tokenBalanceRows=${tokenBalanceRowsSeen} deltas=${deltasApplied}`,
  );
  for (const mint of mints) {
    console.log(
      `[holder] ${mint.slice(0, 8)}… holders=${ledger.holderCount(mint)} top=${ledger
        .top(mint, 5)
        .map((item) => `${item.owner.slice(0, 8)}…:${item.balance}`)
        .join(", ")}`,
    );
  }
}

if (import.meta.main) {
  await measure
    .root({ start: () => "SQD holder tracker" }, main)
    .catch((error) => {
      console.error("[holder] fatal", error);
      process.exitCode = 1;
    });
}
