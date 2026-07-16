import "./page.css";
import { render } from "tradjs/client";

type AnyRow = Record<string, any>;
type IntentStatusFilter =
  "all" | "queued" | "paper" | "sending" | "sent" | "skipped" | "failed";
type Horizon = "1h" | "24h" | "7d" | "all";

type TrackedWallet = {
  address: string;
  label?: string | null;
  enabled?: number | boolean | null;
};

type CopyProfile = {
  profileKey: string;
  leaderWallet: string;
  followerRef: string;
  label?: string | null;
  enabled?: number | boolean | null;
  mode?: "paper" | "live";
  copyBuys?: number | boolean | null;
  copySells?: number | boolean | null;
  buySizing?: "fixed" | "leader-ratio";
  fixedBuyAmountUi?: number | null;
  leaderScaleBps?: number | null;
  maxBuyAmountUi?: number | null;
  sellBalanceBps?: number | null;
  slippageBps?: number | null;
  maxEventAgeMs?: number | null;
  minMarketCapUsd?: number | null;
  maxMarketCapUsd?: number | null;
  allowedMintsJson?: string | null;
  blockedMintsJson?: string | null;
  allowedQuoteMintsJson?: string | null;
  intentCount?: number | null;
  paperCount?: number | null;
  sentCount?: number | null;
  skippedCount?: number | null;
  failedCount?: number | null;
  queuedCount?: number | null;
  lastIntentAtMs?: number | null;
  updatedAtMs?: number | null;
  [key: string]: any;
};

type CopyIntent = {
  intentKey: string;
  profileKey: string;
  leaderEventKey: string;
  leaderWallet: string;
  followerRef: string;
  sourceSignature: string;
  sourceSlot?: number | null;
  sourceTradedAtMs?: number | null;
  side?: "buy" | "sell";
  inputMint: string;
  outputMint: string;
  subjectMint: string;
  quoteMint?: string | null;
  amountKind?: "exact-input-ui" | "balance-bps";
  amountUi?: number | null;
  balanceBps?: number | null;
  slippageBps?: number | null;
  mode?: "paper" | "live";
  status?: "queued" | "paper" | "sending" | "sent" | "skipped" | "failed";
  reason?: string | null;
  attempts?: number | null;
  nextAttemptAtMs?: number | null;
  executionSignature?: string | null;
  createdAtMs?: number | null;
  updatedAtMs?: number | null;
  [key: string]: any;
};

type CopyPayload = {
  profiles?: CopyProfile[];
  intents?: CopyIntent[];
  trackedWallets?: TrackedWallet[];
  worker?: AnyRow | null;
  global?: {
    allowLive?: boolean;
    gatewayConfigured?: boolean;
    liveReady?: boolean;
  };
  stats?: {
    profiles?: number;
    enabledProfiles?: number;
    paperProfiles?: number;
    liveProfiles?: number;
    displayedIntents?: number;
    sentIntents?: number;
    failedIntents?: number;
    paperIntents?: number;
  };
  generatedAtMs?: number | null;
};

type OverviewPayload = {
  wallets?: AnyRow[];
};

type ProfileDraft = {
  profileKey: string;
  label: string;
  leaderWallet: string;
  followerRef: string;
  enabled: boolean;
  mode: "paper" | "live";
  copyBuys: boolean;
  copySells: boolean;
  buySizing: "fixed" | "leader-ratio";
  fixedBuyAmountUi: string;
  leaderScalePct: string;
  maxBuyAmountUi: string;
  sellBalancePct: string;
  slippagePct: string;
  maxEventAgeSec: string;
  minMarketCapUsd: string;
  maxMarketCapUsd: string;
  allowedMints: string;
  blockedMints: string;
  allowedQuoteMints: string;
  liveConfirmation: string;
};

type PageState = {
  payload: CopyPayload;
  overview: OverviewPayload;
  loading: boolean;
  refreshing: boolean;
  saving: boolean;
  actionKey: string | null;
  error: string | null;
  notice: string | null;
  editorOpen: boolean;
  editingProfileKey: string | null;
  selectedProfile: string;
  status: IntentStatusFilter;
  horizon: Horizon;
  search: string;
  lastLoadedAtMs: number | null;
};

const POLL_VISIBLE_MS = 4_000;
const POLL_HIDDEN_MS = 15_000;
const SELECTED_PROFILE_KEY = "solard:copy-trading:selected-profile";

const state: PageState = {
  payload: {
    profiles: [],
    intents: [],
    trackedWallets: [],
    stats: {},
    global: {},
  },
  overview: { wallets: [] },
  loading: true,
  refreshing: false,
  saving: false,
  actionKey: null,
  error: null,
  notice: null,
  editorOpen: false,
  editingProfileKey: null,
  selectedProfile: "",
  status: "all",
  horizon: "24h",
  search: "",
  lastLoadedAtMs: null,
};

let draft: ProfileDraft = emptyDraft();
let unmounted = false;
let renderFrame: number | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let requestActive = false;

