import { Database } from "bun:sqlite";

export type RpcWindowOptions = {
  maxRequests: number;
  windowMs: number;
  maxSends?: number;
  sendWindowMs?: number;
};
type Reservation = { at: number; requests: number; sends: number };

function waitForBudget(
  rows: Reservation[],
  now: number,
  windowMs: number,
  limit: number,
  cost: number,
  key: "requests" | "sends",
): number {
  if (cost === 0) return 0;
  const active = rows.filter((row) => row.at > now - windowMs && row[key] > 0);
  let used = active.reduce((sum, row) => sum + row[key], 0);
  if (used + cost <= limit) return 0;
  for (const row of active) {
    used -= row[key];
    if (used + cost <= limit) return Math.max(1, row.at + windowMs - now);
  }
  return windowMs;
}

/** One atomic reservation precedes each network start; no transaction spans a wait or fetch. */
export class SharedRpcWindow {
  private rows: Reservation[] = [];
  private db?: Database;
  constructor(path?: string) {
    if (!path) return;
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS solard_rpc_window (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, requests INTEGER NOT NULL, sends INTEGER NOT NULL)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS solard_rpc_window_at ON solard_rpc_window(at)",
    );
  }
  close(): void {
    this.db?.close();
  }
  /** Returns zero after reserving, otherwise milliseconds until another reservation may fit. */
  reserve(
    options: RpcWindowOptions,
    requests = 1,
    sends = 0,
    now = Date.now(),
  ): number {
    const maxSends = options.maxSends ?? 1;
    const sendWindowMs = options.sendWindowMs ?? 1000;
    for (const number of [
      options.maxRequests,
      options.windowMs,
      maxSends,
      sendWindowMs,
      requests,
    ])
      if (!Number.isSafeInteger(number) || number <= 0)
        throw new Error("RPC window values must be positive integers");
    if (
      !Number.isSafeInteger(sends) ||
      sends < 0 ||
      requests > options.maxRequests ||
      sends > maxSends
    )
      throw new Error("RPC batch exceeds the shared rate-limit window budget");
    const cutoff = now - Math.max(options.windowMs, sendWindowMs);
    const attempt = () => {
      let rows: Reservation[];
      if (this.db) {
        this.db
          .query("DELETE FROM solard_rpc_window WHERE at <= ?")
          .run(cutoff);
        rows = this.db
          .query(
            "SELECT at, requests, sends FROM solard_rpc_window ORDER BY at, id",
          )
          .all() as Reservation[];
      } else {
        this.rows = this.rows.filter((row) => row.at > cutoff);
        rows = this.rows;
      }
      const wait = Math.max(
        waitForBudget(
          rows,
          now,
          options.windowMs,
          options.maxRequests,
          requests,
          "requests",
        ),
        waitForBudget(rows, now, sendWindowMs, maxSends, sends, "sends"),
      );
      if (wait === 0) {
        if (this.db)
          this.db
            .query(
              "INSERT INTO solard_rpc_window (at, requests, sends) VALUES (?, ?, ?)",
            )
            .run(now, requests, sends);
        else this.rows.push({ at: now, requests, sends });
      }
      return wait;
    };
    return this.db ? this.db.transaction(attempt).immediate() : attempt();
  }
}

/** Count RPC operations inside batches, including the independently limited sendTransaction. */
export function rpcRequestCost(body: unknown): {
  requests: number;
  sends: number;
} {
  try {
    const value = typeof body === "string" ? JSON.parse(body) : body;
    const requests = Array.isArray(value) ? value : [value];
    return {
      requests: Math.max(1, requests.length),
      sends: requests.filter((row) => row?.method === "sendTransaction").length,
    };
  } catch {
    return { requests: 1, sends: 0 };
  }
}
