#!/usr/bin/env bun
import { listScripts, runScript, type TokenRow } from "@solard/sdk";

function emit(value: string): void {
  process.stdout.write(value);
}

const OWL = "🦉";
type Flags = Map<string, string>;
function args(input: string[]): { values: string[]; flags: Flags } {
  const values: string[] = [],
    flags = new Map<string, string>();
  for (let i = 0; i < input.length; i++) {
    const current = input[i]!;
    if (current === "-w") {
      flags.set("wallet", input[++i] ?? "");
      continue;
    }
    if (current.startsWith("--")) {
      const [key, inline] = current.slice(2).split("=", 2);
      if (inline != null) flags.set(key!, inline);
      else if (input[i + 1] && !input[i + 1]!.startsWith("-"))
        flags.set(key!, input[++i]!);
      else flags.set(key!, "true");
      continue;
    }
    values.push(current);
  }
  return { values, flags };
}
function need(flags: Flags, key: string): string {
  const value = flags.get(key);
  if (!value || value === "true") throw new Error(`Missing --${key} <value>`);
  return value;
}
function int(flags: Flags, key: string, fallback?: number): number | undefined {
  const value = flags.get(key);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key}: ${value}`);
  return parsed;
}
function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}
function formatError(error: unknown): string {
  if (error instanceof Error) {
    const code =
      "code" in error &&
      typeof (error as Error & { code?: unknown }).code === "string"
        ? ` [${String((error as Error & { code?: unknown }).code)}]`
        : "";
    const message = error.message.trim();
    const summary = `${error.name}${code}${message ? `: ${message}` : " (no message)"}`;
    return error.stack && error.stack !== summary
      ? `${summary}\n${error.stack}`
      : summary;
  }
  try {
    const encoded = json(error);
    return encoded && encoded !== "undefined" ? encoded : String(error);
  } catch {
    return String(error);
  }
}
function duration(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(value.trim());
  if (!match)
    throw new Error(`Invalid duration: ${value}. Use e.g. 500ms, 5s, 15m, 1h.`);
  const n = Number(match[1]);
  const scale = ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const)[
    (match[2]?.toLowerCase() ?? "ms") as "ms" | "s" | "m" | "h"
  ];
  return Math.floor(n * scale);
}
function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return value >= 0.001
    ? value.toFixed(9).replace(/0+$/, "").replace(/\.$/, "")
    : value.toExponential(6);
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
function targetWallets(
  slrd: { groupWallets(name: string): unknown[] },
  flags: Flags,
  usage: string,
): { mode: "wallet" | "wallets" | "group"; refs: string[]; group?: string } {
  const wallet = flags.get("wallet");
  const wallets = csv(flags.get("wallets"));
  const group = flags.get("group");
  const selected = [Boolean(wallet), wallets.length > 0, Boolean(group)].filter(
    Boolean,
  ).length;
  if (selected !== 1)
    throw new Error(
      `${usage} Supply exactly one of --wallet, --wallets, or --group.`,
    );
  if (wallet) return { mode: "wallet", refs: [wallet] };
  if (wallets.length > 0) return { mode: "wallets", refs: wallets };
  return {
    mode: "group",
    refs: slrd.groupWallets(group!).map((ref) => String(ref)),
    group,
  };
}
function help(): string {
  return `${OWL} slrd — multi-wallet Solana CLI + SDK for traders and AI agents

Wallets and tokens
  slrd wallets create [name]                Generate and persist an encrypted Solana wallet
  slrd wallet create [name]                 Alias for wallets create
  slrd import <private_key> [name]
  cat key.json | slrd import --stdin [name]
  slrd wallets [--tokens | --token <token>] [--addresses-only]    Show wallet SOL balances; token balances are opt-in
  slrd token <token_ca> [name] [--metadata-json <json>]
  slrd token set <token|ca> [--pool <address>] [--quote-mint <mint>] [--quote-program <program>] [--metadata-json <json>]
  slrd token refresh <token|ca>
  slrd tokens

