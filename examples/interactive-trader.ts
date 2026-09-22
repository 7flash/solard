#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { configure, createMeasure } from "measure-fn";
import {
  InteractiveTraderEngine,
  type TraderPlan,
} from "./lib/interactive-trader-engine.ts";

configure({ silent: false });
const m = createMeasure("slrd:interactive-trader", { maxResultLength: 1600 });

type Flags = Map<string, string>;

function parseArgs(argv: string[]): Flags {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
    if (inline != null) flags.set(key!, inline);
    else if (argv[index + 1] && !argv[index + 1]!.startsWith("--")) {
      flags.set(key!, argv[++index]!);
    } else {
      flags.set(key!, "true");
    }
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

function numeric(value: string | undefined, label: string): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number`);
  return parsed;
}

function positive(value: number, label: string): number {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new Error(`${label} must be greater than zero`);
  }
  return value;
}

function percent(value: number, label: string, capHundred = true): number {
  if (!(value > 0) || !Number.isFinite(value) || (capHundred && value > 100)) {
    throw new Error(
      `${label} must be greater than zero${capHundred ? " and at most 100" : ""}`,
    );
  }
  return value;
}

function liveEnabled(): boolean {
  return [
    process.env.SOLARD_ENABLE_LIVE_TRADES,
    process.env.SLRD_ENABLE_LIVE_TRADES,
    process.env.SOLWAL_ENABLE_LIVE_TRADES,
  ].some((value) => /^(1|true|yes)$/i.test(value?.trim() ?? ""));
}

async function askNumber(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  fallback: number | undefined,
  validate: (value: number) => number,
): Promise<number> {
  while (true) {
    const suffix = fallback == null ? "" : ` [${fallback}]`;
    const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
    if (!answer && fallback != null) return validate(fallback);
    const parsed = Number(answer);
    if (Number.isFinite(parsed)) {
      try {
        return validate(parsed);
      } catch (error) {
        await m.measure(
          {
            start: () => "invalid input",
            end: (value: { error: string }) => value,
          },
          async () => ({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    } else {
      await m.measure(
        {
          start: () => "invalid input",
          end: (value: { error: string }) => value,
        },
        async () => ({ error: "enter a numeric value" }),
      );
    }
  }
}

async function promptNext(args: {
  rl: ReturnType<typeof createInterface>;
  engine: InteractiveTraderEngine;
  previous: TraderPlan | null;
  defaults: {
    upPct?: number;
    sellPct?: number;
    downPct?: number;
    buySol?: number;
  } | null;
}): Promise<"armed" | "quit"> {
  let defaults = args.defaults;
  while (true) {
    const info = await args.engine.info(true);
    await m.measure(
      {
        start: () => "interactive checkpoint",
        end: (value: typeof info) => ({
          mode: value.mode,
          venue: value.venue,
          price: value.market?.price ?? null,
          token: value.market?.tokenUi ?? null,
          walletSol: value.market?.sol ?? null,
          lastTrade: value.lastTrade,
          lastError: value.lastError,
        }),
      },
      async () => info,
    );
    const action =
      (
        await args.rl.question(
          "Next action [levels/buy/sell/pause/resume/clear/quit] (levels): ",
        )
      )
        .trim()
        .toLowerCase() || "levels";
    if (action === "quit" || action === "q") return "quit";
    if (action === "buy" || action === "b") {
      const amountSol = await askNumber(
        args.rl,
        "Buy SOL now",
        args.previous?.buySol ?? defaults?.buySol,
        (value) => positive(value, "buy SOL"),
      );
      await args.engine.command({ action: "buy", sol: amountSol });
      defaults = null;
      continue;
    }
    if (action === "sell" || action === "s") {
      const sellPct = await askNumber(
        args.rl,
        "Sell token percent now",
        args.previous?.sellPct ?? defaults?.sellPct,
        (value) => percent(value, "sell percent"),
      );
      await args.engine.command({ action: "sell", percent: sellPct });
      defaults = null;
      continue;
    }
    if (action === "pause" || action === "p") {
      await args.engine.command({ action: "pause" });
      continue;
    }
    if (action === "resume" || action === "r") {
      await args.engine.command({ action: "resume" });
      return "armed";
    }
    if (action === "clear" || action === "c") {
      await args.engine.command({ action: "clear" });
      defaults = null;
      continue;
    }
    if (action !== "levels" && action !== "l") {
      await m.measure(
        {
          start: () => "invalid action",
          end: (value: { action: string }) => value,
        },
        async () => ({ action }),
      );
      continue;
    }
    const upPct = await askNumber(
      args.rl,
      "Upside trigger % above current price",
      defaults?.upPct ?? args.previous?.upPct,
      (value) => percent(value, "upside trigger", false),
    );
    const sellPct = await askNumber(
      args.rl,
      "Sell % of current token balance when upside hits",
      defaults?.sellPct ?? args.previous?.sellPct,
      (value) => percent(value, "sell percent"),
    );
    const downPct = await askNumber(
      args.rl,
      "Downside trigger % below current price",
      defaults?.downPct ?? args.previous?.downPct,
      (value) => percent(value, "downside trigger", false),
    );
    const buySol = await askNumber(
      args.rl,
      "Buy SOL amount when downside hits",
      defaults?.buySol ?? args.previous?.buySol,
      (value) => positive(value, "buy SOL"),
    );
    await args.engine.command({
      action: "levels",
      upPct,
      sellPct,
      downPct,
      buySol,
    });
    return "armed";
  }
}

async function waitForOverride(args: {
  rl: ReturnType<typeof createInterface>;
  engine: InteractiveTraderEngine;
  lastTradeAt: number;
}): Promise<"override" | "trade"> {
  const controller = new AbortController();
  const override = args.rl
    .question("Auto targets active. Press Enter anytime to redefine them.\n", {
      signal: controller.signal,
    })
    .then(() => "override" as const)
    .catch((error: any) => {
      if (error?.name === "AbortError") return "trade" as const;
      throw error;
    });
  const trade = args.engine
    .waitForTradeAfter(args.lastTradeAt)
    .then(() => "trade" as const);
  try {
    const winner = await Promise.race([override, trade]);
    if (winner === "trade") controller.abort();
    await override.catch(() => undefined);
    return winner;
  } catch (error) {
    controller.abort();
    await override.catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.has("help")) {
    output.write(
      "Interactive token trader\n\n" +
        "Usage:\n" +
        "  slrd run examples/interactive-trader.ts --token <mint> --wallet <wallet> --sol 0.1 --live\n\n" +
        "Optional initial levels: --up-pct 20 --sell-pct 50 --down-pct 10 --buy-sol 0.05\n" +
        "Other controls: --slippage-bps 500 --interval-ms 1000 --settle-ms 1500 --settlement-attempts 24 --launchlab-probe-sol 0.001 --via rpc --no-initial-buy --no-auto-rearm\n" +
        "Triggered trades are balance-verified. By default their previous percentage levels are immediately re-armed from the new market price; press Enter while watching to redefine them.\n",
    );
    return;
  }
  if (!flags.has("live"))
    throw new Error("Interactive trading requires --live");
  if (!liveEnabled()) {
    throw new Error("--live requires SOLARD_ENABLE_LIVE_TRADES=1");
  }
  const engine = new InteractiveTraderEngine({
    tokenRef: required(flags, "token"),
    walletRef: required(flags, "wallet"),
    slippageBps: numeric(flag(flags, "slippage-bps"), "--slippage-bps") ?? 500,
    intervalMs: numeric(flag(flags, "interval-ms"), "--interval-ms") ?? 1_000,
    settleMs: numeric(flag(flags, "settle-ms"), "--settle-ms") ?? 1_500,
    settlementAttempts:
      numeric(flag(flags, "settlement-attempts"), "--settlement-attempts") ??
      24,
    launchlabProbeSol:
      numeric(flag(flags, "launchlab-probe-sol"), "--launchlab-probe-sol") ??
      0.001,
    autoRearmTargets: !flags.has("no-auto-rearm"),
    via: flag(flags, "via") ?? "rpc",
  });
  const rl = createInterface({ input, output });
  try {
    await engine.start();
    if (!flags.has("no-initial-buy")) {
      const amountSol = positive(
        numeric(flag(flags, "sol"), "--sol") ??
          (await askNumber(rl, "Initial SOL to buy", undefined, (value) =>
            positive(value, "initial SOL"),
          )),
        "initial SOL",
      );
      await engine.command({ action: "buy", sol: amountSol });
    }
    const defaults = {
      upPct: numeric(flag(flags, "up-pct"), "--up-pct"),
      sellPct: numeric(flag(flags, "sell-pct"), "--sell-pct"),
      downPct: numeric(flag(flags, "down-pct"), "--down-pct"),
      buySol: numeric(flag(flags, "buy-sol"), "--buy-sol"),
    };
    let previous: TraderPlan | null = null;
    if (
      defaults.upPct != null &&
      defaults.sellPct != null &&
      defaults.downPct != null &&
      defaults.buySol != null
    ) {
      await engine.command({
        action: "levels",
        upPct: percent(defaults.upPct, "--up-pct", false),
        sellPct: percent(defaults.sellPct, "--sell-pct"),
        downPct: percent(defaults.downPct, "--down-pct", false),
        buySol: positive(defaults.buySol, "--buy-sol"),
      });
      previous = engine.plan;
    } else {
      const result = await promptNext({
        rl,
        engine,
        previous,
        defaults,
      });
      if (result === "quit") return;
      previous = engine.plan;
    }

    while (true) {
      const info = await engine.info(false);
      const lastTradeAt = info.lastTrade?.completedAt ?? 0;
      if (engine.mode === "watching" && engine.plan) {
        previous = engine.plan;
        const result = await waitForOverride({ rl, engine, lastTradeAt });
        if (result === "trade") {
          previous = engine.plan ?? previous;
          continue;
        }
        try {
          await engine.command({ action: "pause" });
        } catch {
          continue;
        }
      }
      const result = await promptNext({
        rl,
        engine,
        previous,
        defaults: null,
      });
      if (result === "quit") return;
      previous = engine.plan ?? previous;
    }
  } finally {
    rl.close();
    await engine.close();
  }
}

main().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  m.sync(
    {
      start: () => "interactive trader error",
      end: (value: { error: string }) => value,
    },
    () => ({ error: message }),
  );
  process.exitCode = 1;
});
