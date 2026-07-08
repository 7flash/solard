import { render } from "tradjs/client";

type AnyRow = Record<string, any>;
type Overview = {
  wallets: AnyRow[];
  tokens: AnyRow[];
  groups: AnyRow[];
  executions: AnyRow[];
  balances: AnyRow[];
};

type BuyPlanRow = {
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

type PumpFeedRow = {
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

type TokenWatchSample = {
  capturedAtMs: number;
  marketCapSol: number | null;
  source?: string | null;
};

type TokenWatchToken = {
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

type TokenWatchGroup = {
  id: string;
  name: string;
  createdAtMs: number;
  updatedAtMs: number;
  tokens: TokenWatchToken[];
};

type TelegramSignalSource = {
  id: string;
  kind: "telegram" | "manual";
  name: string;
  chatRef?: string | null;
  isActive: boolean;
  createdAtMs: number;
  updatedAtMs: number;
};

type TelegramSignal = {
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

type TelegramSignalsState = {
  version: 1;
  sources: TelegramSignalSource[];
  signals: TelegramSignal[];
};

type State = {
  tab:
    | "overview"
    | "wallets"
    | "terminal"
    | "watchlists"
    | "signals"
    | "launch"
    | "trade"
    | "jobs";
  overview: Overview | null;
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

const state: State = {
  tab: "overview",
  overview: null,
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

function pageFromPath(): State["tab"] {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path.endsWith("/wallets")) return "wallets";
  if (path.endsWith("/terminal")) return "terminal";
  if (path.endsWith("/watchlists")) return "watchlists";
  if (path.endsWith("/signals")) return "signals";
  if (path.endsWith("/launch")) return "launch";
  if (path.endsWith("/trade")) return "trade";
  if (path.endsWith("/activity")) return "jobs";
  return "overview";
}

function pageHref(page: State["tab"]): string {
  if (page === "overview") return "/";
  if (page === "jobs") return "/activity";
  return `/${page}`;
}

function navigatePage(page: State["tab"]): void {
  window.location.href = pageHref(page);
}

function authHeaders(): HeadersInit {
  return state.token ? { "x-solwal-web-token": state.token } : {};
}

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
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

function short(value: string | null | undefined, head = 6, tail = 6): string {
  if (!value) return "—";
  return value.length <= head + tail + 1
    ? value
    : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function solFromLamports(value: any): string {
  const raw = typeof value === "bigint" ? value : BigInt(String(value ?? "0"));
  const whole = raw / 1_000_000_000n;
  const frac = (raw % 1_000_000_000n)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}`;
}

function formatSol(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value >= 0.001
    ? value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")
    : value.toExponential(2);
}

function tokenUrl(mint: string | null | undefined): string {
  return mint ? `https://pump.fun/coin/${mint}` : "#";
}

function tokenImage(row: {
  image?: string | null;
  uri?: string | null;
}): string | null {
  const image = row.image || null;
  if (!image) return null;
  return image.startsWith("ipfs://")
    ? `https://ipfs.io/ipfs/${image.slice(7)}`
    : image;
}

function isMayhemToken(row: {
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

function isUsdcToken(row: {
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

function passesBadgeFilters(row: {
  isMayhemMode?: boolean | null;
  quoteAsset?: string | null;
  quoteMint?: string | null;
  raw?: AnyRow;
}): boolean {
  if (state.hideMayhem && isMayhemToken(row)) return false;
  if (state.hideUsdc && isUsdcToken(row)) return false;
  return true;
}

function TokenBadges(row: {
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

function formatMcap(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value >= 1
    ? value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")
    : value.toExponential(2);
}

function latestMcap(row: {
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

function initialMcap(row: {
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

function mcapChange(row: {
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

function mcapChangePct(row: {
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

function formatSignedMcap(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatMcap(value)}`;
}

function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(Math.abs(value) >= 10 ? 0 : 1)}%`;
}

function sortFeedRows(rows: PumpFeedRow[]): PumpFeedRow[] {
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

function sortWatchRows(rows: TokenWatchToken[]): TokenWatchToken[] {
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

function age(ms: number | null | undefined): string {
  if (!ms) return "—";
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}

function selectedWatchGroup(): TokenWatchGroup | null {
  return (
    state.watchGroups.find(
      (group) => group.id === state.selectedWatchGroupId,
    ) ??
    state.watchGroups[0] ??
    null
  );
}

async function refreshWatchGroups(): Promise<void> {
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

async function refreshSignals(): Promise<void> {
  state.signals = await api<TelegramSignalsState>("/api/signals");
  const source = state.signals.sources[0];
  if (!state.signalSourceId && source) state.signalSourceId = source.id;
}

async function signalAction(
  action: string,
  payload: AnyRow = {},
): Promise<void> {
  const result = await api<any>("/api/signals", {
    method: "POST",
    body: JSON.stringify({ action, ...payload }),
  });
  state.signals = action === "ingest" && result?.state ? result.state : result;
}

async function refreshPumpLive(): Promise<void> {
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

async function createWatchGroup(name: string): Promise<void> {
  const created = await api<TokenWatchGroup>("/api/watch-groups", {
    method: "POST",
    body: JSON.stringify({ action: "create-group", name }),
  });
  await refreshWatchGroups();
  state.selectedWatchGroupId = created.id;
}

async function addWatchedToken(
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

async function removeWatchedToken(
  groupId: string,
  mint: string,
): Promise<void> {
  await api<TokenWatchGroup>("/api/watch-groups", {
    method: "POST",
    body: JSON.stringify({ action: "remove-token", groupId, mint }),
  });
  await refreshWatchGroups();
}

async function starPumpFeedRow(
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

async function quickBuyPumpFeedRow(row: PumpFeedRow): Promise<void> {
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
function schedulePumpFeedUpdate(): void {
  if (pumpFeedUpdateScheduled) return;
  pumpFeedUpdateScheduled = true;
  setTimeout(() => {
    pumpFeedUpdateScheduled = false;
    update();
  }, 120);
}

function mergePumpToken(row: PumpFeedRow): void {
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

function appendPumpFeed(row: PumpFeedRow): void {
  mergePumpToken(row);
}

function handleSseBlock(block: string): void {
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

async function startPumpFeed(): Promise<void> {
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

function stopPumpFeed(): void {
  state.pumpFeedAbort?.abort();
  state.pumpFeedAbort = null;
  state.pumpFeedStatus = "closed";
  update();
}

function formData(form: HTMLFormElement): AnyRow {
  return Object.fromEntries(new FormData(form).entries());
}

async function refreshStatus(): Promise<void> {
  state.rpcStatus = await api<AnyRow>("/api/status");
  const status = document.getElementById("connection-status");
  if (status) {
    status.textContent = state.rpcStatus?.ok ? "connected" : "rpc error";
    status.className = state.rpcStatus?.ok ? "pill ok" : "pill bad";
  }
  const last = document.getElementById("last-refresh");
  if (last) last.textContent = new Date().toLocaleTimeString();
}

async function refreshOverview(): Promise<void> {
  const rpcStatus = await api<AnyRow>("/api/status").catch(() => null);
  if (rpcStatus) state.rpcStatus = rpcStatus;

  try {
    state.overview = await api<Overview>("/api/overview");
  } catch (error) {
    // The home screen must stay usable even when RPC/account enrichment is unavailable.
    // Keep the last successful overview and surface the issue in the global status area.
    const message = error instanceof Error ? error.message : String(error);
    state.error = `Overview unavailable: ${message}`;
    if (!state.overview) {
      state.overview = {
        wallets: [],
        tokens: [],
        groups: [],
        executions: [],
        balances: [],
      };
    }
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

async function refreshJobs(): Promise<void> {
  state.jobs = await api<AnyRow[]>("/api/jobs");
  if (state.selectedJobId)
    state.selectedJob = await api<AnyRow>(
      `/api/jobs?id=${encodeURIComponent(state.selectedJobId)}`,
    );
}

async function runAction<T>(fn: () => Promise<T>): Promise<T | undefined> {
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

function statusClass(status: string | undefined | null): string {
  if (status === "succeeded" || status === "confirmed") return "ok";
  if (status === "failed") return "bad";
  if (status === "running" || status === "planned" || status === "broadcast")
    return "warn";
  return "";
}

function isRetryExecution(row: AnyRow): boolean {
  const kind = String(row.kind ?? "");
  return (
    kind.includes(":attempt:") ||
    /:trader:\d+/.test(kind) ||
    kind.includes(":retry")
  );
}

function friendlyExecutionKind(kind: unknown): string {
  const text = String(kind ?? "—");
  if (text.includes("launch:pump") || text.includes("launch-pump"))
    return "Pump launch";
  if (text.includes(":create-and-creator-buy")) return "Create token";
  if (text.includes(":trader:")) return "Follower buy attempt";
  if (text.includes("buy")) return "Buy";
  if (text.includes("sell")) return "Sell";
  return text.replace(/^cli:/, "");
}

function jobHeadline(job: AnyRow | null | undefined): string {
  if (!job) return "No run selected";
  const token =
    job.result?.token?.symbol ||
    job.result?.token?.alias ||
    job.result?.token?.mint;
  return token ? `Pump launch: ${token}` : String(job.kind ?? "Launch run");
}

function jobStatusPill(job: AnyRow | null | undefined) {
  if (!job) return null;
  return (
    <span className={`pill ${statusClass(job.status)}`}>{job.status}</span>
  );
}

function latestJob(): AnyRow | null {
  return state.selectedJob ?? state.jobs[0] ?? null;
}

function LaunchRunSummary({ job }: { job: AnyRow | null }) {
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

function ConnectionStrip() {
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

function Stats() {
  const data = state.overview;
  const visibleExecutions = (data?.executions ?? []).filter(
    (row: AnyRow) => !isRetryExecution(row),
  );
  const hiddenRetries =
    (data?.executions ?? []).length - visibleExecutions.length;
  const walletCount = data?.wallets.length ?? 0;
  const balanceCount = data?.balances.length ?? 0;
  return (
    <div className="home-metrics">
      <div className="metric-card">
        <div className="muted small">Wallets loaded</div>
        <div className="stat">{walletCount || "—"}</div>
        <div className="muted small">
          {balanceCount
            ? `${balanceCount}/${walletCount} balance rows`
            : "waiting for overview"}
        </div>
      </div>
      <div className="metric-card">
        <div className="muted small">Groups</div>
        <div className="stat">{data?.groups.length ?? "—"}</div>
      </div>
      <div className="metric-card">
        <div className="muted small">Tokens tracked</div>
        <div className="stat">{data?.tokens.length ?? "—"}</div>
      </div>
      <div className="metric-card">
        <div className="muted small">High-level executions</div>
        <div className="stat">{visibleExecutions.length}</div>
        {hiddenRetries > 0 ? (
          <div className="muted small">
            {hiddenRetries} retry attempts hidden
          </div>
        ) : null}
      </div>
    </div>
  );
}

function walletHoldingsChips(tokens: AnyRow[] | undefined): any {
  const rows = tokens ?? [];
  if (!rows.length)
    return <span className="muted tiny">no non-zero token holdings</span>;
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

function OverviewView() {
  const data = state.overview;
  const visibleExecutions = (data?.executions ?? [])
    .filter((row: AnyRow) => !isRetryExecution(row))
    .slice(0, 12);
  const hiddenRetries = (data?.executions ?? []).filter((row: AnyRow) =>
    isRetryExecution(row),
  ).length;
  return (
    <div className="home-layout">
      <div className="home-top">
        <div>
          <div className="section-kicker">Console home</div>
          <h2>What needs attention</h2>
          <p className="muted">
            Home shows only high-level runs and balances. Spam/retry attempts
            are expected noise and are hidden here.
          </p>
        </div>
        <div className="quick-actions">
          <button type="button" onClick={() => navigatePage("terminal")}>
            Open Pump terminal
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => navigatePage("launch")}
          >
            Build launch
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                await refreshOverview();
                await refreshJobs();
                if (state.tab === "terminal" || state.tab === "watchlists")
                  await refreshPumpLive();
              })
            }
          >
            Refresh all
          </button>
        </div>
      </div>
      <Stats />
      <div className="home-columns">
        <div className="card">
          <div className="row between">
            <div>
              <h2>Wallet balances</h2>
              <div className="muted small">
                Showing all {(data?.balances ?? []).length} wallets from the
                local encrypted store.
              </div>
            </div>
            <button
              type="button"
              className="secondary compact"
              onClick={() => navigatePage("wallets")}
            >
              Manage
            </button>
          </div>
          <div className="wallet-balance-scroll">
            <table className="clean-table wallet-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Address</th>
                  <th>SOL</th>
                  <th>Non-zero holdings</th>
                </tr>
              </thead>
              <tbody>
                {(data?.balances ?? []).map((row: AnyRow) => (
                  <tr>
                    <td className="strong-cell">{row.wallet?.name ?? "—"}</td>
                    <td
                      className="code address-cell"
                      title={row.wallet?.address}
                    >
                      {short(row.wallet?.address)}
                    </td>
                    <td className="sol-cell">
                      {solFromLamports(row.solLamports)} SOL
                    </td>
                    <td>
                      <div className="holdings">
                        {walletHoldingsChips(row.visibleTokenBalances)}
                      </div>
                      {row.balanceWarning ? (
                        <div className="muted tiny">partial balance data</div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!(data?.balances ?? []).length ? (
            <p className="muted">
              No wallets returned by overview yet. Check SOWL_MASTER_KEY /
              SOLARD_MASTER_KEY and refresh.
            </p>
          ) : null}
        </div>
        <div className="card">
          <div className="row between">
            <h2>Launch / trade activity</h2>
            <button
              type="button"
              className="secondary compact"
              onClick={() => navigatePage("jobs")}
            >
              Open Activity
            </button>
          </div>
          {hiddenRetries > 0 ? (
            <div className="callout">
              {hiddenRetries} low-level retry attempts are hidden here. This
              does not mean the app failed; it means spam lanes retried.
            </div>
          ) : null}
          <table className="clean-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Action</th>
                <th>Wallet</th>
                <th>Signature</th>
              </tr>
            </thead>
            <tbody>
              {visibleExecutions.map((row: AnyRow) => (
                <tr>
                  <td>
                    <span className={`pill ${statusClass(row.status)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td>{friendlyExecutionKind(row.kind)}</td>
                  <td className="code">{short(row.walletAddress)}</td>
                  <td className="code">
                    {row.signature ? short(row.signature) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visibleExecutions.length ? (
            <p className="muted">No high-level execution rows yet.</p>
          ) : null}
        </div>
      </div>
      <LaunchRunSummary job={latestJob()} />
    </div>
  );
}

function walletBalanceForAddress(address: string | undefined): AnyRow | null {
  if (!address) return null;
  const target = String(address).toLowerCase();
  return (
    (state.overview?.balances ?? []).find(
      (row: AnyRow) =>
        String(row.wallet?.address ?? "").toLowerCase() === target,
    ) ?? null
  );
}

function WalletsView() {
  const data = state.overview;
  const walletQuery = state.walletSearch.trim().toLowerCase();
  const groupQuery = state.groupSearch.trim().toLowerCase();
  const wallets = (data?.wallets ?? []).filter((wallet: AnyRow) => {
    if (!walletQuery) return true;
    return (
      String(wallet.name ?? "")
        .toLowerCase()
        .includes(walletQuery) ||
      String(wallet.address ?? "")
        .toLowerCase()
        .includes(walletQuery)
    );
  });
  const groups = (data?.groups ?? []).filter((group: AnyRow) => {
    if (!groupQuery) return true;
    const haystack = [
      group.name,
      group.description,
      ...(group.wallets ?? []).map(
        (member: AnyRow) =>
          member.name ?? member.walletAddress ?? member.address,
      ),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(groupQuery);
  });
  const selectedWallet = state.terminalDefaultWallet
    ? data?.wallets?.find(
        (wallet: AnyRow) => wallet.address === state.terminalDefaultWallet,
      )
    : null;
  const selectedBalance = walletBalanceForAddress(state.terminalDefaultWallet);
  return (
    <div className="wallets-page">
      <section className="console-panel hero-panel">
        <div>
          <div className="section-kicker">Wallet command center</div>
          <h2>Wallets and groups</h2>
          <p className="muted">
            Encrypted local wallet store, buyer groups, default trading wallet,
            and live balances in one place.
          </p>
        </div>
        <div className="wallet-default-card">
          <label>
            <span>Default trading wallet</span>
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
              {(data?.wallets ?? []).map((wallet: AnyRow) => (
                <option value={wallet.address}>
                  {wallet.name
                    ? `${wallet.name} · ${short(wallet.address)}`
                    : wallet.address}
                </option>
              ))}
            </select>
          </label>
          <div className="wallet-default-meta">
            <b>{selectedWallet?.name ?? "no wallet selected"}</b>
            <span className="code">
              {selectedWallet?.address
                ? short(selectedWallet.address, 8, 8)
                : "—"}
            </span>
            <span>
              {selectedBalance
                ? `${solFromLamports(selectedBalance.solLamports)} SOL`
                : "—"}
            </span>
          </div>
        </div>
      </section>

      <div className="wallet-action-grid">
        <form
          className="console-panel"
          onSubmit={(event) => {
            event.preventDefault();
            const body = formData(event.currentTarget);
            void runAction(async () => {
              await api("/api/wallets/import", {
                method: "POST",
                body: JSON.stringify(body),
              });
              await refreshOverview();
            });
          }}
        >
          <h3>Import wallet</h3>
          <label>
            Name
            <input name="name" placeholder="main / buyer-1" />
          </label>
          <label>
            Private key
            <textarea
              name="privateKey"
              placeholder="base58 secret or keypair JSON"
            />
          </label>
          <button type="submit">Import encrypted wallet</button>
        </form>
        <form
          className="console-panel"
          onSubmit={(event) => {
            event.preventDefault();
            const body = formData(event.currentTarget);
            void runAction(async () => {
              await api("/api/groups/create", {
                method: "POST",
                body: JSON.stringify(body),
              });
              await refreshOverview();
            });
          }}
        >
          <h3>Create group</h3>
          <label>
            Group name
            <input name="name" placeholder="mind-buyers" />
          </label>
          <label>
            Description
            <input name="description" placeholder="Launch buyers / scalpers" />
          </label>
          <button type="submit">Create group</button>
        </form>
        <form
          className="console-panel"
          onSubmit={(event) => {
            event.preventDefault();
            const body = formData(event.currentTarget);
            void runAction(async () => {
              await api("/api/groups/add", {
                method: "POST",
                body: JSON.stringify(body),
              });
              await refreshOverview();
            });
          }}
        >
          <h3>Add member</h3>
          <label>
            Group
            <select name="groupName">
              <option value="">select group…</option>
              {(data?.groups ?? []).map((group: AnyRow) => (
                <option value={group.name}>{group.name}</option>
              ))}
            </select>
          </label>
          <label>
            Wallet
            <select name="wallet">
              <option value="">select wallet…</option>
              {(data?.wallets ?? []).map((wallet: AnyRow) => (
                <option value={wallet.address}>
                  {wallet.name
                    ? `${wallet.name} · ${short(wallet.address)}`
                    : wallet.address}
                </option>
              ))}
            </select>
          </label>
          <label>
            Weight bps
            <input name="weightBps" defaultValue="10000" />
          </label>
          <button type="submit">Add to group</button>
        </form>
      </div>

      <section className="console-panel">
        <div className="row between wrap">
          <div>
            <div className="section-kicker">Wallet inventory</div>
            <h2>All wallets</h2>
            <p className="muted small">
              {wallets.length}/{data?.wallets?.length ?? 0} wallets shown.
              Balances are best-effort RPC reads.
            </p>
          </div>
          <div className="toolbar compact-toolbar">
            <input
              value={state.walletSearch}
              placeholder="search name/address"
              onInput={(event: any) => {
                state.walletSearch = event.currentTarget.value;
                localStorage.setItem(
                  "solard:wallet-search",
                  state.walletSearch,
                );
                update();
              }}
            />
            <button
              type="button"
              className="secondary compact"
              onClick={() => void runAction(refreshOverview)}
            >
              Refresh
            </button>
          </div>
        </div>
        <div className="table-scroll tall-table">
          <table className="clean-table wallet-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Address</th>
                <th>SOL</th>
                <th>Holdings</th>
                <th>Use</th>
              </tr>
            </thead>
            <tbody>
              {wallets.map((wallet: AnyRow) => {
                const balance = walletBalanceForAddress(wallet.address);
                return (
                  <tr>
                    <td className="strong-cell">{wallet.name ?? "—"}</td>
                    <td className="code address-cell" title={wallet.address}>
                      {short(wallet.address, 8, 8)}
                    </td>
                    <td className="sol-cell">
                      {balance
                        ? `${solFromLamports(balance.solLamports)} SOL`
                        : "—"}
                    </td>
                    <td>
                      <div className="holdings">
                        {walletHoldingsChips(balance?.visibleTokenBalances)}
                      </div>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="secondary compact"
                        onClick={() => {
                          state.terminalDefaultWallet = wallet.address;
                          localStorage.setItem(
                            "solwal:terminal-default-wallet",
                            state.terminalDefaultWallet,
                          );
                          update();
                        }}
                      >
                        Set default
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="console-panel">
        <div className="row between wrap">
          <div>
            <div className="section-kicker">Buyer groups</div>
            <h2>Groups</h2>
            <p className="muted small">
              {groups.length}/{data?.groups?.length ?? 0} groups shown. Members
              are rendered as wallet chips.
            </p>
          </div>
          <input
            className="inline-search"
            value={state.groupSearch}
            placeholder="search groups"
            onInput={(event: any) => {
              state.groupSearch = event.currentTarget.value;
              localStorage.setItem("solard:group-search", state.groupSearch);
              update();
            }}
          />
        </div>
        <div className="group-grid">
          {groups.map((group: AnyRow) => (
            <div className="group-card">
              <div className="row between">
                <h3>{group.name}</h3>
                <span className="pill">
                  {group.wallets?.length ?? 0} wallets
                </span>
              </div>
              {group.description ? (
                <p className="muted small">{group.description}</p>
              ) : null}
              <div className="member-chip-list">
                {(group.wallets ?? []).map((member: AnyRow) => {
                  const address =
                    member.address ?? member.walletAddress ?? member.wallet;
                  const wallet = (data?.wallets ?? []).find(
                    (item: AnyRow) =>
                      item.address === address || item.name === member.name,
                  );
                  return (
                    <span className="member-chip" title={address}>
                      {wallet?.name ?? member.name ?? short(address)}{" "}
                      <small>{short(address, 4, 4)}</small>
                    </span>
                  );
                })}
                {!(group.wallets ?? []).length ? (
                  <span className="muted tiny">empty group</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function newBuyPlanRow(seed: Partial<BuyPlanRow> = {}): BuyPlanRow {
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

function updateBuyPlanRow(id: string, patch: Partial<BuyPlanRow>): void {
  state.buyPlanRows = state.buyPlanRows.map((row) =>
    row.id === id ? { ...row, ...patch } : row,
  );
  update();
}

function removeBuyPlanRow(id: string): void {
  state.buyPlanRows = state.buyPlanRows.filter((row) => row.id !== id);
  update();
}

function walletLabel(wallet: AnyRow): string {
  return wallet.name
    ? `${wallet.name} — ${short(wallet.address, 4, 4)}`
    : wallet.address;
}

function populateBuyPlanFromGroup(groupName: string): void {
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

function buyPlanPayload(): AnyRow[] {
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

function BuyPlanTable() {
  const wallets = state.overview?.wallets ?? [];
  const groups = state.overview?.groups ?? [];
  return (
    <div className="launch-panel span-12 buy-plan-panel">
      <div className="section-head">
        <div>
          <div className="section-kicker">Parallel followers</div>
          <h2>Follower buy plan</h2>
          <p className="muted">
            Each card is one wallet lane. Mix amount rules, sender, strategy,
            fees and retry rhythm in the same launch.
          </p>
        </div>
        <div className="plan-toolbar">
          <select id="buy-plan-group-select" className="group-picker">
            <option value="">Load wallets from group…</option>
            {groups.map((group: AnyRow) => (
              <option value={group.name}>{group.name}</option>
            ))}
          </select>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              const select = document.getElementById(
                "buy-plan-group-select",
              ) as HTMLSelectElement | null;
              if (select?.value) populateBuyPlanFromGroup(select.value);
            }}
          >
            Load group
          </button>
          <button
            type="button"
            onClick={() => {
              state.buyPlanRows = [
                ...state.buyPlanRows,
                newBuyPlanRow({
                  label: `buyer-${state.buyPlanRows.length + 1}`,
                }),
              ];
              update();
            }}
          >
            Add wallet
          </button>
        </div>
      </div>

      <div className="plan-summary">
        <span>
          <b>{state.buyPlanRows.length}</b> wallet lanes
        </span>
        <span>
          <b>
            {
              state.buyPlanRows.filter((row) => row.sender === "helius-fast")
                .length
            }
          </b>{" "}
          Helius fast
        </span>
        <span>
          <b>
            {
              state.buyPlanRows.filter((row) => row.strategy.includes("spam"))
                .length
            }
          </b>{" "}
          spam lanes
        </span>
        <span>Rows override the fallback buyer group settings.</span>
      </div>

      <div className="plan-list">
        {state.buyPlanRows.map((row, index) => (
          <div className="plan-card" data-sender={row.sender}>
            <div className="plan-card-top">
              <div className="lane-badge">#{index + 1}</div>
              <label className="field label-field">
                <span>Label</span>
                <input
                  placeholder="buyer-1"
                  value={row.label}
                  onInput={(event: any) =>
                    updateBuyPlanRow(row.id, {
                      label: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <label className="field wallet-field">
                <span>Wallet</span>
                <select
                  value={row.wallet}
                  onInput={(event: any) =>
                    updateBuyPlanRow(row.id, {
                      wallet: event.currentTarget.value,
                    })
                  }
                >
                  <option value="">Select wallet…</option>
                  {wallets.map((wallet: AnyRow) => (
                    <option value={wallet.address}>
                      {walletLabel(wallet)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field sender-field">
                <span>Sender</span>
                <select
                  value={row.sender}
                  onInput={(event: any) =>
                    updateBuyPlanRow(row.id, {
                      sender: event.currentTarget.value,
                    })
                  }
                >
                  <option value="helius-fast">Helius fast</option>
                  <option value="helius-rpc">Helius RPC</option>
                </select>
              </label>
              <label className="field strategy-field">
                <span>Strategy</span>
                <select
                  value={row.strategy}
                  onInput={(event: any) =>
                    updateBuyPlanRow(row.id, {
                      strategy: event.currentTarget.value,
                    })
                  }
                >
                  <option value="fast-spam">Fast spam</option>
                  <option value="spam-after-market-ready">
                    Market-ready spam
                  </option>
                  <option value="after-deploy-processed">
                    After processed
                  </option>
                  <option value="after-deploy-confirmed">
                    After confirmed
                  </option>
                </select>
              </label>
              <button
                type="button"
                className="danger compact"
                onClick={() => removeBuyPlanRow(row.id)}
              >
                Remove
              </button>
            </div>

            <div className="plan-card-body">
              <div className="plan-block amount-block">
                <div className="block-title">Amount</div>
                <div className="inline-fields">
                  <label className="field wide">
                    <span>Mode</span>
                    <select
                      value={row.amountMode}
                      onInput={(event: any) =>
                        updateBuyPlanRow(row.id, {
                          amountMode: event.currentTarget.value,
                        })
                      }
                    >
                      <option value="range-bps">Balance % range</option>
                      <option value="exact-sol">Exact SOL</option>
                      <option value="exact-lamports">Exact lamports</option>
                    </select>
                  </label>
                  {row.amountMode === "range-bps" ? (
                    <>
                      <label className="field">
                        <span>Min %</span>
                        <input
                          value={String(Number(row.minBps || "0") / 100)}
                          onInput={(event: any) =>
                            updateBuyPlanRow(row.id, {
                              minBps: String(
                                Math.round(
                                  Number(event.currentTarget.value || "0") *
                                    100,
                                ),
                              ),
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Max %</span>
                        <input
                          value={String(Number(row.maxBps || "0") / 100)}
                          onInput={(event: any) =>
                            updateBuyPlanRow(row.id, {
                              maxBps: String(
                                Math.round(
                                  Number(event.currentTarget.value || "0") *
                                    100,
                                ),
                              ),
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Reserve SOL</span>
                        <input
                          value={row.reserveSol}
                          onInput={(event: any) =>
                            updateBuyPlanRow(row.id, {
                              reserveSol: event.currentTarget.value,
                            })
                          }
                        />
                      </label>
                    </>
                  ) : null}
                  {row.amountMode === "exact-sol" ? (
                    <label className="field">
                      <span>Exact SOL</span>
                      <input
                        placeholder="0.25"
                        value={row.exactSol}
                        onInput={(event: any) =>
                          updateBuyPlanRow(row.id, {
                            exactSol: event.currentTarget.value,
                          })
                        }
                      />
                    </label>
                  ) : null}
                  {row.amountMode === "exact-lamports" ? (
                    <label className="field">
                      <span>Lamports</span>
                      <input
                        placeholder="250000000"
                        value={row.exactLamports}
                        onInput={(event: any) =>
                          updateBuyPlanRow(row.id, {
                            exactLamports: event.currentTarget.value,
                          })
                        }
                      />
                    </label>
                  ) : null}
                </div>
              </div>

              <div className="plan-block fee-block">
                <div className="block-title">Fees & slippage</div>
                <div className="inline-fields">
                  <label className="field">
                    <span>Tip SOL</span>
                    <input
                      value={row.tipSol}
                      disabled={row.sender !== "helius-fast"}
                      onInput={(event: any) =>
                        updateBuyPlanRow(row.id, {
                          tipSol: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Priority µ-lamports</span>
                    <input
                      value={row.priorityMicroLamports}
                      onInput={(event: any) =>
                        updateBuyPlanRow(row.id, {
                          priorityMicroLamports: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Slippage bps</span>
                    <input
                      value={row.slippageBps}
                      onInput={(event: any) =>
                        updateBuyPlanRow(row.id, {
                          slippageBps: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                </div>
              </div>

              <div className="plan-block retry-block">
                <div className="block-title">Retry</div>
                <div className="inline-fields">
                  <label className="field">
                    <span>Retry ms</span>
                    <input
                      value={row.retryIntervalMs}
                      onInput={(event: any) =>
                        updateBuyPlanRow(row.id, {
                          retryIntervalMs: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Recompile ms</span>
                    <input
                      value={row.recompileIntervalMs}
                      onInput={(event: any) =>
                        updateBuyPlanRow(row.id, {
                          recompileIntervalMs: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Fresh quote delay</span>
                    <input
                      value={row.freshQuoteDelayMs}
                      onInput={(event: any) =>
                        updateBuyPlanRow(row.id, {
                          freshQuoteDelayMs: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Max failed</span>
                    <input
                      value={row.maxFailedAttempts}
                      onInput={(event: any) =>
                        updateBuyPlanRow(row.id, {
                          maxFailedAttempts: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                </div>
              </div>
            </div>
          </div>
        ))}
        {state.buyPlanRows.length === 0 ? (
          <div className="empty-plan">
            <b>No custom follower rows.</b>
            <span>
              Load a group or add wallets manually. Without rows, the fallback
              buyer-group settings are used.
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TerminalView() {
  const filter = state.pumpFeedFilter.trim().toLowerCase();
  const visibleFeed = state.pumpFeed.filter(passesBadgeFilters);
  const filteredRows = filter
    ? visibleFeed.filter((row) =>
        [row.name, row.symbol, row.mint, row.creator, row.quoteAsset].some(
          (value) =>
            String(value ?? "")
              .toLowerCase()
              .includes(filter),
        ),
      )
    : visibleFeed;
  const rows = sortFeedRows(filteredRows);
  return (
    <div className="grid">
      <div className="card span-12 terminal-head">
        <div>
          <h2>Pump.fun new-token terminal</h2>
          <p className="muted">
            Stream new Pump launches directly from Helius or through PumpPortal.
            Pick a default wallet and amount, then quick-buy any row.
          </p>
        </div>
        <div className="terminal-controls">
          <label className="mini-field">
            <span>Source</span>
            <select
              value={state.pumpFeedSource}
              onInput={(event: any) => {
                state.pumpFeedSource = event.currentTarget.value;
                localStorage.setItem(
                  "solwal:pump-feed-source",
                  state.pumpFeedSource,
                );
                update();
              }}
            >
              <option value="helius">Helius direct</option>
              <option value="pumpportal">PumpPortal enriched</option>
            </select>
          </label>
          <label className="mini-field">
            <span>Wallet</span>
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
              <option value="">default wallet…</option>
              {(state.overview?.wallets ?? []).map((wallet: AnyRow) => (
                <option value={wallet.name ?? wallet.address}>
                  {wallet.name ?? short(wallet.address)} ·{" "}
                  {short(wallet.address, 4, 4)}
                </option>
              ))}
            </select>
          </label>
          <label className="mini-field">
            <span>Buy SOL</span>
            <input
              value={state.terminalDefaultBuySol}
              onInput={(event: any) => {
                state.terminalDefaultBuySol = event.currentTarget.value;
                localStorage.setItem(
                  "solwal:terminal-default-buy-sol",
                  state.terminalDefaultBuySol,
                );
                update();
              }}
            />
          </label>
          <label className="mini-field">
            <span>Sender</span>
            <select
              value={state.terminalDefaultSender}
              onInput={(event: any) => {
                state.terminalDefaultSender = event.currentTarget.value;
                localStorage.setItem(
                  "solwal:terminal-default-sender",
                  state.terminalDefaultSender,
                );
                update();
              }}
            >
              <option value="helius-fast">Helius fast</option>
              <option value="helius-rpc">Helius RPC</option>
              <option value="rpc">RPC</option>
            </select>
          </label>
          <label className="mini-field">
            <span>Slippage</span>
            <input
              value={state.terminalDefaultSlippageBps}
              onInput={(event: any) => {
                state.terminalDefaultSlippageBps = event.currentTarget.value;
                localStorage.setItem(
                  "solwal:terminal-default-slippage-bps",
                  state.terminalDefaultSlippageBps,
                );
                update();
              }}
            />
          </label>
          <label className="mini-field">
            <span>Tip SOL</span>
            <input
              value={state.terminalDefaultTipSol}
              onInput={(event: any) => {
                state.terminalDefaultTipSol = event.currentTarget.value;
                localStorage.setItem(
                  "solwal:terminal-default-tip-sol",
                  state.terminalDefaultTipSol,
                );
                update();
              }}
            />
          </label>
          <label className="mini-field">
            <span>Priority</span>
            <input
              value={state.terminalDefaultPriorityMicroLamports}
              onInput={(event: any) => {
                state.terminalDefaultPriorityMicroLamports =
                  event.currentTarget.value;
                localStorage.setItem(
                  "solwal:terminal-default-priority-micro-lamports",
                  state.terminalDefaultPriorityMicroLamports,
                );
                update();
              }}
            />
          </label>
          <label className="quick-live">
            <input
              type="checkbox"
              checked={state.terminalQuickLive}
              onInput={(event: any) => {
                state.terminalQuickLive = event.currentTarget.checked;
                localStorage.setItem(
                  "solwal:terminal-quick-live",
                  state.terminalQuickLive ? "1" : "0",
                );
                update();
              }}
            />
            <span>LIVE</span>
          </label>
          <select
            value={state.selectedWatchGroupId ?? ""}
            onInput={(event: any) => {
              state.selectedWatchGroupId = event.currentTarget.value || null;
              update();
            }}
          >
            <option value="">watch group…</option>
            {state.watchGroups.map((group) => (
              <option value={group.id}>{group.name}</option>
            ))}
          </select>
          <span
            className={`pill ${state.pumpFeedStatus === "connected" ? "ok" : state.pumpFeedStatus === "error" ? "bad" : ""}`}
          >
            {state.pumpFeedStatus}
          </span>
          <button type="button" onClick={() => void startPumpFeed()}>
            {state.pumpFeedStatus === "connected" ? "Reconnect" : "Connect"}
          </button>
          <button type="button" className="secondary" onClick={stopPumpFeed}>
            Stop
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              state.pumpFeed = [];
              update();
            }}
          >
            Clear
          </button>
        </div>
      </div>
      <div className="card span-12">
        <div className="row between">
          <div className="row">
            <label>
              Filter
              <input
                value={state.pumpFeedFilter}
                placeholder="symbol, name, mint, creator"
                onInput={(event: any) => {
                  state.pumpFeedFilter = event.currentTarget.value;
                  update();
                }}
              />
            </label>
            <label>
              Sort
              <select
                value={state.pumpFeedSort}
                onInput={(event: any) => {
                  state.pumpFeedSort = event.currentTarget.value;
                  localStorage.setItem(
                    "solwal:pump-feed-sort",
                    state.pumpFeedSort,
                  );
                  update();
                }}
              >
                <option value="newest">Newest</option>
                <option value="mcap-desc">MCap high → low</option>
                <option value="mcap-asc">MCap low → high</option>
                <option value="mcap-change-desc">Raised most SOL</option>
                <option value="mcap-change-pct-desc">Raised most %</option>
                <option value="trades-desc">Most trades</option>
              </select>
            </label>
            <label className="switch">
              <input
                type="checkbox"
                checked={state.hideMayhem}
                onInput={(event: any) => {
                  state.hideMayhem = event.currentTarget.checked;
                  localStorage.setItem(
                    "solwal:pump-hide-mayhem",
                    state.hideMayhem ? "1" : "0",
                  );
                  update();
                }}
              />
              <span>Hide Mayhem</span>
            </label>
            <label className="switch">
              <input
                type="checkbox"
                checked={state.hideUsdc}
                onInput={(event: any) => {
                  state.hideUsdc = event.currentTarget.checked;
                  localStorage.setItem(
                    "solwal:pump-hide-usdc",
                    state.hideUsdc ? "1" : "0",
                  );
                  update();
                }}
              />
              <span>Hide USDC</span>
            </label>
            <span className="pill">
              {rows.length} shown / {state.pumpFeed.length} cached
            </span>
          </div>
          {state.pumpFeedError ? (
            <span className="pill bad">{state.pumpFeedError}</span>
          ) : null}
        </div>
        <div className="terminal-table">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th></th>
                <th>Token</th>
                <th>Mint</th>
                <th>Creator</th>
                <th>Initial buy</th>
                <th>MCap SOL</th>
                <th>Δ MCap</th>
                <th>Δ %</th>
                <th>Last trade</th>
                <th>Sig</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr>
                  <td className="code">
                    {row.receivedAt
                      ? new Date(row.receivedAt).toLocaleTimeString()
                      : row.lastTradeAtMs
                        ? new Date(row.lastTradeAtMs).toLocaleTimeString()
                        : "—"}
                  </td>
                  <td>
                    {tokenImage(row) ? (
                      <img
                        className="token-img"
                        src={tokenImage(row)!}
                        loading="lazy"
                      />
                    ) : (
                      <div className="token-img placeholder" />
                    )}
                  </td>
                  <td>
                    <div className="token-title">
                      {row.symbol ? `$${row.symbol}` : "—"}{" "}
                      <TokenBadges {...row} />
                    </div>
                    <div className="muted small">
                      {row.name ?? row.eventType ?? "new token"}
                    </div>
                  </td>
                  <td className="code">
                    {row.mint ? (
                      <a
                        href={tokenUrl(row.mint)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {short(row.mint)}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="code">{short(row.creator)}</td>
                  <td>{formatSol(row.initialBuy ?? row.solAmount)}</td>
                  <td>{formatSol(latestMcap(row))}</td>
                  <td
                    className={
                      mcapChange(row) != null && mcapChange(row)! > 0
                        ? "gain"
                        : mcapChange(row) != null && mcapChange(row)! < 0
                          ? "loss"
                          : ""
                    }
                  >
                    {formatSignedMcap(mcapChange(row))}
                  </td>
                  <td
                    className={
                      mcapChangePct(row) != null && mcapChangePct(row)! > 0
                        ? "gain"
                        : mcapChangePct(row) != null && mcapChangePct(row)! < 0
                          ? "loss"
                          : ""
                    }
                  >
                    {formatPct(mcapChangePct(row))}
                  </td>
                  <td>{row.lastTradeAtMs ? age(row.lastTradeAtMs) : "—"}</td>
                  <td className="code">{short(row.signature)}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="primary compact"
                        disabled={!row.mint || !state.terminalDefaultWallet}
                        onClick={() =>
                          void runAction(() => quickBuyPumpFeedRow(row))
                        }
                      >
                        {state.terminalQuickLive ? "BUY" : "SIM"}
                      </button>
                      <button
                        type="button"
                        className="secondary compact"
                        disabled={!row.mint}
                        onClick={() =>
                          void runAction(() => starPumpFeedRow(row))
                        }
                      >
                        ★
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card span-12">
        <h3>Latest raw event</h3>
        {state.pumpFeed[0] ? (
          <pre>{JSON.stringify(state.pumpFeed[0], null, 2)}</pre>
        ) : (
          <p className="muted">
            Connect to the feed to see new Pump.fun launches.
          </p>
        )}
      </div>
    </div>
  );
}

function WatchlistsView() {
  const active = selectedWatchGroup();
  const tokenRows = sortWatchRows(
    (active?.tokens ?? []).filter(passesBadgeFilters),
  );
  return (
    <div className="grid">
      <div className="card span-12 terminal-head">
        <div>
          <h2>Watched token groups</h2>
          <p className="muted">
            Star tokens from the Pump terminal into groups. The backend
            subscribes to watched-token trades and updates live market-cap + SMA
            columns.
          </p>
        </div>
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            const name = state.watchGroupName.trim();
            if (name) void runAction(() => createWatchGroup(name));
          }}
        >
          <input
            value={state.watchGroupName}
            placeholder="group name"
            onInput={(event: any) => {
              state.watchGroupName = event.currentTarget.value;
            }}
          />
          <button type="submit">Create group</button>
          <button
            type="button"
            className="secondary"
            onClick={() => void runAction(refreshWatchGroups)}
          >
            Refresh
          </button>
          <label>
            Sort
            <select
              value={state.watchSort}
              onInput={(event: any) => {
                state.watchSort = event.currentTarget.value;
                localStorage.setItem("solwal:watch-sort", state.watchSort);
                update();
              }}
            >
              <option value="mcap-desc">MCap high → low</option>
              <option value="mcap-asc">MCap low → high</option>
              <option value="mcap-change-desc">Raised most SOL</option>
              <option value="mcap-change-pct-desc">Raised most %</option>
              <option value="sma1m-desc">SMA 1m high → low</option>
              <option value="trades-desc">Most trades</option>
              <option value="newest">Newest added</option>
            </select>
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={state.hideMayhem}
              onInput={(event: any) => {
                state.hideMayhem = event.currentTarget.checked;
                localStorage.setItem(
                  "solwal:pump-hide-mayhem",
                  state.hideMayhem ? "1" : "0",
                );
                update();
              }}
            />
            <span>Hide Mayhem</span>
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={state.hideUsdc}
              onInput={(event: any) => {
                state.hideUsdc = event.currentTarget.checked;
                localStorage.setItem(
                  "solwal:pump-hide-usdc",
                  state.hideUsdc ? "1" : "0",
                );
                update();
              }}
            />
            <span>Hide USDC</span>
          </label>
        </form>
      </div>

      <div className="card span-3">
        <h3>Groups</h3>
        <div className="watch-group-list">
          {state.watchGroups.map((group) => (
            <button
              type="button"
              className={group.id === active?.id ? "active-row" : "secondary"}
              onClick={() => {
                state.selectedWatchGroupId = group.id;
                update();
              }}
            >
              <span>{group.name}</span>
              <span className="pill">{group.tokens.length}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="card span-9">
        <div className="row between">
          <h3>{active ? active.name : "No group selected"}</h3>
          <form
            className="row"
            onSubmit={(event) => {
              event.preventDefault();
              if (!active) return;
              const body = formData(event.currentTarget);
              const mint = String(body.mint ?? "").trim();
              if (!mint) return;
              void runAction(() =>
                addWatchedToken(active.id, {
                  mint,
                  name: String(body.name ?? "").trim() || null,
                  symbol: String(body.symbol ?? "").trim() || null,
                  marketCapSol: body.marketCapSol
                    ? Number(body.marketCapSol)
                    : null,
                  source: "manual",
                }),
              );
              event.currentTarget.reset();
            }}
          >
            <input name="mint" placeholder="mint" />
            <input name="symbol" placeholder="symbol" />
            <input name="name" placeholder="name" />
            <input name="marketCapSol" placeholder="mcap SOL" />
            <button type="submit" disabled={!active}>
              Add
            </button>
          </form>
        </div>
        <div className="watch-grid-table">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Token</th>
                <th>Mint</th>
                <th>Creator</th>
                <th>Last mcap</th>
                <th>Δ MCap</th>
                <th>Δ %</th>
                <th>SMA 1m</th>
                <th>SMA 5m</th>
                <th>SMA 15m</th>
                <th>SMA 60m</th>
                <th>Trades</th>
                <th>Last trade</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tokenRows.map((token) => (
                <tr>
                  <td>
                    {tokenImage(token) ? (
                      <img
                        className="token-img"
                        src={tokenImage(token)!}
                        loading="lazy"
                      />
                    ) : (
                      <div className="token-img placeholder" />
                    )}
                  </td>
                  <td>
                    <div className="token-title">
                      {token.symbol ? `$${token.symbol}` : "—"}{" "}
                      <TokenBadges {...token} />
                    </div>
                    <div className="muted small">
                      {token.name ?? "watched token"}
                    </div>
                  </td>
                  <td className="code">
                    <a
                      href={tokenUrl(token.mint)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {short(token.mint)}
                    </a>
                  </td>
                  <td className="code">{short(token.creator)}</td>
                  <td>{formatMcap(latestMcap(token))}</td>
                  <td
                    className={
                      mcapChange(token) != null && mcapChange(token)! > 0
                        ? "gain"
                        : mcapChange(token) != null && mcapChange(token)! < 0
                          ? "loss"
                          : ""
                    }
                  >
                    {formatSignedMcap(mcapChange(token))}
                  </td>
                  <td
                    className={
                      mcapChangePct(token) != null && mcapChangePct(token)! > 0
                        ? "gain"
                        : mcapChangePct(token) != null &&
                            mcapChangePct(token)! < 0
                          ? "loss"
                          : ""
                    }
                  >
                    {formatPct(mcapChangePct(token))}
                  </td>
                  <td>{formatMcap(token.sma1m)}</td>
                  <td>{formatMcap(token.sma5m)}</td>
                  <td>{formatMcap(token.sma15m)}</td>
                  <td>{formatMcap(token.sma60m)}</td>
                  <td>{token.trades?.length ?? token.samples.length}</td>
                  <td>
                    {token.lastTradeAtMs ? age(token.lastTradeAtMs) : "—"}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="danger compact"
                      onClick={() =>
                        void runAction(() =>
                          removeWatchedToken(active!.id, token.mint),
                        )
                      }
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!tokenRows.length ? (
          <p className="muted">
            No watched tokens yet. Star tokens from the Pump terminal or add a
            mint manually.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function LaunchView() {
  return (
    <form
      className="launch-grid"
      onSubmit={(event) => {
        event.preventDefault();
        const body = formData(event.currentTarget);
        body.live = event.currentTarget.querySelector<HTMLInputElement>(
          "[name=live]",
        )?.checked
          ? "true"
          : "false";
        body.skipSimulation =
          event.currentTarget.querySelector<HTMLInputElement>(
            "[name=skipSimulation]",
          )?.checked
            ? "true"
            : "false";
        const explicitBuyPlan = buyPlanPayload();
        if (explicitBuyPlan.length > 0) body.buyPlan = explicitBuyPlan;
        void runAction(async () => {
          const started = await api<{ id: string }>("/api/launch/pump", {
            method: "POST",
            body: JSON.stringify(body),
          });
          state.selectedJobId = started.id;
          await refreshJobs();
        });
      }}
    >
      <div className="launch-hero span-12">
        <div>
          <div className="section-kicker">Pump launch builder</div>
          <h2>Build a token launch + parallel follower plan</h2>
          <p className="muted">
            Configure metadata, creator buy, per-wallet follower lanes, and
            sender strategy in one place before starting the job.
          </p>
        </div>
        <div className="launch-actions">
          <label className="toggle-card">
            <span>Live</span>
            <input type="checkbox" name="live" />
          </label>
          <label className="toggle-card">
            <span>Skip sim</span>
            <input type="checkbox" name="skipSimulation" defaultChecked />
          </label>
          <button type="submit" className="primary-large">
            Start launch job
          </button>
        </div>
      </div>

      <div className="span-12">
        <LaunchRunSummary job={latestJob()} />
      </div>

      <div className="launch-panel span-7">
        <div className="section-head compact-head">
          <div>
            <div className="section-kicker">01</div>
            <h3>Token metadata</h3>
          </div>
        </div>
        <div className="clean-form token-form">
          <label className="field full">
            <span>Metadata JSON path</span>
            <input name="metadataPath" placeholder="./metadata/mind.json" />
          </label>
          <label className="field">
            <span>Alias</span>
            <input name="alias" placeholder="mind" />
          </label>
          <label className="field">
            <span>Name</span>
            <input name="name" placeholder="Mind Token" />
          </label>
          <label className="field">
            <span>Symbol</span>
            <input name="symbol" placeholder="MIND" />
          </label>
          <label className="field">
            <span>Metadata URI</span>
            <input name="uri" placeholder="ipfs:// or https://" />
          </label>
          <label className="field full">
            <span>Server image path</span>
            <input name="imagePath" placeholder="./metadata/mind.png" />
          </label>
          <label className="field full">
            <span>Description</span>
            <textarea
              name="description"
              placeholder="Optional; auto-filled if empty."
            />
          </label>
        </div>
      </div>

      <div className="launch-panel span-5">
        <div className="section-head compact-head">
          <div>
            <div className="section-kicker">02</div>
            <h3>Launch defaults</h3>
          </div>
        </div>
        <div className="clean-form defaults-form">
          <label className="field full">
            <span>Creator wallet</span>
            <input name="creator" required placeholder="name or address" />
          </label>
          <label className="field">
            <span>Creator buy SOL</span>
            <input name="creatorBuySol" placeholder="0" />
          </label>
          <label className="field">
            <span>Buyer group fallback</span>
            <input name="buyerGroup" placeholder="mind-buyers" />
          </label>
          <label className="field">
            <span>Buyer min %</span>
            <input name="buyerMinBps" defaultValue="5000" />
          </label>
          <label className="field">
            <span>Buyer max %</span>
            <input name="buyerMaxBps" defaultValue="8000" />
          </label>
          <label className="field">
            <span>Reserve SOL</span>
            <input name="buyerReserveSol" defaultValue="0.02" />
          </label>
          <label className="field">
            <span>Deploy sender</span>
            <select name="deploymentSender">
              <option value="helius-rpc">Helius RPC</option>
              <option value="helius-fast">Helius fast</option>
            </select>
          </label>
          <label className="field">
            <span>Buyer sender</span>
            <select name="buyerSender">
              <option value="helius-fast">Helius fast</option>
              <option value="helius-rpc">Helius RPC</option>
            </select>
          </label>
          <label className="field full">
            <span>Submit mode</span>
            <select name="submitMode">
              <option value="fast-spam">Fast spam</option>
              <option value="spam-after-market-ready">Market-ready spam</option>
              <option value="after-deploy-processed">After processed</option>
              <option value="after-deploy-confirmed">After confirmed</option>
            </select>
          </label>
        </div>
      </div>

      <BuyPlanTable />

      <div className="launch-panel span-12 global-strip">
        <div>
          <div className="section-kicker">03</div>
          <h3>Global execution defaults</h3>
          <p className="muted small">
            Used when a follower row does not override the value.
          </p>
        </div>
        <div className="global-fields">
          <label className="field">
            <span>Sender TPS</span>
            <input name="senderTps" defaultValue="40" />
          </label>
          <label className="field">
            <span>Helius tip SOL</span>
            <input name="heliusTipSol" defaultValue="0.001" />
          </label>
          <label className="field">
            <span>Buyer priority</span>
            <input name="buyerPriorityMicroLamports" defaultValue="1500000" />
          </label>
          <label className="field">
            <span>Slippage bps</span>
            <input name="slippageBps" defaultValue="9999" />
          </label>
          <label className="field">
            <span>Fresh quote delay</span>
            <input name="freshQuoteDelayMs" defaultValue="-1" />
          </label>
          <button type="submit" className="primary-large bottom-submit">
            Start launch job
          </button>
        </div>
      </div>
    </form>
  );
}

function TradeView() {
  return (
    <div className="grid">
      <form
        className="card span-6"
        onSubmit={(event) => {
          event.preventDefault();
          const body = formData(event.currentTarget);
          body.live = event.currentTarget.querySelector<HTMLInputElement>(
            "[name=live]",
          )?.checked
            ? "true"
            : "false";
          void runAction(() =>
            api("/api/trade/buy", {
              method: "POST",
              body: JSON.stringify(body),
            }),
          );
        }}
      >
        <h2>Buy</h2>
        <div className="form-grid">
          <label>
            Wallet
            <input name="wallet" required />
          </label>
          <label>
            Token
            <input name="token" required />
          </label>
          <label>
            SOL
            <input name="amountSol" defaultValue="0.01" />
          </label>
          <label>
            Slippage bps
            <input name="slippageBps" defaultValue="1500" />
          </label>
          <label>
            Sender
            <input name="sender" defaultValue="rpc" />
          </label>
          <label>
            <span>Live</span>
            <input type="checkbox" name="live" />
          </label>
          <button className="full">Buy</button>
        </div>
      </form>
      <form
        className="card span-6"
        onSubmit={(event) => {
          event.preventDefault();
          const body = formData(event.currentTarget);
          body.live = event.currentTarget.querySelector<HTMLInputElement>(
            "[name=live]",
          )?.checked
            ? "true"
            : "false";
          void runAction(() =>
            api("/api/trade/sell", {
              method: "POST",
              body: JSON.stringify(body),
            }),
          );
        }}
      >
        <h2>Sell</h2>
        <div className="form-grid">
          <label>
            Wallet
            <input name="wallet" required />
          </label>
          <label>
            Token
            <input name="token" required />
          </label>
          <label>
            Sell bps
            <input name="bps" defaultValue="10000" />
          </label>
          <label>
            Slippage bps
            <input name="slippageBps" defaultValue="1500" />
          </label>
          <label>
            Sender
            <input name="sender" defaultValue="rpc" />
          </label>
          <label>
            <span>Live</span>
            <input type="checkbox" name="live" />
          </label>
          <button className="full danger">Sell</button>
        </div>
      </form>
    </div>
  );
}

function SignalsView() {
  const signals = state.signals;
  const sources = signals?.sources ?? [];
  const rows = signals?.signals ?? [];
  const activeSource =
    sources.find((source) => source.id === state.signalSourceId) ??
    sources[0] ??
    null;
  return (
    <div className="signals-layout">
      <div className="activity-hero">
        <div>
          <div className="section-kicker">Telegram signals</div>
          <h2>Signal parser</h2>
          <p className="muted">
            Paste Telegram calls or wire a connector later. The parser extracts
            mint addresses, symbols, links, side, and SOL sizing into the shared
            Solard database state.
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          onClick={() => void runAction(refreshSignals)}
        >
          Refresh signals
        </button>
      </div>

      <div className="grid two">
        <form
          className="card"
          onSubmit={(event: any) => {
            event.preventDefault();
            void runAction(async () => {
              await signalAction("upsert-source", {
                name: state.signalSourceName,
                chatRef: state.signalSourceChatRef,
              });
              await refreshSignals();
            });
          }}
        >
          <h3>Sources</h3>
          <div className="form-grid">
            <label>
              Name
              <input
                value={state.signalSourceName}
                onInput={(event: any) => {
                  state.signalSourceName = event.currentTarget.value;
                }}
              />
            </label>
            <label>
              Telegram group/channel ref
              <input
                placeholder="@group, invite, chat id"
                value={state.signalSourceChatRef}
                onInput={(event: any) => {
                  state.signalSourceChatRef = event.currentTarget.value;
                }}
              />
            </label>
            <button className="secondary full">Save source</button>
          </div>
          <div className="source-list">
            {sources.map((source) => (
              <button
                type="button"
                className={`source-row ${activeSource?.id === source.id ? "active-row" : ""}`}
                onClick={() => {
                  state.signalSourceId = source.id;
                  state.signalSourceName = source.name;
                  state.signalSourceChatRef = source.chatRef ?? "";
                  update();
                }}
              >
                <b>{source.name}</b>
                <small>{source.chatRef || "manual"}</small>
              </button>
            ))}
          </div>
        </form>

        <form
          className="card"
          onSubmit={(event: any) => {
            event.preventDefault();
            void runAction(async () => {
              await signalAction("ingest", {
                sourceId: activeSource?.id ?? null,
                text: state.signalText,
              });
              state.signalText = "";
              await refreshSignals();
            });
          }}
        >
          <h3>Manual ingest</h3>
          <label>
            Paste Telegram signal
            <textarea
              rows={8}
              value={state.signalText}
              onInput={(event: any) => {
                state.signalText = event.currentTarget.value;
              }}
              placeholder="Example: BUY $ABC 0.2 SOL mint 7x... website https://..."
            />
          </label>
          <div className="row">
            <button>Parse signal</button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                state.signalText = "";
                update();
              }}
            >
              Clear text
            </button>
            <button
              type="button"
              className="danger"
              onClick={() =>
                void runAction(async () => {
                  await signalAction("clear");
                  await refreshSignals();
                })
              }
            >
              Clear signals
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h3>Parsed signals</h3>
        <table className="clean-table signals-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Side</th>
              <th>Source</th>
              <th>Mint / symbol</th>
              <th>Amount</th>
              <th>Links</th>
              <th>Status</th>
              <th>Text</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((signal) => (
              <tr>
                <td className="code">
                  {new Date(signal.receivedAtMs).toLocaleTimeString()}
                </td>
                <td>
                  <span
                    className={`pill ${signal.direction === "buy" ? "good" : signal.direction === "sell" ? "bad" : ""}`}
                  >
                    {signal.direction}
                  </span>
                </td>
                <td>{signal.sourceName ?? "manual"}</td>
                <td className="code">
                  {signal.mints[0]
                    ? short(signal.mints[0])
                    : signal.symbols.map((symbol) => `$${symbol}`).join(", ") ||
                      "—"}
                </td>
                <td>{signal.amountSol ? `${signal.amountSol} SOL` : "—"}</td>
                <td>
                  {signal.urls.slice(0, 2).map((url) => (
                    <a target="_blank" href={url}>
                      link
                    </a>
                  ))}
                </td>
                <td>
                  <select
                    value={signal.status}
                    onChange={(event: any) =>
                      void runAction(async () => {
                        await signalAction("status", {
                          id: signal.id,
                          status: event.currentTarget.value,
                        });
                        await refreshSignals();
                      })
                    }
                  >
                    <option value="new">new</option>
                    <option value="watched">watched</option>
                    <option value="ignored">ignored</option>
                    <option value="traded">traded</option>
                  </select>
                </td>
                <td className="signal-text">{signal.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? <p className="muted">No signals yet.</p> : null}
      </div>
    </div>
  );
}

function JobsView() {
  const selected = state.selectedJob ?? state.jobs[0] ?? null;
  const jobs = state.jobs;
  const executions = state.overview?.executions ?? [];
  const rawRetries = executions
    .filter((row: AnyRow) => isRetryExecution(row))
    .slice(0, 60);
  const highLevel = executions
    .filter((row: AnyRow) => !isRetryExecution(row))
    .slice(0, 20);
  return (
    <div className="activity-layout">
      <div className="activity-hero">
        <div>
          <div className="section-kicker">Activity center</div>
          <h2>Runs, not noise</h2>
          <p className="muted">
            A launch can generate thousands of retry attempts. This page
            separates the launch job from low-level attempts so “failed retry”
            does not look like “failed app”.
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          onClick={() =>
            void runAction(async () => {
              await refreshJobs();
              await refreshOverview();
            })
          }
        >
          Refresh activity
        </button>
      </div>

      <div className="activity-columns">
        <div className="card runs-list">
          <h3>Launch runs</h3>
          {!jobs.length ? (
            <p className="muted">No launch jobs in this server process yet.</p>
          ) : null}
          {jobs.map((job: AnyRow) => (
            <button
              type="button"
              className={`run-list-item ${selected?.id === job.id ? "active-row" : ""}`}
              onClick={() => {
                state.selectedJobId = job.id;
                void refreshJobs().then(update);
              }}
            >
              <span>
                {jobStatusPill(job)} <b>{jobHeadline(job)}</b>
              </span>
              <small>{new Date(job.createdAtMs).toLocaleTimeString()}</small>
            </button>
          ))}
        </div>

        <div className="card run-detail">
          <h3>Selected run</h3>
          {selected ? (
            <>
              <LaunchRunSummary job={selected} />
              <div className="job-log-list">
                {(selected.logs ?? [])
                  .slice(-80)
                  .reverse()
                  .map((entry: AnyRow) => (
                    <details className="log-entry">
                      <summary>
                        <span className="muted small">
                          {new Date(entry.atMs).toLocaleTimeString()}
                        </span>{" "}
                        <b>{entry.label}</b>
                      </summary>
                      <pre>{JSON.stringify(entry.value, null, 2)}</pre>
                    </details>
                  ))}
              </div>
            </>
          ) : (
            <p className="muted">Select a launch run.</p>
          )}
        </div>
      </div>

      <div className="activity-columns lower">
        <div className="card">
          <h3>High-level executions</h3>
          <table className="clean-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Action</th>
                <th>Wallet</th>
                <th>Sig</th>
              </tr>
            </thead>
            <tbody>
              {highLevel.map((row: AnyRow) => (
                <tr>
                  <td>
                    <span className={`pill ${statusClass(row.status)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td>{friendlyExecutionKind(row.kind)}</td>
                  <td className="code">{short(row.walletAddress)}</td>
                  <td className="code">
                    {row.signature ? short(row.signature) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3>Retry attempt log</h3>
          <div className="callout warn">
            These rows are expected during spam modes. A failed retry only means
            that one attempt failed; the lane may still continue.
          </div>
          <table className="clean-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Attempt</th>
                <th>Wallet</th>
              </tr>
            </thead>
            <tbody>
              {rawRetries.map((row: AnyRow) => (
                <tr>
                  <td>
                    <span className={`pill ${statusClass(row.status)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="code">
                    {String(row.kind ?? "").replace(/^cli:/, "")}
                  </td>
                  <td className="code">{short(row.walletAddress)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function App() {
  return (
    <>
      <div className="notice row">
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
      {state.tab === "overview" ? (
        <OverviewView />
      ) : state.tab === "wallets" ? (
        <WalletsView />
      ) : state.tab === "terminal" ? (
        <TerminalView />
      ) : state.tab === "watchlists" ? (
        <WatchlistsView />
      ) : state.tab === "signals" ? (
        <SignalsView />
      ) : state.tab === "launch" ? (
        <LaunchView />
      ) : state.tab === "trade" ? (
        <TradeView />
      ) : (
        <JobsView />
      )}
    </>
  );
}

function update() {
  const root = document.getElementById("app-root");
  if (root) render(<App />, root);
  document
    .querySelectorAll<HTMLAnchorElement>("#main-nav a")
    .forEach((link) =>
      link.classList.toggle("active", link.dataset.page === state.tab),
    );
}

export default function mount() {
  state.tab = pageFromPath();
  void runAction(async () => {
    await refreshOverview();
    await refreshStatus().catch(() => undefined);
    await refreshJobs().catch(() => undefined);
    if (state.tab === "terminal" || state.tab === "watchlists")
      await refreshPumpLive().catch(() => undefined);
    if (state.tab === "signals") await refreshSignals().catch(() => undefined);
  });
  if (state.tab === "terminal") void startPumpFeed();
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
    void refreshStatus()
      .then(update)
      .catch(() => undefined);
  }, 1500);
  update();
  return () => {
    clearInterval(interval);
    state.pumpFeedAbort?.abort();
  };
}
