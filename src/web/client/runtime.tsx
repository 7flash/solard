import { render } from "tradjs/client";

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
  pumpFeedStatus: "idle" | "connecting" | "connected" | "error" | "closed";
  pumpFeedError: string | null;
  pumpFeedFilter: string;
  pumpFeedSort:
    | "newest"
    | "mcap-desc"
    | "mcap-asc"
    | "mcap-change-desc"
    | "mcap-change-pct-desc"
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
};

export const state: State = {
  tab: "overview",
  overview: null,
  portfolio: null,
  portfolioSearch: localStorage.getItem("solard:portfolio-search") ?? "",
  portfolioHideZero: localStorage.getItem("solard:portfolio-hide-zero") !== "0",
  rpcStatus: null,
  jobs: [],
  selectedJobId: null,
  selectedJob: null,
  busy: false,
  error: null,
  token: localStorage.getItem("solwal:web-token") ?? "",
  buyPlanRows: [],
  pumpFeed: [],
  pumpFeedStatus: "idle",
  pumpFeedError: null,
  pumpFeedFilter: "",
  pumpFeedSort:
    (localStorage.getItem("solwal:pump-feed-sort") as State["pumpFeedSort"]) ||
    "newest",
  pumpFeedSource:
    (localStorage.getItem(
      "solwal:pump-feed-source",
    ) as State["pumpFeedSource"]) || "helius",
  terminalDefaultWallet:
    localStorage.getItem("solwal:terminal-default-wallet") ?? "",
  terminalDefaultBuySol:
    localStorage.getItem("solwal:terminal-default-buy-sol") ?? "0.05",
  terminalDefaultSender:
    (localStorage.getItem(
      "solwal:terminal-default-sender",
    ) as State["terminalDefaultSender"]) || "helius-fast",
  terminalDefaultSlippageBps:
    localStorage.getItem("solwal:terminal-default-slippage-bps") ?? "9999",
  terminalDefaultTipSol:
    localStorage.getItem("solwal:terminal-default-tip-sol") ?? "0.001",
  terminalDefaultPriorityMicroLamports:
    localStorage.getItem("solwal:terminal-default-priority-micro-lamports") ??
    "1500000",
  terminalQuickLive: localStorage.getItem("solwal:terminal-quick-live") === "1",
  watchSort:
    (localStorage.getItem("solwal:watch-sort") as State["watchSort"]) ||
    "mcap-desc",
  hideMayhem: localStorage.getItem("solwal:pump-hide-mayhem") === "1",
  hideUsdc: localStorage.getItem("solwal:pump-hide-usdc") === "1",
  pumpFeedAbort: null,
  watchGroups: [],
  selectedWatchGroupId: null,
  watchGroupName: "main",
  signals: null,
  signalSourceName: "Telegram alpha",
  signalSourceChatRef: "",
  signalSourceId: "",
  signalText: "",
  walletSearch: localStorage.getItem("solard:wallet-search") ?? "",
  groupSearch: localStorage.getItem("solard:group-search") ?? "",
};

export function pageFromPath(): State["tab"] {
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

export function pageHref(page: State["tab"]): string {
  if (page === "overview") return "/";
  if (page === "jobs") return "/activity";
  return `/${page}`;
}

export function navigatePage(page: State["tab"]): void {
  window.location.href = pageHref(page);
}

export function authHeaders(): HeadersInit {
  return state.token ? { "x-solwal-web-token": state.token } : {};
}

export async function api<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
      ...(options.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false)
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload.value as T;
}

