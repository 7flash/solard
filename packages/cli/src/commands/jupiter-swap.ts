import { PublicKey } from "@solana/web3.js";
import {
  executeJupiterSwap,
  formatRaw,
  quoteJupiterSwap,
  RaydiumService,
  resolveTradeAsset,
  sol,
  tokenAmount,
  type JupiterSwapExecuteResult,
  type JupiterSwapQuote,
  type Solard,
  type TradeAsset,
} from "@solard/sdk";

export type JupiterSwapCliFlags = ReadonlyMap<string, string>;

export type JupiterCliAsset = TradeAsset;

export type JupiterSwapCliRequest = {
  wallet: string;
  fromRef: string;
  toRef: string;
  amountUi: string;
  live: boolean;
};

export type JupiterSwapQuoteCommandResult = {
  mode: "quote";
  wallet: string;
  input: JupiterCliAsset & { amountUi: string; amountRaw: bigint };
  output: JupiterCliAsset & { expectedOutputUi: string };
  quote: JupiterSwapQuote;
  hint: string;
};

export type JupiterSwapLiveCommandResult = {
  mode: "live";
  wallet: string;
  input: JupiterCliAsset & { amountUi: string; amountRaw: bigint };
  output: JupiterCliAsset;
  result: JupiterSwapExecuteResult;
};

export type JupiterSwapCommandResult =
  JupiterSwapQuoteCommandResult | JupiterSwapLiveCommandResult;

export type RaydiumSwapCommandResult =
  | {
      mode: "quote";
      route: "raydium";
      wallet: string;
      input: JupiterCliAsset & { amountUi: string; amountRaw: bigint };
      output: JupiterCliAsset & {
        expectedOutputUi: string;
        minimumOutputUi: string;
      };
      quote: Awaited<ReturnType<RaydiumService["quoteExactIn"]>>;
      hint: string;
    }
  | {
      mode: "live";
      route: "raydium";
      wallet: string;
      input: JupiterCliAsset & { amountUi: string; amountRaw: bigint };
      output: JupiterCliAsset;
      result: Awaited<ReturnType<RaydiumService["executePrepared"]>>;
    };

type RunJupiterSwapCommandArgs = {
  slrd: Solard;
  values: string[];
  flags: JupiterSwapCliFlags;
};

function requiredFlag(flags: JupiterSwapCliFlags, key: string): string {
  const value = flags.get(key);
  if (!value || value === "true") {
    throw new Error(`Missing --${key} <value>`);
  }
  return value;
}

export function parseJupiterSwapCliRequest(
  values: readonly string[],
  flags: JupiterSwapCliFlags,
): JupiterSwapCliRequest {
  const usage =
    "Usage: slrd swap --from <SOL|token|mint> --to <SOL|token|mint> --amount <ui> --wallet <wallet> [--live]\n" +
    "   or: slrd swap <token|mint> --wallet <wallet> --sol <amount> [--live]";

  const wallet = requiredFlag(flags, "wallet");
  const legacySolAmount = flags.get("sol");
  const fromRef = flags.get("from") ?? (legacySolAmount ? "SOL" : undefined);
  const toRef = flags.get("to") ?? values[0];
  const amountUi = flags.get("amount") ?? legacySolAmount;

  if (!fromRef || !toRef || !amountUi || amountUi === "true") {
    throw new Error(usage);
  }
  if (legacySolAmount && fromRef.trim().toUpperCase() !== "SOL") {
    throw new Error(
      "--sol is compatibility syntax for --from SOL only; use --amount with non-SOL input",
    );
  }

  return {
    wallet,
    fromRef,
    toRef,
    amountUi,
    live: flags.has("live"),
  };
}

export async function resolveJupiterCliAsset(
  slrd: Solard,
  refInput: string,
): Promise<JupiterCliAsset> {
  return await resolveTradeAsset(slrd, refInput);
}

