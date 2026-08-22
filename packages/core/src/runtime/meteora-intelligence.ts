import { PublicKey } from "@solana/web3.js";
import type { WalletRef } from "../core/refs.ts";
import type { AgentRow } from "../db/schema.ts";
import type { AgentRepo } from "../db/agent-repo.ts";
import type { MeteoraDlmmService } from "../venues/meteora/dlmm.ts";
import type { MeteoraTimeframe } from "../venues/meteora/types.ts";
import { MeteoraAutopilot } from "./meteora-autopilot.ts";
import {
  METEORA_INTELLIGENCE_TOOL_NAMES,
  meteoraIntelligenceTools,
  type MeteoraIntelligenceToolName,
} from "./meteora-intelligence-tools.ts";
import {
  OpenAiCompatibleMeteoraDecisionModel,
  type MeteoraDecisionModel,
} from "./meteora-decision-model.ts";
import type {
  MeteoraCandidateIntelligence,
  MeteoraHolder,
  MeteoraHolderReport,
  MeteoraIndicatorConfirmation,
  MeteoraIndicatorPreset,
  MeteoraIndicatorSignal,
  MeteoraIntelligenceConfig,
  MeteoraIntelligenceDecisionInput,
  MeteoraIntelligenceDecisionRecord,
  MeteoraIntelligenceState,
  MeteoraModelCycleDecision,
  MeteoraNarrative,
  MeteoraSmartWallet,
  MeteoraSmartWalletCategory,
  MeteoraSmartWalletExposure,
  MeteoraSmartWalletType,
  MeteoraStrategyDefinition,
  MeteoraTokenInfo,
  MeteoraTopLperStudy,
} from "./meteora-intelligence-types.ts";

const DEFAULT_JUPITER_DATA_API = "https://datapi.jup.ag/v1";
const DEFAULT_AGENT_MERIDIAN_API = "https://api.agentmeridian.xyz/api";

type Dict = Record<string, unknown>;

type RunOptions = {
  execute?: boolean;
  live?: boolean;
  simulate?: boolean;
  skipPreflight?: boolean;
  limit?: number;
};

type Candle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const TIMEFRAME_SECONDS: Record<MeteoraTimeframe, number> = {
  "5m": 5 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
  "2h": 2 * 60 * 60,
  "4h": 4 * 60 * 60,
  "12h": 12 * 60 * 60,
  "24h": 24 * 60 * 60,
};

