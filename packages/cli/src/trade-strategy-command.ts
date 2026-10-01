import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configure, createMeasure } from "measure-fn";
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
  subscribeTrades,
  type TradeEvent,
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

export type StrategyPriceTick = {
  signature: string;
  slot: number;
  atMs: number;
  mint: string;
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
  readonly priceCount: number;
  readonly lastPrice: StrategyPriceTick | null;
  readonly tradeCount: number;
  readonly lastTrade: StrategyTrade | null;
  buy(input: { sol: number; reason?: string }): Promise<StrategyExecution>;
  sell(input: { percent: number; reason?: string }): Promise<StrategyExecution>;
  position(): Promise<StrategyPosition>;
  samplePrice(): Promise<{ price: number; venue: string }>;
  log(message: string, data?: unknown): void;
  notify(message: string, data?: unknown): void;
  stop(reason?: string): void;
};

export type TradeStrategy<State = Record<string, unknown>> = {
  name?: string;
  history?: { mode?: "price" | "exact"; sampleMs?: number };
  state?: State | (() => State | Promise<State>);
  onStart?(ctx: TradeStrategyContext<State>): void | Promise<void>;
  onPrice?(
    ctx: TradeStrategyContext<State>,
    price: StrategyPriceTick,
  ): void | Promise<void>;
  onTrade?(
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

function rpcReadRate(flags: Flags): { hard: number; read: number } {
  const raw = flag(flags, "rpc-rps") ?? process.env.SLRD_RPC_MAX_RPS ?? "5";
  const hardValue = Number(raw);
  if (!Number.isFinite(hardValue) || hardValue <= 0)
    throw new Error(`Invalid RPC rate: ${raw}`);
  const hard = Math.max(1, Math.floor(hardValue));
  const defaultRead = hard > 2 ? Math.min(3, hard - 2) : 1;
  const readRaw = flag(flags, "rpc-read-rps");
  const readValue = readRaw == null ? defaultRead : Number(readRaw);
  if (!Number.isFinite(readValue) || readValue <= 0)
    throw new Error(`Invalid --rpc-read-rps: ${readRaw}`);
  return { hard, read: Math.max(1, Math.min(hard, Math.floor(readValue))) };
}

class RpcPacer {
  private tail: Promise<unknown> = Promise.resolve();
  private nextAt = 0;
  private pending = 0;

  constructor(readonly rps: number) {}

  get queued(): number {
    return this.pending;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const step = Math.ceil(1_000 / this.rps);
    const execute = async () => {
      const wait = Math.max(0, this.nextAt - Date.now());
      if (wait > 0) await sleep(wait);
      this.nextAt = Math.max(this.nextAt, Date.now()) + step;
      try {
        return await fn();
      } finally {
        this.pending -= 1;
      }
    };
    const result = this.tail.then(execute, execute);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function required(flags: Flags, key: string): string {
  const value = flag(flags, key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function rpcUrl(flags: Flags): string {
  if (flags.has("rpc") || flags.has("ws"))
    throw new Error(
      "Set only RPC_ENDPOINT in the environment. --rpc and --ws are intentionally unsupported.",
    );
  const value = process.env.RPC_ENDPOINT?.trim();
  if (!value)
    throw new Error(
      "strategy run requires RPC_ENDPOINT. WebSocket access is derived from the same endpoint.",
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

async function parsedTransaction(
  connection: Connection,
  signature: string,
): Promise<ParsedTransactionWithMeta | null> {
  return (await connection.getParsedTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 1,
  } as any)) as ParsedTransactionWithMeta | null;
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
  if (
    typeof strategy.onPrice !== "function" &&
    typeof strategy.onTrade !== "function"
  )
    throw new Error(
      `Strategy ${absolute} must define async onPrice(ctx, price) or legacy onTrade(ctx, trade)`,
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
  if (live && !liveEnabled())
    throw new Error(
      "Live strategy execution requires --live and SOLARD_ENABLE_LIVE_TRADES=1",
    );
  const json = args.flags.has("json");
  configure({
    silent: false,
    logger(_event: unknown, next?: () => void) {
      next?.();
    },
  });
  const m = createMeasure("slrd:trade-strategy", { maxResultLength: 1600 });
  const report = <T extends Record<string, unknown>>(
    label: string,
    value: T,
  ): T => {
    if (json) {
      args.emit(`${JSON.stringify({ type: label, ...value })}\n`);
      return value;
    }
    return m.sync(
      { start: () => label, end: (result: T) => result },
      () => value,
    );
  };
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
  const rpc = rpcUrl(args.flags);
  const strategy = await loadStrategy(path);
  if (typeof strategy.onPrice !== "function")
    throw new Error(
      `Live trade strategy ${path} must define onPrice(ctx, price). ` +
        `Legacy onTrade is retained for historical exact-trade backtests, not per-agent live RPC subscriptions.`,
    );
  const state = await initialState(strategy);
  const strategyParams = params(args.flags);
  const slrd = createTraderSolard({ rpcUrl: rpc });
  let stopped = false;
  let stopReason = "stopped";
  let priceCount = 0;
  let lastPrice: StrategyPriceTick | null = null;
  let callbackErrors = 0;
  let tradeErrors = 0;
  let callbackQueue: Promise<void> = Promise.resolve();

  try {
    const mint = await ensureToken(slrd, tokenRef);
    const walletAddress = slrd.resolveWallet(walletRef).address.toBase58();
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

    const log = (message: string, data?: unknown) => {
      report("strategy log", {
        at: new Date().toISOString(),
        strategy: strategy.name ?? path,
        message,
        ...(data === undefined ? {} : { data }),
      });
    };
    const notify = (message: string, data?: unknown) => {
      if (!args.flags.has("no-bell") && !json) process.stderr.write("\x07");
      report("strategy notification", {
        at: new Date().toISOString(),
        strategy: strategy.name ?? path,
        mint,
        message,
        ...(data === undefined ? {} : { data }),
      });
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
      get priceCount() {
        return priceCount;
      },
      get lastPrice() {
        return lastPrice;
      },
      get tradeCount() {
        return 0;
      },
      get lastTrade() {
        return null;
      },
      async buy(input: { sol: number; reason?: string }) {
        const result = await executor.buy(input.sol, input.reason ?? null);
        report("strategy execution", {
          at: new Date(result.completedAt).toISOString(),
          ...result,
          side: "buy",
          tokenDeltaRaw: result.tokenDeltaRaw?.toString() ?? null,
          solDeltaLamports: result.solDeltaLamports?.toString() ?? null,
        });
        return result;
      },
      async sell(input: { percent: number; reason?: string }) {
        const result = await executor.sell(input.percent, input.reason ?? null);
        report("strategy execution", {
          at: new Date(result.completedAt).toISOString(),
          ...result,
          side: "sell",
          tokenDeltaRaw: result.tokenDeltaRaw?.toString() ?? null,
          solDeltaLamports: result.solDeltaLamports?.toString() ?? null,
        });
        return result;
      },
      position: () => executor.position(),
      samplePrice: () => executor.samplePrice(),
      log,
      notify,
      stop(reason?: string) {
        stopped = true;
        stopReason = reason?.trim() || "strategy requested stop";
      },
    } satisfies TradeStrategyContext<any>;

    const handleCallbackError = async (error: unknown) => {
      callbackErrors += 1;
      if (strategy.onError) {
        try {
          await strategy.onError(context, error, null);
        } catch (handlerError) {
          report("strategy onError failure", {
            error: errorText(handlerError),
          });
        }
      }
      report("strategy callback error", { error: errorText(error) });
      if (!continueOnError) {
        stopped = true;
        stopReason = `callback error: ${errorText(error)}`;
      }
    };

    const onPrice = async (event: TradeEvent) => {
      if (event.mint !== mint || stopped) return;
      if (event.market.priceSol == null && event.market.priceUsd == null)
        return;
      const price: StrategyPriceTick = {
        signature: event.signature,
        slot: event.slot,
        atMs: event.atMs,
        mint,
        priceSol: event.market.priceSol,
        priceUsd: event.market.priceUsd,
        marketCapUsd: event.market.marketCapUsd,
      };
      priceCount += 1;
      lastPrice = price;
      if (json) report("price", price as any);
      try {
        await strategy.onPrice!(context, price);
      } catch (error) {
        await handleCallbackError(error);
      }
    };

    const controller = new AbortController();
    const tradeSubscription = await subscribeTrades({
      connection: slrd.connection(),
      tokens: [mint],
      signal: controller.signal,
      onTrade(event) {
        callbackQueue = callbackQueue.then(() => onPrice(event));
      },
      onStatus(event, data) {
        if (event.includes("error")) tradeErrors += 1;
        report(`trades ${event}`, data ?? {});
      },
    });

    report("strategy ready", {
      strategy: strategy.name ?? path,
      mint,
      wallet: walletRef,
      walletAddress,
      live,
      event: "direct-trade-subscription",
      upstreamTradeSubscriptions: tradeSubscription.listTokens().length,
    });

    if (strategy.onStart) {
      try {
        await strategy.onStart(context);
      } catch (error) {
        await handleCallbackError(error);
      }
    }

    const stopSignal = () => {
      stopped = true;
      stopReason = "signal";
      controller.abort();
    };
    process.once("SIGINT", stopSignal);
    process.once("SIGTERM", stopSignal);
    const heartbeatTimer = setInterval(() => {
      report("strategy heartbeat", {
        prices: priceCount,
        callbackErrors,
        tradeErrors,
        upstreamTradeSubscriptions: tradeSubscription.listTokens().length,
        executionVenue: executor.venue ?? "unresolved",
      });
    }, heartbeatMs);

    try {
      while (!stopped) await sleep(250);
    } finally {
      clearInterval(heartbeatTimer);
      process.removeListener("SIGINT", stopSignal);
      process.removeListener("SIGTERM", stopSignal);
      controller.abort();
      await tradeSubscription.close();
      await callbackQueue.catch(() => undefined);
      if (strategy.onStop) {
        try {
          await strategy.onStop(context, stopReason);
        } catch (error) {
          report("strategy onStop failure", { error: errorText(error) });
        }
      }
      report("strategy stopped", {
        strategy: strategy.name ?? path,
        reason: stopReason,
        prices: priceCount,
        callbackErrors,
        tradeErrors,
      });
    }
  } finally {
    slrd.close();
  }
}
