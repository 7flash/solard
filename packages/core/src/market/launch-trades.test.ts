import { describe, expect, test } from "bun:test";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { pumpAmmJson } from "@pump-fun/pump-swap-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { bondingCurvePda, globalPda } from "../venues/pump/pda.ts";
import { PUMP_PROGRAM_ID } from "../venues/pump/constants.ts";
import { PUMP_CURVE_DISCRIMINATOR } from "../venues/pump/state.ts";
import { fixtureConnection } from "../venues/meteora/fixtures/connection.ts";
import {
  decodePumpProgramData,
  decodePumpSwapProgramData,
  decodeRaydiumLaunchLabProgramData,
  subscribeTrades,
  quoteSolLoader,
} from "./launch-trades.ts";

test("custom Pump curve quote metadata survives unavailable parsed transactions", async () => {
  const { connection, accounts, callbacks } = fixtureConnection();
  const mint = new PublicKey(Buffer.alloc(32, 30));
  const quote = new PublicKey(Buffer.alloc(32, 35));
  const mintData = (decimals: number) => {
    const data = Buffer.alloc(82);
    data.writeBigUInt64LE(1_000_000_000_000_000n, 36);
    data[44] = decimals;
    data[45] = 1;
    return { data, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 };
  };
  accounts.set(mint.toBase58(), mintData(6));
  accounts.set(quote.toBase58(), mintData(8));
  const curveData = Buffer.alloc(115);
  PUMP_CURVE_DISCRIMINATOR.copy(curveData);
  quote.toBuffer().copy(curveData, 83);
  accounts.set(bondingCurvePda(mint).toBase58(), { data: curveData, owner: PUMP_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 });
  let parsedCalls = 0;
  connection.getParsedTransaction = async () => { parsedCalls++; throw new Error("unavailable parsed RPC"); };
  const trades: Array<Parameters<Parameters<typeof subscribeTrades>[0]["onTrade"]>[0]> = [];
  const statuses: Array<string> = [];
  const subscription = await subscribeTrades({ connection, tokens: [mint.toBase58()], venues: ["pump"], solUsd: 100, quoteSol: async () => 0.01, onStatus: event => statuses.push(event), onTrade: event => { trades.push(event); } });
  callbacks[0]!({ err: null, signature: "custom-curve", logs: [`Program ${PUMP_PROGRAM_ID} invoke [1]`, `Program data: ${pumpTradeEvent().toString("base64")}`, `Program ${PUMP_PROGRAM_ID} success`] }, { slot: 42 });
  await Bun.sleep(40);
  expect(parsedCalls).toBe(0);
  expect(trades).toHaveLength(1);
  expect(trades[0]!.market.quoteMint).toBe(quote.toBase58());
  expect(trades[0]!.market.quoteDecimals).toBe(8);
  expect(trades[0]!.market.supplyRaw).toBe(1_000_000_000_000_000n);
  expect(trades[0]!.market.priceSol).toBeGreaterThan(0);
  const mismatched = pumpTradeEvent();
  Buffer.alloc(32, 36).copy(mismatched, mismatched.indexOf(Buffer.alloc(32, 35)));
  callbacks[0]!({ err: null, signature: "mismatched-quote", logs: [`Program ${PUMP_PROGRAM_ID} invoke [1]`, `Program data: ${mismatched.toString("base64")}`, `Program ${PUMP_PROGRAM_ID} success`] }, { slot: 43 });
  await Bun.sleep(40);
  expect(trades).toHaveLength(1);
  expect(statuses).toContain("pump-quote-metadata-mismatch");
  await subscription.close();
});

test("eligible unmigrated quote curve converts through verified virtual reserves without Jupiter", async () => {
  const { connection, accounts } = fixtureConnection();
  const mint = new PublicKey(Buffer.alloc(32, 90));
  const mintData = Buffer.alloc(82);
  mintData[44] = 6;
  mintData[45] = 1;
  accounts.set(mint.toBase58(), { data: mintData, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 });
  const data = Buffer.alloc(115);
  PUMP_CURVE_DISCRIMINATOR.copy(data);
  data.writeBigUInt64LE(100_000_000n, 8);
  data.writeBigUInt64LE(2_000_000_000n, 16);
  data.writeBigUInt64LE(100_000_000n, 24);
  accounts.set(bondingCurvePda(mint).toBase58(), { data, owner: PUMP_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 });
  const load = quoteSolLoader(connection, () => {});
  expect(await load(mint.toBase58(), 9)).toBeCloseTo(0.02);
});

