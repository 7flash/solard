import { expect, test } from "bun:test";
import { Database } from "sqlite-zod-orm";
import { AgentSchema, type SolardDatabase } from "./schema.ts";
import { AgentRepo } from "./agent-repo.ts";

test("agent config and state merges preserve other runtime namespaces", () => {
  const db = new Database(":memory:", { agents: AgentSchema });
  try {
    const repo = new AgentRepo(db as unknown as SolardDatabase);
    const agent = repo.configure("test", { existing: { enabled: true } });
    repo.mergeConfig(agent, { meteoraAutopilot: { enabled: false } });
    expect(repo.config(repo.resolve("test"))).toEqual({
      existing: { enabled: true }, meteoraAutopilot: { enabled: false },
    });
    repo.saveState(agent, { existing: { cursor: 42 } });
    repo.mergeState(agent, { meteoraIntelligence: { cursor: 43 } });
    expect(repo.state(repo.resolve("test"))).toEqual({
      existing: { cursor: 42 }, meteoraIntelligence: { cursor: 43 },
    });
    agent.stateJson = "null";
    expect(repo.state(agent)).toEqual({});
  } finally { db.close(); }
});
