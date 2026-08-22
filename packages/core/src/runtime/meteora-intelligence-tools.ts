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

const category = {
  type: "string",
  enum: ["alpha", "smart", "fast", "multi"],
};
const walletType = { type: "string", enum: ["lp", "holder"] };
const role = { type: "string", enum: ["SCREENER", "MANAGER", "GENERAL"] };
const indicatorPreset = {
  type: "string",
  enum: [
    "supertrend_break",
    "rsi_reversal",
    "bollinger_reversion",
    "rsi_plus_supertrend",
    "supertrend_or_rsi",
    "bb_plus_rsi",
    "fibo_reclaim",
    "fibo_reject",
  ],
};

export const meteoraIntelligenceTools: readonly SolardFunctionTool[] = [
  tool(
    "meteora_intelligence_status",
    "Read Meteora intelligence configuration, smart-wallet count, strategy state, model readiness, and recent decision count.",
    {},
  ),
  tool(
    "meteora_intelligence_configure",
    "Persist partial intelligence configuration for token safety, indicators, top-LPer study, smart wallets, and the optional OpenAI-compatible decision model.",
    {
      token: { type: "object", additionalProperties: true },
      indicators: { type: "object", additionalProperties: true },
      topLpers: { type: "object", additionalProperties: true },
      smartWallets: { type: "object", additionalProperties: true },
      model: { type: "object", additionalProperties: true },
      decision: { type: "object", additionalProperties: true },
    },
  ),
  tool(
    "meteora_get_token_info",
    "Search Jupiter token intelligence by name, symbol, or mint. Returns audit flags, holders, organic score, liquidity, market cap, fees, and short-horizon stats.",
    { query: { type: "string" } },
    ["query"],
  ),
  tool(
    "meteora_get_token_holders",
    "Inspect holder concentration for a token and cross-reference configured smart wallets. Pool/AMM addresses are excluded from the top-10 real-holder concentration calculation.",
    {
      mint: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 100 },
    },
    ["mint"],
  ),
  tool(
    "meteora_get_token_narrative",
    "Fetch Jupiter ChainInsight narrative/context for a token mint.",
    { mint: { type: "string" } },
    ["mint"],
  ),
  tool(
    "meteora_confirm_indicator",
    "Calculate RSI, Bollinger Bands, Supertrend, and Fibonacci levels from Meteora DLMM OHLCV and evaluate a configured entry/exit preset.",
    {
      pool_address: { type: "string" },
      side: { type: "string", enum: ["entry", "exit"] },
      preset: indicatorPreset,
      refresh: { type: "boolean" },
    },
    ["pool_address", "side"],
  ),
  tool(
    "meteora_get_top_lpers",
    "Read top-LPer aggregate data for a pool from the configured Agent Meridian-compatible intelligence endpoint. Fails soft when the service is not configured or unavailable.",
    {
      pool_address: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 20 },
    },
    ["pool_address"],
  ),
  tool(
    "meteora_study_top_lpers",
    "Study top LPers for a pool, including historical style/range patterns when the configured intelligence service provides them.",
    {
      pool_address: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 20 },
    },
    ["pool_address"],
  ),
  tool(
    "meteora_add_smart_wallet",
    "Persist a wallet as an LP or holder intelligence signal for future candidate analysis.",
    {
      address: { type: "string" },
      name: { type: "string" },
      category,
      wallet_type: walletType,
      note: { type: ["string", "null"] },
    },
    ["address", "name"],
  ),
  tool(
    "meteora_remove_smart_wallet",
    "Remove a wallet from the persistent Meteora smart-wallet registry.",
    { address: { type: "string" } },
    ["address"],
  ),
  tool(
    "meteora_list_smart_wallets",
    "List persistent Meteora smart-wallet signals.",
    {},
  ),
  tool(
    "meteora_check_smart_wallets_on_pool",
    "Check whether configured smart wallets currently LP in a pool or hold its base token.",
    { pool_address: { type: "string" } },
    ["pool_address"],
  ),
  tool(
    "meteora_add_strategy",
    "Add or replace a persistent LP strategy definition. The strategy can constrain token quality, indicator entry, range, and exit preferences.",
    {
      id: { type: "string" },
      name: { type: "string" },
      author: { type: ["string", "null"] },
      lp_strategy: { type: "string", enum: ["bid_ask", "spot"] },
      token_criteria: { type: "object", additionalProperties: true },
      entry: { type: "object", additionalProperties: true },
      range: { type: "object", additionalProperties: true },
      exit: { type: "object", additionalProperties: true },
      best_for: { type: ["string", "null"] },
      raw: { type: ["string", "null"] },
    },
    ["id", "name"],
  ),
  tool(
    "meteora_list_strategies",
    "List saved LP strategies and identify the active strategy.",
    {},
  ),
  tool(
    "meteora_get_strategy",
    "Read one saved LP strategy by ID.",
    { id: { type: "string" } },
    ["id"],
  ),
  tool(
    "meteora_set_active_strategy",
    "Set the strategy used as the default model/policy preference for future deployments.",
    { id: { type: ["string", "null"] } },
  ),
  tool(
    "meteora_remove_strategy",
    "Remove a saved LP strategy.",
    { id: { type: "string" } },
    ["id"],
  ),
  tool(
    "meteora_intelligence_candidates",
    "Enrich deterministic autopilot candidates with token audit, holder concentration, narrative, smart-wallet signals, technical indicators, top-LPer study, and strategy checks.",
    { limit: { type: "number", minimum: 1, maximum: 20 } },
  ),
  tool(
    "meteora_intelligence_context",
    "Build the complete bounded context for an LLM decision: autopilot plan/context, enriched candidates, strategies, smart wallets, and hard constraints.",
    { limit: { type: "number", minimum: 1, maximum: 20 } },
  ),
  tool(
    "meteora_intelligence_propose_cycle",
    "Produce a structured model-reviewed cycle decision. Uses the configured OpenAI-compatible model when enabled, otherwise returns a deterministic fallback recommendation.",
    { limit: { type: "number", minimum: 1, maximum: 20 } },
  ),
  tool(
    "meteora_intelligence_run_cycle",
    "Run one model-reviewed Meteora cycle. Defaults to plan/review only. Live writes still require execute=true, live=true, and Solard's live-trading master switch.",
    {
      limit: { type: "number", minimum: 1, maximum: 20 },
      execute: { type: "boolean" },
      live: { type: "boolean" },
      simulate: { type: "boolean" },
      skip_preflight: { type: "boolean" },
    },
  ),
  tool(
    "meteora_intelligence_history",
    "Read recent structured intelligence/model decisions.",
    { limit: { type: "number", minimum: 1, maximum: 100 } },
  ),
] as const;

export type MeteoraIntelligenceToolName =
  (typeof meteoraIntelligenceTools)[number]["function"]["name"];

export const METEORA_INTELLIGENCE_TOOL_NAMES = new Set(
  meteoraIntelligenceTools.map((entry) => entry.function.name),
);
