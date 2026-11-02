import { parseRangeCsv } from "./packages/core/src/runtime/range-csv.ts";
import { SampleWake } from "./packages/core/src/runtime/sample-wake.ts";
import { RefreshingValue } from "./packages/core/src/runtime/refreshing-value.ts";
import { sampleObservationTime } from "./packages/core/src/runtime/sample-time.ts";
import { PreparedOrderSlot } from "./packages/core/src/runtime/prepared-order-slot.ts";
import { ThresholdHold } from "./packages/core/src/runtime/threshold-hold.ts";
import { rangeSlippageBps } from "./packages/core/src/runtime/range-slippage.ts";
import { marketCapPrices, type RangeSpec } from "./packages/core/src/runtime/market-cap-band.ts";
import { readMint } from "./packages/core/src/chain/state.ts";
import { SolardConnection } from "./packages/core/src/chain/connection.ts";
import { getSolUsdPrice } from "./packages/sdk/src/index.ts";
import { PublicKey } from "@solana/web3.js";
import { publishTradeHistory } from "./packages/core/src/runtime/trade-history-csv.ts";
import { resolveDbPath } from "./packages/core/src/db/database.ts";
import { parseRangeFile, watchRangeFile } from "./packages/core/src/runtime/range-file.ts";
import { fixedPriceBand, fixedPriceSignal, type FixedPriceBand } from "./packages/core/src/runtime/fixed-price-band.ts";
import { runIndependentSampler } from "./packages/core/src/runtime/independent-sampler.ts";
import { recordBotSnapshot } from "./packages/core/src/runtime/bot-journal.ts";
import { quoteSolLoader } from "./packages/core/src/market/launch-trades.ts";
import { samplePriceInSol } from "./packages/core/src/market/sample-price-sol.ts";

import { parseArgs } from "node:util";
import {
  existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync,
} from "node:fs";
import { createSolard } from "./packages/sdk/src/index";
import { createMeasure } from "measure-fn";

