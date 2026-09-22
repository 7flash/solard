import { configure, createMeasure } from "measure-fn";
import {
  RaydiumService,
  createTraderSolard,
  resolveTradeAsset,
  sol,
} from "@solard/core";

configure({ silent: false });
const m = createMeasure("slrd:trader-engine", { maxResultLength: 1600 });

type Trader = ReturnType<typeof createTraderSolard>;
type ExecutionVenue = "solard" | "raydium-launchlab" | "raydium";

type WalletState = {
  tokenRaw: bigint;
  tokenUi: number | null;
  tokenDecimals: number | null;
  solLamports: bigint;
  sol: number;
};

export type TraderMode =
  | "starting"
  | "awaiting-command"
  | "watching"
  | "executing"
  | "paused"
  | "error"
  | "stopped";

export type TraderPlan = {
  referencePrice: number;
  upPct: number;
  sellPct: number;
  downPct: number;
  buySol: number;
  upTarget: number;
  downTarget: number;
  armedAt: number;
};

export type TraderTrade = {
  side: "buy" | "sell";
  reason: "manual" | "up-target" | "down-target";
  requested: number;
  signature: string | null;
  venue: string;
  verified: boolean;
  tokenDeltaRaw: string;
  solDeltaLamports: string;
  completedAt: number;
};

export type TraderEngineOptions = {
  tokenRef: string;
  walletRef: string;
  slippageBps?: number;
  intervalMs?: number;
  settleMs?: number;
  settlementAttempts?: number;
  launchlabProbeSol?: number;
  autoRearmTargets?: boolean;
  via?: string;
};

export type TraderCommand =
  | { action: "buy"; sol: number }
  | { action: "sell"; percent: number }
  | {
      action: "levels";
      upPct: number;
      sellPct: number;
      downPct: number;
      buySol: number;
    }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "clear" };

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

function short(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length <= 16 ? value : `${value.slice(0, 7)}…${value.slice(-6)}`;
}

