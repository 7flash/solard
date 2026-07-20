// SQD wallet tracker: all token/SOL activity for selected wallets.
// Uses direct Portal tokenBalances + balances. No logsSubscribe, getTransaction,
// or getSignaturesForAddress. Finalized mode is the default for stable PnL.

import { Database } from "bun:sqlite";
import {
  getPortalHead,
  measure,
  type PortalBalance,
  type PortalBlock,
  type PortalQuery,
  type PortalTokenBalance,
  runPortal,
  timestampMs,
  transactionMap,
} from "./shared/portal.ts";

export const WSOL = "So11111111111111111111111111111111111111112";
const RENT_EPSILON = BigInt(process.env.RENT_EPSILON_LAMPORTS ?? "3000000");

export type ActivityKind =
  | "BUY"
  | "SELL"
  | "SWAP"
  | "TRANSFER_IN"
  | "TRANSFER_OUT"
  | "SOL_TRANSFER"
  | "COMPOSITE"
  | "NONE";

export interface TokenLeg {
  mint: string;
  delta: bigint;
  decimals: number;
}

export interface WalletActivity {
  wallet: string;
  kind: ActivityKind;
  solDelta: bigint;
  feePaid: bigint;
  legs: TokenLeg[];
}

interface Position {
  qty: bigint;
  cost: bigint;
  realized: bigint;
  decimals: number;
  basisKnown: boolean;
}

function bigintValue(value: string | number | undefined): bigint {
  if (value === undefined) return 0n;
  return BigInt(value);
}

export function classifyWalletActivity(
  wallet: string,
  tokenLegs: TokenLeg[],
  nativeDelta: bigint,
  feePaid = 0n,
): WalletActivity {
  const byMint = new Map<string, TokenLeg>();
  for (const leg of tokenLegs) {
    const current = byMint.get(leg.mint);
    if (current) current.delta += leg.delta;
    else byMint.set(leg.mint, { ...leg });
  }

  const wrappedSol = byMint.get(WSOL)?.delta ?? 0n;
  byMint.delete(WSOL);

  const legs = [...byMint.values()].filter((leg) => leg.delta !== 0n);
  const up = legs.filter((leg) => leg.delta > 0n);
  const down = legs.filter((leg) => leg.delta < 0n);
  const solDelta = nativeDelta + wrappedSol;
  const negativeNoise = feePaid + RENT_EPSILON;

  let kind: ActivityKind;
  if (legs.length === 0) {
    const economicDelta = solDelta + feePaid;
    kind =
      economicDelta > RENT_EPSILON || economicDelta < -RENT_EPSILON
        ? "SOL_TRANSFER"
        : "NONE";
  } else if (
    up.length === 1 &&
    down.length === 0 &&
    solDelta < -negativeNoise
  ) {
    kind = "BUY";
  } else if (down.length === 1 && up.length === 0 && solDelta > RENT_EPSILON) {
    kind = "SELL";
  } else if (
    up.length === 1 &&
    down.length === 1 &&
    solDelta <= RENT_EPSILON &&
    solDelta >= -negativeNoise
  ) {
    kind = "SWAP";
  } else if (up.length > 0 && down.length === 0) {
    kind = legs.length === 1 ? "TRANSFER_IN" : "COMPOSITE";
  } else if (down.length > 0 && up.length === 0) {
    kind = legs.length === 1 ? "TRANSFER_OUT" : "COMPOSITE";
  } else {
    kind = "COMPOSITE";
  }

  return { wallet, kind, solDelta, feePaid, legs };
}

export class WalletLedger {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS positions (
        wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        qty TEXT NOT NULL,
        cost_lamports TEXT NOT NULL,
        realized_lamports TEXT NOT NULL,
        decimals INTEGER NOT NULL,
        basis_known INTEGER NOT NULL,
        updated_slot INTEGER NOT NULL,
        PRIMARY KEY (wallet, mint)
      );
      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        slot INTEGER NOT NULL,
        signature TEXT NOT NULL,
        wallet TEXT NOT NULL,
        kind TEXT NOT NULL,
        sol_delta TEXT NOT NULL,
        fee_paid TEXT NOT NULL,
        realized_lamports TEXT,
        legs_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_activities_wallet_slot
        ON activities(wallet, slot);
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

