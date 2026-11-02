import {
  RpcPacer,
  createRpcPacer,
  createTraderSolard as createCoreSolard,
  type ClaimCreatorRewardsOptions,
  type CreatorRewardClaimResult,
  type CumulativeDistributionExecuteOptions,
  type CumulativeDistributionInput,
  type CumulativeDistributionPlan,
  type CumulativeDistributionState,
  type HumanAmount,
  type MarketHistory,
  type MarketHistoryOptions,
  type MarketPrice,
  type MergedReplayEventStream,
  type ReplayEventSubscription,
  type ReplayHistory,
  type ReplayItem,
  type ReplayOptions,
  type ReplayEventsOptions,
  type RecordConfirmedTradeInput,
  type SendReceipt,
  type TradeLandingPolicy,
  type TradeResult,
  type TradeExecutionOptions,
  type LivePoolReserves,
  type SenderId,
  type SolardDecodedTransaction,
  type SolardTransactionOptions,
  type SolardPosition,
  type SolardPositionQuery,
  type SolardTrade,
  type SolardTradeQuery,
  type TokenHolderSnapshot,
  type TokenHolderSnapshotOptions,
  type TokenRef,
  type WalletRef,
  type WalletPrivateKeyExport,
  type WalletPrivateKeyFormat,
  TradePreSubmissionError,
} from "@solard/core";
import {
  listenTrades as openTradeListener,
  type ListenTradesOptions,
  type TradeListener,
} from "./live.ts";

export type SolardOptions = import('@solard/core').EventSourceOptions & {
  rpc?: import('@solard/core').RpcPacingOptions | RpcPacer;
  fetch?: import('@solana/web3.js').FetchFn;
  transactionVersion?: 0 | 1;
  rpcUrl?: string;
  rpcUrls?: readonly string[];
  websocketUrls?: readonly string[];
  dbPath?: string;
  cacheTtlMs?: number;
};

export type SolardHistoryApi = {
  replay(token: TokenRef, options?: ReplayOptions): Promise<ReplayHistory>;
  market(
    token: TokenRef,
    options?: MarketHistoryOptions,
  ): Promise<MarketHistory>;
  merge(
    histories: readonly (ReplayHistory | Iterable<ReplayItem>)[],
  ): ReplayItem[];
};

export type SolardEventsApi = {
  subscribeToken: ReturnType<typeof createCoreSolard>["events"]["subscribeToken"];
  (
    token: TokenRef,
    options?: ReplayEventsOptions,
  ): Promise<ReplayEventSubscription>;
  merge(streams: readonly ReplayEventSubscription[]): MergedReplayEventStream;
};

export type SolardBuyInput = {
  reserves?: LivePoolReserves;
  maxPriceSol?: string | number;
  wallet: WalletRef;
  token: TokenRef;
  amount: HumanAmount | string | number;
  slippageBps?: number;
  minOutputRaw?: bigint | string;
};

export type SolardSellInput = {
  closeTokenAccount?: boolean;
  reserves?: LivePoolReserves;
  minPriceSol?: string | number;
  wallet: WalletRef;
  token: TokenRef;
  amount?: "all" | { bps: number } | { raw: bigint | string };
  /** Exact raw token units; mutually exclusive with amount. */
  amountRaw?: bigint | string;
  slippageBps?: number;
  minOutputLamports?: bigint | string;
};

export type SolardTradeExecutionOptions = TradeExecutionOptions;

