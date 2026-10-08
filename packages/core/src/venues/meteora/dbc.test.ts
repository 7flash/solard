import { expect, test } from "bun:test";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { fixtureConnection } from "./fixtures/connection.ts";
import {
  dbcClient,
  dbcPrice,
  readDbcMarket,
  MeteoraDbcVenue,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
} from "./dbc.ts";
import { decodeDbcTrade, dbcTradesFromTransaction } from "./dbc-events.ts";
import {
  subscribeTrades,
  type TradeEvent,
} from "../../market/launch-trades.ts";
import type { TokenRow } from "../../db/schema.ts";
import { sol } from "../../core/amounts.ts";
import bs58 from "bs58";

const POOL = new PublicKey("8UCus3tg3YUZMjsCsQg9icvQLrKpQXaKxAKCQ5icTkrB");
const MINT = new PublicKey("3QEbHMK6ceYevtaCdLmBQMJgcPb9PJQpgyFBP6f6x6Rg");

function eventData(
  connection: ReturnType<typeof fixtureConnection>["connection"],
  state: Awaited<ReturnType<typeof readDbcMarket>>,
  overrides = {},
) {
  const program = dbcClient(connection).state.getProgram();
  const discriminator = program.idl.events!.find(
    (event) => event.name === "evtSwap2",
  )!.discriminator;
  const data = program.coder.types.encode("evtSwap2", {
    pool: POOL,
    config: state.virtualPool.poolState.config,
    tradeDirection: 1,
    hasReferral: false,
    swapParameters: {
      amount0: new BN(1_000_000),
      amount1: new BN(1),
      swapMode: 0,
    },
    swapResult: {
      includedFeeInputAmount: new BN(1_000_000),
      excludedFeeInputAmount: new BN(990_000),
      amountLeft: new BN(0),
      outputAmount: new BN(10_000_000),
      nextSqrtPrice: state.virtualPool.poolState.sqrtPrice,
      tradingFee: new BN(10_000),
      protocolFee: new BN(0),
      referralFee: new BN(0),
    },
    quoteReserveAmount: new BN(10_000_000),
    migrationThreshold: state.config.migrationQuoteThreshold,
    currentTimestamp: new BN(1_790_000_000),
    ...overrides,
  });
  return Buffer.concat([Buffer.from(discriminator), data]);
}

test("DBC reads real pool/config mint ownership and refuses wrong owners or graduated execution", async () => {
  const { connection, accounts } = fixtureConnection();
  const state = await readDbcMarket(connection, POOL);
  expect(state.virtualPool.poolState.baseMint.equals(MINT)).toBe(true);
  expect(state.baseDecimals).toBe(9);
  expect(state.quoteDecimals).toBe(9);
  expect(state.config.quoteMint.toBase58()).toBe(
    "So11111111111111111111111111111111111111112",
  );
  expect(dbcPrice(state)).toBeGreaterThan(0);
  const venue = new MeteoraDbcVenue();
  expect(await venue.inspectToken(connection, MINT)).toBeNull();
  expect(
    await venue.resolveMarket({
      connection,
      user: PublicKey.default,
      token: {
        mint: MINT.toBase58(),
        venueHint: "meteora-dbc",
        pool: POOL.toBase58(),
      } as TokenRow,
    }),
  ).toBeNull();
  accounts.get(POOL.toBase58())!.owner = PublicKey.default;
  await expect(readDbcMarket(connection, POOL)).rejects.toThrow("owner");
});