export async function runRangeBot(argv = process.argv.slice(2), runtime: {
  signal?: AbortSignal;
  client?: ReturnType<typeof createSolard>;
  ranges?: import("./packages/core/src/runtime/shared-ranges.ts").SharedRanges;
  solUsd?: typeof getSolUsdPrice;
  samplePrice?: () => Promise<import("./packages/core/src/venues/venue-plugin.ts").MarketPrice>;
  sharedBlockhashWarmer?: boolean;
  preparationIntervalMs?: number;
  /** Filled in by the engine: lets an operator console resume entries after a pause. */
  control?: { resumeEntries?: () => boolean };
} = {}) {
const { values: args } = parseArgs({
  args: argv,
  options: {
    mint: { type: "string" },
    "rpc-url": { type: "string" },
    mode: { type: "string", default: "fixed" },
    "check-config": { type: "boolean", default: false },
    "range-file": { type: "string" },
    "ranges-csv": { type: "string" },
    "buy-price-sol": { type: "string" },
    "sell-price-sol": { type: "string" },
    wallet: { type: "string", default: "trader-1" },
    amount: { type: "string", default: "0.1" },
    interval: { type: "string", default: "1000" },
    "priority-micro-lamports": { type: "string", default: "20000" },
    "cu-limit": { type: "string", default: "600000" },
    "hold-ms": { type: "string", default: "0" },
    "range-slippage-share-bps": { type: "string", default: "1000" },
    /** Grid slice id (s0, s1, ...): separate state/lock per slice of one wallet+mint. */
    slice: { type: "string" },
  },
});

if (args.mode !== "fixed") throw Error("range-trade.ts uses fixed prices only");
if ((args["range-file"] || args["ranges-csv"]) && (args["buy-price-sol"] || args["sell-price-sol"])) throw Error("Choose --range-file or inline prices");
if (args["range-file"] && args["ranges-csv"]) throw Error("Choose --ranges-csv or --range-file");
const mint = args.mint!;
const wallet = args.wallet!;
const configPath = args["ranges-csv"] ?? args["range-file"];
const parseConfig = (text: string) => args["ranges-csv"] ? parseRangeCsv(text, wallet, mint) : parseRangeFile(text);
let spec: RangeSpec = runtime.ranges ? runtime.ranges.read(wallet, mint) : configPath ? parseConfig(readFileSync(configPath, "utf8")) : fixedPriceBand(args["buy-price-sol"], args["sell-price-sol"]);
let fixed: FixedPriceBand = spec.kind === "fixed" ? spec : fixedPriceBand("1", "2");
let rangeFile: ReturnType<typeof watchRangeFile> | undefined;
const amount = Number(args.amount);
const interval = Number(args.interval);
const priorityMicroLamports = Number(args["priority-micro-lamports"]), cuLimit = Number(args["cu-limit"]);
const thresholdHold = new ThresholdHold(Number(args["hold-ms"]), interval * 1.5);
const slippageShareBps = Number(args["range-slippage-share-bps"]);
rangeSlippageBps(fixed, slippageShareBps);
if (!Number.isSafeInteger(priorityMicroLamports) || priorityMicroLamports < 0 || !Number.isInteger(cuLimit) || cuLimit < 1 || cuLimit > 1400000)
  throw Error("Valid priority-micro-lamports and cu-limit required");
const windowMs = 300000; // Retain recent samples for diagnostics only; not a trading indicator.
if (!mint || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(interval) || interval < 1000)
  throw Error("Valid mint, positive amount and interval >=1000ms are required");

if (args["check-config"]) { console.log(JSON.stringify({mint, wallet, amountSol: args.amount, range: spec, rangeFile: configPath ?? null, intervalMs: interval, holdMs: thresholdHold.holdMs, cuLimit, priorityMicroLamports, executionPolicy:"spot-trigger", slippageShareBps, maxAdditionalSlippageBps:200})); process.exit(0); }

const sliceId = args.slice && /^s\d{1,2}$/.test(args.slice) ? args.slice : undefined;
if (args.slice && !sliceId) throw Error("--slice must look like s0..s99");
const botId = sliceId ? `${mint}.${sliceId}` : mint;
const m = createMeasure(`range-${mint.slice(0, 8)}${sliceId ? `.${sliceId}` : ""}`);
const slrd = runtime.client ?? createSolard({
  transactionVersion: 1,
  ...((args["rpc-url"] ?? process.env.RPC_ENDPOINT)
    ? { rpcUrl: (args["rpc-url"] ?? process.env.RPC_ENDPOINT) }
    : {}),
});

const rpcUrl = args["rpc-url"] ?? process.env.RPC_ENDPOINT;
if (!rpcUrl) throw Error("RPC_ENDPOINT or --rpc-url is required");
const readConnection = new SolardConnection(rpcUrl).get();
const loadQuoteSol = quoteSolLoader(readConnection,
  (event, data) => m.note(`${event} | ${data?.reason ?? "conversion status"}`), 0,
  quoteMint => { try { return slrd.resolveToken(quoteMint).pool; } catch { return null; } },
  quoteMint => { try { return slrd.resolveToken(quoteMint).venueHint === "jupiter"; } catch { return false; } });

const storage = "./.range-bots";
mkdirSync(storage, { recursive: true });
const file = `${storage}/bot-${wallet}-${botId}.json`;
const lockPath = `./bot-${wallet}-${botId}.json.lock`;

type State = {
  marketObservation?: { capUsd: number; at: number };
  executionPolicy?: {kind:"spot-trigger";slippageShareBps:number;maxAdditionalSlippageBps:200};
  entryPause?: { reason: string; at: string; signature?: string };
  rangeSpec?: RangeSpec;
  orderScope?: string;
  strategy?: FixedPriceBand;
  health?: string;
  lastResult?: unknown;
  sellAtLoss?: boolean;
  phase: "buy" | "sell";
  position: null | {
    amountRaw: string;
    costLamports: string;
  };
  pending: null | {
    key: string;
    side: "buy" | "sell";
    buyPriceSol?: string; sellPriceSol?: string;
  };
  prices: { time: number; price: number }[];
  sequence: number;
};

const state: State = existsSync(file)
  ? JSON.parse(readFileSync(file, "utf8"))
  : {
      phase: "buy",
      position: null,
      pending: null,
      prices: [],
      sequence: 0,
    };

state.orderScope ??= crypto.randomUUID();
state.executionPolicy = {kind:"spot-trigger",slippageShareBps,maxAdditionalSlippageBps:200};
state.rangeSpec = spec;
state.strategy = spec.kind === "fixed" ? spec : undefined;
state.sellAtLoss = true;
state.prices ??= [];
state.sequence ??= 0;

if (
  (state.phase === "buy" && state.position) ||
  (state.phase === "sell" && !state.position)
) throw Error("Inconsistent saved position");

const save = (publish = true) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(state, (_, value) => typeof value === "bigint" ? value.toString() : value));
  renameSync(`${file}.tmp`, file);
  if (!publish) return;
  m.measureSync("Persist bot journal", () => recordBotSnapshot(storage, wallet, mint, state, "snapshot"));
  m.measureSync("Publish range trade CSV", () => publishTradeHistory(storage, wallet,
    readdirSync(storage).filter(name => name.startsWith(`bot-${wallet}-`) && name.endsWith(".json"))
      .map(name => name.slice(`bot-${wallet}-`.length, -5).replace(/\.s\d+$/, ""))
      .filter((value, index, all) => all.indexOf(value) === index).map(mint => ({ mint })),
    { dbPath: resolveDbPath(), intentPrefix: "range" }));
};

