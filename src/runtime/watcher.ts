import { EventEmitter } from "node:events";
import { PublicKey, type Connection, type Logs } from "@solana/web3.js";
import type { SowlDatabase, WatchRow } from "../db/schema.js";

export type SowlWatchEvents = {
  logs: { kind: WatchRow["kind"]; address: string; logs: Logs };
};

/**
 * Generic subscription registry. It emits raw address logs only; venue-specific
 * decoding belongs in discovery/observer plugins, not in the Sowl kernel.
 */
export class SowlWatcher extends EventEmitter {
  private subscriptions: number[] = [];
  constructor(private readonly db: SowlDatabase, private readonly connection: () => Connection) { super(); }
  watchToken(mint: string, label?: string): WatchRow { return this.register("token", mint, label); }
  watchWallet(address: string, label?: string): WatchRow { return this.register("wallet", address, label); }
  watchProgram(address: string, label?: string): WatchRow { return this.register("program", address, label); }
  private register(kind: WatchRow["kind"], address: string, label?: string): WatchRow {
    const existing = this.db.watches.select().where({ kind, address }).first() as WatchRow | undefined;
    if (existing) { existing.isActive = 1; existing.label = label ?? existing.label; existing.updatedAtMs = Date.now(); return existing; }
    const now = Date.now();
    return this.db.watches.insert({ kind, address, label: label ?? null, configJson: null, isActive: 1, createdAtMs: now, updatedAtMs: now }) as WatchRow;
  }
  start(): void {
    void this.stop();
    const rows = this.db.watches.select().where({ isActive: 1 }).all() as WatchRow[];
    for (const row of rows) {
      const id = this.connection().onLogs(
        new PublicKey(row.address),
        (logs) => this.emit("logs", { kind: row.kind, address: row.address, logs }),
        "confirmed",
      );
      this.subscriptions.push(id);
    }
  }
  async stop(): Promise<void> {
    await Promise.all(this.subscriptions.map((id) => this.connection().removeOnLogsListener(id)));
    this.subscriptions = [];
  }
}
