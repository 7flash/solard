// Robinhood Chain wallet flow tracker.
// Tracks top-level native ETH flow and ERC-20 Transfer logs through SQD Portal.
// It intentionally does not claim tax-grade PnL: internal ETH flows, protocol
// semantics, and off-chain stock prices require additional sources.

import { Database } from "bun:sqlite";
import {
  addressTopic,
  decodeTransfer,
  decimalBigInt,
  formatUnitsExact,
  normalizeAddress,
  shortAddress,
  TRANSFER_TOPIC,
  type Erc20Transfer,
} from "./shared/evm.ts";
import { CheckpointStore } from "./shared/checkpoint.ts";
import {
  fetchPortalHead,
  runPortal,
  type EvmBlock,
  type EvmQuery,
  type EvmTransaction,
} from "./shared/portal.ts";
import { TOKEN_BY_ADDRESS } from "./shared/tokens.ts";

export type ActivityKind =
  | "BUY"
  | "SELL"
  | "SWAP"
  | "TRANSFER_IN"
  | "TRANSFER_OUT"
  | "COMPOSITE"
  | "NATIVE_TRANSFER"
  | "CONTRACT_CALL";

export interface TokenDelta {
  token: string;
  amount: bigint;
}

export interface WalletActivity {
  wallet: string;
  transactionHash: string;
  blockNumber: number;
  timestamp?: number;
  kind: ActivityKind;
  nativeDeltaWei: bigint;
  feeWei: bigint;
  tokenDeltas: TokenDelta[];
}