test("mayhem, nested Pump quotes, and migration gaps remain explicit unavailable conversions", async () => {
  for (const [mode, reason] of [["mayhem", "mayhem-quote-prohibited"], ["nested", "nested-pump-quote-prohibited"], ["migrated", "migration-gap"]] as const) {
    const { connection, accounts } = fixtureConnection();
    const mint = new PublicKey(Buffer.alloc(32, 91));
    const data = Buffer.alloc(115);
    PUMP_CURVE_DISCRIMINATOR.copy(data);
    data[81] = mode === "mayhem" ? 1 : 0;
    data[48] = mode === "migrated" ? 1 : 0;
    if (mode === "nested") {
      const quote = new PublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
      quote.toBuffer().copy(data, 83);
      const global = Buffer.alloc(1045);
      Buffer.from([167, 232, 232, 177, 200, 108, 114, 127]).copy(global);
      accounts.set(globalPda().toBase58(), { data: global, owner: PUMP_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 });
    }
    accounts.set(bondingCurvePda(mint).toBase58(), { data, owner: PUMP_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 });
    const statuses: Array<Record<string, unknown> | undefined> = [];
    expect(await quoteSolLoader(connection, (_event, status) => statuses.push(status))(mint.toBase58(), 6)).toBeNull();
    expect(statuses.some(status => status?.reason === reason)).toBe(true);
  }
});

test("a curve quoted in an actual Global-listed mint converts through verified SOL reserves", async () => {
  const { connection, accounts } = fixtureConnection();
  const mint = new PublicKey(Buffer.alloc(32, 92));
  const quote = new PublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
  const quoteCurve = Buffer.alloc(115);
  PUMP_CURVE_DISCRIMINATOR.copy(quoteCurve);
  quoteCurve.writeBigUInt64LE(100_000_000n, 8);
  quoteCurve.writeBigUInt64LE(2_000_000_000n, 16);
  quoteCurve.writeBigUInt64LE(100_000_000n, 24);
  accounts.set(bondingCurvePda(quote).toBase58(), { data: quoteCurve, owner: PUMP_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 });
  const global = Buffer.alloc(1045);
  Buffer.from([167, 232, 232, 177, 200, 108, 114, 127]).copy(global);
  quote.toBuffer().copy(global, 1013);
  accounts.set(globalPda().toBase58(), { data: global, owner: PUMP_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 });
  const mintData = Buffer.alloc(82);
  mintData[44] = 6; mintData[45] = 1;
  accounts.set(mint.toBase58(), { data: mintData, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 });
  const data = Buffer.alloc(115);
  PUMP_CURVE_DISCRIMINATOR.copy(data);
  quote.toBuffer().copy(data, 83);
  data.writeBigUInt64LE(100_000_000n, 8);
  data.writeBigUInt64LE(200_000_000n, 16);
  data.writeBigUInt64LE(100_000_000n, 24);
  accounts.set(bondingCurvePda(mint).toBase58(), { data, owner: PUMP_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 });
  const load = quoteSolLoader(connection, () => {});
  const quotePrice = await load(quote.toBase58(), 6);
  expect(quotePrice).toBeGreaterThan(0);
  expect(await load(mint.toBase58(), 6)).toBeCloseTo(quotePrice! * 2, 12);
});

test("recursive listed quote cycles stop without deadlocking or cached path shortcuts", async () => {
  const { connection, accounts } = fixtureConnection();
  const mint = new PublicKey(Buffer.alloc(32, 93));
  const mintData = Buffer.alloc(82);
  mintData[44] = 6; mintData[45] = 1;
  accounts.set(mint.toBase58(), { data: mintData, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 });
  const global = Buffer.alloc(1045);
  Buffer.from([167, 232, 232, 177, 200, 108, 114, 127]).copy(global);
  mint.toBuffer().copy(global, 1013);
  accounts.set(globalPda().toBase58(), { data: global, owner: PUMP_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 });
  const data = Buffer.alloc(115);
  PUMP_CURVE_DISCRIMINATOR.copy(data);
  mint.toBuffer().copy(data, 83);
  for (const offset of [8, 16, 24]) data.writeBigUInt64LE(100_000_000n, offset);
  accounts.set(bondingCurvePda(mint).toBase58(), { data, owner: PUMP_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 });
  const reasons: Array<unknown> = [];
  const load = quoteSolLoader(connection, (_event, status) => reasons.push(status?.reason));
  expect(await load(mint.toBase58(), 6)).toBeNull();
  expect(reasons).toContain("cycle-or-depth-limit");
});

