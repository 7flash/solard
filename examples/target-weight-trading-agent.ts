#!/usr/bin/env bun
import {
  configureSolardMeasure,
  createSolardMeasure,
  createTraderSolard,
  executeJupiterSwap,
  quoteJupiterSwap,
  quoteJupiterTokenToSol,
  targetWeightGapPct,
  type JupiterSwapQuote,
  type TargetWeightCandle,
  type TargetWeightPolicy,
} from "@solard/sdk";
import {
  TradingDashboard,
  createTradingAudit,
  defaultTradingLogPath,
  fmtPct,
  fmtSol,
  short,
  sleep,
} from "./lib/trading-terminal.ts";

const WSOL = "So11111111111111111111111111111111111111112";
const FIVE_MINUTES_MS = 300_000;
const m = createSolardMeasure("target-weight-agent");
type Flags = Map<string, string>;

type SampleCandle = TargetWeightCandle & {
  firstSampleAtMs: number;
  lastSampleAtMs: number;
  samples: number;
};

type TokenInventory = {
  amountRaw: bigint;
  decimals: number | null;
  amountUi: number | null;
  accountCount: number;
};

type Snapshot = {
  atMs: number;
  tokenRaw: bigint;
  tokenUi: number | null;
  tokenDecimals: number | null;
  liquidationSol: number;
  walletSol: number;
  strategySol: number;
  navSol: number;
  weightPct: number;
  effectivePriceSol: number | null;
  liquidationQuote: JupiterSwapQuote | null;
};

function parseArgs(argv: string[]): Flags {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]!;
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
    if (inline != null) flags.set(key!, inline);
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--"))
      flags.set(key!, argv[++i]!);
    else flags.set(key!, "true");
  }
  return flags;
}

function flag(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return value && value !== "true" ? value : undefined;
}

function required(flags: Flags, key: string): string {
  const value = flag(flags, key);
  if (!value) throw new Error(`Missing --${key} <value>`);
  return value;
}