test("active DBC quotes and builds both actual SDK swap directions with protected exact inputs", async () => {
  const { connection, accounts, snapshot } = fixtureConnection();
  const state = await readDbcMarket(connection, POOL);
  const poolState = state.virtualPool.poolState;
  poolState.isMigrated = 0;
  poolState.migrationProgress = 0;
  poolState.sqrtPrice = state.config.sqrtStartPrice;
  poolState.quoteReserve = new BN(0);
  poolState.baseReserve = new BN(state.supplyRaw.toString());
  poolState.activationPoint = new BN(snapshot.slot - 100_000);
  poolState.hasSwap = 1;
  // Rewind only the frozen pool state to an active curve; no chain writes.
  accounts.get(POOL.toBase58())!.data = await dbcClient(connection)
    .state.getProgram()
    .coder.accounts.encode("virtualPool", state.virtualPool);
  const venue = new MeteoraDbcVenue();
  const token = {
    mint: MINT.toBase58(),
    venueHint: "meteora-dbc",
    pool: POOL.toBase58(),
  } as TokenRow;
  const ctx = {
    connection,
    token,
    user: new PublicKey("4jxDfXDLRh3fJvQxPhuV5uMt4YLEsaM6QNYFuMddbCen"),
  };
  const market = await venue.resolveMarket(ctx);
  expect(market).not.toBeNull();
  const quote = await venue.quoteBuy(ctx, market!, sol(0.001), 500);
  const built = await venue.buildBuy(ctx, market!, quote);
  expect(quote.inputRaw).toBe(1_000_000n);
  expect(built.minOutputRaw).toBe(quote.minimumOutputRaw);
  expect(quote.minimumOutputRaw).toBeGreaterThan(0n);
  expect(
    built.instructions.some((instruction) =>
      instruction.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID),
    ),
  ).toBe(true);
  poolState.sqrtPrice = new BN(String(quote.meta!.nextSqrtPrice));
  poolState.quoteReserve = new BN(1_000_000);
  poolState.baseReserve = poolState.baseReserve.sub(
    new BN(quote.expectedOutputRaw.toString()),
  );
  accounts.get(POOL.toBase58())!.data = await dbcClient(connection)
    .state.getProgram()
    .coder.accounts.encode("virtualPool", state.virtualPool);
  const sellMarket = await venue.resolveMarket(ctx);
  const sellQuote = await venue.quoteSell(
    ctx,
    sellMarket!,
    quote.expectedOutputRaw / 2n,
    500,
  );
  const sellBuilt = await venue.buildSell(ctx, sellMarket!, sellQuote);
  expect(
    sellBuilt.instructions.some((instruction) =>
      instruction.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID),
    ),
  ).toBe(true);
  expect(sellBuilt.minOutputRaw).toBeGreaterThan(0n);
});

test("DBC decodes event-CPI and listener uses matched pool sqrt price plus verified supply", async () => {
  const { connection, callbacks } = fixtureConnection();
  const state = await readDbcMarket(connection, POOL);
  const data = eventData(connection, state);
  const decoded = decodeDbcTrade(connection, data);
  expect(decoded?.sell).toBe(false);
  expect(decoded?.inputRaw).toBe(1_000_000n);
  const transaction = {
    meta: {
      err: null,
      innerInstructions: [
        {
          instructions: [
            {
              programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
              data: bs58.encode(
                Buffer.concat([Buffer.from("e445a52e51cb9a1d", "hex"), data]),
              ),
              accounts: [],
            },
          ],
        },
      ],
    },
  } as unknown as Parameters<typeof dbcTradesFromTransaction>[1];
  expect(dbcTradesFromTransaction(connection, transaction)).toHaveLength(1);
  connection.getParsedTransaction = async () => transaction;
  const trades: Array<TradeEvent> = [];
  const subscription = await subscribeTrades({
    connection,
    tokens: [MINT.toBase58()],
    venues: ["meteora-dbc"],
    solUsd: 100,
    onTrade(event) {
      trades.push(event);
    },
  });
  callbacks[0]!(
    {
      err: null,
      signature: "dbc-cpi",
      logs: [
        `Program ${DYNAMIC_BONDING_CURVE_PROGRAM_ID} invoke [1]`,
        `Program ${DYNAMIC_BONDING_CURVE_PROGRAM_ID} success`,
      ],
    },
    { slot: 1 },
  );
  await Bun.sleep(30);
  expect(trades).toHaveLength(1);
  expect(trades[0]!.market.supplyRaw).toBe(state.supplyRaw);
  expect(trades[0]!.market.priceSol).toBeCloseTo(dbcPrice(state), 12);
  expect(trades[0]!.market.marketCapUsd).toBeCloseTo(
    ((dbcPrice(state) * Number(state.supplyRaw)) / 10 ** state.baseDecimals) *
      100,
    4,
  );
  callbacks[0]!(
    {
      err: null,
      signature: "dbc-wrong-config",
      logs: [
        `Program ${DYNAMIC_BONDING_CURVE_PROGRAM_ID} invoke [1]`,
        `Program data: ${eventData(connection, state, { config: PublicKey.default }).toString("base64")}`,
        `Program ${DYNAMIC_BONDING_CURVE_PROGRAM_ID} success`,
      ],
    },
    { slot: 2 },
  );
  await Bun.sleep(30);
  expect(trades).toHaveLength(1);
  await subscription.close();
});
