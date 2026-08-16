import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "sqlite-zod-orm";
import { measure } from "../core/log.ts";
import { ensureSolardDatabaseRuntimeObjects } from "./maintenance.ts";
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
  WatchSchema,
  type SolardDatabase,
} from "./schema.ts";

const m = measure("db");
type OpenDatabaseEntry = { db: SolardDatabase; refs: number };
const open = new Map<string, OpenDatabaseEntry>();

/**
 * Resolve the one database path shared by @solard/core, @solard/sdk and @solard/cli.
 *
 * An explicit path always wins, followed by the environment overrides. Without
 * either, use a stable per-user location instead of process.cwd(), so invoking
 * the globally linked CLI from different directories still opens the same DB.
 */
export function resolveDbPath(input?: string): string {
  const configured =
    input ?? process.env.SLRD_DB_PATH ?? process.env.SOLARD_DB_PATH;
  if (configured?.trim()) return resolve(configured);
  return join(homedir(), ".solard", "solard.sqlite");
}

export function openDatabase(input?: string): SolardDatabase {
  const path = resolveDbPath(input);
  const existing = open.get(path);
  if (existing) {
    existing.refs += 1;
    return existing.db;
  }

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
      },
    },
  ) as SolardDatabase;

  ensureSolardDatabaseRuntimeObjects(db);
  open.set(path, { db, refs: 1 });
  m.measureSync(`open ${path}`, () => "ready");
  return db;
}

export function closeDatabase(input?: string): void {
  const path = resolveDbPath(input);
  const entry = open.get(path);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  entry.db.close();
  open.delete(path);
}
