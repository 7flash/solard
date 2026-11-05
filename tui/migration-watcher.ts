/** Opens a target bot on every fresh pump.fun / LaunchLab migration (SOL-quoted), inside slrd-bots.
 * Range: top slightly above the market cap at migration, bottom well below it, so the bot buys the
 * post-migration dips and sells the recovery. Sized small and capped; the dead-coin rule cleans up rugs.
 * Env: SLRD_AUTO_MIGRATIONS=0 disables; SLRD_AUTO_WALLET (default: first bot's wallet), SLRD_AUTO_BUDGET (0.02),
 * SLRD_AUTO_MAX (30 open at once), SLRD_AUTO_TOP (1.2: first buy lands ~3% under the migration cap), SLRD_AUTO_BOTTOM (0.5), SLRD_AUTO_STEPS (3). */
import { existsSync, writeFileSync } from "node:fs";
import { staleRange } from "./recenter.ts";
import { resolve } from "node:path";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { Solard } from "../packages/sdk/src/client.ts";
import { getSolUsdPrice, subscribeMigrations, type MigrationEvent } from "../packages/core/src/market/launch-trades.ts";
import { samplePriceInSol } from "../packages/core/src/market/sample-price-sol.ts";
import { addBot, readRegistry, removeBot, updateBot } from "./bot-registry.ts";
import { globalFeesPaid } from "./token-fees.ts";
import { coinLaunchMs, replayCoin } from "./coin-replay.ts";
import type { TradeEvent } from "../packages/core/src/market/launch-trades.ts";

const SOL = "So11111111111111111111111111111111111111112";
export type Decision = { atMs: number; mint: string; name: string; decision: "opened" | "skipped" | "dropped" | "buys-on" | "failed"; reason: string };
/** Recent migration decisions, newest first (for the Discovery view). */
export const decisions: Decision[] = [];
export const decide = (d: Omit<Decision, "atMs">) => { decisions.unshift({ atMs: Date.now(), ...d }); if (decisions.length > 200) decisions.length = 200; };
const env = (k: string, d: number) => Number(process.env[k] ?? d);

