import { render } from "tradjs/client";
import { createClientMeasureScope, summarizeForClient } from "./measure";

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
  marketCapUsd?: number | null;
  priceUsd?: number | null;
  priceSolPerToken?: number | null;
  image?: string | null;
  website?: string | null;
  twitter?: string | null;
  telegram?: string | null;
  description?: string | null;
  samples?: TokenWatchSample[];
  initialMarketCapSol?: number | null;
  initialMarketCapUsd?: number | null;
  lastMarketCapSol?: number | null;
  marketCapChangeSol?: number | null;
  marketCapChangePct?: number | null;
  sma1m?: number | null;
  sma5m?: number | null;
  sma15m?: number | null;
  sma60m?: number | null;
  lastTradeAtMs?: number | null;
  isMayhemMode?: boolean | number | string | null;
  quoteAsset?: string | null;
  quoteMint?: string | null;
  trades?: AnyRow[];
  tradeCount?: number | null;
  signalText?: string | null;
  signalSource?: string | null;
  source?: string | null;
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
  initialMarketCapUsd?: number | null;
  marketCapChangeSol?: number | null;
  marketCapChangePct?: number | null;
  isMayhemMode?: boolean | number | string | null;
  quoteAsset?: string | null;
  quoteMint?: string | null;
  trades?: AnyRow[];
  tradeCount?: number | null;
  signalText?: string | null;
  signalSource?: string | null;
  source?: string | null;
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
    | "sma1m-desc"
    | "sma5m-desc"
    | "sma15m-desc"
    | "trades-desc";
  pumpFeedSource: "helius" | "pumpportal" | "both";
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
  terminalHealth: AnyRow | null;
  terminalLastPollAtMs: number | null;
  terminalLastRows: number;
  terminalProbe: AnyRow | null;
  terminalLastError: string | null;
  tokenHolders: Record<string, TokenHolder[]>;
  tokenHolderErrors: Record<string, string>;
  tokenHoldersCheckedAt: Record<string, number>;
  tokenHoldersLoadingMint: string | null;
  toasts: Toast[];
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
  pumpFeedSource: (() => {
    const saved = localStorage.getItem("solwal:pump-feed-source") as
      State["pumpFeedSource"] | null;
    if (!saved || saved === "pumpportal") return "helius";
    return saved;
  })(),
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
  mountId: 0,
  previousTab: null,
  measureScope: "solard:web:boot",
  terminalInspectorKey:
    localStorage.getItem("solard:terminal-inspector-key") || null,
  terminalInspectorFixed:
    localStorage.getItem("solard:terminal-inspector-fixed") === "1",
  terminalPinnedMints: (() => {
    try {
      const parsed = JSON.parse(
        localStorage.getItem("solard:terminal-pinned-mints") || "[]",
      );
      return Array.isArray(parsed)
        ? parsed.filter((item) => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  })(),
  terminalSessionStartedAtMs: null,
  terminalHealth: null,
  terminalLastPollAtMs: null,
  terminalLastRows: 0,
  terminalProbe: null,
  terminalLastError: null,
  tokenHolders: {},
  tokenHolderErrors: {},
  tokenHoldersCheckedAt: {},
  tokenHoldersLoadingMint: null,
  toasts: [],
};

const runtimeMeasure = createClientMeasureScope("solard:web");
const toastDedupedAt: Record<string, number> = {};

function clientMeasureEnabled(): boolean {
  try {
    return (
      localStorage.getItem("solard:measure") !== "0" &&
      localStorage.getItem("solwal:measure") !== "0"
    );
  } catch {
    return true;
  }
}

export async function measureClient<T>(
  label: string,
  fn: () => Promise<T> | T,
  summarize: (value: T) => unknown = summarizeForClient,
): Promise<T> {
  if (!clientMeasureEnabled()) return await fn();
  return await runtimeMeasure.measure(
    `${state.measureScope}:${label}`,
    fn,
    summarize,
  );
}

export function measureClientSync<T>(
  label: string,
  fn: () => T,
  summarize: (value: T) => unknown = summarizeForClient,
): T {
  if (!clientMeasureEnabled()) return fn();
  return runtimeMeasure.measureSync(
    `${state.measureScope}:${label}`,
    fn,
    summarize,
  );
}

function measureEvent(label: string, summary?: unknown): void {
  if (!clientMeasureEnabled()) return;
  runtimeMeasure.event(`${state.measureScope}:${label}`, summary);
}

function trimText(value: unknown, limit = 180): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function pushToast(
  kind: Toast["kind"],
  title: string,
  message?: unknown,
  ttlMs = 6000,
): void {
  const now = Date.now();
  const cleanTitle = trimText(title, 80);
  const cleanMessage = message == null ? null : trimText(message, 220);
  const key = `${kind}:${cleanTitle}:${cleanMessage ?? ""}`;
  const dedupeMs = /local issuer certificate|certificate/i.test(
    cleanMessage ?? "",
  )
    ? 60_000
    : 8_000;
  if (toastDedupedAt[key] && now - toastDedupedAt[key] < dedupeMs) return;
  toastDedupedAt[key] = now;
  state.toasts = [
    {
      id: `${now}:${Math.random().toString(36).slice(2)}`,
      kind,
      title: cleanTitle,
      message: cleanMessage,
      createdAtMs: now,
      expiresAtMs: now + Math.max(1000, ttlMs),
    },
    ...state.toasts.filter((toast) => toast.expiresAtMs > now),
  ].slice(0, 5);
  window.setTimeout(
    () => {
      const at = Date.now();
      const before = state.toasts.length;
      state.toasts = state.toasts.filter((toast) => toast.expiresAtMs > at);
      if (state.toasts.length !== before) update();
    },
    Math.max(1000, ttlMs + 50),
  );
}

export function dismissToast(id: string): void {
  state.toasts = state.toasts.filter((toast) => toast.id !== id);
  update();
}

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

function unwrapApiPayload<T>(payload: any, status: number): T {
  if (payload && typeof payload === "object") {
    if (payload.ok === false)
      throw new Error(payload.error ?? payload.message ?? `HTTP ${status}`);
    if (Object.prototype.hasOwnProperty.call(payload, "value"))
      return payload.value as T;
    if (Object.prototype.hasOwnProperty.call(payload, "data"))
      return payload.data as T;
  }
  return payload as T;
}

export async function api<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const method = String(options.method ?? "GET").toUpperCase();
  const path = (() => {
    try {
      const parsed = new URL(url, window.location.origin);
      return `${method} ${parsed.pathname}${parsed.search ? "?…" : ""}`;
    } catch {
      return `${method} ${url}`;
    }
  })();
  return await measureClient(
    path,
    async () => {
      const isFormData =
        typeof FormData !== "undefined" && options.body instanceof FormData;

      const response = await fetch(url, {
        ...options,
        headers: {
          ...(isFormData
            ? {}
            : {
                "content-type": "application/json",
              }),
          ...authHeaders(),
          ...(options.headers ?? {}),
        },
      });
      const text = await response.text();
      let payload: any = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { ok: false, error: text || `HTTP ${response.status}` };
      }
      if (!response.ok)
        throw new Error(
          payload?.error ?? payload?.message ?? `HTTP ${response.status}`,
        );
      return unwrapApiPayload<T>(payload, response.status);
    },
    (value: T) => summarizeForClient(value),
  );
}