Metadata and launching
  slrd launch pump --creator <wallet> --alias <name> (--uri <metadata_uri> | --metadata <json> | --image <path> --description <text>) [--live] [--skip-simulation]
                    [--deployment-sender helius-rpc|helius-fast] [--helius-tip-sol 0.01]
  slrd launch pump --creator <wallet> --alias <name> --buyer-group <group> --submit-mode jito-bundle --jito-block-engine-url <url>
                    (--uri <metadata_uri> | --image <path> --description <text>) [--creator-buy-sol <amount>] [--live --skip-simulation]
  slrd metadata upload --image <local_path> --name <name> --symbol <symbol> --description <text> [--provider pump-frontend|pinata]
                       [--twitter <url>] [--telegram <url>] [--website <url>] [--video <url>] [--hide-name]
  slrd deploy pump --wallet <wallet> --name <name> --symbol <symbol> (--uri <metadata_uri> | --image <local_path> --description <text>) [--alias <name>] [--live]
                   [--twitter <url>] [--telegram <url>] [--website <url>] [--video <url>] [--hide-name]

Prices
  slrd quote buy <token|ca> --sol <amount>           Inspect buy quote without submitting
  slrd price <token|ca>                              Sample current venue price
  slrd price average <token|ca> --period 15m         Average stored samples in a period
  slrd price watch <token|ca...> [--interval 1s] [--period 1m]

Trading
  slrd buy <token|ca> (--wallet <wallet> | --wallets <w1,w2> | --group <name>) --sol <amount> [--slippage-bps 1500] [--sender rpc|helius|jito] [--simulate-only]
  slrd buy <future-mint> (--wallet <wallet> | --group <name>) (--sol <amount> | --lamports <amount> | --min-bps <n> --max-bps <n>) --spam [--live]
  slrd spam-buy [pump] <future-mint> (--wallet <wallet> | --group <name>) (--sol <amount> | --lamports <amount> | --min-bps <n> --max-bps <n>) [--sender <id>] [--live]
  slrd sell <token|ca> (--wallet <wallet> | --wallets <w1,w2> | --group <name>) [--bps 10000] [--slippage-bps 1500] [--sender rpc|helius|jito] [--simulate-only]
  slrd unwrap-wsol (--wallet <wallet> | --wallets <w1,w2> | --group <name>) [--sender rpc|helius|jito] [--ignore-missing] [--simulate-only]
  slrd claim <token|ca> --wallet <wallet> [--sender rpc|helius|jito]

Scripts (strategies stay outside the kernel)
  slrd scripts                              List scripts registered in slrd.config.ts
  slrd run <name-or-path> [script flags...] Execute a script that imports slrd
  slrd run snipe --name <exact_name> --group <group> --sol 0.05 --sender jito

Groups and agents
  slrd group create <name> [description]
  slrd group add <group> <wallet> [weight_bps]
  slrd group add-many <group> <wallet1,wallet2,...>
  slrd group show <group>
  slrd group list
  slrd buy <token|ca> --group <name> --sol <amount> --sender jito      Submit group buys as Jito bundles, five tx per bundle
  slrd sell <token|ca> --group <name> --sender jito              Submit group sells as Jito bundles, five tx per bundle
  slrd agent create <name> --wallet <wallet> [--config-json <json>]
  slrd agent list

Watching
  slrd watch token <token|ca> [label]
  slrd watch wallet <wallet> [label]
  slrd watch program <address> [label]
  slrd watch list

Transactions and ALTs
  slrd transfer <recipient> --wallet <wallet> --sol <amount> [--sender rpc|helius|jito] [--simulate-only]
  slrd history
  slrd jito tip-accounts [--endpoint <block-engine-url>]
  slrd alt add <address> [label]
  slrd alt list
  slrd alt create --wallet <wallet>
  slrd alt extend <address> --wallet <wallet> <account...>

Environment
  SLRD_DB_PATH      shared SDK/CLI database; default ~/.solard/solard.sqlite (SOLARD_DB_PATH alias supported)
  SLRD_MASTER_KEY   required to create/import/decrypt stored wallets
  RPC_ENDPOINT      required only for chain operations
  HELIUS_SENDER_URL regional/global Helius Sender endpoint used by launch scripts
  HELIUS_RPC_URL    RPC endpoint used for ordinary Helius-RPC buyer lane
  HELIUS_TIP_ACCOUNT, HELIUS_TIP_LAMPORTS, HELIUS_PRIORITY_MICRO_LAMPORTS launch transport policy
  SLRD_LAUNCH_*     launch resend/timeout policy; shared environment, not per-token metadata
  JITO_BLOCK_ENGINE_URL only when explicitly selecting the separate Jito sender
  SLRD_METADATA_UPLOADER metadata provider; default pump-frontend; optional pinata
  PUMP_IPFS_ENDPOINT browser-facing Pump metadata upload endpoint; default https://pump.fun/api/ipfs
  PINATA_JWT       required only with --provider pinata or explicit pinata fallback
  IPFS_PUBLIC_GATEWAY optional Pinata returned metadata gateway; default https://ipfs.io/ipfs
