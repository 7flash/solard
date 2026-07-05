import type { AgentRow, SowlDatabase } from "./schema.js";

export class AgentRepo {
  constructor(private readonly db: SowlDatabase) {}

  resolve(name: string): AgentRow {
    const row = this.db.agents.select().where({ name }).first() as
      AgentRow | undefined;
    if (row) return row;
    return this.configure(name, {});
  }

  configure(name: string, config: Record<string, unknown>): AgentRow {
    const existing = this.db.agents.select().where({ name }).first() as
      AgentRow | undefined;
    const now = Date.now();
    const configJson = JSON.stringify(config);
    if (existing) {
      existing.configJson = configJson;
      existing.updatedAtMs = now;
      return existing;
    }
    return this.db.agents.insert({
      name,
      configJson,
      stateJson: "{}",
      createdAtMs: now,
      updatedAtMs: now,
    }) as AgentRow;
  }

  list(): AgentRow[] {
    return this.db.agents.select().orderBy("id", "asc").all() as AgentRow[];
  }

  config(agent: AgentRow): Record<string, unknown> {
    try {
      return JSON.parse(agent.configJson) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  saveState(agent: AgentRow, state: unknown): void {
    agent.stateJson = JSON.stringify(state);
    agent.updatedAtMs = Date.now();
  }
}