function numberFlag(flag: string): number | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${flag} requires a block number`);
  return value;
}

function classify(
  tokenDeltas: TokenDelta[],
  nativeDeltaWei: bigint,
  feeWei: bigint,
): ActivityKind {
  const incoming = tokenDeltas.filter((delta) => delta.amount > 0n);
  const outgoing = tokenDeltas.filter((delta) => delta.amount < 0n);
  const spendWithoutFee = nativeDeltaWei + feeWei;
  if (incoming.length && outgoing.length) return "SWAP";
  if (incoming.length) return spendWithoutFee < 0n ? "BUY" : "TRANSFER_IN";
  if (outgoing.length) return nativeDeltaWei > 0n ? "SELL" : "TRANSFER_OUT";
  if (nativeDeltaWei !== 0n) return "NATIVE_TRANSFER";
  return "CONTRACT_CALL";
}

export class WalletStore {
  readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS activities (
        wallet TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        timestamp INTEGER,
        kind TEXT NOT NULL,
        native_delta_wei TEXT NOT NULL,
        fee_wei TEXT NOT NULL,
        token_deltas_json TEXT NOT NULL,
        PRIMARY KEY(wallet, tx_hash)
      );
      CREATE TABLE IF NOT EXISTS positions (
        wallet TEXT NOT NULL,
        token TEXT NOT NULL,
        raw_amount TEXT NOT NULL,
        updated_block INTEGER NOT NULL,
        PRIMARY KEY(wallet, token)
      );
      CREATE INDEX IF NOT EXISTS idx_activities_wallet_block ON activities(wallet, block_number);
    `);
  }

  position(wallet: string, token: string): bigint {
    const row = this.db
      .query<{ raw_amount: string }, [string, string]>(
        "SELECT raw_amount FROM positions WHERE wallet=? AND token=?",
      )
      .get(wallet, token);
    return row ? BigInt(row.raw_amount) : 0n;
  }

  apply(activity: WalletActivity): boolean {
    if (
      this.db
        .query("SELECT 1 FROM activities WHERE wallet=? AND tx_hash=?")
        .get(activity.wallet, activity.transactionHash)
    ) {
      return false;
    }
    const transaction = this.db.transaction(() => {
      this.db.run(
        `INSERT INTO activities(wallet, tx_hash, block_number, timestamp, kind, native_delta_wei, fee_wei, token_deltas_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          activity.wallet,
          activity.transactionHash,
          activity.blockNumber,
          activity.timestamp ?? null,
          activity.kind,
          activity.nativeDeltaWei.toString(),
          activity.feeWei.toString(),
          JSON.stringify(
            activity.tokenDeltas.map((delta) => ({
              token: delta.token,
              amount: delta.amount.toString(),
            })),
          ),
        ],
      );
      for (const delta of activity.tokenDeltas) {
        const next = this.position(activity.wallet, delta.token) + delta.amount;
        // A negative position means tracking began after the wallet acquired the
        // token. Preserve it as an explicit partial-history signal.
        if (next === 0n) {
          this.db.run("DELETE FROM positions WHERE wallet=? AND token=?", [
            activity.wallet,
            delta.token,
          ]);
        } else {
          this.db.run(
            `INSERT INTO positions(wallet, token, raw_amount, updated_block) VALUES (?, ?, ?, ?)
             ON CONFLICT(wallet, token) DO UPDATE SET raw_amount=excluded.raw_amount, updated_block=excluded.updated_block`,
            [
              activity.wallet,
              delta.token,
              next.toString(),
              activity.blockNumber,
            ],
          );
        }
      }
    });
    transaction();
    return true;
  }
}

function txFee(transaction: EvmTransaction | undefined): bigint {
  if (!transaction) return 0n;
  return (
    decimalBigInt(transaction.gasUsed) * decimalBigInt(transaction.gasPrice)
  );
}

export function activitiesFromBlock(
  block: EvmBlock,
  wallets: Set<string>,
): WalletActivity[] {
  const transactions = block.transactions ?? [];
  const txByHash = new Map<string, EvmTransaction>();
  const txByIndex = new Map<number, EvmTransaction>();
  for (const tx of transactions) {
    if (tx.hash) txByHash.set(tx.hash.toLowerCase(), tx);
    if (tx.transactionIndex !== undefined)
      txByIndex.set(tx.transactionIndex, tx);
  }
  const transfersByTx = new Map<string, Erc20Transfer[]>();
  for (const log of block.logs ?? []) {
    const transfer = decodeTransfer(log);
    if (!transfer) continue;
    const list = transfersByTx.get(transfer.transactionHash) ?? [];
    list.push(transfer);
    transfersByTx.set(transfer.transactionHash, list);
  }
  const txHashes = new Set<string>([
    ...txByHash.keys(),
    ...transfersByTx.keys(),
  ]);
  const output: WalletActivity[] = [];

  for (const hash of txHashes) {
    const transfers = transfersByTx.get(hash) ?? [];
    const first = transfers[0];
    const transaction =
      txByHash.get(hash) ??
      (first ? txByIndex.get(first.transactionIndex) : undefined);
    const impacted = new Set<string>();
    if (transaction?.from) {
      const from = normalizeAddress(transaction.from);
      if (wallets.has(from)) impacted.add(from);
    }
    if (transaction?.to) {
      const to = normalizeAddress(transaction.to);
      if (wallets.has(to)) impacted.add(to);
    }
    for (const transfer of transfers) {
      if (wallets.has(transfer.from)) impacted.add(transfer.from);
      if (wallets.has(transfer.to)) impacted.add(transfer.to);
    }

    for (const wallet of impacted) {
      const tokenMap = new Map<string, bigint>();
      for (const transfer of transfers) {
        let delta = 0n;
        if (transfer.from === wallet) delta -= transfer.amount;
        if (transfer.to === wallet) delta += transfer.amount;
        if (delta !== 0n)
          tokenMap.set(
            transfer.token,
            (tokenMap.get(transfer.token) ?? 0n) + delta,
          );
      }
      let nativeDelta = 0n;
      const value = decimalBigInt(transaction?.value);
      const fee =
        transaction?.from && normalizeAddress(transaction.from) === wallet
          ? txFee(transaction)
          : 0n;
      if (transaction?.from && normalizeAddress(transaction.from) === wallet)
        nativeDelta -= value + fee;
      if (transaction?.to && normalizeAddress(transaction.to) === wallet)
        nativeDelta += value;
      const tokenDeltas = [...tokenMap.entries()]
        .filter(([, amount]) => amount !== 0n)
        .map(([token, amount]) => ({ token, amount }));
      output.push({
        wallet,
        transactionHash: hash,
        blockNumber: block.header.number,
        ...(block.header.timestamp === undefined
          ? {}
          : { timestamp: block.header.timestamp }),
        kind: classify(tokenDeltas, nativeDelta, fee),
        nativeDeltaWei: nativeDelta,
        feeWei: fee,
        tokenDeltas,
      });
    }
  }
  return output;
}

const wallets = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith("--"))
  .map(normalizeAddress);
if (wallets.length === 0)
  throw new Error(
    "usage: bun run src/wallet-tracker.ts 0xWALLET [0xWALLET...] [--from BLOCK]",
  );
const walletSet = new Set(wallets);
const topics = wallets.map(addressTopic);
const dbPath = process.env.DB_PATH ?? "robinhood-wallets.db";
const store = new WalletStore(dbPath);
const checkpoints = new CheckpointStore(dbPath);
const checkpointName = `wallets:${[...wallets].sort().join(",")}`;
const saved = checkpoints.get(checkpointName);
const fromArg = numberFlag("--from") ?? Number(process.env.RH_START_BLOCK ?? 0);
const finalized = process.env.SQD_FINALIZED !== "0";
const head = await fetchPortalHead(undefined, finalized);
const from = saved?.nextBlock ?? fromArg;

function buildQuery(cursor: number): EvmQuery {
  return {
    type: "evm",
    fromBlock: cursor,
    fields: {
      block: { number: true, hash: true, parentHash: true, timestamp: true },
      transaction: {
        transactionIndex: true,
        hash: true,
        from: true,
        to: true,
        value: true,
        status: true,
        gasUsed: true,
        gasPrice: true,
      },
      log: {
        address: true,
        topics: true,
        data: true,
        logIndex: true,
        transactionIndex: true,
        transactionHash: true,
      },
    },
    transactions: [
      { from: wallets, logs: true },
      { to: wallets, logs: true },
    ],
    logs: [
      { topic0: [TRANSFER_TOPIC], topic1: topics, transaction: true },
      { topic0: [TRANSFER_TOPIC], topic2: topics, transaction: true },
    ],
  };
}

console.log(
  `[rh:wallet] wallets=${wallets.map(shortAddress).join(",")} from=${from} head=${head.number}`,
);
await runPortal({
  name: "rh-wallet",
  finalized,
  from,
  ...(saved?.parentHash ? { parentBlockHash: saved.parentHash } : {}),
  buildQuery,
  onBlock: async (block) => {
    for (const activity of activitiesFromBlock(block, walletSet)) {
      if (!store.apply(activity)) continue;
      const legs = activity.tokenDeltas
        .map((delta) => {
          const token = TOKEN_BY_ADDRESS.get(delta.token);
          return `${formatUnitsExact(delta.amount, token?.decimals ?? 18)} ${token?.symbol ?? shortAddress(delta.token)}`;
        })
        .join(", ");
      console.log(
        `[rh:wallet] ${shortAddress(activity.wallet)} ${activity.kind.padEnd(14)} ` +
          `${legs || `${formatUnitsExact(activity.nativeDeltaWei, 18)} ETH`} ` +
          `block=${activity.blockNumber} tx=${shortAddress(activity.transactionHash)}`,
      );
    }
  },
  onCheckpoint: (nextBlock, parentHash) =>
    checkpoints.set(checkpointName, nextBlock, parentHash),
});