const PUMP_TRADE_D8 = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const BUY_D8 = Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]);
const SELL_D8 = Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]);
const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const LAUNCHLAB_PROGRAM = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const LAUNCHLAB_TRADE_D8 = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const LAUNCHLAB_BUY_D8 = Buffer.from([250, 234, 13, 123, 213, 156, 19, 236]);
const WSOL = "So11111111111111111111111111111111111111112";

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

function i64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(value);
  return out;
}

function i128(value: bigint): Buffer {
  const unsigned = BigInt.asUintN(128, value);
  const out = Buffer.alloc(16);
  out.writeBigUInt64LE(unsigned & ((1n << 64n) - 1n), 0);
  out.writeBigUInt64LE(unsigned >> 64n, 8);
  return out;
}

function bool(value: boolean): Buffer {
  return Buffer.from([value ? 1 : 0]);
}

function pubkey(seed: number): Buffer {
  return Buffer.alloc(32, seed);
}

function text(value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([size, body]);
}

function pumpTradeEvent() {
  return Buffer.concat([
    PUMP_TRADE_D8,
    pubkey(30),
    u64(101n),
    u64(202n),
    bool(true),
    pubkey(31),
    i64(1_700_000_001n),
    u64(303n),
    u64(404n),
    u64(505n),
    u64(606n),
    pubkey(32),
    u64(1n),
    u64(2n),
    pubkey(33),
    u64(3n),
    u64(4n),
    bool(true),
    u64(5n),
    u64(6n),
    u64(7n),
    i64(8n),
    text("buy"),
    bool(false),
    u64(9n),
    u64(10n),
    u64(11n),
    u64(12n),
    Buffer.from([1, 0, 0, 0]),
    pubkey(34),
    Buffer.from([25, 0]),
    pubkey(35),
    u64(707n),
    u64(808n),
    u64(909n),
    u64(13n),
    u64(14n),
  ]);
}

function pumpSwapEvent(args: {
  side: "buy" | "sell";
  pool?: Buffer;
  poolBaseRaw?: bigint;
  poolQuoteRaw?: bigint;
  virtualQuoteRaw?: bigint;
  supplyRaw?: bigint;
}) {
  const discriminator = args.side === "buy" ? BUY_D8 : SELL_D8;
  const parts: Buffer[] = [
    discriminator,
    i64(1_790_871_415n),
    u64(1_788_857_979n),
    u64(2n),
    u64(3n),
    u64(4n),
    u64(args.poolBaseRaw ?? 142_120_607_229_034n),
    u64(args.poolQuoteRaw ?? 145_018_861_948n),
    u64(1_825_361n),
    u64(10n),
    u64(11n),
    u64(12n),
    u64(13n),
    u64(14n),
    u64(15n),
    args.pool ?? pubkey(1),
    pubkey(2),
    pubkey(3),
    pubkey(4),
    pubkey(5),
    pubkey(6),
    pubkey(7),
    u64(16n),
    u64(17n),
  ];
  if (args.side === "buy") {
    parts.push(
      bool(true),
      u64(18n),
      u64(19n),
      u64(20n),
      i64(21n),
      u64(22n),
      text("buy_exact_quote_in"),
    );
  }
  parts.push(
    u64(23n),
    u64(24n),
    u64(25n),
    u64(26n),
    i128(args.virtualQuoteRaw ?? 0n),
    bool(true),
    u64(args.supplyRaw ?? 975_349_926_053_310n),
    u64(27n),
    u64(28n),
  );
  return Buffer.concat(parts);
}

function pumpSwapPoolAccount(args: {
  baseMint: string;
  quoteMint: string;
}): Buffer {
  const data = Buffer.alloc(261);
  Buffer.from(
    pumpAmmJson.accounts.find(
      (account) => account.name.toLowerCase() === "pool",
    )!.discriminator,
  ).copy(data);
  new PublicKey(args.baseMint).toBuffer().copy(data, 43);
  new PublicKey(args.quoteMint).toBuffer().copy(data, 75);
  pubkey(70).copy(data, 139);
  pubkey(71).copy(data, 171);
  pubkey(72).copy(data, 211);
  return data;
}

