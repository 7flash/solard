import "./page.css";
import { render } from "tradjs/client";
import { api } from "../_client/api";
import { age, formatMcap, numberValue, short } from "../_client/format";
import {
  storageFlag,
  storageGet,
  storageJson,
  storageSet,
} from "../_client/storage";
import {
  clearClientMeasureEntries,
  getClientMeasureEntries,
  subscribeClientMeasure,
  type ClientMeasureEntry,
} from "../_client/measure";
import {
  compactId,
  summarizeError,
  terminalFeedMeasure,
  terminalHoldersMeasure,
  terminalTradeMeasure,
  terminalUiMeasure,
} from "./measure";
import type {
  AnyRow,
  OverviewPayload,
  PumpFeedRow,
  TerminalFeedPayload,
  TerminalHealthPayload,
  WalletRow,
} from "../_client/types";

type SortBase =
  | "created"
  | "lastTrade"
  | "mcap"
  | "ath"
  | "atl"
  | "volume1m"
  | "volume5m"
  | "volume15m"
  | "volumeDelta1m"
  | "volumeDelta5m"
  | "volumeDelta15m"
  | "sma1m"
  | "sma5m"
  | "sma15m"
  | "smaDelta1m"
  | "smaDelta5m"
  | "smaDelta15m"
  | "trades1m"
  | "trades5m"
  | "trades15m"
  | "tradesDelta1m"
  | "tradesDelta5m"
  | "tradesDelta15m"
  | "holdersNow"
  | "holders5mAgo"
  | "holders15mAgo"
  | "holdersDelta1m"
  | "holdersDelta5m"
  | "holdersDelta15m";

type SortKey = `${SortBase}-asc` | `${SortBase}-desc`;

type HolderRow = {
  owner?: string | null;
  tokenAccount?: string | null;

  observedBuySol?: number | null;
  observedSellSol?: number | null;
  observedNetSpentSol?: number | null;
  observedTrades?: number | null;

  uiAmount?: string | number | null;
  amountUi?: string | number | null;
  amount?: string | number | null;
  pctSupply?: string | number | null;
  percent?: string | number | null;
  [key: string]: any;
};

type UiErrorEntry = {
  id: string;
  message: string;
  source: "render" | "feed";
  createdAtMs: number;
  count: number;
};

type PageState = {
  rows: PumpFeedRow[];
  health: TerminalHealthPayload | null;
  feedMeta: AnyRow | null;
  status: "idle" | "loading" | "live" | "error";
  error: string | null;

  uiErrors: UiErrorEntry[];
  errorDockOpen: boolean;

  lastPollAtMs: number | null;
  lastRows: number;

  pendingRows: PumpFeedRow[] | null;
  pendingNewRows: number;

  filter: string;

  minMarketCapUsd: string;
  maxMarketCapUsd: string;

  minAgeMinutes: string;
  maxAgeMinutes: string;

  filterWindow: "1m" | "5m" | "15m";

  minVolumeSol: string;
  maxVolumeSol: string;

  minSmaUsd: string;
  maxSmaUsd: string;

  minTrades: string;
  maxTrades: string;

  minHolders: string;
  maxHolders: string;

  sort: SortKey;
  selectedKey: string | null;
  pinned: string[];

  resetBusy: boolean;
  resetMessage: string | null;

  wallets: WalletRow[];
  selectedWallet: string;
  buySol: string;
  sellPct: string;
  slippageBps: string;
  sender: string;
  liveTrade: boolean;
  tradeBusy: boolean;
  tradeMessage: string | null;
  tradeError: string | null;
  holdersMint: string | null;
  holders: HolderRow[];
  holdersBusy: boolean;
  holdersMessage: string | null;
  holdersError: string | null;
  showLogs: boolean;
  logs: ClientMeasureEntry[];

  selectedLogId: string | number | null;
  copiedLogId: string | number | null;
};

const FEED_LIMIT = 160;
const FEED_WINDOW_MS = Number(
  storageGet("solard:terminal-feed-window-ms", "300000"),
);

const state: PageState = {
  rows: [],
  health: null,
  feedMeta: null,
  status: "idle",
  error: null,

  uiErrors: [],
  errorDockOpen: false,

  lastPollAtMs: null,
  lastRows: 0,

  pendingRows: null,
  pendingNewRows: 0,

  filter: storageGet("solwal:pump-feed-filter", ""),

  minMarketCapUsd: storageGet("solard:terminal-min-mcap-usd", "2500"),

  maxMarketCapUsd: storageGet("solard:terminal-max-mcap-usd", ""),

  minAgeMinutes: storageGet("solard:terminal-min-age-minutes", ""),

  maxAgeMinutes: storageGet("solard:terminal-max-age-minutes", ""),

  filterWindow:
    storageGet("solard:terminal-filter-window", "5m") === "1m"
      ? "1m"
      : storageGet("solard:terminal-filter-window", "5m") === "15m"
        ? "15m"
        : "5m",

  minVolumeSol: storageGet("solard:terminal-min-volume-sol", ""),

  maxVolumeSol: storageGet("solard:terminal-max-volume-sol", ""),

  minSmaUsd: storageGet("solard:terminal-min-sma-usd", ""),

  maxSmaUsd: storageGet("solard:terminal-max-sma-usd", ""),

  minTrades: storageGet("solard:terminal-min-trades", ""),

  maxTrades: storageGet("solard:terminal-max-trades", ""),

  minHolders: storageGet("solard:terminal-min-holders", ""),

  maxHolders: storageGet("solard:terminal-max-holders", ""),

  sort: (() => {
    const saved = storageGet("solwal:pump-feed-sort", "created-desc");

    if (saved === "newest" || saved.startsWith("age")) {
      return "created-desc";
    }

    return saved as SortKey;
  })(),
  selectedKey: storageGet("solard:terminal-inspector-key", "") || null,
  pinned: storageJson<string[]>("solard:terminal-pinned-mints", []).filter(
    (x) => typeof x === "string",
  ),

  resetBusy: false,
  resetMessage: null,

  wallets: [],
  selectedWallet: storageGet("solwal:terminal-default-wallet", ""),
  buySol: storageGet("solwal:terminal-default-buy-sol", "0.05"),
  sellPct: storageGet("solwal:terminal-default-sell-pct", "100"),
  slippageBps: storageGet("solwal:terminal-default-slippage-bps", "9999"),
  sender: storageGet("solwal:terminal-default-sender", "helius-fast"),
  liveTrade: storageFlag("solwal:terminal-quick-live"),
  tradeBusy: false,
  tradeMessage: null,
  tradeError: null,
  holdersMint: null,
  holders: [],
  holdersBusy: false,
  holdersMessage: null,
  holdersError: null,
  showLogs: storageGet("solard:terminal-show-logs", "1") !== "0",
  logs: getClientMeasureEntries(),

  selectedLogId: null,
  copiedLogId: null,
};

let unmounted = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollInFlight = false;
let pollStartedAtMs = 0;

let pollAbortController: AbortController | null = null;

let pollWatchdogTimer: ReturnType<typeof setInterval> | null = null;

let unsubscribeLogs: (() => void) | null = null;
let logRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function pollMs(): number {
  const parsed = Number(storageGet("solard:terminal-poll-ms", "1000"));
  return Number.isFinite(parsed)
    ? Math.max(1000, Math.min(parsed, 30000))
    : 1000;
}

function rootElement(): HTMLElement {
  const root = document.getElementById("app-root");
  if (!root) throw new Error("Missing #app-root");
  return root;
}

let renderFrame: number | null = null;

let renderActive = false;
let renderPending = false;

function updateActiveNavigation(): void {
  document
    .querySelectorAll<HTMLAnchorElement>("#main-nav a")
    .forEach((link) =>
      link.classList.toggle("active", link.dataset.page === "terminal"),
    );
}

