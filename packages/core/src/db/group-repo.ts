import type { SolardDatabase, GroupRow, GroupWalletRow } from "./schema.ts";
import { measure } from "../core/log.ts";
import { groupLog, groupWalletLog } from "../core/log-result.ts";
import { measuredSync } from "../core/measured.ts";

const m = measure("groups");
export class GroupRepo {
  constructor(private readonly db: SolardDatabase) {}
  create(name: string, description?: string): GroupRow {
    if (name.trim().toLowerCase() === "ungrouped") {
      throw new Error(
        "ungrouped is a reserved virtual group containing wallets with zero persisted group memberships",
      );
    }
    return measuredSync(
      m,
      `create ${name}`,
      () => {
        const existing = this.db.groups.select().where({ name }).first() as
          GroupRow | undefined;
        if (existing) return existing;
        const now = Date.now();
        return this.db.groups.insert({
          name,
          description: description ?? null,
          createdAtMs: now,
          updatedAtMs: now,
        }) as GroupRow;
      },
      groupLog,
    );
  }
  addWallet(
    groupName: string,
    walletAddress: string,
    weightBps = 10000,
  ): GroupWalletRow {
    if (weightBps <= 0 || weightBps > 10000)
      throw new Error("weightBps must be within 1..10000");
    return measuredSync(
      m,
      `add ${groupName}`,
      () => {
        const existing = this.db.groupWallets
          .select()
          .where({ groupName, walletAddress })
          .first() as GroupWalletRow | undefined;
        if (existing) {
          existing.weightBps = weightBps;
          return existing;
        }
        return this.db.groupWallets.insert({
          groupName,
          walletAddress,
          weightBps,
          createdAtMs: Date.now(),
        }) as GroupWalletRow;
      },
      groupWalletLog,
    );
  }
  list(): GroupRow[] {
    return this.db.groups.select().orderBy("name", "asc").all() as GroupRow[];
  }
  wallets(groupName: string): GroupWalletRow[] {
    return this.db.groupWallets
      .select()
      .where({ groupName })
      .orderBy("id", "asc")
      .all() as GroupWalletRow[];
  }
}
