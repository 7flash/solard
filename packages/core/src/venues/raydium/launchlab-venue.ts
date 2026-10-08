import { randomBytes } from "node:crypto";
import BN from "bn.js";
import {
  PublicKey,
  SystemProgram,
  type Connection,
  type AccountInfo,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  ACCOUNT_SIZE,
  ExtensionType,
  unpackMint,
  unpackAccount,
  getExtensionTypes,
  getTransferFeeConfig,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeAccount3Instruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import {
  LaunchpadPool,
  LaunchpadConfig,
  PlatformConfig,
  LAUNCHPAD_PROGRAM,
  Curve,
  getPdaLaunchpadPoolId,
  getPdaLaunchpadAuth,
  getPdaPlatformVault,
  getPdaCreatorVault,
  getLaunchpadPoolMintAProgram,
  getLaunchpadPoolMintBProgram,
  buyExactInInstruction,
  sellExactInInstruction,
} from "@raydium-io/raydium-sdk-v2";
import {
  SOL_ASSET,
  sameAsset,
  type QuoteAsset,
  type RawAmount,
} from "../../core/amounts.ts";
import type { TokenRow } from "../../db/schema.ts";
import type {
  TradeVenuePlugin,
  VenueContext,
  VenueMarket,
  QuoteResult,
  BuiltInstructions,
  MarketPrice,
} from "../venue-plugin.ts";
import accountsIdl from "./launchlab-accounts.json";

type LaunchLabState = {
  address: PublicKey;
  pool: ReturnType<typeof LaunchpadPool.decode>;
  config: ReturnType<typeof LaunchpadConfig.decode>;
  platform: ReturnType<typeof PlatformConfig.decode>;
  base: ReturnType<typeof unpackMint>;
  quote: ReturnType<typeof unpackMint>;
  baseProgram: PublicKey;
  quoteProgram: PublicKey;
};
function verify(data: Buffer, name: string, minimum: number): void {
  const account = accountsIdl.accounts.find((row) => row.name === name);
  if (
    !account ||
    data.length < minimum ||
    !data
      .subarray(0, account.discriminator.length)
      .equals(Buffer.from(account.discriminator))
  )
    throw new Error(`Invalid LaunchLab ${name} discriminator or account size`);
}
function mintState(address: PublicKey, info: AccountInfo<Buffer> | null) {
  if (
    !info ||
    (!info.owner.equals(TOKEN_PROGRAM_ID) &&
      !info.owner.equals(TOKEN_2022_PROGRAM_ID))
  )
    throw new Error("Invalid LaunchLab mint owner");
  const mint = unpackMint(address, info, info.owner);
  if (!mint.isInitialized) throw new Error("Uninitialized LaunchLab mint");
  const supported = new Set([
    ExtensionType.TransferFeeConfig,
    ExtensionType.MintCloseAuthority,
    ExtensionType.MetadataPointer,
    ExtensionType.TokenMetadata,
  ]);
  if (
    getExtensionTypes(mint.tlvData).some(
      (extension) => !supported.has(extension),
    )
  )
    throw Object.assign(
      new Error(
        "Unsupported LaunchLab token extension (including transfer hooks)",
      ),
      { code: "UNSUPPORTED_TOKEN_EXTENSION" },
    );
  return { mint, program: info.owner };
}
async function readMarket(
  connection: Connection,
  address: PublicKey,
  info?: AccountInfo<Buffer>,
): Promise<LaunchLabState> {
  const account =
    info ?? (await connection.getAccountInfo(address, "confirmed"));
  if (!account?.owner.equals(LAUNCHPAD_PROGRAM))
    throw new Error("Invalid LaunchLab pool owner");
  verify(account.data, "PoolState", LaunchpadPool.span);
  const pool = LaunchpadPool.decode(account.data);
  if (
    !getPdaLaunchpadPoolId(
      LAUNCHPAD_PROGRAM,
      pool.mintA,
      pool.mintB,
    ).publicKey.equals(address)
  )
    throw new Error("LaunchLab pool PDA mint identity mismatch");
  const keys = [
    pool.configId,
    pool.platformId,
    pool.mintA,
    pool.mintB,
    pool.vaultA,
    pool.vaultB,
  ];
  const [configInfo, platformInfo, baseInfo, quoteInfo, vaultA, vaultB] =
    await connection.getMultipleAccountsInfo(keys, "confirmed");
  if (
    !configInfo?.owner.equals(LAUNCHPAD_PROGRAM) ||
    !platformInfo?.owner.equals(LAUNCHPAD_PROGRAM)
  )
    throw new Error("Invalid LaunchLab config/platform owner");
  verify(configInfo.data, "GlobalConfig", LaunchpadConfig.span);
  verify(platformInfo.data, "PlatformConfig", 8);
  const config = LaunchpadConfig.decode(configInfo.data),
    platform = PlatformConfig.decode(platformInfo.data);
  if (!config.mintB.equals(pool.mintB))
    throw new Error("LaunchLab config quote mint mismatch");
  const base = mintState(pool.mintA, baseInfo ?? null),
    quote = mintState(pool.mintB, quoteInfo ?? null);
  if (
    !base.program.equals(getLaunchpadPoolMintAProgram(pool.mintProgramFlag)) ||
    !quote.program.equals(getLaunchpadPoolMintBProgram(pool.mintProgramFlag)) ||
    base.mint.decimals !== pool.mintDecimalsA ||
    quote.mint.decimals !== pool.mintDecimalsB
  )
    throw new Error("LaunchLab pool mint program/decimals mismatch");
  for (const [key, vaultInfo, mint, program] of [
    [pool.vaultA, vaultA, pool.mintA, base.program],
    [pool.vaultB, vaultB, pool.mintB, quote.program],
  ] as const) {
    const vault = unpackAccount(key, vaultInfo ?? null, program);
    if (
      !vault.mint.equals(mint) ||
      !vault.owner.equals(getPdaLaunchpadAuth(LAUNCHPAD_PROGRAM).publicKey)
    )
      throw new Error("LaunchLab vault mint/authority mismatch");
  }
  return {
    address,
    pool,
    config,
    platform,
    base: base.mint,
    quote: quote.mint,
    baseProgram: base.program,
    quoteProgram: quote.program,
  };
}

/** Native instruction-only LaunchLab trades; graduated pools fall through to other venues. */
export class LaunchLabVenue implements TradeVenuePlugin {
  readonly id = "raydium-launchlab";
  private async discover(
    connection: Connection,
    mint: PublicKey,
    token?: TokenRow,
  ): Promise<{ address: PublicKey; info: AccountInfo<Buffer> } | null> {
    const candidates = new Map<string, PublicKey>();
    if (token?.pool) {
      const key = new PublicKey(token.pool);
      candidates.set(key.toBase58(), key);
    }
    for (const quote of [
      new PublicKey(token?.quoteMint ?? NATIVE_MINT.toBase58()),
      NATIVE_MINT,
    ]) {
      const key = getPdaLaunchpadPoolId(
        LAUNCHPAD_PROGRAM,
        mint,
        quote,
      ).publicKey;
      candidates.set(key.toBase58(), key);
    }
    const keys = [...candidates.values()],
      infos = await connection.getMultipleAccountsInfo(keys, "confirmed");
    for (let i = 0; i < keys.length; i++) {
      const info = infos[i];
      if (!info?.owner.equals(LAUNCHPAD_PROGRAM)) continue;
      verify(info.data, "PoolState", LaunchpadPool.span);
      const pool = LaunchpadPool.decode(info.data);
      if (pool.mintA.equals(mint) && pool.status === 0)
        return { address: keys[i]!, info };
    }
    // Custom quotes cannot be inferred from a mint suffix or a WSOL balance.
    const rows = await connection.getProgramAccounts(LAUNCHPAD_PROGRAM, {
      commitment: "confirmed",
      filters: [
        {
          memcmp: {
            offset: LaunchpadPool.offsetOf("mintA"),
            bytes: mint.toBase58(),
          },
        },
      ],
    });
    const matching = rows.filter((row) => {
      if (!row.account.owner.equals(LAUNCHPAD_PROGRAM)) return false;
      verify(row.account.data, "PoolState", LaunchpadPool.span);
      const pool = LaunchpadPool.decode(row.account.data);
      return pool.mintA.equals(mint) && pool.status === 0;
    });
    if (matching.length > 1)
      throw new Error(
        "Ambiguous LaunchLab pools; register the explicit pool and quote mint",
      );
    return matching[0]
      ? { address: matching[0].pubkey, info: matching[0].account }
      : null;
  }
  async inspectToken(
    connection: Connection,
    mint: PublicKey,
  ): Promise<Partial<TokenRow> | null> {
    const selected = await this.discover(connection, mint);
    if (!selected) return null;
    const state = await readMarket(connection, selected.address, selected.info);
    return {
      pool: selected.address.toBase58(),
      quoteMint: state.pool.mintB.toBase58(),
      quoteTokenProgram: state.quoteProgram.toBase58(),
      baseTokenProgram: state.baseProgram.toBase58(),
      creator: state.pool.creator.toBase58(),
      decimals: state.base.decimals,
      venueHint: this.id as TokenRow["venueHint"],
      metadataJson: JSON.stringify({
        nativeVenue: this.id,
        quoteDecimals: state.quote.decimals,
        launchConfig: state.pool.configId.toBase58(),
        platformConfig: state.pool.platformId.toBase58(),
      }),
    };
  }
  async resolveMarket(ctx: VenueContext): Promise<VenueMarket | null> {
    const mint = new PublicKey(ctx.token.mint),
      selected = await this.discover(ctx.connection, mint, ctx.token);
    if (!selected) return null;
    if (ctx.reserves)
      throw new Error(
        "LaunchLab requires its curve state; caller vault-only reserves are unsupported",
      );
    const state = await readMarket(
      ctx.connection,
      selected.address,
      selected.info,
    );
    const quoteAsset: QuoteAsset = state.pool.mintB.equals(NATIVE_MINT)
      ? SOL_ASSET
      : {
          kind: "spl-token",
          mint: state.pool.mintB,
          tokenProgram: state.quoteProgram,
          decimals: state.quote.decimals,
        };
    return {
      venue: this.id,
      mint,
      quoteAsset,
      baseTokenProgram: state.baseProgram,
      creator: state.pool.creator,
      metadata: { launchlab: state },
    };
  }
  private async quote(
    ctx: VenueContext,
    market: VenueMarket,
    amount: bigint,
    bps: number,
    buy: boolean,
  ): Promise<QuoteResult> {
    if (amount <= 0n || !Number.isInteger(bps) || bps < 0 || bps >= 10000)
      throw new Error("Invalid LaunchLab amount or slippage");
    const state = market.metadata.launchlab as LaunchLabState;
    const parameters = {
      poolInfo: state.pool,
      protocolFeeRate: state.config.tradeFeeRate,
      platformFeeRate: state.platform.feeRate,
      creatorFeeRate: state.platform.creatorFeeRate,
      curveType: state.config.curveType,
      shareFeeRate: new BN(0),
      transferFeeConfigA: getTransferFeeConfig(state.base) ?? undefined,
      transferFeeConfigB: getTransferFeeConfig(state.quote) ?? undefined,
      slot: await ctx.connection.getSlot("confirmed"),
    };
    const calculated = buy
      ? Curve.buyExactIn({ ...parameters, amountB: new BN(amount.toString()) })
      : Curve.sellExactIn({
          ...parameters,
          amountA: new BN(amount.toString()),
        });
    if (buy && calculated.amountB.toString() !== amount.toString())
      throw new Error(
        "LaunchLab buy exceeds remaining curve input; refresh graduated route",
      );
    const expected = BigInt(
      (buy
        ? calculated.amountA.amount.sub(calculated.amountA.fee ?? new BN(0))
        : calculated.amountB
      ).toString(),
    );
    const minimum = (expected * BigInt(10000 - bps)) / 10000n;
    if (minimum <= 0n)
      throw new Error("LaunchLab quote resolves to zero guaranteed output");
    return {
      venue: this.id,
      quoteAsset: market.quoteAsset,
      inputRaw: amount,
      expectedOutputRaw: expected,
      minimumOutputRaw: minimum,
      meta: {
        pool: state.address.toBase58(),
        quoteMint: state.pool.mintB.toBase58(),
        quoteTransferFeeRaw: calculated.transferFeeB?.toString() ?? "0",
      },
    };
  }
  quoteBuy(
    ctx: VenueContext,
    market: VenueMarket,
    amount: RawAmount,
    bps: number,
  ) {
    if (!sameAsset(amount.asset, market.quoteAsset))
      throw new Error("LaunchLab buy quote asset mismatch");
    return this.quote(ctx, market, amount.raw, bps, true);
  }
  quoteSell(
    ctx: VenueContext,
    market: VenueMarket,
    amount: bigint,
    bps: number,
  ) {
    return this.quote(ctx, market, amount, bps, false);
  }
  async price(_ctx: VenueContext, market: VenueMarket): Promise<MarketPrice> {
    const state = market.metadata.launchlab as LaunchLabState;
    const price = Curve.getPrice({
      poolInfo: state.pool,
      curveType: state.config.curveType,
      decimalA: state.base.decimals,
      decimalB: state.quote.decimals,
    }).toNumber();
    if (!Number.isFinite(price) || price <= 0)
      throw new Error("Invalid LaunchLab reserve price");
    return {
      venue: this.id,
      mint: market.mint,
      quoteAsset: market.quoteAsset,
      priceQuotePerToken: price,
      capturedAtMs: Date.now(),
    };
  }
  private async build(
    ctx: VenueContext,
    market: VenueMarket,
    quote: QuoteResult,
    buy: boolean,
  ): Promise<BuiltInstructions> {
    const state = market.metadata.launchlab as LaunchLabState;
    const baseAta = getAssociatedTokenAddressSync(
      state.pool.mintA,
      ctx.user,
      true,
      state.baseProgram,
    );
    let quoteAccount = getAssociatedTokenAddressSync(
      state.pool.mintB,
      ctx.user,
      true,
      state.quoteProgram,
    );
    const instructions: Array<TransactionInstruction> = [
      createAssociatedTokenAccountIdempotentInstruction(
        ctx.user,
        baseAta,
        ctx.user,
        state.pool.mintA,
        state.baseProgram,
      ),
    ];
    const cleanup: Array<TransactionInstruction> = [];
    let temporaryRentLamports = 0;
    if (market.quoteAsset.kind === "native-sol") {
      const seed = randomBytes(16).toString("hex");
      quoteAccount = await PublicKey.createWithSeed(
        ctx.user,
        seed,
        TOKEN_PROGRAM_ID,
      );
      temporaryRentLamports =
        await ctx.connection.getMinimumBalanceForRentExemption(
          ACCOUNT_SIZE,
          "confirmed",
        );
      instructions.push(
        SystemProgram.createAccountWithSeed({
          fromPubkey: ctx.user,
          basePubkey: ctx.user,
          newAccountPubkey: quoteAccount,
          seed,
          lamports: temporaryRentLamports,
          space: ACCOUNT_SIZE,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeAccount3Instruction(
          quoteAccount,
          NATIVE_MINT,
          ctx.user,
          TOKEN_PROGRAM_ID,
        ),
      );
      if (buy)
        instructions.push(
          SystemProgram.transfer({
            fromPubkey: ctx.user,
            toPubkey: quoteAccount,
            lamports: quote.inputRaw,
          }),
          createSyncNativeInstruction(quoteAccount, TOKEN_PROGRAM_ID),
        );
      cleanup.push(
        createCloseAccountInstruction(
          quoteAccount,
          ctx.user,
          ctx.user,
          [],
          TOKEN_PROGRAM_ID,
        ),
      );
    } else
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          ctx.user,
          quoteAccount,
          ctx.user,
          state.pool.mintB,
          state.quoteProgram,
        ),
      );
    const builder = buy ? buyExactInInstruction : sellExactInInstruction;
    instructions.push(
      builder(
        LAUNCHPAD_PROGRAM,
        ctx.user,
        getPdaLaunchpadAuth(LAUNCHPAD_PROGRAM).publicKey,
        state.pool.configId,
        state.pool.platformId,
        state.address,
        baseAta,
        quoteAccount,
        state.pool.vaultA,
        state.pool.vaultB,
        state.pool.mintA,
        state.pool.mintB,
        state.baseProgram,
        state.quoteProgram,
        getPdaPlatformVault(
          LAUNCHPAD_PROGRAM,
          state.pool.platformId,
          state.pool.mintB,
        ).publicKey,
        getPdaCreatorVault(
          LAUNCHPAD_PROGRAM,
          state.pool.creator,
          state.pool.mintB,
        ).publicKey,
        new BN(quote.inputRaw.toString()),
        new BN(quote.minimumOutputRaw.toString()),
      ),
      ...cleanup,
    );
    return {
      venue: this.id,
      quoteAsset: market.quoteAsset,
      instructions,
      minOutputRaw: quote.minimumOutputRaw,
      expectedOutputRaw: quote.expectedOutputRaw,
      meta: { temporaryRentLamports, pool: state.address.toBase58() },
    };
  }
  buildBuy(ctx: VenueContext, market: VenueMarket, quote: QuoteResult) {
    return this.build(ctx, market, quote, true);
  }
  buildSell(ctx: VenueContext, market: VenueMarket, quote: QuoteResult) {
    return this.build(ctx, market, quote, false);
  }
}