export async function startMigrationWatcher(o: { root: string; client: Solard; connection: Connection; log: (t: string) => void;
  /** Market cap after migration from the firehose (PumpSwap trades); avoids reading the emptied curve. */
  capFor?: (mint: string) => number | null | undefined;
  /** Firehose activity since launch (null when the firehose did not see the coin from launch). */
  activityFor?: (mint: string) => { traders: number; volSol: number; fromLaunch: boolean } | null;
  /** false: no own SQD stream; migrations are fed through the returned `migrate` (from the firehose). */
  /** Ticker seen at launch by the firehose (migration metadata is often missing). */
  symbolFor?: (mint: string) => string | null | undefined;
  stream?: boolean;
  /** Entry checks (tui/entry-guard.ts): a reason to skip, or null. */
  guard?: (mint: string, stepSol: number) => Promise<string | null>;
  /** Every trade from each migrated coin's replayed history (wallet scoring). */
  onHistoryTrade?: (e: TradeEvent) => void }) {
  if (process.env.SLRD_AUTO_MIGRATIONS === "0") { o.log("migration watcher disabled (SLRD_AUTO_MIGRATIONS=0)"); return null; }
  const budget = process.env.SLRD_AUTO_BUDGET ?? "0.05", max = env("SLRD_MAX_POSITIONS", 100);
  const top = env("SLRD_AUTO_TOP", 1.2), bottom = env("SLRD_AUTO_BOTTOM", 0.5), steps = env("SLRD_AUTO_STEPS", 3);
  const wallet = () => process.env.SLRD_AUTO_WALLET ?? readRegistry(o.root)[0]?.wallet;
  const handling = new Set<string>();
  const nameOf = (mint: string, meta?: string | null) => meta || o.symbolFor?.(mint) || mint.slice(0, 6);
  // Replay every migrated coin's history, one at a time: who got into the coins that ran, and when.
  let replayQueue: Promise<void> = Promise.resolve(); let replays = 0;
  const replay = (mint: string, name: string) => {
    if (!o.onHistoryTrade) return;
    replayQueue = replayQueue.then(async () => {
      try {
        const r = await replayCoin({ mint, fromMs: (await coinLaunchMs(mint)) - 10 * 60_000, connection: o.connection, onTrade: o.onHistoryTrade!, maxMs: 5 * 60_000 });
        if (++replays % 10 === 1 || !r.caughtUp) o.log(`history ${name}: ${r.trades} trades in ${(r.tookMs / 1000).toFixed(0)}s${r.caughtUp ? "" : " (timed out)"} [${replays} coins replayed]`);
      } catch (error) { o.log(`history ${name}: replay failed: ${error instanceof Error ? error.message.slice(0, 100) : error}`); }
    });
  };
  const minCap = env("SLRD_AUTO_MIN_CAP", 15_000), maxCap = env("SLRD_AUTO_MAX_CAP", 1_500_000);
  const minFees = 0; // replaced by the firehose activity gate below
  const minTraders = env("SLRD_AUTO_MIN_TRADERS", 150);
  /** Axiom-style global fees (network + priority + Jito tips) since launch; under minFees -> drop the coin. */
  // One fee scan at a time: parallel history scans got the whole daemon rate-limited by the SQD portal (429).
  let feeQueue: Promise<void> = Promise.resolve();
  const checkFees = (w: string, mint: string, name: string) => { feeQueue = feeQueue.then(() => checkFeesNow(w, mint, name)); return feeQueue; };
  const checkFeesNow = async (w: string, mint: string, name: string) => {
    try {
      const pairs = ((await (await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`)).json()) as { pairs?: Array<{ pairCreatedAt?: number }> }).pairs ?? [];
      const created = Math.min(...pairs.map(p => p.pairCreatedAt ?? Infinity), Date.now() - 6 * 3600_000);
      const f = await globalFeesPaid(mint, created);
      if (!readRegistry(o.root).some(b => b.mint === mint)) return; // removed meanwhile
      if (f.totalSol >= minFees) { updateBot(o.root, w, mint, { buysPaused: false }); o.log(`AUTO ${name}: fees ${f.totalSol.toFixed(2)} SOL >= ${minFees}, buys on`); decide({ mint, name, decision: "buys-on", reason: `fees+tips ${f.totalSol.toFixed(2)} SOL` }); }
      else { removeBot(o.root, w, mint); o.log(`AUTO ${name}: fees ${f.totalSol.toFixed(2)} SOL < ${minFees}, dropped`); decide({ mint, name, decision: "dropped", reason: `fees+tips ${f.totalSol.toFixed(2)} SOL < ${minFees}` }); }
    } catch (error) { o.log(`AUTO ${name}: fee check failed, buys stay paused: ${error instanceof Error ? error.message.slice(0, 100) : error}`); }
  };

  /** Rejected for low SOL or too few wallets so far: rechecked for 15 min, unless the price already ran 30% past that cap. */
  const waiting = new Map<string, { e: MigrationEvent; cap: number; at: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [mint, w] of waiting) {
      const cap = o.capFor?.(mint) ?? null;
      if (now - w.at > 15 * 60_000 || (cap && cap > w.cap * 1.3)) { waiting.delete(mint); if (cap && cap > w.cap * 1.3) o.log(`migration ${mint.slice(0, 6)}: not rechecked, ran from ${Math.round(w.cap)} to ${Math.round(cap)}`); continue; }
      void open(w.e);
    }
  }, 60_000).unref?.();
  const open = async (e: MigrationEvent) => {
    const w = wallet(), registry = readRegistry(o.root);
    if (!w || registry.some(b => b.mint === e.mint) || handling.has(e.mint)) return;
    const auto = registry.length; // one limit for every position
    if (auto >= max) { o.log(`migration ${e.mint.slice(0, 6)} (${nameOf(e.mint, e.metadata?.symbol)}): skipped, ${auto}/${max} positions open`); decide({ mint: e.mint, name: nameOf(e.mint, e.metadata?.symbol), decision: "skipped", reason: `${auto}/${max} positions open` }); return; }
    handling.add(e.mint);
    try {
      // The new pool can take a few seconds to be readable: retry registration + price for ~1 minute.
      let registered = false, lastError: unknown = null, cap = 0;
      for (const wait of [5_000, 10_000, 15_000, 30_000]) {
        await Bun.sleep(wait);
        try { if (!registered) { await o.client.addToken(e.mint); registered = true; } } catch (error) { lastError = error; continue; }
        const fromFirehose = o.capFor?.(e.mint);
        if (fromFirehose && fromFirehose >= minCap && fromFirehose <= maxCap) { cap = fromFirehose; break; }
        if (fromFirehose) { cap = fromFirehose; break; } // out of range is a real answer (dumped or manipulated): reject below
        {
          try {
            const sample = await o.client.samplePrice(e.mint);
            const { priceSol } = await samplePriceInSol(sample, async () => null);
            const supply = Number((await o.connection.getTokenSupply(new PublicKey(e.mint))).value.uiAmount ?? 0);
            cap = priceSol * supply * (await getSolUsdPrice()).price; break;
          } catch (error) { lastError = error; }
        }
      }
      if (!registered) throw lastError ?? new Error("token registration failed");
      if (!(cap > 0)) throw new Error("no trades on the new pool within a minute");
      if (!(cap >= minCap && cap <= maxCap)) throw new Error(cap < minCap ? `rejected: cap $${(cap / 1000).toFixed(1)}k, dumped at migration` : `rejected: cap $${(cap / 1000).toFixed(0)}k, implausible (manipulated pool)`);
      const round = (v: number) => Math.round(v / 100) * 100;
      const buy = round(cap * bottom), sell = round(cap * top);
      const path = resolve(o.root, "ranges", `${w}-${e.mint}.json`);
      if (staleRange(path, cap)) writeFileSync(path, JSON.stringify({ buyMarketCapUsd: String(buy), sellMarketCapUsd: String(sell), steps }, null, 2) + "\n");
      // Buys stay paused until the fee check passes: no real activity, no trade.
      // Activity gate from the firehose (instant, no SQD query): enough distinct wallets traded it since launch.
      const act = o.activityFor?.(e.mint) ?? null;
      if (act?.fromLaunch && act.traders < minTraders) {
        // A fast coin has few wallets at the instant it migrates (CPU: 95, then 1,536): look again before giving up.
        if (!waiting.has(e.mint)) waiting.set(e.mint, { e, cap, at: Date.now() });
        decide({ mint: e.mint, name: nameOf(e.mint, e.metadata?.symbol), decision: "dropped", reason: `only ${act.traders} wallets traded it since launch (< ${minTraders})` });
        o.log(`migration ${nameOf(e.mint, e.metadata?.symbol)} ${e.mint.slice(0, 6)}: dropped, ${act.traders} wallets since launch < ${minTraders}`); return;
      }
      const veto = await o.guard?.(e.mint, Number(budget) / steps);
      if (veto) {
        if (/SOL low/.test(veto) && !waiting.has(e.mint)) waiting.set(e.mint, { e, cap, at: Date.now() });
        decide({ mint: e.mint, name: nameOf(e.mint, e.metadata?.symbol), decision: "dropped", reason: veto });
        o.log(`migration ${nameOf(e.mint, e.metadata?.symbol)} ${e.mint.slice(0, 6)}: dropped, ${veto}`); return;
      }
      waiting.delete(e.mint);
      addBot(o.root, { wallet: w, mint: e.mint, amount: budget, mode: "target", auto: true });
      o.log(`AUTO migration ${nameOf(e.mint, e.metadata?.symbol)} ${e.mint} -> ${e.destination}: cap $${(cap / 1000).toFixed(1)}k, range ${buy / 1000}-${sell / 1000}k x${steps}, ${budget} SOL`);
      decide({ mint: e.mint, name: nameOf(e.mint, e.metadata?.symbol), decision: "opened", reason: `cap $${(cap / 1000).toFixed(1)}k, range ${buy / 1000}-${sell / 1000}k${act ? `, ${act.traders} wallets${act.fromLaunch ? " since launch" : " seen"}` : ""}` });
    } catch (error) {
      o.log(`migration ${nameOf(e.mint, e.metadata?.symbol)} ${e.mint.slice(0, 6)}: not opened: ${error instanceof Error ? error.message.slice(0, 120) : error}`);
      decide({ mint: e.mint, name: nameOf(e.mint, e.metadata?.symbol), decision: "failed", reason: (error instanceof Error ? error.message : String(error)).slice(0, 120) });
    } finally { handling.delete(e.mint); }
  };

  const migrate = (e: Pick<MigrationEvent, "mint" | "quoteMint" | "pool" | "destination"> & { metadata?: MigrationEvent["metadata"] }) =>
    void open({ metadata: null, ...e } as MigrationEvent);
  if (o.stream === false) { o.log(`migration watcher on (firehose): top ${top}x / bottom ${bottom}x of migration cap, ${steps} steps, ${budget} SOL, max ${max} open`); return { migrate }; }
  const sub = await subscribeMigrations({
    source: "sqd", sqd: { portalUrl: "https://portal.sqd.dev/datasets/solana-mainnet" }, connection: o.connection,
    metadata: false, // not needed to trade; one less RPC call per migration
    onMigration: e => { replay(e.mint, nameOf(e.mint, e.metadata?.symbol)); if (!e.quoteMint || e.quoteMint === SOL) void open(e); else { o.log(`migration ${e.mint.slice(0, 6)}: skipped, quoted in ${e.quoteMint.slice(0, 6)}`); decide({ mint: e.mint, name: nameOf(e.mint, e.metadata?.symbol), decision: "skipped", reason: `quoted in ${e.quoteMint.slice(0, 6)}` }); } },
    onStatus: (event, data) => { if (!/progress|tokens-changed/.test(event)) o.log(`migrations ${event} ${JSON.stringify(data ?? {}).slice(0, 200)}`); },
  } as Parameters<typeof subscribeMigrations>[0]);
  o.log(`migration watcher on: top ${top}x / bottom ${bottom}x of migration cap, ${steps} steps, ${budget} SOL, max ${max} open`);
  return { migrate, sub };
}
