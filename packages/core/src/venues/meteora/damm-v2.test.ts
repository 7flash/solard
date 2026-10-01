import { expect, test } from "bun:test";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { fixtureConnection } from "./fixtures/connection.ts";
import { dammV2Client, readDammV2Market, dammV2Price, MeteoraDammV2Venue, CP_AMM_PROGRAM_ID } from "./damm-v2.ts";
import { decodeDammV2Trade } from "./damm-v2-events.ts";
import { subscribeTrades, type TradeEvent } from "../../market/launch-trades.ts";
import type { TokenRow } from "../../db/schema.ts";
import { sol } from "../../core/amounts.ts";
import { verifyPoolTokenMetadata } from "../pump/token-metadata.ts";

const POOL = new PublicKey("4CmPy9CYhVpTTEE1dWLt4ezHgn8Y3niJj9CtUQkDLstb");
const MINT = new PublicKey("3QEbHMK6ceYevtaCdLmBQMJgcPb9PJQpgyFBP6f6x6Rg");
test("current THICC DAMM v2 builds SDK exact-in buy and sell with quote identity and protected minima", async () => {
  const { connection } = fixtureConnection();
  const venue = new MeteoraDammV2Venue();
  const discovered = await venue.inspectToken(connection, MINT);
  expect(discovered?.venueHint).toBe("meteora-damm-v2");
  expect(discovered?.quoteMint).toBe("So11111111111111111111111111111111111111112");
  const token = { ...discovered, mint: MINT.toBase58(), pool: POOL.toBase58() } as TokenRow;
  const ctx = { connection, token, user: new PublicKey("4jxDfXDLRh3fJvQxPhuV5uMt4YLEsaM6QNYFuMddbCen") };
  const market = await venue.resolveMarket(ctx);
  expect(market).not.toBeNull();
  const quote = await venue.quoteBuy(ctx, market!, sol(0.001), 500);
  const built = await venue.buildBuy(ctx, market!, quote);
  const swap = built.instructions.find((instruction) => instruction.programId.equals(CP_AMM_PROGRAM_ID))!;
  const coder = dammV2Client(connection)._program.coder.instruction as unknown as { decode(data: Buffer): { name: string; data: { params: { amount0: BN; amount1: BN; swapMode: number } } } };
  const decoded = coder.decode(swap.data);
  expect(decoded.name).toBe("swap2");
  expect(decoded.data.params.amount0.toString()).toBe("1000000");
  expect(decoded.data.params.amount1.toString()).toBe(quote.minimumOutputRaw.toString());
  expect(decoded.data.params.swapMode).toBe(0);
  const sell = await venue.quoteSell(ctx, market!, 1_000_000_000n, 500);
  const sold = await venue.buildSell(ctx, market!, sell);
  expect(sold.instructions.some((instruction) => instruction.programId.equals(CP_AMM_PROGRAM_ID))).toBe(true);
  expect(sold.minOutputRaw).toBeGreaterThan(0n);
  const verified = await verifyPoolTokenMetadata(connection, { ...token, quoteMint: PublicKey.default.toBase58() });
  expect(verified.quoteMint).toBe("So11111111111111111111111111111111111111112");
});

test("DAMM v2 event identity, side and marginal price work for either watched mint", async () => {
  const { connection, callbacks } = fixtureConnection();
  const market = await readDammV2Market(connection, POOL);
  const program = dammV2Client(connection)._program;
  const event = {
    pool: POOL, tradeDirection: 1, collectFeeMode: 0, hasReferral: false,
    params: { amount0: new BN(1_000_000), amount1: new BN(1), swapMode: 0 },
    swapResult: { includedFeeInputAmount: new BN(1_000_000), excludedFeeInputAmount: new BN(990_000), amountLeft: new BN(0),
      outputAmount: new BN(10_000_000), nextSqrtPrice: market.state.sqrtPrice,
      claimingFee: new BN(10_000), compoundingFee: new BN(0), protocolFee: new BN(0), referralFee: new BN(0) },
    includedTransferFeeAmountIn: new BN(1_000_000), includedTransferFeeAmountOut: new BN(10_000_000), excludedTransferFeeAmountOut: new BN(10_000_000),
    currentTimestamp: new BN(1_790_000_000), reserveAAmount: new BN(market.reserveA.toString()), reserveBAmount: new BN(market.reserveB.toString()),
  };
  const data = Buffer.concat([Buffer.from(program.idl.events!.find((entry) => entry.name === "evtSwap2")!.discriminator), program.coder.types.encode("evtSwap2", event)]);
  expect(decodeDammV2Trade(connection, data)?.aToB).toBe(false);
  const trades: Array<TradeEvent> = [];
  const subscription = await subscribeTrades({ connection, tokens: [MINT.toBase58(), PublicKey.default.toBase58()], venues: ["meteora-damm-v2"], solUsd: 100,
    onTrade(event) { trades.push(event); } });
  const logs = { err: null, signature: "damm-v2", logs: [`Program ${CP_AMM_PROGRAM_ID} invoke [1]`, `Program data: ${data.toString("base64")}`, `Program ${CP_AMM_PROGRAM_ID} success`] };
  callbacks[0]!(logs, { slot: 1 }); callbacks[1]!(logs, { slot: 1 });
  await Bun.sleep(40);
  expect(trades).toHaveLength(1);
  expect(trades[0]!.side).toBe("buy");
  expect(trades[0]!.market.priceSol).toBeCloseTo(dammV2Price(market, MINT), 12);
  expect(dammV2Price(market, market.state.tokenBMint) * dammV2Price(market, MINT)).toBeCloseTo(1, 12);
  expect(trades[0]!.market.marketCapUsd).toBeCloseTo(trades[0]!.market.priceUsd! * trades[0]!.market.supply, 6);
  await subscription.close();
});
