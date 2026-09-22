import {
  Connection,
  PublicKey,
  type Logs,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";

type Flags = Map<string, string>;
type Emit = (value: string) => void;

type VenueId = "pump" | "raydium-launchlab";

type Candle = {
  startAtMs: number;
  endAtMs: number;
  open: number;
  close: number;
  high: number;
  low: number;
  trades: number;
  green: boolean;
};

type LiveCandle = {
  startAtMs: number;
  open: number;
  close: number;
  high: number;
  low: number;
  trades: number;
};

type TokenState = {
  mint: string;
  venue: VenueId;
  createdAtMs: number;
  lastSeenAtMs: number;
  decimals: number;
  supplyUi: number;
  priceSol: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  eligibleAtMs: number | null;
  firstEligibleBucketStartMs: number | null;
  lastFinalizedBucketStartMs: number | null;
  greenStreak: number;
  streakAlerted: boolean;
  greenRun: Candle[];
  buckets: Map<number, LiveCandle>;
  subscriptionId: number | null;
};

type Trade = {
  atMs: number;
  side: "buy" | "sell";
  priceSol: number | null;
  priceUsd: number | null;
};

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
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

function duration(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const scale = ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const)[
    (match[2]?.toLowerCase() ?? "ms") as "ms" | "s" | "m" | "h"
  ];
  return Math.max(100, Math.floor(Number(match[1]) * scale));
}

function rpcUrl(flags: Flags): string {
  const value =
    flag(flags, "rpc") ??
    process.env.RPC_ENDPOINT?.trim() ??
    process.env.SOLANA_RPC_URL?.trim() ??
    process.env.HELIUS_RPC_URL?.trim();
  if (!value)
    throw new Error(
      "launch watch requires RPC_ENDPOINT, SOLANA_RPC_URL, HELIUS_RPC_URL, or --rpc <url>",
    );
  return value;
}

function venues(flags: Flags): VenueId[] {
  const raw = flag(flags, "venue") ?? "pump,raydium-launchlab";
  const values = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) =>
      value === "launchlab" || value === "raydium" || value === "stonkfun"
        ? "raydium-launchlab"
        : value,
    );
  const out = [...new Set(values)] as string[];
  for (const value of out) {
    if (value !== "pump" && value !== "raydium-launchlab")
      throw new Error(`Unsupported --venue value: ${value}`);
  }
  return out as VenueId[];
}

function usd(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: value < 10_000 ? 2 : 0,
    maximumFractionDigits: value < 10_000 ? 2 : 0,
  });
}

function finitePositive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function fetchJson(url: string): Promise<unknown> {
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
    const raw = (await fetchJson(
      "https://api.coinbase.com/v2/prices/SOL-USD/spot",
    )) as { data?: { amount?: unknown } };
    const value = finitePositive(raw?.data?.amount);
    if (value != null) return value;
  } catch {}
  const raw = (await fetchJson(
    "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
  )) as { solana?: { usd?: unknown } };
  const value = finitePositive(raw?.solana?.usd);
  if (value == null) throw new Error("SOL/USD price unavailable");
  return value;
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
  const explicit = rows
    .filter((row) => row && typeof row === "object" && row.signer === true)
    .map((row) => keyText(row))
    .filter((row): row is string => Boolean(row));
  return new Set(explicit);
}

function rawAmount(row: any): bigint {
  try {
    return BigInt(String(row?.uiTokenAmount?.amount ?? "0"));
  } catch {
    return 0n;
  }
}

