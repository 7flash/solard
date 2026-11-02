import { expect, test } from "bun:test";
import { PublicKey, type Logs, type Context } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { subscribeTrades, subscribeLaunches, subscribeMigrations, type TradeEvent, type LaunchEvent, type MigrationEvent } from "../market/launch-trades.ts";
import { subscribeTokenEvents, type SolardTokenEvent } from "./token-events.ts";
import { fixtureConnection } from "../venues/meteora/fixtures/connection.ts";
import { PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID } from "../venues/pump/constants.ts";
import { bondingCurvePda } from "../venues/pump/pda.ts";
import { PUMP_CURVE_DISCRIMINATOR } from "../venues/pump/state.ts";
import { address, portalBlock, portalFixture, until } from "./fixtures/portal.ts";
import type { TokenRow } from "../db/schema.ts";
import { liveTradeHistoryRow } from "../market/live-trade-history.ts";

const u64 = (value: bigint) => { const out = Buffer.alloc(8); out.writeBigUInt64LE(value); return out; };
const text = (value: string) => { const data = Buffer.from(value); const length = Buffer.alloc(4); length.writeUInt32LE(data.length); return Buffer.concat([length, data]); };
const mint = address(30), quote = address(35);
const now = () => u64(BigInt(Math.floor(Date.now() / 1000)));

function mintAccount() {
  const data = Buffer.alloc(82); data.writeBigUInt64LE(1_000_000_000_000_000n, 36); data[44] = 6; data[45] = 1;
  return { data, owner: TOKEN_2022_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 };
}
function customTrade() {
  return Buffer.concat([
    Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]), mint.toBuffer(), u64(101n), u64(202n), Buffer.from([1]), address(31).toBuffer(), now(), u64(303n), u64(404n),
    u64(505n), u64(606n), address(32).toBuffer(), u64(1n), u64(2n), address(33).toBuffer(), u64(3n), u64(4n), Buffer.from([1]),
    u64(5n), u64(6n), u64(7n), u64(8n), text("buy"), Buffer.from([0]), u64(9n), u64(10n), u64(11n), u64(12n), Buffer.alloc(4),
    quote.toBuffer(), u64(707n), u64(808n), u64(909n), u64(13n), u64(14n),
  ]);
}
function rpcLogs(signature: string, program: PublicKey, bytes: Buffer): Logs {
  return { signature, err: null, logs: [`Program ${program} invoke [1]`, `Program data: ${bytes.toString("base64")}`, `Program ${program} success`] };
}

test("RPC and default SQD emit identical custom-quote prices and actual supply without parsed transaction enrichment", async () => {
  const results: TradeEvent[] = [];
  const data = customTrade();
  for (const source of ["rpc", "sqd"] as const) {
    const { connection, accounts, callbacks } = fixtureConnection();
    accounts.set(mint.toBase58(), mintAccount());
    accounts.set(quote.toBase58(), { ...mintAccount(), data: Buffer.from(mintAccount().data) });
    accounts.get(quote.toBase58())!.data[44] = 8;
    const curve = Buffer.alloc(115); PUMP_CURVE_DISCRIMINATOR.copy(curve); quote.toBuffer().copy(curve, 83);
    accounts.set(bondingCurvePda(mint).toBase58(), { data: curve, owner: PUMP_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 });
    let enrichment = 0;
    connection.getParsedTransaction = async () => { enrichment++; throw new Error("Unavailable parsed transaction"); };
    const block = portalBlock(10, [mint.toBase58(), PUMP_PROGRAM_ID.toBase58()], [{ program: PUMP_PROGRAM_ID.toBase58(), bytes: data }], "same-trade");
    block.logs[0]!.logIndex = 4;
    const portal = portalFixture([block]);
    const sub = await subscribeTrades({ connection, ...(source === "rpc" ? { source } : {}), sqd: { fetch: portal.fetcher }, tokens: [mint.toBase58()],
      venues: ["pump"], solUsd: 100, quoteSol: async () => 0.01, onTrade: event => { results.push(event); } });
    try {
      if (source === "rpc") {
        const event = rpcLogs("same-trade", PUMP_PROGRAM_ID, data);
        event.logs.unshift(`Program ${address(60)} invoke [1]`, "Program data: AQID", `Program ${address(60)} success`);
        callbacks[0]!(event, { slot: 10 });
      }
      await until(() => results.length === (source === "rpc" ? 1 : 2));
      expect(enrichment).toBe(0);
      expect(sub.listTokens()).toEqual([mint.toBase58()]);
      await sub.removeTokens(mint.toBase58()); expect(sub.hasToken(mint.toBase58())).toBe(false);
      await sub.addTokens(mint.toBase58()); expect(sub.hasToken(mint.toBase58())).toBe(true);
    } finally { await sub.close(); }
  }
  expect(results[0]!.eventSource).toBe("rpc"); expect(results[1]!.eventSource).toBe("sqd");
  const { eventSource: _rpc, eventIndex: _rpcOrdinal, ...rpc } = results[0]!;
  const { eventSource: _sqd, eventIndex: _sqdOrdinal, ...sqd } = results[1]!;
  expect(results.map(event => event.logIndex)).toEqual([4, 4]);
  expect(results.map(event => event.eventIndex)).toEqual([1, 0]);
  expect(liveTradeHistoryRow(results[0]!)!.eventKey).toBe(liveTradeHistoryRow(results[1]!)!.eventKey);
  const { solUsdAtMs: _rpcAt, ...rpcMarket } = rpc.market;
  const { solUsdAtMs: _sqdAt, ...sqdMarket } = sqd.market;
  expect({ ...sqd, market: sqdMarket }).toEqual({ ...rpc, market: rpcMarket });
  expect(sqd.market.quoteMint).toBe(quote.toBase58()); expect(sqd.market.quoteDecimals).toBe(8);
  expect(sqd.market.supplyRaw).toBe(1_000_000_000_000_000n); expect(sqd.market.priceSol).toBeGreaterThan(0);
});

