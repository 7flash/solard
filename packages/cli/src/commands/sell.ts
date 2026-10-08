import {
  executeJupiterSwap,
  NATIVE_SOL_MINT,
  nativePumpTradeAvailable,
  quoteJupiterSwap,
  resolveTradeRoute,
  type SenderId,
  type Solard,
} from "@solard/core";

import { resolveTradeTargets, type TradeTargets } from "./trade-targets.ts";
import { tradeFeeOptions } from "./trade-fees.ts";
import { summarizeTradeRoute, type TradeRouteSummary } from "./trade-result.ts";
import { parseVenuePreference, type TradeCommandFlags } from "./trade-venue.ts";

export type JupiterSellWalletPlan = {
  wallet: string;
  balanceRaw: bigint;
  amountRaw: bigint;
};

export type SmartSellCommandResult =
  | {
      mode: "simulation";
      route: "native";
      target: TradeTargets;
      routing: TradeRouteSummary;
      results: unknown[];
    }
  | {
      mode: "quote";
      route: "jupiter";
      target: TradeTargets;
      routing: TradeRouteSummary;
      plans: Array<
        JupiterSellWalletPlan & {
          quote: Awaited<ReturnType<typeof quoteJupiterSwap>>;
        }
      >;
      hint: string;
    }
  | {
      mode: "live";
      route: "native";
      target: TradeTargets;
      routing: TradeRouteSummary;
      receipts: unknown;
    }
  | {
      mode: "live";
      route: "jupiter";
      target: TradeTargets;
      routing: TradeRouteSummary;
      results: Array<
        JupiterSellWalletPlan & {
          result: Awaited<ReturnType<typeof executeJupiterSwap>>;
        }
      >;
    };

type RunSmartSellCommandArgs = {
  slrd: Solard;
  values: string[];
  flags: TradeCommandFlags;
};

function intFlag(
  flags: TradeCommandFlags,
  key: string,
  fallback: number,
): number {
  const value = flags.get(key);
  if (!value || value === "true") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`--${key} must be an integer`);
  return parsed;
}

export async function jupiterSellableAtaBalance(
  slrd: Solard,
  walletRef: string,
  mint: string,
): Promise<bigint> {
  const accounts = await slrd.tokenAccounts(walletRef);
  let associatedRaw = 0n;

  for (const account of accounts) {
    if (
      account.mint === mint &&
      account.isAssociated &&
      account.amountRaw > 0n
    ) {
      associatedRaw += account.amountRaw;
    }
  }

  return associatedRaw;
}

async function jupiterSellPlan(
  slrd: Solard,
  wallet: string,
  mint: string,
  bps: number,
): Promise<JupiterSellWalletPlan> {
  const balanceRaw = await jupiterSellableAtaBalance(slrd, wallet, mint);
  const amountRaw = (balanceRaw * BigInt(bps)) / 10_000n;
  if (amountRaw <= 0n) {
    throw new Error(`No sellable associated-token-account balance for ${mint}`);
  }
  return { wallet, balanceRaw, amountRaw };
}

export async function runSmartSellCommand({
  slrd,
  values,
  flags,
}: RunSmartSellCommandArgs): Promise<SmartSellCommandResult> {
  const tokenRef = values[0];
  const usage =
    "Usage: slrd sell <token|ca> (--wallet <wallet> | --wallets <w1,w2> | --group <group>) [--bps 10000] [--venue auto|native|jupiter]";
  if (!tokenRef) throw new Error(usage);

  const bps = intFlag(flags, "bps", 10_000);
  if (bps <= 0 || bps > 10_000) throw new Error("--bps must be 1..10000");

  const target = resolveTradeTargets(slrd, flags, usage);
  const resolution = await resolveTradeRoute(
    slrd,
    tokenRef,
    parseVenuePreference(flags),
  );

  if (resolution.asset.mint === NATIVE_SOL_MINT) {
    throw new Error("slrd sell expects an SPL token");
  }

  if (resolution.route === "native") {
    if (!nativePumpTradeAvailable(resolution.token)) {
      throw new Error(
        "Native sell requires a registered Pump/PumpSwap token; use --venue jupiter for ordinary SPL assets",
      );
    }

    const options = {
      ...tradeFeeOptions(flags),
      bps,
      slippageBps: intFlag(flags, "slippage-bps", 1_500),
      via: (flags.get("sender") ?? "rpc") as SenderId,
      skipSimulation: flags.has("skip-simulation"),
      skipPreflight:
        flags.has("skip-preflight") || flags.has("skip-simulation"),
    };

    if (flags.has("simulate-only")) {
      const plans =
        target.refs.length === 1
          ? [
              await slrd
                .tx(target.refs[0]!)
                .priorityFee(options.priorityFee)
                .sell(resolution.token!.mint, options)
                .build(),
            ]
          : await slrd
              .composeMany(target.refs)
              .priorityFee(options.priorityFee)
              .sell(resolution.token!.mint, options)
              .build();
      const results = await Promise.all(
        plans.map(async (plan, index) => {
          const prepared = await slrd.prepareTradePlan(
            target.refs[index]!,
            plan,
            options,
          );
          return {
            ...(await slrd.simulatePlan(prepared.plan)),
            priorityMicroLamports: prepared.priorityMicroLamports,
            cuLimit: prepared.plan.draft.cuLimit ?? 600_000,
          };
        }),
      );
      return {
        mode: "simulation",
        route: "native",
        target,
        routing: summarizeTradeRoute(resolution),
        results,
      };
    }

    const receipts =
      target.refs.length === 1
        ? await slrd.sell(resolution.token!.mint, target.refs[0]!, options)
        : await slrd.sellMany(resolution.token!.mint, target.refs, options);

    return {
      mode: "live",
      route: "native",
      target,
      routing: summarizeTradeRoute(resolution),
      receipts,
    };
  }

  const plans: JupiterSellWalletPlan[] = [];
  for (const wallet of target.refs) {
    plans.push(await jupiterSellPlan(slrd, wallet, resolution.asset.mint, bps));
  }

  if (flags.has("simulate-only")) {
    const quoted = [];
    for (const plan of plans) {
      quoted.push({
        ...plan,
        quote: await quoteJupiterSwap({
          inputMint: resolution.asset.mint,
          outputMint: NATIVE_SOL_MINT,
          amountRaw: plan.amountRaw,
        }),
      });
    }
    return {
      mode: "quote",
      route: "jupiter",
      target,
      routing: summarizeTradeRoute(resolution),
      plans: quoted,
      hint: "Remove --simulate-only to execute these Jupiter-routed sells.",
    };
  }

  const results = [];
  for (const plan of plans) {
    results.push({
      ...plan,
      result: await executeJupiterSwap({
        inputMint: resolution.asset.mint,
        outputMint: NATIVE_SOL_MINT,
        amountRaw: plan.amountRaw,
        signer: slrd.signer(plan.wallet),
      }),
    });
  }

  return {
    mode: "live",
    route: "jupiter",
    target,
    routing: summarizeTradeRoute(resolution),
    results,
  };
}
