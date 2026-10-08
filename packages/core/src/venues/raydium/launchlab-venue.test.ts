import { expect, test } from "bun:test";
import BN from "bn.js";
import {
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type AccountInfo,
} from "@solana/web3.js";
import {
  MintLayout,
  AccountLayout,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  LaunchpadPool,
  LaunchpadConfig,
  PlatformConfig,
  LAUNCHPAD_PROGRAM,
  getPdaLaunchpadPoolId,
  getPdaLaunchpadAuth,
} from "@raydium-io/raydium-sdk-v2";
import { defaultPumpQuoteShell } from "../pump/common.ts";
import { SOL_ASSET, rawAmount } from "../../core/amounts.ts";
import { LaunchLabVenue } from "./launchlab-venue.ts";
import accountsIdl from "./launchlab-accounts.json";

const user = new PublicKey("4jxDfXDLRh3fJvQxPhuV5uMt4YLEsaM6QNYFuMddbCen");
const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
function fixture(custom = false) {
  const mint = key(1),
    quoteMint = custom ? key(2) : NATIVE_MINT,
    pool = getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mint, quoteMint).publicKey;
  const config = key(3),
    platform = key(4),
    vaultA = key(5),
    vaultB = key(6);
  const accounts = new Map<string, AccountInfo<Buffer>>();
  const info = (data: Buffer, owner = LAUNCHPAD_PROGRAM) => ({
    data,
    owner,
    lamports: 1,
    executable: false,
    rentEpoch: 0,
  });
  function discriminator(data: Buffer, name: string) {
    Buffer.from(
      accountsIdl.accounts.find((row) => row.name === name)!.discriminator,
    ).copy(data);
  }
  const poolData = Buffer.alloc(LaunchpadPool.span),
    decoded = LaunchpadPool.decode(poolData);
  Object.assign(decoded, {
    mintA: mint,
    mintB: quoteMint,
    configId: config,
    platformId: platform,
    vaultA,
    vaultB,
    creator: user,
    mintDecimalsA: 6,
    mintDecimalsB: custom ? 6 : 9,
    status: 0,
    mintProgramFlag: custom ? 2 : 0,
    virtualA: new BN(1_000_000_000),
    virtualB: new BN(1_000_000_000),
    realA: new BN(100_000_000),
    realB: new BN(100_000_000),
    totalSellA: new BN(900_000_000),
    totalFundRaisingB: new BN(1_000_000_000),
  });
  LaunchpadPool.encode(decoded, poolData);
  discriminator(poolData, "PoolState");
  accounts.set(pool.toBase58(), info(poolData));
  const configData = Buffer.alloc(LaunchpadConfig.span);
  quoteMint.toBuffer().copy(configData, LaunchpadConfig.offsetOf("mintB"));
  configData.writeBigUInt64LE(1000n, LaunchpadConfig.offsetOf("tradeFeeRate"));
  discriminator(configData, "GlobalConfig");
  accounts.set(config.toBase58(), info(configData));
  const platformData = Buffer.alloc(4096);
  platformData.writeBigUInt64LE(2000n, PlatformConfig.offsetOf("feeRate"));
  discriminator(platformData, "PlatformConfig");
  accounts.set(platform.toBase58(), info(platformData));
  function tokenMint(address: PublicKey, decimals: number, program: PublicKey) {
    const data = Buffer.alloc(MintLayout.span);
    MintLayout.encode(
      {
        mintAuthorityOption: 0,
        mintAuthority: PublicKey.default,
        supply: 1_000_000_000n,
        decimals,
        isInitialized: true,
        freezeAuthorityOption: 0,
        freezeAuthority: PublicKey.default,
      },
      data,
    );
    accounts.set(address.toBase58(), info(data, program));
  }
  tokenMint(mint, 6, TOKEN_PROGRAM_ID);
  tokenMint(
    quoteMint,
    custom ? 6 : 9,
    custom ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
  );
  function tokenAccount(
    address: PublicKey,
    tokenMint: PublicKey,
    program: PublicKey,
  ) {
    const data = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode(
      {
        mint: tokenMint,
        owner: getPdaLaunchpadAuth(LAUNCHPAD_PROGRAM).publicKey,
        amount: 1_000_000_000n,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      data,
    );
    accounts.set(address.toBase58(), info(data, program));
  }
  tokenAccount(vaultA, mint, TOKEN_PROGRAM_ID);
  tokenAccount(
    vaultB,
    quoteMint,
    custom ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
  );
  const connection = {
    async getAccountInfo(address: PublicKey) {
      return accounts.get(address.toBase58()) ?? null;
    },
    async getMultipleAccountsInfo(addresses: Array<PublicKey>) {
      return addresses.map(
        (address) => accounts.get(address.toBase58()) ?? null,
      );
    },
    async getProgramAccounts() {
      return [];
    },
    async getSlot() {
      return 100;
    },
    async getMinimumBalanceForRentExemption() {
      return 2_039_280;
    },
  } as unknown as Connection;
  const token = {
    ...defaultPumpQuoteShell(mint),
    pool: pool.toBase58(),
    quoteMint: quoteMint.toBase58(),
  };
  return {
    connection,
    token,
    mint,
    pool,
    vaultB,
    accounts,
    poolData,
    quoteMint,
  };
}

