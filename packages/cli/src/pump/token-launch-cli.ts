import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { Keypair, PublicKey } from "@solana/web3.js";
import {
  abortArmedBuyerEndpoints,
  assertArmedBuyerEndpointsReady,
  bondingCurvePda,
  createTraderSolard,
  cleanVanitySuffix,
  defaultVanityMaxAttempts,
  executePumpTokenLaunch,
  generateMintKeypairWithSuffix,
  installPumpLaunchSenders,
  loadExplicitBuyerAllocations,
  loadGroupBuyerAllocations,
  normalizeTraderSubmitMode,
  parseArmedBuyerEndpoint,
  PUMP_PROGRAM_ID,
  preparePumpTokenLaunch,
  pumpLaunchEnvironment,
  releaseArmedBuyerEndpoints,
  releaseVanityMintReservation,
  reserveVanityMintFromPool,
  markVanityMintUsed,
  sol,
  TOKEN_2022_ID,
  uploadPumpMetadata,
  usesHeliusSenderForLaunch,
  validateHeliusTip,
  validateJitoTip,
  type ExplicitBuyerPlanRow,
  type LaunchReporter,
  type MetadataUploaderId,
  type PumpLaunchEnvironment,
  type PumpTokenLaunchPlan,
  type PumpTokenLaunchResult,
  type SendReceipt,
  type SimulationResult,
  type Solard,
  type TokenMetadata,
  type TraderSubmitMode,
  type VanityMintPoolReservation,
} from "@solard/sdk";

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

type LoadedMintKeypair = {
  mint: Keypair;
  path: string;
  address: string;
};

function mintSecretKeyBytes(value: unknown): Uint8Array {
  const source = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        Array.isArray((value as { secretKey?: unknown }).secretKey)
      ? (value as { secretKey: unknown[] }).secretKey
      : null;

  if (!source || source.length !== 64) {
    throw new Error(
      "Mint keypair JSON must be an array of exactly 64 bytes, or an object with a 64-byte secretKey array.",
    );
  }

  return Uint8Array.from(
    source.map((item, index) => {
      const byte = Number(item);
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new Error(`Invalid mint keypair byte at index ${index}.`);
      }
      return byte;
    }),
  );
}

