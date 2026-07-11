export type AnyRow = Record<string, any>;

export type WalletRow = {
  name?: string | null;
  address?: string | null;
  groups?: string[];
  [key: string]: any;
};

export type BalanceRow = {
  wallet?: WalletRow | null;
  solLamports?: string | number | bigint | null;
  balanceWarning?: unknown;
  [key: string]: any;
};

export type OverviewPayload = {
  wallets: WalletRow[];
  groups: AnyRow[];
  tokens: AnyRow[];
  executions: AnyRow[];
  balances: BalanceRow[];
  [key: string]: any;
};

export type JobRow = {
  id: string;
  status?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  input?: AnyRow;
  result?: AnyRow;
  argv?: string[];
  logs?: AnyRow[];
  kind?: string;
  [key: string]: any;
};

export type PumpFeedRow = {
  mint?: string | null;
  signature?: string | null;
  name?: string | null;
  symbol?: string | null;
  creator?: string | null;
  uri?: string | null;
  image?: string | null;
  description?: string | null;
  website?: string | null;
  twitter?: string | null;
  telegram?: string | null;
  source?: string | null;
  quoteAsset?: string | null;
  quoteMint?: string | null;
  createdAtMs?: number | null;
  updatedAtMs?: number | null;
  lastTradeAtMs?: number | null;
  priceUpdatedAtMs?: number | null;
  priceAgeMs?: number | null;
  priceStatus?: "live" | "stale" | "snapshot" | "missing" | string | null;
  priceSource?: string | null;
  priceUsd?: number | string | null;
  priceSol?: number | string | null;
  priceSolPerToken?: number | string | null;
  marketCapUsd?: number | string | null;
  marketCapSol?: number | string | null;
  initialMarketCapUsd?: number | string | null;
  initialMarketCapSol?: number | string | null;
  sma1m?: number | string | null;
  sma5m?: number | string | null;
  sma15m?: number | string | null;
  tradeCount?: number | null;
  isMayhemMode?: boolean | number | string | null;
  raw?: AnyRow;
  [key: string]: any;
};

export type WatchGroup = {
  id: string;
  name: string;
  tokens?: AnyRow[];
  [key: string]: any;
};

export type TerminalHealthPayload = {
  ok?: boolean;
  store?: AnyRow;
  processes?: AnyRow[];
  errors?: AnyRow[];
  [key: string]: any;
};

export type TerminalFeedPayload = {
  rows?: PumpFeedRow[];
  rawRows?: AnyRow[];
  stats?: AnyRow | null;
  health?: TerminalHealthPayload | null;
  meta?: AnyRow;
};

export type PumpLivePayload = {
  newTokens?: PumpFeedRow[];
  rawTokens?: AnyRow[];
  watchGroups?: WatchGroup[];
  watchedMints?: string[];
  db?: AnyRow | null;
  health?: TerminalHealthPayload | null;
  source?: string | null;
  ensure?: AnyRow;
};
