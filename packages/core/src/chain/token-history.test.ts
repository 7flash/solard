import { describe, expect, test } from "bun:test";
import { NATIVE_MINT } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { Buffer } from "buffer";

import {
  findPumpHistoryCreateMarker,
  parsePumpHistoryTransaction,
} from "./token-history.ts";
import {
  AMM_BUY_EVENT_D8,
  AMM_BUY_EXACT_QUOTE_IN_D8,
  AMM_SELL_D8,
  AMM_SELL_EVENT_D8,
  BUY_EXACT_QUOTE_IN_V2_D8,
  CREATE_V2_D8,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SELL_V2_D8,
} from "../venues/pump/constants.ts";

const MINT = new PublicKey("2WUHazZ8aJQaJiCX24ksNCjf8ZyHTh8gohWCNBoxpump");
const USER = new PublicKey("BgmuMifRmKxLSJ6s93De9EW2b4cRwxTd78hsGfdwDaLS");
const TARGET_ATA = new PublicKey(Buffer.alloc(32, 1));
const WSOL_ATA = new PublicKey(Buffer.alloc(32, 2));
const POOL = new PublicKey(Buffer.alloc(32, 3));
const OTHER = PublicKey.default;
const TIP = new PublicKey("9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7");

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

function borshString(value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  return Buffer.concat([length, body]);
}

function pumpSwapBuyEvent(args: {
  userQuoteRaw: bigint;
  lpFeeRaw: bigint;
  protocolFeeRaw: bigint;
  creatorFeeRaw: bigint;
  cashbackRaw?: bigint;
  buybackFeeRaw?: bigint;
  holderRewardsRaw?: bigint;
}): Buffer {
  return Buffer.concat([
    AMM_BUY_EVENT_D8,
    i64(1_700_000_000n),
    u64(80_000_000n),
    u64(args.userQuoteRaw),
    u64(80_000_000n),
    u64(0n),
    u64(1n),
    u64(1n),
    u64(args.userQuoteRaw),
    u64(100n),
    u64(args.lpFeeRaw),
    u64(50n),
    u64(args.protocolFeeRaw),
    u64(args.userQuoteRaw),
    u64(args.userQuoteRaw),
    POOL.toBuffer(),
    USER.toBuffer(),
    TARGET_ATA.toBuffer(),
    WSOL_ATA.toBuffer(),
    OTHER.toBuffer(),
    OTHER.toBuffer(),
    OTHER.toBuffer(),
    u64(25n),
    u64(args.creatorFeeRaw),
    Buffer.from([1]),
    u64(0n),
    u64(0n),
    u64(0n),
    i64(1_700_000_000n),
    u64(1n),
    borshString("buy_exact_quote_in"),
    u64(0n),
    u64(args.cashbackRaw ?? 0n),
    u64(0n),
    u64(args.buybackFeeRaw ?? 0n),
    Buffer.alloc(16),
    Buffer.from([0]),
    u64(1_000_000_000n),
    u64(0n),
    u64(args.holderRewardsRaw ?? 0n),
  ]);
}

function pumpSwapSellEvent(args: {
  userQuoteRaw: bigint;
  lpFeeRaw: bigint;
  protocolFeeRaw: bigint;
  creatorFeeRaw: bigint;
}): Buffer {
  return Buffer.concat([
    AMM_SELL_EVENT_D8,
    i64(1_700_000_000n),
    u64(20_000_000n),
    u64(1n),
    u64(60_000_000n),
    u64(args.userQuoteRaw),
    u64(1n),
    u64(1n),
    u64(args.userQuoteRaw),
    u64(100n),
    u64(args.lpFeeRaw),
    u64(50n),
    u64(args.protocolFeeRaw),
    u64(args.userQuoteRaw),
    u64(args.userQuoteRaw),
    POOL.toBuffer(),
    USER.toBuffer(),
    TARGET_ATA.toBuffer(),
    WSOL_ATA.toBuffer(),
    OTHER.toBuffer(),
    OTHER.toBuffer(),
    OTHER.toBuffer(),
    u64(25n),
    u64(args.creatorFeeRaw),
    u64(0n),
    u64(0n),
    u64(0n),
    u64(0n),
    Buffer.alloc(16),
    Buffer.from([0]),
    u64(1_000_000_000n),
    u64(0n),
    u64(0n),
  ]);
}

