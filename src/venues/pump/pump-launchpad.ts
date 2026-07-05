import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { SOL_ASSET, sameAsset, type RawAmount } from "../../core/amounts.js";
import type {
  PendingMarketState, PreparedPendingBuy, PreparedTokenDeployment, PrepareDeploymentArgs, TokenLaunchpadPlugin,
} from "../../launches/launchpad.js";
import type { TokenRow } from "../../db/schema.js";
import { configuredTotalFeeBps } from "./common.js";
import { TOKEN_2022_ID, WRAPPED_SOL_MINT } from "./constants.js";
import { bondingCurvePda } from "./pda.js";
import { buildCreateV2, buildCurveBuyV2 } from "./pump-instructions.js";
import { quoteBuyConstantProduct } from "./quote.js";
import { resolvePumpRouting } from "./routing.js";
import { fetchInitialSolCurveState } from "./state.js";

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
    metadataJson: JSON.stringify({ pendingDeployment: true, ...(deployment.metadata ?? {}) }),
    refreshedAtMs: null,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

/** Direct Pump create_v2 launchpad. The mint keypair is produced client-side,
 * therefore its public address is available before submission. */
export class PumpTokenLaunchpad implements TokenLaunchpadPlugin {
  readonly id = "pump";

  async prepareDeployment(_connection: Connection, args: PrepareDeploymentArgs): Promise<PreparedTokenDeployment> {
    const mint = args.mint ?? Keypair.generate();
    const creator = args.creator ?? args.user;
    const quoteAsset = args.quoteAsset ?? SOL_ASSET;
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
      metadataJson: JSON.stringify({ uri: args.uri, mayhemMode: args.mayhemMode ?? false, cashback: args.cashback ?? false }),
    };
    return {
      launchpad: this.id,
      mint,
      user: args.user,
      creator,
      quoteAsset,
      token,
      instructions: [buildCreateV2({
        mint: mint.publicKey,
        user: args.user,
        creator,
        name: args.name,
        symbol: args.symbol,
        uri: args.uri,
        quote: quoteAsset,
        mayhemMode: args.mayhemMode,
        cashback: args.cashback,
      })],
      signers: [mint],
      metadata: { uri: args.uri, mayhemMode: args.mayhemMode ?? false, cashback: args.cashback ?? false },
    };
  }

  async initialPendingMarketState(connection: Connection, deployment: PreparedTokenDeployment): Promise<PumpPendingCurveState> {
    if (!sameAsset(deployment.quoteAsset, SOL_ASSET)) {
      throw new Error("Pre-landing Pump buy planning is currently implemented only for SOL-paired create_v2 launches");
    }
    const initial = await fetchInitialSolCurveState(connection);
    return { ...initial, totalFeeBps: configuredTotalFeeBps(tokenForDeployment(deployment)) };
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
      throw new Error(`Pending Pump buy asset ${amount.asset.mint.toBase58()} does not match deployment quote ${deployment.quoteAsset.mint.toBase58()}`);
    }
    const reserves = state as PumpPendingCurveState;
    if (!reserves || typeof reserves.totalFeeBps !== "number") throw new Error("Invalid Pump pending curve state");
    const quote = quoteBuyConstantProduct(amount, reserves, options.slippageBps ?? 1500, reserves.totalFeeBps);
    const token = tokenForDeployment(deployment);
    const routing = await resolvePumpRouting(
      connection,
      token,
      deployment.creator,
      deployment.quoteAsset,
      deployment.metadata?.mayhemMode === true,
    );
    const netQuoteIn = amount.raw * 10_000n / BigInt(10_000 + reserves.totalFeeBps);
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
      metadata: { quoteInRaw: quote.inputRaw.toString(), minBaseOutRaw: quote.minimumOutputRaw.toString() },
    };
  }
}