function emptyDraft(): ProfileDraft {
  return {
    profileKey: "",
    label: "",
    leaderWallet: "",
    followerRef: "",
    enabled: true,
    mode: "paper",
    copyBuys: true,
    copySells: true,
    buySizing: "fixed",
    fixedBuyAmountUi: "0.05",
    leaderScalePct: "100",
    maxBuyAmountUi: "1",
    sellBalancePct: "100",
    slippagePct: "5",
    maxEventAgeSec: "30",
    minMarketCapUsd: "",
    maxMarketCapUsd: "",
    allowedMints: "",
    blockedMints: "",
    allowedQuoteMints: "",
    liveConfirmation: "",
  };
}

function rootElement(): HTMLElement {
  const root = document.getElementById("app-root");
  if (!root) throw new Error("Missing #app-root.");
  return root;
}

function updateActiveNavigation(): void {
  document
    .querySelectorAll<HTMLAnchorElement>("#main-nav a")
    .forEach((link) =>
      link.classList.toggle("active", link.dataset.page === "copy"),
    );
}

function rerender(): void {
  if (unmounted || renderFrame != null) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;
    render(<CopyTradingPage />, rootElement(), { reconciler: "sequential" });
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
  const raw = text(value);
  if (raw.length <= head + tail + 1) return raw;
  return `${raw.slice(0, head)}…${raw.slice(-tail)}`;
}

function formatInteger(value: unknown): string {
  return Math.max(0, Math.trunc(number(value))).toLocaleString();
}