function tokenBalances(rows: readonly any[] | null | undefined) {
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
  for (const row of [...pre, ...post])
    if (row.mint === mint && row.owner === owner) indices.add(row.accountIndex);
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
    if ((pairPost?.mint ?? pairPre?.mint) === WSOL_MINT)
      delta -= (pairPost?.raw ?? 0n) - (pairPre?.raw ?? 0n);
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

function parseTrade(
  tx: ParsedTransactionWithMeta,
  token: TokenState,
): Trade | null {
  if (!tx.meta || tx.meta.err || tx.blockTime == null) return null;
  const signers = signerKeys(tx);
  const owners = new Set<string>();
  for (const row of [
    ...tokenBalances(tx.meta.preTokenBalances),
    ...tokenBalances(tx.meta.postTokenBalances),
  ]) {
    if (row.mint === token.mint && row.owner && signers.has(row.owner))
      owners.add(row.owner);
  }
  for (const owner of owners) {
    const targetDelta = ownerTokenDeltaRaw(tx, token.mint, owner);
    if (targetDelta === 0n) continue;
    const side = targetDelta > 0n ? "buy" : "sell";
    const tokenUi =
      Number(targetDelta < 0n ? -targetDelta : targetDelta) /
      10 ** token.decimals;
    if (!(tokenUi > 0) || !Number.isFinite(tokenUi)) continue;

    const solDelta = economicSolDelta(tx, owner);
    if (
      solDelta != null &&
      ((side === "buy" && solDelta < 0n) || (side === "sell" && solDelta > 0n))
    ) {
      const solUi =
        Number(solDelta < 0n ? -solDelta : solDelta) / LAMPORTS_PER_SOL;
      if (solUi > 0 && Number.isFinite(solUi))
        return {
          atMs: tx.blockTime * 1_000,
          side,
          priceSol: solUi / tokenUi,
          priceUsd: null,
        };
    }

    const usdcDelta = ownerTokenDeltaRaw(tx, USDC_MINT, owner);
    if (
      (side === "buy" && usdcDelta < 0n) ||
      (side === "sell" && usdcDelta > 0n)
    ) {
      const usdcUi =
        Number(usdcDelta < 0n ? -usdcDelta : usdcDelta) / 1_000_000;
      if (usdcUi > 0 && Number.isFinite(usdcUi))
        return {
          atMs: tx.blockTime * 1_000,
          side,
          priceSol: null,
          priceUsd: usdcUi / tokenUi,
        };
    }
  }
  return null;
}

function instructions(tx: ParsedTransactionWithMeta): any[] {
  const outer = ((tx.transaction.message as any).instructions ?? []) as any[];
  const inner = (tx.meta?.innerInstructions ?? []).flatMap(
    (group: any) => group.instructions ?? [],
  );
  return [...outer, ...inner];
}

function initializedMints(tx: ParsedTransactionWithMeta): string[] {
  const out = new Set<string>();
  for (const ix of instructions(tx)) {
    const parsed = (ix as any)?.parsed;
    const type = String(parsed?.type ?? "").toLowerCase();
    if (type !== "initializemint" && type !== "initializemint2") continue;
    const mint =
      keyText(parsed?.info?.mint) ?? String(parsed?.info?.mint ?? "");
    if (mint && mint !== WSOL_MINT && mint !== USDC_MINT) out.add(mint);
  }
  if (!out.size) {
    const pre = new Set(
      tokenBalances(tx.meta?.preTokenBalances).map((row) => row.mint),
    );
    const post = tokenBalances(tx.meta?.postTokenBalances)
      .map((row) => row.mint)
      .filter(
        (mint) =>
          mint && mint !== WSOL_MINT && mint !== USDC_MINT && !pre.has(mint),
      );
    const pump = post.find((mint) => /pump$/i.test(mint));
    if (pump) out.add(pump);
    else if (post.length === 1) out.add(post[0]!);
  }
  return [...out];
}

function createLike(logs: readonly string[], venue: VenueId): boolean {
  const text = logs.join("\n");
  if (venue === "pump") return /Instruction:\s*Create(?:V2)?\b/i.test(text);
  return /Instruction:\s*(?:InitializeMint2?|Initialize|InitializeV2|Create|CreateLaunchpad|InitializeLaunchpad)\b/i.test(
    text,
  );
}

function bucketStart(atMs: number, candleMs: number): number {
  return Math.floor(atMs / candleMs) * candleMs;
}

function firstFullBucketAfter(atMs: number, candleMs: number): number {
  return Math.ceil(atMs / candleMs) * candleMs;
}

function updateCandle(
  token: TokenState,
  atMs: number,
  candleMs: number,
  value: number,
): void {
  if (token.firstEligibleBucketStartMs == null) return;
  const startAtMs = bucketStart(atMs, candleMs);
  if (startAtMs < token.firstEligibleBucketStartMs) return;
  const existing = token.buckets.get(startAtMs);
  if (!existing) {
    token.buckets.set(startAtMs, {
      startAtMs,
      open: value,
      close: value,
      high: value,
      low: value,
      trades: 1,
    });
    return;
  }
  existing.close = value;
  existing.high = Math.max(existing.high, value);
  existing.low = Math.min(existing.low, value);
  existing.trades += 1;
}

async function sendWebhook(url: string, payload: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`webhook returned HTTP ${response.status}`);
}

