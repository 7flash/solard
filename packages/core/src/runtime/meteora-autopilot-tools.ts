import type { SolardFunctionTool } from "./meteora-tools.ts";

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): SolardFunctionTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: objectSchema(properties, required),
    },
  };
}

const role = { type: "string", enum: ["SCREENER", "MANAGER", "GENERAL"] };

export const meteoraAutopilotTools: readonly SolardFunctionTool[] = [
  tool(
    "meteora_autopilot_status",
    "Read the autonomous Meteora LP agent status, risk config, SOL balance, position count, memory counts, and last-cycle state.",
    {},
  ),
  tool(
    "meteora_autopilot_configure",
    "Persist partial autonomous LP configuration. Changes are scoped to this Solard agent and survive restarts.",
    {
      screening: { type: "object", additionalProperties: true },
      risk: { type: "object", additionalProperties: true },
      strategy: { type: "object", additionalProperties: true },
      management: { type: "object", additionalProperties: true },
      loopIntervalMs: { type: "number", minimum: 5000 },
    },
  ),
  tool(
    "meteora_autopilot_context",
    "Get persistent policy context for a future model: config, pinned/recent lessons, recent decisions, position instructions, blacklist, and pool-memory summaries.",
    {
      decision_limit: { type: "number", minimum: 1, maximum: 50 },
      lesson_limit: { type: "number", minimum: 1, maximum: 100 },
    },
  ),
  tool(
    "meteora_autopilot_screen",
    "Run deterministic Meteora DLMM hard filters and balanced scoring before any model judgment. Returns eligible and rejected candidates with reasons.",
    { limit: { type: "number", minimum: 1, maximum: 50 } },
  ),
  tool(
    "meteora_autopilot_management_plan",
    "Inspect all open Meteora positions and produce deterministic claim/close/rebalance/review actions from PnL, fees, range state, health, and persistent position notes.",
    {},
  ),
  tool(
    "meteora_autopilot_plan_cycle",
    "Build a full read-only management + deployment plan. This never broadcasts transactions.",
    { limit: { type: "number", minimum: 1, maximum: 50 } },
  ),
  tool(
    "meteora_autopilot_run_cycle",
    "Run one autonomous LP cycle. Defaults to planning only. Broadcasting requires execute=true, live=true, and Solard's server live-trading master switch.",
    {
      limit: { type: "number", minimum: 1, maximum: 50 },
      execute: { type: "boolean" },
      live: { type: "boolean" },
      simulate: { type: "boolean" },
      skip_preflight: { type: "boolean" },
    },
  ),
  tool(
    "meteora_autopilot_history",
    "Read structured recent autonomous decisions: screens, deploys, claims, closes, rebalances, skips, and errors.",
    { limit: { type: "number", minimum: 1, maximum: 250 } },
  ),
  tool(
    "meteora_autopilot_list_lessons",
    "List persistent LP lessons, optionally filtered for screener/manager/general use. Pinned lessons are returned first.",
    { role },
  ),
  tool(
    "meteora_autopilot_add_lesson",
    "Save a persistent, actionable LP lesson for future cycles.",
    {
      rule: { type: "string" },
      tags: { type: "array", items: { type: "string" }, maxItems: 20 },
      role,
      pinned: { type: "boolean" },
    },
    ["rule"],
  ),
  tool(
    "meteora_autopilot_pin_lesson",
    "Pin or unpin a persistent LP lesson.",
    {
      lesson_id: { type: "string" },
      pinned: { type: "boolean" },
    },
    ["lesson_id"],
  ),
  tool(
    "meteora_autopilot_remove_lesson",
    "Remove one persistent LP lesson by ID.",
    { lesson_id: { type: "string" } },
    ["lesson_id"],
  ),
  tool(
    "meteora_autopilot_get_pool_memory",
    "Read persistent deployment/close performance, cooldown, and notes for one Meteora pool.",
    { pool_address: { type: "string" } },
    ["pool_address"],
  ),
  tool(
    "meteora_autopilot_add_pool_note",
    "Add a persistent note to a Meteora pool memory record.",
    { pool_address: { type: "string" }, note: { type: "string" } },
    ["pool_address", "note"],
  ),
  tool(
    "meteora_autopilot_set_position_note",
    "Set or clear a persistent instruction for an open position. By default any instruction blocks automatic close/rebalance and produces a review action instead.",
    {
      position_address: { type: "string" },
      instruction: { type: ["string", "null"] },
    },
    ["position_address"],
  ),
  tool(
    "meteora_autopilot_blacklist_token",
    "Persistently blacklist a base-token mint so the deterministic screener rejects it before model review.",
    {
      mint: { type: "string" },
      symbol: { type: "string" },
      reason: { type: "string" },
    },
    ["mint", "reason"],
  ),
  tool(
    "meteora_autopilot_unblacklist_token",
    "Remove a base-token mint from the autonomous LP blacklist.",
    { mint: { type: "string" } },
    ["mint"],
  ),
  tool(
    "meteora_autopilot_list_blacklist",
    "List persistent base-token blacklist entries.",
    {},
  ),
] as const;

export type MeteoraAutopilotToolName =
  (typeof meteoraAutopilotTools)[number]["function"]["name"];

export const METEORA_AUTOPILOT_TOOL_NAMES = new Set(
  meteoraAutopilotTools.map((entry) => entry.function.name),
);