try {
  (globalThis as any).API = api;
} catch {
  // Compatibility for any stale inline terminal action still referencing API.
}

function emptyOverview(): Overview {
  return { wallets: [], tokens: [], groups: [], executions: [], balances: [] };
}

function mergeOverview(
  next: Overview,
  options: { keepBalances?: boolean } = {},
): void {
  const previous = state.overview ?? emptyOverview();
  state.overview = {
    wallets: next.wallets ?? previous.wallets ?? [],
    tokens: next.tokens ?? previous.tokens ?? [],
    groups: next.groups ?? previous.groups ?? [],
    executions: next.executions ?? previous.executions ?? [],
    balances:
      options.keepBalances && previous.balances?.length
        ? previous.balances
        : (next.balances ?? previous.balances ?? []),
  };
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
  isMayhemMode?: boolean | number | string | null;
  raw?: AnyRow;
}): boolean {
  const direct = String(row.isMayhemMode ?? "").toLowerCase();
  if (
    row.isMayhemMode === true ||
    row.isMayhemMode === 1 ||
    direct === "true" ||
    direct === "1" ||
    direct.includes("mayhem")
  )
    return true;
  const raw = row.raw ?? {};
  return [
    "isMayhemMode",
    "mayhemMode",
    "mayhem",
    "isMayhem",
    "mode",
    "launchMode",
    "curveType",
    "poolType",
  ].some((key) => {
    const value = raw[key];
    const text = String(value ?? "").toLowerCase();
    return (
      value === true ||
      value === 1 ||
      text === "true" ||
      text === "1" ||
      text.includes("mayhem")
    );
  });
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
  isMayhemMode?: boolean | number | string | null;
  quoteAsset?: string | null;
  quoteMint?: string | null;
  raw?: AnyRow;
}): boolean {
  if (state.hideMayhem && isMayhemToken(row)) return false;
  if (state.hideUsdc && isUsdcToken(row)) return false;
  return true;
}

export function pumpRowKey(row: {
  mint?: string | null;
  signature?: string | null;
  seq?: number;
}): string {
  return row.mint || row.signature || String(row.seq ?? "");
}

export function isTerminalPinned(row: { mint?: string | null }): boolean {
  return !!row.mint && state.terminalPinnedMints.includes(row.mint);
}

