import {
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
  type Connection,
} from "@solana/web3.js";
import {
  unpackMint,
  getTransferFeeConfig,
  getExtensionTypes,
  ExtensionType,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Raydium,
  LaunchpadConfig,
  PlatformConfig,
  LAUNCHPAD_PROGRAM,
  getPdaLaunchpadConfigId,
  getPdaLaunchpadAuth,
  getPdaPlatformVault,
  getPdaCreatorVault,
  buyExactInInstruction,
  Curve,
  TxVersion,
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import { SOL_ASSET, sameAsset, type RawAmount } from "../../core/amounts.ts";
import type {
  TokenLaunchpadPlugin,
  PrepareDeploymentArgs,
  PreparedTokenDeployment,
  PreparedPendingBuy,
} from "../launchpad.ts";

/** Primary reference: Raydium's SDK demo createBonkMintApi.ts. */
export const BONKFUN_PLATFORM_CONFIG = new PublicKey(
  "8pCtbn9iatQ8493mDQax4xfEUjhoVBpUWYVQoRU18333",
);
export const RAYDIUM_PLATFORM_CONFIG = new PublicKey(
  "4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4",
);
/** Official StonkFun /api/public/v1/launchlab/platforms, verified on-chain 2026-10-07. */
export const STONKFUN_PLATFORM_CONFIG = new PublicKey(
  "4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7",
);
export const STONKFUN_REWARD_PLATFORM_CONFIG = new PublicKey(
  "6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt",
);
export const STONKFUN_COMMUNITY_PLATFORM_CONFIG = new PublicKey(
  "CUqSiwPs6C4WyntMgaFazLp7wYQfaLp5URbjUP9V7SNi",
);
export const LAUNCHLAB_PLATFORM_PRESETS = Object.freeze({
  raydium: RAYDIUM_PLATFORM_CONFIG,
  bonkfun: BONKFUN_PLATFORM_CONFIG,
  stonkfun: STONKFUN_PLATFORM_CONFIG,
  "stonkfun-reward": STONKFUN_REWARD_PLATFORM_CONFIG,
  "stonkfun-community": STONKFUN_COMMUNITY_PLATFORM_CONFIG,
});
export function resolveLaunchLabPlatform(
  value?: string | PublicKey,
): PublicKey {
  if (!value) return RAYDIUM_PLATFORM_CONFIG;
  if (
    typeof value === "string" &&
    Object.hasOwn(LAUNCHLAB_PLATFORM_PRESETS, value)
  )
    return LAUNCHLAB_PLATFORM_PRESETS[
      value as keyof typeof LAUNCHLAB_PLATFORM_PRESETS
    ];
  return new PublicKey(value);
}

type Loader = (connection: Connection, user: PublicKey) => Promise<any>;
const loadSdk: Loader = (connection, owner) =>
  Raydium.load({
    connection: connection as unknown as Parameters<
      typeof Raydium.load
    >[0]["connection"],
    owner,
    cluster: "mainnet",
    disableLoadToken: true,
    blockhashCommitment: "confirmed",
  });

/** Instruction-only preparation; URI must already identify uploaded metadata. */
export class LaunchLabTokenLaunchpad implements TokenLaunchpadPlugin {
  readonly id = "launchlab";
  private readonly pending = new WeakMap<
    PreparedTokenDeployment,
    {
      pool: any;
      config: any;
      platform: any;
      transferFee: ReturnType<typeof getTransferFeeConfig>;
    }
  >();
  constructor(private readonly loader: Loader = loadSdk) {}
  async prepareDeployment(
    connection: Connection,
    args: PrepareDeploymentArgs,
  ): Promise<PreparedTokenDeployment> {
    if (
      !args.name.trim() ||
      !args.symbol.trim() ||
      args.symbol.length > 10 ||
      !args.uri.trim()
    )
      throw new Error(
        "LaunchLab requires name, symbol (1–10 characters), and an uploaded metadata URI",
      );
    if (args.creator && !args.creator.equals(args.user))
      throw new Error("LaunchLab creator must be the transaction payer");
    if (args.mayhemMode || args.cashback)
      throw new Error("Pump-only launch flags are unsupported by LaunchLab");
    const decimals = args.decimals ?? 6;
    const slippageBps = args.slippageBps ?? 500;
    if (
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 18 ||
      !Number.isInteger(slippageBps) ||
      slippageBps < 0 ||
      slippageBps >= 10000
    )
      throw new Error("Invalid LaunchLab decimals or slippage");
    const quoteAsset = args.quoteAsset ?? SOL_ASSET;
    const configId = args.launchConfig
      ? new PublicKey(args.launchConfig)
      : getPdaLaunchpadConfigId(LAUNCHPAD_PROGRAM, quoteAsset.mint, 0, 0)
          .publicKey;
    const platformId = resolveLaunchLabPlatform(args.platformConfig);
    const [configAccount, platformAccount, quoteAccount] =
      await connection.getMultipleAccountsInfo(
        [configId, platformId, quoteAsset.mint],
        "confirmed",
      );
    if (
      !configAccount?.owner.equals(LAUNCHPAD_PROGRAM) ||
      !platformAccount?.owner.equals(LAUNCHPAD_PROGRAM)
    )
      throw new Error(
        "LaunchLab config/platform is missing or has the wrong program owner",
      );
    const config = LaunchpadConfig.decode(configAccount.data);
    const platform = PlatformConfig.decode(platformAccount.data);
    if (!config.mintB.equals(quoteAsset.mint))
      throw new Error(
        "LaunchLab quote mint does not match the selected on-chain config",
      );
    if (
      !quoteAccount ||
      (!quoteAccount.owner.equals(TOKEN_PROGRAM_ID) &&
        !quoteAccount.owner.equals(TOKEN_2022_PROGRAM_ID))
    )
      throw new Error("Unsupported LaunchLab quote mint owner");
    const quoteMint = unpackMint(
      quoteAsset.mint,
      quoteAccount,
      quoteAccount.owner,
    );
    if (
      !quoteMint.isInitialized ||
      quoteMint.decimals !== quoteAsset.decimals ||
      !quoteAccount.owner.equals(quoteAsset.tokenProgram)
    )
      throw new Error(
        "LaunchLab quote metadata does not match its mint account",
      );
    const supportedExtensions = new Set([
      ExtensionType.TransferFeeConfig,
      ExtensionType.MintCloseAuthority,
      ExtensionType.MetadataPointer,
      ExtensionType.TokenMetadata,
    ]);
    const unsupported = getExtensionTypes(quoteMint.tlvData).filter(
      (extension) => !supportedExtensions.has(extension),
    );
    if (unsupported.length)
      throw Object.assign(
        new Error(
          `LaunchLab quote mint has unsupported Token-2022 extensions: ${unsupported.map((extension) => ExtensionType[extension]).join(", ")}`,
        ),
        { code: "UNSUPPORTED_TOKEN_EXTENSION" },
      );
    if (
      args.initialBuy &&
      (!sameAsset(args.initialBuy.asset, quoteAsset) ||
        args.initialBuy.raw <= 0n)
    )
      throw Object.assign(
        new Error(
          "LaunchLab creator buy requires a positive amount in the configured quote asset; SOL funding for custom quotes must be composed atomically first",
        ),
        { code: "QUOTE_ASSET_MISMATCH" },
      );
    const mint = args.mint ?? Keypair.generate();
    const sdk = await this.loader(connection, args.user);
    const built = await sdk.launchpad.createLaunchpad({
      programId: LAUNCHPAD_PROGRAM,
      platformId,
      mintA: mint.publicKey,
      name: args.name,
      symbol: args.symbol,
      uri: args.uri,
      configId,
      configInfo: config,
      decimals,
      mintBDecimals: quoteMint.decimals,
      mintBProgram: quoteAccount.owner,
      migrateType: "cpmm",
      createOnly: !args.initialBuy,
      buyAmount: new BN((args.initialBuy?.raw ?? 1n).toString()),
      slippage: new BN(slippageBps),
      txVersion: TxVersion.LEGACY,
      extraSigners: [mint],
    });
    const instructions = built.builder?.allInstructions;
    if (!Array.isArray(instructions) || instructions.length === 0)
      throw new Error("LaunchLab SDK returned no deployment instructions");
    const poolId = built.extInfo?.address?.poolId;
    if (!poolId) throw new Error("LaunchLab SDK returned no pool identity");
    const deployment: PreparedTokenDeployment = {
      launchpad: this.id,
      mint,
      user: args.user,
      creator: args.user,
      quoteAsset,
      instructions: instructions.filter(
        (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
      ),
      signers: [mint],
      token: {
        mint: mint.publicKey.toBase58(),
        name: args.name,
        symbol: args.symbol,
        decimals,
        baseTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
        quoteMint: quoteAsset.mint.toBase58(),
        quoteTokenProgram: quoteAsset.tokenProgram.toBase58(),
        pool: poolId.toBase58(),
        venueHint: "raydium-launchlab",
        metadataJson: JSON.stringify({
          launchpad: this.id,
          platformConfig: platformId.toBase58(),
          launchConfig: configId.toBase58(),
          quoteDecimals: quoteAsset.decimals,
        }),
      },
      metadata: {
        pool: poolId.toBase58(),
        platformConfig: platformId.toBase58(),
        launchConfig: configId.toBase58(),
        expectedOutputRaw:
          built.extInfo?.swapInfo?.decimalOutAmount?.toFixed(0) ?? null,
        minimumOutputRaw:
          built.extInfo?.swapInfo?.minDecimalOutAmount?.toFixed(0) ?? null,
        protocolTradeFeeRate: config.tradeFeeRate.toString(),
        platformTradeFeeRate: platform.feeRate.toString(),
        creatorTradeFeeRate: platform.creatorFeeRate.toString(),
        feeRateDenominator: "1000000",
        migrationFeeRaw: config.migrateFee.toString(),
        initialBuyRaw: (args.initialBuy?.raw ?? 0n).toString(),
        networkFeeLamports: null,
        accountRentLamports: null,
        costsRequireSimulation: true,
        uri: args.uri,
      },
    };
    if (!args.initialBuy)
      this.pending.set(deployment, {
        pool: built.extInfo.address,
        config,
        platform,
        transferFee: getTransferFeeConfig(quoteMint),
      });
    return deployment;
  }

  async initialPendingMarketState(
    _connection: Connection,
    deployment: PreparedTokenDeployment,
  ): Promise<unknown> {
    const state = this.pending.get(deployment);
    if (!state)
      throw new Error(
        "LaunchLab pending state requires a create-only deployment prepared by this plugin",
      );
    return state;
  }

  async buildPendingBuy(
    connection: Connection,
    deployment: PreparedTokenDeployment,
    buyer: PublicKey,
    amount: RawAmount,
    state: unknown,
    options: { slippageBps?: number } = {},
  ): Promise<PreparedPendingBuy> {
    const initial = this.pending.get(deployment);
    const pending = state as NonNullable<typeof initial>;
    if (
      !initial ||
      !pending ||
      pending.config !== initial.config ||
      pending.platform !== initial.platform ||
      !pending.pool.mintA.equals(deployment.mint.publicKey)
    )
      throw new Error("Invalid LaunchLab pending state");
    for (const key of [
      "poolId",
      "mintB",
      "configId",
      "platformId",
      "vaultA",
      "vaultB",
    ])
      if (!pending.pool[key]?.equals(initial.pool[key]))
        throw new Error("Pending LaunchLab pool identity mismatch");
    if (deployment.quoteAsset.kind === "native-sol")
      throw new Error(
        "Use initialBuy for an atomic SOL-quoted LaunchLab creator buy",
      );
    if (!sameAsset(amount.asset, deployment.quoteAsset) || amount.raw <= 0n)
      throw new Error(
        "Pending LaunchLab buy must use the configured quote asset",
      );
    const slippage = options.slippageBps ?? 500;
    if (!Number.isInteger(slippage) || slippage < 0 || slippage >= 10000)
      throw new Error("Invalid pending LaunchLab slippage");
    const calculated = Curve.buyExactIn({
      poolInfo: pending.pool,
      amountB: new BN(amount.raw.toString()),
      protocolFeeRate: pending.config.tradeFeeRate,
      platformFeeRate: pending.platform.feeRate,
      creatorFeeRate: pending.platform.creatorFeeRate,
      curveType: pending.config.curveType,
      shareFeeRate: new BN(0),
      transferFeeConfigA: undefined,
      transferFeeConfigB: pending.transferFee ?? undefined,
      slot: await connection.getSlot("confirmed"),
    });
    // Reject graduation truncation rather than silently leaving funded quote inventory.
    if (calculated.amountB.toString() !== amount.raw.toString())
      throw new Error(
        "Pending LaunchLab buy exceeds the remaining curve input",
      );
    const expected = BigInt(
      calculated.amountA.amount
        .sub(calculated.amountA.fee ?? new BN(0))
        .toString(),
    );
    const minimum = (expected * BigInt(10000 - slippage)) / 10000n;
    if (minimum <= 0n)
      throw new Error("Pending LaunchLab buy resolves to zero minimum output");
    const quote = deployment.quoteAsset;
    const baseAta = getAssociatedTokenAddressSync(
      deployment.mint.publicKey,
      buyer,
      true,
      TOKEN_PROGRAM_ID,
    );
    const quoteAta = getAssociatedTokenAddressSync(
      quote.mint,
      buyer,
      true,
      quote.tokenProgram,
    );
    const pool = pending.pool;
    const fees = Object.values(calculated.splitFee).reduce(
      (sum: BN, fee: BN) => sum.add(fee),
      new BN(0),
    );
    return {
      launchpad: this.id,
      mint: deployment.mint.publicKey,
      quoteAsset: quote,
      buyer,
      expectedOutputRaw: expected,
      minimumOutputRaw: minimum,
      instructions: [
        createAssociatedTokenAccountIdempotentInstruction(
          buyer,
          baseAta,
          buyer,
          deployment.mint.publicKey,
          TOKEN_PROGRAM_ID,
        ),
        createAssociatedTokenAccountIdempotentInstruction(
          buyer,
          quoteAta,
          buyer,
          quote.mint,
          quote.tokenProgram,
        ),
        buyExactInInstruction(
          LAUNCHPAD_PROGRAM,
          buyer,
          getPdaLaunchpadAuth(LAUNCHPAD_PROGRAM).publicKey,
          pool.configId,
          pool.platformId,
          pool.poolId,
          baseAta,
          quoteAta,
          pool.vaultA,
          pool.vaultB,
          pool.mintA,
          pool.mintB,
          TOKEN_PROGRAM_ID,
          quote.tokenProgram,
          getPdaPlatformVault(LAUNCHPAD_PROGRAM, pool.platformId, quote.mint)
            .publicKey,
          getPdaCreatorVault(LAUNCHPAD_PROGRAM, deployment.creator, quote.mint)
            .publicKey,
          new BN(amount.raw.toString()),
          new BN(minimum.toString()),
        ),
      ],
      nextState: {
        ...pending,
        pool: {
          ...pool,
          realA: pool.realA.add(calculated.amountA.amount),
          realB: pool.realB.add(
            calculated.amountB
              .sub(calculated.transferFeeB ?? new BN(0))
              .sub(fees),
          ),
        },
      },
      metadata: {
        inputRaw: amount.raw.toString(),
        minOutputRaw: minimum.toString(),
        expectedOutputRaw: expected.toString(),
        quoteTransferFeeRaw: calculated.transferFeeB?.toString() ?? "0",
        quoteTradeFeeRaw: fees.toString(),
        slippageBps: slippage,
      },
    };
  }
}
