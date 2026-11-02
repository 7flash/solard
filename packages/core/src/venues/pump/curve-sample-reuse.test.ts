import { expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PumpCurveVenue } from "./pump-curve-venue.ts";
import { PUMP_CURVE_DISCRIMINATOR } from "./state.ts";
import { PUMP_PROGRAM_ID } from "./constants.ts";
import { defaultPumpQuoteShell } from "./common.ts";

function fixture() {
  let reads = 0, now = 1000;
  const data = Buffer.alloc(115); PUMP_CURVE_DISCRIMINATOR.copy(data);
  data.writeBigUInt64LE(1_000_000_000_000_000n, 8);
  data.writeBigUInt64LE(30_000_000_000n, 16);
  data.writeBigUInt64LE(700_000_000_000_000n, 24);
  data.writeBigUInt64LE(1_000_000_000n, 32);
  data.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  Keypair.generate().publicKey.toBuffer().copy(data, 49);
  const connection = { getAccountInfo: async () => { reads++; return { owner: PUMP_PROGRAM_ID, data }; } } as any;
  const token = { ...defaultPumpQuoteShell(Keypair.generate().publicKey), decimals: 6, venueHint: "pump-curve" as const };
  const ctx = { connection, token, user: PublicKey.default };
  return { venue: new PumpCurveVenue(() => now), ctx, data, reads: () => reads, time: (next: number) => { now = next; } };
}

test('completed curve inspection cannot register an unverified canonical pool',async()=>{
 const f=fixture();f.data[48]=1;
 expect(await f.venue.inspectToken(f.ctx.connection,new PublicKey(f.ctx.token.mint))).toBeNull();
 expect(f.reads()).toBe(1);
});

test("sample and immediate trade reuse complete verified curve state without another reserve RPC", async () => {
  const f = fixture();
  const sampledMarket = (await f.venue.resolveMarket(f.ctx))!;
  const sample = await f.venue.price(f.ctx, sampledMarket);
  f.time(1500);
  const tradeMarket = (await f.venue.resolveMarket(f.ctx))!;
  const quoted = await f.venue.quoteSell(f.ctx, tradeMarket, 1_000_000_000n, 0);
  expect(f.reads()).toBe(1);
  expect(sample.baseReserveRaw).toBe((tradeMarket.metadata.curve as any).virtualBase);
  expect(quoted.minimumOutputRaw).toBe(quoted.expectedOutputRaw);
  expect(quoted.minimumOutputRaw).toBeGreaterThan(0n);
  // Reuse at 500ms must not extend the original read's one-second lifetime.
  f.time(2000);
  const fresh = (await f.venue.resolveMarket(f.ctx))!;
  expect(f.reads()).toBe(2);
  expect(await f.venue.quoteSell(f.ctx, fresh, 1_000_000_000n, 0)).toEqual(quoted);
});

test("metadata changes, migration and separate connections cannot inherit a cached curve", async () => {
  const f = fixture();
  await f.venue.resolveMarket(f.ctx);
  await f.venue.resolveMarket({ ...f.ctx, token: { ...f.ctx.token, metadataJson: '{"feeBps":200}' } });
  expect(f.reads()).toBe(2);
  await f.venue.resolveMarket({ ...f.ctx, connection: { getAccountInfo: f.ctx.connection.getAccountInfo } as any });
  expect(f.reads()).toBe(3);
  expect(await f.venue.resolveMarket({ ...f.ctx, token: { ...f.ctx.token, pool: Keypair.generate().publicKey.toBase58() } })).toBeNull();
  f.data[48] = 1; f.time(2001);
  expect(await f.venue.resolveMarket(f.ctx)).toBeNull();
  expect(f.reads()).toBe(4);
});