export async function runLaunchWatchCommand(args: {
  flags: Flags;
  emit: Emit;
  forcedVenues?: VenueId[];
}): Promise<void> {
  const selectedVenues = args.forcedVenues ?? venues(args.flags);
  const minMarketCapUsd = numberFlag(args.flags, "min-mcap", 5_000);
  if (!(minMarketCapUsd > 0)) throw new Error("--min-mcap must be > 0");
  const candleMs = duration(flag(args.flags, "candle"), 30_000);
  const greenCandles = integerFlag(args.flags, "green-candles", 5);
  const trackTtlMs = duration(flag(args.flags, "track-ttl"), 30 * 60_000);
  const maxTracked = integerFlag(args.flags, "max-tracked", 500);
  const json = args.flags.has("json");
  const once = args.flags.has("once");
  const bell = !args.flags.has("no-bell");
  const webhook = flag(args.flags, "webhook");
  const connection = new Connection(rpcUrl(args.flags), "confirmed");
  const tokens = new Map<string, TokenState>();
  const processedSignatures = new Map<string, number>();
  const programSubscriptions: number[] = [];
  let stopped = false;
  let solUsdValue: number | null = null;
  let solUsdUpdatedAtMs = 0;
  let creates = 0;
  let trades = 0;
  let crossings = 0;
  let alerts = 0;
  let fetchErrors = 0;

  const solUsd = async (): Promise<number | null> => {
    if (solUsdValue != null && Date.now() - solUsdUpdatedAtMs < 30_000)
      return solUsdValue;
    try {
      solUsdValue = await fetchSolUsd();
      solUsdUpdatedAtMs = Date.now();
    } catch {}
    return solUsdValue;
  };

  const removeToken = async (token: TokenState) => {
    tokens.delete(token.mint);
    if (token.subscriptionId != null) {
      try {
        await connection.removeOnLogsListener(token.subscriptionId);
      } catch {}
      token.subscriptionId = null;
    }
  };

  const prune = async () => {
    const now = Date.now();
    const unqualified = [...tokens.values()]
      .filter((token) => token.eligibleAtMs == null)
      .sort((a, b) => a.lastSeenAtMs - b.lastSeenAtMs);
    for (const token of unqualified) {
      if (now - token.createdAtMs > trackTtlMs || tokens.size > maxTracked)
        await removeToken(token);
    }
  };

  const qualify = async (token: TokenState) => {
    if (
      token.eligibleAtMs != null ||
      token.marketCapUsd == null ||
      token.marketCapUsd < minMarketCapUsd
    )
      return false;
    const now = Date.now();
    token.eligibleAtMs = now;
    token.firstEligibleBucketStartMs = firstFullBucketAfter(now, candleMs);
    token.lastFinalizedBucketStartMs = null;
    token.greenStreak = 0;
    token.streakAlerted = false;
    token.greenRun = [];
    token.buckets.clear();
    crossings += 1;
    const event = {
      type: "threshold-crossed",
      detectedAt: new Date().toISOString(),
      venue: token.venue,
      mint: token.mint,
      thresholdMarketCapUsd: minMarketCapUsd,
      marketCapUsd: token.marketCapUsd,
      priceSol: token.priceSol,
      priceUsd: token.priceUsd,
    };
    if (json) args.emit(`${JSON.stringify(event)}\n`);
    else
      args.emit(
        `${event.detectedAt} CROSS venue=${token.venue} mcap=$${usd(token.marketCapUsd)} mint=${token.mint}\n`,
      );
    if (once) stopped = true;
    return true;
  };

  const processTokenTransaction = async (
    token: TokenState,
    signature: string,
  ) => {
    if (processedSignatures.has(signature)) return;
    processedSignatures.set(signature, Date.now());
    let tx: ParsedTransactionWithMeta | null = null;
    for (let attempt = 0; attempt < 8 && !tx && !stopped; attempt += 1) {
      try {
        tx = await connection.getParsedTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
      } catch {}
      if (!tx)
        await new Promise((resolve) =>
          setTimeout(resolve, 250 + attempt * 150),
        );
    }
    if (!tx) {
      fetchErrors += 1;
      return;
    }
    const trade = parseTrade(tx, token);
    if (!trade) return;
    trades += 1;
    token.lastSeenAtMs = trade.atMs;
    if (trade.priceSol != null) {
      token.priceSol = trade.priceSol;
      const s = await solUsd();
      if (s != null) token.priceUsd = trade.priceSol * s;
    } else if (trade.priceUsd != null) {
      token.priceUsd = trade.priceUsd;
    }
    if (token.priceUsd != null && token.supplyUi > 0)
      token.marketCapUsd = token.priceUsd * token.supplyUi;
    await qualify(token);
    if (token.eligibleAtMs != null) {
      const candlePrice = token.priceSol ?? token.priceUsd;
      if (candlePrice != null)
        updateCandle(token, trade.atMs, candleMs, candlePrice);
    }
  };

  const subscribeMint = (token: TokenState) => {
    if (token.subscriptionId != null) return;
    token.subscriptionId = connection.onLogs(
      new PublicKey(token.mint),
      (log: Logs) => {
        if (!log.err) void processTokenTransaction(token, log.signature);
      },
      "processed",
    );
  };

  const registerCreate = async (venue: VenueId, signature: string) => {
    let tx: ParsedTransactionWithMeta | null = null;
    for (let attempt = 0; attempt < 8 && !tx && !stopped; attempt += 1) {
      try {
        tx = await connection.getParsedTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
      } catch {}
      if (!tx)
        await new Promise((resolve) =>
          setTimeout(resolve, 250 + attempt * 150),
        );
    }
    if (!tx || tx.meta?.err) {
      fetchErrors += 1;
      return;
    }
    for (const mint of initializedMints(tx)) {
      if (tokens.has(mint)) continue;
      let supplyUi = 0;
      let decimals = 6;
      try {
        const supply = await connection.getTokenSupply(
          new PublicKey(mint),
          "confirmed",
        );
        decimals = supply.value.decimals;
        supplyUi = Number(supply.value.uiAmountString ?? "0");
      } catch {}
      if (!(supplyUi > 0)) continue;
      const now = (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1_000;
      const token: TokenState = {
        mint,
        venue,
        createdAtMs: now,
        lastSeenAtMs: now,
        decimals,
        supplyUi,
        priceSol: null,
        priceUsd: null,
        marketCapUsd: null,
        eligibleAtMs: null,
        firstEligibleBucketStartMs: null,
        lastFinalizedBucketStartMs: null,
        greenStreak: 0,
        streakAlerted: false,
        greenRun: [],
        buckets: new Map(),
        subscriptionId: null,
      };
      tokens.set(mint, token);
      creates += 1;
      subscribeMint(token);
      if (!json)
        args.emit(
          `${new Date(now).toISOString()} NEW venue=${venue} mint=${mint}\n`,
        );
      else
        args.emit(
          `${JSON.stringify({ type: "new-token", detectedAt: new Date(now).toISOString(), venue, mint })}\n`,
        );
      await processTokenTransaction(token, signature);
      await prune();
    }
  };

  const finalizeCandles = async () => {
    const now = Date.now();
    const currentStart = bucketStart(now, candleMs);
    for (const token of tokens.values()) {
      if (token.firstEligibleBucketStartMs == null) continue;
      let next =
        token.lastFinalizedBucketStartMs == null
          ? token.firstEligibleBucketStartMs
          : token.lastFinalizedBucketStartMs + candleMs;
      while (next < currentStart) {
        const live = token.buckets.get(next);
        token.buckets.delete(next);
        const candle: Candle | null = live
          ? {
              startAtMs: live.startAtMs,
              endAtMs: live.startAtMs + candleMs,
              open: live.open,
              close: live.close,
              high: live.high,
              low: live.low,
              trades: live.trades,
              green: live.close > live.open,
            }
          : null;
        if (!candle || !candle.green) {
          token.greenStreak = 0;
          token.streakAlerted = false;
          token.greenRun = [];
        } else {
          token.greenStreak += 1;
          token.greenRun.push(candle);
          while (token.greenRun.length > greenCandles) token.greenRun.shift();
          if (
            token.greenStreak >= greenCandles &&
            !token.streakAlerted &&
            token.greenRun.length === greenCandles
          ) {
            token.streakAlerted = true;
            alerts += 1;
            const first = token.greenRun[0]!;
            const last = token.greenRun.at(-1)!;
            const event = {
              type: "green-streak",
              detectedAt: new Date().toISOString(),
              venue: token.venue,
              mint: token.mint,
              currentMarketCapUsd: token.marketCapUsd,
              candleMs,
              consecutiveGreenCandles: greenCandles,
              streakChangePct: (last.close / first.open - 1) * 100,
            };
            if (bell) process.stderr.write("\x07");
            if (json) args.emit(`${JSON.stringify(event)}\n`);
            else
              args.emit(
                `🔔 ${event.detectedAt} ALERT venue=${token.venue} ${greenCandles}x${Math.round(candleMs / 1000)}s green change=${event.streakChangePct >= 0 ? "+" : ""}${event.streakChangePct.toFixed(2)}% mcap=${token.marketCapUsd == null ? "n/a" : "$" + usd(token.marketCapUsd)} mint=${token.mint}\n`,
              );
            if (webhook)
              void sendWebhook(webhook, event).catch((error) =>
                process.stderr.write(
                  `launch watch webhook error: ${error instanceof Error ? error.message : String(error)}\n`,
                ),
              );
          }
        }
        token.lastFinalizedBucketStartMs = next;
        next += candleMs;
      }
    }
  };

  const programRows: Array<{ venue: VenueId; program: string }> = [];
  if (selectedVenues.includes("pump"))
    programRows.push({ venue: "pump", program: PUMP_PROGRAM });
  if (selectedVenues.includes("raydium-launchlab"))
    programRows.push({
      venue: "raydium-launchlab",
      program: RAYDIUM_LAUNCHPAD_PROGRAM,
    });

  for (const row of programRows) {
    const id = connection.onLogs(
      new PublicKey(row.program),
      (log: Logs) => {
        if (!log.err && createLike(log.logs, row.venue))
          void registerCreate(row.venue, log.signature);
      },
      "processed",
    );
    programSubscriptions.push(id);
  }

  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await solUsd();

  const candleTimer = setInterval(
    () => void finalizeCandles(),
    Math.max(250, Math.min(1_000, candleMs / 10)),
  );
  const maintenanceTimer = setInterval(() => {
    void prune();
    const cutoff = Date.now() - 10 * 60_000;
    for (const [signature, at] of processedSignatures)
      if (at < cutoff) processedSignatures.delete(signature);
    void solUsd();
  }, 15_000);
  const heartbeatTimer = setInterval(() => {
    const eligible = [...tokens.values()].filter(
      (token) => token.eligibleAtMs != null,
    ).length;
    process.stderr.write(
      `launch watch rpc venues=${selectedVenues.join(",")} new=${creates} tracked=${tokens.size} eligible=${eligible} trades=${trades} crossings=${crossings} alerts=${alerts} fetchErrors=${fetchErrors} solUsd=${solUsdValue == null ? "n/a" : solUsdValue.toFixed(2)}\n`,
    );
  }, 15_000);

  if (!json)
    args.emit(
      `🦉 launch watch RPC venues=${selectedVenues.join(",")} minMcap=$${usd(minMarketCapUsd)} greenAlert=${greenCandles}x${Math.round(candleMs / 1_000)}s trackTtl=${Math.round(trackTtlMs / 60_000)}m maxTracked=${maxTracked} — Ctrl+C to stop\n`,
    );
  else
    process.stderr.write(
      `launch watch RPC venues=${selectedVenues.join(",")}\n`,
    );

  try {
    while (!stopped) await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    clearInterval(candleTimer);
    clearInterval(maintenanceTimer);
    clearInterval(heartbeatTimer);
    for (const id of programSubscriptions) {
      try {
        await connection.removeOnLogsListener(id);
      } catch {}
    }
    for (const token of tokens.values()) {
      if (token.subscriptionId != null) {
        try {
          await connection.removeOnLogsListener(token.subscriptionId);
        } catch {}
      }
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
