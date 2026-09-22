import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Connection,
  PublicKey,
  type Logs,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import {
  RaydiumService,
  createTraderSolard,
  resolveTradeAsset,
  sol,
} from "@solard/core";

type Flags = Map<string, string>;
type Emit = (value: string) => void;
type Trader = ReturnType<typeof createTraderSolard>;
type ExecutionVenue = "solard" | "raydium-launchlab" | "raydium";

export type StrategyTrade = {
  id: string;
  signature: string;
  slot: number;
  atMs: number;
  mint: string;
  venue: string;
  side: "buy" | "sell";
  trader: string;
  isMine: boolean;
  tokenAmountRaw: bigint;
  tokenAmountUi: number;
  quote: "SOL" | "USDC";
  quoteAmountUi: number;
  priceSol: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
};

export type StrategyPosition = {
  tokenRaw: bigint;
  tokenUi: number | null;
  tokenDecimals: number | null;
  solLamports: bigint;
  sol: number;
};

export type StrategyExecution = {
  live: boolean;
  side: "buy" | "sell";
  requested: number;
  reason: string | null;
  venue: string | null;
  signature: string | null;
  tokenDeltaRaw: bigint | null;
  solDeltaLamports: bigint | null;
  completedAt: number;
};

export type TradeStrategyContext<State = Record<string, unknown>> = {
  readonly mint: string;
  readonly wallet: string;
  readonly walletAddress: string;
  readonly live: boolean;
  readonly state: State;
  readonly params: Record<string, unknown>;
  readonly tradeCount: number;
  readonly lastTrade: StrategyTrade | null;
  buy(input: { sol: number; reason?: string }): Promise<StrategyExecution>;
  sell(input: { percent: number; reason?: string }): Promise<StrategyExecution>;
  position(): Promise<StrategyPosition>;
  samplePrice(): Promise<{ price: number; venue: string }>;
  log(message: string, data?: unknown): void;
  stop(reason?: string): void;
};

export type TradeStrategy<State = Record<string, unknown>> = {
  name?: string;
  state?: State | (() => State | Promise<State>);
  onStart?(ctx: TradeStrategyContext<State>): void | Promise<void>;
  onTrade(
    ctx: TradeStrategyContext<State>,
    trade: StrategyTrade,
  ): void | Promise<void>;
  onError?(
    ctx: TradeStrategyContext<State>,
    error: unknown,
    trade: StrategyTrade | null,
  ): void | Promise<void>;
  onStop?(
    ctx: TradeStrategyContext<State>,
    reason: string,
  ): void | Promise<void>;
};

export function defineTradeStrategy<State>(
  strategy: TradeStrategy<State>,
): TradeStrategy<State> {
  return strategy;
}

type RawBalance = {
  accountIndex: number;
  mint: string;
  owner: string | null;
  raw: bigint;
};

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const RAYDIUM_LAUNCHPAD_PROGRAM = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const LAMPORTS_PER_SOL = 1_000_000_000;

function flag(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return value && value !== "true" ? value : undefined;
}

