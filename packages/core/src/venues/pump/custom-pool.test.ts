import { expect, test } from "bun:test";
import { Keypair, PublicKey, SystemProgram, type AccountInfo, type Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { pumpAmmJson } from "@pump-fun/pump-swap-sdk";
import type { TokenRow } from "../../db/schema.ts";
import { PumpSwapVenue } from "./pumpswap-venue.ts";
import { PUMP_AMM_PROGRAM_ID } from "./constants.ts";
import { fetchPool } from "./state.ts";
import { verifyPoolTokenMetadata } from "./token-metadata.ts";
import { Solard } from "../../core/solard.ts";
import { PumpCurveVenue } from "./pump-curve-venue.ts";
import { fetchCurve } from "./state.ts";

function fixture() {
  const base = Keypair.generate().publicKey;
  const quote = Keypair.generate().publicKey;
  const pool = Keypair.generate().publicKey;
  const baseVault = Keypair.generate().publicKey;
  const quoteVault = Keypair.generate().publicKey;
  const user = Keypair.generate().publicKey;
  const accounts = new Map<string, AccountInfo<Buffer>>();
  const add = (address: PublicKey, data: Buffer, owner: PublicKey) => {
    accounts.set(address.toBase58(), { data, owner, lamports: 2_000_000, executable: false, rentEpoch: 0 });
  };
  const poolData = Buffer.alloc(261);
  Buffer.from(pumpAmmJson.accounts.find((account) => account.name.toLowerCase() === "pool")!.discriminator).copy(poolData);
  base.toBuffer().copy(poolData, 43);
  quote.toBuffer().copy(poolData, 75);
  baseVault.toBuffer().copy(poolData, 139);
  quoteVault.toBuffer().copy(poolData, 171);
  user.toBuffer().copy(poolData, 211);
  add(pool, poolData, PUMP_AMM_PROGRAM_ID);
  for (const [address, decimals, owner] of [
    [base, 7, TOKEN_PROGRAM_ID], [quote, 8, TOKEN_2022_PROGRAM_ID],
  ] as const) {
    const data = Buffer.alloc(82);
    data.writeBigUInt64LE(1_000_000_000n, 36);
    data[44] = decimals;
    data[45] = 1;
    add(address, data, owner);
  }
  for (const [address, mint, owner, amount] of [
    [baseVault, base, TOKEN_PROGRAM_ID, 200_000_000n],
    [quoteVault, quote, TOKEN_2022_PROGRAM_ID, 1_000_000_000n],
  ] as const) {
    const data = Buffer.alloc(165);
    mint.toBuffer().copy(data);
    user.toBuffer().copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    data[108] = 1;
    add(address, data, owner);
  }
  const queried: Array<string> = [];
  const connection = {
    async getAccountInfo(address: PublicKey) {
      queried.push(address.toBase58());
      return accounts.get(address.toBase58()) ?? null;
    },
  } as unknown as Connection;
  const token = {
    mint: base.toBase58(), pool: pool.toBase58(), venueHint: "pumpswap",
    decimals: 6, quoteMint: quote.toBase58(), quoteTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    metadataJson: JSON.stringify({ protocolFeeRecipient: user.toBase58(), custom: "keep", quoteDecimals: 6 }),
  } as TokenRow;
  return { base, quote, pool, baseVault, accounts, queried, connection, token, user };
}

test("explicit PumpSwap custom pool resolves without a bonding curve using actual mint owners and decimals", async () => {
  const context = fixture();
  const venue = new PumpSwapVenue();
  const market = await venue.resolveMarket(context);
  expect(market).not.toBeNull();
  expect(market!.quoteAsset.decimals).toBe(8);
  expect(market!.quoteAsset.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  expect(market!.metadata.baseDecimals).toBe(7);
  const price = await venue.price(context, market!);
  expect(price.priceQuotePerToken).toBeCloseTo(0.5);
  expect(context.queried.every((address) => context.accounts.has(address))).toBe(true);
});

test("custom pool metadata corrects stale quote program/decimals and preserves unrelated hints", async () => {
  const { connection, token } = fixture();
  const verified = await verifyPoolTokenMetadata(connection, token);
  expect(verified.quoteTokenProgram).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
  expect(JSON.parse(verified.metadataJson!)).toMatchObject({ quoteDecimals: 8, custom: "keep" });
});

test("refresh preserves the configured custom pool when inspection suggests another pool", async () => {
  const { connection, token } = fixture();
  const slrd: Solard = Object.create(Solard.prototype);
  slrd.connection = () => connection;
  slrd.resolveToken = () => token;
  Object.defineProperty(slrd, "venues", { value: { async inspect() {
    return { pool: Keypair.generate().publicKey.toBase58(), venueHint: "pump-curve",
      metadataJson: JSON.stringify({ inspected: true }) };
  } } });
  Object.defineProperty(slrd, "tokens", { value: { upsert(value: TokenRow) { return value; } } });
  const refreshed = await slrd.refreshToken(token.mint);
  expect(refreshed.pool).toBe(token.pool);
  expect(refreshed.venueHint).toBe("pumpswap");
  expect(refreshed.decimals).toBe(7);
  expect(refreshed.quoteTokenProgram).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
  expect(JSON.parse(refreshed.metadataJson!)).toMatchObject({ custom: "keep", inspected: true, quoteDecimals: 8 });
});

test("custom pool rejects wrong program owner and discriminator", async () => {
  const { connection, pool, accounts } = fixture();
  const account = accounts.get(pool.toBase58())!;
  account.owner = SystemProgram.programId;
  await expect(fetchPool(connection, pool)).rejects.toThrow("unexpected program owner");
  account.owner = PUMP_AMM_PROGRAM_ID;
  account.data[0] ^= 1;
  await expect(fetchPool(connection, pool)).rejects.toThrow("invalid account discriminator");
});

test("custom pool rejects target identity and vault mint mismatches", async () => {
  const context = fixture();
  const venue = new PumpSwapVenue();
  await expect(venue.resolveMarket({ ...context, token: { ...context.token,
    mint: Keypair.generate().publicKey.toBase58() } })).rejects.toThrow("does not contain token");
  context.quote.toBuffer().copy(context.accounts.get(context.baseVault.toBase58())!.data);
  await expect(venue.resolveMarket(context)).rejects.toThrow("does not match expected");
});

test("explicit AMM routing bypasses curve accounts; closed curve PDAs allow AMM discovery", async () => {
  const { connection, token } = fixture();
  expect(await new PumpCurveVenue().resolveMarket({ connection, token, user: Keypair.generate().publicKey })).toBeNull();
  const curve = Keypair.generate().publicKey;
  const closed = { owner: SystemProgram.programId, data: Buffer.alloc(0), executable: false, lamports: 0 };
  const chain = { async getAccountInfo() { return closed; } } as unknown as Connection;
  expect(await fetchCurve(chain, { ...token, bondingCurve: curve.toBase58() })).toBeNull();
  closed.data = Buffer.alloc(49);
  await expect(fetchCurve(chain, { ...token, bondingCurve: curve.toBase58() })).rejects.toThrow("unexpected program owner");
});
