// Split from runtime.tsx in the second repair pass.
// Keep this file free of JSX so state/types stay cheap to import.

export type AnyRow = Record<string, any>;
export type Overview = {
  wallets: AnyRow[];
  tokens: AnyRow[];
  groups: AnyRow[];
  executions: AnyRow[];
  balances: AnyRow[];
};

export type Portfolio = {
  wallets: AnyRow[];
  totals: {
    wallets: number;
    tokenAccounts: number;
    holdings: number;
    solLamports: string | null;
  };
  rows: AnyRow[];
  loadedAtMs: number;
};

export type BuyPlanRow = {
  id: string;
  wallet: string;
  label: string;
  amountMode: "range-bps" | "exact-sol" | "exact-lamports";
  minBps: string;
  maxBps: string;
  reserveSol: string;
  exactSol: string;
  exactLamports: string;
  sender: "helius-fast" | "helius-rpc";
  strategy:
    | "fast-spam"
    | "spam-after-market-ready"
    | "after-deploy-processed"
    | "after-deploy-confirmed";
  tipSol: string;
  priorityMicroLamports: string;
  slippageBps: string;
  retryIntervalMs: string;
  recompileIntervalMs: string;
  freshQuoteDelayMs: string;
  maxFailedAttempts: string;
};

export type PumpFeedRow = {
  seq?: number;
  receivedAt?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  eventType?: string;
  mint?: string | null;
  name?: string | null;
  symbol?: string | null;
  uri?: string | null;
  creator?: string | null;
  signature?: string | null;
  initialBuy?: number | null;
  solAmount?: number | null;
  marketCapSol?: number | null;
  priceSolPerToken?: number | null;
  image?: string | null;
  website?: string | null;
  twitter?: string | null;
  telegram?: string | null;
  description?: string | null;
  samples?: TokenWatchSample[];
  initialMarketCapSol?: number | null;
  lastMarketCapSol?: number | null;
  marketCapChangeSol?: number | null;
  marketCapChangePct?: number | null;
  sma1m?: number | null;
  sma5m?: number | null;
  sma15m?: number | null;
  sma60m?: number | null;
  lastTradeAtMs?: number | null;
  isMayhemMode?: boolean | null;
  quoteAsset?: string | null;
  quoteMint?: string | null;
  trades?: AnyRow[];
  raw?: AnyRow;
};

export type TokenHolder = {
  tokenAccount: string;
  owner: string | null;
  amount: string | null;
  uiAmount: string | null;
  decimals: number | null;
  pctSupply?: number | null;
  label?: string | null;
  lastDeltaUi?: number | null;
  lastSignature?: string | null;
  source?: string | null;
};

export type Toast = {
  id: string;
  kind: "info" | "warn" | "error" | "success";
  title: string;
  message?: string | null;
  createdAtMs: number;
  expiresAtMs: number;
};

export type TokenWatchSample = {
  capturedAtMs: number;
  marketCapSol: number | null;
  source?: string | null;
};

export type TokenWatchToken = {
  mint: string;
  name?: string | null;
  symbol?: string | null;
  creator?: string | null;
  uri?: string | null;
  image?: string | null;
  signature?: string | null;
  addedAtMs: number;
  updatedAtMs: number;
  samples: TokenWatchSample[];
  priceSolPerToken?: number | null;
  lastTradeAtMs?: number | null;
  initialMarketCapSol?: number | null;
  marketCapChangeSol?: number | null;
  marketCapChangePct?: number | null;
  isMayhemMode?: boolean | null;
  quoteAsset?: string | null;
  quoteMint?: string | null;
  trades?: AnyRow[];
  lastMarketCapSol: number | null;
  sma1m: number | null;
  sma5m: number | null;
  sma15m: number | null;
  sma60m: number | null;
};

export type TokenWatchGroup = {
  id: string;
  name: string;
  createdAtMs: number;
  updatedAtMs: number;
  tokens: TokenWatchToken[];
};

export type TelegramSignalSource = {
  id: string;
  kind: "telegram" | "manual";
  name: string;
  chatRef?: string | null;
  isActive: boolean;
  createdAtMs: number;
  updatedAtMs: number;
};

export type TelegramSignal = {
  id: string;
  sourceId: string | null;
  sourceName: string | null;
  receivedAtMs: number;
  direction: "buy" | "sell" | "watch" | "unknown";
  confidence: number;
  text: string;
  mints: string[];
  symbols: string[];
  urls: string[];
  amountSol: string | null;
  status: "new" | "watched" | "ignored" | "traded";
  notes?: string | null;
};

export type TelegramSignalsState = {
  version: 1;
  sources: TelegramSignalSource[];
  signals: TelegramSignal[];
};