export function jupiterCliAmountRaw(
  asset: JupiterCliAsset,
  amountUi: string,
): bigint {
  const raw =
    asset.kind === "sol"
      ? sol(amountUi).raw
      : (() => {
          if (!asset.tokenProgram) {
            throw new Error(`Missing token program for ${asset.mint}`);
          }
          return tokenAmount(
            amountUi,
            new PublicKey(asset.mint),
            asset.decimals,
            new PublicKey(asset.tokenProgram),
          ).raw;
        })();

  if (raw <= 0n) throw new Error("Swap amount must be greater than zero");
  return raw;
}

export async function runJupiterSwapCommand({
  slrd,
  values,
  flags,
}: RunJupiterSwapCommandArgs): Promise<
  JupiterSwapCommandResult | RaydiumSwapCommandResult
> {
  const request = parseJupiterSwapCliRequest(values, flags);

  const [input, output] = await Promise.all([
    resolveJupiterCliAsset(slrd, request.fromRef),
    resolveJupiterCliAsset(slrd, request.toRef),
  ]);
  if (input.mint === output.mint) {
    throw new Error(
      `Swap input and output resolve to the same mint: ${input.mint}`,
    );
  }

  const amountRaw = jupiterCliAmountRaw(input, request.amountUi);

  const raydiumRequested =
    flags.has("raydium") ||
    (flags.get("venue") ?? "").toLowerCase() === "raydium";
  if (raydiumRequested) {
    const raydium = new RaydiumService(slrd);
    const slippageBps = (() => {
      const value = flags.get("slippage-bps");
      if (!value || value === "true") return 100;
      const parsed = Number(value);
      if (!Number.isInteger(parsed))
        throw new Error("--slippage-bps must be an integer");
      return parsed;
    })();
    if (!request.live) {
      const quote = await raydium.quoteExactIn({
        inputMint: input.mint,
        outputMint: output.mint,
        amountRaw,
        slippageBps,
      });
      return {
        mode: "quote",
        route: "raydium",
        wallet: request.wallet,
        input: { ...input, amountUi: request.amountUi, amountRaw },
        output: {
          ...output,
          expectedOutputUi: formatRaw(quote.outputRaw, output.decimals),
          minimumOutputUi: formatRaw(quote.minOutputRaw, output.decimals),
        },
        quote,
        hint: "Re-run with --live and SOLARD_ENABLE_LIVE_TRADES=1 to execute this Raydium swap.",
      };
    }
    const prepared = await raydium.buildSwapExactIn({
      wallet: request.wallet,
      inputMint: input.mint,
      outputMint: output.mint,
      amountRaw,
      slippageBps,
      computeUnitPriceMicroLamports:
        flags.get("priority-micro-lamports") === "true"
          ? undefined
          : flags.get("priority-micro-lamports"),
    });
    const result = await raydium.executePrepared(prepared, {
      live: true,
      simulate: !flags.has("skip-simulation"),
      skipPreflight: flags.has("skip-preflight"),
    });
    return {
      mode: "live",
      route: "raydium",
      wallet: request.wallet,
      input: { ...input, amountUi: request.amountUi, amountRaw },
      output,
      result,
    };
  }

  if (!request.live) {
    const quote = await quoteJupiterSwap({
      inputMint: input.mint,
      outputMint: output.mint,
      amountRaw,
    });

    return {
      mode: "quote",
      wallet: request.wallet,
      input: {
        ...input,
        amountUi: request.amountUi,
        amountRaw,
      },
      output: {
        ...output,
        expectedOutputUi: formatRaw(quote.outAmountRaw, output.decimals),
      },
      quote,
      hint: "Re-run with --live to execute this exact-input Jupiter swap.",
    };
  }

  const result = await executeJupiterSwap({
    inputMint: input.mint,
    outputMint: output.mint,
    amountRaw,
    signer: slrd.signer(request.wallet),
  });

  return {
    mode: "live",
    wallet: request.wallet,
    input: {
      ...input,
      amountUi: request.amountUi,
      amountRaw,
    },
    output,
    result,
  };
}
