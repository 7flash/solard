import {
  runPumpTokenLaunchFromArgs,
  type PumpTokenLaunchCliOptions,
  type PumpTokenLaunchCliResult,
} from "../../launches/pump/token-launch-cli.js";
import { liveTradesEnabled } from "./context.js";
import { measureSolard, summarizeForMeasure } from "../api-response.js";

export type PumpLaunchInput = {
  creator: string;
  buyerGroup?: string | null;
  buyPlan?: unknown[] | null;
  buyPlanJson?: string | null;
  buyPlanPath?: string | null;
  metadataPath?: string | null;
  alias?: string | null;
  name?: string | null;
  symbol?: string | null;
  uri?: string | null;
  imagePath?: string | null;
  description?: string | null;
  website?: string | null;
  twitter?: string | null;
  telegram?: string | null;
  video?: string | null;
  showName?: boolean | null;
  creatorBuySol?: string | null;
  creatorBuyLamports?: string | null;
  creatorReserveSol?: string | null;
  buyerMinBps?: number | null;
  buyerMaxBps?: number | null;
  buyerReserveSol?: string | null;
  deploymentSender?: string | null;
  buyerSender?: string | null;
  submitMode?: string | null;
  senderTps?: number | null;
  retryIntervalMs?: number | null;
  retryRecompileIntervalMs?: number | null;
  blockhashRefreshIntervalMs?: number | null;
  freshQuoteDelayMs?: number | null;
  retryTimeoutMs?: number | null;
  maxFailedAttempts?: number | null;
  rateLimitBackoffMs?: number | null;
  retryJitterMs?: number | null;
  heliusTipSol?: string | null;
  buyerPriorityMicroLamports?: number | null;
  deploymentPriorityMicroLamports?: number | null;
  slippageBps?: number | null;
  live?: boolean | null;
  skipSimulation?: boolean | null;
  out?: string | null;
};

function present(value: unknown): value is string | number | boolean {
  return value !== null && value !== undefined && value !== "";
}

function pushArg(argv: string[], key: string, value: unknown): void {
  if (!present(value)) return;
  if (value === false) return;
  argv.push(`--${key}`);
  if (value !== true) argv.push(String(value));
}

export function pumpLaunchArgsFromInput(input: PumpLaunchInput): string[] {
  const argv: string[] = [];
  pushArg(argv, "creator", input.creator);
  pushArg(argv, "buyer-group", input.buyerGroup);
  if (Array.isArray(input.buyPlan) && input.buyPlan.length > 0) {
    pushArg(argv, "buy-plan-json", JSON.stringify(input.buyPlan));
  }
  pushArg(argv, "buy-plan-json", input.buyPlanJson);
  pushArg(argv, "buy-plan", input.buyPlanPath);
  pushArg(argv, "metadata", input.metadataPath);
  pushArg(argv, "alias", input.alias);
  pushArg(argv, "name", input.name);
  pushArg(argv, "symbol", input.symbol);
  pushArg(argv, "uri", input.uri);
  pushArg(argv, "image", input.imagePath);
  pushArg(argv, "description", input.description);
  pushArg(argv, "website", input.website);
  pushArg(argv, "twitter", input.twitter);
  pushArg(argv, "telegram", input.telegram);
  pushArg(argv, "video", input.video);
  if (input.showName === false) pushArg(argv, "hide-name", true);
  pushArg(argv, "creator-buy-sol", input.creatorBuySol);
  pushArg(argv, "creator-buy-lamports", input.creatorBuyLamports);
  pushArg(argv, "creator-reserve-sol", input.creatorReserveSol);
  pushArg(argv, "buyer-min-bps", input.buyerMinBps);
  pushArg(argv, "buyer-max-bps", input.buyerMaxBps);
  pushArg(argv, "buyer-reserve-sol", input.buyerReserveSol);
  pushArg(argv, "deployment-sender", input.deploymentSender);
  pushArg(argv, "buyer-sender", input.buyerSender);
  pushArg(argv, "submit-mode", input.submitMode);
  pushArg(argv, "sender-tps", input.senderTps);
  pushArg(argv, "retry-interval-ms", input.retryIntervalMs);
  pushArg(argv, "retry-recompile-interval-ms", input.retryRecompileIntervalMs);
  pushArg(
    argv,
    "blockhash-refresh-interval-ms",
    input.blockhashRefreshIntervalMs,
  );
  pushArg(argv, "fresh-quote-delay-ms", input.freshQuoteDelayMs);
  pushArg(argv, "retry-timeout-ms", input.retryTimeoutMs);
  pushArg(argv, "max-failed-attempts", input.maxFailedAttempts);
  pushArg(argv, "rate-limit-backoff-ms", input.rateLimitBackoffMs);
  pushArg(argv, "retry-jitter-ms", input.retryJitterMs);
  pushArg(argv, "helius-tip-sol", input.heliusTipSol);
  pushArg(
    argv,
    "buyer-priority-micro-lamports",
    input.buyerPriorityMicroLamports,
  );
  pushArg(
    argv,
    "deployment-priority-micro-lamports",
    input.deploymentPriorityMicroLamports,
  );
  pushArg(argv, "slippage-bps", input.slippageBps);
  pushArg(argv, "out", input.out);
  if (input.live) pushArg(argv, "live", true);
  if (input.skipSimulation) pushArg(argv, "skip-simulation", true);
  return argv;
}