  hasActivity(id: string): boolean {
    return !!this.db.query("SELECT 1 FROM activities WHERE id = ?").get(id);
  }

  position(wallet: string, mint: string): Position {
    const row = this.db
      .query<
        {
          qty: string;
          cost_lamports: string;
          realized_lamports: string;
          decimals: number;
          basis_known: number;
        },
        [string, string]
      >(
        `SELECT qty, cost_lamports, realized_lamports, decimals, basis_known
         FROM positions WHERE wallet = ? AND mint = ?`,
      )
      .get(wallet, mint);

    return row
      ? {
          qty: BigInt(row.qty),
          cost: BigInt(row.cost_lamports),
          realized: BigInt(row.realized_lamports),
          decimals: row.decimals,
          basisKnown: row.basis_known === 1,
        }
      : { qty: 0n, cost: 0n, realized: 0n, decimals: 0, basisKnown: true };
  }

  private savePosition(
    wallet: string,
    mint: string,
    position: Position,
    slot: number,
  ): void {
    this.db.run(
      `INSERT INTO positions
         (wallet, mint, qty, cost_lamports, realized_lamports, decimals, basis_known, updated_slot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(wallet, mint) DO UPDATE SET
         qty = excluded.qty,
         cost_lamports = excluded.cost_lamports,
         realized_lamports = excluded.realized_lamports,
         decimals = excluded.decimals,
         basis_known = excluded.basis_known,
         updated_slot = excluded.updated_slot
       WHERE excluded.updated_slot >= positions.updated_slot`,
      [
        wallet,
        mint,
        position.qty.toString(),
        position.cost.toString(),
        position.realized.toString(),
        position.decimals,
        position.basisKnown ? 1 : 0,
        slot,
      ],
    );
  }