export function short(
  value: string | null | undefined,
  head = 6,
  tail = 6,
): string {
  if (!value) return "—";
  return value.length <= head + tail + 1
    ? value
    : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function solFromLamports(value: any): string {
  if (value == null || value === "" || value === "pending") return "refreshing";
  try {
    const raw =
      typeof value === "bigint" ? value : BigInt(String(value ?? "0"));
    const whole = raw / 1_000_000_000n;
    const frac = (raw % 1_000_000_000n)
      .toString()
      .padStart(9, "0")
      .replace(/0+$/, "");
    return `${whole}${frac ? `.${frac}` : ""}`;
  } catch {
    return "refreshing";
  }
}

export function formatSol(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value >= 0.001
    ? value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")
    : value.toExponential(2);
}

export function tokenUrl(mint: string | null | undefined): string {
  return mint ? `https://pump.fun/coin/${mint}` : "#";
}

export function tokenImage(row: {
  image?: string | null;
  uri?: string | null;
}): string | null {
  const image = row.image || null;
  if (!image) return null;
  return image.startsWith("ipfs://")
    ? `https://ipfs.io/ipfs/${image.slice(7)}`
    : image;
}

export function isMayhemToken(row: {
  isMayhemMode?: boolean | null;
  raw?: AnyRow;
}): boolean {
  if (row.isMayhemMode === true) return true;
  const raw = row.raw ?? {};
  return [
    "isMayhemMode",
    "mayhemMode",
    "mayhem",
    "isMayhem",
    "mode",
    "launchMode",
    "curveType",
  ].some(
    (key) =>
      String(raw[key] ?? "")
        .toLowerCase()
        .includes("mayhem") || raw[key] === true,
  );
}

export function isUsdcToken(row: {
  quoteAsset?: string | null;
  quoteMint?: string | null;
  raw?: AnyRow;
}): boolean {
  const text = [
    row.quoteAsset,
    row.quoteMint,
    row.raw?.quoteAsset,
    row.raw?.quoteSymbol,
    row.raw?.quoteMint,
    row.raw?.quoteTokenMint,
    row.raw?.quoteCurrency,
  ]
    .map((value) => String(value ?? "").toLowerCase())
    .join(" ");
  return (
    text.includes("usdc") ||
    text.includes("epjfwdd5aufqssqem2qn1xzybapc8g4wegkgzwydt1v")
  );
}

export function passesBadgeFilters(row: {
  isMayhemMode?: boolean | null;
  quoteAsset?: string | null;
  quoteMint?: string | null;
  raw?: AnyRow;
}): boolean {
  if (state.hideMayhem && isMayhemToken(row)) return false;
  if (state.hideUsdc && isUsdcToken(row)) return false;
  return true;
}

export function TokenBadges(row: {
  isMayhemMode?: boolean | null;
  quoteAsset?: string | null;
  quoteMint?: string | null;
  raw?: AnyRow;
}) {
  const mayhem = isMayhemToken(row);
  const usdc = isUsdcToken(row);
  const quote = usdc
    ? "USDC"
    : String(
        row.quoteAsset ?? row.raw?.quoteAsset ?? row.raw?.quoteSymbol ?? "SOL",
      ).toUpperCase();
  return (
    <span className="badges">
      {mayhem ? <span className="badge mayhem">MAYHEM</span> : null}
      {usdc ? (
        <span className="badge usdc">USDC</span>
      ) : quote && quote !== "SOL" ? (
        <span className="badge quote">{quote}</span>
      ) : null}
    </span>
  );
}

export function formatMcap(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value >= 1
    ? value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")
    : value.toExponential(2);
}

export function latestMcap(row: {
  marketCapSol?: number | null;
  lastMarketCapSol?: number | null;
  samples?: TokenWatchSample[];
}): number | null {
  const direct = row.marketCapSol ?? row.lastMarketCapSol;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  const samples = [...(row.samples ?? [])].sort(
    (a, b) => b.capturedAtMs - a.capturedAtMs,
  );
  return (
    samples.find(
      (sample) =>
        typeof sample.marketCapSol === "number" &&
        Number.isFinite(sample.marketCapSol),
    )?.marketCapSol ?? null
  );
}

export function initialMcap(row: {
  initialMarketCapSol?: number | null;
  marketCapSol?: number | null;
  samples?: TokenWatchSample[];
}): number | null {
  if (
    typeof row.initialMarketCapSol === "number" &&
    Number.isFinite(row.initialMarketCapSol)
  )
    return row.initialMarketCapSol;
  const samples = [...(row.samples ?? [])].sort(
    (a, b) => a.capturedAtMs - b.capturedAtMs,
  );
  return (
    samples.find(
      (sample) =>
        typeof sample.marketCapSol === "number" &&
        Number.isFinite(sample.marketCapSol),
    )?.marketCapSol ??
    (typeof row.marketCapSol === "number" ? row.marketCapSol : null)
  );
}

export function mcapChange(row: {
  initialMarketCapSol?: number | null;
  marketCapSol?: number | null;
  lastMarketCapSol?: number | null;
  marketCapChangeSol?: number | null;
  samples?: TokenWatchSample[];
}): number | null {
  if (
    typeof row.marketCapChangeSol === "number" &&
    Number.isFinite(row.marketCapChangeSol)
  )
    return row.marketCapChangeSol;
  const first = initialMcap(row);
  const last = latestMcap(row);
  return first != null && last != null ? last - first : null;
}

export function mcapChangePct(row: {
  initialMarketCapSol?: number | null;
  marketCapSol?: number | null;
  lastMarketCapSol?: number | null;
  marketCapChangePct?: number | null;
  samples?: TokenWatchSample[];
}): number | null {
  if (
    typeof row.marketCapChangePct === "number" &&
    Number.isFinite(row.marketCapChangePct)
  )
    return row.marketCapChangePct;
  const first = initialMcap(row);
  const change = mcapChange(row);
  return first != null && first > 0 && change != null
    ? (change / first) * 100
    : null;
}

export function formatSignedMcap(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatMcap(value)}`;
}

export function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(Math.abs(value) >= 10 ? 0 : 1)}%`;
}

