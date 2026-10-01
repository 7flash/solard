import {
  executeJupiterSwap,
  NATIVE_SOL_MINT,
  nativePumpTradeAvailable,
  quoteJupiterSwap,
  resolveTradeRoute,
  sol,
  type SenderId,
  type Solard,
} from "@solard/core";

import { resolveTradeTargets, type TradeTargets } from "./trade-targets.ts";
import { tradeFeeOptions } from "./trade-fees.ts";
import { summarizeTradeRoute, type TradeRouteSummary } from "./trade-result.ts";
import { parseVenuePreference, type TradeCommandFlags } from "./trade-venue.ts";

export type SmartBuyCommandResult =
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
      amountSol: string;
      quote: Awaited<ReturnType<typeof quoteJupiterSwap>>;
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
      results: Array<{
        wallet: string;
        result: Awaited<ReturnType<typeof executeJupiterSwap>>;
      }>;
    };

type RunSmartBuyCommandArgs = {
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

export async function runSmartBuyCommand({
  slrd,
  values,
  flags,
}: RunSmartBuyCommandArgs): Promise<SmartBuyCommandResult> {
  const tokenRef = values[0];
  const usage =
    "Usage: slrd buy <token|ca> (--wallet <wallet> | --wallets <w1,w2> | --group <group>) --sol <amount> [--venue auto|native|jupiter]";
  if (!tokenRef) throw new Error(usage);

  const amountSol = flags.get("sol");
  if (!amountSol || amountSol === "true") {
    throw new Error("Buy requires explicit --sol <amount>");
  }

  const amount = sol(amountSol);
  if (amount.raw <= 0n) throw new Error("--sol must be greater than zero");

  const target = resolveTradeTargets(slrd, flags, usage);
  const resolution = await resolveTradeRoute(
    slrd,
    tokenRef,
    parseVenuePreference(flags),
  );

  if (resolution.asset.mint === NATIVE_SOL_MINT) {
    throw new Error(
      "slrd buy expects an SPL token; SOL is already the input asset",
    );
  }

  if (resolution.route === "native") {
    if (!nativePumpTradeAvailable(resolution.token)) {
      throw new Error(
        "Native buy requires a registered Pump/PumpSwap token; use --venue jupiter for ordinary SPL assets",
      );
    }

    const options = {
      ...tradeFeeOptions(flags),
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
                .buy(resolution.token!.mint, amount, options)
                .build(),
            ]
          : await slrd
              .composeMany(target.refs)
              .priorityFee(options.priorityFee)
              .buy(resolution.token!.mint, amount, options)
              .build();
      const results = await Promise.all(
        plans.map(async (plan, index) => {
          const prepared = await slrd.prepareTradePlan(target.refs[index]!, plan, options);
          return { ...await slrd.simulatePlan(prepared.plan),
            priorityMicroLamports: prepared.priorityMicroLamports,
            cuLimit: prepared.plan.draft.cuLimit ?? 600_000 };
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
        ? await slrd.buy(
            resolution.token!.mint,
            target.refs[0]!,
            amount,
            options,
          )
        : await slrd.buyMany(
            resolution.token!.mint,
            target.refs,
            amount,
            options,
          );

    return {
      mode: "live",
      route: "native",
      target,
      routing: summarizeTradeRoute(resolution),
      receipts,
    };
  }

  if (flags.has("simulate-only")) {
    const quote = await quoteJupiterSwap({
      inputMint: NATIVE_SOL_MINT,
      outputMint: resolution.asset.mint,
      amountRaw: amount.raw,
    });
    return {
      mode: "quote",
      route: "jupiter",
      target,
      routing: summarizeTradeRoute(resolution),
      amountSol,
      quote,
      hint: "Remove --simulate-only to execute this Jupiter-routed buy.",
    };
  }

  // Jupiter transport has its own measured, instance-scoped rate limiter. Keep
  // multi-wallet execution sequential so a one-shot CLI command cannot create
  // an avoidable burst against the API.
  const results: Array<{
    wallet: string;
    result: Awaited<ReturnType<typeof executeJupiterSwap>>;
  }> = [];
  for (const wallet of target.refs) {
    results.push({
      wallet,
      result: await executeJupiterSwap({
        inputMint: NATIVE_SOL_MINT,
        outputMint: resolution.asset.mint,
        amountRaw: amount.raw,
        signer: slrd.signer(wallet),
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