function rememberUiError(source: UiErrorEntry["source"], error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);

  const existing = state.uiErrors.find(
    (item) => item.source === source && item.message === message,
  );

  if (existing) {
    existing.count++;
    existing.createdAtMs = Date.now();
    return;
  }

  state.uiErrors = [
    {
      id: `${source}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,

      source,
      message,
      createdAtMs: Date.now(),

      count: 1,
    },

    ...state.uiErrors,
  ].slice(0, 25);
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement("textarea");

    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";

    document.body.appendChild(textarea);

    textarea.select();

    document.execCommand("copy");

    textarea.remove();
  }
}

function renderTerminalPage(): void {
  if (unmounted) {
    return;
  }

  if (renderActive) {
    renderPending = true;
    return;
  }

  renderActive = true;

  try {
    /**
     * TradJS owns #app-root and performs normal reconciliation.
     * Never clone, replace, detach, clear, or manually rewrite this root.
     */
    render(<TerminalPage />, rootElement(), {
      reconciler: "sequential",
    });

    updateActiveNavigation();
  } catch (error) {
    rememberUiError("render", error);

    console.error("[solard:terminal] render failed", error);
  } finally {
    renderActive = false;

    if (renderPending && !unmounted) {
      renderPending = false;
      rerender();
    }
  }
}

function rerender(): void {
  if (unmounted) {
    return;
  }

  if (renderActive) {
    renderPending = true;
    return;
  }

  if (renderFrame != null) {
    return;
  }

  /**
   * Feed polling, activity events, and user actions can request updates in the
   * same frame. Collapse them into one TradJS render.
   */
  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;

    renderTerminalPage();
  });
}

function clearPollTimer(): void {
  if (pollTimer != null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function scheduleNextPoll(): void {
  clearPollTimer();
  if (unmounted || state.status === "idle") return;
  pollTimer = setTimeout(
    () => void reloadFeed({ scheduleNext: true }),
    pollMs(),
  );
}

function startPollWatchdog(): void {
  if (pollWatchdogTimer != null) {
    return;
  }

  pollWatchdogTimer = setInterval(() => {
    if (unmounted || state.status === "idle") {
      return;
    }

    const now = Date.now();

    const staleAfterMs = Math.max(12_000, pollMs() * 5);

    if (
      pollInFlight &&
      pollStartedAtMs > 0 &&
      now - pollStartedAtMs > staleAfterMs
    ) {
      pollAbortController?.abort();

      return;
    }

    if (
      !pollInFlight &&
      (state.lastPollAtMs == null || now - state.lastPollAtMs > staleAfterMs)
    ) {
      void reloadFeed({
        includeHealth: true,

        scheduleNext: true,
      });
    }
  }, 3_000);
}

function stopPollWatchdog(): void {
  if (pollWatchdogTimer != null) {
    clearInterval(pollWatchdogTimer);

    pollWatchdogTimer = null;
  }

  pollAbortController?.abort();

  pollAbortController = null;
}

function imageUrl(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (text.startsWith("ipfs://"))
    return `https://ipfs.io/ipfs/${text.replace(/^ipfs:\/\//, "")}`;
  if (/^https?:\/\//i.test(text)) return text;
  return null;
}

function tokenImage(row: PumpFeedRow | null | undefined): string | null {
  if (!row) return null;
  return (
    imageUrl(row.image) ??
    imageUrl(row.raw?.image) ??
    imageUrl(row.raw?.metadata?.image) ??
    imageUrl(row.raw?.content?.links?.image) ??
    null
  );
}

function TokenAvatar({
  row,
  large = false,
}: {
  row: PumpFeedRow;
  large?: boolean;
}) {
  const src = tokenImage(row);
  const initial =
    String(row.symbol ?? row.name ?? "?")
      .replace(/^\$/, "")
      .slice(0, 2)
      .toUpperCase() || "?";
  return src ? (
    <img
      className={`terminal-token-avatar ${large ? "large" : ""}`}
      src={src}
      loading="lazy"
      alt={String(row.symbol ?? row.name ?? "token")}
    />
  ) : (
    <div
      className={`terminal-token-avatar terminal-token-avatar-fallback ${large ? "large" : ""}`}
    >
      {initial}
    </div>
  );
}

function rowKey(row: PumpFeedRow): string {
  return (
    row.mint ||
    row.signature ||
    `${row.symbol ?? row.name ?? "row"}:${row.createdAtMs ?? row.updatedAtMs ?? ""}`
  );
}

function latestMcap(
  row: Partial<PumpFeedRow> | null | undefined,
): number | null {
  return (
    numberValue(row?.marketCapUsd) ??
    numberValue((row as any)?.currentMarketCapUsd) ??
    numberValue((row as any)?.lastMarketCapUsd)
  );
}

function createdTime(row: PumpFeedRow): number | null {
  const value = Number(row.createdAtMs ?? 0);

  return Number.isFinite(value) && value > 0 ? value : null;
}

function lastTradeTime(row: PumpFeedRow): number | null {
  const value = Number(row.lastTradeAtMs ?? 0);

  return Number.isFinite(value) && value > 0 ? value : null;
}

function displayAge(value: number | null): string {
  return value == null ? "—" : age(value);
}

function booleanFlag(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") {
    return true;
  }

  if (value === false || value === 0 || value === "0") {
    return false;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (normalized === "true" || normalized === "yes") {
      return true;
    }

    if (normalized === "false" || normalized === "no") {
      return false;
    }
  }

  return null;
}

function mayhemFlag(row: PumpFeedRow): boolean | null {
  for (const value of [
    row.isMayhemMode,
    (row as any).is_mayhem_mode,
    row.raw?.isMayhemMode,
    row.raw?.is_mayhem_mode,
    row.raw?.metadata?.isMayhemMode,
    row.raw?.metadata?.is_mayhem_mode,
  ]) {
    const parsed = booleanFlag(value);

    if (parsed != null) {
      return parsed;
    }
  }

  return null;
}

function isMayhemKnown(row: PumpFeedRow): boolean {
  return (
    mayhemFlag(row) === true ||
    Number((row as any).mayhemCheckedAtMs ?? row.raw?.mayhemCheckedAtMs ?? 0) >
      0
  );
}

function isMayhem(row: PumpFeedRow): boolean {
  return mayhemFlag(row) === true;
}

function isUsdc(row: PumpFeedRow): boolean {
  const haystack =
    `${row.quoteAsset ?? ""} ${row.quoteMint ?? ""} ${row.raw?.quoteAsset ?? ""} ${row.raw?.quoteMint ?? ""}`.toLowerCase();
  return (
    haystack.includes("usdc") ||
    haystack.includes("epjfwdd5aufqssqem2qn1xzybapc8g4wegkgzwydt1v")
  );
}

function isPinned(row: PumpFeedRow): boolean {
  return !!row.mint && state.pinned.includes(row.mint);
}

function optionalFilterNumber(value: string): number | null {
  if (!value.trim()) {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function minimumMarketCapUsd(): number {
  return optionalFilterNumber(state.minMarketCapUsd) ?? 0;
}

function maximumMarketCapUsd(): number {
  return optionalFilterNumber(state.maxMarketCapUsd) ?? 0;
}

function valueInRange(
  value: number | null,
  minimumText: string,
  maximumText: string,
): boolean {
  const minimum = optionalFilterNumber(minimumText);

  const maximum = optionalFilterNumber(maximumText);

  if (minimum == null && maximum == null) {
    return true;
  }

  if (value == null || !Number.isFinite(value)) {
    return false;
  }

  return (
    (minimum == null || value >= minimum) &&
    (maximum == null || value <= maximum)
  );
}

function tokenAgeMinutes(row: PumpFeedRow): number | null {
  const createdAtMs = createdTime(row);

  if (createdAtMs == null || createdAtMs <= 0) {
    return null;
  }

  return Math.max(0, (Date.now() - createdAtMs) / 60_000);
}

function passesFilters(row: PumpFeedRow): boolean {
  if (
    !valueInRange(
      latestMcap(row),
      state.minMarketCapUsd,
      state.maxMarketCapUsd,
    ) ||
    !valueInRange(
      tokenAgeMinutes(row),
      state.minAgeMinutes,
      state.maxAgeMinutes,
    ) ||
    !valueInRange(
      volumeFor(row, state.filterWindow),
      state.minVolumeSol,
      state.maxVolumeSol,
    ) ||
    !valueInRange(
      smaFor(row, state.filterWindow),
      state.minSmaUsd,
      state.maxSmaUsd,
    ) ||
    !valueInRange(
      tradesFor(row, state.filterWindow),
      state.minTrades,
      state.maxTrades,
    ) ||
    !valueInRange(holderCount(row, "Now"), state.minHolders, state.maxHolders)
  ) {
    return false;
  }

  const q = state.filter.trim().toLowerCase();

  if (!q) {
    return true;
  }

  return [
    row.name,
    row.symbol,
    row.mint,
    row.creator,
    row.quoteAsset,
    row.quoteMint,
    row.source,
  ]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

type MetricWindow = "1m" | "5m" | "15m";

type WindowMetric = "volume" | "sma" | "trades";

function tradesFor(row: PumpFeedRow, window: MetricWindow): number {
  return (
    numberValue((row as any)[`trades${window}`]) ??
    (window === "15m" ? numberValue(row.tradeCount) : null) ??
    0
  );
}

function volumeFor(row: PumpFeedRow, window: MetricWindow): number {
  return numberValue((row as any)[`volumeSol${window}`]) ?? 0;
}

function smaFor(row: PumpFeedRow, window: MetricWindow): number | null {
  return numberValue((row as any)[`sma${window}`]);
}

function previousTradesFor(row: PumpFeedRow, window: MetricWindow): number {
  return numberValue((row as any)[`previousTrades${window}`]) ?? 0;
}

function previousVolumeFor(row: PumpFeedRow, window: MetricWindow): number {
  return numberValue((row as any)[`previousVolumeSol${window}`]) ?? 0;
}

function previousSmaFor(row: PumpFeedRow, window: MetricWindow): number | null {
  return numberValue((row as any)[`previousSma${window}`]);
}

function amountChange(
  current: number | null,
  previous: number | null,
): number | null {
  if (current == null || previous == null) {
    return null;
  }

  return current - previous;
}

const SMA_DELTA_MIN_USD = 3_000;

const WINDOW_DURATION_MS: Record<MetricWindow, number> = {
  "1m": 60_000,

  "5m": 5 * 60_000,

  "15m": 15 * 60_000,
};

function dataCoverageStartedAt(row: PumpFeedRow): number | null {
  const candidates = [
    numberValue((row as any).dataCoverageStartedAtMs),

    numberValue((row as any).firstRecordedTradeAtMs),

    numberValue(row.createdAtMs),

    numberValue((row as any).observedAtMs),
  ].filter(
    (value): value is number =>
      value != null && Number.isFinite(value) && value > 0,
  );

  return candidates.length ? Math.max(...candidates) : null;
}

function hasRecordedCoverage(row: PumpFeedRow, requiredMs: number): boolean {
  const startedAtMs = dataCoverageStartedAt(row);

  return startedAtMs != null && Date.now() - startedAtMs >= requiredMs;
}

/**
 * Volume, SMA, and transaction deltas compare two equal-length windows.
 */
function metricDeltaReady(row: PumpFeedRow, window: MetricWindow): boolean {
  return hasRecordedCoverage(row, WINDOW_DURATION_MS[window] * 2);
}

/**
 * Holder deltas compare now with one historical point.
 */
function holderDeltaReady(row: PumpFeedRow, window: MetricWindow): boolean {
  return hasRecordedCoverage(row, WINDOW_DURATION_MS[window]);
}

function metricDelta(
  row: PumpFeedRow,
  metric: WindowMetric,
  window: MetricWindow,
): number | null {
  if (!metricDeltaReady(row, window)) {
    return null;
  }

  if (metric === "volume") {
    return amountChange(volumeFor(row, window), previousVolumeFor(row, window));
  }

  if (metric === "trades") {
    return amountChange(tradesFor(row, window), previousTradesFor(row, window));
  }

  const delta = amountChange(smaFor(row, window), previousSmaFor(row, window));

  if (delta == null || Math.abs(delta) < SMA_DELTA_MIN_USD) {
    return null;
  }

  return delta;
}

function holderCount(
  row: PumpFeedRow,
  point: "Now" | "1mAgo" | "5mAgo" | "15mAgo",
): number {
  return numberValue((row as any)[`holders${point}`]) ?? 0;
}

function holderDelta(row: PumpFeedRow, window: MetricWindow): number | null {
  if (!holderDeltaReady(row, window)) {
    return null;
  }

  const point =
    window === "1m" ? "1mAgo" : window === "5m" ? "5mAgo" : "15mAgo";

  return amountChange(holderCount(row, "Now"), holderCount(row, point));
}

type DeltaFormat = "volume" | "marketCap" | "count";

function signedPrefix(value: number): string {
  return value > 0 ? "+" : value < 0 ? "−" : "";
}

function formatCountDelta(value: number): string {
  return `${signedPrefix(value)}${Math.abs(Math.round(value)).toLocaleString(
    "en-US",
  )}`;
}

function formatMarketCapDelta(value: number): string {
  if (value === 0) {
    return "$0";
  }

  return `${signedPrefix(value)}${formatMcap(Math.abs(value))}`;
}

function formatVolumeDelta(value: number): string {
  if (value === 0) {
    return "0 SOL";
  }

  return `${signedPrefix(value)}${formatVolumeSol(Math.abs(value))}`;
}

function formatDelta(value: number | null, format: DeltaFormat): string {
  if (value == null || !Number.isFinite(value)) {
    return "—";
  }

  if (format === "volume") {
    return formatVolumeDelta(value);
  }

  if (format === "marketCap") {
    return formatMarketCapDelta(value);
  }

  return formatCountDelta(value);
}

function deltaTone(value: number | null): string {
  if (value == null) {
    return "neutral";
  }

  if (value > 0) {
    return "positive";
  }

  if (value < 0) {
    return "negative";
  }

  return "neutral";
}

function marketCapExtrema(row: PumpFeedRow): {
  ath: number | null;
  atl: number | null;
} {
  const values = [
    numberValue((row as any).athMarketCapUsd),

    numberValue((row as any).atlMarketCapUsd),

    latestMcap(row),
  ].filter(
    (value): value is number =>
      value != null && Number.isFinite(value) && value > 0,
  );

  return {
    ath: values.length ? Math.max(...values) : null,

    atl: values.length ? Math.min(...values) : null,
  };
}

function athMcap(row: PumpFeedRow): number | null {
  return marketCapExtrema(row).ath;
}

function atlMcap(row: PumpFeedRow): number | null {
  return marketCapExtrema(row).atl;
}

function exactSortBase(): SortBase {
  return state.sort.replace(/-(?:asc|desc)$/, "") as SortBase;
}

function sortValue(row: PumpFeedRow): number {
  const base = exactSortBase();

  if (base === "created") {
    return createdTime(row) ?? -Infinity;
  }

  if (base === "lastTrade") {
    return lastTradeTime(row) ?? -Infinity;
  }

  if (base === "mcap") {
    return latestMcap(row) ?? -Infinity;
  }

  if (base === "ath") {
    return athMcap(row) ?? -Infinity;
  }

  if (base === "atl") {
    return atlMcap(row) ?? -Infinity;
  }

  if (base === "holdersNow") {
    return holderCount(row, "Now");
  }

  if (base === "holders5mAgo") {
    return holderCount(row, "5mAgo");
  }

  if (base === "holders15mAgo") {
    return holderCount(row, "15mAgo");
  }

  for (const window of ["1m", "5m", "15m"] as const) {
    if (base === `volume${window}`) {
      return volumeFor(row, window);
    }

    if (base === `volumeDelta${window}`) {
      const delta = metricDelta(row, "volume", window);

      return delta == null || delta === 0 ? Number.NaN : delta;
    }

    if (base === `sma${window}`) {
      return smaFor(row, window) ?? -Infinity;
    }

    if (base === `smaDelta${window}`) {
      const delta = metricDelta(row, "sma", window);

      return delta == null || delta === 0 ? Number.NaN : delta;
    }

    if (base === `trades${window}`) {
      return tradesFor(row, window);
    }

    if (base === `tradesDelta${window}`) {
      const delta = metricDelta(row, "trades", window);

      return delta == null || delta === 0 ? Number.NaN : delta;
    }

    if (base === `holdersDelta${window}`) {
      const delta = holderDelta(row, window);

      return delta == null || delta === 0 ? Number.NaN : delta;
    }
  }

  return createdTime(row) ?? -Infinity;
}

function visibleRows(): PumpFeedRow[] {
  return state.rows.filter(passesFilters).sort((a, b) => {
    if (isPinned(a) !== isPinned(b)) return isPinned(a) ? -1 : 1;
    const dir = state.sort.endsWith("-asc") ? 1 : -1;
    const av = sortValue(a);

    const bv = sortValue(b);

    const aMissing = !Number.isFinite(av);

    const bMissing = !Number.isFinite(bv);

    if (aMissing !== bMissing) {
      return aMissing ? 1 : -1;
    }

    if (!aMissing && av !== bv) {
      return (av - bv) * dir;
    }

    return (createdTime(b) ?? 0) - (createdTime(a) ?? 0);
  });
}

function tableScroller(): HTMLElement | null {
  return document.querySelector(".terminal-table-scroll");
}

function tableAwayFromTop(): boolean {
  return (tableScroller()?.scrollTop ?? 0) > 24;
}

function newRowCount(
  current: readonly PumpFeedRow[],
  incoming: readonly PumpFeedRow[],
): number {
  const currentKeys = new Set(current.map(rowKey));

  return incoming.reduce(
    (count, row) => (currentKeys.has(rowKey(row)) ? count : count + 1),
    0,
  );
}

function updateVisibleRowsWithoutReorder(
  current: readonly PumpFeedRow[],
  incoming: readonly PumpFeedRow[],
): PumpFeedRow[] {
  const incomingByKey = new Map(incoming.map((row) => [rowKey(row), row]));

  return current.map((row) => incomingByKey.get(rowKey(row)) ?? row);
}

function commitPendingRows(): void {
  if (!state.pendingRows) {
    return;
  }

  state.rows = state.pendingRows;

  state.pendingRows = null;

  state.pendingNewRows = 0;

  state.lastRows = state.rows.length;

  rerender();
}

function handleTableScroll(element: HTMLElement): void {
  if (element.scrollTop <= 24 && state.pendingRows) {
    commitPendingRows();
  }
}

function revealPendingRows(): void {
  const scroller = tableScroller();

  if (scroller && scroller.scrollTop > 24) {
    scroller.scrollTo({
      top: 0,
      behavior: "smooth",
    });

    return;
  }

  commitPendingRows();
}

function selectedRow(rows: PumpFeedRow[]): PumpFeedRow | null {
  return (
    rows.find(
      (row) =>
        rowKey(row) === state.selectedKey || row.mint === state.selectedKey,
    ) ??
    rows[0] ??
    null
  );
}

function setSort(base: SortBase): void {
  const defaultKey = `${base}-desc` as SortKey;

  const alternateKey = (
    defaultKey.endsWith("-asc") ? `${base}-desc` : `${base}-asc`
  ) as SortKey;

  state.sort = state.sort === defaultKey ? alternateKey : defaultKey;

  storageSet("solwal:pump-feed-sort", state.sort);

  terminalUiMeasure.measureSync(
    {
      start: () => `ui.sort key=${state.sort}`,

      end: () => ({
        sort: state.sort,
      }),

      catch: summarizeError,
    },
    () => ({
      sort: state.sort,
    }),
  );

  rerender();
}

function sortMark(base: string): string {
  return state.sort === `${base}-asc`
    ? "↑"
    : state.sort === `${base}-desc`
      ? "↓"
      : "";
}

function setFilter(value: string): void {
  state.filter = value;
  storageSet("solwal:pump-feed-filter", value);
  rerender();
}

type NumericFilterField =
  | "minMarketCapUsd"
  | "maxMarketCapUsd"
  | "minAgeMinutes"
  | "maxAgeMinutes"
  | "minVolumeSol"
  | "maxVolumeSol"
  | "minSmaUsd"
  | "maxSmaUsd"
  | "minTrades"
  | "maxTrades"
  | "minHolders"
  | "maxHolders";

const NUMERIC_FILTER_STORAGE: Record<NumericFilterField, string> = {
  minMarketCapUsd: "solard:terminal-min-mcap-usd",

  maxMarketCapUsd: "solard:terminal-max-mcap-usd",

  minAgeMinutes: "solard:terminal-min-age-minutes",

  maxAgeMinutes: "solard:terminal-max-age-minutes",

  minVolumeSol: "solard:terminal-min-volume-sol",

  maxVolumeSol: "solard:terminal-max-volume-sol",

  minSmaUsd: "solard:terminal-min-sma-usd",

  maxSmaUsd: "solard:terminal-max-sma-usd",

  minTrades: "solard:terminal-min-trades",

  maxTrades: "solard:terminal-max-trades",

  minHolders: "solard:terminal-min-holders",

  maxHolders: "solard:terminal-max-holders",
};

function normalizeNumericFilter(value: string): string {
  return value.replace(/[^0-9.]/g, "");
}

function setNumericFilter(field: NumericFilterField, value: string): void {
  const normalized = normalizeNumericFilter(value);

  state[field] = normalized;

  storageSet(NUMERIC_FILTER_STORAGE[field], normalized);

  rerender();
}

function setFilterWindow(value: string): void {
  state.filterWindow = value === "1m" ? "1m" : value === "15m" ? "15m" : "5m";

  storageSet("solard:terminal-filter-window", state.filterWindow);

  rerender();
}

function clearRangeFilters(): void {
  for (const field of Object.keys(
    NUMERIC_FILTER_STORAGE,
  ) as NumericFilterField[]) {
    state[field] = field === "minMarketCapUsd" ? "2500" : "";

    storageSet(NUMERIC_FILTER_STORAGE[field], state[field]);
  }

  state.filterWindow = "5m";

  storageSet("solard:terminal-filter-window", "5m");

  rerender();
}

function togglePinned(row: PumpFeedRow): void {
  if (!row.mint) return;
  state.pinned = state.pinned.includes(row.mint)
    ? state.pinned.filter((mint) => mint !== row.mint)
    : [row.mint, ...state.pinned];
  storageSet("solard:terminal-pinned-mints", JSON.stringify(state.pinned));
  terminalUiMeasure.measureSync(
    {
      start: () => `ui.pin mint=${compactId(row.mint)}`,

      end: () => ({
        pinned: isPinned(row),
      }),

      catch: summarizeError,
    },
    () => ({
      pinned: isPinned(row),
    }),
  );
  rerender();
}

function selectRow(row: PumpFeedRow): void {
  const key = rowKey(row);
  state.selectedKey = key;
  storageSet("solard:terminal-inspector-key", key);
  state.tradeError = null;
  state.tradeMessage = null;
  terminalUiMeasure.measureSync(
    {
      start: () => `ui.select mint=${compactId(row.mint)}`,

      end: () => ({
        symbol: row.symbol ?? null,

        mcap: latestMcap(row),
      }),

      catch: summarizeError,
    },
    () => ({
      symbol: row.symbol ?? null,

      mcap: latestMcap(row),
    }),
  );
  rerender();
}

async function loadWallets(): Promise<void> {
  await terminalUiMeasure
    .measure(
      {
        start: () => "wallets.load",

        end: (overview: any) => ({
          wallets: Array.isArray(overview?.wallets)
            ? overview.wallets.length
            : 0,
        }),

        catch: summarizeError,
      },
      async () => {
        const overview = await api<OverviewPayload>(
          "/api/overview?fast=1&balances=none&tokenLimit=0&executionLimit=0",
        );
        state.wallets = overview.wallets ?? [];

        const selected = selectedWalletAddress();

        if (!selected && state.wallets[0]?.address) {
          state.selectedWallet = state.wallets[0].address;

          storageSet("solwal:terminal-default-wallet", state.selectedWallet);
        } else if (selected) {
          state.selectedWallet = selected;
        }

        return overview;
      },
    )
    .catch(() => undefined);
  rerender();
}

async function reloadFeed(
  options: { includeHealth?: boolean; scheduleNext?: boolean } = {},
): Promise<void> {
  if (pollInFlight) {
    return;
  }

  pollInFlight = true;
  pollStartedAtMs = Date.now();

  const controller = new AbortController();

  pollAbortController = controller;
  state.status = state.rows.length ? "live" : "loading";

  state.error = null;

  if (!state.rows.length) {
    rerender();
  }

  try {
    const payload = await terminalFeedMeasure.measure(
      {
        start: () =>
          `poll limit=${FEED_LIMIT} windowMs=${FEED_WINDOW_MS} health=${options.includeHealth ? 1 : 0}`,

        end: (payload: any) => ({
          rows: Array.isArray(payload?.rows) ? payload.rows.length : 0,

          priced: Number(payload?.meta?.priced ?? 0),
        }),

        catch: summarizeError,
      },
      async () => {
        const params = new URLSearchParams({
          limit: String(FEED_LIMIT),
          activeWindowMs: String(FEED_WINDOW_MS),
          includeUnpriced: "1",
          source: "both",

          minMarketCapUsd: String(minimumMarketCapUsd()),

          maxMarketCapUsd: String(maximumMarketCapUsd()),

          stats: options.includeHealth ? "1" : "0",
          health: options.includeHealth ? "1" : "0",

          pinned: state.pinned.join(","),
        });

        return await api<TerminalFeedPayload>(`/api/terminal/feed?${params}`, {
          signal: controller.signal,
        });
      },
    );

    const incomingRows = payload.rows ?? [];

    if (state.rows.length && tableAwayFromTop()) {
      state.pendingRows = incomingRows;

      state.pendingNewRows = newRowCount(state.rows, incomingRows);

      state.rows = updateVisibleRowsWithoutReorder(state.rows, incomingRows);

      state.lastRows = incomingRows.length;
    } else {
      state.rows = incomingRows;

      state.pendingRows = null;

      state.pendingNewRows = 0;

      state.lastRows = state.rows.length;
    }

    state.feedMeta = payload.meta ?? null;
    state.lastPollAtMs = Date.now();
    if (payload.health) state.health = payload.health;
    state.status = "live";
  } catch (error) {
    const aborted =
      error instanceof DOMException
        ? error.name === "AbortError"
        : error instanceof Error && error.name === "AbortError";

    if (!aborted) {
      state.status = "error";

      state.error = error instanceof Error ? error.message : String(error);

      rememberUiError("feed", error);
    }
  } finally {
    if (pollAbortController === controller) {
      pollAbortController = null;
    }

    pollStartedAtMs = 0;
    pollInFlight = false;

    rerender();

    if (options.scheduleNext) {
      scheduleNextPoll();
    }
  }
}

async function resetFeed(): Promise<void> {
  if (state.resetBusy) return;

  const keep = state.pinned.length;

  const confirmed = window.confirm(
    `Reset the live feed? ${keep} pinned token${keep === 1 ? "" : "s"} will remain visible. Append-only trade history will not be deleted.`,
  );

  if (!confirmed) return;

  state.resetBusy = true;
  state.resetMessage = null;
  state.error = null;

  clearPollTimer();
  rerender();

  try {
    /**
     * Let the current poll settle first so an older response cannot visually
     * repopulate rows after the reset.
     */
    while (pollInFlight && !unmounted) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    clearPollTimer();

    const result = await terminalFeedMeasure.measure(
      {
        start: () => `reset pinned=${state.pinned.length}`,

        end: (value: any) => ({
          resetAtMs: value?.resetAtMs ?? null,

          pinned: Array.isArray(value?.pinned) ? value.pinned.length : 0,
        }),

        catch: summarizeError,
      },
      async () =>
        await api<AnyRow>("/api/terminal/feed/reset", {
          method: "POST",

          body: JSON.stringify({
            pinned: state.pinned,
          }),
        }),
    );

    state.rows = state.rows.filter((row) => isPinned(row));

    state.pendingRows = null;

    state.pendingNewRows = 0;

    if (
      state.selectedKey &&
      !state.rows.some(
        (row) =>
          rowKey(row) === state.selectedKey || row.mint === state.selectedKey,
      )
    ) {
      state.selectedKey = state.rows[0] ? rowKey(state.rows[0]) : null;

      storageSet("solard:terminal-inspector-key", state.selectedKey ?? "");
    }

    state.resetMessage = `Feed reset · kept ${state.pinned.length} pinned`;

    terminalUiMeasure.measureSync(
      {
        start: () => `ui.reset_complete pinned=${state.pinned.length}`,

        end: () => ({
          resetAtMs: result?.resetAtMs ?? null,
        }),

        catch: summarizeError,
      },
      () => ({
        resetAtMs: result?.resetAtMs ?? null,
      }),
    );

    await reloadFeed({
      includeHealth: true,
      scheduleNext: true,
    });
  } catch (error) {
    state.status = "error";

    state.error = error instanceof Error ? error.message : String(error);

    scheduleNextPoll();
  } finally {
    state.resetBusy = false;
    rerender();
  }
}

function restartWorkers(): void {
  void terminalUiMeasure
    .measure(
      {
        start: () => "workers.restart",

        end: (value: any) => ({
          ok: value?.ok !== false,
        }),

        catch: summarizeError,
      },
      async () =>
        await api("/api/workers/ensure", {
          method: "POST",
          body: JSON.stringify({
            action: "restart",
            worker: "all",
            all: true,
            telegram: true,
            restartStale: true,
            source: "both",
            clearLive: false,
          }),
        }),
    )
    .then(() => reloadFeed({ includeHealth: true }))
    .catch((error) => {
      state.error = error instanceof Error ? error.message : String(error);
      state.status = "error";
      rerender();
    });
}

function walletLabel(wallet: WalletRow): string {
  return wallet.name
    ? `${wallet.name} · ${short(wallet.address, 4, 4)}`
    : short(wallet.address, 5, 5);
}

function selectedWalletRow(): WalletRow | null {
  return (
    state.wallets.find(
      (wallet) =>
        wallet.address === state.selectedWallet ||
        wallet.name === state.selectedWallet,
    ) ?? null
  );
}

function selectedWalletAddress(): string | null {
  const wallet = selectedWalletRow();

  const address = String(wallet?.address ?? "").trim();

  return address || null;
}

function selectedWalletLabel(): string {
  const wallet = state.wallets.find(
    (row) =>
      row.address === state.selectedWallet || row.name === state.selectedWallet,
  );
  return wallet
    ? walletLabel(wallet)
    : state.selectedWallet
      ? short(state.selectedWallet, 5, 5)
      : "select wallet";
}

function updateTradeField(
  field: keyof PageState,
  value: string | boolean,
): void {
  (state as any)[field] = value;
  if (field === "selectedWallet")
    storageSet("solwal:terminal-default-wallet", String(value));
  if (field === "buySol")
    storageSet("solwal:terminal-default-buy-sol", String(value));
  if (field === "sellPct")
    storageSet("solwal:terminal-default-sell-pct", String(value));
  if (field === "slippageBps")
    storageSet("solwal:terminal-default-slippage-bps", String(value));
  if (field === "sender")
    storageSet("solwal:terminal-default-sender", String(value));
  if (field === "liveTrade")
    storageSet("solwal:terminal-quick-live", value ? "1" : "0");
  rerender();
}

function tokenMeta(row: PumpFeedRow): AnyRow {
  return {
    name: row.name ?? null,
    symbol: row.symbol ?? null,
    creator: row.creator ?? null,
    uri: row.uri ?? null,
    image: tokenImage(row),
    signature: row.signature ?? null,
    marketCapSol: row.marketCapSol ?? null,
    marketCapUsd: row.marketCapUsd ?? null,
    isMayhemMode: isMayhemKnown(row) ? isMayhem(row) : null,
    quoteAsset: row.quoteAsset ?? null,
    quoteMint: row.quoteMint ?? null,
  };
}

function apiErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const row = value as AnyRow;

  const nested =
    row.error && typeof row.error === "object" ? (row.error as AnyRow) : null;

  if (
    row.ok === false ||
    row.success === false ||
    row.name === "Error" ||
    nested
  ) {
    return String(
      nested?.message ?? row.message ?? row.error ?? "Request failed",
    );
  }

  return null;
}

async function tradeSelected(
  row: PumpFeedRow,
  side: "buy" | "sell",
): Promise<void> {
  if (!row.mint) {
    state.tradeError = "Selected token has no mint.";
    rerender();
    return;
  }
  const walletAddress = selectedWalletAddress();

  if (!walletAddress) {
    state.tradeError = "Select a loaded wallet before trading.";

    rerender();
    return;
  }

  state.selectedWallet = walletAddress;

  storageSet("solwal:terminal-default-wallet", walletAddress);

  state.tradeBusy = true;
  state.tradeMessage = null;
  state.tradeError = null;
  rerender();

  try {
    const result = await terminalTradeMeasure.measure(
      {
        start: () =>
          `${side} mint=${compactId(row.mint)} live=${state.liveTrade ? 1 : 0}`,

        end: (value: any) => ({
          ok: value?.ok !== false && value?.success !== false,
        }),

        catch: summarizeError,
      },
      async () => {
        const body =
          side === "buy"
            ? {
                token: row.mint,
                amountSol: state.buySol,
                wallet: walletAddress,
                slippageBps: Number(state.slippageBps || "9999"),
                sender: state.sender,
                live: state.liveTrade,
                skipSimulation: false,
                skipPreflight: true,
                tokenMeta: tokenMeta(row),
              }
            : {
                token: row.mint,
                wallet: walletAddress,
                bps: Math.max(
                  1,
                  Math.min(
                    10000,
                    Math.round(Number(state.sellPct || "100") * 100),
                  ),
                ),
                slippageBps: Number(state.slippageBps || "9999"),
                sender: state.sender,
                live: state.liveTrade,
                skipSimulation: false,
                skipPreflight: true,
              };
        const response = await api<AnyRow>(`/api/trade/${side}`, {
          method: "POST",
          body: JSON.stringify(body),
        });

        const responseError = apiErrorMessage(response);

        if (responseError) {
          throw new Error(responseError);
        }

        return response;
      },
    );
    state.tradeMessage = `${side.toUpperCase()} ${state.liveTrade ? "live" : "sim"} ok: ${JSON.stringify(result).slice(0, 220)}`;
  } catch (error) {
    state.tradeError = error instanceof Error ? error.message : String(error);
  } finally {
    state.tradeBusy = false;
    rerender();
  }
}

async function refreshHolders(row: PumpFeedRow): Promise<void> {
  if (!row.mint) return;
  state.holdersBusy = true;
  state.holdersMint = row.mint;
  state.holdersError = null;
  state.holdersMessage = "Loading holders…";
  rerender();

  try {
    const result = await terminalHoldersMeasure.measure(
      {
        start: () => `refresh mint=${compactId(row.mint)}`,

        end: (value: any) => ({
          holders: Array.isArray(value?.holders) ? value.holders.length : 0,

          ok: value?.ok !== false,
        }),

        catch: summarizeError,
      },
      async () => {
        const params = new URLSearchParams({
          mint: row.mint!,
          limit: "20",
          refresh: "1",
          source: "terminal-ui",
        });
        return await api<AnyRow>(`/api/token-holders?${params}`);
      },
    );
    const holders = Array.isArray(result.holders)
      ? (result.holders as HolderRow[])
      : [];

    const owners = holders
      .map((holder) => String(holder.owner ?? holder.tokenAccount ?? "").trim())
      .filter(Boolean);

    const pnl = owners.length
      ? await api<AnyRow>("/api/terminal/holder-pnl", {
          method: "POST",

          body: JSON.stringify({
            mint: row.mint,

            owners,
          }),
        })
      : {
          positions: [],
        };

    const positions = new Map(
      (Array.isArray(pnl.positions) ? pnl.positions : []).map(
        (position: AnyRow) => [String(position.owner ?? ""), position],
      ),
    );

    state.holders = holders.map((holder) => {
      const owner = String(holder.owner ?? holder.tokenAccount ?? "");

      const position = positions.get(owner);

      return {
        ...holder,

        observedBuySol: numberValue(position?.buySol),

        observedSellSol: numberValue(position?.sellSol),

        observedNetSpentSol: numberValue(position?.netSpentSol),

        observedTrades: numberValue(position?.trades),
      };
    });

    state.holdersMessage =
      result.unavailableReason ??
      (state.holders.length
        ? `${state.holders.length} holders · observed P/L uses indexed trades only`
        : "No holders yet");
  } catch (error) {
    state.holders = [];
    state.holdersError = error instanceof Error ? error.message : String(error);
    state.holdersMessage = null;
  } finally {
    state.holdersBusy = false;
    rerender();
  }
}

function holderAmount(holder: HolderRow): number | null {
  return numberValue(holder.uiAmount ?? holder.amountUi ?? holder.amount);
}

function holderCurrentValueSol(
  holder: HolderRow,
  row: PumpFeedRow,
): number | null {
  const amount = holderAmount(holder);

  const price = numberValue(row.priceSol);

  if (amount == null || price == null) {
    return null;
  }

  return amount * price;
}

function holderPnlSol(holder: HolderRow, row: PumpFeedRow): number | null {
  const current = holderCurrentValueSol(holder, row);

  const spent = numberValue(holder.observedNetSpentSol);

  if (current == null || spent == null) {
    return null;
  }

  return current - spent;
}

function holderPnlPct(holder: HolderRow, row: PumpFeedRow): number | null {
  const pnl = holderPnlSol(holder, row);

  const spent = numberValue(holder.observedNetSpentSol);

  if (pnl == null || spent == null || spent <= 0) {
    return null;
  }

  return (pnl / spent) * 100;
}

function formatSol(value: unknown): string {
  const number = numberValue(value);

  if (number == null) {
    return "—";
  }

  return `${number.toLocaleString("en-US", {
    maximumFractionDigits: Math.abs(number) < 0.01 ? 6 : 3,
  })} SOL`;
}

function formatPercent(value: unknown): string {
  const number = numberValue(value);

  return number == null ? "—" : `${number.toFixed(2)}%`;
}

function formatVolumeSol(value: unknown): string {
  const number = numberValue(value);

  if (number == null) {
    return "—";
  }

  if (number === 0) {
    return "0 SOL";
  }

  const absolute = Math.abs(number);

  const maximumFractionDigits =
    absolute < 0.001
      ? 8
      : absolute < 0.01
        ? 6
        : absolute < 1
          ? 4
          : absolute < 100
            ? 2
            : 1;

  const formatted = new Intl.NumberFormat("en-US", {
    notation: absolute >= 10_000 ? "compact" : "standard",

    maximumFractionDigits,

    minimumFractionDigits:
      absolute < 0.01 ? Math.min(4, maximumFractionDigits) : 0,
  }).format(number);

  return `${formatted} SOL`;
}

function normalizedExternalUrl(
  kind: "site" | "x" | "tg",
  value: unknown,
): string | null {
  const raw = typeof value === "string" ? value.trim() : "";

  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  if (
    kind === "site" &&
    /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(raw)
  ) {
    return `https://${raw}`;
  }

  const handle = raw
    .replace(/^@/, "")
    .replace(/^(?:x|twitter|telegram|tg):/i, "")
    .trim();

  if (!/^[a-z0-9_]{2,64}$/i.test(handle)) {
    return null;
  }

  if (kind === "x") {
    return `https://x.com/${handle}`;
  }

  if (kind === "tg") {
    return `https://t.me/${handle}`;
  }

  return null;
}

function linksFor(row: PumpFeedRow): Array<{
  label: string;
  href: string;
}> {
  const links: Array<{
    label: string;
    href: string;
  }> = [];

  if (row.mint) {
    links.push({
      label: "solscan",
      href: `https://solscan.io/token/${row.mint}`,
    });

    links.push({
      label: "pump",
      href: `https://pump.fun/${row.mint}`,
    });
  }

  const candidates: Array<["site" | "x" | "tg", unknown[]]> = [
    [
      "site",
      [
        row.website,
        row.raw?.website,
        row.raw?.metadata?.website,
        row.raw?.metadata?.external_url,
      ],
    ],

    [
      "x",
      [
        row.twitter,
        row.raw?.twitter,
        row.raw?.x,
        row.raw?.metadata?.twitter,
        row.raw?.metadata?.x,
      ],
    ],

    ["tg", [row.telegram, row.raw?.telegram, row.raw?.metadata?.telegram]],
  ];

  for (const [label, values] of candidates) {
    const href =
      values
        .map((value) => normalizedExternalUrl(label, value))
        .find(Boolean) ?? null;

    if (href) {
      links.push({
        label,
        href,
      });
    }
  }

  return links;
}

function SortButton({ base, label }: { base: SortBase; label: string }) {
  return (
    <button
      type="button"
      className={`terminal-sort-button ${state.sort.startsWith(base) ? "active" : ""}`}
      onClick={() => setSort(base)}
    >
      {label} {sortMark(base)}
    </button>
  );
}

function HeaderSortButton({
  base,
  label,
  title,
}: {
  base: SortBase;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      className={exactSortBase() === base ? "active" : ""}
      aria-label={title}
      onClick={() => setSort(base)}
    >
      {label}
      {sortMark(base)}
    </button>
  );
}

function RangeFilter({
  label,
  unit,
  minimumField,
  maximumField,
  minimum,
  maximum,
  step = "1",
}: {
  label: string;
  unit?: string;
  minimumField: NumericFilterField;
  maximumField: NumericFilterField;
  minimum: string;
  maximum: string;
  step?: string;
}) {
  return (
    <fieldset className="terminal-range-filter">
      <legend>{label}</legend>

      <label>
        <span>Min</span>

        <span className="terminal-range-input">
          {unit ? <small>{unit}</small> : null}

          <input
            type="number"
            min="0"
            step={step}
            inputMode="decimal"
            value={minimum}
            onInput={(event: any) =>
              setNumericFilter(minimumField, event.currentTarget.value)
            }
          />
        </span>
      </label>

      <span className="terminal-range-separator">–</span>

      <label>
        <span>Max</span>

        <span className="terminal-range-input">
          {unit ? <small>{unit}</small> : null}

          <input
            type="number"
            min="0"
            step={step}
            inputMode="decimal"
            value={maximum}
            onInput={(event: any) =>
              setNumericFilter(maximumField, event.currentTarget.value)
            }
          />
        </span>
      </label>
    </fieldset>
  );
}

function HeaderHelp({ label, help }: { label: string; help: string }) {
  return (
    <span
      className="terminal-header-label terminal-header-tooltip"
      data-help={help}
      aria-label={`${label}. ${help}`}
    >
      <b>{label}</b>
    </span>
  );
}

function windowMetricHelp(prefix: "volume" | "sma" | "trades"): string {
  if (prefix === "volume") {
    return "VOL is SOL traded during the current 1m, 5m, and 15m windows. Δ1 equals current 1m volume minus the immediately previous 1m volume. Negative means less volume than the preceding equal-length window.";
  }

  if (prefix === "sma") {
    return "SMA is average USD market cap during the current window. Its delta is the current-window average minus the preceding equal-length-window average. Negative means average market cap moved down. Moves below $3K are ignored.";
  }

  return "TRX is observed trade count during the current window. Δ1 equals current 1m trades minus immediately previous 1m trades. Negative means fewer trades occurred in the current window; it does not mean a negative number of trades.";
}

function WindowSortHeader({
  label,
  prefix,
}: {
  label: string;
  prefix: "volume" | "sma" | "trades";
}) {
  return (
    <div className="terminal-metric-header">
      <HeaderHelp label={label} help={windowMetricHelp(prefix)} />

      <div className="terminal-header-values">
        {(["1m", "5m", "15m"] as const).map((window) => (
          <HeaderSortButton
            key={`value:${window}`}
            base={`${prefix}${window}` as SortBase}
            label={window.replace("m", "")}
            title={`Sort by ${label} during the current ${window} window`}
          />
        ))}
      </div>

      <div className="terminal-header-deltas">
        {(["1m", "5m", "15m"] as const).map((window) => (
          <HeaderSortButton
            key={`delta:${window}`}
            base={`${prefix}Delta${window}` as SortBase}
            label={`Δ${window.replace("m", "")}`}
            title={`Sort by signed ${label} amount change after ${window === "1m" ? "2 minutes" : window === "5m" ? "10 minutes" : "30 minutes"} of recorded coverage: descending shows increases, ascending shows decreases${prefix === "sma" ? "; moves below $3K are ignored" : ""}`}
          />
        ))}
      </div>
    </div>
  );
}

function MarketCapSortHeader() {
  return (
    <div className="terminal-metric-header terminal-market-cap-header">
      <HeaderHelp
        label="MC"
        help="MC is current USD market cap. ATH and ATL are the highest and lowest valid USD market caps observed in recorded trade history."
      />

      <div>
        <HeaderSortButton
          base="mcap"
          label="MC"
          title="Sort by current market cap"
        />

        <HeaderSortButton
          base="ath"
          label="ATH"
          title="Sort by all-time-high market cap"
        />

        <HeaderSortButton
          base="atl"
          label="ATL"
          title="Sort by all-time-low market cap"
        />
      </div>
    </div>
  );
}

function HolderSortHeader() {
  return (
    <div className="terminal-metric-header">
      <HeaderHelp
        label="HOLD"
        help="Observed holder counts come from indexed owner buy and sell balance changes. N is holders now; 5 and 15 are holder counts five and fifteen minutes ago. Holder Δ1 equals holders now minus holders one minute ago. It is the actual holder-count change, not this minute's additions versus last minute's additions. Negative means fewer observed holders now. Transfers and activity outside recorded history are not included."
      />

      <div className="terminal-header-values">
        <HeaderSortButton
          base="holdersNow"
          label="N"
          title="Sort by observed holders now"
        />

        <HeaderSortButton
          base="holders5mAgo"
          label="5"
          title="Sort by observed holders five minutes ago"
        />

        <HeaderSortButton
          base="holders15mAgo"
          label="15"
          title="Sort by observed holders fifteen minutes ago"
        />
      </div>

      <div className="terminal-header-deltas">
        {(["1m", "5m", "15m"] as const).map((window) => (
          <HeaderSortButton
            key={window}
            base={`holdersDelta${window}` as SortBase}
            label={`Δ${window.replace("m", "")}`}
            title={`Sort by signed observed-holder count change after one complete ${window} interval: descending shows gains, ascending shows losses`}
          />
        ))}
      </div>
    </div>
  );
}

function MintTimeSortHeader() {
  return (
    <div className="terminal-metric-header terminal-time-header">
      <HeaderHelp
        label="Mint / time"
        help="The cell contains the clickable mint, creation age, and latest recorded trade age. C sorts by creation time and T sorts by last trade time."
      />

      <div>
        <HeaderSortButton
          base="created"
          label="C"
          title="Sort by token creation time"
        />

        <HeaderSortButton
          base="lastTrade"
          label="T"
          title="Sort by last trade time"
        />
      </div>
    </div>
  );
}

function MetricStack({
  values,
}: {
  values: Array<{
    label: string;
    value: string;
    delta?: number | null;
    deltaFormat?: DeltaFormat;
  }>;
}) {
  return (
    <div className="terminal-metric-stack">
      {values.map((item) => (
        <div key={item.label}>
          <span>{item.label}</span>

          <span className="terminal-metric-value">
            <b>{item.value}</b>

            {"delta" in item ? (
              <em
                className={`terminal-delta ${deltaTone(item.delta ?? null)}`}
                title={
                  item.delta == null
                    ? "Waiting for complete recorded comparison history"
                    : "Signed amount change versus the previous equal-length window"
                }
              >
                {formatDelta(
                  item.delta ?? null,

                  item.deltaFormat ?? "count",
                )}
              </em>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}

function quoteLabel(row: PumpFeedRow): string {
  if (isUsdc(row)) {
    return "USDC";
  }

  const value = String(
    row.quoteAsset ??
      row.quoteMint ??
      row.raw?.quoteAsset ??
      row.raw?.quoteMint ??
      "",
  )
    .trim()
    .toUpperCase();

  if (
    !value ||
    value.includes("SO111111") ||
    value === "SOL" ||
    value === "WSOL"
  ) {
    return "SOL";
  }

  return short(value, 4, 3);
}

function TokenRow({ row, selected }: { row: PumpFeedRow; selected: boolean }) {
  const pumpHref = row.mint ? `https://pump.fun/${row.mint}` : null;

  return (
    <tr
      className={`${selected ? "selected" : ""} ${isPinned(row) ? "pinned" : ""}`}
      onClick={() => selectRow(row)}
    >
      <td className="terminal-token-cell">
        <button
          type="button"
          className={`terminal-pin-button ${isPinned(row) ? "active" : ""}`}
          title={isPinned(row) ? "Unpin" : "Pin"}
          onClick={(event: any) => {
            event.stopPropagation();
            togglePinned(row);
          }}
        >
          ★
        </button>

        {pumpHref ? (
          <a
            href={pumpHref}
            target="_blank"
            rel="noreferrer"
            title={`Open ${row.mint} on Pump.fun`}
            onClick={(event: any) => event.stopPropagation()}
          >
            <TokenAvatar row={row} />

            <span>
              <b>
                {row.symbol
                  ? `$${row.symbol}`
                  : row.name || short(row.mint, 5, 5)}
              </b>

              <small>{row.name || "unnamed"}</small>
            </span>
          </a>
        ) : (
          <div>
            <TokenAvatar row={row} />

            <span>
              <b>{row.symbol || row.name || "token"}</b>

              <small>{row.name || "unnamed"}</small>
            </span>
          </div>
        )}
      </td>

      <td>
        <MetricStack
          values={[
            {
              label: "MC",
              value: formatMcap(latestMcap(row)),
            },
            {
              label: "ATH",
              value: formatMcap(athMcap(row)),
            },
            {
              label: "ATL",
              value: formatMcap(atlMcap(row)),
            },
          ]}
        />
      </td>

      <td>
        <MetricStack
          values={[
            {
              label: "1m",
              value: formatVolumeSol(volumeFor(row, "1m")),

              delta: metricDelta(row, "volume", "1m"),

              deltaFormat: "volume",
            },
            {
              label: "5m",
              value: formatVolumeSol(volumeFor(row, "5m")),

              delta: metricDelta(row, "volume", "5m"),

              deltaFormat: "volume",
            },
            {
              label: "15m",
              value: formatVolumeSol(volumeFor(row, "15m")),

              delta: metricDelta(row, "volume", "15m"),

              deltaFormat: "volume",
            },
          ]}
        />
      </td>

      <td>
        <MetricStack
          values={[
            {
              label: "1m",
              value: formatMcap(smaFor(row, "1m")),

              delta: metricDelta(row, "sma", "1m"),

              deltaFormat: "marketCap",
            },
            {
              label: "5m",
              value: formatMcap(smaFor(row, "5m")),

              delta: metricDelta(row, "sma", "5m"),

              deltaFormat: "marketCap",
            },
            {
              label: "15m",
              value: formatMcap(smaFor(row, "15m")),

              delta: metricDelta(row, "sma", "15m"),

              deltaFormat: "marketCap",
            },
          ]}
        />
      </td>

      <td>
        <MetricStack
          values={[
            {
              label: "1m",
              value: String(tradesFor(row, "1m")),

              delta: metricDelta(row, "trades", "1m"),

              deltaFormat: "count",
            },
            {
              label: "5m",
              value: String(tradesFor(row, "5m")),

              delta: metricDelta(row, "trades", "5m"),

              deltaFormat: "count",
            },
            {
              label: "15m",
              value: String(tradesFor(row, "15m")),

              delta: metricDelta(row, "trades", "15m"),

              deltaFormat: "count",
            },
          ]}
        />
      </td>

      <td>
        <MetricStack
          values={[
            {
              label: "Now",
              value: String(holderCount(row, "Now")),

              delta: holderDelta(row, "1m"),

              deltaFormat: "count",
            },
            {
              label: "5m",
              value: String(holderCount(row, "5mAgo")),

              delta: holderDelta(row, "5m"),

              deltaFormat: "count",
            },
            {
              label: "15m",
              value: String(holderCount(row, "15mAgo")),

              delta: holderDelta(row, "15m"),

              deltaFormat: "count",
            },
          ]}
        />
      </td>

      <td className="terminal-mint-cell">
        {pumpHref ? (
          <a
            className="terminal-mint-time-link"
            href={pumpHref}
            target="_blank"
            rel="noreferrer"
            title={`Open ${row.mint} on Pump.fun`}
            onClick={(event: any) => event.stopPropagation()}
          >
            <b className="code">{short(row.mint, 6, 5)}</b>

            <span>
              <small>Created</small>
              <strong>{displayAge(createdTime(row))}</strong>
            </span>

            <span>
              <small>Trade</small>
              <strong>{displayAge(lastTradeTime(row))}</strong>
            </span>
          </a>
        ) : (
          <span className="terminal-mint-time-link">—</span>
        )}
      </td>
    </tr>
  );
}

function SelectedToken({ row }: { row: PumpFeedRow | null }) {
  if (!row)
    return (
      <section className="terminal-inspector">
        <p className="muted">Select a token.</p>
      </section>
    );
  const holders = state.holdersMint === row.mint ? state.holders : [];

  return (
    <section className="terminal-inspector">
      <div className="terminal-inspector-header">
        <TokenAvatar row={row} large />
        <div>
          <h3>{row.symbol ? `$${row.symbol}` : row.name || "Token"}</h3>
          <div className="muted">{row.name || short(row.mint, 8, 8)}</div>
          <div className="terminal-links">
            {linksFor(row).map((link) => (
              <a
                key={`${link.label}:${link.href}`}
                href={link.href}
                target="_blank"
                rel="noreferrer"
              >
                {link.label}
              </a>
            ))}
          </div>
        </div>
        <div className="terminal-links">
          <button
            type="button"
            className="secondary compact"
            onClick={() => togglePinned(row)}
          >
            {isPinned(row) ? "Unpin" : "Pin"}
          </button>
          <button
            type="button"
            className="secondary compact"
            disabled={!row.mint || state.holdersBusy}
            onClick={() => void refreshHolders(row)}
          >
            {state.holdersBusy ? "Loading holders…" : "Refresh holders"}
          </button>
        </div>
      </div>

      <div className="terminal-stats">
        <div>
          <span>MCap</span>
          <b>{formatMcap(latestMcap(row))}</b>
        </div>
        <div>
          <span>ATH</span>
          <b>{formatMcap(athMcap(row))}</b>
        </div>
        <div>
          <span>ATL</span>
          <b>{formatMcap(atlMcap(row))}</b>
        </div>

        {(["1m", "5m", "15m"] as const).map((window) => (
          <div key={`window:${window}`}>
            <span>{window}</span>

            <b>
              V {formatVolumeSol(volumeFor(row, window))}{" "}
              <em
                className={`terminal-delta ${deltaTone(metricDelta(row, "volume", window))}`}
              >
                {formatDelta(metricDelta(row, "volume", window), "volume")}
              </em>
              {" · "}S {formatMcap(smaFor(row, window))}{" "}
              <em
                className={`terminal-delta ${deltaTone(metricDelta(row, "sma", window))}`}
              >
                {formatDelta(metricDelta(row, "sma", window), "marketCap")}
              </em>
              {" · "}T {tradesFor(row, window)}{" "}
              <em
                className={`terminal-delta ${deltaTone(metricDelta(row, "trades", window))}`}
              >
                {formatDelta(metricDelta(row, "trades", window), "count")}
              </em>
            </b>
          </div>
        ))}

        <div>
          <span>Holders</span>

          <b>
            {holderCount(row, "Now")}
            {" · Δ1 "}
            <em
              className={`terminal-delta ${deltaTone(holderDelta(row, "1m"))}`}
            >
              {formatDelta(holderDelta(row, "1m"), "count")}
            </em>
            {" · Δ5 "}
            <em
              className={`terminal-delta ${deltaTone(holderDelta(row, "5m"))}`}
            >
              {formatDelta(holderDelta(row, "5m"), "count")}
            </em>
            {" · Δ15 "}
            <em
              className={`terminal-delta ${deltaTone(holderDelta(row, "15m"))}`}
            >
              {formatDelta(holderDelta(row, "15m"), "count")}
            </em>
          </b>
        </div>

        <div>
          <span>Created</span>
          <b>{displayAge(createdTime(row))}</b>
        </div>
        <div>
          <span>Last trade</span>
          <b>{displayAge(lastTradeTime(row))}</b>
        </div>

        <div>
          <span>Recorded coverage</span>

          <b>{displayAge(dataCoverageStartedAt(row))}</b>
        </div>

        <div>
          <span>Mayhem</span>

          <b>
            {isMayhemKnown(row) ? (isMayhem(row) ? "yes" : "no") : "checking"}
          </b>
        </div>

        <div>
          <span>Mayhem check</span>

          <b>
            {Number(
              (row as any).mayhemCheckedAtMs ?? row.raw?.mayhemCheckedAtMs ?? 0,
            ) > 0
              ? displayAge(
                  Number(
                    (row as any).mayhemCheckedAtMs ??
                      row.raw?.mayhemCheckedAtMs,
                  ),
                )
              : "pending"}
          </b>
        </div>

        <div>
          <span>Quote</span>
          <b>{quoteLabel(row)}</b>
        </div>
      </div>
      <div className="terminal-inspector-grid">
        <div className="terminal-panel">
          <h3>Trade</h3>
          <div className="terminal-trade-form">
            <select
              data-terminal-focus="wallet"
              value={state.selectedWallet}
              title={selectedWalletLabel()}
              onInput={(event: any) =>
                updateTradeField("selectedWallet", event.currentTarget.value)
              }
            >
              <option value="">Select wallet…</option>
              {state.wallets.map((wallet) => {
                const value = wallet.address ?? wallet.name ?? "";

                return (
                  <option key={value} value={value}>
                    {walletLabel(wallet)}
                  </option>
                );
              })}
            </select>
            <input
              data-terminal-focus="buy-sol"
              value={state.buySol}
              placeholder="Buy SOL"
              onInput={(event: any) =>
                updateTradeField("buySol", event.currentTarget.value)
              }
            />
            <input
              data-terminal-focus="sell-pct"
              value={state.sellPct}
              placeholder="Sell %"
              onInput={(event: any) =>
                updateTradeField("sellPct", event.currentTarget.value)
              }
            />
            <input
              data-terminal-focus="slippage-bps"
              value={state.slippageBps}
              placeholder="Slippage bps"
              onInput={(event: any) =>
                updateTradeField("slippageBps", event.currentTarget.value)
              }
            />
          </div>
          <div className="terminal-trade-form">
            <select
              data-terminal-focus="sender"
              value={state.sender}
              onInput={(event: any) =>
                updateTradeField("sender", event.currentTarget.value)
              }
            >
              <option value="helius-fast">Helius fast</option>
              <option value="helius-rpc">Helius RPC</option>
              <option value="rpc">RPC</option>
            </select>
            <label className="check">
              <input
                data-terminal-focus="live-trade"
                type="checkbox"
                checked={state.liveTrade}
                onChange={(event: any) =>
                  updateTradeField("liveTrade", event.currentTarget.checked)
                }
              />{" "}
              Live
            </label>
            <span className="muted small">
              {state.liveTrade ? "Live trade" : "Simulation"}
            </span>
            <span className="muted small">Wallet: {selectedWalletLabel()}</span>
          </div>
          <div className="terminal-trade-actions">
            <button
              type="button"
              disabled={state.tradeBusy || !row.mint}
              onClick={() => void tradeSelected(row, "buy")}
            >
              Buy {state.buySol || "0"} SOL
            </button>
            <button
              type="button"
              className="secondary"
              disabled={state.tradeBusy || !row.mint}
              onClick={() => void tradeSelected(row, "sell")}
            >
              Sell {state.sellPct || "0"}%
            </button>
          </div>
          {state.tradeMessage ? (
            <div className="pill ok">{state.tradeMessage}</div>
          ) : null}
          {state.tradeError ? (
            <div className="pill bad">{state.tradeError}</div>
          ) : null}
        </div>

        <div className="terminal-panel">
          <div className="row between">
            <h3>Holders</h3>
            <span className="muted small">
              {state.holdersMint === row.mint
                ? state.holdersMessage
                : "Click refresh holders"}
            </span>
          </div>
          {state.holdersError ? (
            <div className="pill bad">{state.holdersError}</div>
          ) : null}
          {holders.length ? (
            <table className="terminal-holders-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Owner</th>
                  <th>Amount</th>
                  <th>%</th>
                  <th>Observed spent</th>
                  <th>Current value</th>
                  <th>P/L</th>
                  <th>P/L %</th>
                </tr>
              </thead>
              <tbody>
                {holders.slice(0, 20).map((holder, index) => (
                  <tr
                    key={String(holder.owner ?? holder.tokenAccount ?? index)}
                  >
                    <td>{index + 1}</td>
                    <td className="code">
                      {short(holder.owner ?? holder.tokenAccount, 5, 5)}
                    </td>
                    <td>
                      {holder.uiAmount ??
                        holder.amountUi ??
                        holder.amount ??
                        "—"}
                    </td>

                    <td>{formatPercent(holder.pctSupply ?? holder.percent)}</td>

                    <td>{formatSol(holder.observedNetSpentSol)}</td>

                    <td>{formatSol(holderCurrentValueSol(holder, row))}</td>

                    <td>{formatSol(holderPnlSol(holder, row))}</td>

                    <td>{formatPercent(holderPnlPct(holder, row))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">
              {state.holdersMint === row.mint
                ? (state.holdersMessage ?? "No holders loaded.")
                : "Holder lookup is on demand."}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function logPayload(entry: ClientMeasureEntry): unknown {
  return entry.error ?? entry.summary ?? {};
}

function nestedErrorMessage(value: unknown, depth = 0): string | null {
  if (value == null || depth > 5) {
    return null;
  }

  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === "string") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = nestedErrorMessage(item, depth + 1);

      if (found) {
        return found;
      }
    }

    return null;
  }

  if (typeof value === "object") {
    const row = value as Record<string, unknown>;

    const direct = row.error ?? (row.name === "Error" ? row.message : null);

    if (typeof direct === "string" && direct.trim()) {
      return direct.trim();
    }

    if (direct && typeof direct === "object") {
      const nested = nestedErrorMessage(direct, depth + 1);

      if (nested) {
        return nested;
      }
    }

    for (const item of Object.values(row)) {
      const found = nestedErrorMessage(item, depth + 1);

      if (found) {
        return found;
      }
    }
  }

  return null;
}

function logErrorMessage(entry: ClientMeasureEntry): string | null {
  if (entry.error) {
    return nestedErrorMessage(entry.error) ?? String(entry.error);
  }

  return nestedErrorMessage(entry.summary);
}

function logStatus(entry: ClientMeasureEntry): "ok" | "error" {
  return entry.status === "error" || logErrorMessage(entry) ? "error" : "ok";
}

function friendlyLogLabel(entry: ClientMeasureEntry): string {
  const error = logErrorMessage(entry);

  if (error?.includes("insertBefore")) {
    return "Terminal render error";
  }

  let label = String(entry.label ?? "Terminal activity")
    .replace(/^solard:web:terminal(?::[a-z0-9_-]+)*/i, "")
    .replace(/^[:\s-]+/, "")
    .trim();

  if (!label || /^[a-z]{1,3}$/i.test(label)) {
    label = error ? "Terminal error" : "Terminal activity";
  }

  return label
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayedLogs(): ClientMeasureEntry[] {
  const recent = state.logs.slice(0, 40);

  if (
    !state.selectedLogId ||
    recent.some((entry) => entry.id === state.selectedLogId)
  ) {
    return recent;
  }

  const selected = state.logs.find((entry) => entry.id === state.selectedLogId);

  return selected ? [selected, ...recent] : recent;
}

function selectLog(entry: ClientMeasureEntry): void {
  state.selectedLogId = entry.id;

  state.copiedLogId = null;

  rerender();
}

function closeLog(): void {
  state.selectedLogId = null;

  state.copiedLogId = null;

  rerender();
}

async function copyLog(
  entry: ClientMeasureEntry,
  errorOnly = false,
): Promise<void> {
  const error = logErrorMessage(entry);

  const text =
    errorOnly && error
      ? error
      : JSON.stringify(
          {
            status: logStatus(entry),

            label: friendlyLogLabel(entry),

            tookMs: entry.tookMs,

            at: new Date(entry.atMs).toISOString(),

            error,

            details: logPayload(entry),
          },
          null,
          2,
        );

  try {
    await navigator.clipboard.writeText(text);

    state.copiedLogId = entry.id;
  } catch {
    const textarea = document.createElement("textarea");

    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";

    document.body.appendChild(textarea);

    textarea.select();

    document.execCommand("copy");

    textarea.remove();

    state.copiedLogId = entry.id;
  }

  rerender();
}

function ErrorDock() {
  const errors = state.uiErrors;

  return (
    <aside className="terminal-error-dock">
      <button
        type="button"
        className={errors.length ? "has-errors" : ""}
        title={
          errors.length
            ? `${errors.length} retained Terminal errors`
            : "No retained Terminal errors"
        }
        onClick={() => {
          state.errorDockOpen = !state.errorDockOpen;

          rerender();
        }}
      >
        !{errors.length ? <span>{errors.length}</span> : null}
      </button>

      {state.errorDockOpen ? (
        <div className="terminal-error-panel">
          <div className="row between">
            <b>Terminal errors</b>

            <div className="terminal-links">
              <button
                type="button"
                className="secondary compact"
                onClick={() => {
                  state.uiErrors = [];
                  state.error = null;
                  rerender();
                }}
              >
                Clear
              </button>

              <button
                type="button"
                className="secondary compact"
                onClick={() => {
                  state.errorDockOpen = false;

                  rerender();
                }}
              >
                Close
              </button>
            </div>
          </div>

          {errors.length ? (
            errors.map((entry) => (
              <div key={entry.id} className="terminal-error-entry">
                <div className="row between">
                  <b>{entry.source}</b>

                  <span className="muted small">
                    {age(entry.createdAtMs)}
                    {entry.count > 1 ? ` · ×${entry.count}` : ""}
                  </span>
                </div>

                <pre>{entry.message}</pre>

                <button
                  type="button"
                  className="secondary compact"
                  onClick={() => void copyText(entry.message)}
                >
                  Copy
                </button>
              </div>
            ))
          ) : (
            <p className="muted">No retained errors.</p>
          )}
        </div>
      ) : null}
    </aside>
  );
}

function LogsPanel() {
  if (!state.showLogs) {
    return null;
  }

  const entries = displayedLogs();

  return (
    <section className="terminal-activity">
      <div className="terminal-activity-header">
        <div>
          <b>Activity log</b>

          <span className="muted small">
            {state.logs.length} recent events · select an entry to inspect or
            copy it
          </span>
        </div>

        <div className="terminal-links">
          <button
            type="button"
            className="secondary compact"
            onClick={() => {
              clearClientMeasureEntries();

              state.logs = [];

              state.selectedLogId = null;

              state.copiedLogId = null;

              rerender();
            }}
          >
            Clear
          </button>

          <button
            type="button"
            className="secondary compact"
            onClick={() => {
              state.showLogs = false;

              storageSet("solard:terminal-show-logs", "0");

              rerender();
            }}
          >
            Hide activity
          </button>
        </div>
      </div>

      <div className="terminal-activity-list">
        {entries.map((entry) => {
          const status = logStatus(entry);

          const error = logErrorMessage(entry);

          const selected = state.selectedLogId === entry.id;

          return (
            <details
              key={entry.id}
              className={`terminal-activity-entry ${status} ${selected ? "selected" : ""}`}
              data-log-id={entry.id}
              open={selected}
            >
              <summary
                onClick={(event: any) => {
                  event.preventDefault();

                  selectLog(entry);
                }}
              >
                <span>{status}</span>

                <span>
                  {entry.tookMs.toFixed(1)}
                  ms
                </span>

                <b>{friendlyLogLabel(entry)}</b>

                <small>{new Date(entry.atMs).toLocaleTimeString()}</small>
              </summary>

              {selected ? (
                <div className="terminal-activity-detail">
                  {error ? <div className="pill bad">{error}</div> : null}

                  <pre>{JSON.stringify(logPayload(entry), null, 2)}</pre>

                  <div className="terminal-links">
                    {error ? (
                      <button
                        type="button"
                        className="secondary compact"
                        onClick={() => void copyLog(entry, true)}
                      >
                        Copy error
                      </button>
                    ) : null}

                    <button
                      type="button"
                      className="secondary compact"
                      onClick={() => void copyLog(entry)}
                    >
                      Copy details
                    </button>

                    <button
                      type="button"
                      className="secondary compact"
                      onClick={closeLog}
                    >
                      Close
                    </button>

                    {state.copiedLogId === entry.id ? (
                      <span className="pill ok">Copied</span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </details>
          );
        })}
      </div>
    </section>
  );
}

function processData(row: AnyRow | null | undefined): AnyRow {
  if (!row) return {};

  if (row.data && typeof row.data === "object") {
    return row.data;
  }

  try {
    const parsed = JSON.parse(String(row.dataJson ?? "{}"));

    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function TerminalPage() {
  const rows = visibleRows();
  const selected = selectedRow(rows);
  const processes = Array.isArray(state.health?.processes)
    ? state.health!.processes!
    : [];
  const stale = processes.filter((row) => row.stale || row.error).length;

  const indexerProcess =
    processes.find((row: AnyRow) =>
      String(row.name ?? "").includes("indexer"),
    ) ?? null;

  const indexer =
    state.health?.indexer && typeof state.health.indexer === "object"
      ? state.health.indexer
      : processData(indexerProcess);

  const hasIndexerDiagnostics = [
    indexer.messages,
    indexer.recognizedEventLines,
    indexer.parsedTrades,
    indexer.unknownEventLines,
    indexer.eventParseErrors,
  ].some((value) => value != null);

  const pricedRows = state.rows.filter((row) => latestMcap(row) != null).length;

  return (
    <div className="terminal-page">
      <section className="terminal-header">
        <div className="terminal-header-title">
          <h2>Pump</h2>
          <span className="muted small">feed={state.status}</span>
          <span className="muted small">
            rows={rows.length}/{state.rows.length} · raw=
            {state.feedMeta?.count ?? "?"} · poll=
            {state.lastPollAtMs ? age(state.lastPollAtMs) : "never"} · every=
            {pollMs()}ms
          </span>
        </div>
        <div className="terminal-actions">
          <button
            type="button"
            className="secondary compact"
            onClick={() => void reloadFeed({ includeHealth: true })}
          >
            Refresh
          </button>

          <button
            type="button"
            className="secondary compact"
            disabled={state.resetBusy}
            onClick={() => void resetFeed()}
          >
            {state.resetBusy ? "Resetting…" : "Reset feed"}
          </button>

          <a className="secondary compact button" href="/system">
            System logs
          </a>

          <button
            type="button"
            className="secondary compact"
            onClick={restartWorkers}
          >
            Restart workers
          </button>
          <button
            type="button"
            className="secondary compact"
            onClick={() => {
              state.showLogs = !state.showLogs;
              storageSet(
                "solard:terminal-show-logs",
                state.showLogs ? "1" : "0",
              );
              rerender();
            }}
          >
            {state.showLogs ? "Hide activity" : "Show activity"}
          </button>
        </div>
      </section>

      {state.resetMessage ? (
        <div className="pill ok">{state.resetMessage}</div>
      ) : null}

      <section className="terminal-query-row">
        <label className="terminal-query-field">
          <span>Search</span>

          <input
            data-terminal-focus="filter"
            placeholder="symbol, mint, creator, source"
            value={state.filter}
            onInput={(event: any) => setFilter(event.currentTarget.value)}
          />
        </label>

        <label className="terminal-query-field">
          <span>Trade wallet</span>

          <select
            data-terminal-focus="top-wallet"
            value={state.selectedWallet}
            onInput={(event: any) =>
              updateTradeField("selectedWallet", event.currentTarget.value)
            }
          >
            <option value="">Select trade wallet…</option>

            {state.wallets.map((wallet) => {
              const value = wallet.address ?? "";

              return (
                <option key={`top:${value}`} value={value}>
                  {walletLabel(wallet)}
                </option>
              );
            })}
          </select>
        </label>
      </section>

      <section className="terminal-filter-panel">
        <div className="terminal-filter-row terminal-filter-row-primary">
          <RangeFilter
            label="Current MCAP"
            unit="$"
            minimumField="minMarketCapUsd"
            maximumField="maxMarketCapUsd"
            minimum={state.minMarketCapUsd}
            maximum={state.maxMarketCapUsd}
            step="500"
          />

          <RangeFilter
            label="Token age"
            unit="min"
            minimumField="minAgeMinutes"
            maximumField="maxAgeMinutes"
            minimum={state.minAgeMinutes}
            maximum={state.maxAgeMinutes}
            step="1"
          />

          <label className="terminal-window-filter">
            <span>Activity window</span>

            <select
              value={state.filterWindow}
              onInput={(event: any) =>
                setFilterWindow(event.currentTarget.value)
              }
            >
              <option value="1m">1 minute</option>

              <option value="5m">5 minutes</option>

              <option value="15m">15 minutes</option>
            </select>
          </label>
        </div>

        <div className="terminal-filter-row terminal-filter-row-activity">
          <RangeFilter
            label={`Volume ${state.filterWindow}`}
            unit="SOL"
            minimumField="minVolumeSol"
            maximumField="maxVolumeSol"
            minimum={state.minVolumeSol}
            maximum={state.maxVolumeSol}
            step="0.1"
          />

          <RangeFilter
            label={`SMA ${state.filterWindow}`}
            unit="$"
            minimumField="minSmaUsd"
            maximumField="maxSmaUsd"
            minimum={state.minSmaUsd}
            maximum={state.maxSmaUsd}
            step="500"
          />

          <RangeFilter
            label={`TRX ${state.filterWindow}`}
            minimumField="minTrades"
            maximumField="maxTrades"
            minimum={state.minTrades}
            maximum={state.maxTrades}
            step="1"
          />

          <RangeFilter
            label="Holders now"
            minimumField="minHolders"
            maximumField="maxHolders"
            minimum={state.minHolders}
            maximum={state.maxHolders}
            step="1"
          />

          <button
            type="button"
            className="secondary compact terminal-clear-filters"
            onClick={clearRangeFilters}
          >
            Reset ranges
          </button>
        </div>
      </section>

      {(state.health as AnyRow | null)?.status !== "ok" ? (
        <section className="terminal-health">
          <b>System {(state.health as AnyRow | null)?.status ?? "checking"}</b>

          {(state.health as AnyRow | null)?.indexerError ? (
            <span className="pill bad">
              {(state.health as AnyRow).indexerError}
            </span>
          ) : null}

          <a className="secondary compact button" href="/system">
            Open system status and logs
          </a>
        </section>
      ) : null}

      <section className="terminal-table-card">
        {state.pendingRows ? (
          <button
            type="button"
            className="terminal-feed-update"
            onClick={revealPendingRows}
          >
            {state.pendingNewRows > 0
              ? `${state.pendingNewRows} new ${state.pendingNewRows === 1 ? "token" : "tokens"}`
              : "Latest order ready"}
            {" · "}
            show latest
          </button>
        ) : null}

        <div
          className="terminal-table-scroll"
          onScroll={(event: any) => handleTableScroll(event.currentTarget)}
        >
          <table className="terminal-table terminal-market-table">
            <thead>
              <tr>
                <th>
                  <HeaderHelp
                    label="Token"
                    help="Token image, symbol, and name. The search box matches symbol, mint, creator, quote asset, and source."
                  />
                </th>

                <th>
                  <MarketCapSortHeader />
                </th>

                <th>
                  <WindowSortHeader label="VOL" prefix="volume" />
                </th>

                <th>
                  <WindowSortHeader label="SMA" prefix="sma" />
                </th>

                <th>
                  <WindowSortHeader label="TRX" prefix="trades" />
                </th>

                <th>
                  <HolderSortHeader />
                </th>

                <th>
                  <MintTimeSortHeader />
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <TokenRow
                  key={rowKey(row)}
                  row={row}
                  selected={selected ? rowKey(row) === rowKey(selected) : false}
                />
              ))}
            </tbody>
          </table>
          {!rows.length ? (
            <div className="terminal-empty">
              No rows in the live window yet. The route no longer full-scans
              history during polling.
            </div>
          ) : null}
        </div>
      </section>

      <SelectedToken row={selected} />
      <LogsPanel />
      <ErrorDock />
    </div>
  );
}

export default function mount() {
  unmounted = false;
  state.logs = getClientMeasureEntries();
  unsubscribeLogs = subscribeClientMeasure(() => {
    state.logs = getClientMeasureEntries();

    if (logRefreshTimer != null) {
      return;
    }

    logRefreshTimer = setTimeout(() => {
      logRefreshTimer = null;

      rerender();
    }, 250);
  });
  terminalUiMeasure.measureSync(
    {
      start: () => `mount path=${window.location.pathname}`,

      end: () => ({
        mounted: true,
      }),

      catch: summarizeError,
    },
    () => ({
      mounted: true,
    }),
  );
  rerender();
  void loadWallets();

  startPollWatchdog();

  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      void reloadFeed({
        includeHealth: true,

        scheduleNext: true,
      });
    }
  };

  document.addEventListener("visibilitychange", onVisibility);

  void reloadFeed({
    includeHealth: true,
    scheduleNext: true,
  });

  return () => {
    terminalUiMeasure.measureSync(
      {
        start: () => `unmount path=${window.location.pathname}`,

        end: () => ({
          mounted: false,
        }),

        catch: summarizeError,
      },
      () => ({
        mounted: false,
      }),
    );
    unmounted = true;

    if (renderFrame != null) {
      cancelAnimationFrame(renderFrame);

      renderFrame = null;
    }

    renderPending = false;

    clearPollTimer();
    stopPollWatchdog();

    document.removeEventListener("visibilitychange", onVisibility);

    pollInFlight = false;
    unsubscribeLogs?.();
    unsubscribeLogs = null;

    if (logRefreshTimer != null) {
      clearTimeout(logRefreshTimer);

      logRefreshTimer = null;
    }
  };
}
