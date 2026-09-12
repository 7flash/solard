import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  RaydiumService,
  formatRaw,
  resolveTradeAsset,
  sol,
  tokenAmount,
  type Solard,
  type TradeAsset,
} from "@solard/core";

type Flags = Map<string, string>;
type Emit = (value: string) => void;

type Args = {
  slrd: Solard;
  values: string[];
  flags: Flags;
  emit: Emit;
};

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function flag(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return value && value !== "true" ? value : undefined;
}

function need(flags: Flags, key: string): string {
  const value = flag(flags, key);
  if (!value) throw new Error(`Missing --${key} <value>`);
  return value;
}

function intFlag(flags: Flags, key: string, fallback: number): number {
  const value = flag(flags, key);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`--${key} must be an integer`);
  return parsed;
}

function numberFlag(flags: Flags, key: string, fallback: number): number {
  const value = flag(flags, key);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number`);
  return parsed;
}

function rawFor(asset: TradeAsset, amountUi: string): bigint {
  if (asset.kind !== "sol" && !asset.tokenProgram) {
    throw new Error(`Missing token program for ${asset.mint}`);
  }
  const raw =
    asset.kind === "sol"
      ? sol(amountUi).raw
      : tokenAmount(
          amountUi,
          new PublicKey(asset.mint),
          asset.decimals,
          new PublicKey(asset.tokenProgram!),
        ).raw;
  if (raw <= 0n) throw new Error("Amount must be greater than zero");
  return raw;
}

async function assets(
  slrd: Solard,
  from: string,
  to: string,
): Promise<[TradeAsset, TradeAsset]> {
  return await Promise.all([
    resolveTradeAsset(slrd, from),
    resolveTradeAsset(slrd, to),
  ]);
}

function executionOptions(flags: Flags) {
  return {
    live: flags.has("live"),
    simulate: !flags.has("skip-simulation"),
    skipPreflight: flags.has("skip-preflight"),
  };
}

function readKeypair(path: string): Keypair {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (
    !Array.isArray(parsed) ||
    !parsed.every((value) => Number.isInteger(value))
  ) {
    throw new Error(`Invalid Solana keypair JSON: ${path}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

function saveKeypair(path: string, signer: Keypair): string {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify([...signer.secretKey])}\n`, {
    flag: "wx",
  });
  try {
    chmodSync(absolute, 0o600);
  } catch {}
  return absolute;
}

function launchMintSigner(flags: Flags): { signer: Keypair; path: string } {
  const requested = flag(flags, "mint-keypair");
  if (requested && existsSync(resolve(requested))) {
    return {
      signer: readKeypair(resolve(requested)),
      path: resolve(requested),
    };
  }
  const signer = Keypair.generate();
  const path = requested
    ? resolve(requested)
    : resolve(
        ".solard",
        "raydium-mints",
        `${signer.publicKey.toBase58()}.json`,
      );
  return { signer, path: saveKeypair(path, signer) };
}

function help(): string {
  return `Raydium
  slrd raydium quote --from <SOL|token|mint> --to <SOL|token|mint> --amount <ui> [--slippage-bps 100]
  slrd raydium swap --from <SOL|token|mint> --to <SOL|token|mint> --amount <ui> --wallet <wallet> [--live]

LaunchLab
  slrd raydium launchlab configs [--quote <SOL|token|mint>]
  slrd raydium launchlab launch --wallet <wallet> --name <name> --symbol <symbol> --uri <metadata-uri> [--quote SOL|mint] [--buy <ui>] [--decimals 6] [--mint-keypair <path>] [--live]
  slrd raydium launchlab buy <mint> --wallet <wallet> [--quote SOL|mint] --amount <ui> [--live]
  slrd raydium launchlab sell <mint> --wallet <wallet> [--quote SOL|mint] --amount <ui> [--live]

Arbitrary SPL/SPL pair
  slrd raydium cpmm create --wallet <wallet> --mint-a <token|mint> --mint-b <token|mint> --amount-a <ui> --amount-b <ui> [--fee-config-index 0] [--live]

All writes are simulation-only unless --live is supplied. Live Raydium writes also require SOLARD_ENABLE_LIVE_TRADES=1.`;
}

export async function handleRaydiumCommand({
  slrd,
  values,
  flags,
  emit,
}: Args): Promise<void> {
  const service = new RaydiumService(slrd);
  const section = values[0] ?? "help";

  if (section === "help" || flags.has("help")) {
    emit(`${help()}\n`);
    return;
  }

  if (section === "quote") {
    const inputRef = need(flags, "from");
    const outputRef = need(flags, "to");
    const amountUi = need(flags, "amount");
    const [input, output] = await assets(slrd, inputRef, outputRef);
    const quote = await service.quoteExactIn({
      inputMint: input.mint,
      outputMint: output.mint,
      amountRaw: rawFor(input, amountUi),
      slippageBps: intFlag(flags, "slippage-bps", 100),
    });
    emit(
      `${json({
        mode: "quote",
        venue: "raydium",
        input: { ...input, amountUi, amountRaw: quote.inputRaw },
        output: {
          ...output,
          expectedOutputUi: formatRaw(quote.outputRaw, output.decimals),
          minimumOutputUi: formatRaw(quote.minOutputRaw, output.decimals),
        },
        quote,
      })}\n`,
    );
    return;
  }

  if (section === "swap") {
    const wallet = need(flags, "wallet");
    const inputRef = need(flags, "from");
    const outputRef = need(flags, "to");
    const amountUi = need(flags, "amount");
    const [input, output] = await assets(slrd, inputRef, outputRef);
    const prepared = await service.buildSwapExactIn({
      wallet,
      inputMint: input.mint,
      outputMint: output.mint,
      amountRaw: rawFor(input, amountUi),
      slippageBps: intFlag(flags, "slippage-bps", 100),
      computeUnitPriceMicroLamports:
        flag(flags, "priority-micro-lamports") ?? undefined,
    });
    const result = await service.executePrepared(
      prepared,
      executionOptions(flags),
    );
    emit(
      `${json({
        mode: flags.has("live") ? "live" : "simulation",
        venue: "raydium",
        input: { ...input, amountUi },
        output: {
          ...output,
          expectedOutputUi: formatRaw(
            prepared.quote.outputRaw,
            output.decimals,
          ),
          minimumOutputUi: formatRaw(
            prepared.quote.minOutputRaw,
            output.decimals,
          ),
        },
        result,
      })}\n`,
    );
    return;
  }

  if (section === "launchlab") {
    const action = values[1] ?? "help";

    if (action === "help") {
      emit(`${help()}\n`);
      return;
    }

    if (action === "configs") {
      const quoteRef = flag(flags, "quote");
      const quote = quoteRef ? await resolveTradeAsset(slrd, quoteRef) : null;
      let configs = await service.listLaunchConfigs();
      if (quote) configs = configs.filter((row) => row.mintB === quote.mint);
      emit(`${json({ quote, configs })}\n`);
      return;
    }

    if (action === "launch" || action === "create") {
      const wallet = need(flags, "wallet");
      const name = need(flags, "name");
      const symbol = need(flags, "symbol");
      const uri = need(flags, "uri");
      const quote = await resolveTradeAsset(
        slrd,
        flag(flags, "quote") ?? "SOL",
      );
      const buyUi = flag(flags, "buy") ?? "0";
      const buyRaw = buyUi === "0" ? 0n : rawFor(quote, buyUi);
      // Fail before generating/saving a mint keypair when this quote is not
      // actually supported by an on-chain LaunchLab config.
      await service.resolveLaunchConfig({
        quoteMint: quote.mint,
        configId: flag(flags, "config"),
      });
      const mint = launchMintSigner(flags);
      const prepared = await service.buildLaunchLabCreate({
        wallet,
        mintSigner: mint.signer,
        name,
        symbol,
        uri,
        quoteMint: quote.mint,
        buyAmountRaw: buyRaw,
        decimals: intFlag(flags, "decimals", 6),
        slippageBps: intFlag(flags, "slippage-bps", 100),
        configId: flag(flags, "config"),
        token2022: flags.has("token-2022"),
      });
      const result = await service.executePrepared(
        prepared,
        executionOptions(flags),
      );
      emit(
        `${json({
          mode: flags.has("live") ? "live" : "simulation",
          venue: "raydium-launchlab",
          mint: mint.signer.publicKey.toBase58(),
          mintKeypairPath: mint.path,
          quote,
          result,
          hint: flags.has("live")
            ? null
            : `Re-run with --mint-keypair ${mint.path} --live to launch this exact mint.`,
        })}\n`,
      );
      return;
    }

    if (action === "buy" || action === "sell") {
      const mintRef = values[2];
      if (!mintRef) {
        throw new Error(
          `Usage: slrd raydium launchlab ${action} <mint> --wallet <wallet> [--quote SOL|mint] --amount <ui> [--live]`,
        );
      }
      const wallet = need(flags, "wallet");
      const amountUi = need(flags, "amount");
      const mint = await resolveTradeAsset(slrd, mintRef);
      const quote = await resolveTradeAsset(
        slrd,
        flag(flags, "quote") ?? "SOL",
      );
      const prepared =
        action === "buy"
          ? await service.buildLaunchLabBuy({
              wallet,
              mint: mint.mint,
              quoteMint: quote.mint,
              amountRaw: rawFor(quote, amountUi),
              slippageBps: intFlag(flags, "slippage-bps", 100),
            })
          : await service.buildLaunchLabSell({
              wallet,
              mint: mint.mint,
              quoteMint: quote.mint,
              amountRaw: rawFor(mint, amountUi),
              slippageBps: intFlag(flags, "slippage-bps", 100),
            });
      const result = await service.executePrepared(
        prepared,
        executionOptions(flags),
      );
      emit(
        `${json({
          mode: flags.has("live") ? "live" : "simulation",
          venue: "raydium-launchlab",
          side: action,
          mint,
          quote,
          amountUi,
          result,
        })}\n`,
      );
      return;
    }

    throw new Error(`Unknown Raydium LaunchLab action: ${action}\n${help()}`);
  }

  if (section === "cpmm") {
    const action = values[1] ?? "help";
    if (action !== "create") {
      emit(`${help()}\n`);
      return;
    }
    const wallet = need(flags, "wallet");
    const mintA = await resolveTradeAsset(slrd, need(flags, "mint-a"));
    const mintB = await resolveTradeAsset(slrd, need(flags, "mint-b"));
    const amountAUi = need(flags, "amount-a");
    const amountBUi = need(flags, "amount-b");
    const prepared = await service.buildCpmmCreate({
      wallet,
      mintA: mintA.mint,
      mintB: mintB.mint,
      amountARaw: rawFor(mintA, amountAUi),
      amountBRaw: rawFor(mintB, amountBUi),
      feeConfigIndex: intFlag(flags, "fee-config-index", 0),
      startTime: numberFlag(flags, "start-time", 0),
    });
    const result = await service.executePrepared(
      prepared,
      executionOptions(flags),
    );
    emit(
      `${json({
        mode: flags.has("live") ? "live" : "simulation",
        venue: "raydium-cpmm",
        mintA: { ...mintA, amountUi: amountAUi },
        mintB: { ...mintB, amountUi: amountBUi },
        result,
      })}\n`,
    );
    return;
  }

  throw new Error(`Unknown Raydium command: ${section}\n${help()}`);
}