export type SolardTradeExecutionResult = TradeResult;
export type Solard = {
  tx:ReturnType<typeof createCoreSolard>['tx'];
  compileGroups:ReturnType<typeof createCoreSolard>['compileGroups'];
  simulatePlan:ReturnType<typeof createCoreSolard>['simulatePlan'];
  sendBatchPlans:ReturnType<typeof createCoreSolard>['sendBatchPlans'];
  prepareFastTrade: ReturnType<typeof createCoreSolard>["prepareFastTrade"];
  listenTrades(
    options?: Omit<ListenTradesOptions, "tokens"> & {
      tokens?: readonly string[];
    },
  ): Promise<TradeListener>;
  prepareUnsignedBuy: ReturnType<typeof createCoreSolard>["prepareUnsignedBuy"];
  prepareUnsignedTokenDeployment: ReturnType<typeof createCoreSolard>["prepareUnsignedTokenDeployment"];
  resolvePumpLaunchQuote: ReturnType<typeof createCoreSolard>["resolvePumpLaunchQuote"];
  simulateUnsignedTokenDeployment: ReturnType<typeof createCoreSolard>["simulateUnsignedTokenDeployment"];
  simulateUnsignedBuy: ReturnType<typeof createCoreSolard>["simulateUnsignedBuy"];
  prepareUnsignedSell: ReturnType<typeof createCoreSolard>["prepareUnsignedSell"];
  simulateUnsignedSell: ReturnType<typeof createCoreSolard>["simulateUnsignedSell"];
  proposeUnsignedBuyLookupTable: ReturnType<typeof createCoreSolard>["proposeUnsignedBuyLookupTable"];
  resolveCurrentMarket: ReturnType<
    typeof createCoreSolard
  >["resolveCurrentMarket"];
  getClaimableCreatorFees: ReturnType<
    typeof createCoreSolard
  >["getClaimableCreatorFees"];
  claimAllCreatorFees: ReturnType<
    typeof createCoreSolard
  >["claimAllCreatorFees"];
  walletLedger: ReturnType<typeof createCoreSolard>["walletLedger"];
  historicalTape: ReturnType<typeof createCoreSolard>["historicalTape"];
  getSupportedPumpPairs: ReturnType<
    typeof createCoreSolard
  >["getSupportedPumpPairs"];
  getSupportedLaunchLabPairs: ReturnType<
    typeof createCoreSolard
  >["getSupportedLaunchLabPairs"];
  listVanityMints: ReturnType<typeof createCoreSolard>["listVanityMints"];
  releaseVanityMint: ReturnType<typeof createCoreSolard>["releaseVanityMint"];
  closeEmptyTokenAccounts: ReturnType<
    typeof createCoreSolard
  >["closeEmptyTokenAccounts"];
  prepareTokenDeployment: ReturnType<
    typeof createCoreSolard
  >["prepareTokenDeployment"];
  deployToken: ReturnType<typeof createCoreSolard>["deployToken"];
  warmBlockhash: ReturnType<typeof createCoreSolard>["warmBlockhash"];
  curveLiquidity: ReturnType<typeof createCoreSolard>["curveLiquidity"];
  maxSendableSol: ReturnType<typeof createCoreSolard>["maxSendableSol"];
  transferToken: ReturnType<typeof createCoreSolard>["transferToken"];
  exitWallet: ReturnType<typeof createCoreSolard>["exitWallet"];
  resumeTrade(intentKey: string): Promise<SolardTradeExecutionResult>;
  reconcile(intentKey: string): Promise<SolardTradeExecutionResult>;
  quote: ReturnType<typeof createCoreSolard>["quote"];
  close(): void;
  history: SolardHistoryApi;
  events: SolardEventsApi;
  claims: {
    creatorFees: {
      claim(
        token: TokenRef,
        wallet: WalletRef,
        options?: ClaimCreatorRewardsOptions,
      ): Promise<CreatorRewardClaimResult>;
      status(
        id: string,
      ): ReturnType<
        ReturnType<typeof createCoreSolard>["claims"]["creatorFees"]["status"]
      >;
    };
  };
  distributions: {
    plan(
      options: CumulativeDistributionInput,
    ): Promise<CumulativeDistributionPlan>;
    execute(
      options: CumulativeDistributionExecuteOptions,
    ): Promise<CumulativeDistributionState>;
    status(id: string): CumulativeDistributionState | null;
  };
  createWallet: ReturnType<typeof createCoreSolard>["createWallet"];
  createVanityWallet: ReturnType<typeof createCoreSolard>["createVanityWallet"];
  importWallet: ReturnType<typeof createCoreSolard>["importWallet"];
  listWallets: ReturnType<typeof createCoreSolard>["listWallets"];
  ignoreWallet: ReturnType<typeof createCoreSolard>["ignoreWallet"];
  unignoreWallet: ReturnType<typeof createCoreSolard>["unignoreWallet"];
  walletAddress(wallet: WalletRef): string;
  exportPrivateKey(
    wallet: WalletRef,
    format?: WalletPrivateKeyFormat,
  ): WalletPrivateKeyExport;
  addToken: ReturnType<typeof createCoreSolard>["addToken"];
  resolveToken: ReturnType<typeof createCoreSolard>["resolveToken"];
  tokenAccounts: ReturnType<typeof createCoreSolard>["tokenAccounts"];
  snapshotHolders(
    token: TokenRef,
    options?: Omit<TokenHolderSnapshotOptions, "token">,
  ): Promise<TokenHolderSnapshot>;
  walletBalances: ReturnType<typeof createCoreSolard>["walletBalances"];
  recordConfirmedTrade(input: RecordConfirmedTradeInput): Promise<SolardTrade>;
  trades(options?: SolardTradeQuery): Promise<SolardTrade[]>;
  position(options: SolardPositionQuery): Promise<SolardPosition>;
  getTransaction(
    signature: string,
    options?: SolardTransactionOptions,
  ): Promise<SolardDecodedTransaction | null>;
  samplePrice(token: TokenRef): Promise<MarketPrice>;
  buy(
    input: SolardBuyInput,
    options?: SolardTradeExecutionOptions,
  ): Promise<SolardTradeExecutionResult>;
  sell(
    input: SolardSellInput,
    options?: SolardTradeExecutionOptions,
  ): Promise<SolardTradeExecutionResult>;
};

