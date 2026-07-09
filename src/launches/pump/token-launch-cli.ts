import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Keypair } from "@solana/web3.js";
import { sol } from "../../core/amounts.js";
import {
  uploadPumpMetadata,
  type MetadataUploaderId,
} from "../../metadata/pump-metadata.js";
import { createTraderSowl } from "../../presets/trader.js";
import type { Sowl } from "../../sdk/sowl.js";
import type { SendReceipt, SimulationResult } from "../../tx/types.js";
import {
  executePumpTokenLaunch,
  installPumpLaunchSenders,
  loadExplicitBuyerAllocations,
  loadGroupBuyerAllocations,
  normalizeTraderSubmitMode,
  preparePumpTokenLaunch,
  pumpLaunchEnvironment,
  usesHeliusSenderForLaunch,
  validateHeliusTip,
  type ExplicitBuyerPlanRow,
  type LaunchReporter,
  type PumpLaunchEnvironment,
  type PumpTokenLaunchPlan,
  type PumpTokenLaunchResult,
  type TokenMetadata,
  type TraderSubmitMode,
} from "./token-launch.js";
import { generateMintKeypairWithSuffix } from "./vanity-mint.js";

export type Flags = Map<string, string[]>;

export type PumpTokenMetadataInput = {
  alias: string;
  name: string;
  symbol: string;
  uri?: string;
  imagePath?: string;
  description?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  video?: string;
  showName?: boolean;
};

export type PumpTokenLaunchCliOptions = {
  /** Safe default: do not start trader spam until the deploy signature is processed. */
  defaultSubmitMode?: TraderSubmitMode;
  defaultDeploymentPriorityMicroLamports?: number;
  defaultBuyerPriorityMicroLamports?: number;
  defaultSlippageBps?: number;
  /** Persist the token after any live execution attempt, even if some buyers fail. */
  persistOnLive?: boolean;
  report?: LaunchReporter;
};

export type PumpTokenLaunchCliResult = {
  createdAt: string;
  live: boolean;
  creator: string;
  buyerGroup: string | null;
  buyPlan?: string | null;
  transport: Record<string, unknown>;
  token: PumpTokenMetadataInput & {
    uri: string;
    metadataUri: string;
    mint: string;
    feeMode: "creator-fees";
    cashback: boolean;
    mayhemMode: boolean;
    vanityMintSuffix?: string | null;
    vanityMintAttempts?: number | null;
    vanityMintElapsedMs?: number | null;
  };
  result: PumpTokenLaunchResult;
};

export function parseArgs(argv: string[]): {
  flags: Flags;
  positionals: string[];
} {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) {
      positionals.push(item);
      continue;
    }

    const [key, inline] = item.slice(2).split("=", 2);
    let value = inline ?? "true";
    if (
      inline == null &&
      argv[index + 1] &&
      !argv[index + 1]!.startsWith("--")
    ) {
      value = argv[++index]!;
    }

    const current = flags.get(key!) ?? [];
    current.push(value);
    flags.set(key!, current);
  }

  return { flags, positionals };
}

export function first(
  flags: Flags,
  key: string,
  env?: string,
): string | undefined {
  return flags.get(key)?.at(-1) ?? (env ? process.env[env] : undefined);
}

