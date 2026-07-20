import { PublicKey } from "@solana/web3.js";

import { sol } from "../../core/amounts.ts";
import { createTraderSolard } from "../../presets/trader.ts";
import type { SenderId } from "../../tx/types.ts";
import {
  installPumpLaunchSenders,
  loadExplicitBuyerAllocations,
  validateHeliusTip,
  type ExplicitBuyerAmount,
  type ExplicitBuyerPlanRow,
  type LaunchReporter,
} from "./token-launch.ts";
import {
  bigintFlag,
  enabled,
  first,
  json,
  numberFlag,
  parseArgs,
  pumpLaunchEnvironmentFromFlags,
  required,
} from "./token-launch-cli.ts";
import {
  runPumpSpamBuyers,
  type PumpSpamBuyRunResult,
  type PumpSpamBuySettings,
} from "./spam-buy.ts";

export type PumpSpamBuyCliOptions = {
  report?: LaunchReporter;
};

function defaultReport(label: string, value: unknown): void {
  console.log(`${label}: ${json(value)}`);
}

function selectedMint(
  flags: ReturnType<typeof parseArgs>["flags"],
  positionals: string[],
): string {
  const values = positionals[0] === "pump" ? positionals.slice(1) : positionals;
  const positionalMint = values[0];
  const flagMint = first(flags, "mint");
  const mint = flagMint && flagMint !== "true" ? flagMint : positionalMint;
  if (!mint) {
    throw new Error(
      "Usage: bun run scripts/spam-pump-buyers.ts --mint <mint> (--wallet <wallet> | --group <group>) --amount-mode <range-bps|exact-sol|exact-lamports> [amount flags] [--live]",
    );
  }
  if (flagMint && positionalMint && flagMint !== positionalMint) {
    throw new Error(
      `Conflicting mint values: --mint ${flagMint} and positional ${positionalMint}`,
    );
  }
  return new PublicKey(mint).toBase58();
}

function amountFromFlags(
  flags: ReturnType<typeof parseArgs>["flags"],
): ExplicitBuyerAmount {
  const requestedMode = first(flags, "amount-mode")?.trim().toLowerCase();
  const exactSol = first(flags, "sol") ?? first(flags, "exact-sol");
  const exactLamports =
    first(flags, "lamports") ?? first(flags, "exact-lamports");
  const hasRangeFlags =
    flags.has("min-bps") ||
    flags.has("max-bps") ||
    flags.has("buyer-min-bps") ||
    flags.has("buyer-max-bps");

  const inferredMode =
    exactSol != null
      ? "exact-sol"
      : exactLamports != null
        ? "exact-lamports"
        : hasRangeFlags
          ? "range-bps"
          : null;
  const modeAliases: Record<
    string,
    "range-bps" | "exact-sol" | "exact-lamports"
  > = {
    "range-bps": "range-bps",
    range: "range-bps",
    "balance-bps": "range-bps",
    "exact-sol": "exact-sol",
    sol: "exact-sol",
    "exact-lamports": "exact-lamports",
    lamports: "exact-lamports",
  };
  if (requestedMode && !modeAliases[requestedMode]) {
    throw new Error(
      `Invalid --amount-mode ${requestedMode}. Use range-bps, exact-sol, or exact-lamports.`,
    );
  }
  const mode = requestedMode ? modeAliases[requestedMode] : inferredMode;

  if (!mode) {
    throw new Error(
      "Missing amount configuration. Use --amount-mode range-bps with --min-bps/--max-bps, --amount-mode exact-sol with --sol, or --amount-mode exact-lamports with --lamports.",
    );
  }
  if (inferredMode && mode !== inferredMode) {
    throw new Error(
      `--amount-mode ${requestedMode} conflicts with the supplied amount flags.`,
    );
  }

  if (mode === "exact-sol") {
    if (exactSol == null || exactSol === "true") {
      throw new Error("--amount-mode exact-sol requires --sol <amount>.");
    }
    return { kind: "exact-sol", sol: exactSol };
  }

  if (mode === "exact-lamports") {
    if (exactLamports == null || exactLamports === "true") {
      throw new Error(
        "--amount-mode exact-lamports requires --lamports <amount>.",
      );
    }
    return {
      kind: "exact-lamports",
      lamports: BigInt(exactLamports),
    };
  }

  const minKey = flags.has("min-bps") ? "min-bps" : "buyer-min-bps";
  const maxKey = flags.has("max-bps") ? "max-bps" : "buyer-max-bps";
  if (!flags.has(minKey) || !flags.has(maxKey)) {
    throw new Error(
      "--amount-mode range-bps requires both --min-bps <n> and --max-bps <n>.",
    );
  }

  const reserveLamports = flags.has("reserve-lamports")
    ? bigintFlag(flags, "reserve-lamports", 0n)
    : flags.has("buyer-reserve-lamports")
      ? bigintFlag(flags, "buyer-reserve-lamports", 0n)
      : sol(
          first(flags, "reserve-sol") ??
            first(flags, "buyer-reserve-sol") ??
            "0.01",
        ).raw;

  return {
    kind: "balance-bps",
    minBps: numberFlag(flags, minKey, 0),
    maxBps: numberFlag(flags, maxKey, 0),
    reserveLamports,
  };
}