const fmt = (n: number) => n.toPrecision(9);
const describeResult = (result: { status?: string; code?: string; phase?: string; message?: string; attempts?: unknown[]; quotedMinimum?: bigint; requiredMinimum?: bigint } | null | undefined) => result
  ? [result.status, result.code, result.phase, result.message, `submitted attempts=${result.attempts?.length ?? 0}`].filter(Boolean).join(" | ")
  : "No result; keep pending for reconciliation";

// Disallow two processes controlling the same state file.
const lock = Bun.file(lockPath);
if (await lock.exists()) {
  throw Error(`Lock exists: ${lockPath}; check for another process`);
}
await Bun.write(lock, `${process.pid}`);

m.note(`Started | wallet=${wallet} | range=${JSON.stringify(spec)} | amount=${amount} SOL`);

const sampling = new AbortController();
const priceWake = new SampleWake();
const refreshOptions = { refreshAfterMs: 45_000, maxAgeMs: 120_000,
  onUpdate: () => priceWake.notify(),
  onError: (error: unknown) => m.note(`Metadata refresh failed; freshness guard remains active: ${String(error)}`) };
const mintSnapshots = new RefreshingValue(async () => {
  const atMs = Date.now();
  const info = await m.measure("Refresh mint supply", () => readMint(readConnection, new PublicKey(mint)));
  return { supply: info.supply, decimals: info.decimals, atMs };
}, refreshOptions);
const usdSnapshots = new RefreshingValue(
  () => m.measure("Refresh SOL/USD", () => (runtime.solUsd ?? getSolUsdPrice)({ maxAgeMs: 60_000 })),
  refreshOptions,
);
let sampler: Promise<void> | undefined;
let preparation: Promise<void> | undefined;
let blockhashWarmer: ReturnType<typeof slrd.warmBlockhash> | undefined;
const orderKey = (band: FixedPriceBand) => JSON.stringify({ side: state.phase, token: mint, wallet,
  ...(state.phase === "buy" ? { amountSol: String(amount) } : { amountRaw: state.position?.amountRaw }),
  priceSol: state.phase === "buy" ? band.buyPriceSol : band.sellPriceSol,
  priceKind:"spot", additionalSlippageBps:rangeSlippageBps(band, slippageShareBps) });
