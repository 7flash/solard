import { render } from "tradjs/client";
import { createClientMeasureScope, summarizeForClient } from "./measure";
import { authHeaders, unwrapApiPayload } from "./api-client";
import { installKeyboardShortcuts } from "./keyboard";
import {
  activePageFromLocation,
  state,
  type AnyRow,
  type BuyPlanRow,
  type Overview,
  type Portfolio,
  type PumpFeedRow,
  type State,
  type TelegramSignalsState,
  type Toast,
  type TokenHolder,
  type TokenWatchGroup,
  type TokenWatchSample,
  type TokenWatchToken,
} from "./state";

export { activePageFromLocation, state } from "./state";
export { authHeaders } from "./api-client";
export type {
  AnyRow,
  BuyPlanRow,
  Overview,
  Portfolio,
  PumpFeedRow,
  State,
  TelegramSignal,
  TelegramSignalSource,
  TelegramSignalsState,
  Toast,
  TokenHolder,
  TokenWatchGroup,
  TokenWatchSample,
  TokenWatchToken,
} from "./state";

const runtimeMeasure = createClientMeasureScope("solard:web");
const toastDedupedAt: Record<string, number> = {};

function clientMeasureEnabled(): boolean {
  try {
    return (
      localStorage.getItem("solard:measure") === "1" ||
      localStorage.getItem("solwal:measure") === "1"
    );
  } catch {
    return false;
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
  return activePageFromLocation();
}

export function pageHref(page: State["tab"]): string {
  if (page === "overview") return "/";
  if (page === "jobs") return "/activity";
  return `/${page}`;
}

export function navigatePage(page: State["tab"]): void {
  window.location.href = pageHref(page);
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
      const response = await fetch(url, {
        ...options,
        headers: {
          "content-type": "application/json",
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
  const terminal = state.tab === "terminal";
  const pinnedParam = state.terminalPinnedMints.length
    ? `&pinnedMints=${encodeURIComponent(state.terminalPinnedMints.join(","))}`
    : "";
  const suffix = terminal
    ? `?terminal=1&sinceMs=${encodeURIComponent(String(state.terminalSessionStartedAtMs ?? Date.now()))}${pinnedParam}`
    : "";
  const live = await api<{
    newTokens: PumpFeedRow[];
    watchGroups: TokenWatchGroup[];
  }>(`/api/pump-live${suffix}`);
  state.watchGroups = live.watchGroups ?? state.watchGroups;
  if (!state.selectedWatchGroupId && state.watchGroups[0])
    state.selectedWatchGroupId = state.watchGroups[0].id;

  if (terminal) {
    const sessionMints = new Set(
      currentSessionRows(state.watchGroups)
        .map((row) => row.mint)
        .filter(Boolean),
    );
    const rows = [
      ...(live.newTokens ?? []),
      ...currentSessionRows(state.watchGroups),
    ];
    const seen = new Set<string>();
    for (const row of rows) {
      const key = pumpRowKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      if (
        shouldHydrateTerminalRow(row) ||
        (!!row.mint && sessionMints.has(row.mint))
      )
        mergePumpToken(row);
    }
    return;
  }

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
    isMayhemMode?: boolean | null;
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
    typeof row.marketCapSol === "number" && Number.isFinite(row.marketCapSol)
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
    lastMarketCapSol: mcap,
    initialMarketCapSol: initial,
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

export async function startPumpFeed(
  options: { reset?: boolean; retry?: number } = {},
): Promise<void> {
  if (!options.retry) {
    state.pumpFeedAbort?.abort();
    if (pumpFeedReconnectTimer) clearTimeout(pumpFeedReconnectTimer);
    pumpFeedReconnectTimer = null;
  }

  const abort = new AbortController();
  const retry = options.retry ?? 0;
  state.pumpFeedAbort = abort;
  state.pumpFeedStatus = retry > 0 ? "reconnecting" : "connecting";
  state.pumpFeedError = null;
  state.terminalSessionStartedAtMs ??= Date.now();

  if (options.reset !== false) {
    // Keep explicitly pinned rows, but clear stale cached DB rows so Terminal
    // behaves like a real-time feed instead of a historical dump.
    state.pumpFeed = state.pumpFeed.filter(
      (row) => row.mint && state.terminalPinnedMints.includes(row.mint),
    );
    followLatestInTerminalInspector();
  }

  update();
  try {
    const reset = options.reset === false ? "0" : "1";
    const response = await fetch(
      `/api/pump-live?stream=1&reset=${reset}&source=${encodeURIComponent(state.pumpFeedSource)}`,
      { headers: authHeaders(), signal: abort.signal },
    );
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error ?? `Pump feed HTTP ${response.status}`);
    }
    state.pumpFeedStatus = "connected";
    state.pumpFeedError = null;
    update();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!abort.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Pump feed stream closed");
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
      const message = error instanceof Error ? error.message : String(error);
      state.pumpFeedError = message;
      state.pumpFeedStatus = "reconnecting";
      const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(retry, 5));
      pushToast(
        "warn",
        retry > 0 ? "Pump feed reconnecting" : "Pump feed disconnected",
        `${message} · retrying in ${Math.round(delayMs / 1000)}s`,
        6000,
      );
      pumpFeedReconnectTimer = setTimeout(() => {
        if (state.tab === "terminal" && state.pumpFeedStatus === "reconnecting")
          void startPumpFeed({ reset: false, retry: retry + 1 });
      }, delayMs);
    }
  } finally {
    if (
      state.pumpFeedAbort === abort &&
      state.pumpFeedStatus !== "reconnecting"
    )
      state.pumpFeedAbort = null;
    update();
  }
}

export function stopPumpFeed(): void {
  if (pumpFeedReconnectTimer) clearTimeout(pumpFeedReconnectTimer);
  pumpFeedReconnectTimer = null;
  state.pumpFeedAbort?.abort();
  state.pumpFeedAbort = null;
  state.pumpFeedStatus = "closed";
  state.terminalSessionStartedAtMs = null;
  void api("/api/pump-live", {
    method: "POST",
    body: JSON.stringify({ action: "stop-worker" }),
  }).catch(() => {});
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
    if (pumpFeedReconnectTimer) clearTimeout(pumpFeedReconnectTimer);
    pumpFeedReconnectTimer = null;
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
let pumpFeedReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let updateQueued = false;

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
  let pageNode: any = null;
  try {
    pageNode = <Page />;
  } catch (error) {
    state.error =
      error instanceof Error
        ? error.message
        : `Render failed: ${String(error)}`;
    pageNode = (
      <div className="card">
        <h3>Render failed</h3>
        <p className="muted">{state.error}</p>
      </div>
    );
  }
  return (
    <>
      {state.error ? (
        <div className="global-error-strip">
          <span className="pill bad">{state.error}</span>
        </div>
      ) : null}
      {pageNode}
      <ToastHost />
    </>
  );
}

function applyActiveNav(): void {
  document
    .querySelectorAll<HTMLAnchorElement>("#main-nav a")
    .forEach((link) => {
      const active = link.dataset.page === state.tab;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
}

function renderRuntime(): void {
  const root = document.getElementById("app-root");
  if (root) render(<ConsoleRuntime />, root);
  applyActiveNav();
}

export function update() {
  if (updateQueued) return;
  updateQueued = true;
  const schedule =
    typeof queueMicrotask === "function"
      ? queueMicrotask
      : (fn: () => void) => window.requestAnimationFrame(fn);
  schedule(() => {
    updateQueued = false;
    renderRuntime();
  });
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

  void runAction(async () => {
    await measureClient("mount-load", async () => {
      // Always load the local wallet/group/token index first. This is SQLite-only
      // and keeps the default wallet dropdown populated on every page.
      await refreshLocalOverview();
      await refreshStatus().catch(() => undefined);

      if (page === "overview")
        await Promise.allSettled([refreshSolBalances(), refreshJobs()]);
      else if (page === "wallets")
        await refreshSolBalances().catch(() => undefined);
      else if (page === "terminal")
        await Promise.allSettled([refreshPumpLive(), refreshWatchGroups()]);
      else if (page === "watchlists")
        await Promise.allSettled([refreshWatchGroups(), refreshPumpLive()]);
      else if (page === "portfolio")
        await refreshPortfolio().catch(() => undefined);
      else if (page === "signals")
        await refreshSignals().catch(() => undefined);
      else if (page === "jobs") await refreshJobs().catch(() => undefined);
      return {
        page,
        wallets: state.overview?.wallets?.length ?? 0,
        groups: state.overview?.groups?.length ?? 0,
      };
    });
  });

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
        if (state.tab === "watchlists" || state.tab === "terminal")
          await refreshPumpLive()
            .then(update)
            .catch(() => undefined);
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

  const removeKeyboardShortcuts = installKeyboardShortcuts({
    getTab: () => state.tab,
    getSelectedTerminalRow: () =>
      state.pumpFeed.find(
        (row) => pumpRowKey(row) === state.terminalInspectorKey,
      ) ??
      state.pumpFeed[0] ??
      null,
    onRefresh: () => {
      void refreshCurrentPage().then(update);
    },
    onPin: (row) => toggleTerminalPinned(row),
    onBuy: (row) => {
      void quickBuyPumpFeedRow(row);
    },
  });

  const cleanup = () =>
    measureClientSync("unmount", () => {
      clearInterval(dataInterval);
      clearInterval(statusInterval);
      removeKeyboardShortcuts();
      if (pumpFeedReconnectTimer) clearTimeout(pumpFeedReconnectTimer);
      pumpFeedReconnectTimer = null;
      state.pumpFeedAbort?.abort();
      state.pumpFeedAbort = null;
      return { page, mountId: state.mountId };
    });
  currentCleanup = cleanup;
  unloadCleanup = cleanup;
  window.addEventListener("beforeunload", cleanup, { once: true });
  return cleanup;
}