function pumpAmmLogs(data: Buffer, program = PUMP_AMM_PROGRAM_ID): string[] {
  return [
    `Program ${program.toBase58()} invoke [1]`,
    `Program data: ${data.toString("base64")}`,
    `Program ${program.toBase58()} success`,
  ];
}

function ix(programId: PublicKey, accounts: PublicKey[], data: Buffer) {
  return { programId, accounts, data: bs58.encode(data) };
}

function curveAccounts(): PublicKey[] {
  const out = Array.from({ length: 27 }, () => OTHER);
  out[1] = MINT;
  out[13] = USER;
  out[15] = WSOL_ATA;
  return out;
}

function ammAccounts(): PublicKey[] {
  const out = Array.from({ length: 20 }, () => OTHER);
  out[0] = POOL;
  out[1] = USER;
  out[3] = MINT;
  out[4] = NATIVE_MINT;
  out[6] = WSOL_ATA;
  return out;
}

function tx(args: {
  instruction: ReturnType<typeof ix>;
  preUser: number;
  postUser: number;
  preTargetRaw?: string;
  postTargetRaw?: string;
  targetPreLamports?: number;
  targetPostLamports?: number;
  preWsolRaw?: string;
  postWsolRaw?: string;
  wsolPreLamports?: number;
  wsolPostLamports?: number;
  fee?: number;
  logMessages?: string[];
}) {
  const keys = [USER, TARGET_ATA, WSOL_ATA];
  const preTokenBalances: any[] = [];
  const postTokenBalances: any[] = [];
  if (args.preTargetRaw != null) {
    preTokenBalances.push({
      accountIndex: 1,
      mint: MINT.toBase58(),
      owner: USER.toBase58(),
      uiTokenAmount: { amount: args.preTargetRaw },
    });
  }
  if (args.postTargetRaw != null) {
    postTokenBalances.push({
      accountIndex: 1,
      mint: MINT.toBase58(),
      owner: USER.toBase58(),
      uiTokenAmount: { amount: args.postTargetRaw },
    });
  }
  if (args.preWsolRaw != null) {
    preTokenBalances.push({
      accountIndex: 2,
      mint: NATIVE_MINT.toBase58(),
      owner: USER.toBase58(),
      uiTokenAmount: { amount: args.preWsolRaw },
    });
  }
  if (args.postWsolRaw != null) {
    postTokenBalances.push({
      accountIndex: 2,
      mint: NATIVE_MINT.toBase58(),
      owner: USER.toBase58(),
      uiTokenAmount: { amount: args.postWsolRaw },
    });
  }
  return {
    slot: 123,
    blockTime: 1_700_000_000,
    transaction: {
      message: {
        accountKeys: keys.map((pubkey) => ({
          pubkey,
          signer: pubkey.equals(USER),
        })),
        instructions: [args.instruction],
      },
      signatures: ["sig"],
    },
    meta: {
      err: null,
      fee: args.fee ?? 5_000,
      preBalances: [
        args.preUser,
        args.targetPreLamports ?? 0,
        args.wsolPreLamports ?? 0,
      ],
      postBalances: [
        args.postUser,
        args.targetPostLamports ?? 0,
        args.wsolPostLamports ?? 0,
      ],
      preTokenBalances,
      postTokenBalances,
      innerInstructions: [],
      logMessages: args.logMessages ?? [],
      loadedAddresses: { writable: [], readonly: [] },
    },
  } as any;
}

function parse(value: any) {
  return parsePumpHistoryTransaction({
    tx: value,
    signature: "5abc",
    mint: MINT.toBase58(),
    decimals: 6,
    supplyUi: 1_000_000_000,
    historyOrder: 1,
    scanAddress: "curve",
    scanKind: "curve",
    confidence: "finalized",
  });
}