export function sortFeedRows(rows: PumpFeedRow[]): PumpFeedRow[] {
  const copy = [...rows];
  const byTime = (row: PumpFeedRow) =>
    row.receivedAt
      ? new Date(row.receivedAt).getTime()
      : (row.lastTradeAtMs ?? 0);
  const byTrades = (row: PumpFeedRow) => row.trades?.length ?? 0;
  switch (state.pumpFeedSort) {
    case "mcap-desc":
      return copy.sort(
        (a, b) => (latestMcap(b) ?? -Infinity) - (latestMcap(a) ?? -Infinity),
      );
    case "mcap-asc":
      return copy.sort(
        (a, b) => (latestMcap(a) ?? Infinity) - (latestMcap(b) ?? Infinity),
      );
    case "mcap-change-desc":
      return copy.sort(
        (a, b) => (mcapChange(b) ?? -Infinity) - (mcapChange(a) ?? -Infinity),
      );
    case "mcap-change-pct-desc":
      return copy.sort(
        (a, b) =>
          (mcapChangePct(b) ?? -Infinity) - (mcapChangePct(a) ?? -Infinity),
      );
    case "trades-desc":
      return copy.sort((a, b) => byTrades(b) - byTrades(a));
    default:
      return copy.sort((a, b) => byTime(b) - byTime(a));
  }
}

export function sortWatchRows(rows: TokenWatchToken[]): TokenWatchToken[] {
  const copy = [...rows];
  switch (state.watchSort) {
    case "mcap-asc":
      return copy.sort(
        (a, b) => (latestMcap(a) ?? Infinity) - (latestMcap(b) ?? Infinity),
      );
    case "mcap-change-desc":
      return copy.sort(
        (a, b) => (mcapChange(b) ?? -Infinity) - (mcapChange(a) ?? -Infinity),
      );
    case "mcap-change-pct-desc":
      return copy.sort(
        (a, b) =>
          (mcapChangePct(b) ?? -Infinity) - (mcapChangePct(a) ?? -Infinity),
      );
    case "sma1m-desc":
      return copy.sort(
        (a, b) => (b.sma1m ?? -Infinity) - (a.sma1m ?? -Infinity),
      );
    case "trades-desc":
      return copy.sort(
        (a, b) =>
          (b.trades?.length ?? b.samples.length) -
          (a.trades?.length ?? a.samples.length),
      );
    case "newest":
      return copy.sort((a, b) => b.addedAtMs - a.addedAtMs);
    default:
      return copy.sort(
        (a, b) => (latestMcap(b) ?? -Infinity) - (latestMcap(a) ?? -Infinity),
      );
  }
}

export function age(ms: number | null | undefined): string {
  if (!ms) return "—";
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}

export function selectedWatchGroup(): TokenWatchGroup | null {
  return (
    state.watchGroups.find(
      (group) => group.id === state.selectedWatchGroupId,
    ) ??
    state.watchGroups[0] ??
    null
  );
}

export async function refreshWatchGroups(): Promise<void> {
  state.watchGroups = await api<TokenWatchGroup[]>("/api/watch-groups");
  if (!state.selectedWatchGroupId && state.watchGroups[0])
    state.selectedWatchGroupId = state.watchGroups[0].id;
  if (
    state.selectedWatchGroupId &&
    !state.watchGroups.some((group) => group.id === state.selectedWatchGroupId)
  ) {
    state.selectedWatchGroupId = state.watchGroups[0]?.id ?? null;
  }
}

export async function refreshPortfolio(): Promise<void> {
  state.portfolio = await api<Portfolio>("/api/portfolio");
}

export async function refreshSignals(): Promise<void> {
  state.signals = await api<TelegramSignalsState>("/api/signals");
  const source = state.signals.sources[0];
  if (!state.signalSourceId && source) state.signalSourceId = source.id;
}

export async function signalAction(
  action: string,
  payload: AnyRow = {},
): Promise<void> {
  const result = await api<any>("/api/signals", {
    method: "POST",
    body: JSON.stringify({ action, ...payload }),
  });
  state.signals = action === "ingest" && result?.state ? result.state : result;
}

