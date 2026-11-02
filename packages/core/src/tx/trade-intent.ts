import type { SolardDatabase } from "../db/schema.ts";
import type { TradeResult } from "./trade-result.ts";
export type TradeIntent = {
  owner?: { pid: number; hostname: string };
  fingerprint: string;
  wallet: string;
  result?: TradeResult;
  submissions: Array<{
    signature: string;
    executionId: number;
    sender: string;
    lastValidBlockHeight: number;
    priorityMicroLamports: number;
  }>;
};
const encode = (value: unknown) =>
  JSON.stringify(value, (_key, data) =>
    typeof data === "bigint" ? { $bigint: data.toString() } : data,
  );
const decode = (value: string) =>
  JSON.parse(value, (_key, data) =>
    data && typeof data === "object" && typeof data.$bigint === "string"
      ? BigInt(data.$bigint)
      : data,
  );
export class TradeIntentStore {
  constructor(private readonly db: SolardDatabase) {}
  private key(key: string) {
    if (!key.trim() || key.length > 512) throw new Error("Invalid intentKey");
    return `trade-intent:${key}`;
  }
  get(key: string): TradeIntent | null {
    const row = this.db.settings
      .select()
      .where({ key: this.key(key) })
      .first();
    return row ? decode(row.value) : null;
  }
  /** Unique settings key arbitrates competing processes before any signing. */
  claim(key: string, fingerprint: string, wallet: string): boolean {
    try {
      this.db.settings.insert({
        key: this.key(key),
        value: encode({ fingerprint, wallet, submissions: [], owner: { pid: process.pid, hostname: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "" } }),
        updatedAtMs: Date.now(),
      });
      return true;
    } catch (error) {
      if (this.get(key)) return false;
      throw error;
    }
  }
  update(key: string, mutate: (intent: TradeIntent) => void): void {
    // A deferred SQLite transaction can lose a lock upgrade to another process.
    // Retry the whole read/modify/write transaction, never just the write.
    for (let attempt = 0; ; attempt++) {
      try {
        this.db.transaction(() => {
      const row = this.db.settings
        .select()
        .where({ key: this.key(key) })
        .first();
      if (!row) throw new Error("Missing trade intent");
      const intent: TradeIntent = decode(row.value);
      mutate(intent);
      const current: TradeIntent = decode(row.value);
      if (
        current.result &&
        current.result.status !== "unresolved" &&
        intent.result?.status === "unresolved"
      )
        return;
      this.db.settings.update({ value: encode(intent), updatedAtMs: Date.now() })
        .where({ key: this.key(key) }).exec();
    });
        return;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (attempt >= 5 || !/^SQLITE_(BUSY|LOCKED)/.test(code ?? "")) throw error;
        Bun.sleepSync(20 * (attempt + 1));
      }
    }
  }
}

/** Only local, definitely dead owners qualify; permission errors/PID reuse stay conservative. */
export function abandonedBeforeSubmission(intent: TradeIntent): boolean {
 if (intent.submissions.length || !intent.owner || !intent.owner.hostname || intent.owner.hostname.toLowerCase() !== (process.env.COMPUTERNAME ?? process.env.HOSTNAME)?.toLowerCase()) return false;
 try { process.kill(intent.owner.pid, 0); return false; }
 catch(error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