export function toggleTerminalPinned(row: { mint?: string | null }): void {
  if (!row.mint) return;
  const pinned = new Set(state.terminalPinnedMints);
  if (pinned.has(row.mint)) pinned.delete(row.mint);
  else pinned.add(row.mint);
  state.terminalPinnedMints = [...pinned];
  localStorage.setItem(
    "solard:terminal-pinned-mints",
    JSON.stringify(state.terminalPinnedMints),
  );
  update();
}

export function fixTerminalInspector(row: {
  mint?: string | null;
  signature?: string | null;
  seq?: number;
}): void {
  const key = pumpRowKey(row);
  if (!key) return;
  state.terminalInspectorKey = key;
  state.terminalInspectorFixed = true;
  localStorage.setItem("solard:terminal-inspector-key", key);
  localStorage.setItem("solard:terminal-inspector-fixed", "1");
  update();
}

export function followLatestInTerminalInspector(): void {
  state.terminalInspectorKey = null;
  state.terminalInspectorFixed = false;
  localStorage.removeItem("solard:terminal-inspector-key");
  localStorage.removeItem("solard:terminal-inspector-fixed");
  update();
}

export function tokenSocialLinks(row: {
  raw?: AnyRow;
  uri?: string | null;
  website?: string | null;
  twitter?: string | null;
  telegram?: string | null;
}): Array<{ kind: string; href: string }> {
  const raw = row.raw ?? {};
  const entries: Array<[string, unknown]> = [
    [
      "web",
      row.website ??
        raw.website ??
        raw.site ??
        raw.external_url ??
        raw.externalUrl,
    ],
    [
      "x",
      row.twitter ?? raw.twitterUrl ?? raw.twitter_url ?? raw.x ?? raw.xUrl,
    ],
    ["tg", row.telegram ?? raw.telegramUrl ?? raw.telegram_url ?? raw.tg],
    ["uri", row.uri],
  ];
  const seen = new Set<string>();
  const out: Array<{ kind: string; href: string }> = [];
  for (const [kind, value] of entries) {
    const href = typeof value === "string" && value.trim() ? value.trim() : "";
    if (!href || seen.has(href)) continue;
    if (!/^https?:\/\//i.test(href) && !href.startsWith("ipfs://")) continue;
    seen.add(href);
    out.push({
      kind,
      href: href.startsWith("ipfs://")
        ? `https://ipfs.io/ipfs/${href.slice(7)}`
        : href,
    });
  }
  return out;
}

export function TokenBadges(row: {
  isMayhemMode?: boolean | number | string | null;
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
  marketCapUsd?: number | null;
  priceUsd?: number | null;
  lastMarketCapSol?: number | null;
  samples?: TokenWatchSample[];
}): number | null {
  const direct = row.marketCapUsd ?? row.marketCapSol ?? row.lastMarketCapSol;
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
  initialMarketCapUsd?: number | null;
  marketCapSol?: number | null;
  marketCapUsd?: number | null;
  priceUsd?: number | null;
  samples?: TokenWatchSample[];
}): number | null {
  if (
    typeof row.initialMarketCapUsd === "number" &&
    Number.isFinite(row.initialMarketCapUsd)
  )
    return row.initialMarketCapUsd;
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
    (typeof row.marketCapUsd === "number"
      ? row.marketCapUsd
      : typeof row.marketCapSol === "number"
        ? row.marketCapSol
        : null)
  );
}

