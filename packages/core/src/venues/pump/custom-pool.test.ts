import { expect, test } from "bun:test";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  type AccountInfo,
  type Connection,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { pumpAmmJson, GLOBAL_CONFIG_PDA } from "@pump-fun/pump-swap-sdk";
import type { TokenRow } from "../../db/schema.ts";
import { PumpSwapVenue } from "./pumpswap-venue.ts";
import { PUMP_AMM_PROGRAM_ID } from "./constants.ts";
import { fetchPool } from "./state.ts";
import { verifyPoolTokenMetadata } from "./token-metadata.ts";
import { Solard } from "../../core/solard.ts";
import { PumpCurveVenue } from "./pump-curve-venue.ts";
import { fetchCurve } from "./state.ts";
import { snapshotSwapState } from "./live-reserves.ts";

function fixture() {
  const base = Keypair.generate().publicKey;
  const quote = Keypair.generate().publicKey;
  const pool = Keypair.generate().publicKey;
  const baseVault = Keypair.generate().publicKey;
  const quoteVault = Keypair.generate().publicKey;
  const user = Keypair.generate().publicKey;
  const accounts = new Map<string, AccountInfo<Buffer>>();
  const add = (address: PublicKey, data: Buffer, owner: PublicKey) => {
    accounts.set(address.toBase58(), {
      data,
      owner,
      lamports: 2_000_000,
      executable: false,
      rentEpoch: 0,
    });
  };
  const poolData = Buffer.alloc(261);
  Buffer.from(
    pumpAmmJson.accounts.find(
      (account) => account.name.toLowerCase() === "pool",
    )!.discriminator,
  ).copy(poolData);
  base.toBuffer().copy(poolData, 43);
  quote.toBuffer().copy(poolData, 75);
  baseVault.toBuffer().copy(poolData, 139);
  quoteVault.toBuffer().copy(poolData, 171);
  user.toBuffer().copy(poolData, 211);
  add(pool, poolData, PUMP_AMM_PROGRAM_ID);
  for (const [address, decimals, owner] of [
    [base, 7, TOKEN_PROGRAM_ID],
    [quote, 8, TOKEN_2022_PROGRAM_ID],
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
    async getMultipleAccountsInfo(addresses: PublicKey[]) {
      queried.push(...addresses.map((address) => address.toBase58()));
      return addresses.map(
        (address) => accounts.get(address.toBase58()) ?? null,
      );
    },
  } as unknown as Connection;
  const token = {
    mint: base.toBase58(),
    pool: pool.toBase58(),
    venueHint: "pumpswap",
    decimals: 6,
    quoteMint: quote.toBase58(),
    quoteTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    metadataJson: JSON.stringify({
      protocolFeeRecipient: user.toBase58(),
      custom: "keep",
      quoteDecimals: 6,
    }),
  } as TokenRow;
  return {
    base,
    quote,
    pool,
    baseVault,
    accounts,
    queried,
    connection,
    token,
    user,
  };
}

test("explicit PumpSwap custom pool resolves without a bonding curve using actual mint owners and decimals", async () => {
  const context = fixture();
  const venue = new PumpSwapVenue();
  const market = await venue.resolveMarket(context);
  expect(market).not.toBeNull();
  expect(market!.quoteAsset.decimals).toBe(8);
  expect(market!.quoteAsset.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)).toBe(
    true,
  );
  expect(market!.metadata.baseDecimals).toBe(7);
  const price = await venue.price(context, market!);
  expect(price.priceQuotePerToken).toBeCloseTo(0.5);
  expect(
    context.queried.every((address) => context.accounts.has(address)),
  ).toBe(true);
});

test("custom pool metadata corrects stale quote program/decimals and preserves unrelated hints", async () => {
  const { connection, token } = fixture();
  const verified = await verifyPoolTokenMetadata(connection, token);
  expect(verified.quoteTokenProgram).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
  expect(JSON.parse(verified.metadataJson!)).toMatchObject({
    quoteDecimals: 8,
    custom: "keep",
  });
});