function tradeAmount(value: HumanAmount | string | number): HumanAmount {
  return typeof value === "string" || typeof value === "number"
    ? { sol: value }
    : value;
}

function sellSize(input: SolardSellInput): {
  bps?: number;
  amountRaw?: bigint | string;
} {
  const value = input.amount;
  if (input.amountRaw !== undefined && value !== undefined)
    throw new Error("sell amountRaw and amount are mutually exclusive");
  const raw =
    input.amountRaw !== undefined
      ? input.amountRaw
      : typeof value === "object" && value !== null && "raw" in value
        ? value.raw
        : undefined;
  if (raw !== undefined) {
    if (typeof value === "object" && value !== null && "bps" in value)
      throw new Error("sell raw and bps are mutually exclusive");
    if (
      (typeof raw !== "bigint" &&
        (typeof raw !== "string" || !/^\d+$/.test(raw))) ||
      BigInt(raw) <= 0n
    )
      throw new Error("sell amountRaw must be a positive raw integer");
    return { amountRaw: raw };
  }
  if (value == null || value === "all") return { bps: 10_000 };
  if (!("bps" in value)) throw new Error("sell amount must specify bps or raw");
  const bps = value.bps;
  if (!Number.isInteger(bps) || !(bps > 0 && bps <= 10_000))
    throw new Error("sell amount.bps must be between 1 and 10000");
  return { bps };
}

async function executeTrade(
  core: ReturnType<typeof createCoreSolard>,
  side: "buy" | "sell",
  input: SolardBuyInput | SolardSellInput,
  options: SolardTradeExecutionOptions = {},
): Promise<SolardTradeExecutionResult> {
  if (side === "buy") {
    const buy = input as SolardBuyInput;
    return await core.buy(buy.token, buy.wallet, tradeAmount(buy.amount), {
      ...options,
      slippageBps: buy.slippageBps,
      minOutputRaw: buy.minOutputRaw,
      maxPriceSol: buy.maxPriceSol,
      reserves: buy.reserves,
    });
  }
  const sell = input as SolardSellInput;
  let size: ReturnType<typeof sellSize>;
  try {
    size = sellSize(sell);
  } catch (error) {
    throw new TradePreSubmissionError(error);
  }
  return await core.sell(sell.token, sell.wallet, {
    ...options,
    ...size,
    slippageBps: sell.slippageBps,
    minOutputLamports: sell.minOutputLamports,
    minPriceSol: sell.minPriceSol,
    reserves: sell.reserves,
    closeTokenAccount: sell.closeTokenAccount,
  });
}