function numberFlag(flags: Flags, key: string, fallback: number): number {
  const value = flag(flags, key);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key}: ${value}`);
  return parsed;
}

function integerFlag(flags: Flags, key: string, fallback: number): number {
  const value = numberFlag(flags, key, fallback);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`--${key} must be a positive integer`);
  return value;
}

function required(flags: Flags, key: string): string {
  const value = flag(flags, key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function rpcUrl(flags: Flags): string {
  const value =
    flag(flags, "rpc") ??
    process.env.RPC_ENDPOINT?.trim() ??
    process.env.SOLANA_RPC_URL?.trim() ??
    process.env.HELIUS_RPC_URL?.trim();
  if (!value)
    throw new Error(
      "strategy run requires RPC_ENDPOINT, SOLANA_RPC_URL, HELIUS_RPC_URL, or --rpc <url>",
    );
  return value;
}

function liveEnabled(): boolean {
  return [
    "SOLARD_ENABLE_LIVE_TRADES",
    "SLRD_ENABLE_LIVE_TRADES",
    "SOLWAL_ENABLE_LIVE_TRADES",
  ].some((key) => process.env[key] === "1");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function keyText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof (value as any).toBase58 === "function")
    return (value as any).toBase58();
  if (value && typeof (value as any).pubkey?.toBase58 === "function")
    return (value as any).pubkey.toBase58();
  if (value && typeof (value as any).pubkey === "string")
    return (value as any).pubkey;
  return null;
}

function accountKeys(tx: ParsedTransactionWithMeta): string[] {
  return ((tx.transaction.message as any).accountKeys ?? [])
    .map((row: unknown) => keyText(row))
    .filter((row: string | null): row is string => Boolean(row));
}

function signerKeys(tx: ParsedTransactionWithMeta): Set<string> {
  const rows = ((tx.transaction.message as any).accountKeys ?? []) as any[];
  return new Set(
    rows
      .filter((row) => row && typeof row === "object" && row.signer === true)
      .map((row) => keyText(row))
      .filter((row): row is string => Boolean(row)),
  );
}

function rawAmount(row: any): bigint {
  try {
    return BigInt(String(row?.uiTokenAmount?.amount ?? "0"));
  } catch {
    return 0n;
  }
}

function tokenBalances(rows: readonly any[] | null | undefined): RawBalance[] {
  return (rows ?? []).map((row) => ({
    accountIndex: Number(row.accountIndex),
    mint: String(row.mint ?? ""),
    owner: row.owner ? String(row.owner) : null,
    raw: rawAmount(row),
  }));
}

function ownerTokenDeltaRaw(
  tx: ParsedTransactionWithMeta,
  mint: string,
  owner: string,
): bigint {
  const pre = tokenBalances(tx.meta?.preTokenBalances);
  const post = tokenBalances(tx.meta?.postTokenBalances);
  const indices = new Set<number>();
  for (const row of [...pre, ...post]) {
    if (row.mint === mint && row.owner === owner) indices.add(row.accountIndex);
  }
  let total = 0n;
  for (const index of indices) {
    const before =
      pre.find((row) => row.accountIndex === index && row.mint === mint)?.raw ??
      0n;
    const after =
      post.find((row) => row.accountIndex === index && row.mint === mint)
        ?.raw ?? 0n;
    total += after - before;
  }
  return total;
}

function tokenAccountRentDelta(
  tx: ParsedTransactionWithMeta,
  owner: string,
): bigint {
  if (!tx.meta) return 0n;
  const pre = tokenBalances(tx.meta.preTokenBalances);
  const post = tokenBalances(tx.meta.postTokenBalances);
  const indices = new Set(
    [...pre, ...post]
      .filter((row) => row.owner === owner)
      .map((row) => row.accountIndex),
  );
  let total = 0n;
  for (const index of indices) {
    const before = BigInt(Math.trunc(Number(tx.meta.preBalances[index] ?? 0)));
    const after = BigInt(Math.trunc(Number(tx.meta.postBalances[index] ?? 0)));
    const pairPre = pre.find((row) => row.accountIndex === index);
    const pairPost = post.find((row) => row.accountIndex === index);
    let delta = after - before;
    if ((pairPost?.mint ?? pairPre?.mint) === WSOL_MINT) {
      delta -= (pairPost?.raw ?? 0n) - (pairPre?.raw ?? 0n);
    }
    total += delta;
  }
  return total;
}

function economicSolDelta(
  tx: ParsedTransactionWithMeta,
  owner: string,
): bigint | null {
  if (!tx.meta) return null;
  const keys = accountKeys(tx);
  const index = keys.indexOf(owner);
  if (index < 0) return null;
  const before = tx.meta.preBalances[index];
  const after = tx.meta.postBalances[index];
  if (before == null || after == null) return null;
  const native =
    BigInt(Math.trunc(Number(after))) - BigInt(Math.trunc(Number(before)));
  const fee = keys[0] === owner ? BigInt(tx.meta.fee ?? 0) : 0n;
  const rent = tokenAccountRentDelta(tx, owner);
  const wsol = ownerTokenDeltaRaw(tx, WSOL_MINT, owner);
  return native + fee + rent + wsol;
}

function venueFromTransaction(tx: ParsedTransactionWithMeta): string {
  const keys = new Set(accountKeys(tx));
  if (keys.has(PUMP_AMM_PROGRAM)) return "pumpswap";
  if (keys.has(PUMP_PROGRAM)) return "pump-curve";
  if (keys.has(RAYDIUM_LAUNCHPAD_PROGRAM)) return "raydium-launchlab";
  return "raydium-or-other";
}

function parseTrades(args: {
  tx: ParsedTransactionWithMeta;
  signature: string;
  mint: string;
  decimals: number;
  supplyUi: number;
  walletAddress: string;
  solUsd: number | null;
}): StrategyTrade[] {
  const tx = args.tx;
  if (!tx.meta || tx.meta.err || tx.blockTime == null) return [];
  const signers = signerKeys(tx);
  const owners = new Set<string>();
  for (const row of [
    ...tokenBalances(tx.meta.preTokenBalances),
    ...tokenBalances(tx.meta.postTokenBalances),
  ]) {
    if (row.mint === args.mint && row.owner && signers.has(row.owner)) {
      owners.add(row.owner);
    }
  }
  const venue = venueFromTransaction(tx);
  const out: StrategyTrade[] = [];
  for (const owner of owners) {
    const targetDelta = ownerTokenDeltaRaw(tx, args.mint, owner);
    if (targetDelta === 0n) continue;
    const side = targetDelta > 0n ? "buy" : "sell";
    const tokenAmountRaw = targetDelta < 0n ? -targetDelta : targetDelta;
    const tokenAmountUi = Number(tokenAmountRaw) / 10 ** args.decimals;
    if (!(tokenAmountUi > 0) || !Number.isFinite(tokenAmountUi)) continue;

    const solDelta = economicSolDelta(tx, owner);
    if (
      solDelta != null &&
      ((side === "buy" && solDelta < 0n) || (side === "sell" && solDelta > 0n))
    ) {
      const quoteAmountUi =
        Number(solDelta < 0n ? -solDelta : solDelta) / LAMPORTS_PER_SOL;
      if (!(quoteAmountUi > 0) || !Number.isFinite(quoteAmountUi)) continue;
      const priceSol = quoteAmountUi / tokenAmountUi;
      const priceUsd = args.solUsd == null ? null : priceSol * args.solUsd;
      out.push({
        id: `${args.signature}:${owner}:${side}`,
        signature: args.signature,
        slot: tx.slot,
        atMs: tx.blockTime * 1_000,
        mint: args.mint,
        venue,
        side,
        trader: owner,
        isMine: owner === args.walletAddress,
        tokenAmountRaw,
        tokenAmountUi,
        quote: "SOL",
        quoteAmountUi,
        priceSol,
        priceUsd,
        marketCapUsd:
          priceUsd != null && args.supplyUi > 0
            ? priceUsd * args.supplyUi
            : null,
      });
      continue;
    }

    const usdcDelta = ownerTokenDeltaRaw(tx, USDC_MINT, owner);
    if (
      (side === "buy" && usdcDelta < 0n) ||
      (side === "sell" && usdcDelta > 0n)
    ) {
      const quoteAmountUi =
        Number(usdcDelta < 0n ? -usdcDelta : usdcDelta) / 1_000_000;
      if (!(quoteAmountUi > 0) || !Number.isFinite(quoteAmountUi)) continue;
      const priceUsd = quoteAmountUi / tokenAmountUi;
      out.push({
        id: `${args.signature}:${owner}:${side}`,
        signature: args.signature,
        slot: tx.slot,
        atMs: tx.blockTime * 1_000,
        mint: args.mint,
        venue,
        side,
        trader: owner,
        isMine: owner === args.walletAddress,
        tokenAmountRaw,
        tokenAmountUi,
        quote: "USDC",
        quoteAmountUi,
        priceSol: args.solUsd == null ? null : priceUsd / args.solUsd,
        priceUsd,
        marketCapUsd: args.supplyUi > 0 ? priceUsd * args.supplyUi : null,
      });
    }
  }
  return out;
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSolUsd(): Promise<number> {
  try {
    const raw = await fetchJson(
      "https://api.coinbase.com/v2/prices/SOL-USD/spot",
    );
    const value = Number(raw?.data?.amount);
    if (Number.isFinite(value) && value > 0) return value;
  } catch {}
  const raw = await fetchJson(
    "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
  );
  const value = Number(raw?.solana?.usd);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("SOL/USD price unavailable");
  return value;
}

async function discoverRaydiumPools(mint: string): Promise<string[]> {
  const query = new URLSearchParams({
    mint1: mint,
    poolType: "all",
    poolSortField: "liquidity",
    sortType: "desc",
    pageSize: "12",
    page: "1",
  });
  try {
    const raw = await fetchJson(
      `https://api-v3.raydium.io/pools/info/mint?${query}`,
    );
    const rows = Array.isArray(raw?.data?.data) ? raw.data.data : [];
    return [
      ...new Set(
        rows
          .map((row: any) => (typeof row?.id === "string" ? row.id.trim() : ""))
          .filter(Boolean),
      ),
    ];
  } catch {
    return [];
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

class StrategyExecutor {
  private readonly raydium: RaydiumService;
  private venueValue: ExecutionVenue | null = null;

  constructor(
    private readonly slrd: Trader,
    readonly mint: string,
    private readonly walletRef: string,
    private readonly live: boolean,
    private readonly slippageBps: number,
    private readonly via: string,
    private readonly settlementAttempts: number,
    private readonly launchlabProbeSol: number,
  ) {
    this.raydium = new RaydiumService(slrd);
  }

  get venue(): string | null {
    return this.venueValue;
  }

  async position(): Promise<StrategyPosition> {
    const balances = await this.slrd.walletBalances(this.walletRef, [
      this.mint,
    ]);
    const token =
      balances.tokenBalances.find(
        (row: any) => row.token?.mint === this.mint,
      ) ??
      balances.tokenBalances[0] ??
      null;
    const tokenRaw = BigInt(token?.amountRaw ?? 0n);
    const tokenDecimals = Number.isInteger(token?.decimals)
      ? Number(token.decimals)
      : null;
    return {
      tokenRaw,
      tokenUi:
        tokenDecimals == null ? null : Number(tokenRaw) / 10 ** tokenDecimals,
      tokenDecimals,
      solLamports: BigInt(balances.solLamports),
      sol: Number(balances.solLamports) / 1e9,
    };
  }

  async samplePrice(): Promise<{ price: number; venue: string }> {
    if (!this.venueValue) this.venueValue = await this.detectVenue();
    if (this.venueValue === "raydium-launchlab") {
      try {
        return {
          price: await this.launchLabPrice(),
          venue: "raydium-launchlab",
        };
      } catch (error) {
        if (await this.trySwitchToRaydium()) return await this.samplePrice();
        if (await this.trySwitchToSolard()) return await this.samplePrice();
        throw error;
      }
    }
    if (this.venueValue === "raydium") {
      try {
        return { price: await this.raydiumPrice(), venue: "raydium" };
      } catch (error) {
        try {
          await this.launchLabPrice();
          this.venueValue = "raydium-launchlab";
          return await this.samplePrice();
        } catch {}
        if (await this.trySwitchToSolard()) return await this.samplePrice();
        throw error;
      }
    }
    try {
      const sampled = await this.slrd.samplePrice(this.mint);
      if (sampled.quoteAsset.kind !== "native-sol")
        throw new Error("Strategy convenience pricing requires a SOL market");
      return { price: sampled.priceQuotePerToken, venue: sampled.venue };
    } catch (error) {
      try {
        await this.launchLabPrice();
        this.venueValue = "raydium-launchlab";
        return await this.samplePrice();
      } catch {}
      if (await this.trySwitchToRaydium()) return await this.samplePrice();
      throw error;
    }
  }

  async buy(
    amountSol: number,
    reason: string | null,
  ): Promise<StrategyExecution> {
    if (!(amountSol > 0) || !Number.isFinite(amountSol))
      throw new Error("buy SOL must be greater than zero");
    if (!this.live) {
      return {
        live: false,
        side: "buy",
        requested: amountSol,
        reason,
        venue: this.venueValue,
        signature: null,
        tokenDeltaRaw: null,
        solDeltaLamports: null,
        completedAt: Date.now(),
      };
    }
    const before = await this.position();
    if (!this.venueValue) this.venueValue = await this.detectVenue();
    const execution = await this.executeBuy(amountSol);
    const after = await this.waitForSettlement("buy", before);
    return {
      live: true,
      side: "buy",
      requested: amountSol,
      reason,
      venue: execution.venue,
      signature: execution.signature,
      tokenDeltaRaw: after.tokenRaw - before.tokenRaw,
      solDeltaLamports: after.solLamports - before.solLamports,
      completedAt: Date.now(),
    };
  }

  async sell(
    percent: number,
    reason: string | null,
  ): Promise<StrategyExecution> {
    if (!(percent > 0) || percent > 100 || !Number.isFinite(percent))
      throw new Error("sell percent must be > 0 and <= 100");
    if (!this.live) {
      return {
        live: false,
        side: "sell",
        requested: percent,
        reason,
        venue: this.venueValue,
        signature: null,
        tokenDeltaRaw: null,
        solDeltaLamports: null,
        completedAt: Date.now(),
      };
    }
    const before = await this.position();
    if (before.tokenRaw <= 0n)
      throw new Error("Wallet has no token balance to sell");
    if (!this.venueValue) this.venueValue = await this.detectVenue();
    const execution = await this.executeSell(percent, before);
    const after = await this.waitForSettlement("sell", before);
    return {
      live: true,
      side: "sell",
      requested: percent,
      reason,
      venue: execution.venue,
      signature: execution.signature,
      tokenDeltaRaw: after.tokenRaw - before.tokenRaw,
      solDeltaLamports: after.solLamports - before.solLamports,
      completedAt: Date.now(),
    };
  }

  private async detectVenue(): Promise<ExecutionVenue> {
    const token = this.slrd.resolveToken(this.mint);
    const user = this.slrd.signer(this.walletRef).publicKey;
    try {
      const route = await this.slrd.route(token, user);
      if (route.market.quoteAsset.kind !== "native-sol")
        throw new Error("non-SOL native route");
      return "solard";
    } catch {}
    try {
      await this.launchLabPrice();
      return "raydium-launchlab";
    } catch {}
    await this.raydiumPrice();
    return "raydium";
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
    if (!(expectedOut > 0) || !Number.isFinite(expectedOut))
      throw new Error("LaunchLab quote returned no usable expectedOut");
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
    if (!(outUi > 0) || !Number.isFinite(outUi))
      throw new Error("Raydium quote returned no usable token output");
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
        if (await this.trySwitchToRaydium())
          return await this.executeBuy(amountSol);
        if (!(await this.trySwitchToSolard())) throw error;
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
      return {
        signature: result.signatures.at(-1) ?? null,
        venue: "raydium",
      };
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
    return {
      signature: (value as any)?.signature ?? null,
      venue: "solard",
    };
  }

  private async executeSell(
    percent: number,
    before: StrategyPosition,
  ): Promise<{ signature: string | null; venue: string }> {
    const bps = Math.max(1, Math.min(10_000, Math.round(percent * 100)));
    const amountRaw = (before.tokenRaw * BigInt(bps)) / 10_000n;
    if (amountRaw <= 0n) throw new Error("Calculated sell amount is zero");
    if (this.venueValue === "raydium-launchlab") {
      try {
        const quote = await resolveTradeAsset(this.slrd, "SOL");
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
        if (await this.trySwitchToRaydium())
          return await this.executeSell(percent, before);
        if (!(await this.trySwitchToSolard())) throw error;
      }
    }
    if (this.venueValue === "raydium") {
      const quote = await resolveTradeAsset(this.slrd, "SOL");
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
      return {
        signature: result.signatures.at(-1) ?? null,
        venue: "raydium",
      };
    }
    const value = await this.slrd.sell(this.mint, this.walletRef, {
      bps,
      slippageBps: this.slippageBps,
      via: this.via as any,
    });
    return {
      signature: (value as any)?.signature ?? null,
      venue: "solard",
    };
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
    before: StrategyPosition,
  ): Promise<StrategyPosition> {
    let latest = before;
    for (let attempt = 1; attempt <= this.settlementAttempts; attempt += 1) {
      if (attempt > 1) await sleep(750);
      latest = await this.position();
      const changed =
        side === "buy"
          ? latest.tokenRaw > before.tokenRaw
          : latest.tokenRaw < before.tokenRaw;
      if (changed) return latest;
    }
    throw new Error(
      `${side} did not produce a provable token balance delta after ${this.settlementAttempts} wallet reads`,
    );
  }
}

async function loadStrategy(path: string): Promise<TradeStrategy<any>> {
  const absolute = resolve(path);
  const module = (await import(
    `${pathToFileURL(absolute).href}?strategy=${Date.now()}`
  )) as { default?: unknown; strategy?: unknown };
  const strategy = (module.default ?? module.strategy) as TradeStrategy<any>;
  if (!strategy || typeof strategy !== "object")
    throw new Error(`Strategy ${absolute} must default-export an object`);
  if (typeof strategy.onTrade !== "function")
    throw new Error(
      `Strategy ${absolute} must define async onTrade(ctx, trade)`,
    );
  return strategy;
}

async function initialState(strategy: TradeStrategy<any>): Promise<any> {
  if (typeof strategy.state === "function") return await strategy.state();
  if (strategy.state == null) return {};
  return structuredClone(strategy.state);
}

function params(flags: Flags): Record<string, unknown> {
  const raw = flag(flags, "params");
  if (!raw) return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("--params must be a JSON object");
  return value as Record<string, unknown>;
}

async function ensureToken(slrd: Trader, tokenRef: string): Promise<string> {
  try {
    return slrd.resolveToken(tokenRef).mint;
  } catch {
    await slrd.addToken(tokenRef);
    return slrd.resolveToken(tokenRef).mint;
  }
}

export async function runTradeStrategyCommand(args: {
  values: string[];
  flags: Flags;
  emit: Emit;
}): Promise<void> {
  const path = args.values[1];
  if (!path)
    throw new Error(
      "Usage: slrd strategy run <file.ts> --token <mint|alias> --wallet <wallet> [--params '{...}'] [--live]",
    );
  const tokenRef = required(args.flags, "token");
  const walletRef = required(args.flags, "wallet");
  const live = args.flags.has("live");
  if (live && !liveEnabled()) {
    throw new Error(
      "Live strategy execution requires --live and SOLARD_ENABLE_LIVE_TRADES=1",
    );
  }
  const json = args.flags.has("json");
  const continueOnError = args.flags.has("continue-on-error");
  const slippageBps = Math.max(
    1,
    Math.min(10_000, Math.trunc(numberFlag(args.flags, "slippage-bps", 500))),
  );
  const settlementAttempts = integerFlag(args.flags, "settlement-attempts", 24);
  const launchlabProbeSol = Math.max(
    0.000001,
    numberFlag(args.flags, "launchlab-probe-sol", 0.001),
  );
  const via = flag(args.flags, "sender") ?? "rpc";
  const heartbeatMs = Math.max(
    1_000,
    Math.trunc(numberFlag(args.flags, "heartbeat-ms", 15_000)),
  );
  const url = rpcUrl(args.flags);
  const strategy = await loadStrategy(path);
  const state = await initialState(strategy);
  const strategyParams = params(args.flags);
  const slrd = createTraderSolard({ rpcUrl: url });
  const connection = slrd.connection();
  let stopped = false;
  let stopReason = "stopped";
  let tradeCount = 0;
  let lastTrade: StrategyTrade | null = null;
  let callbackErrors = 0;
  let rpcErrors = 0;
  let solUsdValue: number | null = null;
  let solUsdAt = 0;
  let queuePeak = 0;
  const queue: string[] = [];
  const queued = new Set<string>();
  const processed = new Map<string, number>();
  const subscriptions = new Map<string, number>();

  try {
    const mint = await ensureToken(slrd, tokenRef);
    const walletAddress = slrd.resolveWallet(walletRef).address.toBase58();
    const supply = await connection.getTokenSupply(
      new PublicKey(mint),
      "confirmed",
    );
    const decimals = supply.value.decimals;
    const supplyUi = Number(supply.value.uiAmountString ?? "0");
    const executor = new StrategyExecutor(
      slrd,
      mint,
      walletRef,
      live,
      slippageBps,
      via,
      settlementAttempts,
      launchlabProbeSol,
    );

    const emitEvent = (value: unknown) => {
      if (json) args.emit(`${JSON.stringify(value)}\n`);
    };

    const log = (message: string, data?: unknown) => {
      const event = {
        type: "strategy-log",
        at: new Date().toISOString(),
        strategy: strategy.name ?? path,
        message,
        ...(data === undefined ? {} : { data }),
      };
      if (json) emitEvent(event);
      else
        args.emit(
          `${event.at} STRATEGY ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}\n`,
        );
    };

    const context = {
      get mint() {
        return mint;
      },
      get wallet() {
        return walletRef;
      },
      get walletAddress() {
        return walletAddress;
      },
      get live() {
        return live;
      },
      get state() {
        return state;
      },
      get params() {
        return strategyParams;
      },
      get tradeCount() {
        return tradeCount;
      },
      get lastTrade() {
        return lastTrade;
      },
      async buy(input: { sol: number; reason?: string }) {
        const result = await executor.buy(input.sol, input.reason ?? null);
        const event = {
          type: "strategy-execution",
          at: new Date(result.completedAt).toISOString(),
          ...result,
          tokenDeltaRaw: result.tokenDeltaRaw?.toString() ?? null,
          solDeltaLamports: result.solDeltaLamports?.toString() ?? null,
        };
        if (json) emitEvent(event);
        else
          args.emit(
            `${event.at} ${result.live ? "EXEC" : "DRY"} BUY sol=${input.sol} venue=${result.venue ?? "pending"} sig=${result.signature ?? "-"}${input.reason ? ` reason=${input.reason}` : ""}\n`,
          );
        return result;
      },
      async sell(input: { percent: number; reason?: string }) {
        const result = await executor.sell(input.percent, input.reason ?? null);
        const event = {
          type: "strategy-execution",
          at: new Date(result.completedAt).toISOString(),
          ...result,
          tokenDeltaRaw: result.tokenDeltaRaw?.toString() ?? null,
          solDeltaLamports: result.solDeltaLamports?.toString() ?? null,
        };
        if (json) emitEvent(event);
        else
          args.emit(
            `${event.at} ${result.live ? "EXEC" : "DRY"} SELL percent=${input.percent} venue=${result.venue ?? "pending"} sig=${result.signature ?? "-"}${input.reason ? ` reason=${input.reason}` : ""}\n`,
          );
        return result;
      },
      position: () => executor.position(),
      samplePrice: () => executor.samplePrice(),
      log,
      stop(reason?: string) {
        stopped = true;
        stopReason = reason?.trim() || "strategy requested stop";
      },
    } satisfies TradeStrategyContext<any>;

    const refreshSolUsd = async () => {
      if (solUsdValue != null && Date.now() - solUsdAt < 30_000)
        return solUsdValue;
      try {
        solUsdValue = await fetchSolUsd();
        solUsdAt = Date.now();
      } catch {}
      return solUsdValue;
    };

    const enqueue = (signature: string) => {
      if (
        stopped ||
        !signature ||
        queued.has(signature) ||
        processed.has(signature)
      )
        return;
      queued.add(signature);
      queue.push(signature);
      queuePeak = Math.max(queuePeak, queue.length);
      if (queue.length === 100 || queue.length % 500 === 0) {
        process.stderr.write(
          `strategy warning: transaction queue=${queue.length}; RPC/callback processing is behind live trades\n`,
        );
      }
    };

    const subscribeAddress = (address: string) => {
      if (!address || subscriptions.has(address)) return;
      try {
        const id = connection.onLogs(
          new PublicKey(address),
          (event: Logs) => {
            if (!event.err) enqueue(event.signature);
          },
          "processed",
        );
        subscriptions.set(address, id);
      } catch (error) {
        process.stderr.write(
          `strategy subscription error ${address}: ${errorText(error)}\n`,
        );
      }
    };

    const refreshAddresses = async () => {
      subscribeAddress(mint);
      try {
        const token = slrd.resolveToken(mint) as any;
        if (token.bondingCurve) subscribeAddress(String(token.bondingCurve));
        if (token.pool) subscribeAddress(String(token.pool));
      } catch {}
      for (const address of await discoverRaydiumPools(mint)) {
        subscribeAddress(address);
      }
    };

    const fetchTransaction = async (
      signature: string,
    ): Promise<ParsedTransactionWithMeta | null> => {
      for (let attempt = 0; attempt < 8 && !stopped; attempt += 1) {
        try {
          const tx = await connection.getParsedTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          if (tx) return tx;
        } catch {
          rpcErrors += 1;
        }
        await sleep(200 + attempt * 150);
      }
      return null;
    };

    const handleCallbackError = async (
      error: unknown,
      trade: StrategyTrade | null,
    ) => {
      callbackErrors += 1;
      if (strategy.onError) {
        try {
          await strategy.onError(context, error, trade);
        } catch (handlerError) {
          process.stderr.write(
            `strategy onError failed: ${errorText(handlerError)}\n`,
          );
        }
      }
      process.stderr.write(`strategy callback error: ${errorText(error)}\n`);
      if (!continueOnError) {
        stopped = true;
        stopReason = `callback error: ${errorText(error)}`;
      }
    };

    const processQueue = async () => {
      while (!stopped) {
        const signature = queue.shift();
        if (!signature) {
          await sleep(25);
          continue;
        }
        queued.delete(signature);
        if (processed.has(signature)) continue;
        processed.set(signature, Date.now());
        const tx = await fetchTransaction(signature);
        if (!tx) continue;
        const solUsd = await refreshSolUsd();
        const parsed = parseTrades({
          tx,
          signature,
          mint,
          decimals,
          supplyUi,
          walletAddress,
          solUsd,
        });
        for (const trade of parsed) {
          if (stopped) break;
          tradeCount += 1;
          lastTrade = trade;
          if (json) {
            emitEvent({
              type: "trade",
              ...trade,
              tokenAmountRaw: trade.tokenAmountRaw.toString(),
            });
          }
          try {
            await strategy.onTrade(context, trade);
          } catch (error) {
            await handleCallbackError(error, trade);
          }
        }
      }
    };

    await refreshSolUsd();
    await refreshAddresses();

    if (!json) {
      args.emit(
        `🦉 strategy=${strategy.name ?? path} token=${mint} wallet=${walletRef} mode=${live ? "LIVE" : "DRY"} event=each-trade subscriptions=${subscriptions.size} — Ctrl+C to stop\n`,
      );
    } else {
      emitEvent({
        type: "strategy-start",
        strategy: strategy.name ?? path,
        mint,
        wallet: walletRef,
        walletAddress,
        live,
      });
    }

    if (strategy.onStart) {
      try {
        await strategy.onStart(context);
      } catch (error) {
        await handleCallbackError(error, null);
      }
    }

    const stopSignal = () => {
      stopped = true;
      stopReason = "signal";
    };
    process.once("SIGINT", stopSignal);
    process.once("SIGTERM", stopSignal);
    const addressTimer = setInterval(() => {
      void refreshAddresses();
      const cutoff = Date.now() - 3_600_000;
      for (const [signature, at] of processed) {
        if (at < cutoff) processed.delete(signature);
      }
    }, 30_000);
    const solUsdTimer = setInterval(() => void refreshSolUsd(), 30_000);
    const heartbeatTimer = setInterval(() => {
      process.stderr.write(
        `strategy trades=${tradeCount} queue=${queue.length} queuePeak=${queuePeak} subscriptions=${subscriptions.size} callbackErrors=${callbackErrors} rpcErrors=${rpcErrors} executionVenue=${executor.venue ?? "unresolved"}\n`,
      );
    }, heartbeatMs);

    try {
      await processQueue();
    } finally {
      clearInterval(addressTimer);
      clearInterval(solUsdTimer);
      clearInterval(heartbeatTimer);
      process.removeListener("SIGINT", stopSignal);
      process.removeListener("SIGTERM", stopSignal);
      for (const id of subscriptions.values()) {
        try {
          await connection.removeOnLogsListener(id);
        } catch {}
      }
      if (strategy.onStop) {
        try {
          await strategy.onStop(context, stopReason);
        } catch (error) {
          process.stderr.write(`strategy onStop failed: ${errorText(error)}\n`);
        }
      }
      if (json) {
        emitEvent({
          type: "strategy-stop",
          strategy: strategy.name ?? path,
          reason: stopReason,
          trades: tradeCount,
          queuePeak,
          callbackErrors,
          rpcErrors,
        });
      } else {
        args.emit(
          `strategy stopped reason=${stopReason} trades=${tradeCount} queuePeak=${queuePeak} callbackErrors=${callbackErrors} rpcErrors=${rpcErrors}\n`,
        );
      }
    }
  } finally {
    slrd.close();
  }
}