function isObject(value: unknown): value is Dict {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const result = String(value).trim();
  return result || null;
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function asAddress(value: string): string {
  return new PublicKey(value).toBase58();
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envText(name: string, fallback: string | null = null): string | null {
  return text(process.env[name]) ?? fallback;
}

function defaultConfig(): MeteoraIntelligenceConfig {
  return {
    token: {
      enabled: true,
      dataApiBase:
        envText("SOLARD_JUPITER_DATA_API_URL", DEFAULT_JUPITER_DATA_API) ??
        DEFAULT_JUPITER_DATA_API,
      timeoutMs: envNumber("SOLARD_INTELLIGENCE_HTTP_TIMEOUT_MS", 10_000),
      requireMintDisabled: true,
      requireFreezeDisabled: true,
      maxTop10HolderPct: 35,
      maxBotHolderPct: 20,
      minGlobalFeesSol: null,
    },
    indicators: {
      enabled: true,
      entryPreset: "supertrend_or_rsi",
      exitPreset: "supertrend_or_rsi",
      timeframes: ["5m", "30m"],
      requireAllIntervals: false,
      rsiLength: 14,
      rsiOversold: 30,
      rsiOverbought: 75,
      bollingerLength: 20,
      bollingerStdDev: 2,
      supertrendAtrLength: 10,
      supertrendMultiplier: 3,
      candleCount: 220,
    },
    topLpers: {
      enabled: false,
      baseUrl:
        envText("SOLARD_AGENT_MERIDIAN_URL", DEFAULT_AGENT_MERIDIAN_API) ??
        DEFAULT_AGENT_MERIDIAN_API,
      publicApiKey: envText("SOLARD_AGENT_MERIDIAN_API_KEY"),
      timeoutMs: envNumber("SOLARD_INTELLIGENCE_HTTP_TIMEOUT_MS", 10_000),
      limit: 4,
    },
    smartWallets: {
      enabled: true,
      scoreBonus: 6,
    },
    model: {
      enabled: false,
      baseUrl:
        envText("SOLARD_AGENT_LLM_BASE_URL", "https://api.openai.com/v1") ??
        "https://api.openai.com/v1",
      apiKey: envText("SOLARD_AGENT_LLM_API_KEY"),
      model: envText("SOLARD_AGENT_LLM_MODEL"),
      timeoutMs: envNumber("SOLARD_AGENT_LLM_TIMEOUT_MS", 30_000),
      temperature: 0.1,
    },
    decision: {
      candidateLimit: 3,
      enrichConcurrency: 3,
      requireTokenInfo: true,
      requireHolderReport: true,
      requireIndicatorConfirmation: false,
      requireNarrative: false,
      allowModelCandidateSelection: true,
    },
  };
}

function mergeConfig(
  base: MeteoraIntelligenceConfig,
  patch: unknown,
): MeteoraIntelligenceConfig {
  const source = isObject(patch) ? patch : {};
  const result: MeteoraIntelligenceConfig = {
    token: {
      ...base.token,
      ...(isObject(source.token) ? source.token : {}),
    } as MeteoraIntelligenceConfig["token"],
    indicators: {
      ...base.indicators,
      ...(isObject(source.indicators) ? source.indicators : {}),
    } as MeteoraIntelligenceConfig["indicators"],
    topLpers: {
      ...base.topLpers,
      ...(isObject(source.topLpers) ? source.topLpers : {}),
    } as MeteoraIntelligenceConfig["topLpers"],
    smartWallets: {
      ...base.smartWallets,
      ...(isObject(source.smartWallets) ? source.smartWallets : {}),
    } as MeteoraIntelligenceConfig["smartWallets"],
    model: {
      ...base.model,
      ...(isObject(source.model) ? source.model : {}),
    } as MeteoraIntelligenceConfig["model"],
    decision: {
      ...base.decision,
      ...(isObject(source.decision) ? source.decision : {}),
    } as MeteoraIntelligenceConfig["decision"],
  };
  // Credentials are environment-only. Never persist or accept them through
  // agent configuration/tool calls, which are visible through the web API.
  result.topLpers.publicApiKey = envText("SOLARD_AGENT_MERIDIAN_API_KEY");
  result.model.apiKey = envText("SOLARD_AGENT_LLM_API_KEY");
  validateConfig(result);
  return result;
}

function validateConfig(config: MeteoraIntelligenceConfig): void {
  if (!text(config.token.dataApiBase))
    throw new Error("token.dataApiBase is required");
  if (!(config.token.timeoutMs >= 1_000))
    throw new Error("token.timeoutMs must be >= 1000");
  for (const value of [
    config.token.maxTop10HolderPct,
    config.token.maxBotHolderPct,
  ]) {
    if (value != null && (value < 0 || value > 100))
      throw new Error("holder percentage limits must be between 0 and 100");
  }
  if (
    config.token.minGlobalFeesSol != null &&
    config.token.minGlobalFeesSol < 0
  )
    throw new Error("token.minGlobalFeesSol must be >= 0");

  const i = config.indicators;
  if (!i.timeframes.length)
    throw new Error("indicators.timeframes must not be empty");
  if (!i.timeframes.every((item) => item in TIMEFRAME_SECONDS))
    throw new Error("indicators.timeframes contains an unsupported timeframe");
  if (!(i.rsiLength >= 2 && i.rsiLength <= 100))
    throw new Error("indicators.rsiLength must be 2..100");
  if (!(i.bollingerLength >= 2 && i.bollingerLength <= 200))
    throw new Error("indicators.bollingerLength must be 2..200");
  if (!(i.supertrendAtrLength >= 2 && i.supertrendAtrLength <= 100))
    throw new Error("indicators.supertrendAtrLength must be 2..100");
  if (!(i.candleCount >= 40 && i.candleCount <= 1000))
    throw new Error("indicators.candleCount must be 40..1000");
  if (!(
    i.rsiOversold >= 0 &&
    i.rsiOversold <= 100 &&
    i.rsiOverbought >= 0 &&
    i.rsiOverbought <= 100
  ))
    throw new Error("RSI thresholds must be 0..100");

  if (!(config.topLpers.limit >= 1 && config.topLpers.limit <= 20))
    throw new Error("topLpers.limit must be 1..20");
  if (!(
    config.smartWallets.scoreBonus >= 0 && config.smartWallets.scoreBonus <= 30
  ))
    throw new Error("smartWallets.scoreBonus must be 0..30");
  if (!(config.model.temperature >= 0 && config.model.temperature <= 2))
    throw new Error("model.temperature must be 0..2");
  if (config.model.enabled && (!config.model.model || !config.model.baseUrl))
    throw new Error("model.enabled requires model.model and model.baseUrl");
  if (!(
    config.decision.candidateLimit >= 1 && config.decision.candidateLimit <= 20
  ))
    throw new Error("decision.candidateLimit must be 1..20");
  if (!(
    config.decision.enrichConcurrency >= 1 &&
    config.decision.enrichConcurrency <= 10
  ))
    throw new Error("decision.enrichConcurrency must be 1..10");
}

function normalizeState(value: unknown): MeteoraIntelligenceState {
  const state = isObject(value) ? value : {};
  return {
    version: 1,
    smartWallets: isObject(state.smartWallets)
      ? (state.smartWallets as Record<string, MeteoraSmartWallet>)
      : {},
    strategies: isObject(state.strategies)
      ? (state.strategies as Record<string, MeteoraStrategyDefinition>)
      : {},
    activeStrategyId: text(state.activeStrategyId),
    decisions: Array.isArray(state.decisions)
      ? (state.decisions.slice(-100) as MeteoraIntelligenceDecisionRecord[])
      : [],
  };
}

async function fetchJson(
  url: string | URL,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { timeoutMs: _ignored, ...request } = options;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(url, {
          ...request,
          signal: controller.signal,
        });
        const bodyText = await response.text();
        let body: unknown = {};
        try {
          body = bodyText ? JSON.parse(bodyText) : {};
        } catch {
          body = { raw: bodyText };
        }
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status} for ${String(url)}`);
          if (
            (response.status === 429 || response.status >= 500) &&
            attempt === 0
          ) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 300));
            continue;
          }
          throw error;
        }
        return body;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === 0 && !controller.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
      }
    }
    throw lastError ?? new Error(`Request failed: ${String(url)}`);
  } finally {
    clearTimeout(timer);
  }
}

function tokenAudit(raw: unknown): MeteoraTokenInfo["audit"] {
  if (!isObject(raw)) return null;
  return {
    mintDisabled: bool(raw.mintAuthorityDisabled),
    freezeDisabled: bool(raw.freezeAuthorityDisabled),
    topHoldersPct: num(raw.topHoldersPercentage),
    botHoldersPct: num(raw.botHoldersPercentage),
    devMigrations: num(raw.devMigrations),
  };
}

function normalizeTokenInfo(raw: unknown): MeteoraTokenInfo | null {
  if (!isObject(raw)) return null;
  const mint = text(raw.id ?? raw.mint ?? raw.address);
  if (!mint) return null;
  const stats = isObject(raw.stats1h) ? raw.stats1h : null;
  return {
    mint,
    name: text(raw.name),
    symbol: text(raw.symbol),
    mcap: num(raw.mcap ?? raw.marketCap),
    priceUsd: num(raw.usdPrice ?? raw.price),
    liquidityUsd: num(raw.liquidity),
    holders: num(raw.holderCount ?? raw.holders),
    organicScore: num(raw.organicScore),
    organicLabel: text(raw.organicScoreLabel),
    launchpad: text(raw.launchpad),
    graduated: bool(raw.graduatedPool),
    globalFeesSol: num(raw.fees),
    audit: tokenAudit(raw.audit),
    stats1h: stats
      ? {
          priceChange: num(stats.priceChange),
          buyVolume: num(stats.buyVolume),
          sellVolume: num(stats.sellVolume),
          organicBuyers: num(stats.numOrganicBuyers),
          netBuyers: num(stats.numNetBuyers),
        }
      : null,
    raw,
  };
}

function holderTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((tag) => (isObject(tag) ? text(tag.name ?? tag.id) : text(tag)))
    .filter((tag): tag is string => !!tag);
}

function normalizeHolder(
  raw: unknown,
  supply: number | null,
): MeteoraHolder | null {
  if (!isObject(raw)) return null;
  const address = text(raw.address ?? raw.wallet);
  if (!address) return null;
  const amountValue = raw.amount;
  const amount =
    typeof amountValue === "string" || typeof amountValue === "number"
      ? amountValue
      : null;
  const tags = holderTags(raw.tags);
  const isPool = tags.some((tag) =>
    /pool|amm|liquidity|raydium|orca|meteora/i.test(tag),
  );
  const amountNumber = num(amountValue);
  const pct =
    supply && amountNumber != null
      ? (amountNumber / supply) * 100
      : num(raw.percentage ?? raw.pct);
  const addressInfo = isObject(raw.addressInfo) ? raw.addressInfo : {};
  const fundingAddress = text(addressInfo.fundingAddress);
  return {
    address,
    amount,
    pct,
    solBalance: num(raw.solBalanceDisplay ?? raw.solBalance),
    tags,
    isPool,
    funding: fundingAddress
      ? {
          address: fundingAddress,
          amount: num(addressInfo.fundingAmount),
          slot: num(addressInfo.fundingSlot),
        }
      : null,
  };
}

function mean(values: number[]): number | null {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function stddev(values: number[]): number | null {
  const avg = mean(values);
  if (avg == null || !values.length) return null;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length,
  );
}

function rsi(closes: number[], length: number): number | null {
  if (closes.length <= length) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= length; i += 1) {
    const delta = closes[i]! - closes[i - 1]!;
    if (delta >= 0) gain += delta;
    else loss -= delta;
  }
  let avgGain = gain / length;
  let avgLoss = loss / length;
  for (let i = length + 1; i < closes.length; i += 1) {
    const delta = closes[i]! - closes[i - 1]!;
    const nextGain = Math.max(0, delta);
    const nextLoss = Math.max(0, -delta);
    avgGain = (avgGain * (length - 1) + nextGain) / length;
    avgLoss = (avgLoss * (length - 1) + nextLoss) / length;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function trueRanges(candles: Candle[]): number[] {
  return candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previous = candles[index - 1]!.close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previous),
      Math.abs(candle.low - previous),
    );
  });
}

function wilderAtr(candles: Candle[], length: number): Array<number | null> {
  const ranges = trueRanges(candles);
  const result: Array<number | null> = Array(candles.length).fill(null);
  if (ranges.length < length) return result;
  let atr =
    ranges.slice(0, length).reduce((sum, value) => sum + value, 0) / length;
  result[length - 1] = atr;
  for (let i = length; i < ranges.length; i += 1) {
    atr = (atr * (length - 1) + ranges[i]!) / length;
    result[i] = atr;
  }
  return result;
}

function supertrend(
  candles: Candle[],
  length: number,
  multiplier: number,
): Array<{
  value: number | null;
  direction: "bullish" | "bearish" | "unknown";
}> {
  const atr = wilderAtr(candles, length);
  const out: Array<{
    value: number | null;
    direction: "bullish" | "bearish" | "unknown";
  }> = [];
  let previousUpper: number | null = null;
  let previousLower: number | null = null;
  let previousDirection: "bullish" | "bearish" = "bullish";

  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i]!;
    const currentAtr = atr[i];
    if (currentAtr == null) {
      out.push({ value: null, direction: "unknown" });
      continue;
    }
    const mid = (candle.high + candle.low) / 2;
    const basicUpper = mid + multiplier * currentAtr;
    const basicLower = mid - multiplier * currentAtr;
    const previousClose = i > 0 ? candles[i - 1]!.close : candle.close;
    const finalUpper =
      previousUpper == null ||
      basicUpper < previousUpper ||
      previousClose > previousUpper
        ? basicUpper
        : previousUpper;
    const finalLower =
      previousLower == null ||
      basicLower > previousLower ||
      previousClose < previousLower
        ? basicLower
        : previousLower;

    let direction = previousDirection;
    if (previousDirection === "bullish" && candle.close < finalLower)
      direction = "bearish";
    else if (previousDirection === "bearish" && candle.close > finalUpper)
      direction = "bullish";
    const value = direction === "bullish" ? finalLower : finalUpper;
    out.push({ value, direction });
    previousUpper = finalUpper;
    previousLower = finalLower;
    previousDirection = direction;
  }
  return out;
}

function signalFromCandles(
  candles: Candle[],
  config: MeteoraIntelligenceConfig["indicators"],
): MeteoraIndicatorSignal {
  const latest = candles.at(-1);
  const previous = candles.at(-2);
  if (!latest) {
    return {
      close: null,
      previousClose: null,
      rsi: null,
      lowerBand: null,
      middleBand: null,
      upperBand: null,
      supertrendValue: null,
      supertrendDirection: "unknown",
      supertrendBreakUp: false,
      supertrendBreakDown: false,
      fib50: null,
      fib618: null,
      fib786: null,
    };
  }
  const closes = candles.map((candle) => candle.close);
  const bbSlice = closes.slice(-config.bollingerLength);
  const middle = mean(bbSlice);
  const deviation = stddev(bbSlice);
  const trend = supertrend(
    candles,
    config.supertrendAtrLength,
    config.supertrendMultiplier,
  );
  const latestTrend = trend.at(-1);
  const previousTrend = trend.at(-2);
  const fibSlice = candles.slice(-Math.min(100, candles.length));
  const high = fibSlice.length
    ? Math.max(...fibSlice.map((candle) => candle.high))
    : null;
  const low = fibSlice.length
    ? Math.min(...fibSlice.map((candle) => candle.low))
    : null;
  const fib = (ratio: number) =>
    high == null || low == null ? null : high - (high - low) * ratio;
  return {
    close: latest.close,
    previousClose: previous?.close ?? null,
    rsi: rsi(closes, config.rsiLength),
    lowerBand:
      middle != null && deviation != null
        ? middle - config.bollingerStdDev * deviation
        : null,
    middleBand: middle,
    upperBand:
      middle != null && deviation != null
        ? middle + config.bollingerStdDev * deviation
        : null,
    supertrendValue: latestTrend?.value ?? null,
    supertrendDirection: latestTrend?.direction ?? "unknown",
    supertrendBreakUp:
      previousTrend?.direction === "bearish" &&
      latestTrend?.direction === "bullish",
    supertrendBreakDown:
      previousTrend?.direction === "bullish" &&
      latestTrend?.direction === "bearish",
    fib50: fib(0.5),
    fib618: fib(0.618),
    fib786: fib(0.786),
  };
}

function evaluatePreset(
  side: "entry" | "exit",
  preset: MeteoraIndicatorPreset,
  signal: MeteoraIndicatorSignal,
  config: MeteoraIntelligenceConfig["indicators"],
): { confirmed: boolean; reason: string } {
  const close = signal.close;
  const previousClose = signal.previousClose;
  const isBullish = signal.supertrendDirection === "bullish";
  const isBearish = signal.supertrendDirection === "bearish";
  const crossedUp = (level: number | null) =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose < level &&
    close >= level;
  const crossedDown = (level: number | null) =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose > level &&
    close <= level;

  switch (preset) {
    case "supertrend_break":
      return side === "entry"
        ? {
            confirmed:
              signal.supertrendBreakUp ||
              (isBullish &&
                close != null &&
                signal.supertrendValue != null &&
                close >= signal.supertrendValue),
            reason: signal.supertrendBreakUp
              ? "Supertrend flipped bullish"
              : "price is above bullish Supertrend",
          }
        : {
            confirmed:
              signal.supertrendBreakDown ||
              (isBearish &&
                close != null &&
                signal.supertrendValue != null &&
                close <= signal.supertrendValue),
            reason: signal.supertrendBreakDown
              ? "Supertrend flipped bearish"
              : "price is below bearish Supertrend",
          };
    case "rsi_reversal":
      return side === "entry"
        ? {
            confirmed: signal.rsi != null && signal.rsi <= config.rsiOversold,
            reason: `RSI ${signal.rsi ?? "n/a"} <= ${config.rsiOversold}`,
          }
        : {
            confirmed: signal.rsi != null && signal.rsi >= config.rsiOverbought,
            reason: `RSI ${signal.rsi ?? "n/a"} >= ${config.rsiOverbought}`,
          };
    case "bollinger_reversion":
      return side === "entry"
        ? {
            confirmed:
              close != null &&
              signal.lowerBand != null &&
              close <= signal.lowerBand,
            reason: "price is at/below lower Bollinger band",
          }
        : {
            confirmed:
              close != null &&
              signal.upperBand != null &&
              close >= signal.upperBand,
            reason: "price is at/above upper Bollinger band",
          };
    case "rsi_plus_supertrend":
      return side === "entry"
        ? {
            confirmed:
              signal.rsi != null &&
              signal.rsi <= config.rsiOversold &&
              (signal.supertrendBreakUp || isBullish),
            reason: "RSI oversold with bullish Supertrend context",
          }
        : {
            confirmed:
              signal.rsi != null &&
              signal.rsi >= config.rsiOverbought &&
              (signal.supertrendBreakDown || isBearish),
            reason: "RSI overbought with bearish Supertrend context",
          };
    case "supertrend_or_rsi":
      return side === "entry"
        ? {
            confirmed:
              signal.supertrendBreakUp ||
              (isBullish &&
                close != null &&
                signal.supertrendValue != null &&
                close >= signal.supertrendValue) ||
              (signal.rsi != null && signal.rsi <= config.rsiOversold),
            reason: "bullish Supertrend confirmation or RSI oversold",
          }
        : {
            confirmed:
              signal.supertrendBreakDown ||
              (isBearish &&
                close != null &&
                signal.supertrendValue != null &&
                close <= signal.supertrendValue) ||
              (signal.rsi != null && signal.rsi >= config.rsiOverbought),
            reason: "bearish Supertrend confirmation or RSI overbought",
          };
    case "bb_plus_rsi":
      return side === "entry"
        ? {
            confirmed:
              close != null &&
              signal.lowerBand != null &&
              close <= signal.lowerBand &&
              signal.rsi != null &&
              signal.rsi <= config.rsiOversold,
            reason: "price at/below lower band with RSI oversold",
          }
        : {
            confirmed:
              close != null &&
              signal.upperBand != null &&
              close >= signal.upperBand &&
              signal.rsi != null &&
              signal.rsi >= config.rsiOverbought,
            reason: "price at/above upper band with RSI overbought",
          };
    case "fibo_reclaim":
      return {
        confirmed:
          crossedUp(signal.fib618) ||
          crossedUp(signal.fib50) ||
          crossedUp(signal.fib786),
        reason: "price reclaimed a key Fibonacci level",
      };
    case "fibo_reject":
      return {
        confirmed:
          crossedDown(signal.fib618) ||
          crossedDown(signal.fib50) ||
          crossedDown(signal.fib786),
        reason: "price rejected below a key Fibonacci level",
      };
  }
}

function normalizeCandles(raw: unknown): Candle[] {
  const rows =
    isObject(raw) && Array.isArray(raw.data)
      ? raw.data
      : Array.isArray(raw)
        ? raw
        : [];
  return rows
    .filter(isObject)
    .map((row) => ({
      timestamp: num(row.timestamp) ?? 0,
      open: num(row.open) ?? NaN,
      high: num(row.high) ?? NaN,
      low: num(row.low) ?? NaN,
      close: num(row.close) ?? NaN,
      volume: num(row.volume) ?? 0,
    }))
    .filter(
      (row) =>
        row.timestamp > 0 &&
        [row.open, row.high, row.low, row.close].every(Number.isFinite),
    )
    .sort((a, b) => a.timestamp - b.timestamp);
}

function strategyNumber(
  source: Dict,
  camel: string,
  snake: string,
): number | undefined {
  const value = num(source[camel] ?? source[snake]);
  return value == null ? undefined : value;
}

function strategyBoolean(
  source: Dict,
  camel: string,
  snake: string,
): boolean | undefined {
  const value = bool(source[camel] ?? source[snake]);
  return value == null ? undefined : value;
}

function sanitizeStrategy(
  input: Partial<MeteoraStrategyDefinition> & { id: string; name: string },
): MeteoraStrategyDefinition {
  const now = Date.now();
  const idValue = text(input.id);
  const name = text(input.name);
  if (!idValue || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(idValue))
    throw new Error("strategy id must be 1..64 safe characters");
  if (!name) throw new Error("strategy name is required");
  const lpStrategy = input.lpStrategy === "spot" ? "spot" : "bid_ask";
  const tokenRaw = isObject(input.tokenCriteria) ? input.tokenCriteria : {};
  const entryRaw = isObject(input.entry) ? input.entry : {};
  const rangeRaw = isObject(input.range) ? input.range : {};
  const exitRaw = isObject(input.exit) ? input.exit : {};

  const tokenCriteria: MeteoraStrategyDefinition["tokenCriteria"] = {
    minMcap: strategyNumber(tokenRaw, "minMcap", "min_mcap"),
    maxMcap: strategyNumber(tokenRaw, "maxMcap", "max_mcap"),
    minHolders: strategyNumber(tokenRaw, "minHolders", "min_holders"),
    minOrganic: strategyNumber(tokenRaw, "minOrganic", "min_organic"),
    maxTop10HolderPct: strategyNumber(
      tokenRaw,
      "maxTop10HolderPct",
      "max_top_10_holder_pct",
    ),
    requiresSmartWallet: strategyBoolean(
      tokenRaw,
      "requiresSmartWallet",
      "requires_smart_wallet",
    ),
    requireNarrative: strategyBoolean(
      tokenRaw,
      "requireNarrative",
      "require_narrative",
    ),
    notes: text(tokenRaw.notes) ?? undefined,
  };
  const preset = text(entryRaw.indicatorPreset ?? entryRaw["indicator_preset"]);
  const entry: MeteoraStrategyDefinition["entry"] = {
    indicatorPreset: preset as MeteoraIndicatorPreset | undefined,
    requireIndicator: strategyBoolean(
      entryRaw,
      "requireIndicator",
      "require_indicator",
    ),
    notes: text(entryRaw.notes) ?? undefined,
  };
  if (
    entry.indicatorPreset &&
    ![
      "supertrend_break",
      "rsi_reversal",
      "bollinger_reversion",
      "rsi_plus_supertrend",
      "supertrend_or_rsi",
      "bb_plus_rsi",
      "fibo_reclaim",
      "fibo_reject",
    ].includes(entry.indicatorPreset)
  )
    throw new Error(`Unknown indicator preset ${entry.indicatorPreset}`);

  const binsBelow = strategyNumber(rangeRaw, "binsBelow", "bins_below");
  const binsAbove = strategyNumber(rangeRaw, "binsAbove", "bins_above");
  if (binsBelow != null && (!Number.isInteger(binsBelow) || binsBelow < 0))
    throw new Error("strategy range.binsBelow must be a non-negative integer");
  if (binsAbove != null && (!Number.isInteger(binsAbove) || binsAbove < 0))
    throw new Error("strategy range.binsAbove must be a non-negative integer");
  const range: MeteoraStrategyDefinition["range"] = {
    binsBelow,
    binsAbove,
    downsidePct: strategyNumber(rangeRaw, "downsidePct", "downside_pct"),
    upsidePct: strategyNumber(rangeRaw, "upsidePct", "upside_pct"),
    notes: text(rangeRaw.notes) ?? undefined,
  };
  const exit: MeteoraStrategyDefinition["exit"] = {
    stopLossPct: strategyNumber(exitRaw, "stopLossPct", "stop_loss_pct"),
    takeProfitPct: strategyNumber(exitRaw, "takeProfitPct", "take_profit_pct"),
    notes: text(exitRaw.notes) ?? undefined,
  };

  return {
    id: idValue,
    name,
    author: text(input.author),
    lpStrategy,
    tokenCriteria,
    entry,
    range,
    exit,
    bestFor: text(input.bestFor),
    raw: text(input.raw),
    createdAt: num(input.createdAt) ?? now,
    updatedAt: now,
  };
}

export class MeteoraIntelligence {
  readonly tools = meteoraIntelligenceTools;
  private modelOverride: MeteoraDecisionModel | null = null;

  constructor(
    private readonly service: MeteoraDlmmService,
    private readonly autopilot: MeteoraAutopilot,
    readonly wallet: WalletRef,
    private readonly row: AgentRow,
    private readonly repo: AgentRepo,
  ) {}

  setDecisionModel(model: MeteoraDecisionModel | null): void {
    this.modelOverride = model;
  }

  config(): MeteoraIntelligenceConfig {
    const root = this.repo.config(this.row);
    return mergeConfig(
      defaultConfig(),
      isObject(root.meteoraIntelligence) ? root.meteoraIntelligence : {},
    );
  }

  configure(patch: unknown): MeteoraIntelligenceConfig {
    const next = mergeConfig(this.config(), patch);
    this.repo.mergeConfig(this.row, { meteoraIntelligence: next });
    return next;
  }

  state(): MeteoraIntelligenceState {
    const root = this.repo.state(this.row);
    return normalizeState(root.meteoraIntelligence);
  }

  private saveState(state: MeteoraIntelligenceState): void {
    this.repo.mergeState(this.row, { meteoraIntelligence: state });
  }

  private publicConfig(
    config: MeteoraIntelligenceConfig = this.config(),
  ): Record<string, unknown> {
    return {
      ...config,
      topLpers: {
        ...config.topLpers,
        publicApiKey: undefined,
        apiKeyConfigured: !!config.topLpers.publicApiKey,
      },
      model: {
        ...config.model,
        apiKey: undefined,
        apiKeyConfigured: !!config.model.apiKey,
      },
    };
  }

  async status(): Promise<Record<string, unknown>> {
    const config = this.config();
    const state = this.state();
    return {
      config: this.publicConfig(config),
      smartWallets: Object.keys(state.smartWallets).length,
      strategies: Object.keys(state.strategies).length,
      activeStrategyId: state.activeStrategyId,
      modelReady: !!(
        this.modelOverride ||
        (config.model.enabled && config.model.model && config.model.baseUrl)
      ),
      modelId: this.modelOverride?.id ?? config.model.model,
      decisions: state.decisions.length,
    };
  }

  private jupiterBase(): string {
    return this.config().token.dataApiBase.replace(/\/+$/, "");
  }

  async getTokenInfo(
    queryInput: string,
  ): Promise<{ found: boolean; query: string; results: MeteoraTokenInfo[] }> {
    const query = text(queryInput);
    if (!query) throw new Error("token query is required");
    const config = this.config();
    const url = new URL(`${this.jupiterBase()}/assets/search`);
    url.searchParams.set("query", query);
    const body = await fetchJson(url, { timeoutMs: config.token.timeoutMs });
    const rows = Array.isArray(body) ? body : isObject(body) ? [body] : [];
    const results = rows
      .map(normalizeTokenInfo)
      .filter((item): item is MeteoraTokenInfo => !!item)
      .slice(0, 5);
    return { found: results.length > 0, query, results };
  }

  async getTokenNarrative(mintInput: string): Promise<MeteoraNarrative> {
    const mint = asAddress(mintInput);
    const config = this.config();
    const body = await fetchJson(
      `${this.jupiterBase()}/chaininsight/narrative/${mint}`,
      {
        timeoutMs: config.token.timeoutMs,
      },
    );
    const row = isObject(body) ? body : {};
    return {
      mint,
      narrative: text(row.narrative),
      status: text(row.status),
    };
  }

  private async smartWalletPnl(
    address: string,
    mint: string,
  ): Promise<Record<string, unknown> | null> {
    const config = this.config();
    try {
      const url = new URL(`${this.jupiterBase()}/pnl-positions`);
      url.searchParams.set("address", address);
      url.searchParams.set("assetId", mint);
      const body = await fetchJson(url, { timeoutMs: config.token.timeoutMs });
      if (!isObject(body)) return null;
      const owner = body[address];
      if (
        !isObject(owner) ||
        !Array.isArray(owner.tokenPositions) ||
        !isObject(owner.tokenPositions[0])
      )
        return null;
      return owner.tokenPositions[0] as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async getTokenHolders(
    mintInput: string,
    limit = 20,
  ): Promise<MeteoraHolderReport> {
    const mint = asAddress(mintInput);
    const config = this.config();
    const [holdersBody, tokenSearch] = await Promise.all([
      fetchJson(`${this.jupiterBase()}/holders/${mint}?limit=100`, {
        timeoutMs: config.token.timeoutMs,
      }),
      this.getTokenInfo(mint).catch(() => ({
        found: false,
        query: mint,
        results: [],
      })),
    ]);
    const token =
      tokenSearch.results.find((item) => item.mint === mint) ??
      tokenSearch.results[0] ??
      null;
    const totalSupply =
      token && isObject(token.raw)
        ? num(token.raw.totalSupply ?? token.raw.circSupply)
        : null;
    const holderRows = Array.isArray(holdersBody)
      ? holdersBody
      : isObject(holdersBody) && Array.isArray(holdersBody.holders)
        ? holdersBody.holders
        : isObject(holdersBody) && Array.isArray(holdersBody.data)
          ? holdersBody.data
          : [];
    const holders = holderRows
      .map((row) => normalizeHolder(row, totalSupply))
      .filter((row): row is MeteoraHolder => !!row);
    const shown = holders.slice(0, clamp(Math.trunc(limit), 1, 100));
    const top10RealHoldersPct = holders
      .filter((holder) => !holder.isPool)
      .slice(0, 10)
      .reduce((sum, holder) => sum + (holder.pct ?? 0), 0);

    const state = this.state();
    const smartWallets = Object.values(state.smartWallets);
    const smartWalletsHolding: MeteoraSmartWalletExposure[] = [];
    if (config.smartWallets.enabled && smartWallets.length) {
      const targetedUrl = new URL(`${this.jupiterBase()}/holders/${mint}`);
      targetedUrl.searchParams.set(
        "addresses",
        smartWallets.map((wallet) => wallet.address).join(","),
      );
      try {
        const targeted = await fetchJson(targetedUrl, {
          timeoutMs: config.token.timeoutMs,
        });
        const targetedRows = Array.isArray(targeted)
          ? targeted
          : isObject(targeted) && Array.isArray(targeted.holders)
            ? targeted.holders
            : isObject(targeted) && Array.isArray(targeted.data)
              ? targeted.data
              : [];
        const byAddress = new Map(
          smartWallets.map((wallet) => [wallet.address, wallet]),
        );
        for (const raw of targetedRows) {
          const holder = normalizeHolder(raw, totalSupply);
          if (!holder) continue;
          const wallet = byAddress.get(holder.address);
          if (!wallet) continue;
          smartWalletsHolding.push({
            wallet,
            holderPct: holder.pct,
            tokenPnl: await this.smartWalletPnl(wallet.address, mint),
            lpPositions: 0,
          });
        }
      } catch {
        // Holder intelligence is an enrichment. A targeted smart-wallet lookup is fail-soft.
      }
    }

    return {
      mint,
      totalFetched: holders.length,
      showing: shown.length,
      top10RealHoldersPct,
      holders: shown,
      smartWalletsHolding,
      globalFeesSol: token?.globalFeesSol ?? null,
    };
  }

  addSmartWallet(input: {
    address: string;
    name: string;
    category?: MeteoraSmartWalletCategory;
    type?: MeteoraSmartWalletType;
    note?: string | null;
  }): MeteoraSmartWallet {
    const address = asAddress(input.address);
    const name = text(input.name);
    if (!name) throw new Error("smart wallet name is required");
    const category = input.category ?? "alpha";
    if (!["alpha", "smart", "fast", "multi"].includes(category))
      throw new Error("invalid smart wallet category");
    const type = input.type ?? "lp";
    if (type !== "lp" && type !== "holder")
      throw new Error("invalid smart wallet type");
    const state = this.state();
    const wallet: MeteoraSmartWallet = {
      address,
      name,
      category,
      type,
      addedAt: state.smartWallets[address]?.addedAt ?? Date.now(),
      note: text(input.note),
    };
    state.smartWallets[address] = wallet;
    this.saveState(state);
    return wallet;
  }

  removeSmartWallet(addressInput: string): boolean {
    const address = asAddress(addressInput);
    const state = this.state();
    const existed = !!state.smartWallets[address];
    delete state.smartWallets[address];
    this.saveState(state);
    return existed;
  }

  listSmartWallets(): MeteoraSmartWallet[] {
    return Object.values(this.state().smartWallets).sort(
      (a, b) => a.addedAt - b.addedAt,
    );
  }

  async checkSmartWalletsOnPool(poolInput: string): Promise<{
    pool: string;
    baseMint: string;
    lpWallets: MeteoraSmartWalletExposure[];
    holderWallets: MeteoraSmartWalletExposure[];
    anySignal: boolean;
  }> {
    const pool = asAddress(poolInput);
    const config = this.autopilot.config();
    const poolState = await this.service.getPoolState(pool);
    const baseMint =
      poolState.tokenY.mint === config.screening.quoteMint
        ? poolState.tokenX.mint
        : poolState.tokenX.mint === config.screening.quoteMint
          ? poolState.tokenY.mint
          : poolState.tokenX.mint;
    const wallets = this.listSmartWallets();
    const lpWallets: MeteoraSmartWalletExposure[] = [];
    const holderWallets: MeteoraSmartWalletExposure[] = [];

    for (const wallet of wallets) {
      if (wallet.type === "lp") {
        try {
          const positions = await this.service.getPoolPositions(
            pool,
            wallet.address,
          );
          if (positions.length) {
            lpWallets.push({
              wallet,
              holderPct: null,
              tokenPnl: null,
              lpPositions: positions.length,
            });
          }
        } catch {
          // one external wallet should not fail the whole cross-reference
        }
      }
    }

    if (wallets.some((wallet) => wallet.type === "holder")) {
      try {
        const report = await this.getTokenHolders(baseMint, 1);
        const holderAddresses = new Set(
          wallets
            .filter((wallet) => wallet.type === "holder")
            .map((wallet) => wallet.address),
        );
        for (const exposure of report.smartWalletsHolding) {
          if (holderAddresses.has(exposure.wallet.address))
            holderWallets.push(exposure);
        }
      } catch {
        // fail-soft enrichment
      }
    }

    return {
      pool,
      baseMint,
      lpWallets,
      holderWallets,
      anySignal: lpWallets.length > 0 || holderWallets.length > 0,
    };
  }

  addStrategy(
    input: Partial<MeteoraStrategyDefinition> & { id: string; name: string },
  ): MeteoraStrategyDefinition {
    const state = this.state();
    const existing = state.strategies[input.id];
    const strategy = sanitizeStrategy({ ...existing, ...input });
    state.strategies[strategy.id] = strategy;
    this.saveState(state);
    return strategy;
  }

  listStrategies(): Array<MeteoraStrategyDefinition & { active: boolean }> {
    const state = this.state();
    return Object.values(state.strategies)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((strategy) => ({
        ...strategy,
        active: strategy.id === state.activeStrategyId,
      }));
  }

  getStrategy(strategyId: string): MeteoraStrategyDefinition {
    const idValue = text(strategyId);
    if (!idValue) throw new Error("strategy id is required");
    const strategy = this.state().strategies[idValue];
    if (!strategy) throw new Error(`Unknown Meteora strategy ${idValue}`);
    return strategy;
  }

  setActiveStrategy(
    strategyId: string | null,
  ): MeteoraStrategyDefinition | null {
    const state = this.state();
    const idValue = text(strategyId);
    if (idValue && !state.strategies[idValue])
      throw new Error(`Unknown Meteora strategy ${idValue}`);
    state.activeStrategyId = idValue;
    this.saveState(state);
    return idValue ? state.strategies[idValue]! : null;
  }

  removeStrategy(strategyId: string): boolean {
    const idValue = text(strategyId);
    if (!idValue) throw new Error("strategy id is required");
    const state = this.state();
    const existed = !!state.strategies[idValue];
    delete state.strategies[idValue];
    if (state.activeStrategyId === idValue) state.activeStrategyId = null;
    this.saveState(state);
    return existed;
  }

  private activeStrategy(): MeteoraStrategyDefinition | null {
    const state = this.state();
    return state.activeStrategyId
      ? (state.strategies[state.activeStrategyId] ?? null)
      : null;
  }

  private async fetchCandles(
    pool: string,
    timeframe: MeteoraTimeframe,
  ): Promise<Candle[]> {
    const config = this.config();
    const base = (
      process.env.METEORA_DLMM_DATA_API_URL?.trim() ||
      "https://dlmm.datapi.meteora.ag"
    ).replace(/\/+$/, "");
    const end = Math.floor(Date.now() / 1000);
    const start = Math.max(
      0,
      end - TIMEFRAME_SECONDS[timeframe] * config.indicators.candleCount,
    );
    const url = new URL(`${base}/pools/${asAddress(pool)}/ohlcv`);
    url.searchParams.set("timeframe", timeframe);
    url.searchParams.set("start_time", String(start));
    url.searchParams.set("end_time", String(end));
    return normalizeCandles(
      await fetchJson(url, { timeoutMs: config.token.timeoutMs }),
    );
  }

  async confirmIndicator(input: {
    pool: string;
    side: "entry" | "exit";
    preset?: MeteoraIndicatorPreset | null;
  }): Promise<MeteoraIndicatorConfirmation> {
    const config = this.config();
    const preset =
      input.preset ??
      (input.side === "entry"
        ? config.indicators.entryPreset
        : config.indicators.exitPreset);
    if (!config.indicators.enabled) {
      return {
        enabled: false,
        confirmed: true,
        skipped: true,
        preset,
        side: input.side,
        requireAllIntervals: config.indicators.requireAllIntervals,
        reason: "indicators disabled",
        intervals: [],
      };
    }

    const intervals: MeteoraIndicatorConfirmation["intervals"] = [];
    for (const timeframe of config.indicators.timeframes) {
      try {
        const candles = await this.fetchCandles(input.pool, timeframe);
        if (
          candles.length <
          Math.max(
            config.indicators.bollingerLength,
            config.indicators.rsiLength,
          ) +
            2
        )
          throw new Error(`not enough OHLCV candles (${candles.length})`);
        const signal = signalFromCandles(candles, config.indicators);
        const evaluation = evaluatePreset(
          input.side,
          preset,
          signal,
          config.indicators,
        );
        intervals.push({
          timeframe,
          ok: true,
          confirmed: evaluation.confirmed,
          reason: evaluation.reason,
          signal,
        });
      } catch (error) {
        intervals.push({
          timeframe,
          ok: false,
          confirmed: null,
          reason: error instanceof Error ? error.message : String(error),
          signal: null,
        });
      }
    }
    const successful = intervals.filter((entry) => entry.ok);
    if (!successful.length) {
      return {
        enabled: true,
        confirmed: true,
        skipped: true,
        preset,
        side: input.side,
        requireAllIntervals: config.indicators.requireAllIntervals,
        reason: "OHLCV indicators unavailable; no indicator veto applied",
        intervals,
      };
    }
    const confirmed = config.indicators.requireAllIntervals
      ? successful.every((entry) => entry.confirmed === true)
      : successful.some((entry) => entry.confirmed === true);
    return {
      enabled: true,
      confirmed,
      skipped: false,
      preset,
      side: input.side,
      requireAllIntervals: config.indicators.requireAllIntervals,
      reason: confirmed
        ? `${preset} confirmed on ${successful
            .filter((entry) => entry.confirmed)
            .map((entry) => entry.timeframe)
            .join(", ")}`
        : `${preset} not confirmed on ${successful.map((entry) => entry.timeframe).join(", ")}`,
      intervals,
    };
  }

  private meridianHeaders(): Record<string, string> {
    const config = this.config();
    return config.topLpers.publicApiKey
      ? { "x-api-key": config.topLpers.publicApiKey }
      : {};
  }

  private async meridian(pathname: string): Promise<unknown> {
    const config = this.config();
    const base = config.topLpers.baseUrl.replace(/\/+$/, "");
    return await fetchJson(`${base}${pathname}`, {
      headers: this.meridianHeaders(),
      timeoutMs: config.topLpers.timeoutMs,
    });
  }

  async getTopLpers(
    poolInput: string,
    limit?: number,
  ): Promise<MeteoraTopLperStudy> {
    const pool = asAddress(poolInput);
    const config = this.config();
    if (!config.topLpers.enabled) {
      return {
        available: false,
        pool,
        source: "agent-meridian",
        patterns: {},
        lpers: [],
        error: "top-LPer intelligence disabled",
      };
    }
    try {
      const body = await this.meridian(`/top-lp/${pool}`);
      const row = isObject(body) ? body : {};
      const lpers = Array.isArray(row.topLpers)
        ? row.topLpers.slice(
            0,
            clamp(Math.trunc(limit ?? config.topLpers.limit), 1, 20),
          )
        : [];
      return {
        available: true,
        pool,
        source: "agent-meridian:/top-lp",
        patterns: {},
        lpers: lpers.filter(isObject),
        raw: body,
      };
    } catch (error) {
      return {
        available: false,
        pool,
        source: "agent-meridian:/top-lp",
        patterns: {},
        lpers: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async studyTopLpers(
    poolInput: string,
    limit?: number,
  ): Promise<MeteoraTopLperStudy> {
    const pool = asAddress(poolInput);
    const config = this.config();
    if (!config.topLpers.enabled) {
      return {
        available: false,
        pool,
        source: "agent-meridian",
        patterns: {},
        lpers: [],
        error: "top-LPer intelligence disabled",
      };
    }
    try {
      const [topRaw, studyRaw] = await Promise.all([
        this.meridian(`/top-lp/${pool}`),
        this.meridian(`/study-top-lp/${pool}`),
      ]);
      const top = isObject(topRaw) ? topRaw : {};
      const study = isObject(studyRaw) ? studyRaw : {};
      const ranked = Array.isArray(top.topLpers)
        ? top.topLpers
            .filter(isObject)
            .slice(0, clamp(Math.trunc(limit ?? config.topLpers.limit), 1, 20))
        : [];
      const historical = Array.isArray(top.historicalOwners)
        ? top.historicalOwners.filter(isObject)
        : [];
      const historicalByOwner = new Map(
        historical
          .map((owner) => [text(owner.owner), owner] as const)
          .filter(([owner]) => !!owner),
      );
      const lpers = ranked.map((owner) => {
        const ownerAddress = text(owner.owner);
        const history = ownerAddress
          ? historicalByOwner.get(ownerAddress)
          : undefined;
        return {
          owner: ownerAddress,
          avg_hold_hours: num(owner.avgAgeHours ?? history?.avgHoldHours),
          avg_open_pnl_pct: num(owner.pnlPerInflowPct ?? history?.avgPnlPct),
          avg_fee_pct: num(owner.feePercent ?? history?.avgFeePercent),
          win_rate_pct: num(owner.winRatePct),
          roi_pct: num(owner.roiPct),
          preferred_strategy: text(history?.preferredStrategy),
          preferred_range_style: text(history?.preferredRangeStyle),
          total_pnl_usd: num(owner.totalPnlUsd),
        };
      });
      const patternSource = study;
      return {
        available: true,
        pool,
        source: "agent-meridian:/top-lp+/study-top-lp",
        patterns: {
          activePositionCount: num(patternSource.activePositionCount),
          ownerCount: num(patternSource.ownerCount),
          suggestedStyle: text(patternSource.suggestedStyle),
          topHistoricalOwners: Array.isArray(patternSource.topHistoricalOwners)
            ? patternSource.topHistoricalOwners.slice(0, 3)
            : [],
        },
        lpers,
        raw: { top: topRaw, study: studyRaw },
      };
    } catch (error) {
      return {
        available: false,
        pool,
        source: "agent-meridian:/top-lp+/study-top-lp",
        patterns: {},
        lpers: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private strategyRejects(
    strategy: MeteoraStrategyDefinition | null,
    token: MeteoraTokenInfo | null,
    holders: MeteoraHolderReport | null,
    narrative: MeteoraNarrative | null,
    smartWallets: MeteoraSmartWalletExposure[],
  ): string[] {
    if (!strategy) return [];
    const criteria = strategy.tokenCriteria;
    const reject: string[] = [];
    if (
      criteria.minMcap != null &&
      (token?.mcap == null || token.mcap < criteria.minMcap)
    )
      reject.push(`strategy min mcap ${criteria.minMcap} not met`);
    if (
      criteria.maxMcap != null &&
      token?.mcap != null &&
      token.mcap > criteria.maxMcap
    )
      reject.push(`strategy max mcap ${criteria.maxMcap} exceeded`);
    if (
      criteria.minHolders != null &&
      (token?.holders == null || token.holders < criteria.minHolders)
    )
      reject.push(`strategy min holders ${criteria.minHolders} not met`);
    if (
      criteria.minOrganic != null &&
      (token?.organicScore == null || token.organicScore < criteria.minOrganic)
    )
      reject.push(`strategy min organic ${criteria.minOrganic} not met`);
    if (
      criteria.maxTop10HolderPct != null &&
      (holders == null ||
        holders.top10RealHoldersPct > criteria.maxTop10HolderPct)
    )
      reject.push(
        `strategy max top-10 holder concentration ${criteria.maxTop10HolderPct}% exceeded/unavailable`,
      );
    if (criteria.requiresSmartWallet && smartWallets.length === 0)
      reject.push("strategy requires smart-wallet signal");
    if (criteria.requireNarrative && !text(narrative?.narrative))
      reject.push("strategy requires token narrative");
    return reject;
  }

  private async enrichCandidate(
    candidate: MeteoraCandidateIntelligence["candidate"],
  ): Promise<MeteoraCandidateIntelligence> {
    const config = this.config();
    const strategy = this.activeStrategy();
    const rejectReasons: string[] = [];
    const warnings: string[] = [];
    let tokenInfo: MeteoraTokenInfo | null = null;
    let holders: MeteoraHolderReport | null = null;
    let narrative: MeteoraNarrative | null = null;
    let indicator: MeteoraIndicatorConfirmation | null = null;
    let topLpers: MeteoraTopLperStudy | null = null;
    let smartWallets: MeteoraSmartWalletExposure[] = [];

    if (config.token.enabled && candidate.baseMint) {
      try {
        const search = await this.getTokenInfo(candidate.baseMint);
        tokenInfo =
          search.results.find((item) => item.mint === candidate.baseMint) ??
          search.results[0] ??
          null;
      } catch (error) {
        warnings.push(
          `token info unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        holders = await this.getTokenHolders(candidate.baseMint, 20);
        smartWallets = holders.smartWalletsHolding;
      } catch (error) {
        warnings.push(
          `holders unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        narrative = await this.getTokenNarrative(candidate.baseMint);
      } catch (error) {
        warnings.push(
          `narrative unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    try {
      const poolSignals = await this.checkSmartWalletsOnPool(candidate.pool);
      const combined = [
        ...poolSignals.lpWallets,
        ...poolSignals.holderWallets,
        ...smartWallets,
      ];
      const unique = new Map(
        combined.map((exposure) => [exposure.wallet.address, exposure]),
      );
      smartWallets = [...unique.values()];
    } catch (error) {
      warnings.push(
        `smart-wallet pool check unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (config.indicators.enabled) {
      try {
        indicator = await this.confirmIndicator({
          pool: candidate.pool,
          side: "entry",
          preset:
            strategy?.entry.indicatorPreset ?? config.indicators.entryPreset,
        });
      } catch (error) {
        warnings.push(
          `indicators unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (config.topLpers.enabled)
      topLpers = await this.studyTopLpers(candidate.pool);

    if (config.decision.requireTokenInfo && !tokenInfo)
      rejectReasons.push("token info required but unavailable");
    if (config.decision.requireHolderReport && !holders)
      rejectReasons.push("holder report required but unavailable");
    if (config.decision.requireNarrative && !text(narrative?.narrative))
      rejectReasons.push("token narrative required but unavailable");
    if (
      config.decision.requireIndicatorConfirmation &&
      indicator &&
      !indicator.skipped &&
      !indicator.confirmed
    )
      rejectReasons.push(`indicator rejected: ${indicator.reason}`);
    if (config.decision.requireIndicatorConfirmation && !indicator)
      rejectReasons.push("indicator confirmation required but unavailable");

    if (tokenInfo?.audit) {
      if (
        config.token.requireMintDisabled &&
        tokenInfo.audit.mintDisabled !== true
      )
        rejectReasons.push("mint authority is not confirmed disabled");
      if (
        config.token.requireFreezeDisabled &&
        tokenInfo.audit.freezeDisabled !== true
      )
        rejectReasons.push("freeze authority is not confirmed disabled");
      if (
        config.token.maxBotHolderPct != null &&
        tokenInfo.audit.botHoldersPct != null &&
        tokenInfo.audit.botHoldersPct > config.token.maxBotHolderPct
      )
        rejectReasons.push(
          `bot holders ${tokenInfo.audit.botHoldersPct}% above ${config.token.maxBotHolderPct}%`,
        );
    }
    if (
      config.token.maxTop10HolderPct != null &&
      holders &&
      holders.top10RealHoldersPct > config.token.maxTop10HolderPct
    )
      rejectReasons.push(
        `top-10 real holders ${holders.top10RealHoldersPct.toFixed(2)}% above ${config.token.maxTop10HolderPct}%`,
      );
    if (
      config.token.minGlobalFeesSol != null &&
      (holders?.globalFeesSol == null ||
        holders.globalFeesSol < config.token.minGlobalFeesSol)
    )
      rejectReasons.push(
        `global fees below ${config.token.minGlobalFeesSol} SOL`,
      );

    rejectReasons.push(
      ...this.strategyRejects(
        strategy,
        tokenInfo,
        holders,
        narrative,
        smartWallets,
      ),
    );
    if (
      strategy?.entry.requireIndicator &&
      indicator &&
      !indicator.skipped &&
      !indicator.confirmed
    )
      rejectReasons.push(
        `active strategy indicator rejected: ${indicator.reason}`,
      );
    if (strategy?.entry.requireIndicator && !indicator)
      rejectReasons.push("active strategy requires indicator confirmation");

    let intelligenceScore = candidate.score;
    if (tokenInfo?.organicScore != null)
      intelligenceScore =
        intelligenceScore * 0.85 + tokenInfo.organicScore * 0.15;
    if (holders && config.token.maxTop10HolderPct != null) {
      const concentrationQuality = clamp(
        100 -
          (holders.top10RealHoldersPct /
            Math.max(config.token.maxTop10HolderPct, 1)) *
            50,
        0,
        100,
      );
      intelligenceScore = intelligenceScore * 0.9 + concentrationQuality * 0.1;
    }
    if (smartWallets.length)
      intelligenceScore += config.smartWallets.scoreBonus;
    if (indicator && !indicator.skipped)
      intelligenceScore += indicator.confirmed ? 3 : -3;
    intelligenceScore = clamp(
      Math.round(intelligenceScore * 100) / 100,
      0,
      100,
    );

    return {
      candidate,
      tokenInfo,
      holders,
      narrative,
      indicator,
      smartWallets,
      topLpers,
      strategy,
      intelligenceScore,
      eligible: candidate.eligible && rejectReasons.length === 0,
      rejectReasons,
      warnings,
    };
  }

  async candidates(limit?: number): Promise<MeteoraCandidateIntelligence[]> {
    const config = this.config();
    const target = clamp(
      Math.trunc(limit ?? config.decision.candidateLimit),
      1,
      20,
    );
    const screened = await this.autopilot.screen(
      Math.max(target, config.decision.candidateLimit),
    );
    const source = screened.candidates.slice(0, target);
    const results: MeteoraCandidateIntelligence[] = [];
    const concurrency = clamp(
      Math.trunc(config.decision.enrichConcurrency),
      1,
      10,
    );
    for (let i = 0; i < source.length; i += concurrency) {
      const batch = await Promise.all(
        source
          .slice(i, i + concurrency)
          .map((candidate) => this.enrichCandidate(candidate)),
      );
      results.push(...batch);
    }
    return results.sort((a, b) => b.intelligenceScore - a.intelligenceScore);
  }

  async decisionContext(
    limit?: number,
  ): Promise<MeteoraIntelligenceDecisionInput> {
    const config = this.config();
    const target = clamp(
      Math.trunc(limit ?? config.decision.candidateLimit),
      1,
      20,
    );
    // Build one deterministic plan first, then enrich the exact candidates carried
    // by that plan. This prevents a second discovery request from giving the model
    // a candidate that is absent from the plan later submitted for execution.
    const plan = await this.autopilot.planCycle(
      Math.max(target, config.decision.candidateLimit),
    );
    const source = plan.candidates.slice(0, target);
    const candidates: MeteoraCandidateIntelligence[] = [];
    const concurrency = clamp(
      Math.trunc(config.decision.enrichConcurrency),
      1,
      10,
    );
    for (let i = 0; i < source.length; i += concurrency) {
      const batch = await Promise.all(
        source
          .slice(i, i + concurrency)
          .map((candidate) => this.enrichCandidate(candidate)),
      );
      candidates.push(...batch);
    }
    candidates.sort((a, b) => b.intelligenceScore - a.intelligenceScore);
    return {
      generatedAt: Date.now(),
      wallet: plan.wallet,
      autopilotContext: this.autopilot.context({
        decisionLimit: 15,
        lessonLimit: 50,
      }),
      cyclePlan: plan,
      candidates,
      strategies: this.listStrategies(),
      activeStrategy: this.activeStrategy(),
      smartWallets: this.listSmartWallets(),
      constraints: {
        managementActionsMayOnlyBeApprovedOrSkipped: true,
        deploymentMustUseEligibleCandidate: true,
        liveExecutionStillRequiresAutopilotGates: true,
      },
    };
  }

  private fallbackDecision(
    input: MeteoraIntelligenceDecisionInput,
  ): MeteoraModelCycleDecision {
    const active = input.activeStrategy;
    const candidate = input.candidates.find((item) => item.eligible) ?? null;
    return {
      deployment: {
        approve: !!candidate,
        pool: candidate?.candidate.pool ?? null,
        reason: candidate
          ? `deterministic fallback selected top intelligence score ${candidate.intelligenceScore}`
          : "no intelligence-eligible candidate",
        strategyId: active?.id ?? null,
        binsBelow: active?.range.binsBelow ?? null,
        binsAbove: active?.range.binsAbove ?? null,
      },
      management: input.cyclePlan.management
        .map((action) => ({
          position: action.position ?? "",
          approve: action.kind !== "review",
          reason:
            action.kind === "review"
              ? "review-only action remains non-executing"
              : "approved deterministic management action",
        }))
        .filter((item) => !!item.position),
      lessons: [],
      summary: "deterministic intelligence fallback",
    };
  }

  private model(
    config: MeteoraIntelligenceConfig,
  ): MeteoraDecisionModel | null {
    if (this.modelOverride) return this.modelOverride;
    if (!config.model.enabled) return null;
    return new OpenAiCompatibleMeteoraDecisionModel(config);
  }

  private validateDecision(
    input: MeteoraIntelligenceDecisionInput,
    decision: MeteoraModelCycleDecision,
  ): MeteoraModelCycleDecision {
    const eligiblePools = new Set(
      input.candidates
        .filter((item) => item.eligible)
        .map((item) => item.candidate.pool),
    );
    const managementPositions = new Set(
      input.cyclePlan.management
        .map((action) => action.position)
        .filter((position): position is string => !!position),
    );
    if (decision.deployment.approve) {
      if (
        !decision.deployment.pool ||
        !eligiblePools.has(decision.deployment.pool)
      )
        throw new Error(
          "Model selected a deployment pool that is not intelligence-eligible",
        );
    }
    decision.management = decision.management.filter((item) =>
      managementPositions.has(item.position),
    );
    const strategyId = decision.deployment.strategyId;
    if (strategyId && !this.state().strategies[strategyId])
      throw new Error(`Model selected unknown strategy ${strategyId}`);
    if (
      decision.deployment.binsBelow != null &&
      (!Number.isInteger(decision.deployment.binsBelow) ||
        decision.deployment.binsBelow < 0)
    )
      throw new Error("Model binsBelow must be a non-negative integer");
    if (
      decision.deployment.binsAbove != null &&
      (!Number.isInteger(decision.deployment.binsAbove) ||
        decision.deployment.binsAbove < 0)
    )
      throw new Error("Model binsAbove must be a non-negative integer");
    return decision;
  }

  async proposeCycle(limit?: number): Promise<{
    input: MeteoraIntelligenceDecisionInput;
    decision: MeteoraModelCycleDecision;
    model: string | null;
  }> {
    const input = await this.decisionContext(limit);
    const config = this.config();
    const model = this.model(config);
    const decision = this.validateDecision(
      input,
      model ? await model.decide(input) : this.fallbackDecision(input),
    );
    return { input, decision, model: model?.id ?? null };
  }

  private reviewFromDecision(
    proposal: Awaited<ReturnType<MeteoraIntelligence["proposeCycle"]>>,
  ) {
    const state = this.state();
    const strategyId =
      proposal.decision.deployment.strategyId ?? state.activeStrategyId;
    const strategy = strategyId ? (state.strategies[strategyId] ?? null) : null;
    const fallback = this.autopilot.config().strategy;
    const requestedBinsBelow =
      proposal.decision.deployment.binsBelow ??
      strategy?.range.binsBelow ??
      fallback.defaultBinsBelow;
    const safeBinsBelow = Math.max(
      fallback.minTotalBins,
      Math.trunc(requestedBinsBelow),
    );
    return {
      management: proposal.input.cyclePlan.management
        .filter((action) => !!action.position)
        .map((action) => {
          const modelDecision = proposal.decision.management.find(
            (item) => item.position === action.position,
          );
          return {
            position: action.position!,
            approve: modelDecision?.approve === true,
            reason: modelDecision?.reason ?? "not explicitly approved by model",
          };
        }),
      deployment: {
        approve: proposal.decision.deployment.approve,
        pool: proposal.decision.deployment.pool,
        reason: proposal.decision.deployment.reason,
        strategy: strategy?.lpStrategy ?? fallback.strategy,
        binsBelow: safeBinsBelow,
        // Single-sided SOL deployment must stay pinned at the active bin.
        binsAbove: 0,
      },
    };
  }

  async runCycle(options: RunOptions = {}) {
    const proposal = await this.proposeCycle(options.limit);
    const review = this.reviewFromDecision(proposal);
    for (const lesson of proposal.decision.lessons) {
      this.autopilot.addLesson({
        rule: lesson.rule,
        tags: lesson.tags,
        role: lesson.role,
        pinned: lesson.pinned,
      });
    }
    const result = await this.autopilot.runReviewedPlan(
      proposal.input.cyclePlan,
      review,
      options,
    );
    const signatures = result.results.flatMap((entry) => entry.signatures);
    const state = this.state();
    const record: MeteoraIntelligenceDecisionRecord = {
      id: id("intel"),
      at: Date.now(),
      model: proposal.model,
      summary: proposal.decision.summary,
      deploymentPool: proposal.decision.deployment.approve
        ? proposal.decision.deployment.pool
        : null,
      approvedManagement: proposal.decision.management
        .filter((item) => item.approve)
        .map((item) => item.position),
      rejectedManagement: proposal.decision.management
        .filter((item) => !item.approve)
        .map((item) => item.position),
      executed: options.execute === true,
      signatures,
    };
    state.decisions = [...state.decisions, record].slice(-100);
    this.saveState(state);
    return { proposal, review, result, record };
  }

  history(limit = 25): MeteoraIntelligenceDecisionRecord[] {
    return this.state()
      .decisions.slice(-clamp(Math.trunc(limit), 1, 100))
      .reverse();
  }

  async call(
    toolName: MeteoraIntelligenceToolName | string,
    input: unknown = {},
  ): Promise<unknown> {
    if (!METEORA_INTELLIGENCE_TOOL_NAMES.has(toolName))
      throw new Error(`Unknown Meteora intelligence tool: ${toolName}`);
    const args = isObject(input) ? input : {};
    switch (toolName) {
      case "meteora_intelligence_status":
        return await this.status();
      case "meteora_intelligence_configure":
        return this.publicConfig(this.configure(args));
      case "meteora_get_token_info":
        return await this.getTokenInfo(text(args.query) ?? "");
      case "meteora_get_token_holders":
        return await this.getTokenHolders(
          text(args.mint) ?? "",
          num(args.limit) ?? 20,
        );
      case "meteora_get_token_narrative":
        return await this.getTokenNarrative(text(args.mint) ?? "");
      case "meteora_confirm_indicator":
        return await this.confirmIndicator({
          pool: text(args.pool_address) ?? "",
          side: text(args.side) === "exit" ? "exit" : "entry",
          preset: text(args.preset) as MeteoraIndicatorPreset | null,
        });
      case "meteora_get_top_lpers":
        return await this.getTopLpers(
          text(args.pool_address) ?? "",
          num(args.limit) ?? undefined,
        );
      case "meteora_study_top_lpers":
        return await this.studyTopLpers(
          text(args.pool_address) ?? "",
          num(args.limit) ?? undefined,
        );
      case "meteora_add_smart_wallet":
        return this.addSmartWallet({
          address: text(args.address) ?? "",
          name: text(args.name) ?? "",
          category:
            (text(args.category) as MeteoraSmartWalletCategory | null) ??
            "alpha",
          type:
            (text(args.wallet_type) as MeteoraSmartWalletType | null) ?? "lp",
          note: text(args.note),
        });
      case "meteora_remove_smart_wallet":
        return { removed: this.removeSmartWallet(text(args.address) ?? "") };
      case "meteora_list_smart_wallets":
        return this.listSmartWallets();
      case "meteora_check_smart_wallets_on_pool":
        return await this.checkSmartWalletsOnPool(
          text(args.pool_address) ?? "",
        );
      case "meteora_add_strategy":
        return this.addStrategy({
          id: text(args.id) ?? "",
          name: text(args.name) ?? "",
          author: text(args.author),
          lpStrategy: text(args.lp_strategy) === "spot" ? "spot" : "bid_ask",
          tokenCriteria: isObject(args.token_criteria)
            ? args.token_criteria
            : {},
          entry: isObject(args.entry) ? args.entry : {},
          range: isObject(args.range) ? args.range : {},
          exit: isObject(args.exit) ? args.exit : {},
          bestFor: text(args.best_for),
          raw: text(args.raw),
        });
      case "meteora_list_strategies":
        return this.listStrategies();
      case "meteora_get_strategy":
        return this.getStrategy(text(args.id) ?? "");
      case "meteora_set_active_strategy":
        return this.setActiveStrategy(text(args.id));
      case "meteora_remove_strategy":
        return { removed: this.removeStrategy(text(args.id) ?? "") };
      case "meteora_intelligence_candidates":
        return await this.candidates(num(args.limit) ?? undefined);
      case "meteora_intelligence_context":
        return await this.decisionContext(num(args.limit) ?? undefined);
      case "meteora_intelligence_propose_cycle":
        return await this.proposeCycle(num(args.limit) ?? undefined);
      case "meteora_intelligence_run_cycle":
        return await this.runCycle({
          limit: num(args.limit) ?? undefined,
          execute: args.execute === true,
          live: args.live === true,
          simulate:
            typeof args.simulate === "boolean" ? args.simulate : undefined,
          skipPreflight:
            typeof args.skip_preflight === "boolean"
              ? args.skip_preflight
              : undefined,
        });
      case "meteora_intelligence_history":
        return this.history(num(args.limit) ?? 25);
      default:
        throw new Error(`Unknown Meteora intelligence tool: ${toolName}`);
    }
  }
}
