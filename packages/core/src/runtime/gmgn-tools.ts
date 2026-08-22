import type { SolardFunctionTool } from "./meteora-tools.ts";

const chains = ["sol", "bsc", "base", "eth", "robinhood", "arc", "stable"];
const chain = { type: "string", enum: chains };
const address = { type: "string", description: "Token contract/mint address." };

function schema(properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(Array.isArray(required) && required.length ? { required } : {}),
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
    function: { name, description, parameters: schema(properties, required) },
  };
}

const page = {
  limit: { type: "number", minimum: 1, maximum: 100 },
  tag: {
    type: "string",
    description:
      "Optional GMGN wallet tag such as smart_degen, renowned, sniper, or bundler.",
  },
  order_by: { type: "string" },
  direction: { type: "string", enum: ["asc", "desc"] },
};

export const gmgnAgentTools: readonly SolardFunctionTool[] = [
  tool(
    "gmgn_token_info",
    "Get GMGN token metadata, price/liquidity, holder stats, socials, dev info and launchpad fee_distribution when available. Read-only.",
    { chain, address },
    ["chain", "address"],
  ),
  tool(
    "gmgn_token_security",
    "Get GMGN token security/risk fields such as authority status, taxes, concentration and rug indicators. Read-only.",
    { chain, address },
    ["chain", "address"],
  ),
  tool(
    "gmgn_token_pool",
    "Get GMGN pool/liquidity information for a token. Read-only.",
    { chain, address },
    ["chain", "address"],
  ),
  tool(
    "gmgn_token_holders",
    "Get top token holders with GMGN wallet tags and available PnL/holding metadata. Read-only.",
    { chain, address, ...page },
    ["chain", "address"],
  ),
  tool(
    "gmgn_token_traders",
    "Get top traders for a token with GMGN wallet tags and available trading/PnL metadata. Read-only.",
    { chain, address, ...page },
    ["chain", "address"],
  ),
  tool(
    "gmgn_token_kline",
    "Fetch token OHLCV/K-line candles from GMGN. volume is USD traded; amount is token units. Read-only.",
    {
      chain,
      address,
      resolution: {
        type: "string",
        enum: ["30s", "1m", "5m", "15m", "1h", "4h", "1d"],
      },
      from: { type: "number", description: "Unix seconds." },
      to: { type: "number", description: "Unix seconds." },
    },
    ["chain", "address", "resolution"],
  ),
  tool(
    "gmgn_market_trending",
    "Get GMGN trending token ranks. Useful fields include volume, swaps, holders, smart-money counts, risk fields and gas_fee. Read-only.",
    {
      chain,
      interval: { type: "string", enum: ["1m", "5m", "1h", "6h", "24h"] },
      limit: { type: "number", minimum: 1, maximum: 100 },
      order_by: {
        type: "string",
        description:
          "Examples: volume, swaps, marketcap, liquidity, holder_count, smart_degen_count, gas_fee, price.",
      },
      direction: { type: "string", enum: ["asc", "desc"] },
      filter: { type: "array", items: { type: "string" } },
      platform: { type: "array", items: { type: "string" } },
      min_volume: { type: "number" },
      max_volume: { type: "number" },
      min_liquidity: { type: "number" },
      max_liquidity: { type: "number" },
      min_marketcap: { type: "number" },
      max_marketcap: { type: "number" },
      min_holder_count: { type: "number" },
      max_holder_count: { type: "number" },
      min_smart_degen_count: { type: "number" },
      max_smart_degen_count: { type: "number" },
      min_renowned_count: { type: "number" },
      max_renowned_count: { type: "number" },
      min_gas_fee: {
        type: "number",
        description: "Minimum GMGN gas_fee metric.",
      },
      max_gas_fee: {
        type: "number",
        description: "Maximum GMGN gas_fee metric.",
      },
    },
    ["chain", "interval"],
  ),
  tool(
    "gmgn_market_trenches",
    "Get newly launched/near-complete/completed launchpad tokens from GMGN Trenches. The body is passed through to the read-only discovery endpoint and may include supported filters such as min_total_fee/max_total_fee. Read-only.",
    {
      chain,
      body: { type: "object", additionalProperties: true },
    },
    ["chain"],
  ),
  tool(
    "gmgn_token_signals",
    "Query GMGN token signal groups such as smart-money buys, price/ATH, KOL and platform calls. Group filters can include total_fee_min/total_fee_max. Read-only.",
    {
      chain,
      groups: {
        type: "array",
        items: { type: "object", additionalProperties: true },
        minItems: 1,
      },
    },
    ["chain", "groups"],
  ),
  tool(
    "gmgn_hot_searches",
    "Get GMGN hot-search rankings. Each params entry may target a different chain/filter set. Read-only.",
    {
      params: {
        type: "array",
        items: { type: "object", additionalProperties: true },
        minItems: 1,
      },
    },
    ["params"],
  ),
  tool(
    "gmgn_wallet_activity",
    "Get public wallet activity from GMGN. Read-only.",
    {
      chain,
      wallet_address: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 100 },
      cursor: { type: ["string", "number"] },
    },
    ["chain", "wallet_address"],
  ),
  tool(
    "gmgn_wallet_stats",
    "Get GMGN statistics for one or more public wallets over a period. Read-only.",
    {
      chain,
      wallet_addresses: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 100,
      },
      period: { type: "string", description: "GMGN period such as 7d." },
    },
    ["chain", "wallet_addresses"],
  ),
  tool(
    "gmgn_wallet_token_balance",
    "Get a public wallet's balance for one token from GMGN. Read-only.",
    {
      chain,
      wallet_address: { type: "string" },
      token_address: { type: "string" },
    },
    ["chain", "wallet_address", "token_address"],
  ),
  tool("gmgn_kol", "Get GMGN's public KOL wallet list. Read-only.", {
    chain,
    limit: { type: "number", minimum: 1, maximum: 100 },
  }),
  tool(
    "gmgn_smart_money",
    "Get GMGN's public smart-money wallet list. Read-only.",
    { chain, limit: { type: "number", minimum: 1, maximum: 100 } },
  ),
  tool(
    "gmgn_created_tokens",
    "Get tokens created by a public wallet, useful for deployer history research. Read-only.",
    {
      chain,
      wallet_address: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 100 },
      cursor: { type: ["string", "number"] },
    },
    ["chain", "wallet_address"],
  ),
  tool(
    "gmgn_gas_price",
    "Get GMGN gas/priority-fee tiers and estimated confirmation times. Read-only.",
    { chain },
    ["chain"],
  ),
  tool(
    "gmgn_quote",
    "Get a read-only GMGN swap quote. This client cannot submit the swap and never uses GMGN private-key auth.",
    {
      chain,
      from_address: { type: "string" },
      input_token: { type: "string" },
      output_token: { type: "string" },
      input_amount: { type: "string" },
      slippage: { type: "number", minimum: 0, maximum: 100 },
    },
    [
      "chain",
      "from_address",
      "input_token",
      "output_token",
      "input_amount",
      "slippage",
    ],
  ),
] as const;

export type GmgnAgentToolName =
  (typeof gmgnAgentTools)[number]["function"]["name"];
export const GMGN_AGENT_TOOL_NAMES = new Set(
  gmgnAgentTools.map((tool) => tool.function.name),
);