const desiredOrder = () => {
  if (sampling.signal.aborted || state.pending || (rangeFile && !rangeFile.valid)) return;
  let band: FixedPriceBand;
  if (spec.kind === "market-cap") {
    const supply = mintSnapshots.get(), usd = usdSnapshots.get();
    if (!supply || !usd) return;
    band = marketCapPrices(spec, supply, usd);
  } else band = spec;
  if (state.phase === "buy" && (state.entryPause || band.entryPaused)) return;
  return orderKey(band);
};
let template: { key: string; order: Awaited<ReturnType<typeof slrd.prepareFastTrade>> } | undefined;
const preparedOrders = new PreparedOrderSlot(desiredOrder, key => m.measure("Prepare limit order in background", async () => {
  if (template?.key === key) {
    try { const order = await template.order.refresh(); template = { key, order }; return order; }
    catch { template = undefined; }
  }
  const order = await slrd.prepareFastTrade(JSON.parse(key), {
    priorityFee: { cuLimit, microLamports: priorityMicroLamports },
    onStage: (stage, durationMs) => m.note(`Preparation stage ${stage}: ${durationMs}ms`),
  });
  template = { key, order }; return order;
}));
const stop = () => { sampling.abort(); priceWake.notify(); };
// A sell that keeps failing on a zero wallet balance means the position left the wallet
// outside this bot (manual sell/transfer). After 3 consecutive confirmations mark it flat and
// pause new buys until the operator resumes; never loop on a sell that cannot exist.
let zeroBalanceMisses = 0;
const preparationFailed = (error: unknown) => {
  const text = String(error);
  if (state.phase === "sell" && state.position && !state.pending && /exceeds token balance 0$/.test(text)) {
    if (++zeroBalanceMisses < 3) return;
    m.note(`POSITION GONE: wallet holds 0 of ${state.position.amountRaw} raw tokens (sold or moved outside this bot). Marked flat; new buys paused until resumed.`);
    state.position = null; state.phase = "buy"; state.health = "EXTERNAL_EXIT";
    state.entryPause = { reason: "EXTERNAL_EXIT", at: new Date().toISOString() };
    zeroBalanceMisses = 0; thresholdHold.reset(); preparedOrders.invalidate(); template = undefined; save();
    return;
  }
  zeroBalanceMisses = 0;
  m.note(`Order preparation unavailable; no slow trigger fallback: ${text}`);
};
if (runtime.control) runtime.control.resumeEntries = () => {
  if (!state.entryPause) return false;
  delete state.entryPause; state.health = "running";
  m.note("Entries resumed by operator"); preparedOrders.invalidate(); template = undefined; save(); priceWake.notify();
  return true;
};
runtime.signal?.addEventListener("abort", stop, { once: true });
async function sampleOnce() {
          const requestedAtMs = Date.now();
          const quote = await m.measure(
            {
              start: () => "Sample price",
              end: q => q
                ? `${fmt(q.priceSol)} SOL · ${q.venue}`
                : "Unavailable",
            },
            async () => samplePriceInSol(await (runtime.samplePrice?.()??slrd.samplePrice(mint)), loadQuoteSol),
          );

          if (!quote) return;

          const price = quote.priceSol;

          if (!Number.isFinite(price) || price <= 0) {
            throw Error("Invalid price");
          }

          // --------------------------------------
          // 3. Record recent price samples
          // --------------------------------------

          const now = Date.now();

          state.prices = state.prices.filter(
            x =>
              Number.isFinite(x.time) &&
              Number.isFinite(x.price) &&
              x.price > 0 &&
              x.time <= now &&
              x.time >= now - windowMs
          );

          const observedAtMs = sampleObservationTime(requestedAtMs, quote.capturedAtMs, now);
          if (now - observedAtMs > interval * 3)
            throw Error(`Price response is stale (${now - observedAtMs}ms); no fresh timestamp assigned`);
          state.prices.push({ time: observedAtMs, price });
          const supplySnapshot = mintSnapshots.get(), usdSnapshot = usdSnapshots.get();
          if (supplySnapshot && usdSnapshot && now - supplySnapshot.atMs < 120_000 && now - usdSnapshot.atMs < 120_000) {
            const capUsd = price * Number(supplySnapshot.supply) / 10 ** supplySnapshot.decimals * usdSnapshot.price;
            if (Number.isFinite(capUsd) && capUsd > 0) state.marketObservation = { capUsd, at: observedAtMs };
          }
          state.prices.sort((a, b) => a.time - b.time);
          const key = desiredOrder();
          const limit = key ? JSON.parse(key).priceSol : undefined;
          const eligible = limit != null && (state.phase === "buy" ? price <= Number(limit) : price >= Number(limit));
          thresholdHold.observe(eligible ? key : undefined, observedAtMs, now);
          priceWake.notify();

          // State file only. The journal + trade CSV are published on real events (trades, range
          // changes); appending full state on every sample grew bot-history to GBs at ~100 MB/s.
          save(false);

}
try {
  try { slrd.resolveToken(mint); }
  catch (error) { if ((error as {code?: string}).code !== "UNKNOWN_TOKEN") throw error; await m.measure("Register token", () => slrd.addToken(mint)); }
  const rangeChanged = (next: RangeSpec | null, error?: string) => {
    thresholdHold.reset(); preparedOrders.invalidate(); template = undefined;
    if (next) { spec = next; state.rangeSpec = next; if(next.kind === "fixed") fixed = next; state.strategy = next.kind === "fixed" ? next : undefined; state.health = "running"; m.note(`Range updated: ${JSON.stringify(next)}`); }
    else { state.health = "INVALID_RANGE_FILE"; m.note(`Range file invalid; new decisions paused: ${error}`); }
    save();
  };
  if (runtime.ranges) rangeFile = runtime.ranges.subscribe(wallet, mint, rangeChanged);
  else if (configPath) rangeFile = watchRangeFile(configPath, rangeChanged, parseConfig);
  // Close the load/watch race before making any decision.
  if (rangeFile) { rangeFile.refresh(); spec = rangeFile.current; state.rangeSpec = spec; if(spec.kind === "fixed") fixed = spec; state.strategy = spec.kind === "fixed" ? spec : undefined; }
  sampler = runIndependentSampler({intervalMs: interval, signal: sampling.signal, sample: sampleOnce,
    onError: error => { thresholdHold.reset(); m.note(`Price sampling error: ${String(error)}`); }});
  if (!runtime.sharedBlockhashWarmer) blockhashWarmer = slrd.warmBlockhash({ intervalMs: 1000 });
  preparation = runIndependentSampler({ intervalMs: runtime.preparationIntervalMs ?? 2000, signal: sampling.signal,
    sample: async () => { await preparedOrders.refresh(); zeroBalanceMisses = 0; priceWake.notify(); },
    onError: preparationFailed });
  while (!runtime.signal?.aborted) {
    const tickStartedAt = Date.now();
    let decisionSampleVersion = priceWake.version;
    try {
      await m.measure(
        {
          start: () => `Tick · ${state.phase.toUpperCase()}`,
          end: () => `Phase ${state.phase.toUpperCase()}`,
        },
        async () => {
          // --------------------------------------
          // 1. Reconcile previous trade
          // --------------------------------------

          if (state.pending) {
            const pending = state.pending;

            const result = await m.measure(
              {
                start: () => `Reconcile ${pending.side}`,
                end: r => describeResult(r),
              },
              () => slrd.resumeTrade(pending.key),
            );

            if (!result || result.status === "unresolved") {
              m.note("Waiting for transaction resolution");
              return;
            }

            if (result.status === "confirmed") {
              if (result.targetTokenDeltaRaw == null || result.solPrincipalDeltaLamports == null) {
                m.note("Trade confirmed; waiting for original transaction fill accounting. No replacement trade.");
                return;
              }
              if (pending.side === "buy") {
                const received = BigInt(result.targetTokenDeltaRaw);
                const spent = -BigInt(result.solPrincipalDeltaLamports);
                const fee = BigInt(result.networkFeeLamports ?? 0);

                if (received <= 0n || spent <= 0n) {
                  throw Error("Invalid confirmed buy");
                }

                state.position = {
                  amountRaw: received.toString(),
                  costLamports: (spent + fee).toString(),
                };
                state.phase = "sell";

                m.note(
                  `BUY confirmed | spent=${Number(spent + fee) / 1e9} SOL`
                );
              } else {
                if (!state.position) throw Error("Missing position");

                const sold = -BigInt(result.targetTokenDeltaRaw);

                if (sold !== BigInt(state.position.amountRaw)) {
                  throw Error("Sell mismatch; manual reconciliation required");
                }

                const received = BigInt(result.solPrincipalDeltaLamports);
                const fee = BigInt(result.networkFeeLamports ?? 0);
                const pnl =
                  received - fee - BigInt(state.position.costLamports);

                m.note(
                  `SELL confirmed | PnL=${Number(pnl) / 1e9} SOL`
                );

                state.position = null;
                state.phase = "buy";
              }
            } else if (result.status === "failed") {
              m.note(`${pending.side.toUpperCase()} failed | ${describeResult(result)}`);
            } else {
              m.note(`Unrecognized status: ${result.status}`);
              return;
            }

            state.pending = null;
            save();
          }

          // --------------------------------------
          // 2. Sample market price
          // --------------------------------------

          const now = Date.now();
          // Re-read on decision as a fallback for dropped filesystem notifications.
          rangeFile?.refresh();
          if (rangeFile && !rangeFile.valid) { m.note("Waiting for a valid range file"); return; }
          const requestedRange = spec;
          if (requestedRange.kind === "market-cap") {
            const mintSnapshot = mintSnapshots.get(), usd = usdSnapshots.get();
            if (!mintSnapshot || !usd) { m.note("Waiting for fresh supply and SOL/USD metadata; refresh runs outside the decision loop"); return; }
            if (spec !== requestedRange || (rangeFile && !rangeFile.valid)) return;
            fixed = marketCapPrices(requestedRange, mintSnapshot, usd);
            state.strategy = fixed;
            m.note(`USD market-cap range: buy<=${requestedRange.buyMarketCapUsd}, sell>=${requestedRange.sellMarketCapUsd}; SOL/USD=${usd.price}`);
          } else fixed = requestedRange;
          const band = fixed; // Immutable limits for this decision, even during a watched edit.
          if (state.phase === "buy" && state.entryPause) {
            m.note(`NEW BUYS PAUSED: ${state.entryPause.reason}; explicit resume required`);
            return;
          }
          if (state.phase === "buy" && band.entryPaused) {
            m.note("NEW BUYS PAUSED: sell floor is at/below buy ceiling. Existing positions may exit; set a non-overlapping range to resume entries.");
            return;
          }
          const latest = state.prices.at(-1);
          decisionSampleVersion = priceWake.version;
          if (!latest || Date.now() - latest.time > interval * 3) { m.note("Waiting for fresh independent price sample"); return; }
          const price = latest.price;

          const buyAt = Number(band.buyPriceSol);
          const sellAt = Number(band.sellPriceSol);
          if (requestedRange.kind === "market-cap") m.note(`Sample market cap $${(Number(requestedRange.buyMarketCapUsd) * price / buyAt).toFixed(2)} | age=${Date.now() - latest.time}ms`);
          m.note(`FIXED RANGE | price=${fmt(price)} | buy<=${band.buyPriceSol} | sell>=${band.sellPriceSol} SOL/token`);

          // --------------------------------------
          // 4. Two-phase trading decision
          // --------------------------------------

          const side = fixedPriceSignal(state.phase, price, band, !!state.entryPause);
          if (!side) {
            thresholdHold.reset();
            m.note(`WAIT ${state.phase.toUpperCase()} | target=${state.phase === "buy" ? band.buyPriceSol : band.sellPriceSol} SOL/token`);
            return;
          }

          // --------------------------------------
          // 5. Execute with Solard
          // --------------------------------------

          if (runtime.signal?.aborted) return;
          if (!thresholdHold.ready(orderKey(band), Date.now())) {
            m.note(`Waiting for ${thresholdHold.holdMs}ms of fresh qualifying price observations`); return;
          }
          const prepared = preparedOrders.take(orderKey(band));
          if (!prepared) { m.note("Trigger reached; waiting for a fresh prepared order with these exact limits"); return; }
          template = undefined;
          thresholdHold.reset();
          const triggeredAt = performance.now();
          const key =
            `range:${wallet}:${mint}:${state.orderScope}:${++state.sequence}:${side}`;

          state.pending = { key, side, buyPriceSol: band.buyPriceSol, sellPriceSol: band.sellPriceSol };
          save(false); // Persist crash recovery now; CSV/report generation follows submission.

          m.note(
            side === "buy"
              ? `BUY signal | ${amount} SOL | spot<=${fmt(buyAt)} SOL/token | extra=${rangeSlippageBps(band,slippageShareBps)}bps`
              : `SELL signal | spot>=${fmt(sellAt)} SOL/token | extra=${rangeSlippageBps(band,slippageShareBps)}bps`
          );

          const result = await m.measure(
            {
              start: () => `Execute ${side.toUpperCase()}`,
              end: r => describeResult(r),
            },
            () => prepared.execute({ intentKey: key, signal: runtime.signal,
              onStage: (stage, durationMs) => m.note(`Trade stage ${stage}: ${durationMs}ms`),
              onSubmitted: signature => m.note(`Broadcast submitted ${signature} | trigger-to-submit=${Math.round(performance.now() - triggeredAt)}ms`),
            })
          );

          state.lastResult = result;
          state.health = result?.code === "INSUFFICIENT_TOKEN_BALANCE" ? "BALANCE_MISMATCH" : "running";
          save();
          if (result?.status === "failed" && result.phase === "before-submission" && result.attempts.length === 0) { state.pending = null; save(); }
          // Always reconcile before changing the position.
          m.note(
            `Trade request ${key} | ${describeResult(result)}`
          );
        },
      );
    } catch (error) {
      const known = (error as { tradeResult?: { status?: string; phase?: string; attempts?: unknown[] } })?.tradeResult;
      if (known?.status === "failed" && known.phase === "before-submission" && known.attempts?.length === 0) { state.pending = null; save(); }
      m.note(`Tick error: ${String(error)}`);
      // Never discard an uncertain trade intent.
    }

    const delay = interval - (Date.now() - tickStartedAt);
    await priceWake.after(decisionSampleVersion, Math.max(1, delay));
  }
} finally {
  mintSnapshots.close(); usdSnapshots.close();
  rangeFile?.close();
  sampling.abort();
  preparedOrders.invalidate(); blockhashWarmer?.stop();
  await preparation;
  await sampler;
  runtime.signal?.removeEventListener("abort", stop);
  if (!runtime.client) slrd.close();
  // Only remove the lock when this process owns it. Read it fresh: the Bun.file handle above was
  // created before the lock existed, and reading through it returned "" so locks were never removed.
  const { readFileSync: readNow, unlinkSync } = await import("node:fs");
  let owner = "";
  try { owner = readNow(lockPath, "utf8").trim(); } catch {}
  if (owner === String(process.pid)) unlinkSync(lockPath);
}

}

if (import.meta.main) await runRangeBot();
