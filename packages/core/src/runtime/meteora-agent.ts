import type { Commitment } from "@solana/web3.js";
import type { WalletRef } from "../core/refs.ts";
import { MeteoraDlmmService } from "../venues/meteora/dlmm.ts";
import type {
  MeteoraExecutionOptions,
  MeteoraPreparedTransactions,
  MeteoraStrategy,
} from "../venues/meteora/types.ts";
import {
  METEORA_AGENT_TOOL_NAMES,
  meteoraAgentTools,
  type MeteoraAgentToolName,
} from "./meteora-tools.ts";

export type MeteoraAgentActionRecord = {
  tool: string;
  executed: boolean;
  at: number;
  pool?: string;
  position?: string;
  signatures?: string[];
};

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

function bool(
  args: JsonArgs,
  key: string,
  fallback?: boolean,
): boolean | undefined {
  const value = args[key];
  if (value == null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
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

function amount(args: JsonArgs, key: string): number | string | undefined {
  const value = args[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error(`${key} must be a number or decimal string`);
  return value;
}

function strategy(args: JsonArgs): MeteoraStrategy | undefined {
  const value = str(args, "strategy");
  if (value == null) return undefined;
  if (value !== "spot" && value !== "bid_ask" && value !== "curve")
    throw new Error("strategy must be spot, bid_ask, or curve");
  return value;
}

function execution(args: JsonArgs): {
  execute: boolean;
  options: MeteoraExecutionOptions;
} {
  const execute = bool(args, "execute", false) === true;
  const live = bool(args, "live", false) === true;
  if (execute && !live) {
    throw new Error(
      "Meteora write execution requires both execute=true and live=true. Omit execute for a prepared transaction summary.",
    );
  }
  const commitment = str(args, "commitment") as Commitment | undefined;
  return {
    execute,
    options: {
      live,
      simulate: bool(args, "simulate", true),
      skipPreflight: bool(args, "skip_preflight", false),
      commitment,
      maxRetries: num(args, "max_retries"),
    },
  };
}

function preparedSummary(prepared: MeteoraPreparedTransactions) {
  return {
    prepared: true,
    executable: true,
    kind: prepared.kind,
    pool: prepared.pool,
    position: prepared.position ?? null,
    transactionCount: prepared.transactions.length,
    extraSignerCount: prepared.extraSigners.length,
    metadata: prepared.metadata ?? null,
    note:
      prepared.kind === "open-position"
        ? "The prepared position key is ephemeral. Rebuilding before execution may produce a different position address."
        : undefined,
  };
}

export class MeteoraAgentFacade {
  readonly tools = meteoraAgentTools;

  constructor(
    private readonly service: MeteoraDlmmService,
    readonly wallet: WalletRef,
    private readonly onAction?: (record: MeteoraAgentActionRecord) => void,
  ) {}

  private walletAddress(args: JsonArgs): string {
    return (
      str(args, "wallet_address") ??
      this.service.resolveWalletAddress(this.wallet)
    );
  }

  async call(
    toolName: MeteoraAgentToolName | string,
    input: unknown = {},
  ): Promise<unknown> {
    if (!METEORA_AGENT_TOOL_NAMES.has(toolName))
      throw new Error(`Unknown Meteora agent tool: ${toolName}`);
    const args =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as JsonArgs)
        : {};

    switch (toolName) {
      case "meteora_discover_pools":
        return await this.service.discoverPools({
          page: num(args, "page"),
          pageSize: num(args, "page_size"),
          timeframe: str(args, "timeframe") as any,
          category: str(args, "category") as any,
          sortBy: str(args, "sort_by"),
          filterBy: str(args, "filter_by"),
        });
      case "meteora_list_pools":
        return await this.service.listPools({
          page: num(args, "page"),
          pageSize: num(args, "page_size"),
          query: str(args, "query"),
          sortBy: str(args, "sort_by"),
          filterBy: str(args, "filter_by"),
          volumeTw: str(args, "volume_tw"),
          feeTvlRatioTw: str(args, "fee_tvl_ratio_tw"),
        });
      case "meteora_search_pools":
        return await this.service.searchPools(
          str(args, "query", true)!,
          num(args, "limit") ?? 10,
        );
      case "meteora_get_onchain_pool_state":
        return await this.service.getPoolState(
          str(args, "pool_address", true)!,
          bool(args, "refresh", true) ?? true,
        );
      case "meteora_get_indexed_pool":
        return await this.service.getIndexedPool(
          str(args, "pool_address", true)!,
        );
      case "meteora_get_discovery_pool_detail":
        return await this.service.getPoolDetail(
          str(args, "pool_address", true)!,
          (str(args, "timeframe") ?? "5m") as any,
        );
      case "meteora_get_pool_detail": {
        const pool = str(args, "pool_address", true)!;
        const timeframe = (str(args, "timeframe") ?? "5m") as any;
        const refresh = bool(args, "refresh", true) ?? true;
        const [onChain, indexed, discovery] = await Promise.all([
          this.service.getPoolState(pool, refresh),
          this.service.getIndexedPool(pool).catch(() => null),
          this.service.getPoolDetail(pool, timeframe).catch(() => null),
        ]);
        return { pool, onChain, indexed, discovery };
      }
      case "meteora_get_active_bin":
        return await this.service.getActiveBin(
          str(args, "pool_address", true)!,
          bool(args, "refresh", true) ?? true,
        );
      case "meteora_get_bins_around_active":
        return await this.service.getBinsAroundActiveBin(
          str(args, "pool_address", true)!,
          Math.trunc(num(args, "left") ?? 20),
          Math.trunc(num(args, "right") ?? 20),
        );
      case "meteora_get_bins_between":
        return await this.service.getBinsBetween(
          str(args, "pool_address", true)!,
          Math.trunc(num(args, "lower_bin_id")!),
          Math.trunc(num(args, "upper_bin_id")!),
        );
      case "meteora_get_bins_by_price":
        return await this.service.getBinsByPrice(
          str(args, "pool_address", true)!,
          num(args, "min_price")!,
          num(args, "max_price")!,
        );
      case "meteora_get_bin_id_from_price":
        return await this.service.getBinIdFromPrice(
          str(args, "pool_address", true)!,
          num(args, "price")!,
          bool(args, "round_down", true) ?? true,
        );
      case "meteora_get_bin_id_from_price_per_lamport":
        return await this.service.getBinIdFromPricePerLamport(
          str(args, "pool_address", true)!,
          num(args, "price_per_lamport")!,
          bool(args, "round_down", true) ?? true,
        );
      case "meteora_get_pool_ohlcv":
        return await this.service.getPoolOhlcv(
          str(args, "pool_address", true)!,
          {
            timeframe: (str(args, "timeframe") ?? "24h") as any,
            startTime: num(args, "start_time"),
            endTime: num(args, "end_time"),
          },
        );
      case "meteora_get_pool_volume_history":
        return await this.service.getPoolVolumeHistory(
          str(args, "pool_address", true)!,
          {
            timeframe: (str(args, "timeframe") ?? "24h") as any,
            startTime: num(args, "start_time"),
            endTime: num(args, "end_time"),
          },
        );
      case "meteora_list_pool_groups":
        return await this.service.listPoolGroups({
          page: num(args, "page"),
          pageSize: num(args, "page_size"),
          query: str(args, "query"),
          sortBy: str(args, "sort_by"),
          filterBy: str(args, "filter_by"),
          volumeTw: str(args, "volume_tw"),
          feeTvlRatioTw: str(args, "fee_tvl_ratio_tw"),
        });
      case "meteora_get_pool_group":
        return await this.service.getPoolGroup(
          str(args, "lexical_order_mints", true)!,
          {
            page: num(args, "page"),
            pageSize: num(args, "page_size"),
            query: str(args, "query"),
            sortBy: str(args, "sort_by"),
            filterBy: str(args, "filter_by"),
          },
        );
      case "meteora_get_portfolio":
        return await this.service.getPortfolio({
          user: this.walletAddress(args),
          page: num(args, "page"),
          pageSize: num(args, "page_size"),
          daysBack: num(args, "days_back"),
        });
      case "meteora_get_open_portfolio":
        return await this.service.getOpenPortfolio({
          user: this.walletAddress(args),
          page: num(args, "page"),
          pageSize: num(args, "page_size"),
          sortDirection: str(args, "sort_direction") as any,
          sortBy: str(args, "sort_by") as any,
        });
      case "meteora_get_portfolio_total":
        return await this.service.getPortfolioTotal(this.walletAddress(args));
      case "meteora_get_position_history":
        return await this.service.getPositionHistory(
          str(args, "position_address", true)!,
          {
            eventType: str(args, "event_type") as any,
            orderDirection: str(args, "order_direction") as any,
            page: num(args, "page"),
            pageSize: num(args, "page_size"),
          },
        );
      case "meteora_get_protocol_metrics":
        return await this.service.getProtocolMetrics();
      case "meteora_get_daily_protocol_fees":
        return await this.service.getDailyProtocolFees();
      case "meteora_get_daily_trading_fees":
        return await this.service.getDailyTradingFees();
      case "meteora_get_daily_volume":
        return await this.service.getDailyVolume();
      case "meteora_get_open_limit_order_pools":
        return await this.service.getOpenLimitOrderPools(
          this.walletAddress(args),
          {
            page: num(args, "page"),
            pageSize: num(args, "page_size"),
          },
        );
      case "meteora_get_open_limit_orders":
        return await this.service.getOpenLimitOrders(
          this.walletAddress(args),
          str(args, "pool_address", true)!,
          { page: num(args, "page"), pageSize: num(args, "page_size") },
        );
      case "meteora_get_closed_limit_order_pools":
        return await this.service.getClosedLimitOrderPools(
          this.walletAddress(args),
          {
            page: num(args, "page"),
            pageSize: num(args, "page_size"),
          },
        );
      case "meteora_get_closed_limit_orders":
        return await this.service.getClosedLimitOrders(
          this.walletAddress(args),
          str(args, "pool_address", true)!,
          { page: num(args, "page"), pageSize: num(args, "page_size") },
        );
      case "meteora_get_limit_order_summary":
        return await this.service.getLimitOrderSummary(
          this.walletAddress(args),
        );
      case "meteora_get_limit_order_bonus_claimed":
        return await this.service.getLimitOrderBonusClaimed(
          this.walletAddress(args),
          str(args, "pool_address", true)!,
        );
      case "meteora_get_wallet_pool_total_claims":
        return await this.service.getWalletPoolTotalClaims(
          this.walletAddress(args),
          str(args, "pool_address", true)!,
        );
      case "meteora_get_my_positions":
        return await this.service.getMyPositions(this.wallet);
      case "meteora_get_wallet_positions":
        return await this.service.getWalletPositions(
          str(args, "wallet_address", true)!,
        );
      case "meteora_get_wallet_positions_for_token":
        return await this.service.getWalletPositionsForToken(
          str(args, "wallet_address", true)!,
          str(args, "token_mint", true)!,
        );
      case "meteora_get_pool_positions": {
        const pool = str(args, "pool_address", true)!;
        const wallet = str(args, "wallet_address");
        if (wallet) return await this.service.getPoolPositions(pool, wallet);
        const mine = await this.service.getMyPositions(this.wallet);
        return mine.positions.filter((position) => position.pool === pool);
      }
      case "meteora_find_pool_for_position": {
        const explicitWallet = str(args, "wallet_address");
        const wallet = explicitWallet
          ? explicitWallet
          : (await this.service.getMyPositions(this.wallet)).wallet;
        return await this.service.findPoolForPosition(
          str(args, "position_address", true)!,
          wallet,
        );
      }
      case "meteora_get_position":
        return await this.service.getPosition(
          str(args, "pool_address", true)!,
          str(args, "position_address", true)!,
        );
      case "meteora_get_position_pnl": {
        const mine = str(args, "wallet_address")
          ? null
          : await this.service.getMyPositions(this.wallet);
        return await this.service.getPositionPnl({
          pool: str(args, "pool_address", true)!,
          wallet: str(args, "wallet_address") ?? mine!.wallet,
          position: str(args, "position_address"),
          status:
            (str(args, "status") as "open" | "closed" | undefined) ?? "open",
        });
      }
      case "meteora_quote_swap_exact_in":
        return await this.service.quoteSwapExactIn({
          pool: str(args, "pool_address", true)!,
          swapForY: bool(args, "swap_for_y")!,
          amountIn: amount(args, "amount_in"),
          amountInRaw: amount(args, "amount_in_raw"),
          slippageBps: num(args, "slippage_bps"),
          allowPartialFill: bool(args, "allow_partial_fill"),
          maxExtraBinArrays: num(args, "max_extra_bin_arrays"),
        });
      case "meteora_quote_swap_exact_out":
        return await this.service.quoteSwapExactOut({
          pool: str(args, "pool_address", true)!,
          swapForY: bool(args, "swap_for_y")!,
          amountOut: amount(args, "amount_out"),
          amountOutRaw: amount(args, "amount_out_raw"),
          slippageBps: num(args, "slippage_bps"),
          maxExtraBinArrays: num(args, "max_extra_bin_arrays"),
        });
      default:
        return await this.callWrite(toolName, args);
    }
  }

  private async callWrite(toolName: string, args: JsonArgs): Promise<unknown> {
    const exec = execution(args);
    const pool = str(args, "pool_address", true)!;
    let prepared: MeteoraPreparedTransactions;

    switch (toolName) {
      case "meteora_open_position":
        prepared = await this.service.buildOpenPosition({
          wallet: this.wallet,
          pool,
          strategy: strategy(args),
          amountX: amount(args, "amount_x"),
          amountY: amount(args, "amount_y"),
          amountXRaw: amount(args, "amount_x_raw"),
          amountYRaw: amount(args, "amount_y_raw"),
          minBinId: num(args, "min_bin_id"),
          maxBinId: num(args, "max_bin_id"),
          binsBelow: num(args, "bins_below"),
          binsAbove: num(args, "bins_above"),
          downsidePct: num(args, "downside_pct"),
          upsidePct: num(args, "upside_pct"),
          slippageBps: num(args, "slippage_bps"),
        });
        break;
      case "meteora_add_liquidity":
        prepared = await this.service.buildAddLiquidity({
          wallet: this.wallet,
          pool,
          position: str(args, "position_address", true)!,
          strategy: strategy(args),
          amountX: amount(args, "amount_x"),
          amountY: amount(args, "amount_y"),
          amountXRaw: amount(args, "amount_x_raw"),
          amountYRaw: amount(args, "amount_y_raw"),
          minBinId: num(args, "min_bin_id"),
          maxBinId: num(args, "max_bin_id"),
          slippageBps: num(args, "slippage_bps"),
        });
        break;
      case "meteora_remove_liquidity":
        prepared = await this.service.buildRemoveLiquidity({
          wallet: this.wallet,
          pool,
          position: str(args, "position_address", true)!,
          bps: num(args, "bps"),
          fromBinId: num(args, "from_bin_id"),
          toBinId: num(args, "to_bin_id"),
          claimAndClose: bool(args, "claim_and_close"),
          skipUnwrapSol: bool(args, "skip_unwrap_sol"),
        });
        break;
      case "meteora_close_position":
        prepared = await this.service.buildClosePosition({
          wallet: this.wallet,
          pool,
          position: str(args, "position_address", true)!,
        });
        break;
      case "meteora_claim_fees":
        prepared = await this.service.buildClaimFees({
          wallet: this.wallet,
          pool,
          position: str(args, "position_address", true)!,
        });
        break;
      case "meteora_claim_lm_rewards":
        prepared = await this.service.buildClaimRewards({
          wallet: this.wallet,
          pool,
          position: str(args, "position_address", true)!,
        });
        break;
      case "meteora_claim_position_rewards":
        prepared = await this.service.buildClaimPositionRewards({
          wallet: this.wallet,
          pool,
          position: str(args, "position_address", true)!,
        });
        break;
      case "meteora_claim_all_fees":
        prepared = await this.service.buildClaimAllFees({
          wallet: this.wallet,
          pool,
        });
        break;
      case "meteora_claim_all_lm_rewards":
        prepared = await this.service.buildClaimAllLmRewards({
          wallet: this.wallet,
          pool,
        });
        break;
      case "meteora_claim_all_rewards":
        prepared = await this.service.buildClaimAllRewards({
          wallet: this.wallet,
          pool,
        });
        break;
      case "meteora_swap_exact_in":
        prepared = await this.service.buildSwapExactIn({
          wallet: this.wallet,
          pool,
          swapForY: bool(args, "swap_for_y")!,
          amountIn: amount(args, "amount_in"),
          amountInRaw: amount(args, "amount_in_raw"),
          slippageBps: num(args, "slippage_bps"),
          allowPartialFill: bool(args, "allow_partial_fill"),
          maxExtraBinArrays: num(args, "max_extra_bin_arrays"),
        });
        break;
      case "meteora_swap_exact_out":
        prepared = await this.service.buildSwapExactOut({
          wallet: this.wallet,
          pool,
          swapForY: bool(args, "swap_for_y")!,
          amountOut: amount(args, "amount_out"),
          amountOutRaw: amount(args, "amount_out_raw"),
          slippageBps: num(args, "slippage_bps"),
          maxExtraBinArrays: num(args, "max_extra_bin_arrays"),
        });
        break;
      default:
        throw new Error(`Unknown Meteora write tool: ${toolName}`);
    }

    if (!exec.execute) return preparedSummary(prepared);
    const result = await this.service.executePrepared(prepared, exec.options);
    this.onAction?.({
      tool: toolName,
      executed: true,
      at: Date.now(),
      pool: result.pool,
      position: result.position,
      signatures: result.signatures,
    });
    return result;
  }
}