test("launch and canonical migration share decoders and preserve identical event identity across transports", async () => {
  const launch = Buffer.concat([Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]), text("Test"), text("TEST"), text("https://example.test/token"),
    mint.toBuffer(), address(31).toBuffer(), address(32).toBuffer(), address(33).toBuffer(), now(), u64(1n), u64(2n), u64(3n), u64(1_000_000_000_000_000n), address(34).toBuffer(), Buffer.from([0, 0]), quote.toBuffer()]);
  const creator = PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), mint.toBuffer()], PUMP_PROGRAM_ID)[0];
  const migration = Buffer.concat([Buffer.from([177, 49, 12, 210, 160, 118, 167, 116]), now(), Buffer.alloc(2), creator.toBuffer(), mint.toBuffer(), quote.toBuffer(),
    Buffer.from([6, 8]), ...Array.from({ length: 7 }, () => u64(1n)), Buffer.from([1]), address(40).toBuffer()]);
  const launches: LaunchEvent[] = [], migrations: MigrationEvent[] = [];
  for (const source of ["rpc", "sqd"] as const) {
    for (const type of ["launch", "migration"] as const) {
      const { connection, callbacks } = fixtureConnection();
      const program = type === "launch" ? PUMP_PROGRAM_ID : PUMP_AMM_PROGRAM_ID;
      const bytes = type === "launch" ? launch : migration;
      const portal = portalFixture([portalBlock(10, [mint.toBase58(), program.toBase58()], [{ program: program.toBase58(), bytes }], type)]);
      const common = { connection, source, venues: ["pump"] as const, sqd: { fetch: portal.fetcher }, metadata: false as const };
      const sub = type === "launch" ? await subscribeLaunches({ ...common, onLaunch: event => { launches.push(event); } })
        : await subscribeMigrations({ ...common, tokens: [mint.toBase58()], onMigration: event => { migrations.push(event); } });
      try {
        if (source === "rpc") callbacks[0]!(rpcLogs(type, program, bytes), { slot: 10 });
        await until(() => (type === "launch" ? launches : migrations).length === (source === "rpc" ? 1 : 2));
        if (source === "sqd") {
          const query = portal.requests.find(row => row.query)!.query!;
          expect(query.instructions[0].programId).toEqual([program.toBase58()]);
          expect(query.instructions[0].d8.length).toBeGreaterThan(0);
        }
      } finally { await sub.close(); }
    }
  }
  for (const events of [launches, migrations]) {
    const { eventSource: _a, ...a } = events[0]!; const { eventSource: _b, ...b } = events[1]!;
    expect(b).toEqual(a);
  }
});

test("typed token events use the same finalized transfer reducer with SQD or RPC delivery", async () => {
  const collected: SolardTokenEvent[][] = [];
  for (const source of ["rpc", "sqd"] as const) {
    const { connection, accounts, callbacks } = fixtureConnection(); accounts.set(mint.toBase58(), mintAccount());
    const from = address(51), to = address(52), sender = address(53), recipient = address(54);
    const balance = (index: number, owner: PublicKey, amount: string) => ({ accountIndex: index, owner: owner.toBase58(), mint: mint.toBase58(),
      uiTokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: amount } });
    connection.getParsedTransaction = async () => ({ slot: 10, blockTime: Math.floor(Date.now() / 1000), transaction: {
      signatures: ["transfer"], message: { recentBlockhash: PublicKey.default.toBase58(), accountKeys: [from, to].map(pubkey => ({ pubkey, signer: false, writable: true })),
        instructions: [{ programId: TOKEN_2022_PROGRAM_ID, program: "spl-token", parsed: { type: "transferChecked", info: { source: from.toBase58(), destination: to.toBase58(),
          mint: mint.toBase58(), authority: sender.toBase58(), tokenAmount: { amount: "25", decimals: 6 } } } }] } },
      meta: { err: null, fee: 5000, preBalances: [0, 0], postBalances: [0, 0], preTokenBalances: [balance(0, sender, "100"), balance(1, recipient, "0")],
        postTokenBalances: [balance(0, sender, "75"), balance(1, recipient, "25")], logMessages: [], innerInstructions: [] },
    });
    const portal = portalFixture([portalBlock(10, [mint.toBase58()], [], "transfer")]);
    const sub = await subscribeTokenEvents({ connection, token: { mint: mint.toBase58() } as TokenRow,
      options: { source, sqd: { fetch: portal.fetcher }, swaps: false, commitment: "finalized" } });
    try {
      if (source === "rpc") callbacks[0]!({ err: null, logs: [], signature: "transfer" }, { slot: 10 });
      const event = await Promise.race([sub[Symbol.asyncIterator]().next(), Bun.sleep(1500).then(() => { throw new Error("Missing transfer"); })]);
      expect(event.done).toBe(false);
      collected.push([event.value!]);
      expect(event.value!.confidence).toBe("finalized");
      expect(event.value!.type).toBe("transfer");
    } finally { await sub.close(); }
  }
  const { eventSource: _a, observedAtMs: _atA, ...a } = collected[0]![0]!;
  const { eventSource: _b, observedAtMs: _atB, ...b } = collected[1]![0]!;
  expect(b).toEqual(a);
});