export async function refreshPumpLive(): Promise<void> {
  const live = await api<{
    newTokens: PumpFeedRow[];
    watchGroups: TokenWatchGroup[];
  }>("/api/pump-live");
  state.pumpFeed = [...(live.newTokens ?? []), ...state.pumpFeed]
    .filter((row, index, arr) =>
      row.mint
        ? arr.findIndex((item) => item.mint === row.mint) === index
        : index < 500,
    )
    .slice(0, 500);
  state.watchGroups = live.watchGroups ?? state.watchGroups;
  if (!state.selectedWatchGroupId && state.watchGroups[0])
    state.selectedWatchGroupId = state.watchGroups[0].id;
}

export async function createWatchGroup(name: string): Promise<void> {
  const created = await api<TokenWatchGroup>("/api/watch-groups", {
    method: "POST",
    body: JSON.stringify({ action: "create-group", name }),
  });
  await refreshWatchGroups();
  state.selectedWatchGroupId = created.id;
}

export async function addWatchedToken(
  groupId: string,
  token: {
    mint: string;
    name?: string | null;
    symbol?: string | null;
    creator?: string | null;
    uri?: string | null;
    image?: string | null;
    signature?: string | null;
    marketCapSol?: number | null;
    source?: string;
  },
): Promise<void> {
  await api<TokenWatchGroup>("/api/watch-groups", {
    method: "POST",
    body: JSON.stringify({ action: "add-token", groupId, token }),
  });
  await refreshWatchGroups();
}

export async function removeWatchedToken(
  groupId: string,
  mint: string,
): Promise<void> {
  await api<TokenWatchGroup>("/api/watch-groups", {
    method: "POST",
    body: JSON.stringify({ action: "remove-token", groupId, mint }),
  });
  await refreshWatchGroups();
}

export async function starPumpFeedRow(
  row: PumpFeedRow,
  groupId?: string | null,
): Promise<void> {
  if (!row.mint) throw new Error("Feed row has no mint");
  let targetGroupId = groupId ?? selectedWatchGroup()?.id ?? null;
  if (!targetGroupId) {
    await createWatchGroup("main");
    targetGroupId = selectedWatchGroup()?.id ?? null;
  }
  if (!targetGroupId) throw new Error("No watch group available");
  await addWatchedToken(targetGroupId, {
    mint: row.mint,
    name: row.name ?? null,
    symbol: row.symbol ?? null,
    creator: row.creator ?? null,
    uri: row.uri ?? null,
    image: row.image ?? null,
    signature: row.signature ?? null,
    marketCapSol: row.marketCapSol ?? null,
    isMayhemMode: row.isMayhemMode ?? null,
    quoteAsset: row.quoteAsset ?? null,
    quoteMint: row.quoteMint ?? null,
    source: "pump-feed",
  });
}

export async function quickBuyPumpFeedRow(row: PumpFeedRow): Promise<void> {
  if (!row.mint) throw new Error("Feed row has no mint");
  if (!state.terminalDefaultWallet.trim())
    throw new Error(
      "Choose a default wallet before quick-buying from the terminal",
    );
  if (!state.terminalDefaultBuySol.trim())
    throw new Error(
      "Set a default buy amount before quick-buying from the terminal",
    );
  await api("/api/trade/buy", {
    method: "POST",
    body: JSON.stringify({
      wallet: state.terminalDefaultWallet.trim(),
      token: row.mint,
      amountSol: state.terminalDefaultBuySol.trim(),
      slippageBps: state.terminalDefaultSlippageBps.trim() || "9999",
      sender: state.terminalDefaultSender,
      tipSol: state.terminalDefaultTipSol.trim() || "0.001",
      priorityMicroLamports:
        state.terminalDefaultPriorityMicroLamports.trim() || "1500000",
      live: state.terminalQuickLive ? "true" : "false",
      skipSimulation: state.terminalQuickLive ? "true" : "false",
      skipPreflight: "true",
    }),
  });
}

let pumpFeedUpdateScheduled = false;
export function schedulePumpFeedUpdate(): void {
  if (pumpFeedUpdateScheduled) return;
  pumpFeedUpdateScheduled = true;
  setTimeout(() => {
    pumpFeedUpdateScheduled = false;
    update();
  }, 120);
}