test("refresh preserves the configured custom pool when inspection suggests another pool", async () => {
  const { connection, token } = fixture();
  const slrd: Solard = Object.create(Solard.prototype);
  slrd.connection = () => connection;
  slrd.resolveToken = () => token;
  Object.defineProperty(slrd, "venues", {
    value: {
      async inspect() {
        return {
          pool: Keypair.generate().publicKey.toBase58(),
          venueHint: "pump-curve",
          metadataJson: JSON.stringify({ inspected: true }),
        };
      },
    },
  });
  Object.defineProperty(slrd, "tokens", {
    value: {
      upsert(value: TokenRow) {
        return value;
      },
    },
  });
  const refreshed = await slrd.refreshToken(token.mint);
  expect(refreshed.pool).toBe(token.pool);
  expect(refreshed.venueHint).toBe("pumpswap");
  expect(refreshed.decimals).toBe(7);
  expect(refreshed.quoteTokenProgram).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
  expect(JSON.parse(refreshed.metadataJson!)).toMatchObject({
    custom: "keep",
    inspected: true,
    quoteDecimals: 8,
  });
});

test("custom pool rejects wrong program owner and discriminator", async () => {
  const { connection, pool, accounts } = fixture();
  const account = accounts.get(pool.toBase58())!;
  account.owner = SystemProgram.programId;
  await expect(fetchPool(connection, pool)).rejects.toThrow(
    "unexpected program owner",
  );
  account.owner = PUMP_AMM_PROGRAM_ID;
  account.data[0] ^= 1;
  await expect(fetchPool(connection, pool)).rejects.toThrow(
    "invalid account discriminator",
  );
});

test("custom pool rejects target identity and vault mint mismatches", async () => {
  const context = fixture();
  const venue = new PumpSwapVenue();
  await expect(
    venue.resolveMarket({
      ...context,
      token: {
        ...context.token,
        mint: Keypair.generate().publicKey.toBase58(),
      },
    }),
  ).rejects.toThrow("does not contain token");
  context.quote
    .toBuffer()
    .copy(context.accounts.get(context.baseVault.toBase58())!.data);
  await expect(venue.resolveMarket(context)).rejects.toThrow(
    "does not match expected",
  );
});

test("PumpSwap resolution batches cold metadata and always refreshes both vaults", async () => {
  const context = fixture();
  const batches: string[][] = [];
  const original = context.connection.getMultipleAccountsInfo.bind(
    context.connection,
  );
  context.connection.getMultipleAccountsInfo = async (
    addresses: PublicKey[],
  ) => {
    batches.push(addresses.map((address) => address.toBase58()));
    return original(addresses);
  };
  const venue = new PumpSwapVenue();
  await venue.resolveMarket(context);
  expect(batches[0]).toHaveLength(4);
  expect(context.queried).toHaveLength(5); // one pool plus one four-account batch
  context.accounts
    .get(context.baseVault.toBase58())!
    .data.writeBigUInt64LE(400_000_000n, 64);
  const market = await venue.resolveMarket(context);
  expect(batches[1]).toHaveLength(2);
  expect(market!.metadata.reserves.virtualBase).toBe(400_000_000n);
  expect(market!.quoteAsset.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)).toBe(
    true,
  );
  context.accounts.get(context.baseVault.toBase58())!.owner =
    TOKEN_2022_PROGRAM_ID;
  await expect(venue.resolveMarket(context)).rejects.toThrow();
});

