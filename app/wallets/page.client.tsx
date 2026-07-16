import "./page.css";
import { render } from "tradjs/client";

type AnyRow = Record<string, any>;
type SideFilter = "all" | "buy" | "sell" | "swap" | "unknown";
type Horizon = "1h" | "24h" | "7d" | "all";

type WalletRow = {
  address: string;
  label?: string | null;
  enabled?: number | boolean | null;
  backfillEnabled?: number | boolean | null;
  lastBackfillAtMs?: number | null;
  lastSeenSlot?: number | null;
  tradeCount?: number | null;
  buyCount?: number | null;
  sellCount?: number | null;
  swapCount?: number | null;
  copyableTrades?: number | null;
  uniqueTokens?: number | null;
  lastTradeAtMs?: number | null;
  [key: string]: any;
};

type TokenSummary = {
  mint: string;
  symbol?: string | null;
  name?: string | null;
  image?: string | null;
  priceUsd?: number | null;
  marketCapUsd?: number | null;
};

type SwapRow = {
  eventKey: string;
  wallet: string;
  signature: string;
  slot?: number | null;
  inputMint: string;
  inputAmountUi?: number | null;
  outputMint: string;
  outputAmountUi?: number | null;
  subjectMint: string;
  quoteMint?: string | null;
  side?: "buy" | "sell" | "swap" | "unknown" | null;
  venue?: string | null;
  parser?: string | null;
  classificationConfidence?: "exact" | "inferred" | "ambiguous" | null;
  copyable?: number | boolean | null;
  priceUsd?: number | null;
  marketCapUsd?: number | null;
  tradedAtMs?: number | null;
  token?: TokenSummary | null;
  [key: string]: any;
};

type PositionRow = {
  wallet: string;
  mint: string;
  token?: TokenSummary | null;
  quoteMint?: string | null;
  netTokenUi?: number | null;
  boughtTokenUi?: number | null;
  soldTokenUi?: number | null;
  spentQuoteUi?: number | null;
  receivedQuoteUi?: number | null;
  tradeCount?: number | null;
  copyableTrades?: number | null;
  lastSide?: string | null;
  lastTradeAtMs?: number | null;
  lastPriceUsd?: number | null;
  estimatedValueUsd?: number | null;
  [key: string]: any;
};

type TrackerPayload = {
  wallets?: WalletRow[];
  swaps?: SwapRow[];
  positions?: PositionRow[];
  worker?: AnyRow | null;
  transactionStats?: {
    total?: number;
    parsed?: number;
    ignored?: number;
    errors?: number;
    latestAtMs?: number | null;
  };
  stats?: {
    trackedWallets?: number;
    activeWallets?: number;
    pausedWallets?: number;
    displayedTrades?: number;
    portfolioTrades?: number;
    copyableTrades?: number;
    uniqueTokens?: number;
  };
  generatedAtMs?: number | null;
};

type WalletDraft = {
  address: string;
  label: string;
  enabled: boolean;
  backfillEnabled: boolean;
};

type PageState = {
  payload: TrackerPayload;
  loading: boolean;
  refreshing: boolean;
  saving: boolean;
  actionAddress: string | null;
  error: string | null;
  notice: string | null;
  editorOpen: boolean;
  editingAddress: string | null;
  selectedWallet: string;
  side: SideFilter;
  horizon: Horizon;
  search: string;
  showClosedPositions: boolean;
  lastLoadedAtMs: number | null;
};

const POLL_VISIBLE_MS = 4_000;
const POLL_HIDDEN_MS = 15_000;
const SELECTED_WALLET_KEY = "solard:wallet-tracker:selected-wallet";
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const state: PageState = {
  payload: {
    wallets: [],
    swaps: [],
    positions: [],
    transactionStats: {},
    stats: {},
  },
  loading: true,
  refreshing: false,
  saving: false,
  actionAddress: null,
  error: null,
  notice: null,
  editorOpen: false,
  editingAddress: null,
  selectedWallet: "",
  side: "all",
  horizon: "24h",
  search: "",
  showClosedPositions: false,
  lastLoadedAtMs: null,
};

let draft: WalletDraft = {
  address: "",
  label: "",
  enabled: true,
  backfillEnabled: true,
};

let unmounted = false;
let renderFrame: number | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let requestActive = false;

function rootElement(): HTMLElement {
  const root = document.getElementById("app-root");
  if (!root) throw new Error("Missing #app-root.");
  return root;
}