export function mergePumpToken(row: PumpFeedRow): void {
  if (!row.mint) return appendPumpFeed(row);
  const existingIndex = state.pumpFeed.findIndex(
    (item) => item.mint === row.mint,
  );
  if (existingIndex >= 0) {
    state.pumpFeed[existingIndex] = {
      ...state.pumpFeed[existingIndex],
      ...row,
    };
    state.pumpFeed = [
      state.pumpFeed[existingIndex],
      ...state.pumpFeed.filter((_item, index) => index !== existingIndex),
    ].slice(0, 500);
  } else {
    state.pumpFeed = [row, ...state.pumpFeed].slice(0, 500);
  }
  for (const group of state.watchGroups) {
    const tokenIndex = group.tokens.findIndex(
      (token) => token.mint === row.mint,
    );
    if (tokenIndex >= 0)
      group.tokens[tokenIndex] = { ...group.tokens[tokenIndex], ...row } as any;
  }
  schedulePumpFeedUpdate();
}

export function appendPumpFeed(row: PumpFeedRow): void {
  state.pumpFeed = [row, ...state.pumpFeed].slice(0, 500);
  schedulePumpFeedUpdate();
}

export function handleSseBlock(block: string): void {
  const lines = block.split("\n");
  let event = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:"))
      dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return;
  const text = dataLines.join("\n");
  try {
    const payload = JSON.parse(text);
    if (event === "token") mergePumpToken(payload as PumpFeedRow);
    else if (event === "trade") mergePumpToken(payload as PumpFeedRow);
    else if (event === "status") {
      state.pumpFeedStatus = (payload.status ??
        event) as State["pumpFeedStatus"];
      state.pumpFeedError = null;
      schedulePumpFeedUpdate();
    } else if (event === "warning") {
      state.pumpFeedError = payload.error ?? "Pump feed warning";
      schedulePumpFeedUpdate();
    }
  } catch {
    state.pumpFeedError = text;
    schedulePumpFeedUpdate();
  }
}

