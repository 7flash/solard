import {
  runPumpTokenLaunchFromArgs,
  type PumpTokenLaunchCliOptions,
  type PumpTokenLaunchCliResult,
} from "../../launches/pump/token-launch-cli.ts";
import { liveTradesEnabled } from "./context.ts";
import { measureSolard, summarizeForMeasure } from "../api-response.ts";

const PUMP_LAUNCH_JOB_LIVE_CAPABILITY = Symbol.for(
  "solard.launch.pump.job-live",
);

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

  /**
   * Server-owned upload path removed after the background launch completes.
   * It is never forwarded to the CLI.
   */
  temporaryImagePath?: string | null;

  description?: string | null;
  website?: string | null;
  twitter?: string | null;
  telegram?: string | null;
  video?: string | null;
  showName?: boolean | null;
  cashback?: boolean | null;
  mayhemMode?: boolean | null;
  mintSuffix?: string | null;
  vanitySuffix?: string | null;
  pumpSuffix?: boolean | null;
  vanityMaxAttempts?: number | null;
  vanityTimeoutMs?: number | null;
  vanityReportEvery?: number | null;
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

export function authorizePumpLaunchJobLive(input: PumpLaunchInput): void {
  Object.defineProperty(input, PUMP_LAUNCH_JOB_LIVE_CAPABILITY, {
    value: true,

    enumerable: false,

    configurable: false,

    writable: false,
  });
}

function isAuthorizedPumpLaunchJobLive(input: PumpLaunchInput): boolean {
  return Boolean(
    (
      input as PumpLaunchInput & {
        [PUMP_LAUNCH_JOB_LIVE_CAPABILITY]?: boolean;
      }
    )[PUMP_LAUNCH_JOB_LIVE_CAPABILITY],
  );
}

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
  if (input.cashback) pushArg(argv, "cashback", true);
  if (input.mayhemMode) pushArg(argv, "mayhem", true);
  if (input.pumpSuffix)
    pushArg(
      argv,
      "mint-suffix",
      input.mintSuffix ?? input.vanitySuffix ?? "pump",
    );
  else pushArg(argv, "mint-suffix", input.mintSuffix ?? input.vanitySuffix);
  pushArg(argv, "vanity-max-attempts", input.vanityMaxAttempts);
  pushArg(argv, "vanity-timeout-ms", input.vanityTimeoutMs);
  pushArg(argv, "vanity-report-every", input.vanityReportEvery);
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

    temporaryImagePath: stringValue("temporaryImagePath"),

    description: stringValue("description"),
    website: stringValue("website"),
    twitter: stringValue("twitter"),
    telegram: stringValue("telegram"),
    video: stringValue("video"),
    showName: boolValue("showName", true),
    cashback: boolValue("cashback", boolValue("cashbackEnabled", false)),
    mayhemMode: boolValue("mayhemMode", boolValue("mayhem", false)),
    mintSuffix:
      stringValue("mintSuffix") ?? stringValue("vanitySuffix") ?? "pump",
    vanitySuffix: stringValue("vanitySuffix"),
    pumpSuffix: boolValue("pumpSuffix", boolValue("vanitySuffixPump", false)),
    vanityMaxAttempts: numberValue("vanityMaxAttempts"),
    vanityTimeoutMs: numberValue("vanityTimeoutMs"),
    vanityReportEvery: numberValue("vanityReportEvery"),
    creatorBuySol: stringValue("creatorBuySol"),
    creatorBuyLamports: stringValue("creatorBuyLamports"),
    creatorReserveSol: stringValue("creatorReserveSol"),
    buyerMinBps: numberValue("buyerMinBps"),
    buyerMaxBps: numberValue("buyerMaxBps"),
    buyerReserveSol: stringValue("buyerReserveSol"),
    deploymentSender: stringValue("deploymentSender") ?? "helius-rpc",
    buyerSender: stringValue("buyerSender"),
    submitMode: stringValue("submitMode"),
    senderTps: numberValue("senderTps"),
    retryIntervalMs: numberValue("retryIntervalMs"),
    retryRecompileIntervalMs: numberValue("retryRecompileIntervalMs"),
    blockhashRefreshIntervalMs: numberValue("blockhashRefreshIntervalMs"),
    freshQuoteDelayMs: numberValue("freshQuoteDelayMs"),
    retryTimeoutMs: numberValue("retryTimeoutMs"),
    maxFailedAttempts: numberValue("maxFailedAttempts"),
    rateLimitBackoffMs: numberValue("rateLimitBackoffMs"),
    retryJitterMs: numberValue("retryJitterMs"),
    heliusTipSol: stringValue("heliusTipSol"),
    buyerPriorityMicroLamports: numberValue("buyerPriorityMicroLamports"),
    deploymentPriorityMicroLamports: numberValue(
      "deploymentPriorityMicroLamports",
      0,
    ),
    slippageBps: numberValue("slippageBps"),
    live: boolValue("live", false),
    // Match kernel safety: simulation is the default unless the caller opts out.
    skipSimulation: boolValue("skipSimulation", false),
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
  if (live && !liveTradesEnabled() && !isAuthorizedPumpLaunchJobLive(input)) {
    throw new Error(
      "Pump launch requested live execution outside the authenticated Launch-job path.",
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