`;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, flags } = args(rest);
  if (!command || command === "help" || command === "--help") {
    emit(help());
    return;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { name: string; version: string };
    emit(`${OWL} ${pkg.name} ${pkg.version} (bun ${Bun.version})\n`);
    return;
  }
  if (command === "vanity") {
    const {
      generateMintKeypairWithSuffix,
      saveMintKeypairFile,
      cleanVanitySuffix,
    } = await import("@solard/sdk");
    const suffix = cleanVanitySuffix(need(flags, "suffix"));
    const out = need(flags, "out");
    const count = int(flags, "count", 1)!;
    const results = [];
    for (let i = 0; i < count; i++) {
      const found = await generateMintKeypairWithSuffix({
        suffix,
        workers: int(flags, "workers"),
        maxAttempts: int(flags, "max-attempts", 25_000_000)!,
        timeoutMs: int(flags, "timeout-ms", 0)!,
        reportEvery: int(flags, "report-every", 1_000_000)!,
        onProgress: (p) =>
          emit(
            `${OWL} grinding ${p.suffix}: ${p.attempts} attempts, ${p.ratePerSecond}/s\n`,
          ),
      });
      const path = count === 1 ? out : out.replace(/(\.json)?$/, `-${i + 1}$1`);
      const saved = saveMintKeypairFile(path, found.mint, {
        force: flags.has("force"),
      });
      results.push({
        address: found.mint.publicKey.toBase58(),
        keypairPath: saved,
        attempts: found.attempts,
        elapsedMs: found.elapsedMs,
        launchArguments: ["--mint-keypair", saved, "--mint-suffix", suffix],
      });
    }
    emit(json(count === 1 ? results[0] : results) + "\n");
    return;
  }
  if (command === "spam-buy" || command === "buy-spam") {
    const { runPumpSpamBuyFromArgs } = await import("./pump/spam-buy-cli.ts");
    await runPumpSpamBuyFromArgs(rest);
    return;
  }
  if (command === "buy" && flags.has("spam")) {
    const { runPumpSpamBuyFromArgs } = await import("./pump/spam-buy-cli.ts");
    await runPumpSpamBuyFromArgs(rest);
    return;
  }
  if (command === "scripts") {
    emit(json(await listScripts()) + "\n");
    return;
  }
  if (command === "run") {
    const [script, ...scriptArgs] = rest;
    if (!script)
      throw new Error("Usage: slrd run <name-or-path> [script flags...]");
    process.exitCode = await runScript(script, scriptArgs);
    return;
  }
  if (
    command === "launch" &&
    (values[0] === "pump" || values[0] === "pump-token")
  ) {
    const { runPumpTokenLaunchFromArgs } =
      await import("./pump/token-launch-cli.ts");
    await runPumpTokenLaunchFromArgs(rest.slice(1), {
      defaultSubmitMode: "after-deploy-processed",
      defaultDeploymentPriorityMicroLamports: 500_000,
      defaultBuyerPriorityMicroLamports: 1_500_000,
      defaultSlippageBps: 1_500,
      persistOnLive: true,
      report: (label, value) => emit(`${label}: ${json(value)}\n`),
    });
    return;
  }
  if (command === "jito" && values[0] === "tip-accounts") {
    const endpoint = (
      flags.get("endpoint") ??
      process.env.JITO_BLOCK_ENGINE_URL ??
      "https://mainnet.block-engine.jito.wtf"
    ).replace(/\/$/, "");
    const { getJitoTipAccounts } = await import("@solard/sdk");
    const tipAccounts = await getJitoTipAccounts(endpoint);
    emit(json({ endpoint, tipAccounts }) + "\n");
    return;
  }
  if (command === "metadata" && values[0] === "upload") {
    const { uploadPumpMetadata } = await import("@solard/sdk");
    const uploaded = await uploadPumpMetadata(
      {
        imagePath: need(flags, "image"),
        name: need(flags, "name"),
        symbol: need(flags, "symbol"),
        description: need(flags, "description"),
        twitter: flags.get("twitter"),
        telegram: flags.get("telegram"),
        website: flags.get("website"),
        video: flags.get("video"),
        showName: !flags.has("hide-name"),
      },
      {
        provider: (flags.get("provider") ??
          process.env.SLRD_METADATA_UPLOADER ??
          "pump-frontend") as "pump-frontend" | "pinata",
        endpoint: flags.get("endpoint"),
        fallback: flags.get("fallback") === "pinata" ? "pinata" : null,
      },
    );
    emit(json(uploaded) + "\n");
    return;
  }
  const [{ sol, formatRaw }, { shortKey }, { createTraderSolard }] =
    await Promise.all([
      import("@solard/sdk"),
      import("@solard/sdk"),
      import("@solard/sdk"),
    ]);
  const slrd = createTraderSolard();
  try {
    if (
      (command === "wallet" || command === "wallets") &&
      values[0] === "create"
    ) {
      const wallet = slrd.createWallet(values[1]);
      emit(`${OWL} created @${wallet.name} ${wallet.address}\n`);
      return;
    }
    if (command === "export") {
      const ref = values[0];
      if (!ref)
        throw new Error(
          "Usage: slrd export <wallet|address> [--json] [--out <path>]",
        );
      const bs58 = (await import("bs58")).default;
      const { signer, row } = slrd.wallets.signer(ref);
      const secret = flags.has("json")
        ? JSON.stringify(Array.from(signer.secretKey))
        : bs58.encode(signer.secretKey);

      const out = flags.get("out");
      if (out && out !== "true") {
        const { writeFileSync, mkdirSync } = await import("node:fs");
        const { dirname, resolve } = await import("node:path");
        const path = resolve(out);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${secret}\n`, { mode: 0o600, flag: "wx" });
        emit(
          `${OWL} exported @${row?.name ?? "?"} ${signer.publicKey.toBase58()} -> ${path}\n`,
        );
        return;
      }

      // Secret to stdout only; metadata to stderr so piping stays clean.
      process.stderr.write(
        `${OWL} @${row?.name ?? "?"} ${signer.publicKey.toBase58()} (${flags.has("json") ? "keypair-json" : "base58"})\n`,
      );
      process.stdout.write(`${secret}\n`);
      return;
    }
    if (command === "import") {
      const input = flags.has("stdin")
        ? (await new Response(Bun.stdin.stream()).text()).trim()
        : values[0];
      if (!input)
        throw new Error(
          "Usage: slrd import <private_key> [name] [--force] or cat key.json | slrd import --stdin [name] [--force]",
        );
      const name = flags.has("stdin") ? values[0] : values[1];
      const wallet = slrd.importWallet(input, name, {
        overwrite: flags.has("force") || flags.has("overwrite"),
      });
      emit(`${OWL} imported @${wallet.name} ${wallet.address}\n`);
      return;
    }
    if (command === "wallets") {
      const wallets = slrd.wallets.list();
      if (flags.has("addresses-only")) {
        for (const wallet of wallets)
          emit(`@${wallet.name}\t${wallet.address}\n`);
        return;
      }

      // Wallet overview is intentionally SOL-only by default. Token scans can
      // be expensive when many tokens are registered, so they are opt-in.
      const selectedTokens = flags.get("token")
        ? [slrd.resolveToken(flags.get("token")!)]
        : flags.has("tokens")
          ? slrd.tokens.list()
          : [];

      for (const wallet of wallets) {
        const balances = await slrd.walletBalances(wallet, selectedTokens);
        const holdings = balances.tokenBalances
          .filter(
            (balance) =>
              balance.amountRaw > 0n ||
              flags.has("show-zero") ||
              Boolean(flags.get("token")),
          )
          .map(
            (balance) =>
              `${balance.token.symbol ? "$" + balance.token.symbol : (balance.token.name ?? shortKey(balance.token.mint))}=${formatRaw(balance.amountRaw, balance.decimals)}`,
          )
          .join("  ");
        emit(
          `@${wallet.name}\t${wallet.address}\tSOL=${formatRaw(balances.solLamports, 9)}${holdings ? `  ${holdings}` : ""}\n`,
        );
      }
      return;
    }

    if (command === "transfer" || command === "send-sol") {
      const recipient = values[0] === "sol" ? values[1] : values[0];
      if (!recipient) {
        throw new Error(
          "Usage: slrd transfer <recipient> --wallet <wallet> --sol <amount> [--sender rpc|helius|jito] [--simulate-only]",
        );
      }

      const wallet = need(flags, "wallet");
      const amount = need(flags, "sol");
      const via = flags.get("sender") ?? "rpc";
      const composer = slrd.tx(wallet).transferSol(recipient, sol(amount));

      if (flags.has("simulate-only")) {
        const plan = await composer.build();
        const result = await slrd.simulatePlan(plan);
        emit(
          json({
            mode: "simulation",
            wallet,
            recipient,
            sol: amount,
            result,
          }) + "\n",
        );
        return;
      }

      const receipt = await composer.send({
        via,
        kind: "transfer-sol",
        skipSimulation: flags.has("skip-simulation"),
        skipPreflight:
          flags.has("skip-preflight") || flags.has("skip-simulation"),
      });
      emit(json(receipt) + "\n");
      return;
    }
    if (command === "deploy") {
      const launchpad = values[0] ?? "pump";
      const wallet = need(flags, "wallet");
      const name = need(flags, "name");
      const symbol = need(flags, "symbol");
      let uri = flags.get("uri");
      let uploadedMetadata: unknown = null;
      if (!uri || uri === "true") {
        if (!flags.get("image"))
          throw new Error(
            "Provide --uri <metadata_uri> or --image <local_path> --description <text>",
          );
        const { uploadPumpMetadata } = await import("@solard/sdk");
        uploadedMetadata = await uploadPumpMetadata(
          {
            imagePath: need(flags, "image"),
            name,
            symbol,
            description: need(flags, "description"),
            twitter: flags.get("twitter"),
            telegram: flags.get("telegram"),
            website: flags.get("website"),
            video: flags.get("video"),
            showName: !flags.has("hide-name"),
          },
          {
            provider: (flags.get("provider") ??
              process.env.SLRD_METADATA_UPLOADER ??
              "pump-frontend") as "pump-frontend" | "pinata",
            endpoint: flags.get("endpoint"),
            fallback: flags.get("fallback") === "pinata" ? "pinata" : null,
          },
        );
        uri = (uploadedMetadata as { metadataUri: string }).metadataUri;
      }
      const creator = flags.get("creator")
        ? slrd.resolveWallet(flags.get("creator")!).address
        : slrd.signer(wallet).publicKey;
      const deployment = await slrd.prepareTokenDeployment(launchpad, wallet, {
        name,
        symbol,
        uri,
        creator,
        mayhemMode: flags.has("mayhem"),
        cashback: flags.has("cashback"),
      });
      const plan = await slrd
        .transaction(wallet)
        .addMany(deployment.instructions, {
          kind: "deploy-token",
          mint: deployment.mint.publicKey,
          meta: { launchpad, name, symbol },
        })
        .withSigner(deployment.mint)
        .build();
      const header = {
        launchpad,
        mint: deployment.mint.publicKey.toBase58(),
        name,
        symbol,
        uri,
        uploadedMetadata,
        live: flags.has("live"),
      };
      if (!flags.has("live")) {
        const simulation = await slrd.simulatePlan(plan);
        emit(json({ ...header, simulation }) + "\n");
        return;
      }
      const receipt = await slrd.sendPlan(
        plan,
        flags.get("sender") ?? "rpc",
        `deploy:${launchpad}`,
        {
          skipSimulation: flags.has("skip-simulation"),
          skipPreflight: flags.has("skip-simulation"),
        },
      );
      const token = slrd.persistPreparedDeployment(
        deployment,
        flags.get("alias"),
      );
      emit(json({ ...header, receipt, token }) + "\n");
      return;
    }
    if (command === "token" && values[0] !== "set" && values[0] !== "refresh") {
      const [mint, name] = values;
      if (!mint) throw new Error("Usage: slrd token <token_ca> [name]");
      const metadata = flags.get("metadata-json");
      const token = await slrd.addToken(
        mint,
        name,
        metadata ? { metadataJson: metadata } : {},
      );
      emit(
        `${OWL} token ${token.name ?? token.symbol ?? "-"} ${token.mint} venue=${token.venueHint}\n`,
      );
      return;
    }
    if (command === "token" && values[0] === "refresh") {
      const ref = values[1];
      if (!ref) throw new Error("Usage: slrd token refresh <token|ca>");
      emit(json(await slrd.refreshToken(ref)) + "\n");
      return;
    }
    if (command === "token" && values[0] === "set") {
      const ref = values[1];
      if (!ref) throw new Error("Usage: slrd token set <token|ca> [flags]");
      const patch: Partial<TokenRow> = {};
      if (flags.get("pool")) patch.pool = flags.get("pool");
      if (flags.get("quote-mint")) patch.quoteMint = flags.get("quote-mint");
      if (flags.get("quote-program"))
        patch.quoteTokenProgram = flags.get("quote-program");
      if (flags.get("metadata-json"))
        patch.metadataJson = flags.get("metadata-json");
      const token = slrd.configureToken(ref, patch);
      emit(`${OWL} updated ${token.name ?? shortKey(token.mint)}\n`);
      return;
    }
    if (command === "tokens") {
      for (const token of slrd.tokens.list())
        emit(
          `${token.name ?? "-"}\t${token.symbol ? "$" + token.symbol : "-"}\t${token.mint}\t${token.venueHint}\n`,
        );
      return;
    }
    if (command === "quote" && values[0] === "buy") {
      const tokenRef = values[1];
      if (!tokenRef)
        throw new Error(
          "Usage: slrd quote buy <token|ca> --sol <amount> [--slippage-bps 1500]",
        );
      const spend = need(flags, "sol");
      const result = await slrd.quoteBuy(
        tokenRef,
        sol(spend),
        int(flags, "slippage-bps", 1500),
      );
      emit(
        json({
          token: {
            mint: result.token.mint,
            name: result.token.name,
            symbol: result.token.symbol,
          },
          venue: result.venue,
          quoteAsset:
            result.quoteAsset.kind === "native-sol"
              ? "SOL"
              : result.quoteAsset.mint.toBase58(),
          spendRaw: result.quote.inputRaw,
          expectedOutputRaw: result.quote.expectedOutputRaw,
          minimumOutputRaw: result.quote.minimumOutputRaw,
          meta: result.quote.meta ?? {},
        }) + "\n",
      );
      return;
    }
    if (command === "price" && values[0] === "average") {
      const tokenRef = values[1];
      if (!tokenRef)
        throw new Error("Usage: slrd price average <token|ca> --period 15m");
      const token = slrd.resolveToken(tokenRef);
      const window = slrd.averagePrice(
        token,
        duration(flags.get("period"), 60_000),
      );
      emit(
        `${token.symbol ? "$" + token.symbol : (token.name ?? shortKey(token.mint))} samples=${window.samples} avg=${formatPrice(window.averagePriceQuotePerToken)} min=${formatPrice(window.minimumPriceQuotePerToken)} max=${formatPrice(window.maximumPriceQuotePerToken)} last=${formatPrice(window.lastPriceQuotePerToken)}\n`,
      );
      return;
    }
    if (command === "price" && values[0] === "watch") {
      const tokenRefs = values.slice(1);
      if (tokenRefs.length === 0)
        throw new Error(
          "Usage: slrd price watch <token|ca...> [--interval 1s] [--period 1m]",
        );
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      for await (const event of slrd.watchPrices(tokenRefs, {
        intervalMs: duration(flags.get("interval"), 1_000),
        averagePeriodMs: duration(flags.get("period"), 60_000),
        signal: controller.signal,
      })) {
        const label = event.token.symbol
          ? "$" + event.token.symbol
          : (event.token.name ?? shortKey(event.token.mint));
        emit(
          `${new Date(event.sample.capturedAtMs).toISOString()} ${label} venue=${event.sample.venue} price=${formatPrice(event.sample.priceQuotePerToken)} avg=${formatPrice(event.average.averagePriceQuotePerToken)} samples=${event.average.samples}\n`,
        );
      }
      return;
    }
    if (command === "price") {
      const tokenRef = values[0];
      if (!tokenRef) throw new Error("Usage: slrd price <token|ca>");
      const token = slrd.resolveToken(tokenRef);
      const sample = await slrd.samplePrice(token);
      const label = token.symbol
        ? "$" + token.symbol
        : (token.name ?? shortKey(token.mint));
      emit(
        `${label} venue=${sample.venue} price=${formatPrice(sample.priceQuotePerToken)} quote=${sample.quoteAsset.kind === "native-sol" ? "SOL" : shortKey(sample.quoteAsset.mint.toBase58())} captured=${new Date(sample.capturedAtMs).toISOString()}\n`,
      );
      return;
    }
    if (command === "buy") {
      const token = values[0];
      if (!token)
        throw new Error(
          "Usage: slrd buy <token|ca> (--wallet <wallet> | --wallets <w1,w2> | --group <group>) --sol <amount>",
        );
      const amount = flags.get("sol");
      if (!amount) throw new Error("Buy requires explicit --sol <amount>");
      const targets = targetWallets(
        slrd,
        flags,
        "Usage: slrd buy <token|ca> (--wallet <wallet> | --wallets <w1,w2> | --group <group>) --sol <amount>.",
      );
      const options = {
        slippageBps: int(flags, "slippage-bps", 1500),
        via: flags.get("sender") ?? "rpc",
        skipSimulation: flags.has("skip-simulation"),
        skipPreflight:
          flags.has("skip-preflight") || flags.has("skip-simulation"),
      };
      if (flags.has("simulate-only")) {
        const plans =
          targets.refs.length === 1
            ? [
                await slrd
                  .tx(targets.refs[0]!)
                  .buy(token, sol(amount), options)
                  .build(),
              ]
            : await slrd
                .composeMany(targets.refs)
                .buy(token, sol(amount), options)
                .build();
        const results = await Promise.all(
          plans.map((plan) => slrd.simulatePlan(plan)),
        );
        emit(json({ mode: "simulation", target: targets, results }) + "\n");
        return;
      }
      const receipts =
        targets.refs.length === 1
          ? await slrd.buy(token, targets.refs[0]!, sol(amount), options)
          : await slrd.buyMany(token, targets.refs, sol(amount), options);
      emit(json(receipts) + "\n");
      return;
    }
    if (command === "sell") {
      const token = values[0];
      if (!token)
        throw new Error(
          "Usage: slrd sell <token|ca> (--wallet <wallet> | --wallets <w1,w2> | --group <group>)",
        );
      const targets = targetWallets(
        slrd,
        flags,
        "Usage: slrd sell <token|ca> (--wallet <wallet> | --wallets <w1,w2> | --group <group>).",
      );
      const sellOptions = {
        bps: int(flags, "bps", 10000),
        slippageBps: int(flags, "slippage-bps", 1500),
        via: flags.get("sender") ?? "rpc",
        skipSimulation: flags.has("skip-simulation"),
        skipPreflight:
          flags.has("skip-preflight") || flags.has("skip-simulation"),
      };
      if (flags.has("simulate-only")) {
        const plans =
          targets.refs.length === 1
            ? [await slrd.tx(targets.refs[0]!).sell(token, sellOptions).build()]
            : await slrd
                .composeMany(targets.refs)
                .sell(token, sellOptions)
                .build();
        const results = await Promise.all(
          plans.map((plan) => slrd.simulatePlan(plan)),
        );
        emit(json({ mode: "simulation", target: targets, results }) + "\n");
        return;
      }
      const receipts =
        targets.refs.length === 1
          ? await slrd.sell(token, targets.refs[0]!, sellOptions)
          : await slrd.sellMany(token, targets.refs, sellOptions);
      emit(json(receipts) + "\n");
      return;
    }
    if (
      command === "unwrap-wsol" ||
      (command === "unwrap" && values[0] === "wsol")
    ) {
      const targets = targetWallets(
        slrd,
        flags,
        "Usage: slrd unwrap-wsol (--wallet <wallet> | --wallets <w1,w2> | --group <group>).",
      );
      const destination = flags.get("destination");
      if (destination && targets.refs.length !== 1)
        throw new Error(
          "--destination is only supported with a single --wallet unwrap.",
        );
      const unwrapOptions = {
        via: flags.get("sender") ?? "rpc",
        destination,
        skipMissing: flags.has("ignore-missing") || flags.has("skip-missing"),
        skipSimulation: flags.has("skip-simulation"),
        skipPreflight:
          flags.has("skip-preflight") || flags.has("skip-simulation"),
      };
      if (flags.has("simulate-only")) {
        const plans =
          targets.refs.length === 1
            ? [
                await slrd
                  .tx(targets.refs[0]!)
                  .unwrapWsol({
                    destination,
                    skipMissing: unwrapOptions.skipMissing,
                  })
                  .build(),
              ]
            : await slrd
                .composeMany(targets.refs)
                .unwrapWsol({ skipMissing: unwrapOptions.skipMissing })
                .build();
        const results = await Promise.all(
          plans.map((plan) => slrd.simulatePlan(plan)),
        );
        emit(json({ mode: "simulation", target: targets, results }) + "\n");
        return;
      }
      const receipts =
        targets.refs.length === 1
          ? await slrd.unwrapWsol(targets.refs[0]!, unwrapOptions)
          : await slrd.unwrapWsolMany(targets.refs, unwrapOptions);
      emit(json(receipts) + "\n");
      return;
    }
    if (command === "claim") {
      const token = values[0];
      if (!token)
        throw new Error("Usage: slrd claim <token|ca> --wallet <wallet>");
      emit(
        json(
          await slrd.claim(token, need(flags, "wallet"), {
            via: flags.get("sender") ?? "rpc",
          }),
        ) + "\n",
      );
      return;
    }
    if (command === "history") {
      emit(json(slrd.executions.history()) + "\n");
      return;
    }
    if (command === "group" && values[0] === "create") {
      const name = values[1];
      if (!name)
        throw new Error("Usage: slrd group create <name> [description]");
      emit(
        json(slrd.groups.create(name, values.slice(2).join(" ") || undefined)) +
          "\n",
      );
      return;
    }
    if (command === "group" && values[0] === "add") {
      const [_, group, wallet, weight] = values;
      if (!group || !wallet)
        throw new Error("Usage: slrd group add <group> <wallet> [weight_bps]");
      const resolved = slrd.resolveWallet(wallet);
      emit(
        json(
          slrd.groups.addWallet(
            group,
            resolved.address.toBase58(),
            weight ? Number(weight) : 10000,
          ),
        ) + "\n",
      );
      return;
    }
    if (command === "group" && values[0] === "add-many") {
      const group = values[1];
      const raw = values[2];
      if (!group || !raw)
        throw new Error(
          "Usage: slrd group add-many <group> <wallet1,wallet2,...>",
        );
      slrd.groups.create(group);
      const members = raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((ref) => {
          const resolved = slrd.resolveWallet(ref);
          return slrd.groups.addWallet(
            group,
            resolved.address.toBase58(),
            10000,
          );
        });
      emit(json({ group, added: members.length, members }) + "\n");
      return;
    }
    if (command === "group" && values[0] === "show") {
      const group = values[1];
      if (!group) throw new Error("Usage: slrd group show <group>");
      const members = slrd.groups.wallets(group).map((row) => {
        const wallet = slrd.resolveWallet(row.walletAddress);
        return {
          name: wallet.row?.name ?? null,
          address: wallet.address.toBase58(),
          weightBps: row.weightBps,
        };
      });
      emit(json({ group, members }) + "\n");
      return;
    }
    if (command === "group" && values[0] === "list") {
      emit(json(slrd.groups.list()) + "\n");
      return;
    }
    if (command === "agent" && values[0] === "create") {
      const name = values[1];
      if (!name)
        throw new Error(
          "Usage: slrd agent create <name> --wallet <wallet> [--config-json <json>]",
        );
      const supplied = flags.get("config-json")
        ? (JSON.parse(flags.get("config-json")!) as Record<string, unknown>)
        : {};
      const wallet = need(flags, "wallet");
      const agent = slrd.configureAgent(name, { ...supplied, wallet });
      emit(json(agent.row) + "\n");
      return;
    }
    if (command === "agent" && values[0] === "list") {
      emit(json(slrd.listAgents()) + "\n");
      return;
    }
    if (command === "watch" && values[0] === "token") {
      const ref = values[1];
      if (!ref) throw new Error("Usage: slrd watch token <token|ca> [label]");
      emit(json(slrd.watchToken(ref, values[2])) + "\n");
      return;
    }
    if (command === "watch" && values[0] === "wallet") {
      const ref = values[1];
      if (!ref) throw new Error("Usage: slrd watch wallet <wallet> [label]");
      emit(json(slrd.watchWallet(ref, values[2])) + "\n");
      return;
    }
    if (command === "watch" && values[0] === "program") {
      const address = values[1];
      if (!address)
        throw new Error("Usage: slrd watch program <address> [label]");
      emit(json(slrd.watchProgram(address, values[2])) + "\n");
      return;
    }
    if (command === "watch" && values[0] === "list") {
      emit(json(slrd.db.watches.select().where({ isActive: 1 }).all()) + "\n");
      return;
    }
    if (command === "alt" && values[0] === "add") {
      if (!values[1]) throw new Error("Usage: slrd alt add <address> [label]");
      emit(json(slrd.alts.register(values[1], values[2])) + "\n");
      return;
    }
    if (command === "alt" && values[0] === "list") {
      emit(json(slrd.alts.list()) + "\n");
      return;
    }
    if (command === "alt" && values[0] === "create") {
      emit(json(await slrd.createAlt(need(flags, "wallet"))) + "\n");
      return;
    }
    if (command === "alt" && values[0] === "extend") {
      if (!values[1] || values.length < 3)
        throw new Error(
          "Usage: slrd alt extend <address> --wallet <wallet> <account...>",
        );
      emit(
        json(
          await slrd.extendAlt(
            values[1],
            need(flags, "wallet"),
            values.slice(2),
          ),
        ) + "\n",
      );
      return;
    }
    throw new Error(`Unknown command: ${command}\n\n${help()}`);
  } finally {
    slrd.close();
  }
}
main().catch((error) => {
  emit(`${OWL} error: ${formatError(error)}\n`);
  process.exitCode = 1;
});

export { formatCliError } from "./pump/token-launch-cli.ts";