export function mcapChange(row: {
  initialMarketCapSol?: number | null;
  initialMarketCapUsd?: number | null;
  marketCapSol?: number | null;
  marketCapUsd?: number | null;
  priceUsd?: number | null;
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
  initialMarketCapUsd?: number | null;
  marketCapSol?: number | null;
  marketCapUsd?: number | null;
  priceUsd?: number | null;
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
  const byTrades = (row: PumpFeedRow) =>
    Number(row.tradeCount ?? row.trades?.length ?? 0);
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
    case "sma1m-desc":
      return copy.sort(
        (a, b) => (b.sma1m ?? -Infinity) - (a.sma1m ?? -Infinity),
      );
    case "sma5m-desc":
      return copy.sort(
        (a, b) => (b.sma5m ?? -Infinity) - (a.sma5m ?? -Infinity),
      );
    case "sma15m-desc":
      return copy.sort(
        (a, b) => (b.sma15m ?? -Infinity) - (a.sma15m ?? -Infinity),
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

function rowTimeMs(row: PumpFeedRow): number {
  const direct = [row.updatedAtMs, row.createdAtMs, row.lastTradeAtMs].find(
    (value) => typeof value === "number" && Number.isFinite(value),
  );
  if (typeof direct === "number") return direct;
  const parsed = row.receivedAt ? Date.parse(row.receivedAt) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function shouldHydrateTerminalRow(row: PumpFeedRow): boolean {
  if (row.mint && state.terminalPinnedMints.includes(row.mint)) return true;
  const started = state.terminalSessionStartedAtMs;
  if (!started) return false;
  // A live SSE event may hit the DB before this client receives the event block.
  // Hydrate only very recent rows so the terminal does not turn into a stale DB dump.
  return rowTimeMs(row) >= started - 60_000;
}

function currentSessionRows(
  groups: TokenWatchGroup[] | undefined,
): PumpFeedRow[] {
  const group = (groups ?? []).find(
    (item) =>
      item.id === "current-session" ||
      String(item.name ?? "").toLowerCase() === "current session",
  );
  return (group?.tokens ?? []) as unknown as PumpFeedRow[];
}

export async function refreshPumpLive(): Promise<void> {
  if (state.tab === "terminal") {
    await refreshTerminalFeedOnce({
      ensure: false,
      activeWindowMs: 5 * 60_000,
      includeUnpriced: state.pumpFeedSource === "helius",
    });
    return;
  }

  const live = await api<{
    newTokens: PumpFeedRow[];
    watchGroups: TokenWatchGroup[];
  }>(`/api/pump-live?source=${encodeURIComponent(state.pumpFeedSource)}`);
  state.watchGroups = live.watchGroups ?? state.watchGroups;
  if (!state.selectedWatchGroupId && state.watchGroups[0])
    state.selectedWatchGroupId = state.watchGroups[0].id;

  for (const row of live.newTokens ?? []) mergePumpToken(row);
}

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isLikelySolanaPublicKey(
  value: string | null | undefined,
): boolean {
  return SOLANA_PUBKEY_RE.test(String(value ?? "").trim());
}

export async function refreshTokenHolders(
  mint: string | null | undefined,
): Promise<void> {
  const normalized = String(mint ?? "").trim();
  if (!normalized) return;
  if (!isLikelySolanaPublicKey(normalized)) {
    state.tokenHolderErrors[normalized] = "not a Solana public key";
    state.tokenHolders[normalized] = [];
    state.tokenHoldersCheckedAt[normalized] = Date.now();
    return;
  }
  if (state.tokenHolders[normalized]?.length) return;
  const lastChecked = state.tokenHoldersCheckedAt[normalized] ?? 0;
  const hadError = !!state.tokenHolderErrors[normalized];
  const ttlMs = hadError ? 15_000 : 90_000;
  if (lastChecked && Date.now() - lastChecked < ttlMs) return;
  state.tokenHoldersLoadingMint = normalized;
  try {
    const result = await api<{
      mint: string;
      ok?: boolean;
      holders: TokenHolder[];
      unavailableReason?: string | null;
    }>(`/api/token-holders?mint=${encodeURIComponent(normalized)}&limit=12`);
    const key = result.mint || normalized;
    state.tokenHolders[key] = result.holders ?? [];
    state.tokenHoldersCheckedAt[key] = Date.now();
    if (result.ok === false || result.unavailableReason)
      state.tokenHolderErrors[key] =
        result.unavailableReason || "holders unavailable";
    else delete state.tokenHolderErrors[key];
  } catch (error) {
    state.tokenHolders[normalized] = [];
    state.tokenHoldersCheckedAt[normalized] = Date.now();
    state.tokenHolderErrors[normalized] =
      error instanceof Error ? error.message : String(error);
  } finally {
    if (state.tokenHoldersLoadingMint === normalized)
      state.tokenHoldersLoadingMint = null;
  }
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
    marketCapUsd?: number | null;
    priceUsd?: number | null;
    isMayhemMode?: boolean | number | string | null;
    quoteAsset?: string | null;
    quoteMint?: string | null;
    source?: string | null;
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

function normalizeFeedRow(
  row: PumpFeedRow,
  existing?: PumpFeedRow,
): PumpFeedRow {
  const now = Date.now();
  const directMcap =
    typeof row.marketCapUsd === "number" && Number.isFinite(row.marketCapUsd)
      ? row.marketCapUsd
      : typeof row.marketCapSol === "number" &&
          Number.isFinite(row.marketCapSol)
        ? row.marketCapSol
        : null;
  const samples = [...(row.samples ?? [])];
  if (
    directMcap != null &&
    !samples.some(
      (sample) =>
        Math.abs(sample.capturedAtMs - now) < 1200 &&
        sample.marketCapSol === directMcap,
    )
  ) {
    samples.unshift({
      capturedAtMs: now,
      marketCapSol: directMcap,
      source: row.eventType ?? row.raw?.txType ?? row.raw?.source ?? "stream",
    });
  }
  const mergedSamples = [...samples, ...(existing?.samples ?? [])]
    .filter((sample) => sample && typeof sample.capturedAtMs === "number")
    .sort((a, b) => b.capturedAtMs - a.capturedAtMs)
    .filter(
      (sample, index, arr) =>
        index ===
        arr.findIndex(
          (other) =>
            Math.abs(other.capturedAtMs - sample.capturedAtMs) < 1000 &&
            other.marketCapSol === sample.marketCapSol,
        ),
    )
    .slice(0, 300);
  const last = mergedSamples.find(
    (sample) =>
      typeof sample.marketCapSol === "number" &&
      Number.isFinite(sample.marketCapSol),
  );
  const first = [...mergedSamples]
    .reverse()
    .find(
      (sample) =>
        typeof sample.marketCapSol === "number" &&
        Number.isFinite(sample.marketCapSol),
    );
  const mcap =
    directMcap ??
    row.lastMarketCapSol ??
    last?.marketCapSol ??
    existing?.marketCapSol ??
    existing?.lastMarketCapSol ??
    null;
  const initial =
    row.initialMarketCapSol ??
    existing?.initialMarketCapSol ??
    first?.marketCapSol ??
    mcap ??
    null;
  const change = mcap != null && initial != null ? mcap - initial : null;
  const pct =
    change != null && initial != null && initial > 0
      ? (change / initial) * 100
      : null;
  const avg = (ms: number): number | null => {
    const vals = mergedSamples
      .filter((sample) => sample.capturedAtMs >= now - ms)
      .map((sample) => sample.marketCapSol)
      .filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value),
      );
    return vals.length
      ? vals.reduce((sum, value) => sum + value, 0) / vals.length
      : null;
  };
  return {
    ...existing,
    ...row,
    marketCapSol: mcap,
    marketCapUsd: mcap,
    lastMarketCapSol: mcap,
    initialMarketCapSol: initial,
    initialMarketCapUsd: initial,
    marketCapChangeSol: row.marketCapChangeSol ?? change,
    marketCapChangePct: row.marketCapChangePct ?? pct,
    samples: mergedSamples,
    sma1m: row.sma1m ?? avg(60_000),
    sma5m: row.sma5m ?? avg(5 * 60_000),
    sma15m: row.sma15m ?? avg(15 * 60_000),
    lastTradeAtMs:
      row.lastTradeAtMs ??
      (row.eventType === "trade" ? now : existing?.lastTradeAtMs) ??
      row.updatedAtMs ??
      existing?.lastTradeAtMs ??
      row.createdAtMs ??
      now,
    updatedAtMs: row.updatedAtMs ?? now,
  };
}

export function mergePumpToken(row: PumpFeedRow): void {
  if (!row.mint) return appendPumpFeed(row);
  const existingIndex = state.pumpFeed.findIndex(
    (item) => item.mint === row.mint,
  );
  if (existingIndex >= 0) {
    const merged = normalizeFeedRow(row, state.pumpFeed[existingIndex]);
    state.pumpFeed = [
      merged,
      ...state.pumpFeed.filter((_item, index) => index !== existingIndex),
    ].slice(0, 500);
  } else {
    state.pumpFeed = [normalizeFeedRow(row), ...state.pumpFeed].slice(0, 500);
  }
  for (const group of state.watchGroups) {
    const tokenIndex = group.tokens.findIndex(
      (token) => token.mint === row.mint,
    );
    if (tokenIndex >= 0)
      group.tokens[tokenIndex] = normalizeFeedRow(
        row as PumpFeedRow,
        group.tokens[tokenIndex] as any,
      ) as any;
  }
  schedulePumpFeedUpdate();
}

export function appendPumpFeed(row: PumpFeedRow): void {
  state.pumpFeed = [row, ...state.pumpFeed].slice(0, 500);
  schedulePumpFeedUpdate();
}

export function replacePumpFeedFromRows(
  rows: PumpFeedRow[],
  options: { keepPinned?: boolean } = {},
): void {
  const next: PumpFeedRow[] = [];
  const seen = new Set<string>();
  const push = (row: PumpFeedRow) => {
    const normalized = normalizeFeedRow(row);
    const key =
      normalized.mint || normalized.signature || pumpRowKey(normalized);
    if (!key || seen.has(key)) return;
    seen.add(key);
    next.push(normalized);
  };
  for (const row of rows ?? []) push(row);
  if (options.keepPinned) {
    for (const row of state.pumpFeed) {
      if (row.mint && state.terminalPinnedMints.includes(row.mint)) push(row);
    }
  }
  state.pumpFeed = next.slice(0, 500);
  followLatestInTerminalInspector();
  schedulePumpFeedUpdate();
}

export async function refreshTerminalFeedOnce(
  args: {
    ensure?: boolean;
    activeWindowMs?: number;
    includeUnpriced?: boolean;
  } = {},
): Promise<void> {
  const activeWindowMs = args.activeWindowMs ?? 5 * 60_000;
  const payload = await measureClient(
    "terminal fetch sqlite feed",
    () =>
      api<{
        rows: PumpFeedRow[];
        stats?: AnyRow;
        health?: AnyRow;
        debug?: AnyRow;
      }>(
        `/api/terminal/feed?ensure=${args.ensure ? "1" : "0"}&limit=300&activeWindowMs=${encodeURIComponent(String(activeWindowMs))}&includeUnpriced=${args.includeUnpriced ? "1" : "0"}&source=${encodeURIComponent(state.pumpFeedSource)}&hideMayhem=${state.hideMayhem ? "1" : "0"}&hideUsdc=${state.hideUsdc ? "1" : "0"}&stats=0&health=0`,
      ),
    (value) => ({
      rows: value.rows?.length ?? 0,
      stats: value.stats,
      health: summarizeTerminalHealth(value.health ?? null),
      debug: value.debug,
    }),
  );
  state.terminalLastPollAtMs = Date.now();
  state.terminalLastRows = payload.rows?.length ?? 0;
  if (payload.health) state.terminalHealth = payload.health;
  replacePumpFeedFromRows(payload.rows ?? [], { keepPinned: true });
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
      const status = String(payload.status ?? "");
      if (
        ["idle", "connecting", "connected", "error", "closed"].includes(status)
      ) {
        state.pumpFeedStatus = status as State["pumpFeedStatus"];
      } else if (
        status === "stream-open" ||
        status === "helius-enrichment" ||
        status === "curve-refresh" ||
        status === "parser-skip" ||
        status === "awaiting-confirmed-transaction"
      ) {
        if (state.pumpFeedAbort && state.pumpFeedStatus !== "error")
          state.pumpFeedStatus = "connected";
      }
      if (status === "error")
        pushToast("error", "Pump feed", payload.error ?? "stream error", 6500);
      state.pumpFeedError = null;
      schedulePumpFeedUpdate();
    } else if (event === "warning") {
      const message = payload.error ?? payload.message ?? "Pump feed warning";
      state.pumpFeedError = null;
      pushToast(
        payload.kind === "rate-limit" ? "warn" : "error",
        "Pump feed",
        message,
        payload.kind === "rate-limit" ? 9000 : 6500,
      );
      schedulePumpFeedUpdate();
    }
  } catch {
    state.pumpFeedError = null;
    pushToast("error", "Pump feed parse", text, 6500);
    schedulePumpFeedUpdate();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function summarizeTerminalHealth(health: AnyRow | null): string {
  if (!health) return "health unknown";
  const store = (health.store ?? {}) as AnyRow;
  const processes = Array.isArray(health.processes) ? health.processes : [];
  const stale = processes.filter((row: AnyRow) => row.stale).length;
  const errors = Array.isArray(health.errors) ? health.errors.length : 0;
  return `tokens=${store.tokens ?? "?"} priced=${store.pricedTokens ?? "?"} imaged=${store.imagedTokens ?? "?"} trades=${store.trades ?? "?"} stale=${stale} errors=${errors}`;
}

export async function refreshTerminalHealth(): Promise<void> {
  const health = await api<AnyRow>("/api/terminal/health?errors=8");
  state.terminalHealth = health;
  measureEvent("terminal health", summarizeTerminalHealth(health));
}

export async function runTerminalProbe(inject = false): Promise<void> {
  const result = await api<AnyRow>("/api/terminal/probe", {
    method: "POST",
    body: JSON.stringify({
      source: state.pumpFeedSource,
      inject,
      ensure: true,
      restartStale: true,
    }),
  });
  state.terminalProbe = result;
  state.terminalHealth = {
    ...(state.terminalHealth ?? {}),
    processes: result.workers,
    errors: result.errors,
    store: result.stats,
  };
  if (Array.isArray(result.rows))
    replacePumpFeedFromRows(result.rows as PumpFeedRow[], { keepPinned: true });
  measureEvent("terminal probe", {
    ok: result.ok,
    source: result.source,
    rows: result.rows?.length,
    injected: result.injected,
  });
  update();
}

export async function startPumpFeed(
  options: { hardRestart?: boolean; clearRows?: boolean } = {},
): Promise<void> {
  state.pumpFeedAbort?.abort();
  const abort = new AbortController();
  state.pumpFeedAbort = abort;
  state.pumpFeedStatus = "connecting";
  state.pumpFeedError = null;
  state.terminalLastError = null;
  state.terminalSessionStartedAtMs = Date.now();
  state.pumpFeed =
    options.clearRows === false
      ? state.pumpFeed.filter(
          (row) => row.mint && state.terminalPinnedMints.includes(row.mint),
        )
      : [];
  followLatestInTerminalInspector();
  measureEvent("terminal connect", { source: state.pumpFeedSource });
  update();

  try {
    const ensure = await api<AnyRow>("/api/workers/ensure", {
      method: "POST",
      body: JSON.stringify({
        action: options.hardRestart ? "restart" : "ensure",
        worker: "all",
        all: true,
        telegram: true,
        restartStale: true,
        source: state.pumpFeedSource,
        clearLive: options.hardRestart === true,
      }),
    });
    measureEvent("terminal workers ensure", ensure);
    pushToast(
      "success",
      "Workers ensured",
      "terminal will poll SQLite feed",
      3500,
    );
  } catch (error) {
    state.terminalLastError =
      error instanceof Error ? error.message : String(error);
    measureEvent("terminal workers ensure failed", {
      error: state.terminalLastError,
    });
    pushToast("error", "Worker ensure failed", state.terminalLastError, 9000);
  }

  let intervalMs = 1000;
  while (!abort.signal.aborted) {
    try {
      await refreshTerminalFeedOnce({
        ensure: true,
        activeWindowMs: 5 * 60_000,
        includeUnpriced: state.pumpFeedSource === "helius",
      });
      state.pumpFeedStatus = "connected";
      state.pumpFeedError = null;
      state.terminalLastError = null;
      measureEvent("terminal poll result", {
        rows: state.terminalLastRows,
        health: summarizeTerminalHealth(state.terminalHealth),
      });
      intervalMs = 1000;
      update();
    } catch (error) {
      if (abort.signal.aborted) break;
      state.pumpFeedStatus = "error";
      state.terminalLastError =
        error instanceof Error ? error.message : String(error);
      state.pumpFeedError = state.terminalLastError;
      measureEvent("terminal poll failed", { error: state.terminalLastError });
      pushToast("error", "Terminal poll failed", state.terminalLastError, 6500);
      update();
      intervalMs = Math.min(8000, Math.floor(intervalMs * 1.6));
    }
    await sleep(intervalMs);
  }

  if (state.pumpFeedAbort === abort) {
    state.pumpFeedAbort = null;
    if (state.pumpFeedStatus !== "error") state.pumpFeedStatus = "closed";
    update();
  }
}

export function stopPumpFeed(): void {
  state.pumpFeedAbort?.abort();
  state.pumpFeedAbort = null;
  state.pumpFeedStatus = "closed";
  state.terminalSessionStartedAtMs = null;
  measureEvent("terminal local stop");
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

export async function refreshLocalOverview(): Promise<void> {
  const fast = await api<Overview>("/api/overview?fast=1");
  mergeOverview(fast, { keepBalances: true });
  state.error = null;
  update();
}

export async function refreshSolBalances(): Promise<void> {
  const full = await api<Overview>("/api/overview?balances=sol");
  mergeOverview(full, { keepBalances: false });
  state.error = null;
  update();
}

export async function refreshOverview(): Promise<void> {
  const rpcStatus = await api<AnyRow>("/api/status").catch(() => null);
  if (rpcStatus) state.rpcStatus = rpcStatus;

  try {
    // Fast path: local SQLite only. This makes wallets/groups/tokens appear instantly.
    await refreshLocalOverview();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.error = `Local overview unavailable: ${message}`;
    if (!state.overview) state.overview = emptyOverview();
  }

  try {
    // Slow path: RPC SOL balances only. SPL holdings belong on Portfolio.
    await refreshSolBalances();
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

export async function refreshCurrentPage(): Promise<void> {
  await refreshLocalOverview();
  await refreshStatus().catch(() => undefined);
  if (state.tab === "overview") {
    await Promise.allSettled([refreshSolBalances(), refreshJobs()]);
  } else if (state.tab === "wallets") {
    await refreshSolBalances().catch(() => undefined);
  } else if (state.tab === "terminal") {
    await refreshWatchGroups().catch(() => undefined);
  } else if (state.tab === "watchlists") {
    await Promise.allSettled([refreshWatchGroups(), refreshPumpLive()]);
  } else if (state.tab === "portfolio") {
    await refreshPortfolio().catch(() => undefined);
  } else if (state.tab === "signals") {
    await refreshSignals().catch(() => undefined);
  } else if (state.tab === "jobs") {
    await refreshJobs().catch(() => undefined);
  }
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
  options: { refreshAfter?: boolean } = {},
): Promise<T | undefined> {
  state.busy = true;
  state.error = null;
  update();
  try {
    const result = await fn();
    if (options.refreshAfter !== false)
      await refreshCurrentPage().catch(() => undefined);
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

function resetPageScopedState(
  previous: State["tab"] | null,
  next: State["tab"],
): void {
  state.previousTab = previous;
  state.error = null;
  state.busy = false;
  if (previous && previous !== next) {
    measureEvent("page-switch", {
      from: previous,
      to: next,
      mountId: state.mountId + 1,
    });
  }
  if (previous === "terminal" && next !== "terminal") {
    state.pumpFeedAbort?.abort();
    state.pumpFeedAbort = null;
    state.pumpFeedStatus = "closed";
    state.pumpFeedError = null;
  }
  if (next === "terminal") {
    state.pumpFeedError = null;
  }
  if (next !== "jobs") {
    state.selectedJob = null;
  }
}

export type ConsolePage = () => any;
let currentPageView: ConsolePage = () => (
  <p className="muted">No page mounted.</p>
);
let currentCleanup: (() => void) | null = null;
let unloadCleanup: (() => void) | null = null;

function ToastHost() {
  const now = Date.now();
  const visible = state.toasts.filter((toast) => toast.expiresAtMs > now);
  if (!visible.length) return null;
  return (
    <div className="toast-host">
      {visible.map((toast) => (
        <button
          type="button"
          className={`toast toast-${toast.kind}`}
          onClick={() => {
            dismissToast(toast.id);
          }}
        >
          <b>{toast.title}</b>
          {toast.message ? <span>{toast.message}</span> : null}
        </button>
      ))}
    </div>
  );
}

function ConsoleRuntime() {
  const Page = currentPageView;
  return (
    <>
      {state.error ? (
        <div className="global-error-strip">
          <span className="pill bad">{state.error}</span>
        </div>
      ) : null}
      <Page />
      <ToastHost />
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
  const previous = state.tab;
  if (unloadCleanup) window.removeEventListener("beforeunload", unloadCleanup);
  unloadCleanup = null;
  currentCleanup?.();
  currentCleanup = null;
  state.mountId += 1;
  state.measureScope = `solard:web:${page}#${state.mountId}`;
  resetPageScopedState(previous, page);
  state.tab = page;
  currentPageView = view;
  measureEvent("mount", {
    page,
    previous,
    url: window.location.pathname,
    moduleSingleton: true,
  });
  update();

  void runAction(
    async () => {
      await measureClient("mount-load", async () => {
        await refreshLocalOverview().catch(() => undefined);
        await refreshStatus().catch(() => undefined);

        if (page === "overview") {
          await Promise.allSettled([refreshSolBalances(), refreshJobs()]);
        } else if (page === "wallets") {
          await refreshSolBalances().catch(() => undefined);
        } else if (page === "terminal") {
          void refreshTerminalFeedOnce({
            ensure: false,
            activeWindowMs: 5 * 60_000,
            includeUnpriced: state.pumpFeedSource === "helius",
          })
            .then(update)
            .catch((error) => {
              state.terminalLastError =
                error instanceof Error ? error.message : String(error);
              update();
            });
          void refreshWatchGroups()
            .then(update)
            .catch(() => undefined);
        } else if (page === "watchlists") {
          await Promise.allSettled([refreshWatchGroups(), refreshPumpLive()]);
        } else if (page === "portfolio") {
          await refreshPortfolio().catch(() => undefined);
        } else if (page === "signals") {
          await refreshSignals().catch(() => undefined);
        } else if (page === "jobs") {
          await refreshJobs().catch(() => undefined);
        }

        return {
          page,
          wallets: state.overview?.wallets?.length ?? 0,
          groups: state.overview?.groups?.length ?? 0,
        };
      });
    },
    { refreshAfter: false },
  );

  if (
    page === "terminal" &&
    localStorage.getItem("solard:pump-auto-connect") === "1"
  ) {
    void measureClient("terminal-start-feed", startPumpFeed, () => ({
      status: state.pumpFeedStatus,
      source: state.pumpFeedSource,
    }));
  }

  const dataInterval = setInterval(
    () => {
      void measureClient("interval:data", async () => {
        if (state.tab === "jobs" || state.selectedJobId)
          await refreshJobs()
            .then(update)
            .catch(() => undefined);
        if (state.tab === "watchlists")
          await refreshPumpLive()
            .then(update)
            .catch(() => undefined);
        if (state.tab === "terminal")
          await refreshTerminalFeedOnce({
            ensure: false,
            activeWindowMs: 5 * 60_000,
            includeUnpriced: state.pumpFeedSource === "helius",
          })
            .then(update)
            .catch((error) => {
              state.terminalLastError =
                error instanceof Error ? error.message : String(error);
              update();
            });
        if (state.tab === "signals")
          await refreshSignals()
            .then(update)
            .catch(() => undefined);
        if (state.tab === "portfolio")
          await refreshPortfolio()
            .then(update)
            .catch(() => undefined);
        return { page: state.tab };
      }).catch(() => undefined);
    },
    state.tab === "terminal" ? 2500 : 5000,
  );

  const statusInterval = setInterval(() => {
    void measureClient("interval:status", async () => {
      await refreshStatus()
        .then(update)
        .catch(() => undefined);
      return { ok: state.rpcStatus?.ok, slot: state.rpcStatus?.slot };
    }).catch(() => undefined);
  }, 10_000);

  const cleanup = () =>
    measureClientSync("unmount", () => {
      clearInterval(dataInterval);
      clearInterval(statusInterval);
      state.pumpFeedAbort?.abort();
      state.pumpFeedAbort = null;
      return { page, mountId: state.mountId };
    });
  currentCleanup = cleanup;
  unloadCleanup = cleanup;
  window.addEventListener("beforeunload", cleanup, { once: true });
  return cleanup;
}
