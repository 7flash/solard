export type SolardFunctionTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

const poolAddress = {
  type: "string",
  description: "Meteora DLMM pool address (base58 public key).",
};
const positionAddress = {
  type: "string",
  description: "Meteora DLMM position address (base58 public key).",
};
const strategy = {
  type: "string",
  enum: ["spot", "bid_ask", "curve"],
  description: "Meteora liquidity strategy. Omit to use spot.",
};
const slippageBps = {
  type: "number",
  minimum: 0,
  maximum: 10000,
  description: "Slippage tolerance in basis points. 100 = 1%.",
};
const executionProperties = {
  execute: {
    type: "boolean",
    description:
      "False/omitted returns a prepared transaction summary only. True attempts on-chain execution.",
  },
  live: {
    type: "boolean",
    description:
      "Must be true together with execute=true for a broadcast. The server live-trading master switch must also be enabled.",
  },
  simulate: {
    type: "boolean",
    description: "Simulate before broadcast. Defaults to true.",
  },
  skip_preflight: {
    type: "boolean",
    description: "Skip RPC preflight. Defaults to false.",
  },
  commitment: {
    type: "string",
    enum: ["processed", "confirmed", "finalized"],
  },
  max_retries: {
    type: "number",
    minimum: 0,
    maximum: 100,
  },
};

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