function buyerRows(args: {
  flags: ReturnType<typeof parseArgs>["flags"];
  amount: ExplicitBuyerAmount;
}): ExplicitBuyerPlanRow[] {
  const wallet = first(args.flags, "wallet");
  const group = first(args.flags, "group");
  if (Boolean(wallet) === Boolean(group)) {
    throw new Error(
      "Supply exactly one of --wallet <wallet> or --group <group>.",
    );
  }

  if (wallet) return [{ wallet, amount: args.amount }];

  // Group expansion is intentionally deferred until Solard is available below.
  return [{ wallet: `group:${group}`, amount: args.amount }];
}

function settingsFromFlags(args: {
  flags: ReturnType<typeof parseArgs>["flags"];
  sender: SenderId;
  tipAccount?: string;
  tipLamports?: bigint;
  defaults: ReturnType<typeof pumpLaunchEnvironmentFromFlags>;
}): PumpSpamBuySettings {
  return {
    sender: args.sender,
    tip:
      String(args.sender) === "helius-fast" &&
      args.tipAccount &&
      args.tipLamports != null
        ? { account: args.tipAccount, lamports: args.tipLamports }
        : {},
    cuLimit: numberFlag(args.flags, "cu-limit", args.defaults.cuLimit),
    priorityMicroLamports: numberFlag(
      args.flags,
      "priority-micro-lamports",
      args.defaults.priorityMicroLamports,
    ),
    slippageBps: numberFlag(args.flags, "slippage-bps", 1_500),
    discoveryIntervalMs: numberFlag(args.flags, "discovery-interval-ms", 25),
    retryIntervalMs: numberFlag(
      args.flags,
      "retry-interval-ms",
      args.defaults.spam.intervalMs,
    ),
    recompileIntervalMs: numberFlag(
      args.flags,
      args.flags.has("recompile-interval-ms")
        ? "recompile-interval-ms"
        : "retry-recompile-interval-ms",
      args.defaults.spam.recompileIntervalMs ?? 750,
    ),
    freshQuoteIntervalMs: numberFlag(
      args.flags,
      "fresh-quote-delay-ms",
      args.defaults.spam.freshQuoteDelayMs ?? 2_500,
    ),
    timeoutMs: numberFlag(
      args.flags,
      args.flags.has("timeout-ms") ? "timeout-ms" : "retry-timeout-ms",
      0,
    ),
    maxFailedAttempts: numberFlag(
      args.flags,
      "max-failed-attempts",
      args.defaults.spam.maxFailedAttempts,
    ),
  };
}

export async function runPumpSpamBuyFromArgs(
  argv: string[],
  options: PumpSpamBuyCliOptions = {},
): Promise<PumpSpamBuyRunResult> {
  const { flags, positionals } = parseArgs(argv);
  const report = options.report ?? defaultReport;
  const mint = selectedMint(flags, positionals);
  const amount = amountFromFlags(flags);
  const requestedRows = buyerRows({ flags, amount });
  const env = pumpLaunchEnvironmentFromFlags(flags);
  const sender = (first(flags, "sender") ??
    first(flags, "buyer-sender") ??
    String(env.policy.rpcTraderSender)) as SenderId;
  const live = enabled(flags, "live", "LIVE");

  const tipAccount =
    first(flags, "tip-account") ??
    first(flags, "helius-tip-account") ??
    env.policy.fastTip.account;
  const tipLamports = flags.has("tip-lamports")
    ? bigintFlag(flags, "tip-lamports", 0n)
    : flags.has("tip-sol")
      ? sol(required(flags, "tip-sol")).raw
      : env.policy.fastTip.lamports;

  if (String(sender) === "helius-fast") {
    if (!env.senderUrl) {
      throw new Error(
        "--sender helius-fast requires HELIUS_SENDER_URL or --helius-sender-url.",
      );
    }
    validateHeliusTip({
      tip: { account: tipAccount, lamports: tipLamports },
      endpoint: env.senderUrl,
      live,
      label: "Pump spam buyer",
    });
  }

  const slrd = createTraderSolard({ rpcUrl: env.rpcUrl });
  installPumpLaunchSenders(slrd, env);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    const rows = requestedRows[0]!.wallet.toString().startsWith("group:")
      ? slrd
          .groupWallets(requestedRows[0]!.wallet.toString().slice(6))
          .map((wallet): ExplicitBuyerPlanRow => ({ wallet, amount }))
      : requestedRows;
    const buyers = await loadExplicitBuyerAllocations({ slrd, rows });
    const settings = settingsFromFlags({
      flags,
      sender,
      tipAccount,
      tipLamports,
      defaults: env,
    });

    report("pump spam-buy plan", {
      mint,
      live,
      buyers: buyers.map((buyer) => ({
        wallet: buyer.address,
        balanceLamports: buyer.balanceLamports,
        reserveLamports: buyer.reserveLamports,
        selectedBps: buyer.selectedBps,
        spendLamports: buyer.spendLamports,
      })),
      settings,
    });

    const result = await runPumpSpamBuyers({
      slrd,
      mint,
      buyers,
      settings,
      live,
      signal: controller.signal,
      reporter: report,
    });
    report("pump spam-buy result", result);
    return result;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    slrd.close();
  }
}