function formatAmount(value: unknown): string {
  const amount = number(value);
  const absolute = Math.abs(amount);
  if (absolute === 0) return "0";
  if (absolute >= 1_000_000) {
    return amount.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  if (absolute >= 1_000) {
    return amount.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (absolute >= 1) {
    return amount.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  return amount.toLocaleString(undefined, { maximumSignificantDigits: 5 });
}

function formatUsd(value: unknown): string {
  if (value == null || value === "") return "Any";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "Any";
  if (Math.abs(amount) >= 1_000_000) {
    return `$${(amount / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}m`;
  }
  if (Math.abs(amount) >= 1_000) {
    return `$${(amount / 1_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}k`;
  }
  return amount.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
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
  return `${Math.floor(hours / 24)}d ago`;
}

function jsonList(value: unknown): string[] {
  try {
    const parsed = JSON.parse(text(value) || "[]");
    return Array.isArray(parsed)
      ? parsed.map((item) => text(item)).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function listText(value: unknown): string {
  return jsonList(value).join("\n");
}

function numberField(
  value: string,
  label: string,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be numeric.`);
  if (parsed < minimum)
    throw new Error(`${label} must be at least ${minimum}.`);
  if (parsed > maximum) throw new Error(`${label} must be at most ${maximum}.`);
  return parsed;
}

function optionalNumber(value: string, label: string): number | null {
  if (!text(value)) return null;
  return numberField(value, label, 0);
}

function profiles(): CopyProfile[] {
  return Array.isArray(state.payload.profiles) ? state.payload.profiles : [];
}

function intents(): CopyIntent[] {
  return Array.isArray(state.payload.intents) ? state.payload.intents : [];
}

function trackedWallets(): TrackedWallet[] {
  return Array.isArray(state.payload.trackedWallets)
    ? state.payload.trackedWallets
    : [];
}

function managedWallets(): AnyRow[] {
  return Array.isArray(state.overview.wallets) ? state.overview.wallets : [];
}

function walletAddress(wallet: AnyRow): string {
  const nested = wallet.wallet;
  const account = wallet.account;
  return text(
    [
      wallet.address,
      wallet.walletAddress,
      wallet.publicKey,
      wallet.pubkey,
      typeof nested === "string" ? nested : null,
      nested?.address,
      nested?.walletAddress,
      nested?.publicKey,
      nested?.pubkey,
      account?.address,
      account?.publicKey,
      account?.pubkey,
    ].find((value) => text(value)),
  );
}

function walletLabel(wallet: AnyRow): string {
  const address = walletAddress(wallet);
  const name = text(wallet.name ?? wallet.walletName ?? wallet.wallet?.name);
  return name ? `${name} — ${shortAddress(address)}` : address;
}

function leaderLabel(address: string): string {
  const wallet = trackedWallets().find((row) => row.address === address);
  return text(wallet?.label) || shortAddress(address);
}

function profileLabel(profile: CopyProfile): string {
  return text(profile.label) || `${leaderLabel(profile.leaderWallet)} copy`;
}

function profileByKey(key: string): CopyProfile | null {
  return profiles().find((profile) => profile.profileKey === key) ?? null;
}

function workerAlive(): boolean {
  const worker = state.payload.worker;
  if (!worker) return false;
  const heartbeat = number(worker.heartbeatAtMs);
  return heartbeat > 0 && Date.now() - heartbeat < 30_000;
}

function globalLiveReady(): boolean {
  return state.payload.global?.liveReady === true;
}

function horizonSinceMs(): number {
  const now = Date.now();
  if (state.horizon === "1h") return now - 60 * 60_000;
  if (state.horizon === "24h") return now - 24 * 60 * 60_000;
  if (state.horizon === "7d") return now - 7 * 24 * 60 * 60_000;
  return 0;
}

function queryString(): string {
  const query = new URLSearchParams();
  if (state.selectedProfile) query.set("profileKey", state.selectedProfile);
  if (state.status !== "all") query.set("status", state.status);
  const sinceMs = horizonSinceMs();
  if (sinceMs > 0) query.set("sinceMs", String(sinceMs));
  query.set("limit", "500");
  return query.toString();
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

async function refresh(manual: boolean): Promise<void> {
  if (requestActive || unmounted) return;
  requestActive = true;
  if (manual) state.refreshing = true;
  else if (!state.lastLoadedAtMs) state.loading = true;
  rerender();

  try {
    const payload = await api<CopyPayload>(
      `/api/copy-trading?${queryString()}`,
    );
    state.payload = {
      ...payload,
      profiles: Array.isArray(payload.profiles) ? payload.profiles : [],
      intents: Array.isArray(payload.intents) ? payload.intents : [],
      trackedWallets: Array.isArray(payload.trackedWallets)
        ? payload.trackedWallets
        : [],
      stats: payload.stats ?? {},
      global: payload.global ?? {},
    };
    state.lastLoadedAtMs = Date.now();
    state.error = null;

    try {
      const overview = await api<OverviewPayload>(
        "/api/overview?fast=1&balances=none",
      );
      state.overview = {
        wallets: Array.isArray(overview.wallets) ? overview.wallets : [],
      };
    } catch {
      state.overview = { wallets: [] };
    }

    if (
      state.selectedProfile &&
      !profiles().some(
        (profile) => profile.profileKey === state.selectedProfile,
      )
    ) {
      state.selectedProfile = "";
      localStorage.removeItem(SELECTED_PROFILE_KEY);
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

function setDraft(patch: Partial<ProfileDraft>): void {
  draft = { ...draft, ...patch };
  state.error = null;
  rerender();
}

function openNewProfile(): void {
  draft = emptyDraft();
  const selectedLeader = trackedWallets().find((wallet) =>
    enabled(wallet.enabled),
  );
  if (selectedLeader) draft.leaderWallet = selectedLeader.address;
  state.editingProfileKey = null;
  state.editorOpen = true;
  state.error = null;
  rerender();
}

function editProfile(profile: CopyProfile): void {
  draft = {
    profileKey: profile.profileKey,
    label: text(profile.label),
    leaderWallet: profile.leaderWallet,
    followerRef: profile.followerRef,
    enabled: enabled(profile.enabled),
    mode: profile.mode === "live" ? "live" : "paper",
    copyBuys: enabled(profile.copyBuys),
    copySells: enabled(profile.copySells),
    buySizing: profile.buySizing === "leader-ratio" ? "leader-ratio" : "fixed",
    fixedBuyAmountUi: String(profile.fixedBuyAmountUi ?? 0.05),
    leaderScalePct: String(number(profile.leaderScaleBps) / 100),
    maxBuyAmountUi: String(profile.maxBuyAmountUi ?? 1),
    sellBalancePct: String(number(profile.sellBalanceBps) / 100),
    slippagePct: String(number(profile.slippageBps) / 100),
    maxEventAgeSec: String(number(profile.maxEventAgeMs) / 1_000),
    minMarketCapUsd:
      profile.minMarketCapUsd == null ? "" : String(profile.minMarketCapUsd),
    maxMarketCapUsd:
      profile.maxMarketCapUsd == null ? "" : String(profile.maxMarketCapUsd),
    allowedMints: listText(profile.allowedMintsJson),
    blockedMints: listText(profile.blockedMintsJson),
    allowedQuoteMints: listText(profile.allowedQuoteMintsJson),
    liveConfirmation: "",
  };
  state.editingProfileKey = profile.profileKey;
  state.editorOpen = true;
  state.error = null;
  rerender();
}

function closeEditor(): void {
  state.editorOpen = false;
  state.editingProfileKey = null;
  draft = emptyDraft();
  rerender();
}

function profileRequest(): Record<string, unknown> {
  if (!draft.leaderWallet) throw new Error("Select a leader wallet.");
  if (!text(draft.followerRef)) {
    throw new Error("Select or enter a follower wallet reference.");
  }
  if (!draft.copyBuys && !draft.copySells) {
    throw new Error("Enable copy buys, copy sells, or both.");
  }
  if (draft.mode === "live") {
    if (!globalLiveReady()) {
      throw new Error("Live mode is not globally configured.");
    }
    if (draft.liveConfirmation !== "LIVE") {
      throw new Error('Type "LIVE" to confirm live execution.');
    }
  }

  const minMarketCapUsd = optionalNumber(
    draft.minMarketCapUsd,
    "Minimum market cap",
  );
  const maxMarketCapUsd = optionalNumber(
    draft.maxMarketCapUsd,
    "Maximum market cap",
  );
  if (
    minMarketCapUsd != null &&
    maxMarketCapUsd != null &&
    minMarketCapUsd > maxMarketCapUsd
  ) {
    throw new Error("Minimum market cap cannot exceed maximum market cap.");
  }

  return {
    profileKey: draft.profileKey || undefined,
    label: text(draft.label) || null,
    leaderWallet: draft.leaderWallet,
    followerRef: text(draft.followerRef),
    enabled: draft.enabled,
    mode: draft.mode,
    copyBuys: draft.copyBuys,
    copySells: draft.copySells,
    buySizing: draft.buySizing,
    fixedBuyAmountUi: numberField(
      draft.fixedBuyAmountUi,
      "Fixed buy amount",
      0.000001,
    ),
    leaderScaleBps: Math.round(
      numberField(draft.leaderScalePct, "Leader scale", 0.01, 1_000) * 100,
    ),
    maxBuyAmountUi: numberField(
      draft.maxBuyAmountUi,
      "Maximum buy amount",
      0.000001,
    ),
    sellBalanceBps: Math.round(
      numberField(draft.sellBalancePct, "Sell balance percent", 0.01, 100) *
        100,
    ),
    slippageBps: Math.round(
      numberField(draft.slippagePct, "Slippage", 0.01, 100) * 100,
    ),
    maxEventAgeMs: Math.round(
      numberField(draft.maxEventAgeSec, "Maximum event age", 1) * 1_000,
    ),
    minMarketCapUsd,
    maxMarketCapUsd,
    allowedMints: draft.allowedMints,
    blockedMints: draft.blockedMints,
    allowedQuoteMints: draft.allowedQuoteMints,
  };
}

async function saveProfile(): Promise<void> {
  if (state.saving) return;
  state.saving = true;
  state.error = null;
  rerender();
  try {
    const saved = await api<CopyProfile>("/api/copy-trading", {
      method: state.editingProfileKey ? "PATCH" : "POST",
      body: JSON.stringify({ action: "profile", ...profileRequest() }),
    });
    state.notice = state.editingProfileKey
      ? "Copy strategy updated."
      : "Copy strategy created in paper mode.";
    state.selectedProfile = saved.profileKey;
    localStorage.setItem(SELECTED_PROFILE_KEY, saved.profileKey);
    closeEditor();
    await refresh(false);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.saving = false;
    rerender();
  }
}

async function toggleProfile(profile: CopyProfile): Promise<void> {
  if (state.actionKey) return;
  state.actionKey = profile.profileKey;
  state.error = null;
  rerender();
  try {
    const next = !enabled(profile.enabled);
    await api<CopyProfile>("/api/copy-trading", {
      method: "PATCH",
      body: JSON.stringify({
        action: "toggle",
        profileKey: profile.profileKey,
        enabled: next,
      }),
    });
    state.notice = next ? "Copy strategy enabled." : "Copy strategy paused.";
    await refresh(false);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.actionKey = null;
    rerender();
  }
}

async function retryIntent(intent: CopyIntent): Promise<void> {
  if (state.actionKey) return;
  state.actionKey = intent.intentKey;
  state.error = null;
  rerender();
  try {
    await api<CopyIntent>("/api/copy-trading", {
      method: "PATCH",
      body: JSON.stringify({
        action: "retry-intent",
        intentKey: intent.intentKey,
      }),
    });
    state.notice = "Intent queued for retry.";
    await refresh(false);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.actionKey = null;
    rerender();
  }
}

function selectProfile(value: string): void {
  state.selectedProfile = value;
  if (value) localStorage.setItem(SELECTED_PROFILE_KEY, value);
  else localStorage.removeItem(SELECTED_PROFILE_KEY);
  void refresh(false);
  rerender();
}

function filteredIntents(): CopyIntent[] {
  const needle = text(state.search).toLowerCase();
  if (!needle) return intents();
  return intents().filter((intent) =>
    [
      intent.intentKey,
      intent.profileKey,
      intent.leaderWallet,
      intent.followerRef,
      intent.sourceSignature,
      intent.subjectMint,
      intent.inputMint,
      intent.outputMint,
      intent.executionSignature,
      intent.reason,
      intent.status,
    ].some((value) => text(value).toLowerCase().includes(needle)),
  );
}

function WorkerStatus() {
  const alive = workerAlive();
  const global = state.payload.global ?? {};
  return (
    <div className="copy-system-status">
      <div>
        <span className={`copy-status-dot ${alive ? "ok" : "bad"}`} />
        <div>
          <b>{alive ? "Copy worker online" : "Copy worker offline"}</b>
          <small>
            {state.payload.worker?.heartbeatAtMs
              ? `Heartbeat ${timeAgo(state.payload.worker.heartbeatAtMs)}`
              : "No worker heartbeat found"}
          </small>
        </div>
      </div>
      <div>
        <span
          className={`copy-status-dot ${global.liveReady ? "warn" : "neutral"}`}
        />
        <div>
          <b>{global.liveReady ? "Live gateway armed" : "Paper-only guard"}</b>
          <small>
            {global.liveReady
              ? "Live profiles can submit execution requests"
              : "Live execution remains globally disabled"}
          </small>
        </div>
      </div>
    </div>
  );
}

function CopyHero() {
  return (
    <section className="copy-hero">
      <div>
        <span className="section-kicker">Wallet intelligence</span>
        <h2>Copy trading</h2>
        <p>
          Turn normalized wallet swaps into guarded paper or live execution
          intents. The tracker never holds follower signing keys.
        </p>
      </div>
      <div className="copy-hero-actions">
        <a className="button-link secondary" href="/wallets">
          Tracked wallets
        </a>
        <button
          type="button"
          className="secondary"
          disabled={state.refreshing}
          onClick={() => void refresh(true)}
        >
          {state.refreshing ? "Refreshing…" : "Refresh"}
        </button>
        <button
          type="button"
          className="primary-large"
          onClick={openNewProfile}
        >
          New strategy
        </button>
      </div>
      <WorkerStatus />
    </section>
  );
}

function StatsGrid() {
  const stats = state.payload.stats ?? {};
  const rows = [
    ["Strategies", formatInteger(stats.profiles), "All configured profiles"],
    [
      "Enabled",
      formatInteger(stats.enabledProfiles),
      `${formatInteger(stats.liveProfiles)} live · ${formatInteger(stats.paperProfiles)} paper`,
    ],
    ["Paper intents", formatInteger(stats.paperIntents), "Displayed window"],
    ["Sent", formatInteger(stats.sentIntents), "Accepted by executor"],
    ["Failed", formatInteger(stats.failedIntents), "Review or retry"],
  ];
  return (
    <section className="copy-stats-grid">
      {rows.map(([label, value, detail]) => (
        <article key={label}>
          <span>{label}</span>
          <b>{value}</b>
          <small>{detail}</small>
        </article>
      ))}
    </section>
  );
}

function StrategyCard({ profile }: { profile: CopyProfile; key?: string }) {
  const active = enabled(profile.enabled);
  const selected = state.selectedProfile === profile.profileKey;
  const busy = state.actionKey === profile.profileKey;
  const mcap = `${formatUsd(profile.minMarketCapUsd)} – ${formatUsd(profile.maxMarketCapUsd)}`;
  return (
    <article className={`copy-strategy-card ${selected ? "selected" : ""}`}>
      <header>
        <button
          type="button"
          className="copy-strategy-title"
          onClick={() => selectProfile(selected ? "" : profile.profileKey)}
        >
          <span className={`copy-status-dot ${active ? "ok" : "neutral"}`} />
          <span>
            <b>{profileLabel(profile)}</b>
            <small>
              {profile.mode === "live" ? "Live execution" : "Paper simulation"}
            </small>
          </span>
        </button>
        <span className={`pill ${profile.mode === "live" ? "bad" : "neutral"}`}>
          {profile.mode ?? "paper"}
        </span>
      </header>

      <dl className="copy-strategy-path">
        <div>
          <dt>Leader</dt>
          <dd title={profile.leaderWallet}>
            {leaderLabel(profile.leaderWallet)}
          </dd>
        </div>
        <span aria-hidden="true">→</span>
        <div>
          <dt>Follower</dt>
          <dd title={profile.followerRef}>
            {shortAddress(profile.followerRef, 8, 6)}
          </dd>
        </div>
      </dl>

      <div className="copy-strategy-metrics">
        <div>
          <span>Buy rule</span>
          <b>
            {profile.buySizing === "leader-ratio"
              ? `${formatAmount(number(profile.leaderScaleBps) / 100)}% leader`
              : `${formatAmount(profile.fixedBuyAmountUi)} fixed`}
          </b>
        </div>
        <div>
          <span>Max buy</span>
          <b>{formatAmount(profile.maxBuyAmountUi)}</b>
        </div>
        <div>
          <span>Sell</span>
          <b>{formatAmount(number(profile.sellBalanceBps) / 100)}%</b>
        </div>
        <div>
          <span>Mcap</span>
          <b>{mcap}</b>
        </div>
      </div>

      <div className="copy-strategy-intents">
        <span>{formatInteger(profile.intentCount)} recent intents</span>
        <span>{formatInteger(profile.sentCount)} sent</span>
        <span className={number(profile.failedCount) > 0 ? "bad-text" : ""}>
          {formatInteger(profile.failedCount)} failed
        </span>
        <span>{timeAgo(profile.lastIntentAtMs)}</span>
      </div>

      <footer>
        <button
          type="button"
          className="secondary compact"
          onClick={() => editProfile(profile)}
        >
          Edit
        </button>
        <button
          type="button"
          className="secondary compact"
          disabled={busy}
          onClick={() => void toggleProfile(profile)}
        >
          {busy ? "Saving…" : active ? "Pause" : "Enable"}
        </button>
      </footer>
    </article>
  );
}

function StrategyList() {
  return (
    <section className="copy-panel copy-strategies-panel">
      <header className="copy-section-head">
        <div>
          <span className="copy-step">01</span>
          <h3>Strategies</h3>
          <p>Each strategy maps one tracked leader to one follower wallet.</p>
        </div>
        <span className="muted small">{profiles().length} configured</span>
      </header>
      {profiles().length ? (
        <div className="copy-strategy-list">
          {profiles().map((profile) => (
            <StrategyCard key={profile.profileKey} profile={profile} />
          ))}
        </div>
      ) : (
        <button type="button" className="copy-empty" onClick={openNewProfile}>
          <b>No copy strategies</b>
          <span>Create a paper strategy from an enabled tracked wallet.</span>
        </button>
      )}
    </section>
  );
}

function FollowerOptions() {
  return (
    <datalist id="copy-follower-options">
      {managedWallets().map((wallet) => {
        const address = walletAddress(wallet);
        if (!address) return null;
        return (
          <option key={address} value={address}>
            {walletLabel(wallet)}
          </option>
        );
      })}
    </datalist>
  );
}

function ProfileEditor() {
  if (!state.editorOpen) {
    return (
      <section className="copy-panel copy-editor-panel">
        <header className="copy-section-head">
          <div>
            <span className="copy-step">02</span>
            <h3>Configuration</h3>
            <p>
              Start with paper mode and promote only after reviewing intents.
            </p>
          </div>
        </header>
        <button
          type="button"
          className="copy-empty editor"
          onClick={openNewProfile}
        >
          <b>Create a strategy</b>
          <span>Choose a leader, follower, sizing rule, and risk limits.</span>
        </button>
      </section>
    );
  }

  const live = draft.mode === "live";
  return (
    <section className="copy-panel copy-editor-panel">
      <header className="copy-section-head">
        <div>
          <span className="copy-step">02</span>
          <h3>{state.editingProfileKey ? "Edit strategy" : "New strategy"}</h3>
          <p>Profile changes are read automatically by the copy worker.</p>
        </div>
        <button
          type="button"
          className="secondary compact"
          onClick={closeEditor}
        >
          Close
        </button>
      </header>

      <form
        className="copy-profile-form"
        onSubmit={(event: any) => {
          event.preventDefault();
          void saveProfile();
        }}
      >
        <div className="copy-form-grid">
          <label>
            <span>Label</span>
            <input
              maxLength={80}
              placeholder="Smart money alpha"
              value={draft.label}
              onInput={(event: any) =>
                setDraft({ label: event.currentTarget.value })
              }
            />
          </label>
          <label>
            <span>Mode</span>
            <select
              value={draft.mode}
              onInput={(event: any) =>
                setDraft({
                  mode: event.currentTarget.value === "live" ? "live" : "paper",
                  enabled:
                    event.currentTarget.value === "live"
                      ? false
                      : draft.enabled,
                  liveConfirmation: "",
                })
              }
            >
              <option value="paper">Paper — create simulated intents</option>
              <option value="live" disabled={!globalLiveReady()}>
                Live — submit to executor gateway
              </option>
            </select>
          </label>
          <label>
            <span>Leader wallet</span>
            <select
              required
              value={draft.leaderWallet}
              disabled={Boolean(state.editingProfileKey)}
              onInput={(event: any) =>
                setDraft({ leaderWallet: event.currentTarget.value })
              }
            >
              <option value="">Select tracked wallet…</option>
              {trackedWallets().map((wallet) => (
                <option key={wallet.address} value={wallet.address}>
                  {text(wallet.label) || shortAddress(wallet.address)}
                  {enabled(wallet.enabled) ? "" : " — paused"}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Follower wallet reference</span>
            <input
              required
              list="copy-follower-options"
              placeholder="Managed wallet address or executor reference"
              value={draft.followerRef}
              disabled={Boolean(state.editingProfileKey)}
              onInput={(event: any) =>
                setDraft({ followerRef: event.currentTarget.value })
              }
            />
            <FollowerOptions />
          </label>
        </div>

        <div className="copy-check-row">
          <label>
            <input
              type="checkbox"
              checked={draft.copyBuys}
              onInput={(event: any) =>
                setDraft({ copyBuys: event.currentTarget.checked })
              }
            />
            <span>Copy buys</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.copySells}
              onInput={(event: any) =>
                setDraft({ copySells: event.currentTarget.checked })
              }
            />
            <span>Copy sells</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={live && draft.liveConfirmation !== "LIVE"}
              onInput={(event: any) =>
                setDraft({ enabled: event.currentTarget.checked })
              }
            />
            <span>Enable after save</span>
          </label>
        </div>

        <fieldset>
          <legend>Buy sizing</legend>
          <div className="copy-form-grid three">
            <label>
              <span>Rule</span>
              <select
                value={draft.buySizing}
                onInput={(event: any) =>
                  setDraft({
                    buySizing:
                      event.currentTarget.value === "leader-ratio"
                        ? "leader-ratio"
                        : "fixed",
                  })
                }
              >
                <option value="fixed">Fixed quote amount</option>
                <option value="leader-ratio">Scale leader input</option>
              </select>
            </label>
            {draft.buySizing === "fixed" ? (
              <label>
                <span>Fixed amount UI</span>
                <input
                  type="number"
                  min="0.000001"
                  step="0.000001"
                  value={draft.fixedBuyAmountUi}
                  onInput={(event: any) =>
                    setDraft({ fixedBuyAmountUi: event.currentTarget.value })
                  }
                />
              </label>
            ) : (
              <label>
                <span>Leader scale %</span>
                <input
                  type="number"
                  min="0.01"
                  max="1000"
                  step="0.01"
                  value={draft.leaderScalePct}
                  onInput={(event: any) =>
                    setDraft({ leaderScalePct: event.currentTarget.value })
                  }
                />
              </label>
            )}
            <label>
              <span>Maximum buy amount UI</span>
              <input
                type="number"
                min="0.000001"
                step="0.000001"
                value={draft.maxBuyAmountUi}
                onInput={(event: any) =>
                  setDraft({ maxBuyAmountUi: event.currentTarget.value })
                }
              />
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Execution limits</legend>
          <div className="copy-form-grid four">
            <label>
              <span>Sell balance %</span>
              <input
                type="number"
                min="0.01"
                max="100"
                step="0.01"
                value={draft.sellBalancePct}
                onInput={(event: any) =>
                  setDraft({ sellBalancePct: event.currentTarget.value })
                }
              />
            </label>
            <label>
              <span>Slippage %</span>
              <input
                type="number"
                min="0.01"
                max="100"
                step="0.01"
                value={draft.slippagePct}
                onInput={(event: any) =>
                  setDraft({ slippagePct: event.currentTarget.value })
                }
              />
            </label>
            <label>
              <span>Maximum event age sec</span>
              <input
                type="number"
                min="1"
                step="1"
                value={draft.maxEventAgeSec}
                onInput={(event: any) =>
                  setDraft({ maxEventAgeSec: event.currentTarget.value })
                }
              />
            </label>
            <label>
              <span>Minimum market cap USD</span>
              <input
                type="number"
                min="0"
                step="100"
                placeholder="Any"
                value={draft.minMarketCapUsd}
                onInput={(event: any) =>
                  setDraft({ minMarketCapUsd: event.currentTarget.value })
                }
              />
            </label>
            <label>
              <span>Maximum market cap USD</span>
              <input
                type="number"
                min="0"
                step="100"
                placeholder="Any"
                value={draft.maxMarketCapUsd}
                onInput={(event: any) =>
                  setDraft({ maxMarketCapUsd: event.currentTarget.value })
                }
              />
            </label>
          </div>
        </fieldset>

        <details className="copy-advanced">
          <summary>Token allowlists and blocklists</summary>
          <div className="copy-list-grid">
            <label>
              <span>Allowed subject mints</span>
              <textarea
                rows={5}
                placeholder="Leave empty to allow all"
                value={draft.allowedMints}
                onInput={(event: any) =>
                  setDraft({ allowedMints: event.currentTarget.value })
                }
              />
            </label>
            <label>
              <span>Blocked subject mints</span>
              <textarea
                rows={5}
                placeholder="One mint per line"
                value={draft.blockedMints}
                onInput={(event: any) =>
                  setDraft({ blockedMints: event.currentTarget.value })
                }
              />
            </label>
            <label>
              <span>Allowed quote mints</span>
              <textarea
                rows={5}
                placeholder="Leave empty to use supported quotes"
                value={draft.allowedQuoteMints}
                onInput={(event: any) =>
                  setDraft({ allowedQuoteMints: event.currentTarget.value })
                }
              />
            </label>
          </div>
        </details>

        {live ? (
          <div className="copy-live-confirmation" role="alert">
            <b>Live mode can spend real funds</b>
            <span>
              The executor gateway, not this page, owns signing keys. Review
              paper intents first and keep the strategy disabled until the
              gateway is ready.
            </span>
            <label>
              <span>Type LIVE to confirm</span>
              <input
                value={draft.liveConfirmation}
                autoComplete="off"
                onInput={(event: any) =>
                  setDraft({
                    liveConfirmation: event.currentTarget.value,
                    enabled:
                      event.currentTarget.value === "LIVE"
                        ? draft.enabled
                        : false,
                  })
                }
              />
            </label>
          </div>
        ) : (
          <div className="copy-paper-note" role="note">
            <b>Paper mode recommended</b>
            <span>
              Approved leader events are persisted as paper intents without
              sending transactions or contacting the executor gateway.
            </span>
          </div>
        )}

        <footer className="copy-editor-actions">
          <button type="button" className="secondary" onClick={closeEditor}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary-large"
            disabled={state.saving}
          >
            {state.saving
              ? "Saving…"
              : state.editingProfileKey
                ? "Save strategy"
                : "Create strategy"}
          </button>
        </footer>
      </form>
    </section>
  );
}

function IntentFilters() {
  return (
    <section className="copy-filter-bar">
      <label>
        <span>Strategy</span>
        <select
          value={state.selectedProfile}
          onInput={(event: any) => selectProfile(event.currentTarget.value)}
        >
          <option value="">All strategies</option>
          {profiles().map((profile) => (
            <option key={profile.profileKey} value={profile.profileKey}>
              {profileLabel(profile)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Status</span>
        <select
          value={state.status}
          onInput={(event: any) => {
            state.status = event.currentTarget.value as IntentStatusFilter;
            void refresh(false);
            rerender();
          }}
        >
          <option value="all">All statuses</option>
          <option value="paper">Paper</option>
          <option value="queued">Queued</option>
          <option value="sending">Sending</option>
          <option value="sent">Sent</option>
          <option value="skipped">Skipped</option>
          <option value="failed">Failed</option>
        </select>
      </label>
      <label>
        <span>Window</span>
        <select
          value={state.horizon}
          onInput={(event: any) => {
            state.horizon = event.currentTarget.value as Horizon;
            void refresh(false);
            rerender();
          }}
        >
          <option value="1h">Last hour</option>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="all">All retained</option>
        </select>
      </label>
      <label className="copy-search-field">
        <span>Search</span>
        <input
          type="search"
          placeholder="Mint, wallet, signature, reason…"
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

function intentAmount(intent: CopyIntent): string {
  if (intent.amountKind === "balance-bps") {
    return `${formatAmount(number(intent.balanceBps) / 100)}% balance`;
  }
  return `${formatAmount(intent.amountUi)} input`;
}

function IntentRow({ intent }: { intent: CopyIntent; key?: string }) {
  const profile = profileByKey(intent.profileKey);
  const status = text(intent.status) || "queued";
  const busy = state.actionKey === intent.intentKey;
  return (
    <article className="copy-intent-row">
      <div className="copy-intent-status">
        <span className={`pill ${status}`}>{status}</span>
        <small>{intent.mode ?? "paper"}</small>
      </div>
      <div className="copy-intent-trade">
        <b className={intent.side === "sell" ? "sell-text" : "buy-text"}>
          {intent.side ?? "buy"} {shortAddress(intent.subjectMint, 6, 5)}
        </b>
        <button
          type="button"
          className="copy-link code"
          onClick={() => copyValue(intent.subjectMint)}
        >
          {intent.subjectMint}
        </button>
      </div>
      <div>
        <span>Strategy</span>
        <b>
          {profile
            ? profileLabel(profile)
            : shortAddress(intent.profileKey, 8, 6)}
        </b>
        <small>
          {leaderLabel(intent.leaderWallet)} →{" "}
          {shortAddress(intent.followerRef, 7, 5)}
        </small>
      </div>
      <div>
        <span>Amount</span>
        <b>{intentAmount(intent)}</b>
        <small>
          {formatAmount(number(intent.slippageBps) / 100)}% slippage
        </small>
      </div>
      <div className="copy-intent-result">
        <span>Result</span>
        <b>
          {text(intent.reason) ||
            (intent.executionSignature ? "Submitted" : "—")}
        </b>
        {intent.executionSignature ? (
          <a
            href={`https://solscan.io/tx/${encodeURIComponent(intent.executionSignature)}`}
            target="_blank"
            rel="noreferrer"
            className="code"
          >
            {shortAddress(intent.executionSignature, 6, 5)}
          </a>
        ) : (
          <small>{formatInteger(intent.attempts)} attempts</small>
        )}
      </div>
      <div className="copy-intent-time">
        <span>Source</span>
        <b>{timeAgo(intent.createdAtMs)}</b>
        <a
          href={`https://solscan.io/tx/${encodeURIComponent(intent.sourceSignature)}`}
          target="_blank"
          rel="noreferrer"
          className="code"
        >
          {shortAddress(intent.sourceSignature, 5, 5)}
        </a>
      </div>
      <div className="copy-intent-action">
        {status === "failed" ? (
          <button
            type="button"
            className="secondary compact"
            disabled={busy}
            onClick={() => void retryIntent(intent)}
          >
            {busy ? "Queuing…" : "Retry"}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function IntentsPanel() {
  const rows = filteredIntents();
  return (
    <section className="copy-panel copy-intents-panel">
      <header className="copy-section-head">
        <div>
          <span className="copy-step">03</span>
          <h3>Execution intents</h3>
          <p>
            Immutable leader events become deduplicated policy decisions here.
          </p>
        </div>
        <span className="muted small">{rows.length} shown</span>
      </header>
      {rows.length ? (
        <div className="copy-intent-list">
          <div className="copy-intent-labels" aria-hidden="true">
            <span>Status</span>
            <span>Trade</span>
            <span>Strategy</span>
            <span>Amount</span>
            <span>Result</span>
            <span>Source</span>
            <span />
          </div>
          {rows.map((intent) => (
            <IntentRow key={intent.intentKey} intent={intent} />
          ))}
        </div>
      ) : (
        <div className="copy-empty static">
          <b>No intents match these filters</b>
          <span>
            Enable a paper strategy and wait for a copyable buy or sell from its
            tracked leader.
          </span>
        </div>
      )}
    </section>
  );
}

function PageMessages() {
  if (!state.error && !state.notice) return null;
  return (
    <section
      className={`copy-page-message ${state.error ? "bad" : "ok"}`}
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

export function CopyTradingPage() {
  return (
    <main className="copy-page-direct">
      <PageMessages />
      <CopyHero />
      <StatsGrid />
      <div className="copy-management-grid">
        <StrategyList />
        <ProfileEditor />
      </div>
      <IntentFilters />
      <IntentsPanel />
      <footer className="copy-page-footer">
        <span>
          {state.lastLoadedAtMs
            ? `Updated ${timeAgo(state.lastLoadedAtMs)}`
            : state.loading
              ? "Loading copy-trade data"
              : "Waiting for copy worker data"}
        </span>
        <span>
          Automatic refresh every {POLL_VISIBLE_MS / 1_000}s while visible.
        </span>
      </footer>
    </main>
  );
}

export default function mount() {
  unmounted = false;
  const selected = text(localStorage.getItem(SELECTED_PROFILE_KEY));
  if (selected) state.selectedProfile = selected;
  const requestedLeader = text(
    new URL(window.location.href).searchParams.get("leader"),
  );
  if (requestedLeader) {
    draft = { ...emptyDraft(), leaderWallet: requestedLeader };
    state.editorOpen = true;
  }
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
