#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  configureSolardMeasure,
  createSolardMeasure,
  createTraderSolard,
  executeJupiterSwap,
  quoteJupiterSwap,
  quoteJupiterTokenToSol,
  type JupiterSwapQuote,
} from "@solard/sdk";
import {
  normalizeValueBandPolicy,
  planValueBandDecision,
  type ValueBandBuyMode,
  type ValueBandPolicy,
} from "../packages/core/src/strategy/value-band.ts";
import {
  TradingDashboard,
  createTradingAudit,
  defaultTradingLogPath,
  fmtSol,
  short,
  sleep,
} from "./lib/trading-terminal.ts";

const WSOL = "So11111111111111111111111111111111111111112";
const m = createSolardMeasure("value-band-agent");
type Flags = Map<string, string>;

type Journal = {
  version: 1;
  wallet: string;
  mint: string;
  createdAtMs: number;
  updatedAtMs: number;
  lowerArmed: boolean;
  cumulativeBuySol: number;
  cumulativeSellSol: number;
  peakNetCapitalDeployedSol: number;
  executions: number;
};

type Snapshot = {
  atMs: number;
  amountRaw: bigint;
  decimals: number | null;
  amountUi: number | null;
  liquidationSol: number;
  walletSol: number;
  effectivePriceSol: number | null;
  quote: JupiterSwapQuote | null;
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

function buyMode(flags: Flags): ValueBandBuyMode {
  const raw = flag(flags, "buy-mode") ?? "same-value";
  if (raw === "match-current") return "same-value";
  if (raw === "same-value" || raw === "same-tokens" || raw === "to-base")
    return raw;
  throw new Error(
    "--buy-mode must be same-value, same-tokens, to-base, or match-current",
  );
}

function journalPath(flags: Flags, wallet: string, mint: string): string {
  return resolve(
    flag(flags, "state-file") ??
      `.solard/agents/value-band-${wallet.slice(0, 8)}-${mint.slice(0, 8)}.json`,
  );
}

function freshJournal(wallet: string, mint: string): Journal {
  const now = Date.now();
  return {
    version: 1,
    wallet,
    mint,
    createdAtMs: now,
    updatedAtMs: now,
    lowerArmed: true,
    cumulativeBuySol: 0,
    cumulativeSellSol: 0,
    peakNetCapitalDeployedSol: 0,
    executions: 0,
  };
}

function readJournal(path: string, wallet: string, mint: string): Journal {
  if (!existsSync(path)) return freshJournal(wallet, mint);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Journal>;
  if (
    parsed.version !== 1 ||
    parsed.wallet !== wallet ||
    parsed.mint !== mint
  ) {
    throw new Error(
      `State file ${path} belongs to another wallet/mint or unsupported version`,
    );
  }
  return {
    ...freshJournal(wallet, mint),
    ...parsed,
    lowerArmed: parsed.lowerArmed !== false,
    cumulativeBuySol: Math.max(0, Number(parsed.cumulativeBuySol ?? 0)),
    cumulativeSellSol: Math.max(0, Number(parsed.cumulativeSellSol ?? 0)),
    peakNetCapitalDeployedSol: Math.max(
      0,
      Number(parsed.peakNetCapitalDeployedSol ?? 0),
    ),
    executions: Math.max(0, Math.trunc(Number(parsed.executions ?? 0))),
  };
}

function writeJournal(path: string, journal: Journal): void {
  journal.updatedAtMs = Date.now();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function netCapital(journal: Journal): number {
  return Math.max(0, journal.cumulativeBuySol - journal.cumulativeSellSol);
}

function recordBuy(journal: Journal, sol: number): void {
  journal.cumulativeBuySol += sol;
  journal.peakNetCapitalDeployedSol = Math.max(
    journal.peakNetCapitalDeployedSol,
    netCapital(journal),
  );
  journal.executions += 1;
}

function recordSell(journal: Journal, sol: number): void {
  journal.cumulativeSellSol += sol;
  journal.executions += 1;
}

async function snapshot(
  slrd: ReturnType<typeof createTraderSolard>,
  walletRef: string,
  mint: string,
): Promise<Snapshot> {
  const wallet = slrd.resolveWallet(walletRef);
  const [accounts, lamports] = await Promise.all([
    slrd.tokenAccounts(walletRef),
    slrd.connection().getBalance(wallet.address, "confirmed"),
  ]);
  const mine = accounts.filter(
    (row) => row.mint === mint && row.isAssociated && row.amountRaw > 0n,
  );
  const amountRaw = mine.reduce((sum, row) => sum + row.amountRaw, 0n);
  const decimals = mine[0]?.decimals ?? null;
  const amountUi = decimals == null ? null : Number(amountRaw) / 10 ** decimals;
  let quote: JupiterSwapQuote | null = null;
  let liquidationSol = 0;
  if (amountRaw > 0n) {
    quote = await quoteJupiterTokenToSol({ inputMint: mint, amountRaw });
    liquidationSol = Number(quote.outAmountRaw) / 1e9;
  }
  return {
    atMs: Date.now(),
    amountRaw,
    decimals,
    amountUi,
    liquidationSol,
    walletSol: Number(lamports) / 1e9,
    effectivePriceSol:
      amountUi != null && amountUi > 0 ? liquidationSol / amountUi : null,
    quote,
  };
}

async function sizeSameTokens(args: {
  mint: string;
  tokenRaw: bigint;
  maxLamports: bigint;
  iterations: number;
}): Promise<{ lamports: bigint; expectedTokensRaw: bigint }> {
  if (args.tokenRaw <= 0n || args.maxLamports <= 0n)
    return { lamports: 0n, expectedTokensRaw: 0n };
  let low = 1n;
  let high = args.maxLamports;
  let best = high;
  let bestOut = 0n;
  for (let i = 0; i < args.iterations && high - low > 1n; i += 1) {
    const mid = (low + high) / 2n;
    const q = await quoteJupiterSwap({
      inputMint: WSOL,
      outputMint: args.mint,
      amountRaw: mid,
    });
    best = mid;
    bestOut = q.outAmountRaw;
    if (q.outAmountRaw < args.tokenRaw) low = mid + 1n;
    else high = mid;
  }
  const q = await quoteJupiterSwap({
    inputMint: WSOL,
    outputMint: args.mint,
    amountRaw: high,
  });
  best = high;
  bestOut = q.outAmountRaw;
  return { lamports: best, expectedTokensRaw: bestOut };
}

async function futureLiquidationForBuy(args: {
  mint: string;
  currentRaw: bigint;
  buyLamports: bigint;
}): Promise<{ liquidationSol: number; outRaw: bigint }> {
  const buy = await quoteJupiterSwap({
    inputMint: WSOL,
    outputMint: args.mint,
    amountRaw: args.buyLamports,
  });
  const totalRaw = args.currentRaw + buy.outAmountRaw;
  const sell = await quoteJupiterTokenToSol({
    inputMint: args.mint,
    amountRaw: totalRaw,
  });
  return {
    liquidationSol: Number(sell.outAmountRaw) / 1e9,
    outRaw: buy.outAmountRaw,
  };
}

async function sizeToBase(args: {
  mint: string;
  currentRaw: bigint;
  targetSol: number;
  maxLamports: bigint;
  iterations: number;
}): Promise<{
  lamports: bigint;
  expectedLiquidationSol: number;
  expectedTokensRaw: bigint;
}> {
  if (args.maxLamports <= 0n)
    return { lamports: 0n, expectedLiquidationSol: 0, expectedTokensRaw: 0n };
  let low = 1n;
  let high = args.maxLamports;
  let best = high;
  let bestLiq = 0;
  let bestOut = 0n;
  for (let i = 0; i < args.iterations && high - low > 1n; i += 1) {
    const mid = (low + high) / 2n;
    const evaluated = await futureLiquidationForBuy({
      mint: args.mint,
      currentRaw: args.currentRaw,
      buyLamports: mid,
    });
    best = mid;
    bestLiq = evaluated.liquidationSol;
    bestOut = evaluated.outRaw;
    if (evaluated.liquidationSol < args.targetSol) low = mid + 1n;
    else high = mid;
  }
  const evaluated = await futureLiquidationForBuy({
    mint: args.mint,
    currentRaw: args.currentRaw,
    buyLamports: high,
  });
  best = high;
  bestLiq = evaluated.liquidationSol;
  bestOut = evaluated.outRaw;
  return {
    lamports: best,
    expectedLiquidationSol: bestLiq,
    expectedTokensRaw: bestOut,
  };
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.has("help")) {
    console.log(
      "Usage: slrd run examples/value-band-trading-agent.ts --token <mint|alias> --wallet <wallet> " +
        "[--base-sol 0.1] [--lower-multiple 0.5] [--upper-multiple 1.8] [--sell-fraction 0.5] " +
        "[--buy-mode same-value|same-tokens|to-base] [--max-capital-sol 0.5] [--max-buy-sol 0.1] " +
        "[--scale-now] [--loop] [--live] [--log file.jsonl]",
    );
    return;
  }

  const tokenRef = required(flags, "token");
  const walletRef = required(flags, "wallet");
  let baseSol = Math.max(0.000001, numberFlag(flags, "base-sol", 0.1));
  const initialLowerMultiple = numberFlag(flags, "lower-sol", NaN);
  const initialUpperMultiple = numberFlag(flags, "upper-sol", NaN);
  const lowerRatio = Number.isFinite(initialLowerMultiple)
    ? initialLowerMultiple / baseSol
    : numberFlag(flags, "lower-multiple", 0.5);
  const upperRatio = Number.isFinite(initialUpperMultiple)
    ? initialUpperMultiple / baseSol
    : numberFlag(flags, "upper-multiple", 1.8);
  const sellFraction = numberFlag(flags, "sell-fraction", 0.5);
  const stepSol = Math.max(
    0.000001,
    numberFlag(flags, "step-sol", Math.max(0.01, baseSol * 0.1)),
  );
  const sampleMs = Math.max(1_000, integerFlag(flags, "sample-ms", 5_000));
  const cooldownMs = Math.max(0, integerFlag(flags, "cooldown-ms", 10_000));
  const sizingIterations = Math.max(
    2,
    Math.min(8, integerFlag(flags, "sizing-iterations", 4)),
  );
  const minTradeSol = Math.max(0, numberFlag(flags, "min-trade-sol", 0.001));
  const reserveSol = Math.max(0, numberFlag(flags, "reserve-sol", 0.02));
  const explicitMaxCapital = flag(flags, "max-capital-sol");
  const explicitMaxBuy = flag(flags, "max-buy-sol");
  const mode = buyMode(flags);
  const live = flags.has("live");
  if (live && !liveEnabled()) {
    throw new Error(
      "Live value-band trading requires --live and SOLARD_ENABLE_LIVE_TRADES=1",
    );
  }

  const slrd = createTraderSolard();
  const mint = resolveMint(slrd, tokenRef);
  const wallet = slrd.resolveWallet(walletRef).address.toBase58();
  const statePath = journalPath(flags, wallet, mint);
  const journal = readJournal(statePath, wallet, mint);
  const logPath =
    flag(flags, "log") ??
    defaultTradingLogPath(`value-band-${short(wallet)}-${short(mint)}`);
  const audit = createTradingAudit(logPath);
  configureSolardMeasure({ silent: false, logger: audit.logger });
  const dashboard = new TradingDashboard(
    "SLRD VALUE-BAND CONTROLLER",
    !flags.has("no-ui"),
  );

  let paused = false;
  let quitting = false;
  let scaleNow = flags.has("scale-now");
  let latest: Snapshot | null = null;
  let lastAction = "starting";
  let lastError: string | null = null;
  let lastTradeAt = 0;

  const policy = (): ValueBandPolicy =>
    normalizeValueBandPolicy({
      version: 1,
      kind: "value-band",
      name: "interactive executable-liquidation value band",
      baseSol,
      lowerMultiple: lowerRatio,
      upperMultiple: upperRatio,
      sellFraction,
      buyMode: mode,
      minTradeSol,
      maxCapitalDeployedSol: explicitMaxCapital
        ? Number(explicitMaxCapital)
        : baseSol * 5,
    });
  const maxBuySol = () =>
    Math.max(minTradeSol, explicitMaxBuy ? Number(explicitMaxBuy) : baseSol);

  dashboard.keys({
    plus: () => {
      baseSol += stepSol;
      audit.event("control", { action: "base+", baseSol });
    },
    minus: () => {
      baseSol = Math.max(stepSol, baseSol - stepSol);
      audit.event("control", { action: "base-", baseSol });
    },
    pause: () => {
      paused = !paused;
      audit.event("control", { action: paused ? "pause" : "resume" });
    },
    rearm: () => {
      journal.lowerArmed = true;
      if (live) writeJournal(statePath, journal);
      audit.event("control", { action: "rearm-lower" });
    },
    rebalance: () => {
      scaleNow = true;
      audit.event("control", { action: "scale-to-base" });
    },
    quit: () => {
      quitting = true;
    },
  });

  audit.event("start", {
    mint,
    wallet,
    live,
    baseSol,
    lowerRatio,
    upperRatio,
    sellFraction,
    buyMode: mode,
    statePath,
    logPath,
  });

  const render = () => {
    const p = normalizeValueBandPolicy(policy());
    const lower = p.baseSol * p.lowerMultiple;
    const upper = p.baseSol * p.upperMultiple;
    dashboard.render(
      [
        ["Token", short(mint)],
        ["Wallet", short(wallet)],
        ["Mode", `${live ? "LIVE" : "DRY"}${paused ? " / PAUSED" : ""}`],
        ["Band", `${fmtSol(lower)} ← ${fmtSol(p.baseSol)} → ${fmtSol(upper)}`],
        ["Liquidation value", fmtSol(latest?.liquidationSol)],
        ["Wallet SOL", fmtSol(latest?.walletSol)],
        [
          "Token amount",
          latest?.amountUi == null
            ? (latest?.amountRaw.toString() ?? "-")
            : latest.amountUi.toLocaleString(undefined, {
                maximumFractionDigits: 8,
              }),
        ],
        [
          "Executable price",
          latest?.effectivePriceSol == null
            ? "-"
            : `${latest.effectivePriceSol.toExponential(6)} SOL/token`,
        ],
        ["Lower armed", journal.lowerArmed ? "YES" : "NO"],
        [
          "Net capital",
          `${fmtSol(netCapital(journal))} / cap ${fmtSol(p.maxCapitalDeployedSol)}`,
        ],
        ["Peak net capital", fmtSol(journal.peakNetCapitalDeployedSol)],
        [
          "Gross buys/sells",
          `${journal.cumulativeBuySol.toFixed(6)} / ${journal.cumulativeSellSol.toFixed(6)} SOL`,
        ],
        ["Last action", lastAction],
        ["Last error", lastError ?? "-"],
        ["Log", audit.logPath],
      ],
      "+/- base  p pause  r rearm lower  b scale to base  q quit",
    );
  };

  async function availableBuyBudget(
    p: ReturnType<typeof normalizeValueBandPolicy>,
    snap: Snapshot,
  ): Promise<number> {
    const capitalRemaining = Math.max(
      0,
      p.maxCapitalDeployedSol - netCapital(journal),
    );
    const walletAvailable = Math.max(0, snap.walletSol - reserveSol);
    return Math.max(
      0,
      Math.min(capitalRemaining, walletAvailable, maxBuySol()),
    );
  }

  async function planBuy(
    p: ReturnType<typeof normalizeValueBandPolicy>,
    snap: Snapshot,
    forceToBase = false,
  ) {
    const maxSol = await availableBuyBudget(p, snap);
    if (maxSol < p.minTradeSol)
      return {
        lamports: 0n,
        expectedLiquidationSol: snap.liquidationSol,
        expectedTokensRaw: 0n,
        reason: "buy budget below minimum",
      };
    const maxLamports = BigInt(Math.floor(maxSol * 1e9));
    const selectedMode: ValueBandBuyMode = forceToBase ? "to-base" : p.buyMode;
    if (selectedMode === "same-value") {
      const spendSol = Math.min(maxSol, Math.max(0, snap.liquidationSol));
      if (spendSol < p.minTradeSol)
        return {
          lamports: 0n,
          expectedLiquidationSol: snap.liquidationSol,
          expectedTokensRaw: 0n,
          reason: "same-value buy below minimum",
        };
      const lamports = BigInt(Math.floor(spendSol * 1e9));
      const q = await quoteJupiterSwap({
        inputMint: WSOL,
        outputMint: mint,
        amountRaw: lamports,
      });
      return {
        lamports,
        expectedLiquidationSol: NaN,
        expectedTokensRaw: q.outAmountRaw,
        reason: "same-value",
      };
    }
    if (selectedMode === "same-tokens") {
      const sized = await sizeSameTokens({
        mint,
        tokenRaw: snap.amountRaw,
        maxLamports,
        iterations: sizingIterations,
      });
      return {
        lamports: sized.lamports,
        expectedLiquidationSol: NaN,
        expectedTokensRaw: sized.expectedTokensRaw,
        reason: "same-tokens",
      };
    }
    const sized = await sizeToBase({
      mint,
      currentRaw: snap.amountRaw,
      targetSol: p.baseSol,
      maxLamports,
      iterations: sizingIterations,
    });
    return {
      lamports: sized.lamports,
      expectedLiquidationSol: sized.expectedLiquidationSol,
      expectedTokensRaw: sized.expectedTokensRaw,
      reason: "to-base",
    };
  }

  async function executeBuy(
    snap: Snapshot,
    forceToBase = false,
  ): Promise<void> {
    const p = normalizeValueBandPolicy(policy());
    const sized = await m(
      {
        start: () =>
          forceToBase
            ? "size scale-to-base buy"
            : `size lower-band ${p.buyMode} buy`,
        end: (v: any) => v,
      },
      () => planBuy(p, snap, forceToBase),
    );
    const buySol = Number(sized.lamports) / 1e9;
    if (buySol < p.minTradeSol) {
      lastAction = `hold: ${sized.reason}`;
      return;
    }
    const decision = {
      action: live ? "buy" : "would-buy",
      reason: sized.reason,
      buySol,
      expectedTokensRaw: sized.expectedTokensRaw.toString(),
      expectedLiquidationSol: Number.isFinite(sized.expectedLiquidationSol)
        ? sized.expectedLiquidationSol
        : null,
      liquidationBeforeSol: snap.liquidationSol,
      forceToBase,
    };
    audit.event("decision", decision);
    if (!live) {
      lastAction = `would buy ${buySol.toFixed(6)} SOL (${sized.reason})`;
      return;
    }
    const result = await executeJupiterSwap({
      inputMint: WSOL,
      outputMint: mint,
      amountRaw: sized.lamports,
      signer: slrd.signer(walletRef),
    });
    recordBuy(journal, buySol);
    if (!forceToBase) journal.lowerArmed = false;
    writeJournal(statePath, journal);
    lastTradeAt = Date.now();
    lastAction = `BUY ${buySol.toFixed(6)} SOL  ${result.signature ?? "submitted"}`;
    audit.event("execution", { ...decision, result, journal });
  }

  async function executeSell(snap: Snapshot): Promise<void> {
    const p = normalizeValueBandPolicy(policy());
    const sellRaw =
      (snap.amountRaw * BigInt(Math.floor(p.sellFraction * 1_000_000))) /
      1_000_000n;
    if (sellRaw <= 0n) {
      lastAction = "hold: sell amount rounded to zero";
      return;
    }
    const quote = await quoteJupiterTokenToSol({
      inputMint: mint,
      amountRaw: sellRaw,
    });
    const proceedsSol = Number(quote.outAmountRaw) / 1e9;
    if (proceedsSol < p.minTradeSol) {
      lastAction = `hold: sell proceeds ${proceedsSol.toFixed(6)} < min ${p.minTradeSol}`;
      return;
    }
    const decision = {
      action: live ? "sell" : "would-sell",
      sellRaw: sellRaw.toString(),
      sellFraction: p.sellFraction,
      expectedProceedsSol: proceedsSol,
      liquidationBeforeSol: snap.liquidationSol,
    };
    audit.event("decision", decision);
    if (!live) {
      lastAction = `would sell ${(p.sellFraction * 100).toFixed(1)}% for ~${proceedsSol.toFixed(6)} SOL`;
      return;
    }
    const result = await executeJupiterSwap({
      inputMint: mint,
      outputMint: WSOL,
      amountRaw: sellRaw,
      signer: slrd.signer(walletRef),
    });
    const actualRaw = result.outputAmountResult ?? result.totalOutputAmount;
    const actualSol =
      actualRaw && /^\d+$/.test(actualRaw)
        ? Number(BigInt(actualRaw)) / 1e9
        : proceedsSol;
    recordSell(journal, actualSol);
    writeJournal(statePath, journal);
    lastTradeAt = Date.now();
    lastAction = `SELL ${(p.sellFraction * 100).toFixed(1)}% ~${actualSol.toFixed(6)} SOL  ${result.signature ?? "submitted"}`;
    audit.event("execution", { ...decision, actualSol, result, journal });
  }

  try {
    while (!quitting) {
      try {
        latest = await m(
          {
            start: () => "executable liquidation snapshot",
            end: (v: Snapshot) => ({
              tokenRaw: v.amountRaw.toString(),
              liquidationSol: v.liquidationSol,
              walletSol: v.walletSol,
            }),
          },
          () => snapshot(slrd, walletRef, mint),
        );
        lastError = null;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        audit.event("snapshot-error", { error: lastError });
        render();
        if (!flags.has("loop")) throw error;
        await sleep(sampleMs);
        continue;
      }

      const p = normalizeValueBandPolicy(policy());
      const decision = planValueBandDecision({
        policy: p,
        liquidationValueSol: latest.liquidationSol,
        state: {
          lowerArmed: journal.lowerArmed,
          cumulativeBuySol: journal.cumulativeBuySol,
          cumulativeSellSol: journal.cumulativeSellSol,
          peakNetCapitalDeployedSol: journal.peakNetCapitalDeployedSol,
        },
      });
      if (decision.rearmLower && !journal.lowerArmed) {
        journal.lowerArmed = true;
        if (live) writeJournal(statePath, journal);
        audit.event("state", {
          action: "lower-rearmed",
          liquidationSol: latest.liquidationSol,
        });
      }

      const cooldownReady = Date.now() - lastTradeAt >= cooldownMs;
      if (!paused && cooldownReady) {
        try {
          if (scaleNow) {
            scaleNow = false;
            if (latest.liquidationSol < p.baseSol)
              await executeBuy(latest, true);
            else
              lastAction = `hold: already >= base ${p.baseSol.toFixed(6)} SOL`;
          } else if (decision.action === "sell") {
            await executeSell(latest);
          } else if (decision.action === "buy") {
            await executeBuy(latest, false);
          } else {
            lastAction = `hold: ${decision.reason}`;
          }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          lastAction = "trade failed";
          audit.event("trade-error", { error: lastError, decision });
          if (!flags.has("loop") || flags.has("fail-fast")) throw error;
        }
      } else if (paused) {
        lastAction = "hold: paused";
      } else {
        lastAction = `hold: cooldown ${Math.max(0, cooldownMs - (Date.now() - lastTradeAt))}ms`;
      }

      if (live && lastTradeAt > 0 && Date.now() - lastTradeAt < sampleMs * 2) {
        try {
          latest = await snapshot(slrd, walletRef, mint);
        } catch {
          // Next loop will retry and log normally.
        }
      }
      render();
      if (!flags.has("loop")) return;
      await sleep(sampleMs);
    }
  } finally {
    audit.event("stop", {
      reason: quitting ? "user" : "exit",
      journal,
      measure: audit.measureSummary(),
    });
    dashboard.close();
  }
}

main().catch((error) => {
  process.stderr.write(
    `VALUE-BAND AGENT ERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
