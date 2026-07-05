import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
  loadGroupBuyerAllocations,
  normalizeTraderSubmitMode,
  preparePumpTokenLaunch,
  pumpLaunchEnvironment,
  usesHeliusSenderForLaunch,
  validateHeliusTip,
  type LaunchReporter,
  type PumpTokenLaunchPlan,
  type PumpTokenLaunchResult,
  type TokenMetadata,
  type TraderSubmitMode,
} from "./token-launch.js";

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
  transport: Record<string, unknown>;
  token: PumpTokenMetadataInput & {
    uri: string;
    metadataUri: string;
    mint: string;
    feeMode: "creator-fees";
    cashback: false;
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
    if (!input.description)
      throw new Error(`Token ${input.alias} has imagePath but no description.`);
    uploaded = await uploadPumpMetadata(
      {
        imagePath: input.imagePath,
        name: input.name,
        symbol: input.symbol,
        description: input.description,
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
      "Provide --uri <metadata-uri> or --metadata <json> / --image <path> with a description.",
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
      process.env.SOWL_LAUNCH_SUBMIT_MODE?.trim() ??
      options.defaultSubmitMode,
  );
}

export async function preparePumpTokenLaunchFromFlags(args: {
  sowl: Sowl;
  flags: Flags;
  token: TokenMetadata;
  creator: string;
  options?: PumpTokenLaunchCliOptions;
}): Promise<PumpTokenLaunchPlan> {
  const options = args.options ?? {};
  const group = first(args.flags, "buyer-group");
  const env = pumpLaunchEnvironment();
  const traders = group
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
  });
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
  const env = pumpLaunchEnvironment();
  const submitMode = resolveSubmitMode(flags, options);
  const usesHeliusSender = usesHeliusSenderForLaunch(env, Boolean(group));
  const persistOnLive = options.persistOnLive ?? true;

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
  const sowl = createTraderSowl({ rpcUrl: env.rpcUrl });
  installPumpLaunchSenders(sowl, env);

  let prepared: PumpTokenLaunchPlan | null = null;
  try {
    const token: TokenMetadata = {
      alias: input.alias,
      name: input.name,
      symbol: input.symbol,
      uri,
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
      options,
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
      cashback: false,
      creatorBuyLamports: optionalSol(
        flags,
        "creator-buy-sol",
        "creator-buy-lamports",
        0n,
      ),
      buyerGroup: group ?? null,
      transport: {
        usesHeliusSender,
        priorityMicroLamports: deploymentPriorityMicroLamports,
        buyerPriorityMicroLamports,
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
        retry: env.spam,
      },
      participants: prepared.expectedOutputByWallet,
    });

    const result = await executePumpTokenLaunch({
      sowl,
      prepared,
      live,
      traderSubmitMode: submitMode,
      skipSimulation,
      spam: env.spam,
      kind: `script:launch-pump-token:${input.alias}`,
      reporter: report,
    });

    const output: PumpTokenLaunchCliResult = {
      createdAt: new Date().toISOString(),
      live,
      creator,
      buyerGroup: group ?? null,
      transport: {
        usesHeliusSender,
        priorityMicroLamports: deploymentPriorityMicroLamports,
        buyerPriorityMicroLamports,
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
        cashback: false,
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