export function loadMintKeypairFromFlags(
  flags: Flags,
  requiredSuffix: string | null,
): LoadedMintKeypair | null {
  const configuredPath = nonEmpty(first(flags, "mint-keypair"));
  const expectedAddress = nonEmpty(first(flags, "mint-address"));

  if (expectedAddress && !configuredPath) {
    throw new Error(
      "--mint-address cannot be used without --mint-keypair; the mint keypair must sign token creation.",
    );
  }

  if (!configuredPath) return null;

  const absolutePath = resolve(configuredPath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Could not read mint keypair JSON: ${absolutePath}`, {
      cause: error,
    });
  }

  const mint = Keypair.fromSecretKey(mintSecretKeyBytes(parsed));
  const address = mint.publicKey.toBase58();

  if (expectedAddress && address !== expectedAddress) {
    throw new Error(
      `Mint keypair derives ${address}, not the expected --mint-address ${expectedAddress}.`,
    );
  }

  if (requiredSuffix && !address.endsWith(requiredSuffix)) {
    throw new Error(
      `Mint keypair address ${address} does not end with required suffix ${requiredSuffix}.`,
    );
  }

  return {
    mint,
    path: absolutePath,
    address,
  };
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

async function assertPumpMintIsUnused(args: {
  slrd: Solard;
  mint: PublicKey;
  report: LaunchReporter;
}): Promise<void> {
  const bondingCurve = bondingCurvePda(args.mint);
  const [mintAccount, bondingCurveAccount] = await args.slrd
    .connection()
    .getMultipleAccountsInfo([args.mint, bondingCurve], {
      commitment: "confirmed",
    });

  args.report("pump mint on-chain preflight", {
    mint: args.mint.toBase58(),
    mintExists: mintAccount != null,
    mintOwner: mintAccount?.owner.toBase58() ?? null,
    mintLamports: mintAccount?.lamports ?? null,
    mintDataLength: mintAccount?.data.length ?? null,
    mintIsToken2022: mintAccount?.owner.equals(TOKEN_2022_ID) ?? false,
    bondingCurve: bondingCurve.toBase58(),
    bondingCurveExists: bondingCurveAccount != null,
    bondingCurveOwner: bondingCurveAccount?.owner.toBase58() ?? null,
    bondingCurveIsPump:
      bondingCurveAccount?.owner.equals(PUMP_PROGRAM_ID) ?? false,
  });

  if (mintAccount == null && bondingCurveAccount == null) return;

  const state =
    mintAccount != null && bondingCurveAccount != null
      ? "the mint and Pump bonding curve already exist"
      : mintAccount != null
        ? "the mint account is already initialized"
        : "the Pump bonding-curve account already exists";

  throw new Error(
    `Configured mint ${args.mint.toBase58()} cannot be used for create_v2: ` +
      `${state}. Pump create_v2 requires a new Token-2022 mint account. ` +
      `Run .\\rotate-pump-mint.ps1 to generate a fresh vanity mint and ` +
      `update the saved launch profile.`,
  );
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

type JitoTipFloorPercentile = "25" | "50" | "75" | "95" | "99" | "ema50";

type JitoTipFloorRow = {
  time?: string;
  landed_tips_25th_percentile?: number;
  landed_tips_50th_percentile?: number;
  landed_tips_75th_percentile?: number;
  landed_tips_95th_percentile?: number;
  landed_tips_99th_percentile?: number;
  ema_landed_tips_50th_percentile?: number;
};

type JitoTipSelection = {
  mode: "fixed" | "dynamic";
  source: "configured" | "minimum-fallback" | "tip-floor-rest";
  lamports: bigint;
  percentile?: JitoTipFloorPercentile;
  multiplier?: number;
  rawSol?: number;
  selectedSol: number;
  sampleTime?: string;
  sampleAgeMs?: number;
  endpoint?: string;
  fallbackReason?: string;
};

function jitoTipPercentile(flags: Flags): JitoTipFloorPercentile {
  const value = (
    first(flags, "jito-tip-percentile") ??
    envFirst("JITO_TIP_PERCENTILE") ??
    "95"
  )
    .trim()
    .toLowerCase();
  if (
    value === "25" ||
    value === "50" ||
    value === "75" ||
    value === "95" ||
    value === "99" ||
    value === "ema50"
  ) {
    return value;
  }
  throw new Error(
    `Invalid --jito-tip-percentile: ${value}. Expected 25, 50, 75, 95, 99, or ema50.`,
  );
}

function jitoTipField(
  percentile: JitoTipFloorPercentile,
): keyof JitoTipFloorRow {
  switch (percentile) {
    case "25":
      return "landed_tips_25th_percentile";
    case "50":
      return "landed_tips_50th_percentile";
    case "75":
      return "landed_tips_75th_percentile";
    case "95":
      return "landed_tips_95th_percentile";
    case "99":
      return "landed_tips_99th_percentile";
    case "ema50":
      return "ema_landed_tips_50th_percentile";
  }
}

function clampBigInt(value: bigint, minimum: bigint, maximum: bigint): bigint {
  if (value < minimum) return minimum;
  if (value > maximum) return maximum;
  return value;
}

async function resolveJitoBundleTip(args: {
  flags: Flags;
  configuredLamports: bigint;
}): Promise<JitoTipSelection> {
  const mode = (
    first(args.flags, "jito-tip-mode") ??
    envFirst("JITO_TIP_MODE") ??
    "dynamic"
  )
    .trim()
    .toLowerCase();

  if (mode === "fixed") {
    return {
      mode: "fixed",
      source: "configured",
      lamports: args.configuredLamports,
      selectedSol: Number(args.configuredLamports) / 1_000_000_000,
    };
  }
  if (mode !== "dynamic") {
    throw new Error(
      `Invalid --jito-tip-mode: ${mode}. Expected dynamic or fixed.`,
    );
  }

  const endpoint = (
    first(args.flags, "jito-tip-floor-url") ??
    envFirst("JITO_TIP_FLOOR_URL") ??
    "https://bundles.jito.wtf/api/v1/bundles/tip_floor"
  ).trim();
  const percentile = jitoTipPercentile(args.flags);
  const multiplier = numberFlag(
    args.flags,
    "jito-tip-multiplier",
    Number(envFirst("JITO_TIP_MULTIPLIER") ?? "1.25"),
  );
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error(
      `--jito-tip-multiplier must be greater than zero; got ${multiplier}.`,
    );
  }

  const minimum =
    optionalSolOverride(
      args.flags,
      "jito-tip-min-sol",
      "jito-tip-min-lamports",
    ) ??
    optionalSolEnv(["JITO_TIP_MIN_SOL"], ["JITO_TIP_MIN_LAMPORTS"]) ??
    1_000n;
  const maximum =
    optionalSolOverride(
      args.flags,
      "jito-tip-max-sol",
      "jito-tip-max-lamports",
    ) ??
    optionalSolEnv(["JITO_TIP_MAX_SOL"], ["JITO_TIP_MAX_LAMPORTS"]) ??
    1_000_000_000n;
  if (minimum < 1_000n) {
    throw new Error(
      `Jito dynamic tip minimum must be at least 1000 lamports; got ${minimum}.`,
    );
  }
  if (maximum < minimum) {
    throw new Error(
      `Jito dynamic tip maximum ${maximum} is below minimum ${minimum}.`,
    );
  }

  const timeoutMs = numberFlag(
    args.flags,
    "jito-tip-floor-timeout-ms",
    Number(envFirst("JITO_TIP_FLOOR_TIMEOUT_MS") ?? "2500"),
  );
  const maximumAgeMs = numberFlag(
    args.flags,
    "jito-tip-floor-max-age-ms",
    Number(envFirst("JITO_TIP_FLOOR_MAX_AGE_MS") ?? "300000"),
  );
  if (timeoutMs <= 0 || maximumAgeMs <= 0) {
    throw new Error("Jito tip floor timeout and maximum age must be positive.");
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(`Jito tip floor request timed out after ${timeoutMs}ms`),
        ),
      timeoutMs,
    );

    let response: Response;
    try {
      response = await fetch(endpoint, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `Jito tip floor request timed out after ${timeoutMs}ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(
        `Jito tip floor request failed with HTTP ${response.status}: ${detail}`,
      );
    }

    const payload = (await response.json()) as
      JitoTipFloorRow | JitoTipFloorRow[];
    const row = Array.isArray(payload) ? payload[0] : payload;
    if (!row) {
      throw new Error("Jito tip floor response contained no samples.");
    }

    const sampleTime = String(row.time ?? "");
    const sampleTimestamp = Date.parse(sampleTime);
    if (!Number.isFinite(sampleTimestamp)) {
      throw new Error(
        `Jito tip floor response has an invalid time: ${sampleTime}`,
      );
    }

    const sampleAgeMs = Math.max(0, Date.now() - sampleTimestamp);
    if (sampleAgeMs > maximumAgeMs) {
      throw new Error(
        `Jito tip floor sample is stale: age=${sampleAgeMs}ms ` +
          `maximum=${maximumAgeMs}ms.`,
      );
    }

    const rawSol = Number(row[jitoTipField(percentile)]);
    if (!Number.isFinite(rawSol) || rawSol <= 0) {
      throw new Error(
        `Jito tip floor percentile ${percentile} is missing or invalid: ` +
          `${String(rawSol)}`,
      );
    }

    const calculated = BigInt(Math.ceil(rawSol * 1_000_000_000 * multiplier));
    const lamports = clampBigInt(calculated, minimum, maximum);
    return {
      mode: "dynamic",
      source: "tip-floor-rest",
      lamports,
      percentile,
      multiplier,
      rawSol,
      selectedSol: Number(lamports) / 1_000_000_000,
      sampleTime,
      sampleAgeMs,
      endpoint,
    };
  } catch (error) {
    // A dynamic-tip outage must start the bounded auction at the configured
    // minimum, not at the larger fixed-tip fallback.
    const fallbackLamports = minimum;
    const fallbackReason =
      error instanceof Error ? error.message : String(error);

    return {
      mode: "dynamic",
      source: "minimum-fallback",
      lamports: fallbackLamports,
      percentile,
      multiplier,
      selectedSol: Number(fallbackLamports) / 1_000_000_000,
      endpoint,
      fallbackReason,
    };
  }
}