export async function startPumpFeed(): Promise<void> {
  state.pumpFeedAbort?.abort();
  const abort = new AbortController();
  state.pumpFeedAbort = abort;
  state.pumpFeedStatus = "connecting";
  state.pumpFeedError = null;
  update();
  try {
    const response = await fetch(
      `/api/pump-live?stream=1&source=${encodeURIComponent(state.pumpFeedSource)}`,
      { headers: authHeaders(), signal: abort.signal },
    );
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error ?? `Pump feed HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!abort.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        handleSseBlock(block);
        split = buffer.indexOf("\n\n");
      }
    }
    if (!abort.signal.aborted) state.pumpFeedStatus = "closed";
  } catch (error) {
    if (!abort.signal.aborted) {
      state.pumpFeedStatus = "error";
      state.pumpFeedError =
        error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (state.pumpFeedAbort === abort) state.pumpFeedAbort = null;
    update();
  }
}

export function stopPumpFeed(): void {
  state.pumpFeedAbort?.abort();
  state.pumpFeedAbort = null;
  state.pumpFeedStatus = "closed";
  update();
}

export function formData(form: HTMLFormElement): AnyRow {
  return Object.fromEntries(new FormData(form).entries());
}

export async function refreshStatus(): Promise<void> {
  state.rpcStatus = await api<AnyRow>("/api/status");
  const status = document.getElementById("connection-status");
  if (status) {
    status.textContent = state.rpcStatus?.ok ? "connected" : "rpc error";
    status.className = state.rpcStatus?.ok ? "pill ok" : "pill bad";
  }
  const last = document.getElementById("last-refresh");
  if (last) last.textContent = new Date().toLocaleTimeString();
}

export async function refreshOverview(): Promise<void> {
  const rpcStatus = await api<AnyRow>("/api/status").catch(() => null);
  if (rpcStatus) state.rpcStatus = rpcStatus;

  try {
    // Fast path: local SQLite only. This makes wallets/groups/tokens appear instantly.
    const fast = await api<Overview>("/api/overview?fast=1");
    state.overview = fast;
    state.error = null;
    update();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.error = `Local overview unavailable: ${message}`;
    if (!state.overview)
      state.overview = {
        wallets: [],
        tokens: [],
        groups: [],
        executions: [],
        balances: [],
      };
  }

  try {
    // Slow path: RPC SOL balances. No token-account crawling on Home.
    const full = await api<Overview>("/api/overview?balances=sol");
    state.overview = full;
    state.error = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.error = `Balance refresh delayed: ${message}`;
  }

  const status = document.getElementById("connection-status");
  if (status) {
    status.textContent =
      state.rpcStatus?.ok === false ? "rpc error" : "connected";
    status.className = state.rpcStatus?.ok === false ? "pill bad" : "pill ok";
  }
  const last = document.getElementById("last-refresh");
  if (last) last.textContent = new Date().toLocaleTimeString();
}

export async function refreshJobs(): Promise<void> {
  state.jobs = await api<AnyRow[]>("/api/jobs");
  if (state.selectedJobId)
    state.selectedJob = await api<AnyRow>(
      `/api/jobs?id=${encodeURIComponent(state.selectedJobId)}`,
    );
}

export async function runAction<T>(
  fn: () => Promise<T>,
): Promise<T | undefined> {
  state.busy = true;
  state.error = null;
  update();
  try {
    const result = await fn();
    await Promise.allSettled([refreshOverview(), refreshJobs()]);
    return result;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.busy = false;
    update();
  }
}

export function statusClass(status: string | undefined | null): string {
  if (status === "succeeded" || status === "confirmed") return "ok";
  if (status === "failed") return "bad";
  if (status === "running" || status === "planned" || status === "broadcast")
    return "warn";
  return "";
}

export function isRetryExecution(row: AnyRow): boolean {
  const kind = String(row.kind ?? "");
  return (
    kind.includes(":attempt:") ||
    /:trader:\d+/.test(kind) ||
    kind.includes(":retry")
  );
}

export function friendlyExecutionKind(kind: unknown): string {
  const text = String(kind ?? "—");
  if (text.includes("launch:pump") || text.includes("launch-pump"))
    return "Pump launch";
  if (text.includes(":create-and-creator-buy")) return "Create token";
  if (text.includes(":trader:")) return "Follower buy attempt";
  if (text.includes("buy")) return "Buy";
  if (text.includes("sell")) return "Sell";
  return text.replace(/^cli:/, "");
}

export function jobHeadline(job: AnyRow | null | undefined): string {
  if (!job) return "No run selected";
  const token =
    job.result?.token?.symbol ||
    job.result?.token?.alias ||
    job.result?.token?.mint;
  return token ? `Pump launch: ${token}` : String(job.kind ?? "Launch run");
}

export function jobStatusPill(job: AnyRow | null | undefined) {
  if (!job) return null;
  return (
    <span className={`pill ${statusClass(job.status)}`}>{job.status}</span>
  );
}

export function latestJob(): AnyRow | null {
  return state.selectedJob ?? state.jobs[0] ?? null;
}

export function LaunchRunSummary({ job }: { job: AnyRow | null }) {
  if (!job) return null;
  const logs = Array.isArray(job.logs) ? job.logs : [];
  const fatal =
    logs.findLast?.((entry: AnyRow) =>
      String(entry.label ?? "")
        .toLowerCase()
        .includes("fatal"),
    ) ??
    logs.find((entry: AnyRow) =>
      String(entry.label ?? "")
        .toLowerCase()
        .includes("fatal"),
    );
  const plan = logs.find((entry: AnyRow) =>
    String(entry.label ?? "").includes("plan"),
  );
  const result =
    job.result ??
    logs.findLast?.((entry: AnyRow) =>
      String(entry.label ?? "").includes("result"),
    )?.value;
  return (
    <div className="run-card">
      <div className="run-card-head">
        <div>
          <div className="section-kicker">Current run</div>
          <h3>{jobHeadline(job)}</h3>
          <p className="muted small">
            Started {new Date(job.createdAtMs).toLocaleString()} · updated{" "}
            {new Date(job.updatedAtMs ?? job.createdAtMs).toLocaleTimeString()}
          </p>
        </div>
        <div className="row">
          {jobStatusPill(job)}
          <button
            type="button"
            className="secondary compact"
            onClick={() => navigatePage("jobs")}
          >
            Open activity
          </button>
        </div>
      </div>
      {fatal ? (
        <div className="callout bad">
          <b>Run failed:</b>{" "}
          {String(fatal.value ?? job.error ?? "Unknown error").slice(0, 420)}
        </div>
      ) : null}
      {job.status === "running" ? (
        <div className="callout warn">
          Running. Expected transient retry failures are hidden from Home; open
          Activity for detailed logs.
        </div>
      ) : null}
      <div className="run-metrics">
        <span>
          <b>{logs.length}</b>
          <small>log events</small>
        </span>
        <span>
          <b>
            {plan?.value?.participants?.length ?? result?.buyers?.length ?? "—"}
          </b>
          <small>follower lanes</small>
        </span>
        <span>
          <b>{result?.mint ?? result?.token?.mint ?? "—"}</b>
          <small>mint</small>
        </span>
      </div>
    </div>
  );
}

export function ConnectionStrip() {
  const status = state.rpcStatus;
  const wallets = state.overview?.wallets ?? [];
  return (
    <div className="connection-strip">
      <div className="conn-cell">
        <span className={`dot ${status?.ok ? "good" : "bad"}`} />
        <div>
          <div className="label">RPC</div>
          <div className="code">{status?.rpc?.url ?? "not checked"}</div>
        </div>
      </div>
      <div className="conn-cell compact">
        <div className="label">SOURCE</div>
        <div>{status?.rpc?.source ?? "—"}</div>
      </div>
      <div className="conn-cell compact">
        <div className="label">API KEY</div>
        <div>{status?.rpc?.hasApiKey ? "yes" : "no / unknown"}</div>
      </div>
      <div className="conn-cell compact">
        <div className="label">PING</div>
        <div>{status?.latencyMs != null ? `${status.latencyMs}ms` : "—"}</div>
      </div>
      <div className="conn-cell compact">
        <div className="label">SLOT</div>
        <div>{status?.slot ?? "—"}</div>
      </div>
      <label className="conn-select">
        <span>Current wallet</span>
        <select
          value={state.terminalDefaultWallet}
          onInput={(event: any) => {
            state.terminalDefaultWallet = event.currentTarget.value;
            localStorage.setItem(
              "solwal:terminal-default-wallet",
              state.terminalDefaultWallet,
            );
            update();
          }}
        >
          <option value="">select wallet…</option>
          {wallets.map((wallet: AnyRow) => (
            <option value={wallet.address}>
              {wallet.name
                ? `${wallet.name} · ${short(wallet.address)}`
                : wallet.address}
            </option>
          ))}
        </select>
      </label>
      <label className="conn-amount">
        <span>Default buy SOL</span>
        <input
          value={state.terminalDefaultBuySol}
          onInput={(event: any) => {
            state.terminalDefaultBuySol = event.currentTarget.value;
            localStorage.setItem(
              "solwal:terminal-default-buy-sol",
              state.terminalDefaultBuySol,
            );
          }}
        />
      </label>
      <button
        type="button"
        className="secondary compact"
        onClick={() => void runAction(refreshStatus)}
      >
        Ping
      </button>
    </div>
  );
}

export function walletGroupBadges(row: AnyRow): any {
  const groups = row.wallet?.groups ?? row.groupNames ?? [];
  if (!Array.isArray(groups) || groups.length === 0)
    return <span className="muted tiny">no groups</span>;
  return groups.map((name: string) => (
    <span className="group-chip">{name}</span>
  ));
}

export function walletHoldingsChips(tokens: AnyRow[] | undefined): any {
  const rows = tokens ?? [];
  if (!rows.length)
    return <span className="muted tiny">no token holdings loaded here</span>;
  return rows.slice(0, 12).map((token: AnyRow) => (
    <span
      className="holding"
      title={`${token.mint ?? ""} ${token.amountUi ?? token.amountRaw ?? ""}`}
    >
      {token.symbol ? `$${token.symbol}` : short(token.mint, 3, 3)}{" "}
      {token.amountUi ?? token.amountRaw}
    </span>
  ));
}

export function walletBalanceForAddress(
  address: string | undefined,
): AnyRow | null {
  if (!address) return null;
  const target = String(address).toLowerCase();
  return (
    (state.overview?.balances ?? []).find(
      (row: AnyRow) =>
        String(row.wallet?.address ?? "").toLowerCase() === target,
    ) ?? null
  );
}

export function newBuyPlanRow(seed: Partial<BuyPlanRow> = {}): BuyPlanRow {
  return {
    id: String(Date.now()) + ":" + Math.random().toString(36).slice(2),
    wallet: "",
    label: "",
    amountMode: "range-bps",
    minBps: "5000",
    maxBps: "8000",
    reserveSol: "0.02",
    exactSol: "",
    exactLamports: "",
    sender: "helius-fast",
    strategy: "fast-spam",
    tipSol: "0.001",
    priorityMicroLamports: "1500000",
    slippageBps: "9999",
    retryIntervalMs: "75",
    recompileIntervalMs: "750",
    freshQuoteDelayMs: "-1",
    maxFailedAttempts: "0",
    ...seed,
  };
}

export function updateBuyPlanRow(id: string, patch: Partial<BuyPlanRow>): void {
  state.buyPlanRows = state.buyPlanRows.map((row) =>
    row.id === id ? { ...row, ...patch } : row,
  );
  update();
}

export function removeBuyPlanRow(id: string): void {
  state.buyPlanRows = state.buyPlanRows.filter((row) => row.id !== id);
  update();
}

export function walletLabel(wallet: AnyRow): string {
  return wallet.name
    ? `${wallet.name} — ${short(wallet.address, 4, 4)}`
    : wallet.address;
}

export function populateBuyPlanFromGroup(groupName: string): void {
  const group = state.overview?.groups.find(
    (item: AnyRow) => item.name === groupName,
  );
  const members = group?.wallets ?? [];
  state.buyPlanRows = members.map((member: AnyRow, index: number) =>
    newBuyPlanRow({
      wallet:
        member.walletAddress ?? member.address ?? String(member.wallet ?? ""),
      label: `buyer-${index + 1}`,
    }),
  );
  update();
}

export function buyPlanPayload(): AnyRow[] {
  return state.buyPlanRows
    .filter((row) => row.wallet.trim())
    .map((row) => ({
      wallet: row.wallet.trim(),
      label: row.label.trim() || undefined,
      amountMode: row.amountMode,
      minBps: row.amountMode === "range-bps" ? row.minBps : undefined,
      maxBps: row.amountMode === "range-bps" ? row.maxBps : undefined,
      reserveSol: row.amountMode === "range-bps" ? row.reserveSol : undefined,
      exactSol: row.amountMode === "exact-sol" ? row.exactSol : undefined,
      exactLamports:
        row.amountMode === "exact-lamports" ? row.exactLamports : undefined,
      sender: row.sender,
      strategy: row.strategy,
      tipSol: row.sender === "helius-fast" ? row.tipSol : undefined,
      priorityMicroLamports: row.priorityMicroLamports,
      slippageBps: row.slippageBps,
      retryIntervalMs: row.retryIntervalMs,
      recompileIntervalMs: row.recompileIntervalMs,
      freshQuoteDelayMs: row.freshQuoteDelayMs,
      maxFailedAttempts: row.maxFailedAttempts,
    }));
}

export type ConsolePage = () => any;
let currentPageView: ConsolePage = () => (
  <p className="muted">No page mounted.</p>
);
let currentCleanup: (() => void) | null = null;

function ConsoleRuntime() {
  const Page = currentPageView;
  return (
    <>
      <div className="notice row global-console-controls">
        <label style="max-width: 360px">
          Web token, optional
          <input
            value={state.token}
            onInput={(event: any) => {
              state.token = event.currentTarget.value;
              localStorage.setItem("solwal:web-token", state.token);
            }}
          />
        </label>
        <button
          className="secondary"
          onClick={() => void runAction(refreshOverview)}
        >
          Refresh
        </button>
        {state.busy ? <span className="pill">working…</span> : null}
        {state.error ? <span className="pill bad">{state.error}</span> : null}
      </div>
      <ConnectionStrip />
      <Page />
    </>
  );
}

export function update() {
  const root = document.getElementById("app-root");
  if (root) render(<ConsoleRuntime />, root);
  document
    .querySelectorAll<HTMLAnchorElement>("#main-nav a")
    .forEach((link) =>
      link.classList.toggle("active", link.dataset.page === state.tab),
    );
}

export function mountPage(page: State["tab"], view: ConsolePage) {
  currentCleanup?.();
  currentCleanup = null;
  state.tab = page;
  currentPageView = view;
  void runAction(async () => {
    await refreshOverview();
    await refreshStatus().catch(() => undefined);
    await refreshJobs().catch(() => undefined);
    if (page === "terminal" || page === "watchlists")
      await refreshPumpLive().catch(() => undefined);
    if (page === "portfolio") await refreshPortfolio().catch(() => undefined);
    if (page === "signals") await refreshSignals().catch(() => undefined);
  });
  if (page === "terminal") void startPumpFeed();
  const interval = setInterval(() => {
    if (state.tab === "jobs" || state.selectedJobId)
      void refreshJobs()
        .then(update)
        .catch(() => undefined);
    if (state.tab === "watchlists" || state.tab === "terminal")
      void refreshPumpLive()
        .then(update)
        .catch(() => undefined);
    if (state.tab === "signals")
      void refreshSignals()
        .then(update)
        .catch(() => undefined);
    if (state.tab === "portfolio")
      void refreshPortfolio()
        .then(update)
        .catch(() => undefined);
    void refreshStatus()
      .then(update)
      .catch(() => undefined);
  }, 1500);
  currentCleanup = () => {
    clearInterval(interval);
    state.pumpFeedAbort?.abort();
    state.pumpFeedAbort = null;
  };
  update();
  return currentCleanup;
}