function launchLabTradeEvent(args: {
  pool: Buffer;
  side: "buy" | "sell";
  amountIn: bigint;
  amountOut: bigint;
  virtualBaseRaw: bigint;
  virtualQuoteRaw: bigint;
}) {
  return Buffer.concat([
    LAUNCHLAB_TRADE_D8,
    args.pool,
    u64(1n),
    u64(args.virtualBaseRaw),
    u64(args.virtualQuoteRaw),
    u64(2n),
    u64(3n),
    u64(4n),
    u64(5n),
    u64(args.amountIn),
    u64(args.amountOut),
    u64(6n),
    u64(7n),
    u64(8n),
    u64(9n),
    Buffer.from([args.side === "buy" ? 0 : 1]),
    Buffer.from([0]),
    bool(true),
  ]);
}

describe("launch trade market decoding", () => {
  test("decodes LaunchLab trade direction and exact amounts", () => {
    const decoded = decodeRaydiumLaunchLabProgramData(
      launchLabTradeEvent({
        pool: pubkey(44),
        side: "buy",
        amountIn: 3_000_000n,
        amountOut: 1_500_000n,
        virtualBaseRaw: 1_000_000_000_000n,
        virtualQuoteRaw: 20_000_000_000n,
      }),
    );
    expect(decoded?.kind).toBe("trade");
    if (!decoded || decoded.kind !== "trade") return;
    expect(decoded.side).toBe("buy");
    expect(decoded.baseRaw).toBe(1_500_000n);
    expect(decoded.quoteRaw).toBe(3_000_000n);
  });

  test("uses the LaunchLab instruction quote mint instead of incidental WSOL", async () => {
    const callbacks: Array<(logs: any, context: any) => void> = [];
    const mint = bs58.encode(pubkey(43));
    const pool = bs58.encode(pubkey(44));
    const quote = bs58.encode(pubkey(45));
    const accounts = Array.from({ length: 15 }, (_, index) =>
      bs58.encode(pubkey(60 + index)),
    );
    accounts[4] = pool;
    accounts[9] = mint;
    accounts[10] = quote;

    class FakeConnection {
      onLogs(_filter: unknown, callback: (logs: any, context: any) => void) {
        callbacks.push(callback);
        return callbacks.length;
      }
      async removeOnLogsListener() {}
      async getTokenSupply() {
        return {
          value: {
            decimals: 6,
            amount: "1000000000000000",
            uiAmountString: "1000000000",
          },
        };
      }
      async getParsedTransaction() {
        return {
          slot: 1,
          blockTime: 1,
          transaction: {
            message: {
              instructions: [
                {
                  programId: LAUNCHLAB_PROGRAM,
                  accounts,
                  data: bs58.encode(LAUNCHLAB_BUY_D8),
                },
              ],
            },
          },
          meta: {
            preTokenBalances: [
              {
                accountIndex: 0,
                mint: WSOL,
                uiTokenAmount: { amount: "1", decimals: 9 },
              },
              {
                accountIndex: 1,
                mint: quote,
                uiTokenAmount: { amount: "1", decimals: 6 },
              },
            ],
            postTokenBalances: [],
            innerInstructions: [],
          },
        };
      }
    }

    const trades: any[] = [];
    const subscription = await subscribeTrades({
      connection: new FakeConnection() as any,
      tokens: [mint],
      venues: ["raydium-launchlab"],
      commitment: "confirmed",
      solUsd: 100,
      quoteSol: async () => null,
      onTrade(event) {
        trades.push(event);
      },
    });

    callbacks[0]!(
      {
        err: null,
        signature: "sig-launchlab",
        logs: [
          `Program ${LAUNCHLAB_PROGRAM} invoke [1]`,
          `Program data: ${launchLabTradeEvent({
            pool: pubkey(44),
            side: "buy",
            amountIn: 3_000_000n,
            amountOut: 1_500_000n,
            virtualBaseRaw: 1_000_000_000_000n,
            virtualQuoteRaw: 20_000_000_000n,
          }).toString("base64")}`,
          `Program ${LAUNCHLAB_PROGRAM} success`,
        ],
      },
      { slot: 2 },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBe("buy");
    expect(trades[0].baseRaw).toBe(1_500_000n);
    expect(trades[0].quoteRaw).toBe(3_000_000n);
    expect(trades[0].market.quoteMint).toBe(quote);
    expect(trades[0].market.priceSol).toBeNull();
    expect(trades[0].market.priceUsd).toBeNull();
    expect(trades[0].market.priceQuotePerToken).toBeCloseTo(0.02, 12);
    expect(trades[0].market.marketCapQuote).toBeCloseTo(20_000_000, 4);
    await subscription.close();
  });

  test("uses Pump quote-specific fields when the extended trade event is present", () => {
    const decoded = decodePumpProgramData(pumpTradeEvent());
    expect(decoded?.kind).toBe("trade");
    if (!decoded || decoded.kind !== "trade") return;
    expect(decoded.quoteMint).toBe(bs58.encode(pubkey(35)));
    expect(decoded.quoteRaw).toBe(707n);
    expect(decoded.virtualQuoteRaw).toBe(808n);
    expect(decoded.virtualBaseRaw).toBe(404n);
  });

  test("decodes PumpSwap buy amounts separately from post-trade reserves", () => {
    const decoded = decodePumpSwapProgramData(pumpSwapEvent({ side: "buy" }));
    expect(decoded?.kind).toBe("trade");
    if (!decoded || decoded.kind !== "trade") return;
    expect(decoded.side).toBe("buy");
    expect(decoded.baseRaw).toBe(1_788_857_979n);
    expect(decoded.quoteRaw).toBe(1_825_361n);
    expect(decoded.poolBaseRaw).toBe(142_120_607_229_034n);
    expect(decoded.poolQuoteRaw).toBe(145_018_861_948n);
    expect(decoded.virtualQuoteRaw).toBe(0n);
    expect(decoded.supplyRaw).toBe(975_349_926_053_310n);
  });

  test("decodes PumpSwap sell tail without buy-only fields", () => {
    const decoded = decodePumpSwapProgramData(pumpSwapEvent({ side: "sell" }));
    expect(decoded?.kind).toBe("trade");
    if (!decoded || decoded.kind !== "trade") return;
    expect(decoded.side).toBe("sell");
    expect(decoded.virtualQuoteRaw).toBe(0n);
    expect(decoded.supplyRaw).toBe(975_349_926_053_310n);
  });

  test("emits one trade with complete market data in the same event", async () => {
    const callbacks: Array<(logs: any, context: any) => void> = [];
    const watchedMint = "H5Kugtkfc5vrm3oSdX6FDkxuutRK1S3GW7Rr7UgnoDhP";
    const eventPool = bs58.encode(pubkey(1));
    class FakeConnection {
      onLogs(_filter: unknown, callback: (logs: any, context: any) => void) {
        callbacks.push(callback);
        return callbacks.length;
      }
      async removeOnLogsListener() {}
      async getAccountInfo(address: PublicKey) {
        if (address.toBase58() !== eventPool) return null;
        return {
          owner: new PublicKey(PUMPSWAP_PROGRAM),
          data: pumpSwapPoolAccount({ baseMint: watchedMint, quoteMint: WSOL }),
        };
      }
      async getTokenSupply(mint: PublicKey) {
        return mint.toBase58() === watchedMint
          ? { value: { decimals: 6, amount: "1000000000000000" } }
          : { value: { decimals: 9, amount: "0" } };
      }
      async getParsedTransaction() {
        throw new Error(
          "PumpSwap quote identity must not come from transaction-wide balances",
        );
      }
    }

    const trades: any[] = [];
    const statuses: string[] = [];
    const subscription = await subscribeTrades({
      connection: new FakeConnection() as any,
      tokens: [watchedMint],
      venues: ["pumpswap"],
      commitment: "confirmed",
      solUsd: 115.55,
      onTrade(event) {
        trades.push(event);
      },
      onStatus(event) {
        statuses.push(event);
      },
    });

    callbacks[0]!(
      {
        err: null,
        signature: "sig-live",
        logs: [
          `Program ${PUMPSWAP_PROGRAM} invoke [1]`,
          `Program data: ${pumpSwapEvent({ side: "buy" }).toString("base64")}`,
          `Program ${PUMPSWAP_PROGRAM} success`,
        ],
      },
      { slot: 452_338_759 },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(trades).toHaveLength(1);
    expect(trades[0].baseRaw).toBe(1_788_857_979n);
    expect(trades[0].quoteRaw).toBe(1_825_361n);
    expect(trades[0].market.priceSol).toBeCloseTo(0.0000010203929238375354, 18);
    expect(trades[0].market.marketCapSol).toBeCloseTo(1020.3929238375355, 9);
    expect(trades[0].market.solUsd).toBe(115.55);
    expect(trades[0].market.marketCapUsd).toBeCloseTo(117_906.40234942723, 2);
    expect(trades[0].market.solUsdSource).toBe("provided");
    expect(statuses).not.toContain("trade-market-incomplete");
    await subscription.close();
  });

  test("filters PumpSwap trade events by authoritative pool base mint", async () => {
    const callbacks: Array<(logs: any, context: any) => void> = [];
    const watchedMint = bs58.encode(pubkey(43));
    const otherMint = bs58.encode(pubkey(44));
    const watchedPool = bs58.encode(pubkey(1));
    const otherPool = bs58.encode(pubkey(9));

    class FakeConnection {
      onLogs(_filter: unknown, callback: (logs: any, context: any) => void) {
        callbacks.push(callback);
        return callbacks.length;
      }
      async removeOnLogsListener() {}
      async getAccountInfo(address: PublicKey) {
        if (address.toBase58() === watchedPool)
          return {
            owner: new PublicKey(PUMPSWAP_PROGRAM),
            data: pumpSwapPoolAccount({
              baseMint: watchedMint,
              quoteMint: WSOL,
            }),
          };
        if (address.toBase58() === otherPool)
          return {
            owner: new PublicKey(PUMPSWAP_PROGRAM),
            data: pumpSwapPoolAccount({ baseMint: otherMint, quoteMint: WSOL }),
          };
        return null;
      }
      async getTokenSupply(mint: PublicKey) {
        if (mint.toBase58() === watchedMint)
          return { value: { decimals: 6, amount: "1000000000000000" } };
        if (mint.toBase58() === otherMint)
          return { value: { decimals: 6, amount: "9000000000000000" } };
        return { value: { decimals: 9, amount: "0" } };
      }
      async getParsedTransaction() {
        throw new Error("not used for PumpSwap identity");
      }
    }

    const trades: any[] = [];
    const statuses: Array<{ event: string; data?: Record<string, unknown> }> =
      [];
    const subscription = await subscribeTrades({
      connection: new FakeConnection() as any,
      tokens: [watchedMint],
      venues: ["pumpswap"],
      commitment: "confirmed",
      solUsd: 100,
      onTrade(event) {
        trades.push(event);
      },
      onStatus(event, data) {
        statuses.push({ event, data });
      },
    });

    callbacks[0]!(
      {
        err: null,
        signature: "sig-multi-pool",
        logs: [
          `Program ${PUMPSWAP_PROGRAM} invoke [1]`,
          `Program data: ${pumpSwapEvent({
            side: "buy",
            pool: pubkey(9),
            poolBaseRaw: 10n,
            poolQuoteRaw: 999_000_000_000n,
            supplyRaw: 9_000_000_000_000_000n,
          }).toString("base64")}`,
          `Program data: ${pumpSwapEvent({
            side: "buy",
            pool: pubkey(1),
            poolBaseRaw: 100_000_000_000_000n,
            poolQuoteRaw: 100_000_000_000n,
            supplyRaw: 7n,
          }).toString("base64")}`,
          `Program ${PUMPSWAP_PROGRAM} success`,
        ],
      },
      { slot: 3 },
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(trades).toHaveLength(1);
    expect(trades[0].mint).toBe(watchedMint);
    expect(trades[0].pool).toBe(watchedPool);
    expect(trades[0].market.supplyRaw).toBe(1_000_000_000_000_000n);
    expect(trades[0].market.marketCapSol).toBeCloseTo(1000, 8);
    expect(statuses.some((row) => row.event === "pumpswap-pool-mismatch")).toBe(
      true,
    );
    await subscription.close();
  });
});

test("PUMP-quoted multi-pool transaction cannot corrupt supply/capitalization or fire a strategy signal", async () => {
  const { connection, callbacks } = fixtureConnection();
  const mint = "3yLHGEma4ek25h8oRswBmYTJkTDdtGnrVn2ZuzV5pump";
  const pool = "D47qeECvhLero1oKCkMuKZ6sgsF6QGUZKnQuHXugQFTM";
  const otherPool = "6ZTSKWDobV2jnyMmrf3vGqy1WZ62iZuQnnwycoZvSmuq";
  const quoteMint = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
  const trades: Array<
    Parameters<NonNullable<Parameters<typeof subscribeTrades>[0]["onTrade"]>>[0]
  > = [];
  let strategySignals = 0;
  const verifiedSupply = await connection.getTokenSupply(
    new PublicKey(mint),
    "confirmed",
  );
  const subscription = await subscribeTrades({
    connection,
    tokens: [mint],
    venues: ["pumpswap"],
    solUsd: 100,
    quoteSol: async (quote, decimals) => {
      expect(quote).toBe(quoteMint);
      expect(decimals).toBe(6);
      return 0.00001;
    },
    onTrade(event) {
      trades.push(event);
      if (event.market.marketCapUsd! > 1_000_000) strategySignals++;
    },
  });
  callbacks[0]!(
    {
      err: null,
      signature: "pillson-nut",
      logs: [
        `Program ${PUMPSWAP_PROGRAM} invoke [1]`,
        `Program data: ${pumpSwapEvent({
          side: "buy",
          pool: new PublicKey(otherPool).toBuffer(),
          poolBaseRaw: 1n,
          poolQuoteRaw: 999_000_000_000_000n,
          supplyRaw: 999_000_000_000_000_000n,
        }).toString("base64")}`,
        `Program data: ${pumpSwapEvent({
          side: "buy",
          pool: new PublicKey(pool).toBuffer(),
          poolBaseRaw: 100_000_000_000_000n,
          poolQuoteRaw: 2_592_000_000_000n,
          supplyRaw: 7n,
        }).toString("base64")}`,
        `Program ${PUMPSWAP_PROGRAM} success`,
      ],
    },
    { slot: 1 },
  );
  await Bun.sleep(40);
  expect(trades).toHaveLength(1);
  expect(strategySignals).toBe(0);
  const market = trades[0]!.market;
  expect(trades[0]!.pool).toBe(pool);
  expect(market.supplyRaw).toBe(BigInt(verifiedSupply.value.amount));
  expect(market.baseDecimals).toBe(6);
  expect(market.quoteDecimals).toBe(6);
  expect(market.priceQuotePerToken).toBeCloseTo(0.02592, 12);
  expect(market.priceSol).toBeCloseTo(0.0000002592, 12);
  expect(market.priceUsd).toBeCloseTo(0.00002592, 12);
  expect(market.marketCapUsd).toBeCloseTo(
    (market.priceUsd! * Number(verifiedSupply.value.amount)) / 1e6,
    6,
  );
  await subscription.close();
});

test("unavailable PUMP conversion leaves SOL/USD fields unavailable", async () => {
  const { connection, callbacks } = fixtureConnection();
  const trades: Array<
    Parameters<Parameters<typeof subscribeTrades>[0]["onTrade"]>[0]
  > = [];
  const subscription = await subscribeTrades({
    connection,
    tokens: ["3yLHGEma4ek25h8oRswBmYTJkTDdtGnrVn2ZuzV5pump"],
    venues: ["pumpswap"],
    solUsd: 100,
    quoteSol: async () => null,
    onTrade(event) {
      trades.push(event);
    },
  });
  callbacks[0]!(
    {
      err: null,
      signature: "no-conversion",
      logs: [
        `Program ${PUMPSWAP_PROGRAM} invoke [1]`,
        `Program data: ${pumpSwapEvent({ side: "sell", pool: new PublicKey("D47qeECvhLero1oKCkMuKZ6sgsF6QGUZKnQuHXugQFTM").toBuffer() }).toString("base64")}`,
        `Program ${PUMPSWAP_PROGRAM} success`,
      ],
    },
    { slot: 1 },
  );
  await Bun.sleep(40);
  expect(trades).toHaveLength(1);
  expect(trades[0]!.market.priceQuotePerToken).toBeGreaterThan(0);
  expect(trades[0]!.market.priceSol).toBeNull();
  expect(trades[0]!.market.marketCapSol).toBeNull();
  expect(trades[0]!.market.priceUsd).toBeNull();
  expect(trades[0]!.market.marketCapUsd).toBeNull();
  await subscription.close();
});