export function createSolard(options: SolardOptions = {}): Solard {
  if(options.rpc||options.fetch)options={...options,rpc:options.rpc instanceof RpcPacer?options.rpc:createRpcPacer(options.rpc,options.fetch)};
  const core = createCoreSolard(options);
  const history: SolardHistoryApi = Object.freeze({
    replay: (token, replayOptions) => core.history.replay(token, replayOptions),
    market: (token, marketOptions) => core.history.market(token, marketOptions),
    merge: core.history.merge,
  });
  const events = Object.assign(
    (token: TokenRef, eventOptions: ReplayEventsOptions = {}) =>
      core.events(token, eventOptions),
    { merge: core.events.merge, subscribeToken: core.events.subscribeToken },
  ) as SolardEventsApi;
  return Object.freeze({
    tx:core.tx.bind(core),
    compileGroups:core.compileGroups.bind(core),
    simulatePlan:core.simulatePlan.bind(core),
    sendBatchPlans:core.sendBatchPlans.bind(core),
    listenTrades: (
      listenerOptions: Omit<ListenTradesOptions, "tokens"> & {
        tokens?: readonly string[];
      } = {},
    ) =>
      openTradeListener({
        source: options.source,
        sqd: options.sqd,
        rpc: options.rpc,
        fetch: options.fetch,
        websocketUrls: listenerOptions.websocketUrls ?? options.websocketUrls,
        rpcUrls:
          options.rpcUrls ?? (options.rpcUrl ? [options.rpcUrl] : undefined),
        dbPath: options.dbPath,
        ...listenerOptions,
        tokens: listenerOptions.tokens ?? [],
      }),
    prepareFastTrade: core.prepareFastTrade.bind(core),
    prepareUnsignedBuy: core.prepareUnsignedBuy.bind(core),
    prepareUnsignedTokenDeployment: core.prepareUnsignedTokenDeployment.bind(core),
    resolvePumpLaunchQuote: core.resolvePumpLaunchQuote.bind(core),
    simulateUnsignedTokenDeployment: core.simulateUnsignedTokenDeployment.bind(core),
    simulateUnsignedBuy: core.simulateUnsignedBuy.bind(core),
    prepareUnsignedSell: core.prepareUnsignedSell.bind(core),
    simulateUnsignedSell: core.simulateUnsignedSell.bind(core),
    proposeUnsignedBuyLookupTable: core.proposeUnsignedBuyLookupTable.bind(core),
    resolveCurrentMarket: core.resolveCurrentMarket.bind(core),
    getClaimableCreatorFees: core.getClaimableCreatorFees.bind(core),
    claimAllCreatorFees: core.claimAllCreatorFees.bind(core),
    walletLedger: core.walletLedger.bind(core),
    historicalTape: core.historicalTape.bind(core),
    getSupportedPumpPairs: core.getSupportedPumpPairs.bind(core),
    getSupportedLaunchLabPairs: core.getSupportedLaunchLabPairs.bind(core),
    listVanityMints: core.listVanityMints.bind(core),
    releaseVanityMint: core.releaseVanityMint.bind(core),
    closeEmptyTokenAccounts: core.closeEmptyTokenAccounts.bind(core),
    prepareTokenDeployment: core.prepareTokenDeployment.bind(core),
    deployToken: core.deployToken.bind(core),
    warmBlockhash: core.warmBlockhash.bind(core),
    curveLiquidity: core.curveLiquidity.bind(core),
    maxSendableSol: core.maxSendableSol.bind(core),
    transferToken: core.transferToken.bind(core),
    exitWallet: core.exitWallet.bind(core),
    resumeTrade: core.resumeTrade.bind(core),
    reconcile: core.reconcile.bind(core),
    quote: core.quote.bind(core),
    close: core.close.bind(core),
    history,
    events: Object.freeze(events),
    claims: Object.freeze({
      creatorFees: Object.freeze({
        claim: core.claims.creatorFees.claim,
        status: core.claims.creatorFees.status,
      }),
    }),
    distributions: Object.freeze({
      plan: core.distributions.plan,
      execute: core.distributions.execute,
      status: core.distributions.status,
    }),
    createWallet: core.createWallet.bind(core),
    createVanityWallet: core.createVanityWallet.bind(core),
    importWallet: core.importWallet.bind(core),
    listWallets: core.listWallets.bind(core),
    ignoreWallet: core.ignoreWallet.bind(core),
    unignoreWallet: core.unignoreWallet.bind(core),
    walletAddress: core.walletAddress.bind(core),
    exportPrivateKey: core.exportWalletPrivateKey.bind(core),
    addToken: core.addToken.bind(core),
    resolveToken: core.resolveToken.bind(core),
    tokenAccounts: core.tokenAccounts.bind(core),
    snapshotHolders: core.snapshotHolders.bind(core),
    walletBalances: core.walletBalances.bind(core),
    recordConfirmedTrade: core.recordConfirmedTrade.bind(core),
    trades: core.trades.bind(core),
    position: core.position.bind(core),
    getTransaction: core.getTransaction.bind(core),
    samplePrice: core.samplePrice.bind(core),
    buy: (input, executionOptions) =>
      executeTrade(core, "buy", input, executionOptions),
    sell: (input, executionOptions) =>
      executeTrade(core, "sell", input, executionOptions),
  });
}