function numberFlag(flags: Flags, key: string, fallback: number): number {
  const raw = flag(flags, key);
  if (raw == null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key}: ${raw}`);
  return parsed;
}

function integerFlag(flags: Flags, key: string, fallback: number): number {
  return Math.trunc(numberFlag(flags, key, fallback));
}

function liveEnabled(): boolean {
  return [
    process.env.SOLARD_ENABLE_LIVE_TRADES,
    process.env.SLRD_ENABLE_LIVE_TRADES,
    process.env.SOLWAL_ENABLE_LIVE_TRADES,
  ].some((value) => value === "1" || value === "true");
}

function resolveMint(
  slrd: ReturnType<typeof createTraderSolard>,
  ref: string,
): string {
  try {
    return slrd.resolveToken(ref).mint;
  } catch {
    return ref;
  }
}

function makePolicy(flags: Flags, targetWeightPct: number): TargetWeightPolicy {
  const mode = flag(flags, "gap-mode") ?? "fixed";
  if (mode !== "fixed" && mode !== "previous-5m-vol") {
    throw new Error("--gap-mode must be fixed or previous-5m-vol");
  }
  return {
    version: 1,
    kind: "target-weight",
    name: "interactive executable-value target-weight controller",
    targetWeightPct,
    gap: {
      mode,
      outerPct: numberFlag(flags, "gap-pct", 3),
      innerPct: numberFlag(flags, "inner-gap-pct", 1),
      volatilityMultiplier: numberFlag(flags, "vol-multiplier", 2),
      minPct: numberFlag(flags, "min-gap-pct", 1),
      maxPct: numberFlag(flags, "max-gap-pct", 8),
    },
    minTradeSol: numberFlag(flags, "min-trade-sol", 0.01),
  };
}

function addSample(
  candles: Map<number, SampleCandle>,
  atMs: number,
  price: number,
): void {
  if (!(price > 0) || !Number.isFinite(price)) return;
  const startMs = Math.floor(atMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  const existing = candles.get(startMs);
  if (!existing) {
    candles.set(startMs, {
      startMs,
      endMs: startMs + FIVE_MINUTES_MS,
      open: price,
      high: price,
      low: price,
      close: price,
      firstSampleAtMs: atMs,
      lastSampleAtMs: atMs,
      samples: 1,
    });
    return;
  }
  existing.high = Math.max(existing.high, price);
  existing.low = Math.min(existing.low, price);
  existing.close = price;
  existing.lastSampleAtMs = atMs;
  existing.samples += 1;
}

function completePreviousCandle(
  candles: Map<number, SampleCandle>,
  boundaryMs: number,
  sampleMs: number,
): SampleCandle | null {
  const candle = candles.get(boundaryMs - FIVE_MINUTES_MS) ?? null;
  if (!candle) return null;
  const tolerance = Math.max(sampleMs * 2, 10_000);
  return candle.firstSampleAtMs <= candle.startMs! + tolerance &&
    candle.lastSampleAtMs >= candle.endMs! - tolerance
    ? candle
    : null;
}

async function tokenInventory(
  slrd: ReturnType<typeof createTraderSolard>,
  walletRef: string,
  mint: string,
): Promise<TokenInventory> {
  const accounts = (await slrd.tokenAccounts(walletRef)).filter(
    (row) => row.mint === mint && row.isAssociated && row.amountRaw > 0n,
  );
  const amountRaw = accounts.reduce((sum, row) => sum + row.amountRaw, 0n);
  const decimals = accounts[0]?.decimals ?? null;
  const amountUi = decimals == null ? null : Number(amountRaw) / 10 ** decimals;
  return { amountRaw, decimals, amountUi, accountCount: accounts.length };
}

async function snapshot(
  slrd: ReturnType<typeof createTraderSolard>,
  walletRef: string,
  mint: string,
  reserveSol: number,
): Promise<Snapshot> {
  const [inventory, wallet] = await Promise.all([
    tokenInventory(slrd, walletRef, mint),
    slrd.resolveWallet(walletRef),
  ]);
  const walletSol =
    Number(await slrd.connection().getBalance(wallet.address, "confirmed")) /
    1e9;
  const strategySol = Math.max(0, walletSol - reserveSol);
  let liquidationQuote: JupiterSwapQuote | null = null;
  let liquidationSol = 0;
  if (inventory.amountRaw > 0n) {
    liquidationQuote = await quoteJupiterTokenToSol({
      inputMint: mint,
      amountRaw: inventory.amountRaw,
    });
    liquidationSol = Number(liquidationQuote.outAmountRaw) / 1e9;
  }
  const navSol = strategySol + liquidationSol;
  const weightPct = navSol > 0 ? (liquidationSol / navSol) * 100 : 0;
  const effectivePriceSol =
    inventory.amountUi != null && inventory.amountUi > 0
      ? liquidationSol / inventory.amountUi
      : null;
  return {
    atMs: Date.now(),
    tokenRaw: inventory.amountRaw,
    tokenUi: inventory.amountUi,
    tokenDecimals: inventory.decimals,
    liquidationSol,
    walletSol,
    strategySol,
    navSol,
    weightPct,
    effectivePriceSol,
    liquidationQuote,
  };
}

async function futureBuyWeight(args: {
  mint: string;
  currentRaw: bigint;
  strategySol: number;
  buyLamports: bigint;
}): Promise<{
  weightPct: number;
  buyQuote: JupiterSwapQuote;
  futureLiquidationSol: number;
}> {
  const buyQuote = await quoteJupiterSwap({
    inputMint: WSOL,
    outputMint: args.mint,
    amountRaw: args.buyLamports,
  });
  const futureRaw = args.currentRaw + buyQuote.outAmountRaw;
  const futureLiquidation = await quoteJupiterTokenToSol({
    inputMint: args.mint,
    amountRaw: futureRaw,
  });
  const futureLiquidationSol = Number(futureLiquidation.outAmountRaw) / 1e9;
  const futureSol = Math.max(
    0,
    args.strategySol - Number(args.buyLamports) / 1e9,
  );
  const nav = futureLiquidationSol + futureSol;
  return {
    weightPct: nav > 0 ? (futureLiquidationSol / nav) * 100 : 0,
    buyQuote,
    futureLiquidationSol,
  };
}

async function sizeBuyToWeight(args: {
  mint: string;
  currentRaw: bigint;
  strategySol: number;
  desiredWeightPct: number;
  iterations: number;
}): Promise<{
  amountRaw: bigint;
  expectedWeightPct: number;
  expectedTokensRaw: bigint;
}> {
  let low = 0n;
  let high = BigInt(Math.max(0, Math.floor(args.strategySol * 1e9)));
  if (high <= 0n)
    return { amountRaw: 0n, expectedWeightPct: 0, expectedTokensRaw: 0n };
  let best = high;
  let bestWeight = 0;
  let bestTokens = 0n;
  for (let i = 0; i < args.iterations && high - low > 1n; i += 1) {
    const mid = (low + high) / 2n;
    if (mid <= 0n) break;
    const evaluated = await futureBuyWeight({
      mint: args.mint,
      currentRaw: args.currentRaw,
      strategySol: args.strategySol,
      buyLamports: mid,
    });
    best = mid;
    bestWeight = evaluated.weightPct;
    bestTokens = evaluated.buyQuote.outAmountRaw;
    if (evaluated.weightPct < args.desiredWeightPct) low = mid + 1n;
    else high = mid;
  }
  if (best !== high && high > 0n) {
    const evaluated = await futureBuyWeight({
      mint: args.mint,
      currentRaw: args.currentRaw,
      strategySol: args.strategySol,
      buyLamports: high,
    });
    best = high;
    bestWeight = evaluated.weightPct;
    bestTokens = evaluated.buyQuote.outAmountRaw;
  }
  return {
    amountRaw: best,
    expectedWeightPct: bestWeight,
    expectedTokensRaw: bestTokens,
  };
}

async function futureSellWeight(args: {
  mint: string;
  currentRaw: bigint;
  strategySol: number;
  sellRaw: bigint;
}): Promise<{ weightPct: number; proceedsSol: number }> {
  const sellQuote = await quoteJupiterTokenToSol({
    inputMint: args.mint,
    amountRaw: args.sellRaw,
  });
  const proceedsSol = Number(sellQuote.outAmountRaw) / 1e9;
  const remainingRaw =
    args.currentRaw > args.sellRaw ? args.currentRaw - args.sellRaw : 0n;
  const remainingLiquidationSol =
    remainingRaw > 0n
      ? Number(
          (
            await quoteJupiterTokenToSol({
              inputMint: args.mint,
              amountRaw: remainingRaw,
            })
          ).outAmountRaw,
        ) / 1e9
      : 0;
  const futureSol = args.strategySol + proceedsSol;
  const nav = remainingLiquidationSol + futureSol;
  return {
    weightPct: nav > 0 ? (remainingLiquidationSol / nav) * 100 : 0,
    proceedsSol,
  };
}

async function sizeSellToWeight(args: {
  mint: string;
  currentRaw: bigint;
  strategySol: number;
  desiredWeightPct: number;
  iterations: number;
}): Promise<{
  amountRaw: bigint;
  expectedWeightPct: number;
  proceedsSol: number;
}> {
  let low = 1n;
  let high = args.currentRaw;
  if (high <= 0n)
    return { amountRaw: 0n, expectedWeightPct: 0, proceedsSol: 0 };
  let best = high;
  let bestWeight = 0;
  let bestProceeds = 0;
  for (let i = 0; i < args.iterations && high - low > 1n; i += 1) {
    const mid = (low + high) / 2n;
    const evaluated = await futureSellWeight({
      mint: args.mint,
      currentRaw: args.currentRaw,
      strategySol: args.strategySol,
      sellRaw: mid,
    });
    best = mid;
    bestWeight = evaluated.weightPct;
    bestProceeds = evaluated.proceedsSol;
    if (evaluated.weightPct > args.desiredWeightPct) low = mid + 1n;
    else high = mid;
  }
  if (best !== high && high > 0n) {
    const evaluated = await futureSellWeight({
      mint: args.mint,
      currentRaw: args.currentRaw,
      strategySol: args.strategySol,
      sellRaw: high,
    });
    best = high;
    bestWeight = evaluated.weightPct;
    bestProceeds = evaluated.proceedsSol;
  }
  return {
    amountRaw: best,
    expectedWeightPct: bestWeight,
    proceedsSol: bestProceeds,
  };
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.has("help")) {
    console.log(
      "Usage: slrd run examples/target-weight-trading-agent.ts --token <mint|alias> --wallet <wallet> " +
        "[--target-weight 40] [--gap-pct 3] [--inner-gap-pct 1] [--reserve-sol 0.02] " +
        "[--sample-ms 5000] [--sizing-iterations 4] [--rebalance-now] [--loop] [--live] [--log file.jsonl]",
    );
    return;
  }

  const tokenRef = required(flags, "token");
  const walletRef = required(flags, "wallet");
  let targetWeightPct = numberFlag(flags, "target-weight", 40);
  const stepWeightPct = Math.max(0.1, numberFlag(flags, "step-weight", 1));
  const reserveSol = Math.max(0, numberFlag(flags, "reserve-sol", 0.02));
  const sampleMs = Math.max(1_000, integerFlag(flags, "sample-ms", 5_000));
  const settleMs = Math.max(0, integerFlag(flags, "settle-ms", 5_000));
  const sizingIterations = Math.max(
    2,
    Math.min(8, integerFlag(flags, "sizing-iterations", 4)),
  );
  const live = flags.has("live");
  if (live && !liveEnabled()) {
    throw new Error(
      "Live target-weight trading requires --live and SOLARD_ENABLE_LIVE_TRADES=1",
    );
  }

  const slrd = createTraderSolard();
  const mint = resolveMint(slrd, tokenRef);
  const wallet = slrd.resolveWallet(walletRef).address.toBase58();
  const logPath =
    flag(flags, "log") ??
    defaultTradingLogPath(`target-weight-${short(wallet)}-${short(mint)}`);
  const audit = createTradingAudit(logPath);
  configureSolardMeasure({ silent: false, logger: audit.logger });
  const dashboard = new TradingDashboard(
    "SLRD TARGET-WEIGHT CONTROLLER",
    !flags.has("no-ui"),
  );
  const candles = new Map<number, SampleCandle>();
  let paused = false;
  let quitting = false;
  let manualRebalance = flags.has("rebalance-now");
  let lastAction = "starting";
  let lastError: string | null = null;
  let latest: Snapshot | null = null;

  const clampTarget = (value: number) => Math.max(1, Math.min(99, value));
  dashboard.keys({
    plus: () => {
      targetWeightPct = clampTarget(targetWeightPct + stepWeightPct);
      audit.event("control", { action: "target+", targetWeightPct });
    },
    minus: () => {
      targetWeightPct = clampTarget(targetWeightPct - stepWeightPct);
      audit.event("control", { action: "target-", targetWeightPct });
    },
    pause: () => {
      paused = !paused;
      audit.event("control", { action: paused ? "pause" : "resume" });
    },
    rebalance: () => {
      manualRebalance = true;
      audit.event("control", { action: "rebalance-now" });
    },
    quit: () => {
      quitting = true;
    },
  });

  audit.event("start", {
    mint,
    wallet,
    live,
    reserveSol,
    targetWeightPct,
    logPath,
    sizingIterations,
  });
  let nextBoundary =
    (Math.floor(Date.now() / FIVE_MINUTES_MS) + 1) * FIVE_MINUTES_MS;

  const render = () => {
    const policy = makePolicy(flags, targetWeightPct);
    let gap = policy.gap.outerPct;
    try {
      const prev = completePreviousCandle(candles, nextBoundary, sampleMs);
      gap = targetWeightGapPct(policy, prev).outerPct;
    } catch {
      // Adaptive mode may not have a complete candle yet.
    }
    dashboard.render(
      [
        ["Token", short(mint)],
        ["Wallet", short(wallet)],
        ["Mode", `${live ? "LIVE" : "DRY"}${paused ? " / PAUSED" : ""}`],
        ["Target", `${fmtPct(targetWeightPct)}  outer ±${gap.toFixed(2)}pp`],
        ["Current weight", fmtPct(latest?.weightPct)],
        ["Token liquidation", fmtSol(latest?.liquidationSol)],
        ["Strategy SOL", fmtSol(latest?.strategySol)],
        ["NAV", fmtSol(latest?.navSol)],
        [
          "Executable price",
          latest?.effectivePriceSol == null
            ? "-"
            : `${latest.effectivePriceSol.toExponential(6)} SOL/token`,
        ],
        ["Last action", lastAction],
        ["Last error", lastError ?? "-"],
        ["Log", audit.logPath],
      ],
      "+/- target  p pause  b rebalance now  q quit",
    );
  };

  async function rebalance(previousCandle: SampleCandle | null): Promise<void> {
    if (paused) {
      lastAction = "hold: paused";
      return;
    }
    const current =
      latest ?? (await snapshot(slrd, walletRef, mint, reserveSol));
    latest = current;
    const policy = makePolicy(flags, targetWeightPct);
    if (policy.gap.mode === "previous-5m-vol" && !previousCandle) {
      lastAction = "hold: waiting for complete previous 5m candle";
      return;
    }
    const gap = targetWeightGapPct(policy, previousCandle);
    const lower = targetWeightPct - gap.outerPct;
    const upper = targetWeightPct + gap.outerPct;
    const minTradeSol = policy.minTradeSol ?? 0;

    if (current.weightPct >= lower && current.weightPct <= upper) {
      lastAction = `hold: ${current.weightPct.toFixed(2)}% inside ${lower.toFixed(2)}..${upper.toFixed(2)}%`;
      audit.event("decision", {
        action: "hold",
        currentWeightPct: current.weightPct,
        lower,
        upper,
        targetWeightPct,
      });
      return;
    }

    if (current.weightPct < lower) {
      const desired = Math.max(0.1, targetWeightPct - gap.innerPct);
      const sized = await m(
        {
          start: () => "size executable buy to target weight",
          end: (v: any) => v,
        },
        () =>
          sizeBuyToWeight({
            mint,
            currentRaw: current.tokenRaw,
            strategySol: current.strategySol,
            desiredWeightPct: desired,
            iterations: sizingIterations,
          }),
      );
      const buySol = Number(sized.amountRaw) / 1e9;
      if (buySol < minTradeSol) {
        lastAction = `hold: buy ${buySol.toFixed(6)} < min ${minTradeSol}`;
        return;
      }
      const decision = {
        action: live ? "buy" : "would-buy",
        buySol,
        expectedWeightPct: sized.expectedWeightPct,
        expectedTokensRaw: sized.expectedTokensRaw.toString(),
        currentWeightPct: current.weightPct,
        desiredWeightPct: desired,
      };
      audit.event("decision", decision);
      if (!live) {
        lastAction = `would buy ${buySol.toFixed(6)} SOL → ~${sized.expectedWeightPct.toFixed(2)}%`;
        return;
      }
      const result = await executeJupiterSwap({
        inputMint: WSOL,
        outputMint: mint,
        amountRaw: sized.amountRaw,
        signer: slrd.signer(walletRef),
      });
      lastAction = `BUY ${buySol.toFixed(6)} SOL  ${result.signature ?? "submitted"}`;
      audit.event("execution", { ...decision, result });
      return;
    }

    const desired = Math.min(99.9, targetWeightPct + gap.innerPct);
    const sized = await m(
      {
        start: () => "size executable sell to target weight",
        end: (v: any) => v,
      },
      () =>
        sizeSellToWeight({
          mint,
          currentRaw: current.tokenRaw,
          strategySol: current.strategySol,
          desiredWeightPct: desired,
          iterations: sizingIterations,
        }),
    );
    if (sized.amountRaw <= 0n || sized.proceedsSol < minTradeSol) {
      lastAction = `hold: sell proceeds ${sized.proceedsSol.toFixed(6)} < min ${minTradeSol}`;
      return;
    }
    const decision = {
      action: live ? "sell" : "would-sell",
      sellRaw: sized.amountRaw.toString(),
      proceedsSol: sized.proceedsSol,
      expectedWeightPct: sized.expectedWeightPct,
      currentWeightPct: current.weightPct,
      desiredWeightPct: desired,
    };
    audit.event("decision", decision);
    if (!live) {
      lastAction = `would sell ~${sized.proceedsSol.toFixed(6)} SOL → ~${sized.expectedWeightPct.toFixed(2)}%`;
      return;
    }
    const result = await executeJupiterSwap({
      inputMint: mint,
      outputMint: WSOL,
      amountRaw: sized.amountRaw,
      signer: slrd.signer(walletRef),
    });
    lastAction = `SELL ~${sized.proceedsSol.toFixed(6)} SOL  ${result.signature ?? "submitted"}`;
    audit.event("execution", { ...decision, result });
  }

  try {
    while (!quitting) {
      try {
        latest = await m(
          {
            start: () => "executable portfolio snapshot",
            end: (v: Snapshot) => ({
              liquidationSol: v.liquidationSol,
              strategySol: v.strategySol,
              navSol: v.navSol,
              weightPct: v.weightPct,
            }),
          },
          () => snapshot(slrd, walletRef, mint, reserveSol),
        );
        if (latest.effectivePriceSol != null)
          addSample(candles, latest.atMs, latest.effectivePriceSol);
        lastError = null;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        audit.event("snapshot-error", { error: lastError });
        render();
        if (!flags.has("loop")) throw error;
        await sleep(sampleMs);
        continue;
      }

      const now = Date.now();
      if (manualRebalance || now >= nextBoundary + settleMs) {
        const boundary = nextBoundary;
        const previousCandle = completePreviousCandle(
          candles,
          boundary,
          sampleMs,
        );
        if (now >= nextBoundary + settleMs) nextBoundary += FIVE_MINUTES_MS;
        manualRebalance = false;
        try {
          await rebalance(previousCandle);
          latest = await snapshot(slrd, walletRef, mint, reserveSol);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          lastAction = "rebalance failed";
          audit.event("rebalance-error", { error: lastError });
          if (!flags.has("loop") || flags.has("fail-fast")) throw error;
        }
      }

      render();
      if (!flags.has("loop")) return;
      const staleBefore = Date.now() - FIVE_MINUTES_MS * 3;
      for (const key of candles.keys())
        if (key < staleBefore) candles.delete(key);
      await sleep(sampleMs);
    }
  } finally {
    audit.event("stop", {
      reason: quitting ? "user" : "exit",
      measure: audit.measureSummary(),
    });
    dashboard.close();
  }
}

main().catch((error) => {
  process.stderr.write(
    `TARGET-WEIGHT AGENT ERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
