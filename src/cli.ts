#!/usr/bin/env bun
import type { TokenRow } from "./db/schema.js";
import { emit } from "./core/ui.js";
import { listScripts, runScript } from "./runner/run-script.js";

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
  sowl: { groupWallets(name: string): unknown[] },
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
    refs: sowl.groupWallets(group!).map((ref) => String(ref)),
    group,
  };
}
function help(): string {
  return `${OWL} sowl — multi-wallet Solana CLI + SDK for traders and AI agents

Wallets and tokens
  sowl import <private_key> [name]
  cat key.json | sowl import --stdin [name]
  sowl wallets [--token <token>] [--addresses-only]    Show SOL and registered-token balances
  sowl token <token_ca> [name] [--metadata-json <json>]
  sowl token set <token|ca> [--pool <address>] [--quote-mint <mint>] [--quote-program <program>] [--metadata-json <json>]
  sowl token refresh <token|ca>
  sowl tokens

Metadata and launching
  sowl metadata upload --image <local_path> --name <name> --symbol <symbol> --description <text> [--provider pump-frontend|pinata]
                       [--twitter <url>] [--telegram <url>] [--website <url>] [--video <url>] [--hide-name]
  sowl deploy pump --wallet <wallet> --name <name> --symbol <symbol> (--uri <metadata_uri> | --image <local_path> --description <text>) [--alias <name>] [--live]
                   [--twitter <url>] [--telegram <url>] [--website <url>] [--video <url>] [--hide-name]
  sowl run launch-pump-token --creator <wallet> --metadata <token.json> [--creator-buy-sol <amount>] [--buyer-group <group>] [--live]
  sowl run prepare-pump-launch-alt --creator <wallet> --metadata <token.json> --creator-buy-sol <amount> [--create --live]

Prices
  sowl quote buy <token|ca> --sol <amount>           Inspect buy quote without submitting
  sowl price <token|ca>                              Sample current venue price
  sowl price average <token|ca> --period 15m         Average stored samples in a period
  sowl price watch <token|ca...> [--interval 1s] [--period 1m]

Trading
  sowl buy <token|ca> (--wallet <wallet> | --wallets <w1,w2> | --group <name>) --sol <amount> [--slippage-bps 1500] [--sender rpc|helius|jito] [--simulate-only]
  sowl sell <token|ca> (--wallet <wallet> | --wallets <w1,w2> | --group <name>) [--bps 10000] [--slippage-bps 1500] [--sender rpc|helius|jito] [--simulate-only]
  sowl unwrap-wsol (--wallet <wallet> | --wallets <w1,w2> | --group <name>) [--sender rpc|helius|jito] [--ignore-missing] [--simulate-only]
  sowl claim <token|ca> --wallet <wallet> [--sender rpc|helius|jito]

Scripts (strategies stay outside the kernel)
  sowl scripts                              List scripts registered in sowl.config.ts
  sowl run <name-or-path> [script flags...] Execute a script that imports sowl
  sowl run snipe --name <exact_name> --group <group> --sol 0.05 --sender jito
  sowl run claim-trade-send --claim <token> --buy <token> --wallet <wallet> --recipient <address>

Groups and agents
  sowl group create <name> [description]
  sowl group add <group> <wallet> [weight_bps]
  sowl group add-many <group> <wallet1,wallet2,...>
  sowl group show <group>
  sowl group list
  sowl buy <token|ca> --group <name> --sol <amount> --sender jito      Submit group buys as Jito bundles, five tx per bundle
  sowl sell <token|ca> --group <name> --sender jito              Submit group sells as Jito bundles, five tx per bundle
  sowl agent create <name> --wallet <wallet> [--config-json <json>]
  sowl agent list

Watching
  sowl watch token <token|ca> [label]
  sowl watch wallet <wallet> [label]
  sowl watch program <address> [label]
  sowl watch list

Transactions and ALTs
  sowl history
  sowl jito tip-accounts [--endpoint <block-engine-url>]
  sowl alt add <address> [label]
  sowl alt list
  sowl alt create --wallet <wallet>
  sowl alt extend <address> --wallet <wallet> <account...>

Environment
  SOWL_DB_PATH      local shared database; default ./sowl.db
  SOWL_MASTER_KEY   required to import/decrypt stored wallets
  RPC_ENDPOINT      required only for chain operations
  HELIUS_SENDER_URL regional/global Helius Sender endpoint used by launch scripts
  HELIUS_RPC_URL    RPC endpoint used for ordinary Helius-RPC buyer lane
  HELIUS_TIP_ACCOUNT, HELIUS_TIP_LAMPORTS, HELIUS_PRIORITY_MICRO_LAMPORTS launch transport policy
  SOWL_LAUNCH_*     launch resend/timeout policy; shared environment, not per-token metadata
  JITO_BLOCK_ENGINE_URL only when explicitly selecting the separate Jito sender
  SOWL_METADATA_UPLOADER metadata provider; default pump-frontend; optional pinata
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
  if (command === "scripts") {
    emit(json(await listScripts()) + "\n");
    return;
  }
  if (command === "run") {
    const [script, ...scriptArgs] = rest;
    if (!script)
      throw new Error("Usage: sowl run <name-or-path> [script flags...]");
    process.exitCode = await runScript(script, scriptArgs);
    return;
  }
  if (command === "jito" && values[0] === "tip-accounts") {
    const endpoint = (
      flags.get("endpoint") ??
      process.env.JITO_BLOCK_ENGINE_URL ??
      "https://mainnet.block-engine.jito.wtf"
    ).replace(/\/$/, "");
    const response = await fetch(`${endpoint}/api/v1/bundles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "getTipAccounts",
        params: [],
      }),
    });
    const payload = (await response.json()) as {
      result?: string[];
      error?: unknown;
    };
    if (!response.ok || payload.error || !Array.isArray(payload.result))
      throw new Error(
        `Jito getTipAccounts failed: ${JSON.stringify(payload.error ?? response.status)}`,
      );
    emit(json({ endpoint, tipAccounts: payload.result }) + "\n");
    return;
  }
  if (command === "metadata" && values[0] === "upload") {
    const { uploadPumpMetadata } = await import("./metadata/pump-metadata.js");
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
          process.env.SOWL_METADATA_UPLOADER ??
          "pump-frontend") as "pump-frontend" | "pinata",
        endpoint: flags.get("endpoint"),
        fallback: flags.get("fallback") === "pinata" ? "pinata" : null,
      },
    );
    emit(json(uploaded) + "\n");
    return;
  }
  const [{ sol, formatRaw }, { shortKey }, { createTraderSowl }] =
    await Promise.all([
      import("./core/amounts.js"),
      import("./core/log.js"),
      import("./presets/trader.js"),
    ]);
  const sowl = createTraderSowl();
  try {
    if (command === "import") {
      const input = flags.has("stdin")
        ? (await new Response(Bun.stdin.stream()).text()).trim()
        : values[0];
      if (!input)
        throw new Error(
          "Usage: sowl import <private_key> [name] or cat key.json | sowl import --stdin [name]",
        );
      const name = flags.has("stdin") ? values[0] : values[1];
      const wallet = sowl.importWallet(input, name);
      emit(`${OWL} imported @${wallet.name} ${wallet.address}\n`);
      return;
    }
    if (command === "wallets") {
      const wallets = sowl.wallets.list();
      if (flags.has("addresses-only")) {
        for (const wallet of wallets)
          emit(`@${wallet.name}\t${wallet.address}\n`);
        return;
      }
      const selectedTokens = flags.get("token")
        ? [sowl.resolveToken(flags.get("token")!)]
        : sowl.tokens.list();
      for (const wallet of wallets) {
        const balances = await sowl.walletBalances(wallet, selectedTokens);
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
        const { uploadPumpMetadata } =
          await import("./metadata/pump-metadata.js");
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
              process.env.SOWL_METADATA_UPLOADER ??
              "pump-frontend") as "pump-frontend" | "pinata",
            endpoint: flags.get("endpoint"),
            fallback: flags.get("fallback") === "pinata" ? "pinata" : null,
          },
        );
        uri = (uploadedMetadata as { metadataUri: string }).metadataUri;
      }
      const creator = flags.get("creator")
        ? sowl.resolveWallet(flags.get("creator")!).address
        : sowl.signer(wallet).publicKey;
      const deployment = await sowl.prepareTokenDeployment(launchpad, wallet, {
        name,
        symbol,
        uri,
        creator,
        mayhemMode: flags.has("mayhem"),
        cashback: flags.has("cashback"),
      });
      const plan = await sowl
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
        const simulation = await sowl.simulatePlan(plan);
        emit(json({ ...header, simulation }) + "\n");
        return;
      }
      const receipt = await sowl.sendPlan(
        plan,
        flags.get("sender") ?? "rpc",
        `deploy:${launchpad}`,
        {
          skipSimulation: flags.has("skip-simulation"),
          skipPreflight: flags.has("skip-simulation"),
        },
      );
      const token = sowl.persistPreparedDeployment(
        deployment,
        flags.get("alias"),
      );
      emit(json({ ...header, receipt, token }) + "\n");
      return;
    }
    if (command === "token" && values[0] !== "set" && values[0] !== "refresh") {
      const [mint, name] = values;
      if (!mint) throw new Error("Usage: sowl token <token_ca> [name]");
      const metadata = flags.get("metadata-json");
      const token = await sowl.addToken(
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
      if (!ref) throw new Error("Usage: sowl token refresh <token|ca>");
      emit(json(await sowl.refreshToken(ref)) + "\n");
      return;
    }
    if (command === "token" && values[0] === "set") {
      const ref = values[1];
      if (!ref) throw new Error("Usage: sowl token set <token|ca> [flags]");
      const patch: Partial<TokenRow> = {};
      if (flags.get("pool")) patch.pool = flags.get("pool");
      if (flags.get("quote-mint")) patch.quoteMint = flags.get("quote-mint");
      if (flags.get("quote-program"))
        patch.quoteTokenProgram = flags.get("quote-program");
      if (flags.get("metadata-json"))
        patch.metadataJson = flags.get("metadata-json");
      const token = sowl.configureToken(ref, patch);
      emit(`${OWL} updated ${token.name ?? shortKey(token.mint)}\n`);
      return;
    }
    if (command === "tokens") {
      for (const token of sowl.tokens.list())
        emit(
          `${token.name ?? "-"}\t${token.symbol ? "$" + token.symbol : "-"}\t${token.mint}\t${token.venueHint}\n`,
        );
      return;
    }
    if (command === "quote" && values[0] === "buy") {
      const tokenRef = values[1];
      if (!tokenRef)
        throw new Error(
          "Usage: sowl quote buy <token|ca> --sol <amount> [--slippage-bps 1500]",
        );
      const spend = need(flags, "sol");
      const result = await sowl.quoteBuy(
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
        throw new Error("Usage: sowl price average <token|ca> --period 15m");
      const token = sowl.resolveToken(tokenRef);
      const window = sowl.averagePrice(
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
          "Usage: sowl price watch <token|ca...> [--interval 1s] [--period 1m]",
        );
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      for await (const event of sowl.watchPrices(tokenRefs, {
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
      if (!tokenRef) throw new Error("Usage: sowl price <token|ca>");
      const token = sowl.resolveToken(tokenRef);
      const sample = await sowl.samplePrice(token);
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
          "Usage: sowl buy <token|ca> (--wallet <wallet> | --wallets <w1,w2> | --group <group>) --sol <amount>",
        );
      const amount = flags.get("sol");
      if (!amount) throw new Error("Buy requires explicit --sol <amount>");
      const targets = targetWallets(
        sowl,
        flags,
        "Usage: sowl buy <token|ca> (--wallet <wallet> | --wallets <w1,w2> | --group <group>) --sol <amount>.",
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
                await sowl
                  .tx(targets.refs[0]!)
                  .buy(token, sol(amount), options)
                  .build(),
              ]
            : await sowl
                .composeMany(targets.refs)
                .buy(token, sol(amount), options)
                .build();
        const results = await Promise.all(
          plans.map((plan) => sowl.simulatePlan(plan)),
        );
        emit(json({ mode: "simulation", target: targets, results }) + "\n");
        return;
      }
      const receipts =
        targets.refs.length === 1
          ? await sowl.buy(token, targets.refs[0]!, sol(amount), options)
          : await sowl.buyMany(token, targets.refs, sol(amount), options);
      emit(json(receipts) + "\n");
      return;
    }
    if (command === "sell") {
      const token = values[0];
      if (!token)
        throw new Error(
          "Usage: sowl sell <token|ca> (--wallet <wallet> | --wallets <w1,w2> | --group <group>)",
        );
      const targets = targetWallets(
        sowl,
        flags,
        "Usage: sowl sell <token|ca> (--wallet <wallet> | --wallets <w1,w2> | --group <group>).",
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
            ? [await sowl.tx(targets.refs[0]!).sell(token, sellOptions).build()]
            : await sowl
                .composeMany(targets.refs)
                .sell(token, sellOptions)
                .build();
        const results = await Promise.all(
          plans.map((plan) => sowl.simulatePlan(plan)),
        );
        emit(json({ mode: "simulation", target: targets, results }) + "\n");
        return;
      }
      const receipts =
        targets.refs.length === 1
          ? await sowl.sell(token, targets.refs[0]!, sellOptions)
          : await sowl.sellMany(token, targets.refs, sellOptions);
      emit(json(receipts) + "\n");
      return;
    }
    if (
      command === "unwrap-wsol" ||
      (command === "unwrap" && values[0] === "wsol")
    ) {
      const targets = targetWallets(
        sowl,
        flags,
        "Usage: sowl unwrap-wsol (--wallet <wallet> | --wallets <w1,w2> | --group <group>).",
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
                await sowl
                  .tx(targets.refs[0]!)
                  .unwrapWsol({
                    destination,
                    skipMissing: unwrapOptions.skipMissing,
                  })
                  .build(),
              ]
            : await sowl
                .composeMany(targets.refs)
                .unwrapWsol({ skipMissing: unwrapOptions.skipMissing })
                .build();
        const results = await Promise.all(
          plans.map((plan) => sowl.simulatePlan(plan)),
        );
        emit(json({ mode: "simulation", target: targets, results }) + "\n");
        return;
      }
      const receipts =
        targets.refs.length === 1
          ? await sowl.unwrapWsol(targets.refs[0]!, unwrapOptions)
          : await sowl.unwrapWsolMany(targets.refs, unwrapOptions);
      emit(json(receipts) + "\n");
      return;
    }
    if (command === "claim") {
      const token = values[0];
      if (!token)
        throw new Error("Usage: sowl claim <token|ca> --wallet <wallet>");
      emit(
        json(
          await sowl.claim(token, need(flags, "wallet"), {
            via: flags.get("sender") ?? "rpc",
          }),
        ) + "\n",
      );
      return;
    }
    if (command === "history") {
      emit(json(sowl.executions.history()) + "\n");
      return;
    }
    if (command === "group" && values[0] === "create") {
      const name = values[1];
      if (!name)
        throw new Error("Usage: sowl group create <name> [description]");
      emit(
        json(sowl.groups.create(name, values.slice(2).join(" ") || undefined)) +
          "\n",
      );
      return;
    }
    if (command === "group" && values[0] === "add") {
      const [_, group, wallet, weight] = values;
      if (!group || !wallet)
        throw new Error("Usage: sowl group add <group> <wallet> [weight_bps]");
      const resolved = sowl.resolveWallet(wallet);
      emit(
        json(
          sowl.groups.addWallet(
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
          "Usage: sowl group add-many <group> <wallet1,wallet2,...>",
        );
      sowl.groups.create(group);
      const members = raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((ref) => {
          const resolved = sowl.resolveWallet(ref);
          return sowl.groups.addWallet(
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
      if (!group) throw new Error("Usage: sowl group show <group>");
      const members = sowl.groups.wallets(group).map((row) => {
        const wallet = sowl.resolveWallet(row.walletAddress);
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
      emit(json(sowl.groups.list()) + "\n");
      return;
    }
    if (command === "agent" && values[0] === "create") {
      const name = values[1];
      if (!name)
        throw new Error(
          "Usage: sowl agent create <name> --wallet <wallet> [--config-json <json>]",
        );
      const supplied = flags.get("config-json")
        ? (JSON.parse(flags.get("config-json")!) as Record<string, unknown>)
        : {};
      const wallet = need(flags, "wallet");
      const agent = sowl.configureAgent(name, { ...supplied, wallet });
      emit(json(agent.row) + "\n");
      return;
    }
    if (command === "agent" && values[0] === "list") {
      emit(json(sowl.listAgents()) + "\n");
      return;
    }
    if (command === "watch" && values[0] === "token") {
      const ref = values[1];
      if (!ref) throw new Error("Usage: sowl watch token <token|ca> [label]");
      emit(json(sowl.watchToken(ref, values[2])) + "\n");
      return;
    }
    if (command === "watch" && values[0] === "wallet") {
      const ref = values[1];
      if (!ref) throw new Error("Usage: sowl watch wallet <wallet> [label]");
      emit(json(sowl.watchWallet(ref, values[2])) + "\n");
      return;
    }
    if (command === "watch" && values[0] === "program") {
      const address = values[1];
      if (!address)
        throw new Error("Usage: sowl watch program <address> [label]");
      emit(json(sowl.watchProgram(address, values[2])) + "\n");
      return;
    }
    if (command === "watch" && values[0] === "list") {
      emit(json(sowl.db.watches.select().where({ isActive: 1 }).all()) + "\n");
      return;
    }
    if (command === "alt" && values[0] === "add") {
      if (!values[1]) throw new Error("Usage: sowl alt add <address> [label]");
      emit(json(sowl.alts.register(values[1], values[2])) + "\n");
      return;
    }
    if (command === "alt" && values[0] === "list") {
      emit(json(sowl.alts.list()) + "\n");
      return;
    }
    if (command === "alt" && values[0] === "create") {
      emit(json(await sowl.createAlt(need(flags, "wallet"))) + "\n");
      return;
    }
    if (command === "alt" && values[0] === "extend") {
      if (!values[1] || values.length < 3)
        throw new Error(
          "Usage: sowl alt extend <address> --wallet <wallet> <account...>",
        );
      emit(
        json(
          await sowl.extendAlt(
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
    sowl.close();
  }
}
main().catch((error) => {
  emit(`${OWL} error: ${formatError(error)}\n`);
  process.exitCode = 1;
});