function priceText(value: number): string {
  if (value >= 0.01) return value.toFixed(8);
  return value.toPrecision(10);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export class InteractiveTraderEngine {
  readonly tokenRef: string;
  readonly walletRef: string;
  readonly slippageBps: number;
  readonly intervalMs: number;
  readonly settleMs: number;
  readonly settlementAttempts: number;
  readonly launchlabProbeSol: number;
  readonly autoRearmTargets: boolean;
  readonly via: string;
  private readonly slrd: Trader;
  private readonly raydium: RaydiumService;
  private mintValue: string | null = null;
  private venueValue: ExecutionVenue | null = null;
  private modeValue: TraderMode = "starting";
  private planValue: TraderPlan | null = null;
  private lastTradeValue: TraderTrade | null = null;
  private lastErrorValue: string | null = null;
  private watchGeneration = 0;
  private startedAt = Date.now();

  constructor(options: TraderEngineOptions) {
    this.tokenRef = options.tokenRef;
    this.walletRef = options.walletRef;
    this.slippageBps = Math.max(1, Math.trunc(options.slippageBps ?? 500));
    this.intervalMs = Math.max(500, Math.trunc(options.intervalMs ?? 1_000));
    this.settleMs = Math.max(0, Math.trunc(options.settleMs ?? 1_500));
    this.settlementAttempts = Math.max(
      4,
      Math.trunc(options.settlementAttempts ?? 24),
    );
    this.launchlabProbeSol = positive(
      options.launchlabProbeSol ?? 0.001,
      "LaunchLab probe SOL",
    );
    this.autoRearmTargets = options.autoRearmTargets !== false;
    this.via = options.via ?? "rpc";
    this.slrd = createTraderSolard();
    this.raydium = new RaydiumService(this.slrd);
  }

  get mint(): string {
    if (!this.mintValue) throw new Error("Trader engine has not started");
    return this.mintValue;
  }

  get mode(): TraderMode {
    return this.modeValue;
  }

  get plan(): TraderPlan | null {
    return this.planValue;
  }

  get venue(): ExecutionVenue | null {
    return this.venueValue;
  }

  async start(): Promise<void> {
    this.mintValue = await this.ensureToken(this.tokenRef);
    this.venueValue = await this.detectVenue();
    this.modeValue = "awaiting-command";
    this.lastErrorValue = null;
    await m.measure(
      {
        start: () => "trader engine ready",
        end: (value: { mint: string; wallet: string; venue: string }) => ({
          mint: short(value.mint),
          wallet: value.wallet,
          venue: value.venue,
        }),
      },
      async () => ({
        mint: this.mint,
        wallet: this.walletRef,
        venue: this.venueValue!,
      }),
    );
  }

  async close(): Promise<void> {
    this.watchGeneration += 1;
    this.planValue = null;
    this.modeValue = "stopped";
    this.slrd.close();
  }

  async info(fresh = true) {
    const market =
      fresh && this.modeValue !== "stopped" ? await this.safeSnapshot() : null;
    return {
      tokenRef: this.tokenRef,
      mint: this.mintValue,
      wallet: this.walletRef,
      venue: this.venueValue,
      mode: this.modeValue,
      plan: this.planValue,
      lastTrade: this.lastTradeValue,
      lastError: this.lastErrorValue,
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      slippageBps: this.slippageBps,
      intervalMs: this.intervalMs,
      settleMs: this.settleMs,
      settlementAttempts: this.settlementAttempts,
      launchlabProbeSol: this.launchlabProbeSol,
      autoRearmTargets: this.autoRearmTargets,
      via: this.via,
      market,
    };
  }

  async command(command: TraderCommand) {
    if (this.modeValue === "executing") {
      throw new Error("Trader is executing a trade; wait for it to finish");
    }
    if (this.modeValue === "stopped") throw new Error("Trader is stopped");
    if (command.action === "buy") {
      await this.buy(command.sol, "manual");
    } else if (command.action === "sell") {
      await this.sell(command.percent, "manual");
    } else if (command.action === "levels") {
      await this.armLevels(command);
    } else if (command.action === "pause") {
      this.pause();
    } else if (command.action === "resume") {
      this.resume();
    } else if (command.action === "clear") {
      this.clear();
    }
    return await this.info(true);
  }

  async buy(
    amountSol: number,
    reason: TraderTrade["reason"] = "manual",
  ): Promise<void> {
    positive(amountSol, "buy SOL");
    this.stopWatchingForTrade();
    this.modeValue = "executing";
    this.lastErrorValue = null;
    try {
      const before = await this.walletState();
      const execution = await m.measure(
        {
          start: () => `buy ${amountSol} SOL`,
          end: (value: { signature: string | null; venue: string }) => ({
            signature: short(value.signature),
            venue: value.venue,
          }),
        },
        () => this.executeBuy(amountSol),
      );
      const after = await this.waitForSettlement("buy", before);
      const tokenDelta = after.tokenRaw - before.tokenRaw;
      const solDelta = after.solLamports - before.solLamports;
      this.lastTradeValue = {
        side: "buy",
        reason,
        requested: amountSol,
        signature: execution.signature,
        venue: execution.venue,
        verified: true,
        tokenDeltaRaw: tokenDelta.toString(),
        solDeltaLamports: solDelta.toString(),
        completedAt: Date.now(),
      };
      await this.reportSettlement(before, after, this.lastTradeValue);
      this.modeValue = "awaiting-command";
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async sell(
    sellPct: number,
    reason: TraderTrade["reason"] = "manual",
  ): Promise<void> {
    percent(sellPct, "sell percent");
    this.stopWatchingForTrade();
    this.modeValue = "executing";
    this.lastErrorValue = null;
    try {
      const before = await this.walletState();
      if (before.tokenRaw <= 0n)
        throw new Error("Wallet has no token balance to sell");
      const execution = await m.measure(
        {
          start: () => `sell ${sellPct}%`,
          end: (value: { signature: string | null; venue: string }) => ({
            signature: short(value.signature),
            venue: value.venue,
          }),
        },
        () => this.executeSell(sellPct, before),
      );
      const after = await this.waitForSettlement("sell", before);
      const tokenDelta = after.tokenRaw - before.tokenRaw;
      const solDelta = after.solLamports - before.solLamports;
      this.lastTradeValue = {
        side: "sell",
        reason,
        requested: sellPct,
        signature: execution.signature,
        venue: execution.venue,
        verified: true,
        tokenDeltaRaw: tokenDelta.toString(),
        solDeltaLamports: solDelta.toString(),
        completedAt: Date.now(),
      };
      await this.reportSettlement(before, after, this.lastTradeValue);
      this.modeValue = "awaiting-command";
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async armLevels(input: {
    upPct: number;
    sellPct: number;
    downPct: number;
    buySol: number;
  }): Promise<void> {
    const upPct = percent(input.upPct, "upside trigger", false);
    const sellPct = percent(input.sellPct, "sell percent");
    const downPct = percent(input.downPct, "downside trigger", false);
    const buySol = positive(input.buySol, "buy SOL");
    const state = await this.snapshot();
    const plan: TraderPlan = {
      referencePrice: state.price,
      upPct,
      sellPct,
      downPct,
      buySol,
      upTarget: state.price * (1 + upPct / 100),
      downTarget: state.price * (1 - downPct / 100),
      armedAt: Date.now(),
    };
    this.watchGeneration += 1;
    this.planValue = plan;
    this.lastErrorValue = null;
    this.modeValue = "watching";
    const generation = this.watchGeneration;
    await m.measure(
      {
        start: () => "targets armed",
        end: (value: {
          reference: string;
          up: string;
          down: string;
          sellPct: number;
          buySol: number;
          venue: string;
        }) => value,
      },
      async () => ({
        reference: priceText(plan.referencePrice),
        up: priceText(plan.upTarget),
        down: priceText(plan.downTarget),
        sellPct: plan.sellPct,
        buySol: plan.buySol,
        venue: state.venue,
      }),
    );
    void this.watch(generation, plan);
  }

  pause(): void {
    if (!this.planValue) {
      this.modeValue = "awaiting-command";
      return;
    }
    this.watchGeneration += 1;
    this.modeValue = "paused";
  }

  resume(): void {
    if (!this.planValue) throw new Error("No levels are armed");
    if (this.modeValue === "executing")
      throw new Error("Trader is executing a trade");
    this.watchGeneration += 1;
    const generation = this.watchGeneration;
    this.modeValue = "watching";
    this.lastErrorValue = null;
    void this.watch(generation, this.planValue);
  }

  clear(): void {
    this.watchGeneration += 1;
    this.planValue = null;
    this.modeValue = "awaiting-command";
    this.lastErrorValue = null;
  }

  async waitForCommandState(): Promise<void> {
    while (this.modeValue === "watching" || this.modeValue === "executing") {
      await sleep(250);
    }
  }

  async waitForTradeAfter(completedAt: number): Promise<TraderTrade> {
    while (this.modeValue !== "stopped") {
      const trade = this.lastTradeValue;
      if (trade && trade.completedAt > completedAt) {
        const triggered =
          trade.reason === "up-target" || trade.reason === "down-target";
        if (
          this.autoRearmTargets &&
          triggered &&
          this.modeValue === "awaiting-command"
        ) {
          await sleep(50);
          continue;
        }
        return trade;
      }
      if (this.modeValue === "error") {
        throw new Error(this.lastErrorValue ?? "Trader entered error state");
      }
      await sleep(250);
    }
    throw new Error("Trader stopped");
  }

  private async ensureToken(tokenRef: string): Promise<string> {
    try {
      return this.slrd.resolveToken(tokenRef).mint;
    } catch {
      await this.slrd.addToken(tokenRef);
      return this.slrd.resolveToken(tokenRef).mint;
    }
  }

  private async detectVenue(): Promise<ExecutionVenue> {
    const token = this.slrd.resolveToken(this.mint);
    const user = this.slrd.signer(this.walletRef).publicKey;
    let routeError: unknown = null;
    try {
      const route = await this.slrd.route(token, user);
      if (route.market.quoteAsset.kind !== "native-sol") {
        throw new Error(
          `Interactive trader requires a native-SOL quoted market, got ${route.market.quoteAsset.mint.toBase58()}`,
        );
      }
      return "solard";
    } catch (error) {
      routeError = error;
    }
    let launchError: unknown = null;
    try {
      await this.launchLabPrice();
      return "raydium-launchlab";
    } catch (error) {
      launchError = error;
    }
    try {
      await this.raydiumPrice();
      return "raydium";
    } catch (raydiumError) {
      throw new Error(
        `No executable SOL route for ${this.mint}: Solard=${errorText(routeError)}; Raydium LaunchLab=${errorText(launchError)}; Raydium swap=${errorText(raydiumError)}`,
      );
    }
  }

  private async walletState(): Promise<WalletState> {
    const balances = await this.slrd.walletBalances(this.walletRef, [
      this.mint,
    ]);
    const token =
      balances.tokenBalances.find((row: any) => row.mint === this.mint) ??
      balances.tokenBalances[0] ??
      null;
    const tokenRaw = BigInt(token?.amountRaw ?? 0n);
    const tokenDecimals = Number.isInteger(token?.decimals)
      ? Number(token.decimals)
      : null;
    return {
      tokenRaw,
      tokenUi:
        tokenDecimals != null ? Number(tokenRaw) / 10 ** tokenDecimals : null,
      tokenDecimals,
      solLamports: BigInt(balances.solLamports),
      sol: Number(balances.solLamports) / 1e9,
    };
  }

  private async snapshot() {
    const [market, wallet] = await Promise.all([
      this.sampleMarket(),
      this.walletState(),
    ]);
    return {
      price: market.price,
      venue: market.venue,
      tokenRaw: wallet.tokenRaw.toString(),
      tokenUi: wallet.tokenUi,
      sol: wallet.sol,
      sampledAt: Date.now(),
    };
  }

  private async safeSnapshot() {
    try {
      return await this.snapshot();
    } catch (error) {
      this.lastErrorValue = errorText(error);
      return null;
    }
  }

  private async sampleMarket(): Promise<{ price: number; venue: string }> {
    if (this.venueValue === "raydium-launchlab") {
      try {
        return {
          price: await this.launchLabPrice(),
          venue: "raydium-launchlab",
        };
      } catch (launchError) {
        try {
          const price = await this.raydiumPrice();
          this.venueValue = "raydium";
          return { price, venue: "raydium" };
        } catch {
          try {
            const generic = await this.slrd.samplePrice(this.mint);
            if (generic.quoteAsset.kind !== "native-sol") throw launchError;
            this.venueValue = "solard";
            return { price: generic.priceQuotePerToken, venue: generic.venue };
          } catch {
            throw launchError;
          }
        }
      }
    }
    if (this.venueValue === "raydium") {
      try {
        return { price: await this.raydiumPrice(), venue: "raydium" };
      } catch (raydiumError) {
        try {
          const price = await this.launchLabPrice();
          this.venueValue = "raydium-launchlab";
          return { price, venue: "raydium-launchlab" };
        } catch {
          try {
            const generic = await this.slrd.samplePrice(this.mint);
            if (generic.quoteAsset.kind !== "native-sol") throw raydiumError;
            this.venueValue = "solard";
            return { price: generic.priceQuotePerToken, venue: generic.venue };
          } catch {
            throw raydiumError;
          }
        }
      }
    }
    try {
      const generic = await this.slrd.samplePrice(this.mint);
      if (generic.quoteAsset.kind !== "native-sol") {
        throw new Error(
          `Interactive trader requires a native-SOL quoted market, got ${generic.quoteAsset.mint.toBase58()}`,
        );
      }
      return { price: generic.priceQuotePerToken, venue: generic.venue };
    } catch (genericError) {
      try {
        const price = await this.launchLabPrice();
        this.venueValue = "raydium-launchlab";
        return { price, venue: "raydium-launchlab" };
      } catch {
        try {
          const price = await this.raydiumPrice();
          this.venueValue = "raydium";
          return { price, venue: "raydium" };
        } catch {
          throw genericError;
        }
      }
    }
  }

  private async launchLabPrice(): Promise<number> {
    const quote = await resolveTradeAsset(this.slrd, "SOL");
    const prepared = await this.raydium.buildLaunchLabBuy({
      wallet: this.walletRef,
      mint: this.mint,
      quoteMint: quote.mint,
      amountRaw: sol(this.launchlabProbeSol).raw,
      slippageBps: this.slippageBps,
    });
    const expectedOut = Number(prepared.metadata.expectedOut);
    if (!(expectedOut > 0) || !Number.isFinite(expectedOut)) {
      throw new Error("Raydium LaunchLab quote returned no usable expectedOut");
    }
    return this.launchlabProbeSol / expectedOut;
  }

  private async raydiumPrice(): Promise<number> {
    const [quote, token] = await Promise.all([
      resolveTradeAsset(this.slrd, "SOL"),
      resolveTradeAsset(this.slrd, this.mint),
    ]);
    const result = await this.raydium.quoteExactIn({
      inputMint: quote.mint,
      outputMint: this.mint,
      amountRaw: sol(this.launchlabProbeSol).raw,
      slippageBps: this.slippageBps,
    });
    const outUi = Number(result.outputRaw) / 10 ** token.decimals;
    if (!(outUi > 0) || !Number.isFinite(outUi)) {
      throw new Error("Raydium quote returned no usable token output");
    }
    return this.launchlabProbeSol / outUi;
  }

  private async executeBuy(
    amountSol: number,
  ): Promise<{ signature: string | null; venue: string }> {
    if (this.venueValue === "raydium-launchlab") {
      try {
        const quote = await resolveTradeAsset(this.slrd, "SOL");
        const prepared = await this.raydium.buildLaunchLabBuy({
          wallet: this.walletRef,
          mint: this.mint,
          quoteMint: quote.mint,
          amountRaw: sol(amountSol).raw,
          slippageBps: this.slippageBps,
        });
        const result = await this.raydium.executePrepared(prepared, {
          live: true,
          simulate: true,
          skipPreflight: false,
          commitment: "confirmed",
        });
        return {
          signature: result.signatures.at(-1) ?? null,
          venue: "raydium-launchlab",
        };
      } catch (error) {
        if (await this.trySwitchToRaydium()) {
          return await this.executeBuy(amountSol);
        }
        const switched = await this.trySwitchToSolard();
        if (!switched) throw error;
      }
    }
    if (this.venueValue === "raydium") {
      const quote = await resolveTradeAsset(this.slrd, "SOL");
      const prepared = await this.raydium.buildSwapExactIn({
        wallet: this.walletRef,
        inputMint: quote.mint,
        outputMint: this.mint,
        amountRaw: sol(amountSol).raw,
        slippageBps: this.slippageBps,
      });
      const result = await this.raydium.executePrepared(prepared, {
        live: true,
        simulate: true,
        skipPreflight: false,
        commitment: "confirmed",
      });
      return { signature: result.signatures.at(-1) ?? null, venue: "raydium" };
    }
    const value = await this.slrd.buy(
      this.mint,
      this.walletRef,
      sol(amountSol),
      {
        slippageBps: this.slippageBps,
        via: this.via as any,
      },
    );
    return { signature: (value as any)?.signature ?? null, venue: "solard" };
  }

  private async executeSell(
    sellPct: number,
    before: WalletState,
  ): Promise<{ signature: string | null; venue: string }> {
    const bps = Math.max(1, Math.min(10_000, Math.round(sellPct * 100)));
    if (this.venueValue === "raydium-launchlab") {
      try {
        const quote = await resolveTradeAsset(this.slrd, "SOL");
        const amountRaw = (before.tokenRaw * BigInt(bps)) / 10_000n;
        if (amountRaw <= 0n)
          throw new Error("Calculated LaunchLab sell amount is zero");
        const prepared = await this.raydium.buildLaunchLabSell({
          wallet: this.walletRef,
          mint: this.mint,
          quoteMint: quote.mint,
          amountRaw,
          slippageBps: this.slippageBps,
        });
        const result = await this.raydium.executePrepared(prepared, {
          live: true,
          simulate: true,
          skipPreflight: false,
          commitment: "confirmed",
        });
        return {
          signature: result.signatures.at(-1) ?? null,
          venue: "raydium-launchlab",
        };
      } catch (error) {
        if (await this.trySwitchToRaydium()) {
          return await this.executeSell(sellPct, before);
        }
        const switched = await this.trySwitchToSolard();
        if (!switched) throw error;
      }
    }
    if (this.venueValue === "raydium") {
      const quote = await resolveTradeAsset(this.slrd, "SOL");
      const amountRaw = (before.tokenRaw * BigInt(bps)) / 10_000n;
      if (amountRaw <= 0n)
        throw new Error("Calculated Raydium sell amount is zero");
      const prepared = await this.raydium.buildSwapExactIn({
        wallet: this.walletRef,
        inputMint: this.mint,
        outputMint: quote.mint,
        amountRaw,
        slippageBps: this.slippageBps,
      });
      const result = await this.raydium.executePrepared(prepared, {
        live: true,
        simulate: true,
        skipPreflight: false,
        commitment: "confirmed",
      });
      return { signature: result.signatures.at(-1) ?? null, venue: "raydium" };
    }
    const value = await this.slrd.sell(this.mint, this.walletRef, {
      bps,
      slippageBps: this.slippageBps,
      via: this.via as any,
    });
    return { signature: (value as any)?.signature ?? null, venue: "solard" };
  }

  private async trySwitchToRaydium(): Promise<boolean> {
    try {
      await this.raydiumPrice();
      this.venueValue = "raydium";
      return true;
    } catch {
      return false;
    }
  }

  private async trySwitchToSolard(): Promise<boolean> {
    try {
      const token = this.slrd.resolveToken(this.mint);
      const route = await this.slrd.route(
        token,
        this.slrd.signer(this.walletRef).publicKey,
      );
      if (route.market.quoteAsset.kind !== "native-sol") return false;
      this.venueValue = "solard";
      return true;
    } catch {
      return false;
    }
  }

  private async waitForSettlement(
    side: "buy" | "sell",
    before: WalletState,
  ): Promise<WalletState> {
    if (this.settleMs > 0) await sleep(this.settleMs);
    let latest = before;
    for (let attempt = 1; attempt <= this.settlementAttempts; attempt += 1) {
      latest = await this.walletState();
      const settled =
        side === "buy"
          ? latest.tokenRaw > before.tokenRaw
          : latest.tokenRaw < before.tokenRaw;
      if (settled) return latest;
      if (attempt < this.settlementAttempts) await sleep(750);
    }
    throw new Error(
      `${side} submission did not produce a provable token balance delta after ${this.settlementAttempts} wallet reads; refusing to treat it as filled`,
    );
  }

  private async reportSettlement(
    before: WalletState,
    after: WalletState,
    trade: TraderTrade,
  ): Promise<void> {
    await m.measure(
      {
        start: () => "trade settlement verified",
        end: (value: {
          side: string;
          venue: string;
          tokenBeforeRaw: string;
          tokenAfterRaw: string;
          tokenDeltaRaw: string;
          solBefore: number;
          solAfter: number;
          signature: string | null;
        }) => value,
      },
      async () => ({
        side: trade.side,
        venue: trade.venue,
        tokenBeforeRaw: before.tokenRaw.toString(),
        tokenAfterRaw: after.tokenRaw.toString(),
        tokenDeltaRaw: trade.tokenDeltaRaw,
        solBefore: before.sol,
        solAfter: after.sol,
        signature: short(trade.signature),
      }),
    );
  }

  private stopWatchingForTrade(): void {
    this.watchGeneration += 1;
    this.planValue = null;
  }

  private fail(error: unknown): void {
    this.watchGeneration += 1;
    this.planValue = null;
    this.lastErrorValue = errorText(error);
    this.modeValue = "error";
  }

  private async watch(generation: number, plan: TraderPlan): Promise<void> {
    let lastStatusAt = 0;
    while (
      generation === this.watchGeneration &&
      this.modeValue === "watching" &&
      this.planValue === plan
    ) {
      try {
        const sampled = await this.sampleMarket();
        const price = sampled.price;
        if (price >= plan.upTarget) {
          if (!this.claimTrigger(generation, plan)) return;
          await this.reportTrigger("up", price, plan.upTarget, sampled.venue);
          await this.sell(plan.sellPct, "up-target");
          await this.rearmAfterTriggeredTrade(plan);
          return;
        }
        if (price <= plan.downTarget) {
          if (!this.claimTrigger(generation, plan)) return;
          await this.reportTrigger(
            "down",
            price,
            plan.downTarget,
            sampled.venue,
          );
          await this.buy(plan.buySol, "down-target");
          await this.rearmAfterTriggeredTrade(plan);
          return;
        }
        if (Date.now() - lastStatusAt >= 15_000) {
          lastStatusAt = Date.now();
          await m.measure(
            {
              start: () => "watch targets",
              end: (value: {
                price: string;
                up: string;
                down: string;
                venue: string;
              }) => value,
            },
            async () => ({
              price: priceText(price),
              up: priceText(plan.upTarget),
              down: priceText(plan.downTarget),
              venue: sampled.venue,
            }),
          );
        }
      } catch (error) {
        this.lastErrorValue = errorText(error);
        await m.measure(
          {
            start: () => "price watch retry",
            end: (value: { error: string }) => value,
          },
          async () => ({ error: this.lastErrorValue! }),
        );
      }
      await sleep(this.intervalMs);
    }
  }

  private async reportTrigger(
    side: "up" | "down",
    price: number,
    target: number,
    venue: string,
  ): Promise<void> {
    await m.measure(
      {
        start: () => `${side} target reached`,
        end: (value: {
          side: string;
          price: string;
          target: string;
          venue: string;
        }) => value,
      },
      async () => ({
        side,
        price: priceText(price),
        target: priceText(target),
        venue,
      }),
    );
  }

  private async rearmAfterTriggeredTrade(plan: TraderPlan): Promise<void> {
    if (!this.autoRearmTargets || this.modeValue !== "awaiting-command") return;
    await m.measure(
      {
        start: () => "auto rearm previous targets",
        end: (value: {
          upPct: number;
          sellPct: number;
          downPct: number;
          buySol: number;
        }) => value,
      },
      async () => ({
        upPct: plan.upPct,
        sellPct: plan.sellPct,
        downPct: plan.downPct,
        buySol: plan.buySol,
      }),
    );
    await this.armLevels({
      upPct: plan.upPct,
      sellPct: plan.sellPct,
      downPct: plan.downPct,
      buySol: plan.buySol,
    });
  }

  private claimTrigger(generation: number, plan: TraderPlan): boolean {
    if (
      generation !== this.watchGeneration ||
      this.modeValue !== "watching" ||
      this.planValue !== plan
    ) {
      return false;
    }
    this.watchGeneration += 1;
    this.planValue = null;
    this.modeValue = "executing";
    return true;
  }
}