function updateActiveNavigation(): void {
  document
    .querySelectorAll<HTMLAnchorElement>("#main-nav a")
    .forEach((link) =>
      link.classList.toggle("active", link.dataset.page === "wallets"),
    );
}

function rerender(): void {
  if (unmounted || renderFrame != null) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;
    render(<WalletTrackerPage />, rootElement(), { reconciler: "sequential" });
    updateActiveNavigation();
  });
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem("solwal:web-token") ?? "";
  return token ? { "x-solwal-web-token": token } : {};
}

function apiErrorMessage(payload: any, status: number): string {
  const raw = payload?.error ?? payload?.message ?? `HTTP ${status}`;
  if (raw && typeof raw === "object" && "message" in raw) {
    return String((raw as { message: unknown }).message);
  }
  return String(raw);
}

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...authHeaders(),
      ...(options.headers ?? {}),
    },
  });

  const raw = await response.text();
  let payload: any = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { ok: false, error: raw || `HTTP ${response.status}` };
  }

  if (!response.ok || payload?.ok === false) {
    throw new Error(apiErrorMessage(payload, response.status));
  }
  if (payload && Object.prototype.hasOwnProperty.call(payload, "value")) {
    return payload.value as T;
  }
  if (payload && Object.prototype.hasOwnProperty.call(payload, "data")) {
    return payload.data as T;
  }
  return payload as T;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function enabled(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return number(value) > 0;
}

function shortAddress(value: unknown, head = 5, tail = 5): string {
  const valueText = text(value);
  if (valueText.length <= head + tail + 1) return valueText;
  return `${valueText.slice(0, head)}…${valueText.slice(-tail)}`;
}

function formatInteger(value: unknown): string {
  return Math.max(0, Math.trunc(number(value))).toLocaleString();
}

function formatAmount(value: unknown): string {
  const amount = number(value);
  const absolute = Math.abs(amount);
  if (absolute === 0) return "0";
  if (absolute >= 1_000_000) return amount.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (absolute >= 1_000) return amount.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (absolute >= 1) return amount.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return amount.toLocaleString(undefined, { maximumSignificantDigits: 5 });
}

function formatUsd(value: unknown): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  if (Math.abs(amount) >= 1_000_000) {
    return `$${(amount / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}m`;
  }
  if (Math.abs(amount) >= 1_000) {
    return `$${(amount / 1_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}k`;
  }
  return amount.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Math.abs(amount) < 1 ? 4 : 2,
  });
}

