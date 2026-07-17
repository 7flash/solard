// ERC-20 holder-state tracker for Robinhood Chain.
// Transfer logs are authoritative for standard ERC-20 raw balances.
// ERC-8056 display balances are raw * uiMultiplier / 1e18.

import { Database } from "bun:sqlite";
import {
  decodeTransfer,
  formatUnitsExact,
  scaledUiAmount,
  shortAddress,
  TRANSFER_TOPIC,
  ZERO_ADDRESS,
} from "./shared/evm.ts";
import { CheckpointStore } from "./shared/checkpoint.ts";
import { fetchPortalHead, runPortal, type EvmQuery } from "./shared/portal.ts";
import { uiMultiplier } from "./shared/rpc.ts";
import {
  resolveTokens,
  TOKEN_BY_ADDRESS,
  type KnownToken,
} from "./shared/tokens.ts";

function numberFlag(flag: string): number | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${flag} requires a block number`);
  return value;
}

export class HolderStore {
  readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS holders (
        token TEXT NOT NULL,
        owner TEXT NOT NULL,
        amount TEXT NOT NULL,
        updated_block INTEGER NOT NULL,
        PRIMARY KEY(token, owner)
      );
      CREATE TABLE IF NOT EXISTS supplies (
        token TEXT PRIMARY KEY,
        amount TEXT NOT NULL,
        updated_block INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transfers (
        token TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        amount TEXT NOT NULL,
        timestamp INTEGER,
        PRIMARY KEY(token, tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS idx_holders_token ON holders(token);
    `);
  }

  private amount(token: string, owner: string): bigint {
    const row = this.db
      .query<{ amount: string }, [string, string]>(
        "SELECT amount FROM holders WHERE token=? AND owner=?",
      )
      .get(token, owner);
    return row ? BigInt(row.amount) : 0n;
  }

  private setAmount(
    token: string,
    owner: string,
    amount: bigint,
    block: number,
  ): void {
    if (owner === ZERO_ADDRESS) return;
    if (amount === 0n) {
      this.db.run("DELETE FROM holders WHERE token=? AND owner=?", [
        token,
        owner,
      ]);
      return;
    }
    if (amount < 0n)
      throw new Error(`negative holder balance ${token} ${owner}`);
    this.db.run(
      `INSERT INTO holders(token, owner, amount, updated_block) VALUES (?, ?, ?, ?)
       ON CONFLICT(token, owner) DO UPDATE SET amount=excluded.amount, updated_block=excluded.updated_block`,
      [token, owner, amount.toString(), block],
    );
  }

  private supply(token: string): bigint {
    const row = this.db
      .query<{ amount: string }, [string]>(
        "SELECT amount FROM supplies WHERE token=?",
      )
      .get(token);
    return row ? BigInt(row.amount) : 0n;
  }

  apply(
    event: ReturnType<typeof decodeTransfer> extends infer T
      ? Exclude<T, null>
      : never,
    block: number,
    timestamp?: number,
  ): boolean {
    if (
      this.db
        .query(
          "SELECT 1 FROM transfers WHERE token=? AND tx_hash=? AND log_index=?",
        )
        .get(event.token, event.transactionHash, event.logIndex)
    )
      return false;

    const transaction = this.db.transaction(() => {
      this.db.run(
        `INSERT INTO transfers(token, tx_hash, log_index, block_number, sender, recipient, amount, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          event.token,
          event.transactionHash,
          event.logIndex,
          block,
          event.from,
          event.to,
          event.amount.toString(),
          timestamp ?? null,
        ],
      );
      if (event.from !== ZERO_ADDRESS) {
        this.setAmount(
          event.token,
          event.from,
          this.amount(event.token, event.from) - event.amount,
          block,
        );
      }
      if (event.to !== ZERO_ADDRESS) {
        this.setAmount(
          event.token,
          event.to,
          this.amount(event.token, event.to) + event.amount,
          block,
        );
      }
      let supply = this.supply(event.token);
      if (event.from === ZERO_ADDRESS) supply += event.amount;
      if (event.to === ZERO_ADDRESS) supply -= event.amount;
      if (supply < 0n) throw new Error(`negative supply ${event.token}`);
      this.db.run(
        `INSERT INTO supplies(token, amount, updated_block) VALUES (?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET amount=excluded.amount, updated_block=excluded.updated_block`,
        [event.token, supply.toString(), block],
      );
    });
    transaction();
    return true;
  }

  top(token: string, limit = 10): { owner: string; amount: bigint }[] {
    return this.db
      .query<{ owner: string; amount: string }, [string]>(
        "SELECT owner, amount FROM holders WHERE token=?",
      )
      .all(token)
      .map((row) => ({ owner: row.owner, amount: BigInt(row.amount) }))
      .sort((a, b) =>
        a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1,
      )
      .slice(0, limit);
  }

  holderCount(token: string): number {
    const row = this.db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM holders WHERE token=?",
      )
      .get(token);
    return row?.count ?? 0;
  }
}

const tokens = resolveTokens(process.argv.slice(2));
if (tokens.length === 0)
  throw new Error(
    "usage: bun run src/holder-tracker.ts TSLA [NVDA...] [--from BLOCK]",
  );
const dbPath = process.env.DB_PATH ?? "robinhood-holders.db";
const store = new HolderStore(dbPath);
const checkpoints = new CheckpointStore(dbPath);
const checkpointName = `holders:${tokens
  .map((token) => token.address)
  .sort()
  .join(",")}`;
const saved = checkpoints.get(checkpointName);
const fromArg = numberFlag("--from") ?? Number(process.env.RH_START_BLOCK ?? 0);
const finalized = process.env.SQD_FINALIZED !== "0";
const head = await fetchPortalHead(undefined, finalized);
const from = saved?.nextBlock ?? fromArg;
const multiplierByToken = new Map<string, bigint>();

async function refreshMultipliers(): Promise<void> {
  for (const token of tokens) {
    if (!token.scaledUi) {
      multiplierByToken.set(token.address, 1_000_000_000_000_000_000n);
      continue;
    }
    try {
      multiplierByToken.set(token.address, await uiMultiplier(token.address));
    } catch (error) {
      multiplierByToken.set(
        token.address,
        multiplierByToken.get(token.address) ?? 1_000_000_000_000_000_000n,
      );
      console.warn(
        `[rh:holders] multiplier ${token.symbol}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

await refreshMultipliers();
const report = setInterval(
  () => {
    for (const token of tokens) {
      const multiplier =
        multiplierByToken.get(token.address) ?? 1_000_000_000_000_000_000n;
      const top = store.top(token.address, 5);
      console.log(
        `\n[rh:holders] ${token.symbol} holders=${store.holderCount(token.address)} multiplier=${formatUnitsExact(multiplier, 18, 6)}`,
      );
      for (const row of top) {
        console.log(
          `  ${shortAddress(row.owner)} raw=${formatUnitsExact(row.amount, token.decimals)} ui=${formatUnitsExact(scaledUiAmount(row.amount, multiplier), token.decimals)}`,
        );
      }
    }
    void refreshMultipliers();
  },
  Number(process.env.REPORT_MS ?? 60_000),
);
(report as any).unref?.();

function buildQuery(cursor: number): EvmQuery {
  return {
    type: "evm",
    fromBlock: cursor,
    fields: {
      block: { number: true, hash: true, parentHash: true, timestamp: true },
      log: {
        address: true,
        topics: true,
        data: true,
        transactionHash: true,
        transactionIndex: true,
        logIndex: true,
      },
    },
    logs: [
      {
        address: tokens.map((token) => token.address),
        topic0: [TRANSFER_TOPIC],
      },
    ],
  };
}

console.log(
  `[rh:holders] tokens=${tokens.map((token) => token.symbol).join(",")} from=${from} head=${head.number}`,
);
await runPortal({
  name: "rh-holders",
  finalized,
  from,
  ...(saved?.parentHash ? { parentBlockHash: saved.parentHash } : {}),
  buildQuery,
  onBlock: async (block) => {
    for (const log of block.logs ?? []) {
      const transfer = decodeTransfer(log);
      if (
        !transfer ||
        (!TOKEN_BY_ADDRESS.has(transfer.token) &&
          !tokens.some((token) => token.address === transfer.token))
      )
        continue;
      if (store.apply(transfer, block.header.number, block.header.timestamp)) {
        const token =
          TOKEN_BY_ADDRESS.get(transfer.token) ??
          (tokens.find(
            (item) => item.address === transfer.token,
          ) as KnownToken);
        const kind =
          transfer.from === ZERO_ADDRESS
            ? "MINT"
            : transfer.to === ZERO_ADDRESS
              ? "BURN"
              : "MOVE";
        console.log(
          `[rh:holders] ${kind} ${token.symbol} ${formatUnitsExact(transfer.amount, token.decimals)} ${shortAddress(transfer.from)} → ${shortAddress(transfer.to)}`,
        );
      }
    }
  },
  onCheckpoint: (nextBlock, parentHash) =>
    checkpoints.set(checkpointName, nextBlock, parentHash),
});
clearInterval(report);