export function pumpLaunchInputFromRecord(
  body: Record<string, unknown>,
): PumpLaunchInput {
  const numberValue = (
    key: string,
    fallback?: number,
  ): number | null | undefined => {
    const value = body[key];
    if (value == null || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
      throw new Error(`Invalid ${key}: ${String(value)}`);
    return parsed;
  };
  const stringValue = (key: string): string | null => {
    const value = body[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const boolValue = (key: string, fallback = false): boolean => {
    const value = body[key];
    if (value == null || value === "") return fallback;
    return value === true || value === "true" || value === "1" || value === 1;
  };
  return {
    creator: stringValue("creator") ?? "",
    buyerGroup: stringValue("buyerGroup"),
    buyPlan: Array.isArray(body.buyPlan) ? body.buyPlan : null,
    buyPlanJson: stringValue("buyPlanJson"),
    buyPlanPath: stringValue("buyPlanPath"),
    metadataPath: stringValue("metadataPath"),
    alias: stringValue("alias"),
    name: stringValue("name"),
    symbol: stringValue("symbol"),
    uri: stringValue("uri"),
    imagePath: stringValue("imagePath"),
    description: stringValue("description"),
    website: stringValue("website"),
    twitter: stringValue("twitter"),
    telegram: stringValue("telegram"),
    video: stringValue("video"),
    showName: boolValue("showName", true),
    creatorBuySol: stringValue("creatorBuySol"),
    creatorBuyLamports: stringValue("creatorBuyLamports"),
    creatorReserveSol: stringValue("creatorReserveSol"),
    buyerMinBps: numberValue("buyerMinBps", 5000),
    buyerMaxBps: numberValue("buyerMaxBps", 8000),
    buyerReserveSol: stringValue("buyerReserveSol") ?? "0.02",
    deploymentSender: stringValue("deploymentSender") ?? "helius-rpc",
    buyerSender: stringValue("buyerSender") ?? "helius-fast",
    submitMode: stringValue("submitMode") ?? "fast-spam",
    senderTps: numberValue("senderTps", 40),
    retryIntervalMs: numberValue("retryIntervalMs", 75),
    retryRecompileIntervalMs: numberValue("retryRecompileIntervalMs", 750),
    blockhashRefreshIntervalMs: numberValue("blockhashRefreshIntervalMs", 500),
    freshQuoteDelayMs: numberValue("freshQuoteDelayMs", -1),
    retryTimeoutMs: numberValue("retryTimeoutMs", 0),
    maxFailedAttempts: numberValue("maxFailedAttempts", 0),
    rateLimitBackoffMs: numberValue("rateLimitBackoffMs", 400),
    retryJitterMs: numberValue("retryJitterMs", 100),
    heliusTipSol: stringValue("heliusTipSol") ?? "0.001",
    buyerPriorityMicroLamports: numberValue(
      "buyerPriorityMicroLamports",
      1_500_000,
    ),
    deploymentPriorityMicroLamports: numberValue(
      "deploymentPriorityMicroLamports",
      0,
    ),
    slippageBps: numberValue("slippageBps", 9999),
    live: boolValue("live", false),
    skipSimulation: boolValue("skipSimulation", true),
    out: stringValue("out"),
  };
}

function withLiveEnv<T>(live: boolean, fn: () => Promise<T>): Promise<T> {
  if (live) return fn();
  const previousLive = process.env.LIVE;
  process.env.LIVE = "0";
  return fn().finally(() => {
    if (previousLive == null) delete process.env.LIVE;
    else process.env.LIVE = previousLive;
  });
}

async function launchPumpTokenActionInner(
  input: PumpLaunchInput,
  options: PumpTokenLaunchCliOptions = {},
): Promise<PumpTokenLaunchCliResult> {
  if (!input.creator?.trim()) throw new Error("creator is required");
  const live = Boolean(input.live);
  if (live && !liveTradesEnabled()) {
    throw new Error(
      "Pump launch requested live execution, but SOLARD_ENABLE_LIVE_TRADES=1 is not set. Run dry-run first, then opt in explicitly.",
    );
  }
  const argv = pumpLaunchArgsFromInput({ ...input, live });
  return await withLiveEnv(live, () =>
    runPumpTokenLaunchFromArgs(argv, {
      defaultSubmitMode: "after-deploy-processed",
      defaultDeploymentPriorityMicroLamports: 0,
      defaultBuyerPriorityMicroLamports: 1_500_000,
      defaultSlippageBps: 9_999,
      persistOnLive: true,
      ...options,
    }),
  );
}

export async function launchPumpTokenAction(
  input: PumpLaunchInput,
  options: PumpTokenLaunchCliOptions = {},
): Promise<PumpTokenLaunchCliResult> {
  const measured = await measureSolard(
    `solard:action:launch:pump:${input.live ? "live" : "dry-run"}`,
    "launchPumpTokenAction",
    async () => await launchPumpTokenActionInner(input, options),
    {
      summarize: summarizeForMeasure,
      meta: {
        creator: input.creator,
        buyerGroup: input.buyerGroup ?? null,
        live: Boolean(input.live),
      },
      onError: (error) => {
        throw error;
      },
    },
  );
  return measured.value;
}