function timeAgo(value: unknown): string {
  const atMs = number(value);
  if (atMs <= 0) return "Never";
  const seconds = Math.max(0, Math.floor((Date.now() - atMs) / 1_000));
  if (seconds < 10) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function horizonSinceMs(): number {
  const now = Date.now();
  if (state.horizon === "1h") return now - 60 * 60_000;
  if (state.horizon === "24h") return now - 24 * 60 * 60_000;
  if (state.horizon === "7d") return now - 7 * 24 * 60 * 60_000;
  return 0;
}

function wallets(): WalletRow[] {
  return Array.isArray(state.payload.wallets) ? state.payload.wallets : [];
}

function swaps(): SwapRow[] {
  return Array.isArray(state.payload.swaps) ? state.payload.swaps : [];
}

function positions(): PositionRow[] {
  return Array.isArray(state.payload.positions) ? state.payload.positions : [];
}

function walletByAddress(address: string): WalletRow | null {
  return wallets().find((wallet) => wallet.address === address) ?? null;
}

function walletName(address: string): string {
  const wallet = walletByAddress(address);
  return text(wallet?.label) || shortAddress(address);
}

function tokenLabel(token: TokenSummary | null | undefined, mint: string): string {
  return text(token?.symbol) || text(token?.name) || shortAddress(mint);
}

function tokenSubLabel(token: TokenSummary | null | undefined, mint: string): string {
  const name = text(token?.name);
  const symbol = text(token?.symbol);
  if (name && symbol) return name;
  return shortAddress(mint, 6, 5);
}

function copyValue(value: string): void {
  if (!value) return;
  void navigator.clipboard.writeText(value).then(
    () => {
      state.notice = "Copied to clipboard.";
      state.error = null;
      rerender();
      window.setTimeout(() => {
        if (state.notice === "Copied to clipboard.") {
          state.notice = null;
          rerender();
        }
      }, 1_600);
    },
    (error) => {
      state.error = error instanceof Error ? error.message : String(error);
      rerender();
    },
  );
}

function clearPollTimer(): void {
  if (pollTimer != null) clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePoll(): void {
  clearPollTimer();
  if (unmounted) return;
  pollTimer = setTimeout(
    () => void refresh(false),
    document.visibilityState === "visible" ? POLL_VISIBLE_MS : POLL_HIDDEN_MS,
  );
}

function queryString(): string {
  const params = new URLSearchParams({
    limit: "500",
    positionLimit: "20000",
  });
  if (state.selectedWallet) params.set("wallet", state.selectedWallet);
  if (state.side !== "all") params.set("side", state.side);
  const sinceMs = horizonSinceMs();
  if (sinceMs > 0) params.set("sinceMs", String(sinceMs));
  return params.toString();
}

async function refresh(manual = true): Promise<void> {
  if (unmounted || requestActive) {
    schedulePoll();
    return;
  }

  requestActive = true;
  if (state.lastLoadedAtMs == null) state.loading = true;
  else if (manual) state.refreshing = true;
  rerender();

  try {
    const payload = await api<TrackerPayload>(
      `/api/wallet-tracker?${queryString()}`,
    );
    state.payload = {
      wallets: Array.isArray(payload.wallets) ? payload.wallets : [],
      swaps: Array.isArray(payload.swaps) ? payload.swaps : [],
      positions: Array.isArray(payload.positions) ? payload.positions : [],
      worker: payload.worker ?? null,
      transactionStats: payload.transactionStats ?? {},
      stats: payload.stats ?? {},
      generatedAtMs: payload.generatedAtMs ?? Date.now(),
    };
    state.lastLoadedAtMs = Date.now();
    state.error = null;

    if (
      state.selectedWallet &&
      !walletByAddress(state.selectedWallet)
    ) {
      state.selectedWallet = "";
      localStorage.removeItem(SELECTED_WALLET_KEY);
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    requestActive = false;
    state.loading = false;
    state.refreshing = false;
    rerender();
    schedulePoll();
  }
}

function resetDraft(): void {
  draft = {
    address: "",
    label: "",
    enabled: true,
    backfillEnabled: true,
  };
  state.editingAddress = null;
}

function openNewWallet(): void {
  resetDraft();
  state.editorOpen = true;
  state.error = null;
  state.notice = null;
  rerender();
}

function editWallet(wallet: WalletRow): void {
  draft = {
    address: wallet.address,
    label: text(wallet.label),
    enabled: enabled(wallet.enabled),
    backfillEnabled: enabled(wallet.backfillEnabled),
  };
  state.editingAddress = wallet.address;
  state.editorOpen = true;
  state.error = null;
  state.notice = null;
  rerender();
}

function closeEditor(): void {
  state.editorOpen = false;
  resetDraft();
  rerender();
}

function updateDraft(patch: Partial<WalletDraft>): void {
  draft = { ...draft, ...patch };
  state.error = null;
  rerender();
}

function validateDraft(): void {
  if (!BASE58_ADDRESS.test(text(draft.address))) {
    throw new Error("Enter a valid Solana wallet address.");
  }
}

async function saveWallet(): Promise<void> {
  if (state.saving) return;
  state.saving = true;
  state.error = null;
  state.notice = null;
  rerender();

  try {
    validateDraft();
    await api<WalletRow>("/api/wallet-tracker", {
      method: state.editingAddress ? "PATCH" : "POST",
      body: JSON.stringify({
        address: text(draft.address),
        label: text(draft.label) || null,
        enabled: draft.enabled,
        backfillEnabled: draft.backfillEnabled,
      }),
    });
    state.notice = state.editingAddress
      ? "Wallet settings updated."
      : "Wallet added to the tracker.";
    state.editorOpen = false;
    resetDraft();
    await refresh(false);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.saving = false;
    rerender();
  }
}

async function setWalletEnabled(wallet: WalletRow, nextEnabled: boolean): Promise<void> {
  if (state.actionAddress) return;
  state.actionAddress = wallet.address;
  state.error = null;
  state.notice = null;
  rerender();

  try {
    await api<WalletRow>("/api/wallet-tracker", {
      method: "PATCH",
      body: JSON.stringify({
        address: wallet.address,
        enabled: nextEnabled,
      }),
    });
    state.notice = nextEnabled
      ? `${walletName(wallet.address)} is being tracked.`
      : `${walletName(wallet.address)} is paused.`;
    await refresh(false);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.actionAddress = null;
    rerender();
  }
}

async function reindexWallet(wallet: WalletRow): Promise<void> {
  if (state.actionAddress) return;
  state.actionAddress = wallet.address;
  state.error = null;
  state.notice = null;
  rerender();

  try {
    await api<WalletRow>("/api/wallet-tracker", {
      method: "PATCH",
      body: JSON.stringify({
        action: "reindex",
        address: wallet.address,
      }),
    });
    state.notice = `${walletName(wallet.address)} was queued for a fresh backfill.`;
    await refresh(false);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.actionAddress = null;
    rerender();
  }
}

function selectWallet(address: string): void {
  state.selectedWallet = address;
  if (address) localStorage.setItem(SELECTED_WALLET_KEY, address);
  else localStorage.removeItem(SELECTED_WALLET_KEY);
  void refresh(true);
}

function setSide(value: SideFilter): void {
  state.side = value;
  void refresh(true);
}

function setHorizon(value: Horizon): void {
  state.horizon = value;
  void refresh(true);
}

function workerHealth(): {
  label: string;
  phase: "ok" | "warn" | "bad";
  detail: string;
} {
  const worker = state.payload.worker;
  if (!worker) {
    return {
      label: "Worker unknown",
      phase: "warn",
      detail: "No wallet-indexer heartbeat found",
    };
  }
  const heartbeat = number(worker.heartbeatAtMs ?? worker.updatedAtMs);
  const ageMs = heartbeat > 0 ? Date.now() - heartbeat : Number.POSITIVE_INFINITY;
  const status = text(worker.status).toLowerCase();
  if ((status === "ok" || status === "running") && ageMs < 30_000) {
    return {
      label: "Indexer live",
      phase: "ok",
      detail: `Heartbeat ${timeAgo(heartbeat)}`,
    };
  }
  if (ageMs < 90_000 && status !== "error") {
    return {
      label: text(worker.status) || "Indexer delayed",
      phase: "warn",
      detail: `Heartbeat ${timeAgo(heartbeat)}`,
    };
  }
  return {
    label: text(worker.status) || "Indexer offline",
    phase: "bad",
    detail: heartbeat > 0 ? `Last heartbeat ${timeAgo(heartbeat)}` : "No heartbeat",
  };
}

function filteredSwaps(): SwapRow[] {
  const query = text(state.search).toLowerCase();
  if (!query) return swaps();
  return swaps().filter((swap) => {
    const token = swap.token;
    return [
      swap.wallet,
      walletName(swap.wallet),
      swap.subjectMint,
      token?.symbol,
      token?.name,
      swap.signature,
      swap.venue,
      swap.side,
    ]
      .map((value) => text(value).toLowerCase())
      .some((value) => value.includes(query));
  });
}

function filteredPositions(): PositionRow[] {
  const query = text(state.search).toLowerCase();
  return positions().filter((position) => {
    if (!state.showClosedPositions && number(position.netTokenUi) <= 0) return false;
    if (!query) return true;
    return [
      position.wallet,
      walletName(position.wallet),
      position.mint,
      position.token?.symbol,
      position.token?.name,
    ]
      .map((value) => text(value).toLowerCase())
      .some((value) => value.includes(query));
  });
}

function TokenIdentity({ token, mint }: { token?: TokenSummary | null; mint: string }) {
  const label = tokenLabel(token, mint);
  return (
    <div className="tracker-token-identity">
      {text(token?.image) ? (
        <img src={text(token?.image)} alt="" loading="lazy" />
      ) : (
        <span className="tracker-token-fallback" aria-hidden="true">
          {label.slice(0, 1).toUpperCase() || "?"}
        </span>
      )}
      <div>
        <b>{label}</b>
        <button
          type="button"
          className="tracker-copy-link code"
          title={mint}
          onClick={() => copyValue(mint)}
        >
          {tokenSubLabel(token, mint)}
        </button>
      </div>
    </div>
  );
}

function TrackerHero() {
  const health = workerHealth();
  return (
    <section className="tracker-hero">
      <div>
        <span className="section-kicker">Wallet intelligence</span>
        <h2>Tracked wallets</h2>
        <p>
          Subscribe to selected wallets, record their buys and sells, and build a
          clean activity history before enabling copy-trade policies.
        </p>
      </div>
      <div className="tracker-hero-actions">
        <div className={`tracker-worker ${health.phase}`}>
          <span className="tracker-status-dot" />
          <div>
            <b>{health.label}</b>
            <small>{health.detail}</small>
          </div>
        </div>
        <a className="button-link secondary" href="/copy">
          Copy trading
        </a>
        <button
          type="button"
          className="secondary"
          disabled={state.refreshing}
          onClick={() => void refresh(true)}
        >
          {state.refreshing ? "Refreshing…" : "Refresh"}
        </button>
        <button type="button" className="primary-large" onClick={openNewWallet}>
          Add wallet
        </button>
      </div>
    </section>
  );
}

function StatsGrid() {
  const stats = state.payload.stats ?? {};
  const items = [
    {
      label: "Active wallets",
      value: formatInteger(stats.activeWallets),
      detail: `${formatInteger(stats.pausedWallets)} paused`,
    },
    {
      label: "Observed trades",
      value: formatInteger(stats.portfolioTrades),
      detail: `${formatInteger(stats.displayedTrades)} in current view`,
    },
    {
      label: "Tokens touched",
      value: formatInteger(stats.uniqueTokens),
      detail: "Across selected history",
    },
    {
      label: "Copyable events",
      value: formatInteger(stats.copyableTrades),
      detail: "Exact supported parsers",
    },
    {
      label: "Transactions scanned",
      value: formatInteger(state.payload.transactionStats?.total),
      detail: `${formatInteger(state.payload.transactionStats?.ignored)} ignored · ${formatInteger(state.payload.transactionStats?.errors)} errors`,
    },
  ];

  return (
    <section className="tracker-stats-grid" aria-label="Wallet tracker summary">
      {items.map((item) => (
        <article key={item.label} className="tracker-stat-card">
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          <small>{item.detail}</small>
        </article>
      ))}
    </section>
  );
}

function WalletCard({ wallet }: { wallet: WalletRow; key?: string }) {
  const active = enabled(wallet.enabled);
  const acting = state.actionAddress === wallet.address;
  const selected = state.selectedWallet === wallet.address;
  return (
    <article className={`tracker-wallet-card ${selected ? "selected" : ""}`}>
      <header>
        <button
          type="button"
          className="tracker-wallet-primary"
          onClick={() => selectWallet(selected ? "" : wallet.address)}
        >
          <span className={`tracker-wallet-avatar ${active ? "active" : "paused"}`}>
            {(text(wallet.label) || wallet.address).slice(0, 1).toUpperCase()}
          </span>
          <span>
            <b>{text(wallet.label) || "Unnamed wallet"}</b>
            <small className="code">{shortAddress(wallet.address, 7, 7)}</small>
          </span>
        </button>
        <span className={`pill ${active ? "ok" : "warn"}`}>
          {active ? "Tracking" : "Paused"}
        </span>
      </header>

      <div className="tracker-wallet-metrics">
        <span>
          <b>{formatInteger(wallet.tradeCount)}</b>
          <small>Trades</small>
        </span>
        <span>
          <b>{formatInteger(wallet.uniqueTokens)}</b>
          <small>Tokens</small>
        </span>
        <span>
          <b>{formatInteger(wallet.copyableTrades)}</b>
          <small>Copyable</small>
        </span>
      </div>

      <div className="tracker-wallet-flow">
        <span className="buy">{formatInteger(wallet.buyCount)} buys</span>
        <span className="sell">{formatInteger(wallet.sellCount)} sells</span>
        {number(wallet.swapCount) > 0 ? (
          <span>{formatInteger(wallet.swapCount)} swaps</span>
        ) : null}
      </div>

      <dl>
        <div>
          <dt>Last trade</dt>
          <dd>{timeAgo(wallet.lastTradeAtMs)}</dd>
        </div>
        <div>
          <dt>Backfill</dt>
          <dd>
            {enabled(wallet.backfillEnabled)
              ? wallet.lastBackfillAtMs
                ? timeAgo(wallet.lastBackfillAtMs)
                : "Queued"
              : "Disabled"}
          </dd>
        </div>
      </dl>

      <footer>
        <a
          className="button-link secondary compact"
          href={`/copy?leader=${encodeURIComponent(wallet.address)}`}
        >
          Copy strategy
        </a>
        <button
          type="button"
          className="secondary compact"
          onClick={() => copyValue(wallet.address)}
        >
          Copy address
        </button>
        <button
          type="button"
          className="secondary compact"
          disabled={acting}
          onClick={() => void reindexWallet(wallet)}
        >
          {acting ? "Queueing…" : "Reindex"}
        </button>
        <button
          type="button"
          className="secondary compact"
          onClick={() => editWallet(wallet)}
        >
          Edit
        </button>
        <button
          type="button"
          className={`compact ${active ? "secondary" : "primary"}`}
          disabled={acting}
          onClick={() => void setWalletEnabled(wallet, !active)}
        >
          {acting ? "Saving…" : active ? "Pause" : "Resume"}
        </button>
      </footer>
    </article>
  );
}

function WalletList() {
  const rows = wallets();
  return (
    <section className="tracker-panel tracker-wallets-panel">
      <header className="tracker-section-head">
        <div>
          <span className="tracker-step">01</span>
          <h3>Wallets</h3>
          <p>Select a wallet to filter its activity and positions.</p>
        </div>
        <span className="muted small">{rows.length} configured</span>
      </header>

      {rows.length ? (
        <div className="tracker-wallet-list">
          {rows.map((wallet) => (
            <WalletCard key={wallet.address} wallet={wallet} />
          ))}
        </div>
      ) : (
        <button type="button" className="tracker-empty" onClick={openNewWallet}>
          <b>No tracked wallets</b>
          <span>Add a Solana address to begin listening for trades.</span>
        </button>
      )}
    </section>
  );
}

function WalletEditor() {
  return (
    <section className={`tracker-panel tracker-editor ${state.editorOpen ? "open" : ""}`}>
      <header className="tracker-section-head">
        <div>
          <span className="tracker-step">02</span>
          <h3>{state.editingAddress ? "Edit wallet" : "Add wallet"}</h3>
          <p>Labels are local. Only public wallet addresses are required.</p>
        </div>
        {state.editorOpen ? (
          <button type="button" className="secondary compact" onClick={closeEditor}>
            Close
          </button>
        ) : null}
      </header>

      {state.editorOpen ? (
        <form
          className="tracker-wallet-form"
          onSubmit={(event: any) => {
            event.preventDefault();
            void saveWallet();
          }}
        >
          <label>
            <span>Wallet address</span>
            <input
              required
              className="code"
              autoComplete="off"
              readOnly={Boolean(state.editingAddress)}
              placeholder="Solana public key"
              value={draft.address}
              onInput={(event: any) =>
                updateDraft({ address: event.currentTarget.value })
              }
            />
          </label>
          <label>
            <span>Label</span>
            <input
              maxLength={80}
              placeholder="Smart money, Dev wallet, Whale…"
              value={draft.label}
              onInput={(event: any) =>
                updateDraft({ label: event.currentTarget.value })
              }
            />
          </label>

          <div className="tracker-toggle-list">
            <label className="tracker-toggle-row">
              <span>
                <b>Realtime tracking</b>
                <small>Subscribe to new transactions for this address.</small>
              </span>
              <input
                type="checkbox"
                checked={draft.enabled}
                onInput={(event: any) =>
                  updateDraft({ enabled: event.currentTarget.checked })
                }
              />
            </label>
            <label className="tracker-toggle-row">
              <span>
                <b>Historical backfill</b>
                <small>Recover recent trades and repair websocket gaps.</small>
              </span>
              <input
                type="checkbox"
                checked={draft.backfillEnabled}
                onInput={(event: any) =>
                  updateDraft({ backfillEnabled: event.currentTarget.checked })
                }
              />
            </label>
          </div>

          <div className="tracker-editor-note" role="note">
            <b>Observation only</b>
            <span>
              Adding a wallet does not grant signing access and cannot execute a
              trade. Copy-trade policies remain a separate opt-in worker.
            </span>
          </div>

          <footer>
            <button type="button" className="secondary" onClick={closeEditor}>
              Cancel
            </button>
            <button type="submit" className="primary-large" disabled={state.saving}>
              {state.saving
                ? "Saving…"
                : state.editingAddress
                  ? "Save changes"
                  : "Start tracking"}
            </button>
          </footer>
        </form>
      ) : (
        <button type="button" className="tracker-empty editor" onClick={openNewWallet}>
          <b>Add another wallet</b>
          <span>Track any public Solana address without importing a keypair.</span>
        </button>
      )}
    </section>
  );
}

function FilterBar() {
  return (
    <section className="tracker-filter-bar">
      <label>
        <span>Wallet</span>
        <select
          value={state.selectedWallet}
          onInput={(event: any) => selectWallet(event.currentTarget.value)}
        >
          <option value="">All tracked wallets</option>
          {wallets().map((wallet) => (
            <option key={wallet.address} value={wallet.address}>
              {text(wallet.label) || shortAddress(wallet.address)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Side</span>
        <select
          value={state.side}
          onInput={(event: any) => setSide(event.currentTarget.value as SideFilter)}
        >
          <option value="all">All activity</option>
          <option value="buy">Buys</option>
          <option value="sell">Sells</option>
          <option value="swap">Token swaps</option>
          <option value="unknown">Unclassified</option>
        </select>
      </label>
      <label>
        <span>Window</span>
        <select
          value={state.horizon}
          onInput={(event: any) => setHorizon(event.currentTarget.value as Horizon)}
        >
          <option value="1h">Last hour</option>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="all">All indexed</option>
        </select>
      </label>
      <label className="tracker-search-field">
        <span>Search</span>
        <input
          type="search"
          placeholder="Token, mint, wallet, signature…"
          value={state.search}
          onInput={(event: any) => {
            state.search = event.currentTarget.value;
            rerender();
          }}
        />
      </label>
    </section>
  );
}

function ActivityRow({ swap }: { swap: SwapRow; key?: string }) {
  const side = text(swap.side) || "unknown";
  const isBuy = side === "buy";
  const tokenAmount = isBuy
    ? swap.outputMint === swap.subjectMint
      ? swap.outputAmountUi
      : swap.inputAmountUi
    : swap.inputMint === swap.subjectMint
      ? swap.inputAmountUi
      : swap.outputAmountUi;
  const quoteAmount = isBuy ? swap.inputAmountUi : swap.outputAmountUi;

  return (
    <article className="tracker-activity-row">
      <div className="tracker-activity-main">
        <span className={`tracker-side ${side}`}>{side}</span>
        <TokenIdentity token={swap.token} mint={swap.subjectMint} />
      </div>
      <div className="tracker-activity-amount">
        <b>{formatAmount(tokenAmount)}</b>
        <small>{swap.quoteMint ? `${formatAmount(quoteAmount)} quote` : "Quote unavailable"}</small>
      </div>
      <div className="tracker-activity-price">
        <b>{formatUsd(swap.priceUsd ?? swap.token?.priceUsd)}</b>
        <small>{formatUsd(swap.marketCapUsd ?? swap.token?.marketCapUsd)} mcap</small>
      </div>
      <div className="tracker-activity-wallet">
        <b>{walletName(swap.wallet)}</b>
        <button
          type="button"
          className="tracker-copy-link code"
          onClick={() => copyValue(swap.wallet)}
        >
          {shortAddress(swap.wallet)}
        </button>
      </div>
      <div className="tracker-activity-meta">
        <b>{text(swap.venue) || "unknown"}</b>
        <small>
          {text(swap.classificationConfidence) || "ambiguous"}
          {enabled(swap.copyable) ? " · copyable" : ""}
        </small>
      </div>
      <div className="tracker-activity-time">
        <b>{timeAgo(swap.tradedAtMs)}</b>
        <a
          href={`https://solscan.io/tx/${encodeURIComponent(swap.signature)}`}
          target="_blank"
          rel="noreferrer"
          className="code"
        >
          {shortAddress(swap.signature, 5, 5)}
        </a>
      </div>
    </article>
  );
}

function ActivityPanel() {
  const rows = filteredSwaps();
  return (
    <section className="tracker-panel tracker-activity-panel">
      <header className="tracker-section-head">
        <div>
          <span className="tracker-step">03</span>
          <h3>Trade activity</h3>
          <p>Normalized wallet swaps with parser confidence and copyability.</p>
        </div>
        <span className="muted small">{rows.length} shown</span>
      </header>

      {rows.length ? (
        <div className="tracker-activity-list">
          <div className="tracker-activity-labels" aria-hidden="true">
            <span>Trade</span>
            <span>Amount</span>
            <span>Price</span>
            <span>Wallet</span>
            <span>Source</span>
            <span>Time</span>
          </div>
          {rows.map((swap) => (
            <ActivityRow key={swap.eventKey} swap={swap} />
          ))}
        </div>
      ) : (
        <div className="tracker-empty static">
          <b>No trades match these filters</b>
          <span>The indexer will populate this list as watched wallets trade.</span>
        </div>
      )}
    </section>
  );
}

function PositionRowView({ position }: { position: PositionRow; key?: string }) {
  const open = number(position.netTokenUi) > 0;
  return (
    <article className="tracker-position-row">
      <TokenIdentity token={position.token} mint={position.mint} />
      <div>
        <span>Net tokens</span>
        <b>{formatAmount(position.netTokenUi)}</b>
      </div>
      <div>
        <span>Estimated value</span>
        <b>{formatUsd(position.estimatedValueUsd)}</b>
      </div>
      <div>
        <span>Flow</span>
        <b>
          <i className="buy">+{formatAmount(position.boughtTokenUi)}</i>
          <i className="sell">−{formatAmount(position.soldTokenUi)}</i>
        </b>
      </div>
      <div>
        <span>Trades</span>
        <b>{formatInteger(position.tradeCount)}</b>
      </div>
      <div className="tracker-position-end">
        <span className={`pill ${open ? "ok" : "neutral"}`}>
          {open ? "Open" : "Closed"}
        </span>
        <small>{timeAgo(position.lastTradeAtMs)}</small>
      </div>
    </article>
  );
}

function PositionsPanel() {
  const rows = filteredPositions();
  return (
    <section className="tracker-panel tracker-positions-panel">
      <header className="tracker-section-head">
        <div>
          <span className="tracker-step">04</span>
          <h3>Observed positions</h3>
          <p>Position estimates derived only from recorded wallet swaps.</p>
        </div>
        <label className="tracker-inline-check">
          <input
            type="checkbox"
            checked={state.showClosedPositions}
            onInput={(event: any) => {
              state.showClosedPositions = event.currentTarget.checked;
              rerender();
            }}
          />
          <span>Show closed</span>
        </label>
      </header>

      <div className="tracker-position-disclaimer" role="note">
        Transfers, deposits, and trades before the configured backfill window can
        make these balances differ from the wallet’s actual on-chain holdings.
      </div>

      {rows.length ? (
        <div className="tracker-position-list">
          {rows.map((position) => (
            <PositionRowView
              key={`${position.wallet}:${position.mint}`}
              position={position}
            />
          ))}
        </div>
      ) : (
        <div className="tracker-empty static compact-empty">
          <b>No observed open positions</b>
          <span>Enable “Show closed” to include fully sold tokens.</span>
        </div>
      )}
    </section>
  );
}

function PageMessages() {
  if (!state.error && !state.notice) return null;
  return (
    <section
      className={`tracker-page-message ${state.error ? "bad" : "ok"}`}
      role={state.error ? "alert" : "status"}
    >
      <span>{state.error ?? state.notice}</span>
      <button
        type="button"
        className="secondary compact"
        onClick={() => {
          state.error = null;
          state.notice = null;
          rerender();
        }}
      >
        Dismiss
      </button>
    </section>
  );
}

export function WalletTrackerPage() {
  return (
    <main className="tracker-page-direct">
      <PageMessages />
      <TrackerHero />
      <StatsGrid />
      <div className="tracker-management-grid">
        <WalletList />
        <WalletEditor />
      </div>
      <FilterBar />
      <ActivityPanel />
      <PositionsPanel />
      <footer className="tracker-page-footer">
        <span>
          {state.lastLoadedAtMs
            ? `Updated ${timeAgo(state.lastLoadedAtMs)}`
            : "Waiting for tracker data"}
        </span>
        <span>Automatic refresh every {POLL_VISIBLE_MS / 1_000}s while visible.</span>
      </footer>
    </main>
  );
}

export default function mount() {
  unmounted = false;
  const savedWallet = text(localStorage.getItem(SELECTED_WALLET_KEY));
  if (savedWallet) state.selectedWallet = savedWallet;
  rerender();
  void refresh(false);

  const onVisibility = () => {
    if (document.visibilityState === "visible") void refresh(false);
    else schedulePoll();
  };
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    unmounted = true;
    document.removeEventListener("visibilitychange", onVisibility);
    clearPollTimer();
    if (renderFrame != null) cancelAnimationFrame(renderFrame);
    renderFrame = null;
  };
}