export const meteoraAgentTools: readonly SolardFunctionTool[] = [
  tool(
    "meteora_discover_pools",
    "Discover Meteora DLMM pools from the discovery API. Use for broad LP opportunity scans; this is read-only.",
    {
      page: { type: "number", minimum: 1 },
      page_size: { type: "number", minimum: 1, maximum: 100 },
      timeframe: {
        type: "string",
        enum: ["5m", "30m", "1h", "2h", "4h", "12h", "24h"],
      },
      category: {
        type: "string",
        enum: ["top", "new", "trending"],
        description:
          "Optional discovery subset. Omit for the broad All universe.",
      },
      sort_by: {
        type: "string",
        description:
          "Server-side discovery sort, e.g. fee_active_tvl_ratio:desc.",
      },
      filter_by: {
        type: "string",
        description: "Optional Meteora discovery API filter expression.",
      },
    },
  ),
  tool(
    "meteora_list_pools",
    "List Meteora indexed DLMM pools with the Data API's generic pagination, query, sort and filter syntax. Read-only.",
    {
      page: { type: "number", minimum: 1 },
      page_size: { type: "number", minimum: 1, maximum: 1000 },
      query: { type: "string" },
      sort_by: {
        type: "string",
        description:
          "Meteora sort expression such as tvl:desc or a windowed metric.",
      },
      filter_by: { type: "string", description: "Meteora filter expression." },
      volume_tw: {
        type: "string",
        enum: ["5m", "30m", "1h", "2h", "4h", "12h", "24h"],
      },
      fee_tvl_ratio_tw: {
        type: "string",
        enum: ["5m", "30m", "1h", "2h", "4h", "12h", "24h"],
      },
    },
  ),
  tool(
    "meteora_search_pools",
    "Search Meteora DLMM pools by symbol, name, mint, or address. Read-only.",
    {
      query: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 100 },
    },
    ["query"],
  ),
  tool(
    "meteora_get_onchain_pool_state",
    "Get normalized on-chain DLMM pool state including token reserves, bin step, active bin, and fee info. Read-only.",
    { pool_address: poolAddress, refresh: { type: "boolean" } },
    ["pool_address"],
  ),
  tool(
    "meteora_get_indexed_pool",
    "Get Meteora's indexed data record for one pool without requiring an on-chain refresh. Read-only.",
    { pool_address: poolAddress },
    ["pool_address"],
  ),
  tool(
    "meteora_get_discovery_pool_detail",
    "Get discovery/ranking metrics for one DLMM pool at a selected timeframe. Read-only.",
    {
      pool_address: poolAddress,
      timeframe: {
        type: "string",
        enum: ["5m", "30m", "1h", "2h", "4h", "12h", "24h"],
      },
    },
    ["pool_address"],
  ),
  tool(
    "meteora_get_pool_detail",
    "Get a combined Meteora pool view: on-chain state, indexed pool data, and discovery metrics. Read-only.",
    {
      pool_address: poolAddress,
      timeframe: {
        type: "string",
        enum: ["5m", "30m", "1h", "2h", "4h", "12h", "24h"],
      },
      refresh: { type: "boolean" },
    },
    ["pool_address"],
  ),
  tool(
    "meteora_get_active_bin",
    "Get the current active bin and human/raw price for a DLMM pool. Read-only.",
    { pool_address: poolAddress, refresh: { type: "boolean" } },
    ["pool_address"],
  ),
  tool(
    "meteora_get_bins_around_active",
    "Fetch bins around the current active bin. Read-only.",
    {
      pool_address: poolAddress,
      left: { type: "number", minimum: 0, maximum: 500 },
      right: { type: "number", minimum: 0, maximum: 500 },
    },
    ["pool_address"],
  ),
  tool(
    "meteora_get_bins_between",
    "Fetch all DLMM bins between two bin IDs. Read-only.",
    {
      pool_address: poolAddress,
      lower_bin_id: { type: "number" },
      upper_bin_id: { type: "number" },
    },
    ["pool_address", "lower_bin_id", "upper_bin_id"],
  ),
  tool(
    "meteora_get_bins_by_price",
    "Fetch DLMM bins spanning a human-readable price range. Read-only.",
    {
      pool_address: poolAddress,
      min_price: { type: "number", exclusiveMinimum: 0 },
      max_price: { type: "number", exclusiveMinimum: 0 },
    },
    ["pool_address", "min_price", "max_price"],
  ),
  tool(
    "meteora_get_bin_id_from_price",
    "Convert a human-readable price into a DLMM bin ID. Read-only.",
    {
      pool_address: poolAddress,
      price: { type: "number", exclusiveMinimum: 0 },
      round_down: { type: "boolean" },
    },
    ["pool_address", "price"],
  ),
  tool(
    "meteora_get_bin_id_from_price_per_lamport",
    "Convert a raw price-per-lamport value into a DLMM bin ID. Use only when working with SDK/raw price units. Read-only.",
    {
      pool_address: poolAddress,
      price_per_lamport: { type: "number", exclusiveMinimum: 0 },
      round_down: { type: "boolean" },
    },
    ["pool_address", "price_per_lamport"],
  ),
  tool(
    "meteora_get_pool_ohlcv",
    "Fetch indexed OHLCV candles for a Meteora DLMM pool. Read-only; no wallet or RPC signing is required.",
    {
      pool_address: poolAddress,
      timeframe: {
        type: "string",
        enum: ["5m", "30m", "1h", "2h", "4h", "12h", "24h"],
      },
      start_time: {
        type: "number",
        minimum: 0,
        description: "Unix seconds, inclusive.",
      },
      end_time: {
        type: "number",
        minimum: 0,
        description: "Unix seconds, inclusive.",
      },
    },
    ["pool_address"],
  ),
  tool(
    "meteora_get_pool_volume_history",
    "Fetch indexed volume, LP fees and protocol fees for a Meteora pool over time. Read-only.",
    {
      pool_address: poolAddress,
      timeframe: {
        type: "string",
        enum: ["5m", "30m", "1h", "2h", "4h", "12h", "24h"],
      },
      start_time: { type: "number", minimum: 0 },
      end_time: { type: "number", minimum: 0 },
    },
    ["pool_address"],
  ),
  tool(
    "meteora_list_pool_groups",
    "List Meteora DLMM pool groups by token pair with aggregate TVL/volume/fee metrics. Read-only.",
    {
      page: { type: "number", minimum: 1 },
      page_size: { type: "number", minimum: 1, maximum: 100 },
      query: { type: "string" },
      sort_by: { type: "string" },
      filter_by: { type: "string" },
      volume_tw: { type: "string" },
      fee_tvl_ratio_tw: { type: "string" },
    },
  ),
  tool(
    "meteora_get_pool_group",
    "Get the DLMM pools inside one Meteora token-pair group. Read-only.",
    {
      lexical_order_mints: {
        type: "string",
        description: "Meteora lexical_order_mints group key.",
      },
      page: { type: "number", minimum: 1 },
      page_size: { type: "number", minimum: 1, maximum: 100 },
      query: { type: "string" },
      sort_by: { type: "string" },
      filter_by: { type: "string" },
    },
    ["lexical_order_mints"],
  ),
  tool(
    "meteora_get_portfolio",
    "Get Meteora indexed closed-position portfolio history for a public wallet. Omit wallet_address to use the bound agent wallet. Read-only.",
    {
      wallet_address: { type: "string" },
      page: { type: "number", minimum: 1 },
      page_size: { type: "number", minimum: 1, maximum: 50 },
      days_back: { type: "number", minimum: 1, maximum: 365 },
    },
  ),
  tool(
    "meteora_get_open_portfolio",
    "Get Meteora indexed open-position portfolio balances, unclaimed fees and pool metrics for a wallet. Omit wallet_address for the bound agent wallet. Read-only.",
    {
      wallet_address: { type: "string" },
      page: { type: "number", minimum: 1 },
      page_size: { type: "number", minimum: 1, maximum: 50 },
      sort_direction: { type: "string", enum: ["asc", "desc"] },
      sort_by: {
        type: "string",
        enum: ["current_balances", "unclaimed_fee", "fee_per_tvl24h"],
      },
    },
  ),
  tool(
    "meteora_get_portfolio_total",
    "Get all-time total Meteora portfolio PnL for a wallet. Omit wallet_address for the bound agent wallet. Read-only.",
    { wallet_address: { type: "string" } },
  ),
  tool(
    "meteora_get_position_history",
    "Get indexed add/remove/claim history for a Meteora position. Read-only.",
    {
      position_address: positionAddress,
      event_type: {
        type: "string",
        enum: ["add", "remove", "claim_fee", "claim_reward"],
      },
      order_direction: { type: "string", enum: ["asc", "desc"] },
      page: { type: "number", minimum: 1 },
      page_size: { type: "number", minimum: 1 },
    },
    ["position_address"],
  ),
  tool(
    "meteora_get_protocol_metrics",
    "Get aggregate Meteora DLMM protocol TVL, volume, fees and pool count. Read-only.",
    {},
  ),
  tool(
    "meteora_get_daily_protocol_fees",
    "Get Meteora DLMM daily protocol-fee time series. Read-only.",
    {},
  ),
  tool(
    "meteora_get_daily_trading_fees",
    "Get Meteora DLMM daily trading-fee time series. Read-only.",
    {},
  ),
  tool(
    "meteora_get_daily_volume",
    "Get Meteora DLMM daily trading-volume time series. Read-only.",
    {},
  ),
  tool(
    "meteora_get_open_limit_order_pools",
    "Get pools containing live Meteora DLMM limit orders for a wallet. Omit wallet_address for the bound agent wallet. Read-only.",
    {
      wallet_address: { type: "string" },
      page: { type: "number", minimum: 1 },
      page_size: { type: "number", minimum: 1, maximum: 100 },
    },
  ),
  tool(
    "meteora_get_open_limit_orders",
    "Get live Meteora DLMM limit orders for one wallet and pool. Omit wallet_address for the bound agent wallet. Read-only.",
    {
      wallet_address: { type: "string" },
      pool_address: poolAddress,
      page: { type: "number", minimum: 1 },
      page_size: { type: "number", minimum: 1, maximum: 100 },
    },
    ["pool_address"],
  ),
  tool(
    "meteora_get_closed_limit_order_pools",
    "Get pools containing closed Meteora DLMM limit orders for a wallet. Omit wallet_address for the bound agent wallet. Read-only.",
    {
      wallet_address: { type: "string" },
      page: { type: "number", minimum: 1 },
      page_size: { type: "number", minimum: 1, maximum: 100 },
    },
  ),
  tool(
    "meteora_get_closed_limit_orders",
    "Get closed Meteora DLMM limit-order lifecycle records for one wallet and pool. Omit wallet_address for the bound agent wallet. Read-only.",
    {
      wallet_address: { type: "string" },
      pool_address: poolAddress,
      page: { type: "number", minimum: 1 },
      page_size: { type: "number", minimum: 1, maximum: 100 },
    },
    ["pool_address"],
  ),
  tool(
    "meteora_get_limit_order_summary",
    "Get aggregate open/closed DLMM limit-order counts, deposits and bonus fees for a wallet. Read-only.",
    { wallet_address: { type: "string" } },
  ),
  tool(
    "meteora_get_limit_order_bonus_claimed",
    "Get realized limit-order bonus claimed by a wallet in one pool. Read-only.",
    { wallet_address: { type: "string" }, pool_address: poolAddress },
    ["pool_address"],
  ),
  tool(
    "meteora_get_wallet_pool_total_claims",
    "Get combined fees and rewards claimed by a wallet in one Meteora pool. Read-only.",
    { wallet_address: { type: "string" }, pool_address: poolAddress },
    ["pool_address"],
  ),
  tool(
    "meteora_get_my_positions",
    "List every open Meteora DLMM position owned by this Solard agent wallet. Read-only.",
    {},
  ),
  tool(
    "meteora_get_wallet_positions",
    "List open Meteora DLMM positions for any public wallet address. Read-only.",
    { wallet_address: { type: "string" } },
    ["wallet_address"],
  ),
  tool(
    "meteora_get_wallet_positions_for_token",
    "List a wallet's Meteora positions involving a specific token mint. Read-only.",
    {
      wallet_address: { type: "string" },
      token_mint: { type: "string" },
    },
    ["wallet_address", "token_mint"],
  ),
  tool(
    "meteora_get_pool_positions",
    "List positions in one pool for this agent wallet or an explicitly supplied public wallet. Read-only.",
    {
      pool_address: poolAddress,
      wallet_address: {
        type: "string",
        description:
          "Optional public wallet. Omit to use the bound agent wallet.",
      },
    },
    ["pool_address"],
  ),
  tool(
    "meteora_find_pool_for_position",
    "Resolve the DLMM pool address for a position address by scanning this agent wallet or an explicitly supplied public wallet. Read-only.",
    {
      position_address: positionAddress,
      wallet_address: {
        type: "string",
        description: "Optional public wallet. Omit for the bound agent wallet.",
      },
    },
    ["position_address"],
  ),
  tool(
    "meteora_get_position",
    "Get the on-chain snapshot for one Meteora position. Read-only.",
    { pool_address: poolAddress, position_address: positionAddress },
    ["pool_address", "position_address"],
  ),
  tool(
    "meteora_get_position_pnl",
    "Get indexed PnL for a position or all positions in a pool. Defaults to this agent wallet. Read-only.",
    {
      pool_address: poolAddress,
      position_address: positionAddress,
      wallet_address: { type: "string" },
      status: { type: "string", enum: ["open", "closed"] },
    },
    ["pool_address"],
  ),
  tool(
    "meteora_quote_swap_exact_in",
    "Quote a Meteora DLMM exact-input swap. swap_for_y=true means token X -> token Y. Read-only.",
    {
      pool_address: poolAddress,
      swap_for_y: { type: "boolean" },
      amount_in: { type: ["number", "string"] },
      amount_in_raw: { type: ["number", "string"] },
      slippage_bps: slippageBps,
      allow_partial_fill: { type: "boolean" },
      max_extra_bin_arrays: { type: "number", minimum: 0 },
    },
    ["pool_address", "swap_for_y"],
  ),
  tool(
    "meteora_quote_swap_exact_out",
    "Quote a Meteora DLMM exact-output swap. swap_for_y=true means token X -> token Y. Read-only.",
    {
      pool_address: poolAddress,
      swap_for_y: { type: "boolean" },
      amount_out: { type: ["number", "string"] },
      amount_out_raw: { type: ["number", "string"] },
      slippage_bps: slippageBps,
      max_extra_bin_arrays: { type: "number", minimum: 0 },
    },
    ["pool_address", "swap_for_y"],
  ),
  tool(
    "meteora_open_position",
    "Prepare or execute opening a new Meteora DLMM position from the bound agent wallet. Supports bin IDs, bins around active, or percentage ranges.",
    {
      pool_address: poolAddress,
      strategy,
      amount_x: { type: ["number", "string"] },
      amount_y: { type: ["number", "string"] },
      amount_x_raw: { type: ["number", "string"] },
      amount_y_raw: { type: ["number", "string"] },
      min_bin_id: { type: "number" },
      max_bin_id: { type: "number" },
      bins_below: { type: "number", minimum: 0 },
      bins_above: { type: "number", minimum: 0 },
      downside_pct: { type: "number", minimum: 0 },
      upside_pct: { type: "number", minimum: 0 },
      slippage_bps: slippageBps,
      ...executionProperties,
    },
    ["pool_address"],
  ),
  tool(
    "meteora_add_liquidity",
    "Prepare or execute adding liquidity to an existing Meteora DLMM position from the bound agent wallet.",
    {
      pool_address: poolAddress,
      position_address: positionAddress,
      strategy,
      amount_x: { type: ["number", "string"] },
      amount_y: { type: ["number", "string"] },
      amount_x_raw: { type: ["number", "string"] },
      amount_y_raw: { type: ["number", "string"] },
      min_bin_id: { type: "number" },
      max_bin_id: { type: "number" },
      slippage_bps: slippageBps,
      ...executionProperties,
    },
    ["pool_address", "position_address"],
  ),
  tool(
    "meteora_remove_liquidity",
    "Prepare or execute partial/full liquidity removal from a Meteora position. bps=10000 removes 100%.",
    {
      pool_address: poolAddress,
      position_address: positionAddress,
      bps: { type: "number", minimum: 1, maximum: 10000 },
      from_bin_id: { type: "number" },
      to_bin_id: { type: "number" },
      claim_and_close: { type: "boolean" },
      skip_unwrap_sol: { type: "boolean" },
      ...executionProperties,
    },
    ["pool_address", "position_address"],
  ),
  tool(
    "meteora_close_position",
    "Prepare or execute full liquidity removal, fee/reward claiming where supported, and position close.",
    {
      pool_address: poolAddress,
      position_address: positionAddress,
      ...executionProperties,
    },
    ["pool_address", "position_address"],
  ),
  tool(
    "meteora_claim_fees",
    "Prepare or execute claiming swap fees from one position.",
    {
      pool_address: poolAddress,
      position_address: positionAddress,
      ...executionProperties,
    },
    ["pool_address", "position_address"],
  ),
  tool(
    "meteora_claim_lm_rewards",
    "Prepare or execute claiming LM rewards from one position.",
    {
      pool_address: poolAddress,
      position_address: positionAddress,
      ...executionProperties,
    },
    ["pool_address", "position_address"],
  ),
  tool(
    "meteora_claim_position_rewards",
    "Prepare or execute claiming all fees/rewards supported for one position.",
    {
      pool_address: poolAddress,
      position_address: positionAddress,
      ...executionProperties,
    },
    ["pool_address", "position_address"],
  ),
  tool(
    "meteora_claim_all_fees",
    "Prepare or execute claiming swap fees for all positions in one pool owned by the bound agent wallet.",
    { pool_address: poolAddress, ...executionProperties },
    ["pool_address"],
  ),
  tool(
    "meteora_claim_all_lm_rewards",
    "Prepare or execute claiming LM rewards for all positions in one pool owned by the bound agent wallet.",
    { pool_address: poolAddress, ...executionProperties },
    ["pool_address"],
  ),
  tool(
    "meteora_claim_all_rewards",
    "Prepare or execute claiming all fees/rewards for all positions in one pool owned by the bound agent wallet.",
    { pool_address: poolAddress, ...executionProperties },
    ["pool_address"],
  ),
  tool(
    "meteora_swap_exact_in",
    "Prepare or execute a Meteora exact-input swap from the bound agent wallet. swap_for_y=true means X -> Y.",
    {
      pool_address: poolAddress,
      swap_for_y: { type: "boolean" },
      amount_in: { type: ["number", "string"] },
      amount_in_raw: { type: ["number", "string"] },
      slippage_bps: slippageBps,
      allow_partial_fill: { type: "boolean" },
      max_extra_bin_arrays: { type: "number", minimum: 0 },
      ...executionProperties,
    },
    ["pool_address", "swap_for_y"],
  ),
  tool(
    "meteora_swap_exact_out",
    "Prepare or execute a Meteora exact-output swap from the bound agent wallet. swap_for_y=true means X -> Y.",
    {
      pool_address: poolAddress,
      swap_for_y: { type: "boolean" },
      amount_out: { type: ["number", "string"] },
      amount_out_raw: { type: ["number", "string"] },
      slippage_bps: slippageBps,
      max_extra_bin_arrays: { type: "number", minimum: 0 },
      ...executionProperties,
    },
    ["pool_address", "swap_for_y"],
  ),
] as const;

export type MeteoraAgentToolName =
  (typeof meteoraAgentTools)[number]["function"]["name"];

export const METEORA_AGENT_TOOL_NAMES = new Set(
  meteoraAgentTools.map((entry) => entry.function.name),
);