export type State = {
  tab:
    | "overview"
    | "wallets"
    | "portfolio"
    | "terminal"
    | "watchlists"
    | "signals"
    | "launch"
    | "trade"
    | "jobs";
  overview: Overview | null;
  portfolio: Portfolio | null;
  portfolioSearch: string;
  portfolioHideZero: boolean;
  rpcStatus: AnyRow | null;
  jobs: AnyRow[];
  selectedJobId: string | null;
  selectedJob: AnyRow | null;
  busy: boolean;
  error: string | null;
  token: string;
  buyPlanRows: BuyPlanRow[];
  pumpFeed: PumpFeedRow[];
  pumpFeedStatus:
    "idle" | "connecting" | "reconnecting" | "connected" | "error" | "closed";
  pumpFeedError: string | null;
  pumpFeedFilter: string;
  pumpFeedSort:
    | "newest"
    | "mcap-desc"
    | "mcap-asc"
    | "mcap-change-desc"
    | "mcap-change-pct-desc"
    | "sma1m-desc"
    | "sma5m-desc"
    | "sma15m-desc"
    | "trades-desc";
  pumpFeedSource: "helius" | "pumpportal";
  terminalDefaultWallet: string;
  terminalDefaultBuySol: string;
  terminalDefaultSender: "helius-fast" | "helius-rpc" | "rpc";
  terminalDefaultSlippageBps: string;
  terminalDefaultTipSol: string;
  terminalDefaultPriorityMicroLamports: string;
  terminalQuickLive: boolean;
  watchSort:
    | "mcap-desc"
    | "mcap-asc"
    | "mcap-change-desc"
    | "mcap-change-pct-desc"
    | "sma1m-desc"
    | "trades-desc"
    | "newest";
  hideMayhem: boolean;
  hideUsdc: boolean;
  pumpFeedAbort: AbortController | null;
  watchGroups: TokenWatchGroup[];
  selectedWatchGroupId: string | null;
  watchGroupName: string;
  signals: TelegramSignalsState | null;
  signalSourceName: string;
  signalSourceChatRef: string;
  signalSourceId: string;
  signalText: string;
  walletSearch: string;
  groupSearch: string;
  mountId: number;
  previousTab: State["tab"] | null;
  measureScope: string;
  terminalInspectorKey: string | null;
  terminalInspectorFixed: boolean;
  terminalPinnedMints: string[];
  terminalSessionStartedAtMs: number | null;
  tokenHolders: Record<string, TokenHolder[]>;
  tokenHolderErrors: Record<string, string>;
  tokenHoldersCheckedAt: Record<string, number>;
  tokenHoldersLoadingMint: string | null;
  toasts: Toast[];
};

export function activePageFromLocation(): State["tab"] {
  if (typeof window === "undefined") return "overview";
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path.endsWith("/wallets")) return "wallets";
  if (path.endsWith("/portfolio")) return "portfolio";
  if (path.endsWith("/terminal")) return "terminal";
  if (path.endsWith("/watchlists")) return "watchlists";
  if (path.endsWith("/signals")) return "signals";
  if (path.endsWith("/launch")) return "launch";
  if (path.endsWith("/trade")) return "trade";
  if (path.endsWith("/activity")) return "jobs";
  return "overview";
}

function storageGet(key: string, fallback = ""): string {
  try {
    if (typeof localStorage === "undefined") return fallback;
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function storageFlag(key: string): boolean {
  return storageGet(key) === "1";
}

export const state: State = {
  tab: activePageFromLocation(),
  overview: null,
  portfolio: null,
  portfolioSearch: storageGet("solard:portfolio-search"),
  portfolioHideZero: storageGet("solard:portfolio-hide-zero", "1") !== "0",
  rpcStatus: null,
  jobs: [],
  selectedJobId: null,
  selectedJob: null,
  busy: false,
  error: null,
  token: storageGet("solwal:web-token"),
  buyPlanRows: [],
  pumpFeed: [],
  pumpFeedStatus: "idle",
  pumpFeedError: null,
  pumpFeedFilter: "",
  pumpFeedSort: storageGet(
    "solwal:pump-feed-sort",
    "newest",
  ) as State["pumpFeedSort"],
  pumpFeedSource: storageGet(
    "solwal:pump-feed-source",
    "helius",
  ) as State["pumpFeedSource"],
  terminalDefaultWallet: storageGet("solwal:terminal-default-wallet"),
  terminalDefaultBuySol: storageGet("solwal:terminal-default-buy-sol", "0.05"),
  terminalDefaultSender: storageGet(
    "solwal:terminal-default-sender",
    "helius-fast",
  ) as State["terminalDefaultSender"],
  terminalDefaultSlippageBps: storageGet(
    "solwal:terminal-default-slippage-bps",
    "9999",
  ),
  terminalDefaultTipSol: storageGet("solwal:terminal-default-tip-sol", "0.001"),
  terminalDefaultPriorityMicroLamports: storageGet(
    "solwal:terminal-default-priority-micro-lamports",
    "1500000",
  ),
  terminalQuickLive: storageFlag("solwal:terminal-quick-live"),
  watchSort: storageGet("solwal:watch-sort", "mcap-desc") as State["watchSort"],
  hideMayhem: storageFlag("solwal:pump-hide-mayhem"),
  hideUsdc: storageFlag("solwal:pump-hide-usdc"),
  pumpFeedAbort: null,
  watchGroups: [],
  selectedWatchGroupId: null,
  watchGroupName: "main",
  signals: null,
  signalSourceName: "Telegram alpha",
  signalSourceChatRef: "",
  signalSourceId: "",
  signalText: "",
  walletSearch: storageGet("solard:wallet-search"),
  groupSearch: storageGet("solard:group-search"),
  mountId: 0,
  previousTab: null,
  measureScope: "solard:web:boot",
  terminalInspectorKey: storageGet("solard:terminal-inspector-key") || null,
  terminalInspectorFixed: storageFlag("solard:terminal-inspector-fixed"),
  terminalPinnedMints: (() => {
    try {
      const parsed = JSON.parse(
        storageGet("solard:terminal-pinned-mints", "[]"),
      );
      return Array.isArray(parsed)
        ? parsed.filter((item) => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  })(),
  terminalSessionStartedAtMs: null,
  tokenHolders: {},
  tokenHolderErrors: {},
  tokenHoldersCheckedAt: {},
  tokenHoldersLoadingMint: null,
  toasts: [],
};
