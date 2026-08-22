import {
  GmgnReadService,
  type GmgnChain,
  type GmgnQuery,
} from "../data/gmgn.ts";
import {
  GMGN_AGENT_TOOL_NAMES,
  gmgnAgentTools,
  type GmgnAgentToolName,
} from "./gmgn-tools.ts";

type JsonArgs = Record<string, unknown>;

function str(
  args: JsonArgs,
  key: string,
  required = false,
): string | undefined {
  const value = args[key];
  if (value == null || value === "") {
    if (required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function num(args: JsonArgs, key: string): number | undefined {
  const value = args[key];
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    throw new Error(`${key} must be a finite number`);
  return parsed;
}

function strings(args: JsonArgs, key: string): string[] | undefined {
  const value = args[key];
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new Error(`${key} must be an array of strings`);
  return value as string[];
}

function objects(args: JsonArgs, key: string): unknown[] {
  const value = args[key];
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  return value;
}

function object(args: JsonArgs, key: string): Record<string, unknown> {
  const value = args[key];
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error(`${key} must be an object`);
  return value as Record<string, unknown>;
}

function chain(args: JsonArgs): GmgnChain {
  const value = str(args, "chain", true)! as GmgnChain;
  if (
    !["sol", "bsc", "base", "eth", "robinhood", "arc", "stable"].includes(value)
  )
    throw new Error(`Unsupported GMGN chain: ${value}`);
  return value;
}

function compactQuery(input: Record<string, unknown>): GmgnQuery {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as GmgnQuery;
}

/** Provider-neutral function-tool facade for GMGN's read-only OpenAPI surface. */
export class GmgnAgentFacade {
  readonly tools = gmgnAgentTools;

  constructor(private readonly service: GmgnReadService) {}

  async call(
    toolName: GmgnAgentToolName | string,
    input: unknown = {},
  ): Promise<unknown> {
    if (!GMGN_AGENT_TOOL_NAMES.has(toolName))
      throw new Error(`Unknown GMGN agent tool: ${toolName}`);
    const args =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as JsonArgs)
        : {};

    switch (toolName) {
      case "gmgn_token_info":
        return await this.service.tokenInfo(
          chain(args),
          str(args, "address", true)!,
        );
      case "gmgn_token_security":
        return await this.service.tokenSecurity(
          chain(args),
          str(args, "address", true)!,
        );
      case "gmgn_token_pool":
        return await this.service.tokenPoolInfo(
          chain(args),
          str(args, "address", true)!,
        );
      case "gmgn_token_holders":
        return await this.service.tokenTopHolders(
          chain(args),
          str(args, "address", true)!,
          compactQuery({
            limit: num(args, "limit"),
            tag: str(args, "tag"),
            order_by: str(args, "order_by"),
            direction: str(args, "direction"),
          }),
        );
      case "gmgn_token_traders":
        return await this.service.tokenTopTraders(
          chain(args),
          str(args, "address", true)!,
          compactQuery({
            limit: num(args, "limit"),
            tag: str(args, "tag"),
            order_by: str(args, "order_by"),
            direction: str(args, "direction"),
          }),
        );
      case "gmgn_token_kline":
        return await this.service.tokenKline({
          chain: chain(args),
          address: str(args, "address", true)!,
          resolution: str(args, "resolution", true)! as any,
          from: num(args, "from"),
          to: num(args, "to"),
        });
      case "gmgn_market_trending":
        return await this.service.trending(
          chain(args),
          str(args, "interval", true)! as any,
          compactQuery({
            limit: num(args, "limit"),
            order_by: str(args, "order_by"),
            direction: str(args, "direction"),
            filter: strings(args, "filter"),
            platform: strings(args, "platform"),
            min_volume: num(args, "min_volume"),
            max_volume: num(args, "max_volume"),
            min_liquidity: num(args, "min_liquidity"),
            max_liquidity: num(args, "max_liquidity"),
            min_marketcap: num(args, "min_marketcap"),
            max_marketcap: num(args, "max_marketcap"),
            min_holder_count: num(args, "min_holder_count"),
            max_holder_count: num(args, "max_holder_count"),
            min_smart_degen_count: num(args, "min_smart_degen_count"),
            max_smart_degen_count: num(args, "max_smart_degen_count"),
            min_renowned_count: num(args, "min_renowned_count"),
            max_renowned_count: num(args, "max_renowned_count"),
            min_gas_fee: num(args, "min_gas_fee"),
            max_gas_fee: num(args, "max_gas_fee"),
          }),
        );
      case "gmgn_market_trenches":
        return await this.service.trenches(chain(args), object(args, "body"));
      case "gmgn_token_signals":
        return await this.service.tokenSignals(
          chain(args),
          objects(args, "groups"),
        );
      case "gmgn_hot_searches":
        return await this.service.hotSearches(objects(args, "params"));
      case "gmgn_wallet_activity":
        return await this.service.walletActivity(
          chain(args),
          str(args, "wallet_address", true)!,
          compactQuery({
            limit: num(args, "limit"),
            cursor: args.cursor as any,
          }),
        );
      case "gmgn_wallet_stats": {
        const wallets = strings(args, "wallet_addresses");
        if (!wallets?.length) throw new Error("wallet_addresses is required");
        return await this.service.walletStats(
          chain(args),
          wallets,
          str(args, "period") ?? "7d",
        );
      }
      case "gmgn_wallet_token_balance":
        return await this.service.walletTokenBalance(
          chain(args),
          str(args, "wallet_address", true)!,
          str(args, "token_address", true)!,
        );
      case "gmgn_kol":
        return await this.service.kol(
          str(args, "chain") as GmgnChain | undefined,
          num(args, "limit"),
        );
      case "gmgn_smart_money":
        return await this.service.smartMoney(
          str(args, "chain") as GmgnChain | undefined,
          num(args, "limit"),
        );
      case "gmgn_created_tokens":
        return await this.service.createdTokens(
          chain(args),
          str(args, "wallet_address", true)!,
          compactQuery({
            limit: num(args, "limit"),
            cursor: args.cursor as any,
          }),
        );
      case "gmgn_gas_price":
        return await this.service.gasPrice(chain(args));
      case "gmgn_quote":
        return await this.service.quote({
          chain: chain(args),
          fromAddress: str(args, "from_address", true)!,
          inputToken: str(args, "input_token", true)!,
          outputToken: str(args, "output_token", true)!,
          inputAmount: str(args, "input_amount", true)!,
          slippage: num(args, "slippage")!,
        });
      default:
        throw new Error(`Unknown GMGN agent tool: ${toolName}`);
    }
  }
}