test("native LaunchLab builds exact buy/sell instructions and isolated temporary WSOL", async () => {
  const f = fixture(),
    venue = new LaunchLabVenue(),
    ctx = { connection: f.connection, token: f.token, user };
  const market = await venue.resolveMarket(ctx);
  expect(market).not.toBeNull();
  expect((await venue.inspectToken(f.connection, f.mint))?.venueHint).toBe(
    "raydium-launchlab",
  );
  const buy = await venue.quoteBuy(
    ctx,
    market!,
    rawAmount(1_000_000n, SOL_ASSET),
    500,
  );
  const built = await venue.buildBuy(ctx, market!, buy);
  const swap = built.instructions.find((ix) =>
    ix.programId.equals(LAUNCHPAD_PROGRAM),
  )!;
  expect(swap.data.readBigUInt64LE(8)).toBe(1_000_000n);
  expect(swap.data.readBigUInt64LE(16)).toBe(buy.minimumOutputRaw);
  const create = built.instructions.find(
    (ix) =>
      ix.programId.equals(SystemProgram.programId) &&
      SystemInstruction.decodeInstructionType(ix) === "CreateWithSeed",
  )!;
  const temporary =
    SystemInstruction.decodeCreateWithSeed(create).newAccountPubkey;
  expect(
    temporary.equals(getAssociatedTokenAddressSync(NATIVE_MINT, user)),
  ).toBe(false);
  expect(built.instructions.at(-1)!.keys[0]!.pubkey.equals(temporary)).toBe(
    true,
  );
  const unsigned = new VersionedTransaction(
    new TransactionMessage({
      payerKey: user,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: built.instructions,
    }).compileToV0Message(),
  );
  expect(unsigned.serialize().length).toBeLessThanOrEqual(1232);
  const sell = await venue.quoteSell(ctx, market!, 284725n, 500),
    sellBuilt = await venue.buildSell(ctx, market!, sell);
  const sellSwap = sellBuilt.instructions.find((ix) =>
    ix.programId.equals(LAUNCHPAD_PROGRAM),
  )!;
  expect(sellSwap.data.readBigUInt64LE(8)).toBe(284725n);
  expect(sellSwap.data.readBigUInt64LE(16)).toBe(sell.minimumOutputRaw);
  expect(sell.minimumOutputRaw).toBeGreaterThan(0n);
});

test("custom Token-2022 quote identity is verified and quoted in its actual units", async () => {
  const f = fixture(true),
    venue = new LaunchLabVenue(),
    ctx = { connection: f.connection, token: f.token, user };
  const market = await venue.resolveMarket(ctx);
  expect(market?.quoteAsset.kind).toBe("spl-token");
  expect(market?.quoteAsset.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)).toBe(
    true,
  );
  const quote = await venue.quoteBuy(
    ctx,
    market!,
    rawAmount(1_000_000n, market!.quoteAsset),
    500,
  );
  const built = await venue.buildBuy(ctx, market!, quote);
  expect(built.instructions).toHaveLength(3);
  expect(built.instructions[2]!.data.readBigUInt64LE(16)).toBe(
    quote.minimumOutputRaw,
  );
});

test("graduation falls through and mismatched vaults/config/owners fail before signing", async () => {
  const f = fixture(),
    venue = new LaunchLabVenue(),
    ctx = { connection: f.connection, token: f.token, user };
  const statusOffset = LaunchpadPool.offsetOf("status");
  f.poolData[statusOffset] = 2;
  expect(await venue.resolveMarket(ctx)).toBeNull();
  f.poolData[statusOffset] = 0;
  f.accounts.get(f.vaultB.toBase58())!.data.fill(0, 0, 32);
  await expect(venue.resolveMarket(ctx)).rejects.toThrow(
    "vault mint/authority",
  );
});