function senderFlag(flags: Flags, key: string, fallback: string): string {
  const value = first(flags, key);
  if (!value) return fallback;
  if (value !== "helius-fast" && value !== "helius-rpc" && value !== "jito") {
    throw new Error(
      `Invalid --${key}: ${value}. Expected helius-fast, helius-rpc, or jito.`,
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
    buyerSender !== "helius-rpc" &&
    buyerSender !== "jito"
  ) {
    throw new Error(
      `Invalid --buyer-sender: ${buyerSender}. Expected helius-fast, helius-rpc, or jito.`,
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
      "SLRD_HELIUS_SENDER_URL",
    ) ??
    base.senderUrl;
  const tipAccount =
    first(flags, "helius-tip-account") ??
    first(flags, "fast-tip-account") ??
    envFirst(
      "HELIUS_TIP_ACCOUNT",
      "SOLWAL_HELIUS_TIP_ACCOUNT",
      "SLRD_HELIUS_TIP_ACCOUNT",
    ) ??
    base.policy.fastTip.account;
  const tipLamports =
    optionalSolOverride(flags, "helius-tip-sol", "helius-tip-lamports") ??
    optionalSolOverride(flags, "fast-tip-sol", "fast-tip-lamports") ??
    optionalSolEnv(
      ["HELIUS_TIP_SOL", "SOLWAL_HELIUS_TIP_SOL", "SLRD_HELIUS_TIP_SOL"],
      [
        "HELIUS_TIP_LAMPORTS",
        "SOLWAL_HELIUS_TIP_LAMPORTS",
        "SLRD_HELIUS_TIP_LAMPORTS",
      ],
    ) ??
    base.policy.fastTip.lamports;

  const jitoUrl =
    first(flags, "jito-block-engine-url") ??
    first(flags, "jito-url") ??
    base.jitoUrl;
  const jitoTipAccount =
    first(flags, "jito-tip-account") ??
    envFirst("JITO_TIP_ACCOUNT") ??
    base.policy.jitoTip.account;
  const jitoTipLamports =
    optionalSolOverride(flags, "jito-tip-sol", "jito-tip-lamports") ??
    optionalSolEnv(["JITO_TIP_SOL"], ["JITO_TIP_LAMPORTS"]) ??
    base.policy.jitoTip.lamports;

  return {
    ...base,
    rpcUrl: first(flags, "rpc-url") ?? envFirst("RPC_ENDPOINT") ?? base.rpcUrl,
    senderUrl,
    jitoUrl,
    cuLimit: numberFlag(flags, "cu-limit", base.cuLimit),
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
      jitoTip:
        jitoTipAccount || jitoTipLamports != null
          ? { account: jitoTipAccount, lamports: jitoTipLamports }
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
    (normalizeTraderSubmitMode(submitMode) === "blind-spam-after-submit" ||
      normalizeTraderSubmitMode(submitMode) === "jito-bundle") &&
    !skipSimulation
  ) {
    throw new Error(
      "Blind parallel dependent-buy submission and Jito bundles require --skip-simulation after a reviewed dry run.",
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
      process.env.SLRD_LAUNCH_SUBMIT_MODE?.trim() ??
      options.defaultSubmitMode,
  );
}

export function spamOptionsFromFlags(
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

    const exactSol =
      stringValue(row, "exactSol") ??
      stringValue(row, "sol") ??
      stringValue(row, "amountSol");
    const exactLamports =
      bigintValue(row, "exactLamports") ??
      bigintValue(row, "lamports") ??
      bigintValue(row, "amountLamports");

    if (exactSol != null && exactLamports != null) {
      throw new Error(
        `Buy plan row ${index + 1} supplies both SOL and lamport exact amounts`,
      );
    }

    const configuredMode =
      stringValue(row, "amountMode") ?? stringValue(row, "mode");
    const amountMode =
      configuredMode ??
      (exactSol != null
        ? "exact-sol"
        : exactLamports != null
          ? "exact-lamports"
          : "range-bps");

    const exactReserveLamports =
      solValue(row, "reserveSol", "reserveLamports") ?? 0n;

    let amount: ExplicitBuyerPlanRow["amount"];
    if (amountMode === "exact-sol" || amountMode === "exact") {
      if (!exactSol)
        throw new Error(
          `Buy plan row ${index + 1} exact-sol mode requires exactSol/amountSol`,
        );
      amount = {
        kind: "exact-sol",
        sol: exactSol,
        reserveLamports: exactReserveLamports,
      };
    } else if (amountMode === "exact-lamports" || amountMode === "lamports") {
      if (exactLamports == null)
        throw new Error(
          `Buy plan row ${index + 1} exact-lamports mode requires exactLamports/amountLamports`,
        );
      amount = {
        kind: "exact-lamports",
        lamports: exactLamports,
        reserveLamports: exactReserveLamports,
      };
    } else {
      if (exactSol != null || exactLamports != null) {
        throw new Error(
          `Buy plan row ${index + 1} exact amount conflicts with amountMode ${amountMode}`,
        );
      }
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
        cuLimit: numberValue(row, "cuLimit"),
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
  slrd: Solard;
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
  let traders = explicitBuyPlan
    ? await loadExplicitBuyerAllocations({
        slrd: args.slrd,
        rows: explicitBuyPlan,
        excludeWallet: args.creator,
      })
    : group
      ? await loadGroupBuyerAllocations({
          slrd: args.slrd,
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

  const effectiveSubmitMode = normalizeTraderSubmitMode(
    first(args.flags, "submit-mode") ?? env.submitMode,
  );
  const jitoTipLamports = env.policy.jitoTip.lamports ?? 0n;
  if (
    effectiveSubmitMode === "jito-bundle" &&
    traders.length > 0 &&
    jitoTipLamports > 0n
  ) {
    const finalIndex = traders.length - 1;
    const finalTrader = traders[finalIndex]!;
    const reserveLamports = finalTrader.reserveLamports + jitoTipLamports;
    const spendLamports =
      finalTrader.selectedBps == null
        ? finalTrader.spendLamports
        : ((finalTrader.balanceLamports - reserveLamports) *
            BigInt(finalTrader.selectedBps)) /
          10_000n;
    if (
      spendLamports <= 0n ||
      finalTrader.balanceLamports < spendLamports + reserveLamports
    ) {
      throw new Error(
        `Final Jito buyer ${finalTrader.address} cannot cover buy, reserve, and tip: balance=${finalTrader.balanceLamports} spend=${spendLamports} reserve=${finalTrader.reserveLamports} jitoTip=${jitoTipLamports}`,
      );
    }
    traders = traders.map((trader, index) =>
      index === finalIndex
        ? { ...trader, reserveLamports, spendLamports }
        : trader,
    );
  }

  return await preparePumpTokenLaunch({
    slrd: args.slrd,
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
  const hasExplicitBuyPlan = Boolean(
    first(flags, "buy-plan") || first(flags, "buy-plan-json"),
  );
  const hasBuyers = Boolean(group) || hasExplicitBuyPlan;
  const deployOnly = enabled(flags, "deploy-only");
  if (deployOnly && hasBuyers) {
    throw new Error(
      "--deploy-only cannot be combined with --buyer-group, --buy-plan, or --buy-plan-json. Armed buyers must own the follower plan.",
    );
  }
  const configuredEnv = pumpLaunchEnvironmentFromFlags(flags);
  const submitMode = resolveSubmitMode(flags, options);
  let env: PumpLaunchEnvironment =
    submitMode === "jito-bundle"
      ? {
          ...configuredEnv,
          policy: {
            ...configuredEnv.policy,
            deploymentSender: "jito",
            evolutionSender: "jito",
            fastTraderSender: "jito",
            rpcTraderSender: "jito",
            fastTraderCount: Number.MAX_SAFE_INTEGER,
          },
        }
      : configuredEnv;
  const spam = spamOptionsFromFlags(flags, env.spam);
  const usesHeliusSender = usesHeliusSenderForLaunch(env, hasBuyers);
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

  if (submitMode === "jito-bundle") {
    if (!hasBuyers) {
      throw new Error(
        "jito-bundle requires at least one buyer in --buy-plan, --buy-plan-json, or --buyer-group.",
      );
    }
    if (!env.jitoUrl) {
      throw new Error(
        "jito-bundle requires --jito-block-engine-url or JITO_BLOCK_ENGINE_URL.",
      );
    }
  }

  requireSkipSimulationForBlindLiveBuys(
    live,
    submitMode,
    skipSimulation,
    hasBuyers,
  );

  const { uri, uploaded } = await resolveMetadataUri(flags, input);
  const cashback = enabled(flags, "cashback", "SOLARD_LAUNCH_CASHBACK");
  const mayhemMode = enabled(flags, "mayhem", "SOLARD_LAUNCH_MAYHEM");
  const vanityPoolSuffixRaw = nonEmpty(first(flags, "mint-pool"));
  const vanityPoolAddress = nonEmpty(first(flags, "mint-pool-address"));
  if (vanityPoolAddress && !vanityPoolSuffixRaw) {
    throw new Error("--mint-pool-address requires --mint-pool <suffix>.");
  }
  if (vanityPoolSuffixRaw && first(flags, "mint-keypair")) {
    throw new Error("Use either --mint-pool or --mint-keypair, not both.");
  }

  const vanityPoolSuffix = vanityPoolSuffixRaw
    ? cleanVanitySuffix(vanityPoolSuffixRaw)
    : null;
  const configuredVanitySuffix = vanitySuffixFromFlags(flags);
  if (
    vanityPoolSuffix &&
    configuredVanitySuffix &&
    vanityPoolSuffix !== configuredVanitySuffix
  ) {
    throw new Error(
      `--mint-pool suffix ${vanityPoolSuffix} conflicts with configured mint suffix ${configuredVanitySuffix}.`,
    );
  }

  const vanityMintSuffix = vanityPoolSuffix ?? configuredVanitySuffix;
  const pregeneratedMint = loadMintKeypairFromFlags(flags, vanityMintSuffix);
  let poolReservation: VanityMintPoolReservation | null = null;
  let vanityMint: Keypair | undefined = pregeneratedMint?.mint;
  let vanityMintAttempts: number | null = pregeneratedMint ? 0 : null;
  let vanityMintElapsedMs: number | null = pregeneratedMint ? 0 : null;

  if (pregeneratedMint) {
    report("pregenerated mint loaded", {
      mint: pregeneratedMint.address,
      keypairPath: pregeneratedMint.path,
      suffix: vanityMintSuffix,
      attempts: 0,
      elapsedMs: 0,
    });
  } else if (vanityMintSuffix && !vanityPoolSuffix) {
    const maxAttempts = numberFlag(
      flags,
      "vanity-max-attempts",
      envNumber(
        "SOLARD_VANITY_MINT_MAX_ATTEMPTS",
        defaultVanityMaxAttempts(vanityMintSuffix),
      ),
    );
    const timeoutMs = numberFlag(
      flags,
      "vanity-timeout-ms",
      envNumber("SOLARD_VANITY_MINT_TIMEOUT_MS", 0),
    );
    const reportEvery = numberFlag(
      flags,
      "vanity-report-every",
      envNumber("SOLARD_VANITY_MINT_REPORT_EVERY", 10_000),
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

  const armedEndpointValues = flags.get("armed-buyer") ?? [];
  const armedEndpoints = armedEndpointValues.map(parseArmedBuyerEndpoint);
  const armedSession = first(flags, "session")?.trim() ?? "";
  if (armedEndpoints.length > 1) {
    throw new Error(
      "v57 accepts one --armed-buyer endpoint containing the complete buy plan, so worst-case quotes include every buyer.",
    );
  }
  if (armedEndpoints.length > 0 && !armedSession) {
    throw new Error("--session is required when --armed-buyer is used.");
  }
  if (armedEndpoints.length > 0 && !deployOnly) {
    throw new Error("--armed-buyer requires --deploy-only.");
  }
  if (armedEndpoints.length > 0 && !live) {
    throw new Error("--armed-buyer release is live-only.");
  }

  let jitoTipSelection: JitoTipSelection | null = null;
  if (submitMode === "jito-bundle") {
    jitoTipSelection = await resolveJitoBundleTip({
      flags,
      configuredLamports: env.policy.jitoTip.lamports ?? 100_000n,
    });
    env = {
      ...env,
      policy: {
        ...env.policy,
        jitoTip: {
          ...env.policy.jitoTip,
          lamports: jitoTipSelection.lamports,
        },
      },
    };
    validateJitoTip({
      tip: env.policy.jitoTip,
      live,
      label: "Pump Jito bundle",
    });
    if (jitoTipSelection.source === "minimum-fallback") {
      report("jito tip floor fallback", {
        endpoint: jitoTipSelection.endpoint,
        reason: jitoTipSelection.fallbackReason,
        startingLamports: jitoTipSelection.lamports.toString(),
        selectedSol: jitoTipSelection.selectedSol,
        policy: "start-at-minimum-and-escalate-fresh-generations",
      });
    }

    report("jito tip selected", {
      ...jitoTipSelection,
      lamports: jitoTipSelection.lamports.toString(),
    });
  }

  if (!vanityMint && vanityPoolSuffix) {
    poolReservation = reserveVanityMintFromPool(vanityPoolSuffix, {
      address: vanityPoolAddress,
      reason: live ? "pump-launch-live" : "pump-launch-dry-run",
    });
    vanityMint = poolReservation.mint;
    vanityMintAttempts = 0;
    vanityMintElapsedMs = 0;
    report("vanity mint pool reserved", {
      mint: poolReservation.address,
      suffix: poolReservation.suffix,
      status: poolReservation.status,
      live,
    });
  }

  const slrd = createTraderSolard({ rpcUrl: env.rpcUrl });
  installPumpLaunchSenders(slrd, env);

  if (vanityMint) {
    await assertPumpMintIsUnused({
      slrd,
      mint: vanityMint.publicKey,
      report,
    });
  }

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
      slrd,
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
            imageUri: uploaded.imageUri ?? null,
            website: input.website ?? null,
            twitter: input.twitter ?? null,
            telegram: input.telegram ?? null,
            video: input.video ?? null,
            showName: input.showName ?? true,
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
        jitoUrl: submitMode === "jito-bundle" ? env.jitoUrl : null,
        jitoTipLamports:
          submitMode === "jito-bundle"
            ? (env.policy.jitoTip.lamports ?? null)
            : null,
        jitoTipSelection,
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

    const armedMint = prepared.deployment.mint.publicKey.toBase58();
    const armedTimeoutMs = numberFlag(flags, "armed-timeout-ms", 1_000);

    if (armedEndpoints.length > 0) {
      await assertArmedBuyerEndpointsReady({
        endpoints: armedEndpoints,
        session: armedSession,
        mint: armedMint,
        timeoutMs: armedTimeoutMs,
      });
      report("pump armed buyers ready", {
        session: armedSession,
        mint: armedMint,
        endpoints: armedEndpoints.map((endpoint) => ({
          label: endpoint.label,
          address: `${endpoint.host}:${endpoint.port}`,
        })),
      });
    }

    const result = await executePumpTokenLaunch({
      slrd,
      prepared,
      live,
      traderSubmitMode: submitMode,
      skipSimulation,
      spam,
      kind: `cli:launch:pump:${input.alias}`,
      reporter: report,
      beforeDeploymentBroadcast:
        armedEndpoints.length > 0
          ? async () => {
              await releaseArmedBuyerEndpoints({
                endpoints: armedEndpoints,
                session: armedSession,
                mint: armedMint,
                timeoutMs: armedTimeoutMs,
                reporter: report,
              });
            }
          : undefined,
      onDeploymentBroadcastFailure:
        armedEndpoints.length > 0
          ? async (error) => {
              await abortArmedBuyerEndpoints({
                endpoints: armedEndpoints,
                session: armedSession,
                mint: armedMint,
                reason: error instanceof Error ? error.message : String(error),
                reporter: report,
              });
            }
          : undefined,
    });

    if (poolReservation && live) {
      const used = markVanityMintUsed(poolReservation.address);
      report("vanity mint pool used", {
        mint: used.address,
        suffix: used.suffix,
        status: used.status,
      });
    }

    if (live && persistOnLive && prepared) {
      try {
        slrd.persistPreparedDeployment(prepared.deployment, input.alias);
      } catch {
        // The launch already succeeded. Persistence is best-effort and must not
        // alter the on-chain result.
      }
    }

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
        jitoUrl: submitMode === "jito-bundle" ? env.jitoUrl : null,
        jitoTipLamports:
          submitMode === "jito-bundle"
            ? (env.policy.jitoTip.lamports ?? null)
            : null,
        jitoTipSelection,
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
    // Dry runs never consume a pooled mint. Live failures intentionally leave
    // it RESERVED because a bundle can be ambiguous even when local tracking
    // fails. Release it manually only after on-chain preflight confirms unused.
    if (poolReservation && !live) {
      try {
        releaseVanityMintReservation(poolReservation.address);
      } catch {
        // Preserve the primary launch/simulation result.
      }
    }

    // Never persist from finally: preflight, simulation, and bundle submission
    // failures must leave the token registry untouched.
    slrd.close();
  }
}

export function formatCliError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}