  apply(
    activity: WalletActivity,
    context: { id: string; signature: string; slot: number; ts: number },
  ): bigint | null {
    if (this.hasActivity(context.id)) return null;
    let realizedTotal: bigint | null = null;

    const transaction = this.db.transaction(() => {
      if (activity.kind === "BUY") {
        const leg = activity.legs[0]!;
        const position = this.position(activity.wallet, leg.mint);
        position.qty += leg.delta;
        position.cost += activity.solDelta < 0n ? -activity.solDelta : 0n;
        position.decimals = leg.decimals;
        this.savePosition(activity.wallet, leg.mint, position, context.slot);
      } else if (activity.kind === "SELL") {
        const leg = activity.legs[0]!;
        const position = this.position(activity.wallet, leg.mint);
        const requested = -leg.delta;
        const sold = requested > position.qty ? position.qty : requested;
        const costOut =
          position.basisKnown && position.qty > 0n
            ? (position.cost * sold) / position.qty
            : 0n;

        if (position.basisKnown) {
          const proceeds = activity.solDelta > 0n ? activity.solDelta : 0n;
          const realized = proceeds - costOut;
          position.realized += realized;
          realizedTotal = realized;
        }

        position.qty -= sold;
        position.cost -= costOut;
        if (position.qty === 0n) {
          position.cost = 0n;
          position.basisKnown = true;
        }
        this.savePosition(activity.wallet, leg.mint, position, context.slot);
      } else if (activity.kind === "SWAP") {
        const outgoing = activity.legs.find((leg) => leg.delta < 0n)!;
        const incoming = activity.legs.find((leg) => leg.delta > 0n)!;
        const from = this.position(activity.wallet, outgoing.mint);
        const movedQty =
          -outgoing.delta > from.qty ? from.qty : -outgoing.delta;
        const movedCost =
          from.basisKnown && from.qty > 0n
            ? (from.cost * movedQty) / from.qty
            : 0n;

        from.qty -= movedQty;
        from.cost -= movedCost;
        if (from.qty === 0n) {
          from.cost = 0n;
          from.basisKnown = true;
        }
        this.savePosition(activity.wallet, outgoing.mint, from, context.slot);

        const to = this.position(activity.wallet, incoming.mint);
        to.qty += incoming.delta;
        to.cost += movedCost + activity.feePaid;
        to.decimals = incoming.decimals;
        to.basisKnown = to.basisKnown && from.basisKnown;
        this.savePosition(activity.wallet, incoming.mint, to, context.slot);
      } else {
        for (const leg of activity.legs) {
          const position = this.position(activity.wallet, leg.mint);
          if (leg.delta > 0n) {
            position.qty += leg.delta;
            position.basisKnown = false;
          } else {
            const removed =
              -leg.delta > position.qty ? position.qty : -leg.delta;
            const costOut =
              position.basisKnown && position.qty > 0n
                ? (position.cost * removed) / position.qty
                : 0n;
            position.qty -= removed;
            position.cost -= costOut;
            if (position.qty === 0n) {
              position.cost = 0n;
              position.basisKnown = true;
            }
          }
          position.decimals = leg.decimals || position.decimals;
          this.savePosition(activity.wallet, leg.mint, position, context.slot);
        }
      }

      this.db.run(
        `INSERT INTO activities
           (id, ts, slot, signature, wallet, kind, sol_delta, fee_paid, realized_lamports, legs_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          context.id,
          context.ts,
          context.slot,
          context.signature,
          activity.wallet,
          activity.kind,
          activity.solDelta.toString(),
          activity.feePaid.toString(),
          realizedTotal?.toString() ?? null,
          JSON.stringify(
            activity.legs.map((leg) => ({
              mint: leg.mint,
              delta: leg.delta.toString(),
              decimals: leg.decimals,
            })),
          ),
        ],
      );
    });

    transaction();
    return realizedTotal;
  }
}

function tokenLegsForWallet(
  rows: PortalTokenBalance[],
  wallet: string,
): TokenLeg[] {
  const states = new Map<
    string,
    { pre: bigint; post: bigint; decimals: number }
  >();

  for (const row of rows) {
    if (row.preOwner === wallet && row.preMint) {
      const state = states.get(row.preMint) ?? {
        pre: 0n,
        post: 0n,
        decimals: row.preDecimals ?? row.postDecimals ?? 0,
      };
      state.pre += bigintValue(row.preAmount);
      states.set(row.preMint, state);
    }

    if (row.postOwner === wallet && row.postMint) {
      const state = states.get(row.postMint) ?? {
        pre: 0n,
        post: 0n,
        decimals: row.postDecimals ?? row.preDecimals ?? 0,
      };
      state.post += bigintValue(row.postAmount);
      states.set(row.postMint, state);
    }
  }

  return [...states.entries()]
    .map(([mint, state]) => ({
      mint,
      delta: state.post - state.pre,
      decimals: state.decimals,
    }))
    .filter((leg) => leg.delta !== 0n);
}

function nativeDeltaForWallet(rows: PortalBalance[], wallet: string): bigint {
  let delta = 0n;
  for (const row of rows) {
    if (row.account !== wallet) continue;
    delta += bigintValue(row.post) - bigintValue(row.pre);
  }
  return delta;
}

export function buildWalletQuery(
  wallets: string[],
  cursor: number,
): PortalQuery {
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
        fee: true,
        feePayer: true,
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
      balance: {
        transactionIndex: true,
        account: true,
        pre: true,
        post: true,
      },
    },
    tokenBalances: [
      { preOwner: wallets, transaction: true },
      { postOwner: wallets, transaction: true },
    ],
    balances: [{ account: wallets, transaction: true }],
  };
}

function formatSol(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 1_000_000_000n;
  const fraction = (absolute % 1_000_000_000n)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "")
    .slice(0, 6);
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""} SOL`;
}

async function main(): Promise<void> {
  const wallets = process.argv
    .slice(2)
    .filter((value) => !value.startsWith("--"));
  if (wallets.length === 0) {
    throw new Error(
      "usage: bun run src/wallet-tracker.ts <WALLET> [WALLET2 ...]",
    );
  }

  const ledger = new WalletLedger(process.env.DB_PATH ?? "sqd-wallets.db");
  const portal =
    process.env.PORTAL_URL ?? "https://portal.sqd.dev/datasets/solana-mainnet";
  const finalized = process.env.SQD_FINALIZED !== "0";
  const head = await getPortalHead(portal, finalized);
  const explicitFrom = Number(process.env.FROM_SLOT ?? "");
  const from =
    ledger.checkpoint() ??
    (Number.isSafeInteger(explicitFrom) && explicitFrom >= 0
      ? explicitFrom
      : Math.max(
          0,
          head.number - Number(process.env.LOOKBACK_SLOTS ?? 10_000),
        ));

  measure.sync.note({
    start: () =>
      `wallet tracker wallets=${wallets.length} from=${from} finalized=${finalized}`,
  });

  await runPortal({
    name: "wallet",
    portalUrl: portal,
    finalized,
    from,
    buildQuery: (cursor) => buildWalletQuery(wallets, cursor),
    onBlock: async (block: PortalBlock) => {
      const txs = transactionMap(block);
      const tokenRowsByTx = new Map<number, PortalTokenBalance[]>();
      const balanceRowsByTx = new Map<number, PortalBalance[]>();

      for (const row of block.tokenBalances ?? []) {
        const rows = tokenRowsByTx.get(row.transactionIndex) ?? [];
        rows.push(row);
        tokenRowsByTx.set(row.transactionIndex, rows);
      }
      for (const row of block.balances ?? []) {
        const rows = balanceRowsByTx.get(row.transactionIndex) ?? [];
        rows.push(row);
        balanceRowsByTx.set(row.transactionIndex, rows);
      }

      const transactionIndexes = new Set<number>([
        ...txs.keys(),
        ...tokenRowsByTx.keys(),
        ...balanceRowsByTx.keys(),
      ]);

      for (const transactionIndex of [...transactionIndexes].sort(
        (a, b) => a - b,
      )) {
        const tx = txs.get(transactionIndex);
        if (!tx || tx.err) continue;
        const signature = tx.signatures?.[0];
        if (!signature) continue;
        const tokenRows = tokenRowsByTx.get(transactionIndex) ?? [];
        const balanceRows = balanceRowsByTx.get(transactionIndex) ?? [];

        for (const wallet of wallets) {
          const legs = tokenLegsForWallet(tokenRows, wallet);
          const nativeDelta = nativeDeltaForWallet(balanceRows, wallet);
          const feePaid = tx.feePayer === wallet ? BigInt(tx.fee ?? 0) : 0n;
          const activity = classifyWalletActivity(
            wallet,
            legs,
            nativeDelta,
            feePaid,
          );
          if (activity.kind === "NONE") continue;

          const id = `${signature}:${wallet}`;
          const realized = ledger.apply(activity, {
            id,
            signature,
            slot: block.header.number,
            ts: timestampMs(block.header.timestamp),
          });

          console.log(
            `[wallet] ${wallet.slice(0, 8)}… ${activity.kind} ` +
              `${activity.legs.map((leg) => `${leg.delta > 0n ? "+" : ""}${leg.delta} ${leg.mint.slice(0, 8)}…`).join(", ") || formatSol(activity.solDelta)}` +
              `${realized === null ? "" : ` realized=${formatSol(realized)}`} ` +
              `${signature.slice(0, 12)}…`,
          );
        }
      }

      ledger.setCheckpoint(block.header.number + 1);
    },
  });
}

if (import.meta.main) {
  await measure
    .root({ start: () => "SQD wallet tracker" }, main)
    .catch((error) => {
      console.error("[wallet] fatal", error);
      process.exitCode = 1;
    });
}
