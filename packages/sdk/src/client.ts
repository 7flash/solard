import {
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
} from "@solard/core";

export type SolardOptions = {
  rpcUrl?: string;
  rpcUrls?: readonly string[];
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
  amount?: "all" | { bps: number };
  slippageBps?: number;
  minOutputLamports?: bigint | string;
};

export type SolardTradeExecutionOptions = TradeExecutionOptions;

export type SolardTradeExecutionResult = TradeResult;
export type Solard = {
  resolveCurrentMarket: ReturnType<typeof createCoreSolard>["resolveCurrentMarket"];
  getClaimableCreatorFees: ReturnType<typeof createCoreSolard>["getClaimableCreatorFees"];
  claimAllCreatorFees: ReturnType<typeof createCoreSolard>["claimAllCreatorFees"];
  walletLedger: ReturnType<typeof createCoreSolard>["walletLedger"];
  historicalTape: ReturnType<typeof createCoreSolard>["historicalTape"];
  getSupportedPumpPairs: ReturnType<typeof createCoreSolard>["getSupportedPumpPairs"];
  listVanityMints: ReturnType<typeof createCoreSolard>["listVanityMints"];
  releaseVanityMint: ReturnType<typeof createCoreSolard>["releaseVanityMint"];
  closeEmptyTokenAccounts: ReturnType<typeof createCoreSolard>["closeEmptyTokenAccounts"];
  prepareTokenDeployment: ReturnType<typeof createCoreSolard>["prepareTokenDeployment"];
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

function sellBps(value: SolardSellInput["amount"]): number {
  if (value == null || value === "all") return 10_000;
  const bps = Math.trunc(value.bps);
  if (!(bps > 0 && bps <= 10_000))
    throw new Error("sell amount.bps must be between 1 and 10000");
  return bps;
}


async function executeTrade(
  core: ReturnType<typeof createCoreSolard>,
  side: "buy" | "sell",
  input: SolardBuyInput | SolardSellInput,
  options: SolardTradeExecutionOptions = {},
): Promise<SolardTradeExecutionResult> {
  if (side === "buy") {
    const buy = input as SolardBuyInput;
    return await core.buy(buy.token, buy.wallet, tradeAmount(buy.amount), { ...options, slippageBps: buy.slippageBps, minOutputRaw: buy.minOutputRaw, maxPriceSol: buy.maxPriceSol, reserves: buy.reserves });
  }
  const sell = input as SolardSellInput;
  return await core.sell(sell.token, sell.wallet, { ...options, bps: sellBps(sell.amount), slippageBps: sell.slippageBps, minOutputLamports: sell.minOutputLamports, minPriceSol: sell.minPriceSol, reserves: sell.reserves, closeTokenAccount: sell.closeTokenAccount });

}

export function createSolard(options: SolardOptions = {}): Solard {
  const core = createCoreSolard(options);
  const history: SolardHistoryApi = Object.freeze({
    replay: (token, replayOptions) => core.history.replay(token, replayOptions),
    market: (token, marketOptions) => core.history.market(token, marketOptions),
    merge: core.history.merge,
  });
  const events = Object.assign(
    (token: TokenRef, eventOptions: ReplayEventsOptions = {}) =>
      core.events(token, eventOptions),
    { merge: core.events.merge },
  ) as SolardEventsApi;
  return Object.freeze({
    resolveCurrentMarket: core.resolveCurrentMarket.bind(core),
    getClaimableCreatorFees: core.getClaimableCreatorFees.bind(core),
    claimAllCreatorFees: core.claimAllCreatorFees.bind(core),
    walletLedger: core.walletLedger.bind(core),
    historicalTape: core.historicalTape.bind(core),
    getSupportedPumpPairs: core.getSupportedPumpPairs.bind(core),
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
