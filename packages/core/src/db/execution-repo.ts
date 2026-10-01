import { measure } from "../core/log.ts";
import { executionLog } from "../core/log-result.ts";
import { measuredSync } from "../core/measured.ts";
import type { SolardDatabase, ExecutionRow } from "./schema.ts";
import type { TransactionAction } from "../tx/types.ts";

export type ExecutionQuery = {
  walletAddress?: string;
  mint?: string;
  status?: ExecutionRow["status"] | readonly ExecutionRow["status"][];
  kind?: string | readonly string[];
  limit?: number;
};

const m = measure("executions");
export class ExecutionRepo {
  constructor(private readonly db: SolardDatabase) {}
  create(
    input: Omit<ExecutionRow, "id" | "createdAtMs" | "updatedAtMs">,
    actions: TransactionAction[] = [],
  ): ExecutionRow {
    return measuredSync(
      m,
      `create ${input.kind}`,
      () => {
        const now = Date.now();
        const row = this.db.executions.insert({
          ...input,
          createdAtMs: now,
          updatedAtMs: now,
        }) as ExecutionRow;
        actions.forEach((action, index) =>
          this.db.executionActions.insert({
            executionId: row.id,
            actionIndex: index,
            kind: action.kind,
            mint: action.mint?.toBase58() ?? null,
            recipient: action.recipient?.toBase58() ?? null,
            metadataJson: JSON.stringify(action.meta ?? {}),
            createdAtMs: now,
          }),
        );
        return row;
      },
      executionLog,
    );
  }
  get(id: number): ExecutionRow {
    const row = this.db.executions.select().where({ id }).first() as
      ExecutionRow | undefined;
    if (!row) throw new Error(`Unknown execution id: ${id}`);
    return row;
  }
  findBySignature(signature: string): ExecutionRow | undefined {
    return this.db.executions
      .select()
      .where({ signature })
      .orderBy("createdAtMs", "desc")
      .first() as ExecutionRow | undefined;
  }
  update(row: ExecutionRow, patch: Partial<ExecutionRow>): ExecutionRow {
    Object.assign(row, patch, { updatedAtMs: Date.now() });
    return row;
  }
  query(input: ExecutionQuery = {}): ExecutionRow[] {
    const statuses =
      input.status == null
        ? null
        : new Set<ExecutionRow["status"]>(
            Array.isArray(input.status) ? [...input.status] : [input.status],
          );
    const kinds =
      input.kind == null
        ? null
        : new Set<string>(
            Array.isArray(input.kind) ? [...input.kind] : [input.kind],
          );
    const limit =
      input.limit == null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.trunc(input.limit));
    return (
      this.db.executions
        .select()
        .orderBy("createdAtMs", "desc")
        .all() as ExecutionRow[]
    )
      .filter(
        (row) =>
          (input.walletAddress == null ||
            row.walletAddress === input.walletAddress) &&
          (input.mint == null || row.mint === input.mint) &&
          (statuses == null || statuses.has(row.status)) &&
          (kinds == null || kinds.has(row.kind)),
      )
      .slice(0, limit);
  }
  history(limit = 50): ExecutionRow[] {
    return this.query({ limit });
  }
}