test("validated caller reserves skip vault reads while SDK uses fresh mint supply and config", async () => {
  const context = fixture();
  const globalData = Buffer.alloc(1024);
  Buffer.from(
    pumpAmmJson.accounts.find(
      (account) => account.name.toLowerCase() === "globalconfig",
    )!.discriminator,
  ).copy(globalData);
  context.accounts.set(GLOBAL_CONFIG_PDA.toBase58(), {
    data: globalData,
    owner: PUMP_AMM_PROGRAM_ID,
    lamports: 1,
    executable: false,
    rentEpoch: 0,
  });
  const reserves = {
    pool: context.pool.toBase58(),
    baseMint: context.base.toBase58(),
    quoteMint: context.quote.toBase58(),
    baseReserveRaw: 300_000_000n,
    quoteReserveRaw: 900_000_000n,
    slot: 100,
    capturedAtMs: Date.now(),
  };
  const batches: PublicKey[][] = [];
  context.connection.getMultipleAccountsInfoAndContext = async (
    addresses: PublicKey[],
  ) => {
    batches.push(addresses);
    return {
      context: { slot: 101 },
      value: addresses.map(
        (address) => context.accounts.get(address.toBase58()) ?? null,
      ),
    };
  };
  const venue = new PumpSwapVenue();
  const ctx = { ...context, reserves };
  const market = (await venue.resolveMarket(ctx))!;
  expect(context.queried).not.toContain(context.baseVault.toBase58());
  const state = await snapshotSwapState(ctx, market);
  expect(batches).toHaveLength(1);
  expect(batches[0]).toHaveLength(7);
  expect(batches[0]!.some((address) => address.equals(context.baseVault))).toBe(
    false,
  );
  expect(state.poolBaseAmount.toString()).toBe("300000000");
  expect(state.baseMintAccount.supply).toBe(1_000_000_000n);
  expect(state.quoteTokenProgram.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  const quote = await venue.quoteBuy(
    ctx,
    market,
    { asset: market.quoteAsset, raw: 100_000n },
    500,
  );
  expect(quote.minimumOutputRaw).toBeGreaterThan(0n);
  expect(batches).toHaveLength(2);
  const built = await venue.buildBuy(ctx, market, quote);
  expect(built.instructions.length).toBeGreaterThan(0);
  expect(batches).toHaveLength(3);
  const sellQuote = await venue.quoteSell(ctx, market, 100_000n, 500);
  const sellBuilt = await venue.buildSell(ctx, market, sellQuote);
  expect(sellBuilt.minOutputRaw).toBeGreaterThan(0n);
  expect(batches).toHaveLength(5);
  context.connection.getMultipleAccountsInfoAndContext = async (
    addresses: PublicKey[],
  ) => ({
    context: { slot: 99 },
    value: addresses.map(
      (address) => context.accounts.get(address.toBase58()) ?? null,
    ),
  });
  await expect(snapshotSwapState(ctx, market)).rejects.toThrow("older");
  context.connection.getMultipleAccountsInfoAndContext = async (
    addresses: PublicKey[],
  ) => ({
    context: { slot: 101 },
    value: addresses.map(
      (address) => context.accounts.get(address.toBase58()) ?? null,
    ),
  });
  context.accounts.get(context.base.toBase58())!.owner =
    SystemProgram.programId;
  await expect(snapshotSwapState(ctx, market)).rejects.toThrow();
  context.accounts.get(context.base.toBase58())!.owner = TOKEN_PROGRAM_ID;
  reserves.capturedAtMs = Date.now() - 3000;
  await expect(snapshotSwapState(ctx, market)).rejects.toThrow("stale");
  reserves.capturedAtMs = Date.now();
  reserves.baseMint = Keypair.generate().publicKey.toBase58();
  await expect(snapshotSwapState(ctx, market)).rejects.toThrow(
    "identity mismatch",
  );
});

test("explicit AMM routing bypasses curve accounts; closed curve PDAs allow AMM discovery", async () => {
  const { connection, token } = fixture();
  expect(
    await new PumpCurveVenue().resolveMarket({
      connection,
      token,
      user: Keypair.generate().publicKey,
    }),
  ).toBeNull();
  const curve = Keypair.generate().publicKey;
  const closed = {
    owner: SystemProgram.programId,
    data: Buffer.alloc(0),
    executable: false,
    lamports: 0,
  };
  const chain = {
    async getAccountInfo() {
      return closed;
    },
  } as unknown as Connection;
  expect(
    await fetchCurve(chain, { ...token, bondingCurve: curve.toBase58() }),
  ).toBeNull();
  closed.data = Buffer.alloc(49);
  await expect(
    fetchCurve(chain, { ...token, bondingCurve: curve.toBase58() }),
  ).rejects.toThrow("unexpected program owner");
});
