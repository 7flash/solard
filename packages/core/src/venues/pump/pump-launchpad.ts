import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { OnlinePumpSdk, PUMP_SDK, newBondingCurve, holderRewardsPda } from "@pump-fun/pump-sdk";
import { readMint } from "../../chain/state.ts";
import { SOL_ASSET, sameAsset, type RawAmount } from "../../core/amounts.ts";
import type {
  PendingMarketState,
  PreparedPendingBuy,
  PreparedTokenDeployment,
  PrepareDeploymentArgs,
  TokenLaunchpadPlugin,
} from "../../launches/launchpad.ts";
import type { TokenRow } from "../../db/schema.ts";
import { configuredTotalFeeBps } from "./common.ts";
import { TOKEN_2022_ID, WRAPPED_SOL_MINT } from "./constants.ts";
import { bondingCurvePda } from "./pda.ts";
import { buildCreateV2, buildCurveBuyV2 } from "./pump-instructions.ts";
import { quoteBuyConstantProduct } from "./quote.ts";
import { resolvePumpRouting } from "./routing.ts";
import { fetchInitialSolCurveState } from "./state.ts";

export type PumpPendingCurveState = {
  virtualBase: bigint;
  virtualQuote: bigint;
  totalFeeBps: number;
};

function tokenForDeployment(deployment: PreparedTokenDeployment): TokenRow {
  const now = Date.now();
  return {
    id: 0,
    mint: deployment.mint.publicKey.toBase58(),
    name: deployment.token.name ?? null,
    symbol: deployment.token.symbol ?? null,
    decimals: 6,
    createKind: "create_v2",
    creator: deployment.creator.toBase58(),
    quoteMint: deployment.quoteAsset.mint.toBase58(),
    quoteTokenProgram: deployment.quoteAsset.tokenProgram.toBase58(),
    baseTokenProgram: TOKEN_2022_ID.toBase58(),
    bondingCurve: bondingCurvePda(deployment.mint.publicKey).toBase58(),
    pool: null,
    sharingConfig: null,
    venueHint: "pump-curve",
    metadataJson: JSON.stringify({
      pendingDeployment: true,
      ...(deployment.metadata ?? {}),
    }),
    refreshedAtMs: null,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

/** Direct Pump create_v2 launchpad. The mint keypair is produced client-side,
 * therefore its public address is available before submission. */
export class PumpTokenLaunchpad implements TokenLaunchpadPlugin {
  readonly id = "pump";

  async prepareDeployment(
    _connection: Connection,
    args: PrepareDeploymentArgs,
  ): Promise<PreparedTokenDeployment> {
    const mint = args.mint ?? Keypair.generate();
    const requestedCreator = args.creator ?? args.user;
    const creator = args.holderReward ? holderRewardsPda(mint.publicKey) : requestedCreator;
    if(args.holderReward){
      if(args.cashback)throw new Error('Holder rewards cannot be combined with deprecated cashback');
      const global=await new OnlinePumpSdk(_connection).fetchGlobal();
      if(!global.isHolderRewardEnabled)throw new Error('Pump holder rewards are disabled');
    }
    let quoteAsset = args.quoteAsset ?? SOL_ASSET;
    let customCreateInstruction = null as import("@solana/web3.js").TransactionInstruction | null;
    let quoteSource: string = "sol";
    if (quoteAsset.kind === "spl-token") {
      const sdk = new OnlinePumpSdk(_connection);
      // A traded pool does not establish a create_v2 quote entitlement.
      // The official resolver enforces Global, QuoteControl, depth, cycle,
      // mayhem and migration-gap admission before any deploy instruction exists.
      const resolved = await sdk.resolveQuoteMint(quoteAsset.mint);
      const chainMint = await readMint(_connection, resolved.mint);
      if (!chainMint.tokenProgram.equals(resolved.quoteTokenProgram) ||
          chainMint.decimals !== resolved.decimals) {
        throw new Error("Launch quote mint program/decimals changed during admission");
      }
      quoteAsset = { kind: "spl-token", mint: resolved.mint,
        tokenProgram: resolved.quoteTokenProgram, decimals: resolved.decimals };
      quoteSource = resolved.source;
      if (args.mayhemMode && resolved.source !== "global")
        throw new Error("Mayhem custom quote must be listed on Pump Global");
      customCreateInstruction = await PUMP_SDK.createV2Instruction({
        mint: mint.publicKey, user: args.user, creator,
        name: args.name, symbol: args.symbol, uri: args.uri,
        quoteMint: resolved.mint, quoteTokenProgram: resolved.quoteTokenProgram,
        mayhemMode: args.mayhemMode ?? false, cashback: args.cashback ?? false,
        holderReward: args.holderReward ?? false,
        pumpQuote: resolved.pumpQuote?.accounts,
      });
    }
    if(args.holderReward&&quoteAsset.kind==='native-sol'){
      customCreateInstruction=await PUMP_SDK.createV2Instruction({
        mint:mint.publicKey,user:args.user,creator:requestedCreator,
        name:args.name,symbol:args.symbol,uri:args.uri,mayhemMode:args.mayhemMode??false,
        cashback:false,holderReward:true,
      });
    }
    const token: Partial<TokenRow> & { mint: string } = {
      mint: mint.publicKey.toBase58(),
      name: args.name,
      symbol: args.symbol,
      decimals: 6,
      createKind: "create_v2",
      creator: creator.toBase58(),
      quoteMint: quoteAsset.mint.toBase58(),
      quoteTokenProgram: quoteAsset.tokenProgram.toBase58(),
      baseTokenProgram: TOKEN_2022_ID.toBase58(),
      bondingCurve: bondingCurvePda(mint.publicKey).toBase58(),
      venueHint: "pump-curve",
      metadataJson: JSON.stringify({
        uri: args.uri,
        mayhemMode: args.mayhemMode ?? false,
        cashback: args.cashback ?? false,
      }),
    };
    const deployment: PreparedTokenDeployment = {
      launchpad: this.id,
      mint,
      user: args.user,
      creator,
      quoteAsset,
      token,
      instructions: customCreateInstruction ? [customCreateInstruction] : [
        buildCreateV2({
          mint: mint.publicKey,
          user: args.user,
          creator,
          name: args.name,
          symbol: args.symbol,
          uri: args.uri,
          quote: quoteAsset,
          mayhemMode: args.mayhemMode,
          cashback: args.cashback,
        }),
      ],
      signers: [mint],
      metadata: {
        uri: args.uri,
        mayhemMode: args.mayhemMode ?? false,
        cashback: args.cashback ?? false,
        quoteSource,
        holderReward: args.holderReward ?? false,
      },
    };
    // A launchpad caller may request its first buy in the deployment quote.
    // Include the buy as instructions in the SAME atomic transaction; never
    // discard the request or return a create-only deployment.
    if (args.initialBuy) {
      if (!sameAsset(args.initialBuy.asset, deployment.quoteAsset) ||
          args.initialBuy.raw <= 0n)
        throw new Error("Initial buy does not use a positive deployment quote amount");
      const state = await this.initialPendingMarketState(_connection, deployment);
      const buy = await this.buildPendingBuy(
        _connection, deployment, args.user, args.initialBuy, state,
        { slippageBps: args.slippageBps ?? 500 },
      );
      if (buy.minimumOutputRaw <= 0n || buy.instructions.length === 0 ||
          !buy.quoteAsset.mint.equals(deployment.quoteAsset.mint))
        throw new Error("Requested initial buy has no protected execution");
      deployment.instructions.push(...buy.instructions);
      deployment.metadata = {
        ...deployment.metadata,
        initialBuyRaw: args.initialBuy.raw.toString(),
        minimumOutputRaw: buy.minimumOutputRaw.toString(),
        expectedOutputRaw: buy.expectedOutputRaw.toString(),
      };
    }
    return deployment;
  }

  async initialPendingMarketState(
    connection: Connection,
    deployment: PreparedTokenDeployment,
  ): Promise<PumpPendingCurveState> {
    // The official SDK reads the correct Global/QuoteControl or eligible pump
    // quote-chain seed (including synthetic migrated reserve calculations).
    // Decimal scaling or SOL spot-price conversion is NOT equivalent.
    if (sameAsset(deployment.quoteAsset, SOL_ASSET)) {
      const initial = await fetchInitialSolCurveState(connection);
      return { ...initial,
        totalFeeBps: configuredTotalFeeBps(tokenForDeployment(deployment)) };
    }
    const resolved = await new OnlinePumpSdk(connection)
      .resolveQuoteMint(deployment.quoteAsset.mint);
    if (!resolved.quoteTokenProgram.equals(deployment.quoteAsset.tokenProgram) ||
        resolved.decimals !== deployment.quoteAsset.decimals) {
      throw new Error("Pending quote program/decimals do not match current chain");
    }
    const online = new OnlinePumpSdk(connection);
    const [global, quoteControl] = await Promise.all([
      online.fetchGlobal(), online.fetchQuoteControl(),
    ]);
    const initial = newBondingCurve(
      global, resolved.mint, quoteControl, undefined, false,
      resolved.pumpQuote?.curve,
    );
    if (initial.virtualTokenReserves.lten(0) ||
        initial.virtualQuoteReserves.lten(0)) {
      throw new Error("Pending custom quote has nonpositive protocol reserves");
    }
    return {
      virtualBase: BigInt(initial.virtualTokenReserves.toString()),
      virtualQuote: BigInt(initial.virtualQuoteReserves.toString()),
      totalFeeBps: configuredTotalFeeBps(tokenForDeployment(deployment)),
    };
  }

  async buildPendingBuy(
    connection: Connection,
    deployment: PreparedTokenDeployment,
    buyer: PublicKey,
    amount: RawAmount,
    state: PendingMarketState,
    options: { slippageBps?: number } = {},
  ): Promise<PreparedPendingBuy> {
    if (!sameAsset(amount.asset, deployment.quoteAsset)) {
      throw new Error(
        `Pending Pump buy asset ${amount.asset.mint.toBase58()} does not match deployment quote ${deployment.quoteAsset.mint.toBase58()}`,
      );
    }
    const reserves = state as PumpPendingCurveState;
    if (!reserves || typeof reserves.totalFeeBps !== "number")
      throw new Error("Invalid Pump pending curve state");
    const quote = quoteBuyConstantProduct(
      amount,
      reserves,
      options.slippageBps ?? 1500,
      reserves.totalFeeBps,
    );
    const token = tokenForDeployment(deployment);
    const routing = await resolvePumpRouting(
      connection,
      token,
      deployment.creator,
      deployment.quoteAsset,
      deployment.metadata?.mayhemMode === true,
    );
    const netQuoteIn =
      (amount.raw * 10_000n) / BigInt(10_000 + reserves.totalFeeBps);
    const nextState: PumpPendingCurveState = {
      virtualBase: reserves.virtualBase - quote.expectedOutputRaw,
      virtualQuote: reserves.virtualQuote + netQuoteIn,
      totalFeeBps: reserves.totalFeeBps,
    };
    return {
      launchpad: this.id,
      mint: deployment.mint.publicKey,
      quoteAsset: deployment.quoteAsset,
      buyer,
      instructions: buildCurveBuyV2({
        mint: deployment.mint.publicKey,
        user: buyer,
        baseTokenProgram: TOKEN_2022_ID,
        quote: deployment.quoteAsset,
        routing,
        quoteInRaw: quote.inputRaw,
        minBaseOutRaw: quote.minimumOutputRaw,
      }),
      expectedOutputRaw: quote.expectedOutputRaw,
      minimumOutputRaw: quote.minimumOutputRaw,
      nextState,
      metadata: {
        quoteInRaw: quote.inputRaw.toString(),
        minBaseOutRaw: quote.minimumOutputRaw.toString(),
      },
    };
  }
}
