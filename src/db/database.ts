import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "sqlite-zod-orm";
import { measure } from "../core/log.js";
import {
  AgentSchema,
  AltSchema,
  BalanceSchema,
  PriceSampleSchema,
  ClaimSchema,
  ExecutionActionSchema,
  ExecutionSchema,
  GroupSchema,
  GroupWalletSchema,
  PositionSchema,
  SettingSchema,
  TokenSchema,
  WalletSchema,
  TokenWatchGroupSchema,
  TokenWatchGroupTokenSchema,
  WatchSchema,
  PumpTokenEventSchema,
  PumpSwapSchema,
  PumpHolderCurrentSchema,
  PumpBalanceDeltaSchema,
  PumpPriceAggregateSchema,
  type SowlDatabase,
} from "./schema.js";

const m = measure("db");
const open = new Map<string, SowlDatabase>();

export function resolveDbPath(input?: string): string {
  return resolve(input ?? process.env.SOWL_DB_PATH ?? "./sowl.db");
}

export function openDatabase(input?: string): SowlDatabase {
  const path = resolveDbPath(input);
  const existing = open.get(path);
  if (existing) return existing;
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(
    path,
    {
      wallets: WalletSchema,
      tokens: TokenSchema,
      executions: ExecutionSchema,
      executionActions: ExecutionActionSchema,
      positions: PositionSchema,
      balances: BalanceSchema,
      priceSamples: PriceSampleSchema,
      claims: ClaimSchema,
      groups: GroupSchema,
      groupWallets: GroupWalletSchema,
      agents: AgentSchema,
      alts: AltSchema,
      watches: WatchSchema,
      settings: SettingSchema,
      tokenWatchGroups: TokenWatchGroupSchema,
      tokenWatchGroupTokens: TokenWatchGroupTokenSchema,
      pumpTokenEvents: PumpTokenEventSchema,
      pumpSwaps: PumpSwapSchema,
      pumpHoldersCurrent: PumpHolderCurrentSchema,
      pumpBalanceDeltas: PumpBalanceDeltaSchema,
      pumpPriceAggregates: PumpPriceAggregateSchema,
    },
    {
      timestamps: false,
      softDeletes: false,
      debug: process.env.SQLITE_DEBUG === "1",
      unique: {
        wallets: [["name"], ["address"]],
        tokens: [["mint"]],
        executions: [["signature"]],
        executionActions: [["executionId", "actionIndex"]],
        positions: [["walletAddress", "mint"]],
        groups: [["name"]],
        groupWallets: [["groupName", "walletAddress"]],
        agents: [["name"]],
        alts: [["address"]],
        watches: [["kind", "address"]],
        settings: [["key"]],
        tokenWatchGroups: [["groupId"], ["name"]],
        tokenWatchGroupTokens: [["groupId", "mint"]],
        pumpTokenEvents: [["mint"]],
        pumpSwaps: [["signature"]],
        pumpHoldersCurrent: [["mint", "owner"]],
        pumpBalanceDeltas: [["signature", "owner", "mint"]],
        pumpPriceAggregates: [["mint", "intervalSeconds", "bucketStartMs"]],
      },
      indexes: {
        wallets: ["name", "address", "isActive"],
        tokens: ["mint", "name", "symbol", "venueHint"],
        executions: ["status", "walletAddress", "mint", "createdAtMs"],
        positions: ["walletAddress", "mint"],
        priceSamples: ["mint", "venue", "capturedAtMs"],
        claims: ["walletAddress", "mint", "status"],
        groupWallets: ["groupName", "walletAddress"],
        watches: ["kind", "address", "isActive"],
        tokenWatchGroups: ["groupId", "name"],
        tokenWatchGroupTokens: ["groupId", "mint", "updatedAtMs"],
        pumpTokenEvents: ["mint", "updatedAtMs", "marketCapSol", "symbol"],
        pumpSwaps: ["mint", "createdAtMs", "trader"],
        pumpHoldersCurrent: ["mint", "pctSupply", "balanceUi", "lastUpdatedMs"],
        pumpBalanceDeltas: ["mint", "owner", "createdAtMs"],
        pumpPriceAggregates: ["mint", "intervalSeconds", "bucketStartMs"],
      },
    },
  ) as SowlDatabase;
  open.set(path, db);
  m.measureSync(`open ${path}`, () => `ready`);
  return db;
}

export function closeDatabase(input?: string): void {
  const path = resolveDbPath(input);
  const db = open.get(path);
  if (!db) return;
  db.close();
  open.delete(path);
}
