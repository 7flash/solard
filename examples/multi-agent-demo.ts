#!/usr/bin/env bun
import slrd from "@solard/sdk";
import { connectPriceFeed } from "./lib/price-feed-client.ts";
import {
  getProcess,
  handleRun,
  isProcessRunning,
  terminateProcess,
} from "bgrun";

async function main(): Promise<void> {
  const role = process.env.SOLARD_DEMO_ROLE?.trim();

  if (role === "agent") {
    const token = process.env.SOLARD_DEMO_TOKEN?.trim();
    const wallet = process.env.SOLARD_DEMO_WALLET?.trim();
    const strategy = process.env.SOLARD_DEMO_STRATEGY?.trim();
    const live = process.env.SOLARD_DEMO_LIVE === "1";
    const buySol = Number(process.env.SOLARD_DEMO_BUY_SOL ?? "0.01");
    const slippageBps = Number(process.env.SOLARD_DEMO_SLIPPAGE_BPS ?? "500");

    if (!token || !wallet || !strategy)
      throw new Error("Missing demo agent configuration");

    let holding = false;
    let entry: number | null = null;
    let high: number | null = null;
    let anchor: number | null = null;
    let samples: number[] = [];
    let busy = false;

    const feed = await connectPriceFeed({
      url: "ws://127.0.0.1:8788/ws",
      mints: token,
      async onMessage(message) {
        if (message.type !== "price" || message.mint !== token || busy) return;
        const price = message.market.priceSol;
        if (price == null || !Number.isFinite(price) || price <= 0) return;

        high = Math.max(high ?? price, price);
        anchor ??= price;
        samples.push(price);
        if (samples.length > 10) samples.shift();

        let side: "buy" | "sell" | null = null;

        if (
          holding &&
          entry != null &&
          (price >= entry * 1.1 || price <= entry * 0.94)
        ) {
          side = "sell";
        } else if (strategy === "dip" && !holding && price <= high * 0.92) {
          side = "buy";
        } else if (
          strategy === "momentum" &&
          !holding &&
          samples.length === 10 &&
          price >= samples[0]! * 1.025
        ) {
          side = "buy";
        } else if (strategy === "range") {
          if (!holding && price <= anchor * 0.96) side = "buy";
          else if (holding && price >= anchor * 1.04) side = "sell";
        }

        process.stdout.write(
          `${JSON.stringify({ strategy, wallet, price, holding, side })}\n`,
        );

        if (!side) return;
        busy = true;
        try {
          if (live) {
            const result =
              side === "buy"
                ? await slrd.buy({ wallet, token, amount: buySol, slippageBps })
                : await slrd.sell({
                    wallet,
                    token,
                    amount: "all",
                    slippageBps,
                  });
            if (result.status !== "confirmed") {
              throw new Error(
                `${result.signature} ${result.status}: ${result.error ?? "unknown error"}`,
              );
            }
            process.stdout.write(
              `${JSON.stringify({ strategy, side, signature: result.signature, status: result.status })}\n`,
            );
          }

          holding = side === "buy";
          if (side === "buy") entry = price;
          else {
            entry = null;
            high = price;
            anchor = price;
            samples = [];
          }
        } finally {
          busy = false;
        }
      },
    });

    process.stdout.write(
      `${JSON.stringify({ strategy, wallet, token, live, ready: true })}\n`,
    );
    await feed.closed;
    return;
  }

  const token = process.argv[2]?.trim();
  const live = process.argv.includes("--live");
  const buySol = Number(process.env.SOLARD_DEMO_BUY_SOL ?? "0.01");
  const slippageBps = Number(process.env.SOLARD_DEMO_SLIPPAGE_BPS ?? "500");

  if (!token)
    throw new Error(
      "Usage: bun examples/multi-agent-demo.ts <token-mint> [--live]",
    );
  if (!process.env.RPC_ENDPOINT?.trim())
    throw new Error("RPC_ENDPOINT is required");
  if (live && process.env.SOLARD_ENABLE_LIVE_TRADES !== "1") {
    throw new Error("Live demo requires SOLARD_ENABLE_LIVE_TRADES=1");
  }

  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && !entry[0].startsWith("BGR_"),
    ),
  );

  const feedProcess: any = getProcess("solard-price-feed");
  if (!feedProcess?.pid || !(await isProcessRunning(feedProcess.pid))) {
    await handleRun({
      action: "run",
      name: "solard-price-feed",
      command: "bun run examples/price-feed-server.ts",
      directory: process.cwd(),
      env: baseEnv,
      force: true,
      remoteName: "",
    } as any);
  }

  await Bun.sleep(500);

  const agents = [];
  for (const strategy of ["dip", "momentum", "range"] as const) {
    const walletName = `demo-${strategy}`;
    const wallet =
      slrd.listWallets().find((row) => row.name === walletName) ??
      slrd.createWallet(walletName);
    const processName = `solard-demo-${strategy}`;
    const oldProcess: any = getProcess(processName);
    if (oldProcess?.pid && (await isProcessRunning(oldProcess.pid))) {
      await terminateProcess(oldProcess.pid);
    }

    await handleRun({
      action: "run",
      name: processName,
      command: "bun run examples/multi-agent-demo.ts",
      directory: process.cwd(),
      env: {
        ...baseEnv,
        SOLARD_DEMO_ROLE: "agent",
        SOLARD_DEMO_TOKEN: token,
        SOLARD_DEMO_WALLET: walletName,
        SOLARD_DEMO_STRATEGY: strategy,
        SOLARD_DEMO_LIVE: live ? "1" : "0",
        SOLARD_DEMO_BUY_SOL: String(buySol),
        SOLARD_DEMO_SLIPPAGE_BPS: String(slippageBps),
      },
      force: true,
      remoteName: "",
    } as any);

    agents.push({
      strategy,
      wallet: walletName,
      address: wallet.address,
      process: processName,
    });
  }

  process.stdout.write(`${JSON.stringify({ token, live, agents }, null, 2)}\n`);
  slrd.close();
}

await main();
