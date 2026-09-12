import {
  createTraderSolard as createCoreSolard,
  type ClaimCreatorRewardsOptions,
  type CreatorRewardClaimResult,
  type CumulativeDistributionExecuteOptions,
  type CumulativeDistributionInput,
  type CumulativeDistributionPlan,
  type CumulativeDistributionState,
  type HumanAmount,
  type MarketPrice,
  type MergedReplayEventStream,
  type ReplayEventSubscription,
  type ReplayHistory,
  type ReplayItem,
  type ReplayOptions,
  type ReplayEventsOptions,
  type TokenRef,
  type WalletRef,
} from "@solard/core";

export type SolardOptions = {
  rpcUrl?: string;
  dbPath?: string;
  cacheTtlMs?: number;
};

export type SolardHistoryApi = {
  replay(token: TokenRef, options?: ReplayOptions): Promise<ReplayHistory>;
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

export type Solard = {
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
  addToken: ReturnType<typeof createCoreSolard>["addToken"];
  resolveToken: ReturnType<typeof createCoreSolard>["resolveToken"];
  tokenAccounts: ReturnType<typeof createCoreSolard>["tokenAccounts"];
  walletBalances: ReturnType<typeof createCoreSolard>["walletBalances"];
  samplePrice(token: TokenRef): Promise<MarketPrice>;
  buy(
    token: TokenRef,
    wallet: WalletRef,
    amount: HumanAmount,
    options?: Parameters<ReturnType<typeof createCoreSolard>["buy"]>[3],
  ): ReturnType<ReturnType<typeof createCoreSolard>["buy"]>;
  sell: ReturnType<typeof createCoreSolard>["sell"];
};

export function createSolard(options: SolardOptions = {}): Solard {
  const core = createCoreSolard(options);
  const history: SolardHistoryApi = Object.freeze({
    replay: (token, replayOptions) => core.history.replay(token, replayOptions),
    merge: core.history.merge,
  });
  const events = Object.assign(
    (token: TokenRef, eventOptions: ReplayEventsOptions = {}) =>
      core.events(token, eventOptions),
    { merge: core.events.merge },
  ) as SolardEventsApi;
  return Object.freeze({
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
    addToken: core.addToken.bind(core),
    resolveToken: core.resolveToken.bind(core),
    tokenAccounts: core.tokenAccounts.bind(core),
    walletBalances: core.walletBalances.bind(core),
    samplePrice: core.samplePrice.bind(core),
    buy: core.buy.bind(core),
    sell: core.sell.bind(core),
  });
}

export const createTraderSolard = createSolard;
