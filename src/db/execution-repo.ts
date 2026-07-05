import { measure } from "../core/log.js";
import { executionLog } from "../core/log-result.js";
import { measuredSync } from "../core/measured.js";
import type { SowlDatabase, ExecutionRow } from "./schema.js";
import type { TransactionAction } from "../tx/types.js";

const m = measure("executions");
export class ExecutionRepo {
  constructor(private readonly db: SowlDatabase) {}
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
  history(limit = 50): ExecutionRow[] {
    return this.db.executions
      .select()
      .orderBy("createdAtMs", "desc")
      .limit(limit)
      .all() as ExecutionRow[];
  }
}