describe("Pump token history parser", () => {
  test("curve buy removes network fee and ATA rent from SOL spend", () => {
    const value = tx({
      instruction: ix(
        PUMP_PROGRAM_ID,
        curveAccounts(),
        Buffer.concat([BUY_EXACT_QUOTE_IN_V2_D8, u64(100_000_000n), u64(1n)]),
      ),
      preUser: 1_000_000_000,
      postUser: 897_995_000,
      postTargetRaw: "100000000",
      targetPostLamports: 2_000_000,
    });
    const row = parse(value).trades[0]!;
    expect(row.side).toBe("buy");
    expect(row.solDeltaUi).toBeCloseTo(0.1, 9);
    expect(row.tokenDeltaUi).toBeCloseTo(100, 9);
    expect(row.priceSol).toBeCloseTo(0.001, 12);
  });

  test("excludes an unrelated outer native transfer such as a Jito tip", () => {
    const value = tx({
      instruction: ix(
        PUMP_PROGRAM_ID,
        curveAccounts(),
        Buffer.concat([BUY_EXACT_QUOTE_IN_V2_D8, u64(100_000_000n), u64(1n)]),
      ),
      preUser: 1_000_000_000,
      postUser: 887_995_000,
      postTargetRaw: "100000000",
      targetPostLamports: 2_000_000,
    });
    value.transaction.message.instructions.push({
      program: "system",
      parsed: {
        type: "transfer",
        info: {
          source: USER.toBase58(),
          destination: TIP.toBase58(),
          lamports: 10_000_000,
        },
      },
    });
    const row = parse(value).trades[0]!;
    expect(row.solDeltaUi).toBeCloseTo(0.1, 9);
    expect(row.history.excludedExternalTransfersLamports).toBe("10000000");
  });

  test("curve sell derives net proceeds from the wallet delta", () => {
    const value = tx({
      instruction: ix(
        PUMP_PROGRAM_ID,
        curveAccounts(),
        Buffer.concat([SELL_V2_D8, u64(80_000_000n), u64(1n)]),
      ),
      preUser: 1_000_000_000,
      postUser: 1_079_995_000,
      preTargetRaw: "100000000",
      postTargetRaw: "20000000",
      targetPreLamports: 2_000_000,
      targetPostLamports: 2_000_000,
    });
    const row = parse(value).trades[0]!;
    expect(row.side).toBe("sell");
    expect(row.solDeltaUi).toBeCloseTo(0.08, 9);
    expect(row.tokenDeltaUi).toBeCloseTo(80, 9);
  });

  test("PumpSwap buy accounts for persistent leftover WSOL", () => {
    const value = tx({
      instruction: ix(
        PUMP_AMM_PROGRAM_ID,
        ammAccounts(),
        Buffer.concat([
          AMM_BUY_EXACT_QUOTE_IN_D8,
          u64(100_000_000n),
          u64(1n),
          Buffer.from([1, 1]),
        ]),
      ),
      preUser: 1_000_000_000,
      postUser: 895_995_000,
      postTargetRaw: "80000000",
      targetPostLamports: 2_000_000,
      postWsolRaw: "20000000",
      wsolPostLamports: 22_000_000,
    });
    const row = parse(value).trades[0]!;
    expect(row.history.venue).toBe("pumpswap");
    expect(row.solDeltaUi).toBeCloseTo(0.08, 9);
    expect(row.tokenDeltaUi).toBeCloseTo(80, 9);
  });

  test("PumpSwap sell values proceeds left in WSOL", () => {
    const value = tx({
      instruction: ix(
        PUMP_AMM_PROGRAM_ID,
        ammAccounts(),
        Buffer.concat([AMM_SELL_D8, u64(20_000_000n), u64(1n)]),
      ),
      preUser: 1_000_000_000,
      postUser: 997_995_000,
      preTargetRaw: "80000000",
      postTargetRaw: "60000000",
      targetPreLamports: 2_000_000,
      targetPostLamports: 2_000_000,
      postWsolRaw: "20000000",
      wsolPostLamports: 22_000_000,
    });
    const row = parse(value).trades[0]!;
    expect(row.side).toBe("sell");
    expect(row.solDeltaUi).toBeCloseTo(0.02, 9);
  });

  test("extracts exact PumpSwap buy fees from authenticated AMM event", () => {
    const value = tx({
      instruction: ix(
        PUMP_AMM_PROGRAM_ID,
        ammAccounts(),
        Buffer.concat([
          AMM_BUY_EXACT_QUOTE_IN_D8,
          u64(80_000_000n),
          u64(1n),
          Buffer.from([1, 1]),
        ]),
      ),
      preUser: 1_000_000_000,
      postUser: 915_995_000,
      postTargetRaw: "80000000",
      targetPostLamports: 2_000_000,
      logMessages: pumpAmmLogs(
        pumpSwapBuyEvent({
          userQuoteRaw: 80_000_000n,
          lpFeeRaw: 800_000n,
          protocolFeeRaw: 400_000n,
          creatorFeeRaw: 200_000n,
          buybackFeeRaw: 100_000n,
          holderRewardsRaw: 50_000n,
        }),
      ),
    });
    const fees = parse(value).trades[0]!.history.pumpSwapFees;
    expect(fees).toEqual({
      source: "anchor-event",
      eventCount: 1,
      quoteMint: NATIVE_MINT.toBase58(),
      userQuoteAmountRaw: "80000000",
      lpFeeQuoteRaw: "800000",
      protocolFeeQuoteRaw: "400000",
      creatorFeeQuoteRaw: "200000",
      cashbackQuoteRaw: "0",
      buybackFeeQuoteRaw: "100000",
      holderRewardsQuoteRaw: "50000",
    });
  });

  test("does not trust a forged PumpSwap fee event emitted by another program", () => {
    const value = tx({
      instruction: ix(
        PUMP_AMM_PROGRAM_ID,
        ammAccounts(),
        Buffer.concat([
          AMM_BUY_EXACT_QUOTE_IN_D8,
          u64(80_000_000n),
          u64(1n),
          Buffer.from([1, 1]),
        ]),
      ),
      preUser: 1_000_000_000,
      postUser: 915_995_000,
      postTargetRaw: "80000000",
      targetPostLamports: 2_000_000,
      logMessages: pumpAmmLogs(
        pumpSwapBuyEvent({
          userQuoteRaw: 80_000_000n,
          lpFeeRaw: 800_000n,
          protocolFeeRaw: 400_000n,
          creatorFeeRaw: 200_000n,
        }),
        PUMP_PROGRAM_ID,
      ),
    });
    expect(parse(value).trades[0]!.history.pumpSwapFees).toBeUndefined();
  });

  test("extracts exact PumpSwap sell fee fields", () => {
    const value = tx({
      instruction: ix(
        PUMP_AMM_PROGRAM_ID,
        ammAccounts(),
        Buffer.concat([AMM_SELL_D8, u64(20_000_000n), u64(1n)]),
      ),
      preUser: 1_000_000_000,
      postUser: 1_019_995_000,
      preTargetRaw: "80000000",
      postTargetRaw: "60000000",
      targetPreLamports: 2_000_000,
      targetPostLamports: 2_000_000,
      logMessages: pumpAmmLogs(
        pumpSwapSellEvent({
          userQuoteRaw: 20_000_000n,
          lpFeeRaw: 200_000n,
          protocolFeeRaw: 100_000n,
          creatorFeeRaw: 50_000n,
        }),
      ),
    });
    const fees = parse(value).trades[0]!.history.pumpSwapFees;
    expect(fees?.userQuoteAmountRaw).toBe("20000000");
    expect(fees?.lpFeeQuoteRaw).toBe("200000");
    expect(fees?.protocolFeeQuoteRaw).toBe("100000");
    expect(fees?.creatorFeeQuoteRaw).toBe("50000");
  });

  test("detects Pump create_v2 for coverage proof", () => {
    const createAccounts = [MINT, OTHER, OTHER, OTHER, OTHER, USER];
    const str = (value: string) => {
      const body = Buffer.from(value, "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32LE(body.length);
      return Buffer.concat([len, body]);
    };
    const createData = Buffer.concat([
      CREATE_V2_D8,
      str("Example"),
      str("EX"),
      str("https://example.invalid/meta.json"),
      USER.toBuffer(),
      Buffer.from([0, 0]),
    ]);
    const value = tx({
      instruction: ix(PUMP_PROGRAM_ID, createAccounts, createData),
      preUser: 1_000_000_000,
      postUser: 999_995_000,
    });
    const marker = findPumpHistoryCreateMarker(
      value,
      "create-sig",
      MINT.toBase58(),
    );
    expect(marker?.signature).toBe("create-sig");
    expect(marker?.name).toBe("Example");
    expect(marker?.symbol).toBe("EX");
  });
});