function envFirst(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function required(flags: Flags, key: string, env?: string): string {
  const value = first(flags, key, env);
  if (!value || value === "true") {
    throw new Error(`Missing --${key} <value>${env ? ` or ${env}` : ""}`);
  }
  return value;
}

export function enabled(flags: Flags, key: string, env?: string): boolean {
  const value = first(flags, key, env);
  return value === "true" || value === "1";
}

export function numberFlag(
  flags: Flags,
  key: string,
  fallback: number,
  env?: string,
): number {
  const raw = first(flags, key, env);
  if (raw == null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key}: ${raw}`);
  return parsed;
}

export function bigintFlag(
  flags: Flags,
  key: string,
  fallback: bigint,
  env?: string,
): bigint {
  const raw = first(flags, key, env);
  if (raw == null) return fallback;
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`Invalid --${key}: ${raw}`);
  }
}

export function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function defaultReport(label: string, value: unknown): void {
  console.log(`${label}: ${json(value)}`);
}

function nonEmpty(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;

  switch (value.trim().toLowerCase()) {
    case "true":
    case "1":
    case "yes":
      return true;
    case "false":
    case "0":
    case "no":
      return false;
    default:
      return undefined;
  }
}

export function pumpTokenMetadataInput(flags: Flags): PumpTokenMetadataInput {
  const metadataPath = first(flags, "metadata");
  let loaded: Partial<PumpTokenMetadataInput> = {};
  let baseDir = process.cwd();

  if (metadataPath) {
    const absolute = resolve(metadataPath);
    baseDir = dirname(absolute);
    loaded = JSON.parse(
      readFileSync(absolute, "utf8"),
    ) as Partial<PumpTokenMetadataInput>;
  }

  const alias =
    nonEmpty(first(flags, "alias")) ??
    nonEmpty(loaded.alias) ??
    required(flags, "alias");
  const name =
    nonEmpty(first(flags, "name")) ??
    nonEmpty(loaded.name) ??
    required(flags, "name");
  const symbol =
    nonEmpty(first(flags, "symbol")) ??
    nonEmpty(loaded.symbol) ??
    required(flags, "symbol");
  const configuredImage =
    nonEmpty(first(flags, "image")) ?? nonEmpty(loaded.imagePath);
  const showName = flags.has("hide-name")
    ? false
    : (optionalBoolean(first(flags, "show-name")) ??
      optionalBoolean(loaded.showName));

  return {
    alias,
    name,
    symbol,
    uri: nonEmpty(first(flags, "uri")) ?? nonEmpty(loaded.uri),
    imagePath: configuredImage ? resolve(baseDir, configuredImage) : undefined,
    description:
      nonEmpty(first(flags, "description")) ?? nonEmpty(loaded.description),
    website: nonEmpty(first(flags, "website")) ?? nonEmpty(loaded.website),
    twitter: nonEmpty(first(flags, "twitter")) ?? nonEmpty(loaded.twitter),
    telegram: nonEmpty(first(flags, "telegram")) ?? nonEmpty(loaded.telegram),
    video: nonEmpty(first(flags, "video")) ?? nonEmpty(loaded.video),
    showName,
  };
}

function optionalSol(
  flags: Flags,
  solKey: string,
  rawKey: string,
  fallback: bigint,
): bigint {
  const raw = first(flags, rawKey);
  if (raw != null) return bigintFlag(flags, rawKey, fallback);
  const human = first(flags, solKey);
  return human == null ? fallback : sol(human).raw;
}

function optionalSolOverride(
  flags: Flags,
  solKey: string,
  rawKey: string,
): bigint | undefined {
  const raw = first(flags, rawKey);
  if (raw != null) return bigintFlag(flags, rawKey, 0n);
  const human = first(flags, solKey);
  return human == null ? undefined : sol(human).raw;
}

function optionalSolEnv(
  solEnvNames: string[],
  rawEnvNames: string[],
): bigint | undefined {
  const raw = envFirst(...rawEnvNames);
  if (raw != null) {
    try {
      return BigInt(raw);
    } catch {
      throw new Error(`Invalid ${rawEnvNames.join("/")}: ${raw}`);
    }
  }

  const human = envFirst(...solEnvNames);
  return human == null ? undefined : sol(human).raw;
}

function senderFlag(flags: Flags, key: string, fallback: string): string {
  const value = first(flags, key);
  if (!value) return fallback;
  if (value !== "helius-fast" && value !== "helius-rpc") {
    throw new Error(
      `Invalid --${key}: ${value}. Expected helius-fast or helius-rpc.`,
    );
  }
  return value;
}

export function pumpLaunchEnvironmentFromFlags(
  flags: Flags,
  base = pumpLaunchEnvironment(),
): PumpLaunchEnvironment {
  const deploymentSender = senderFlag(
    flags,
    "deployment-sender",
    String(base.policy.deploymentSender),
  );
  const buyerSender = first(flags, "buyer-sender");
  if (
    buyerSender &&
    buyerSender !== "helius-fast" &&
    buyerSender !== "helius-rpc"
  ) {
    throw new Error(
      `Invalid --buyer-sender: ${buyerSender}. Expected helius-fast or helius-rpc.`,
    );
  }

  const fastTraderSender =
    buyerSender ??
    senderFlag(
      flags,
      "fast-trader-sender",
      String(base.policy.fastTraderSender),
    );
  const rpcTraderSender =
    buyerSender ??
    senderFlag(flags, "rpc-trader-sender", String(base.policy.rpcTraderSender));
  const evolutionSender = senderFlag(
    flags,
    "evolution-sender",
    String(base.policy.evolutionSender),
  );
  const fastTraderCount = flags.has("fast-trader-count")
    ? numberFlag(flags, "fast-trader-count", base.policy.fastTraderCount)
    : buyerSender === "helius-fast"
      ? Number.MAX_SAFE_INTEGER
      : buyerSender === "helius-rpc"
        ? 0
        : base.policy.fastTraderCount;

  const senderUrl =
    first(flags, "helius-sender-url") ??
    first(flags, "sender-url") ??
    envFirst(
      "HELIUS_SENDER_URL",
      "SOLWAL_HELIUS_SENDER_URL",
      "SOWL_HELIUS_SENDER_URL",
    ) ??
    base.senderUrl;
  const tipAccount =
    first(flags, "helius-tip-account") ??
    first(flags, "fast-tip-account") ??
    envFirst(
      "HELIUS_TIP_ACCOUNT",
      "SOLWAL_HELIUS_TIP_ACCOUNT",
      "SOWL_HELIUS_TIP_ACCOUNT",
    ) ??
    base.policy.fastTip.account;
  const tipLamports =
    optionalSolOverride(flags, "helius-tip-sol", "helius-tip-lamports") ??
    optionalSolOverride(flags, "fast-tip-sol", "fast-tip-lamports") ??
    optionalSolEnv(
      ["HELIUS_TIP_SOL", "SOLWAL_HELIUS_TIP_SOL", "SOWL_HELIUS_TIP_SOL"],
      [
        "HELIUS_TIP_LAMPORTS",
        "SOLWAL_HELIUS_TIP_LAMPORTS",
        "SOWL_HELIUS_TIP_LAMPORTS",
      ],
    ) ??
    base.policy.fastTip.lamports;

  return {
    ...base,
    rpcUrl:
      first(flags, "rpc-url") ??
      envFirst("HELIUS_RPC_URL", "RPC_ENDPOINT") ??
      base.rpcUrl,
    senderUrl,
    policy: {
      ...base.policy,
      deploymentSender,
      evolutionSender,
      fastTraderSender,
      rpcTraderSender,
      fastTraderCount,
      fastTip:
        tipAccount || tipLamports != null
          ? { account: tipAccount, lamports: tipLamports }
          : {},
    },
  };
}

function simulationSummary(
  simulation: SimulationResult,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    success: simulation.success,
    cuUsed: simulation.cuUsed ?? null,
    error: simulation.error ?? null,
    accountChanges: Array.isArray(simulation.accountChanges)
      ? simulation.accountChanges.length
      : undefined,
    tokenChanges: Array.isArray(simulation.tokenChanges)
      ? simulation.tokenChanges.length
      : undefined,
  };
  if (!simulation.success && Array.isArray(simulation.logs))
    result.lastLogs = simulation.logs.slice(-12);
  return result;
}

function receiptSummary(receipt: SendReceipt): Record<string, unknown> {
  return {
    signature: receipt.signature ?? null,
    status: receipt.status ?? null,
    slot: receipt.slot ?? null,
    sender: receipt.sender ?? null,
    error: receipt.error ?? null,
  };
}

function summarizeLaunchResult(result: PumpTokenLaunchResult): unknown {
  if (result.mode === "dry-run") {
    return {
      mode: result.mode,
      launchSimulation: simulationSummary(result.launchSimulation),
      deploymentSender: result.deploymentSender,
      buyers: result.buyers,
    };
  }

  return {
    mode: result.mode,
    launchReceipt: receiptSummary(result.launchReceipt),
    traderReceipts: result.traderReceipts,
  };
}

function requireSkipSimulationForBlindLiveBuys(
  live: boolean,
  submitMode: TraderSubmitMode,
  skipSimulation: boolean,
  hasBuyerGroup: boolean,
): void {
  if (
    live &&
    hasBuyerGroup &&
    normalizeTraderSubmitMode(submitMode) === "blind-spam-after-submit" &&
    !skipSimulation
  ) {
    throw new Error(
      "Blind parallel dependent-buy submission requires --skip-simulation after a reviewed dry run.",
    );
  }
}

async function resolveMetadataUri(
  flags: Flags,
  input: PumpTokenMetadataInput,
): Promise<{
  uri: string;
  uploaded: Awaited<ReturnType<typeof uploadPumpMetadata>> | null;
}> {
  let uri = input.uri;
  let uploaded: Awaited<ReturnType<typeof uploadPumpMetadata>> | null = null;

  if (!uri && input.imagePath) {
    uploaded = await uploadPumpMetadata(
      {
        imagePath: input.imagePath,
        name: input.name,
        symbol: input.symbol,
        description:
          input.description?.trim() || `${input.name} (${input.symbol})`,
        website: input.website,
        twitter: input.twitter,
        telegram: input.telegram,
        video: input.video,
        showName: input.showName,
      },
      {
        provider: (first(
          flags,
          "metadata-provider",
          "PUMP_METADATA_PROVIDER",
        ) ?? "pump-frontend") as MetadataUploaderId,
      },
    );
    uri = uploaded.metadataUri;
  }

  if (!uri) {
    throw new Error(
      "Provide --uri <metadata-uri> or --metadata <json> / --image <path>.",
    );
  }

  return { uri, uploaded };
}

function resolveSubmitMode(
  flags: Flags,
  options: PumpTokenLaunchCliOptions,
): TraderSubmitMode {
  return normalizeTraderSubmitMode(
    first(flags, "submit-mode") ??
      process.env.SOLWAL_LAUNCH_SUBMIT_MODE?.trim() ??
      process.env.SOWL_LAUNCH_SUBMIT_MODE?.trim() ??
      options.defaultSubmitMode,
  );
}

function spamOptionsFromFlags(
  flags: Flags,
  fallback: ReturnType<typeof pumpLaunchEnvironment>["spam"],
): ReturnType<typeof pumpLaunchEnvironment>["spam"] {
  return {
    intervalMs: numberFlag(flags, "retry-interval-ms", fallback.intervalMs),
    timeoutMs: numberFlag(flags, "retry-timeout-ms", fallback.timeoutMs),
    maxFailedAttempts: numberFlag(
      flags,
      "max-failed-attempts",
      fallback.maxFailedAttempts,
    ),
    recompileIntervalMs: numberFlag(
      flags,
      "retry-recompile-interval-ms",
      fallback.recompileIntervalMs ?? 750,
    ),
    freshQuoteDelayMs: numberFlag(
      flags,
      "fresh-quote-delay-ms",
      fallback.freshQuoteDelayMs ?? 2_500,
    ),
    blockhashRefreshIntervalMs: numberFlag(
      flags,
      "blockhash-refresh-interval-ms",
      fallback.blockhashRefreshIntervalMs ?? 500,
    ),
    readinessTimeoutMs: numberFlag(
      flags,
      "readiness-timeout-ms",
      fallback.readinessTimeoutMs ?? fallback.timeoutMs,
    ),
    senderTps: numberFlag(flags, "sender-tps", fallback.senderTps ?? 40),
    rateLimitBackoffMs: numberFlag(
      flags,
      "rate-limit-backoff-ms",
      fallback.rateLimitBackoffMs ?? 350,
    ),
    jitterMs: numberFlag(flags, "retry-jitter-ms", fallback.jitterMs ?? 80),
  };
}

type RawBuyPlanRow = Record<string, unknown>;

function stringValue(row: RawBuyPlanRow, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(row: RawBuyPlanRow, key: string): number | undefined {
  const value = row[key];
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    throw new Error(`Invalid buy plan ${key}: ${String(value)}`);
  return parsed;
}

function bigintValue(row: RawBuyPlanRow, key: string): bigint | undefined {
  const value = row[key];
  if (value == null || value === "") return undefined;
  try {
    return BigInt(String(value));
  } catch {
    throw new Error(`Invalid buy plan ${key}: ${String(value)}`);
  }
}

function solValue(
  row: RawBuyPlanRow,
  solKey: string,
  lamportsKey: string,
): bigint | undefined {
  const lamports = bigintValue(row, lamportsKey);
  if (lamports != null) return lamports;
  const human = stringValue(row, solKey);
  return human == null ? undefined : sol(human).raw;
}

function parseBuyPlanRows(flags: Flags): ExplicitBuyerPlanRow[] | null {
  const inline = first(flags, "buy-plan-json");
  const path = first(flags, "buy-plan");
  if (!inline && !path) return null;

  const parsed = JSON.parse(
    inline ?? readFileSync(resolve(path!), "utf8"),
  ) as unknown;
  const rows = Array.isArray(parsed)
    ? parsed
    : (parsed as { buys?: unknown }).buys;
  if (!Array.isArray(rows))
    throw new Error(
      "Buy plan must be a JSON array or an object with a buys array",
    );

  return rows.map((raw, index): ExplicitBuyerPlanRow => {
    if (!raw || typeof raw !== "object")
      throw new Error(`Buy plan row ${index + 1} must be an object`);
    const row = raw as RawBuyPlanRow;
    const wallet =
      stringValue(row, "wallet") ??
      stringValue(row, "walletRef") ??
      stringValue(row, "address");
    if (!wallet) throw new Error(`Buy plan row ${index + 1} is missing wallet`);

    const amountMode =
      stringValue(row, "amountMode") ?? stringValue(row, "mode") ?? "range-bps";
    let amount: ExplicitBuyerPlanRow["amount"];
    if (amountMode === "exact-sol" || amountMode === "exact") {
      const exactSol =
        stringValue(row, "exactSol") ??
        stringValue(row, "sol") ??
        stringValue(row, "amountSol");
      if (!exactSol)
        throw new Error(
          `Buy plan row ${index + 1} exact-sol mode requires exactSol`,
        );
      amount = { kind: "exact-sol", sol: exactSol };
    } else if (amountMode === "exact-lamports" || amountMode === "lamports") {
      const lamports =
        bigintValue(row, "exactLamports") ??
        bigintValue(row, "lamports") ??
        bigintValue(row, "amountLamports");
      if (lamports == null)
        throw new Error(
          `Buy plan row ${index + 1} exact-lamports mode requires exactLamports`,
        );
      amount = { kind: "exact-lamports", lamports };
    } else {
      amount = {
        kind: "balance-bps",
        minBps:
          numberValue(row, "minBps") ?? numberValue(row, "buyerMinBps") ?? 5000,
        maxBps:
          numberValue(row, "maxBps") ?? numberValue(row, "buyerMaxBps") ?? 8000,
        reserveLamports:
          solValue(row, "reserveSol", "reserveLamports") ?? 20_000_000n,
      };
    }

    const tipLamports = solValue(row, "tipSol", "tipLamports");
    return {
      wallet,
      amount,
      execution: {
        label: stringValue(row, "label"),
        sender: stringValue(row, "sender") as never,
        strategy: stringValue(row, "strategy") as never,
        tipLamports,
        priorityMicroLamports: numberValue(row, "priorityMicroLamports"),
        slippageBps: numberValue(row, "slippageBps"),
        retryIntervalMs: numberValue(row, "retryIntervalMs"),
        recompileIntervalMs: numberValue(row, "recompileIntervalMs"),
        freshQuoteDelayMs: numberValue(row, "freshQuoteDelayMs"),
        maxFailedAttempts: numberValue(row, "maxFailedAttempts"),
      },
    };
  });
}

export async function preparePumpTokenLaunchFromFlags(args: {
  sowl: Sowl;
  flags: Flags;
  token: TokenMetadata;
  creator: string;
  env?: PumpLaunchEnvironment;
  options?: PumpTokenLaunchCliOptions;
  mint?: Keypair;
  cashback?: boolean;
  mayhemMode?: boolean;
}): Promise<PumpTokenLaunchPlan> {
  const options = args.options ?? {};
  const group = first(args.flags, "buyer-group");
  const env = args.env ?? pumpLaunchEnvironmentFromFlags(args.flags);
  const explicitBuyPlan = parseBuyPlanRows(args.flags);
  const traders = explicitBuyPlan
    ? await loadExplicitBuyerAllocations({
        sowl: args.sowl,
        rows: explicitBuyPlan,
        excludeWallet: args.creator,
      })
    : group
      ? await loadGroupBuyerAllocations({
          sowl: args.sowl,
          group,
          minBps: numberFlag(args.flags, "buyer-min-bps", 10),
          maxBps: numberFlag(args.flags, "buyer-max-bps", 10),
          reserveLamports: optionalSol(
            args.flags,
            "buyer-reserve-sol",
            "buyer-reserve-lamports",
            10_000_000n,
          ),
          excludeWallet: args.creator,
        })
      : [];

  return await preparePumpTokenLaunch({
    sowl: args.sowl,
    token: args.token,
    creatorWallet: args.creator,
    traders,
    creatorBuyLamports: optionalSol(
      args.flags,
      "creator-buy-sol",
      "creator-buy-lamports",
      0n,
    ),
    creatorReserveLamports: optionalSol(
      args.flags,
      "creator-reserve-sol",
      "creator-reserve-lamports",
      10_000_000n,
    ),
    slippageBps: numberFlag(
      args.flags,
      "slippage-bps",
      options.defaultSlippageBps ?? 1500,
    ),
    cuLimit: env.cuLimit,
    priorityMicroLamports: numberFlag(
      args.flags,
      "deployment-priority-micro-lamports",
      options.defaultDeploymentPriorityMicroLamports ??
        env.priorityMicroLamports,
    ),
    buyerPriorityMicroLamports: numberFlag(
      args.flags,
      "buyer-priority-micro-lamports",
      options.defaultBuyerPriorityMicroLamports ?? 1_500_000,
    ),
    senderPolicy: env.policy,
    mint: args.mint,
    cashback: args.cashback ?? args.token.cashback ?? false,
    mayhemMode: args.mayhemMode ?? args.token.mayhemMode ?? false,
  });
}

function vanitySuffixFromFlags(flags: Flags): string | null {
  const explicit = first(flags, "mint-suffix") ?? first(flags, "vanity-suffix");
  if (explicit && explicit !== "true") return explicit.trim();
  if (enabled(flags, "pump-suffix", "SOLARD_LAUNCH_PUMP_SUFFIX")) return "pump";
  return null;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function runPumpTokenLaunchFromArgs(
  argv: string[],
  options: PumpTokenLaunchCliOptions = {},
): Promise<PumpTokenLaunchCliResult> {
  const { flags } = parseArgs(argv);
  const report = options.report ?? defaultReport;
  const creator = required(flags, "creator");
  const input = pumpTokenMetadataInput(flags);
  const live = enabled(flags, "live", "LIVE");
  const skipSimulation = enabled(flags, "skip-simulation", "SKIP_SIMULATION");
  const group = first(flags, "buyer-group");
  const env = pumpLaunchEnvironmentFromFlags(flags);
  const spam = spamOptionsFromFlags(flags, env.spam);
  const submitMode = resolveSubmitMode(flags, options);
  const usesHeliusSender = usesHeliusSenderForLaunch(env, Boolean(group));
  const persistOnLive = options.persistOnLive ?? true;

  if (usesHeliusSender && !env.senderUrl) {
    throw new Error(
      "Helius fast sender is selected; provide --helius-sender-url or HELIUS_SENDER_URL.",
    );
  }

  if (usesHeliusSender) {
    validateHeliusTip({
      tip: env.policy.fastTip,
      endpoint: env.senderUrl ?? "",
      live,
      label: "Pump launch transactions routed through Helius Sender",
    });
  }

  requireSkipSimulationForBlindLiveBuys(
    live,
    submitMode,
    skipSimulation,
    Boolean(group),
  );

  const { uri, uploaded } = await resolveMetadataUri(flags, input);
  const cashback = enabled(flags, "cashback", "SOLARD_LAUNCH_CASHBACK");
  const mayhemMode = enabled(flags, "mayhem", "SOLARD_LAUNCH_MAYHEM");
  const vanityMintSuffix = vanitySuffixFromFlags(flags);
  let vanityMint: Keypair | undefined;
  let vanityMintAttempts: number | null = null;
  let vanityMintElapsedMs: number | null = null;

  if (vanityMintSuffix) {
    const maxAttempts = numberFlag(
      flags,
      "vanity-max-attempts",
      envNumber("SOLARD_VANITY_MINT_MAX_ATTEMPTS", 25_000_000),
    );
    const timeoutMs = numberFlag(
      flags,
      "vanity-timeout-ms",
      envNumber("SOLARD_VANITY_MINT_TIMEOUT_MS", 0),
    );
    const reportEvery = numberFlag(
      flags,
      "vanity-report-every",
      envNumber("SOLARD_VANITY_MINT_REPORT_EVERY", 1_000_000),
    );
    report("vanity mint start", {
      suffix: vanityMintSuffix,
      maxAttempts,
      timeoutMs,
      reportEvery,
    });
    const found = await generateMintKeypairWithSuffix({
      suffix: vanityMintSuffix,
      maxAttempts,
      timeoutMs,
      reportEvery,
      onProgress: (progress) => report("vanity mint progress", progress),
    });
    vanityMint = found.mint;
    vanityMintAttempts = found.attempts;
    vanityMintElapsedMs = found.elapsedMs;
    report("vanity mint found", {
      mint: found.mint.publicKey.toBase58(),
      suffix: vanityMintSuffix,
      attempts: found.attempts,
      elapsedMs: found.elapsedMs,
    });
  }

  const sowl = createTraderSowl({ rpcUrl: env.rpcUrl });
  installPumpLaunchSenders(sowl, env);

  let prepared: PumpTokenLaunchPlan | null = null;
  try {
    const token: TokenMetadata = {
      alias: input.alias,
      name: input.name,
      symbol: input.symbol,
      uri,
      cashback,
      mayhemMode,
    };
    const deploymentPriorityMicroLamports = numberFlag(
      flags,
      "deployment-priority-micro-lamports",
      options.defaultDeploymentPriorityMicroLamports ??
        env.priorityMicroLamports,
    );
    const buyerPriorityMicroLamports = numberFlag(
      flags,
      "buyer-priority-micro-lamports",
      options.defaultBuyerPriorityMicroLamports ?? 1_500_000,
    );
    const slippageBps = numberFlag(
      flags,
      "slippage-bps",
      options.defaultSlippageBps ?? 1500,
    );

    prepared = await preparePumpTokenLaunchFromFlags({
      sowl,
      flags,
      token,
      creator,
      env,
      options,
      mint: vanityMint,
      cashback,
      mayhemMode,
    });
    const mint = prepared.deployment.mint.publicKey.toBase58();

    report("pump launch plan", {
      live,
      token: {
        alias: input.alias,
        name: input.name,
        symbol: input.symbol,
        mint,
        metadataUri: uri,
        website: input.website ?? null,
        twitter: input.twitter ?? null,
        telegram: input.telegram ?? null,
        video: input.video ?? null,
        showName: input.showName ?? true,
      },
      metadata: uploaded
        ? {
            provider: uploaded.provider,
            metadataUri: uploaded.metadataUri,
            website: uploaded.metadata.website ?? null,
            twitter: uploaded.metadata.twitter ?? null,
            telegram: uploaded.metadata.telegram ?? null,
            video: uploaded.metadata.video ?? null,
            showName: uploaded.metadata.showName,
          }
        : null,
      feeMode: "creator-fees",
      cashback,
      mayhemMode,
      vanityMintSuffix,
      vanityMintAttempts,
      vanityMintElapsedMs,
      creatorBuyLamports: optionalSol(
        flags,
        "creator-buy-sol",
        "creator-buy-lamports",
        0n,
      ),
      buyerGroup: group ?? null,
      buyPlan:
        first(flags, "buy-plan") ??
        (first(flags, "buy-plan-json") ? "inline-json" : null),
      transport: {
        usesHeliusSender,
        priorityMicroLamports: deploymentPriorityMicroLamports,
        buyerPriorityMicroLamports,
        heliusTipLamports: env.policy.fastTip.lamports ?? null,
        senderTps: spam.senderTps ?? null,
      },
      routes: {
        createAndCreatorBuy: env.policy.deploymentSender,
        fastBuyerCount: env.policy.fastTraderCount,
        fastBuyers: env.policy.fastTraderSender,
        remainingBuyers: env.policy.rpcTraderSender,
      },
      execution: {
        submitMode,
        skipSimulation,
        slippageBps,
        retry: spam,
      },
      participants: prepared.expectedOutputByWallet,
    });

    const result = await executePumpTokenLaunch({
      sowl,
      prepared,
      live,
      traderSubmitMode: submitMode,
      skipSimulation,
      spam,
      kind: `cli:launch:pump:${input.alias}`,
      reporter: report,
    });

    const output: PumpTokenLaunchCliResult = {
      createdAt: new Date().toISOString(),
      live,
      creator,
      buyerGroup: group ?? null,
      buyPlan:
        first(flags, "buy-plan") ??
        (first(flags, "buy-plan-json") ? "inline-json" : null),
      transport: {
        usesHeliusSender,
        priorityMicroLamports: deploymentPriorityMicroLamports,
        buyerPriorityMicroLamports,
        heliusTipLamports: env.policy.fastTip.lamports ?? null,
        senderTps: spam.senderTps ?? null,
        createAndCreatorBuy: env.policy.deploymentSender,
        fastBuyerCount: env.policy.fastTraderCount,
        fastBuyers: env.policy.fastTraderSender,
        remainingBuyers: env.policy.rpcTraderSender,
        submitMode,
      },
      token: {
        ...input,
        uri,
        metadataUri: uri,
        mint,
        feeMode: "creator-fees",
        cashback,
        mayhemMode,
        vanityMintSuffix,
        vanityMintAttempts,
        vanityMintElapsedMs,
      },
      result,
    };

    const out = first(flags, "out");
    if (out) {
      const path = resolve(out);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, json(output));
    }

    report("pump launch result", {
      alias: input.alias,
      mint,
      live,
      outputPath: out ? resolve(out) : null,
      result: summarizeLaunchResult(result),
    });

    return output;
  } finally {
    if (live && persistOnLive && prepared) {
      try {
        sowl.persistPreparedDeployment(prepared.deployment, input.alias);
      } catch {
        // Best-effort persistence fallback. Do not mask the launch result/error.
      }
    }
    sowl.close();
  }
}

export function formatCliError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}
