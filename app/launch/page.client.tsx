import "./page.css";
import { render } from "tradjs/client";

type AnyRow = Record<string, any>;

type OverviewPayload = {
  wallets: AnyRow[];
  groups: AnyRow[];
  tokens?: AnyRow[];
  executions?: AnyRow[];
  balances?: AnyRow[];
};

type LaunchPageState = {
  overview: OverviewPayload | null;

  jobs: AnyRow[];

  selectedJobId: string | null;

  selectedJob: AnyRow | null;

  busy: boolean;

  loading: boolean;

  error: string | null;

  lastLoadedAtMs: number | null;
};

const state: LaunchPageState = {
  overview: null,

  jobs: [],

  selectedJobId: null,

  selectedJob: null,

  busy: false,

  loading: true,

  error: null,

  lastLoadedAtMs: null,
};

let unmounted = false;

let renderFrame: number | null = null;

let renderActive = false;

let renderPending = false;

let jobsPollTimer: ReturnType<typeof setTimeout> | null = null;

let jobsPollInFlight = false;

function rootElement(): HTMLElement {
  const root = document.getElementById("app-root");

  if (!root) {
    throw new Error("Missing #app-root.");
  }

  return root;
}

function updateActiveNavigation(): void {
  document
    .querySelectorAll<HTMLAnchorElement>("#main-nav a")
    .forEach((link) => {
      link.classList.toggle("active", link.dataset.page === "launch");
    });
}

function renderLaunchPage(): void {
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
     * TradJS owns the stable app root. Normal updates reconcile the same tree.
     * Never clone, stage, clear, replace, or manually mutate this root.
     */
    render(<LaunchPage />, rootElement(), {
      reconciler: "sequential",
    });

    updateActiveNavigation();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);

    console.error("[solard:launch] render failed", error);
  } finally {
    renderActive = false;

    if (renderPending && !unmounted) {
      renderPending = false;

      update();
    }
  }
}

function update(): void {
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

  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;

    renderLaunchPage();
  });
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem("solwal:web-token") ?? "";

  return token
    ? {
        "x-solwal-web-token": token,
      }
    : {};
}

function unwrapApiPayload<T>(payload: any, status: number): T {
  if (payload && typeof payload === "object") {
    if (payload.ok === false) {
      throw new Error(payload.error ?? payload.message ?? `HTTP ${status}`);
    }

    if (Object.prototype.hasOwnProperty.call(payload, "value")) {
      return payload.value as T;
    }

    if (Object.prototype.hasOwnProperty.call(payload, "data")) {
      return payload.data as T;
    }
  }

  return payload as T;
}

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
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
    payload = {
      ok: false,

      error: text || `HTTP ${response.status}`,
    };
  }

  if (!response.ok) {
    throw new Error(
      payload?.error ?? payload?.message ?? `HTTP ${response.status}`,
    );
  }

  return unwrapApiPayload<T>(payload, response.status);
}

function shortAddress(value: unknown, head = 4, tail = 4): string {
  const text = String(value ?? "");

  if (text.length <= head + tail + 1) {
    return text;
  }

  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function walletPublicValue(wallet: AnyRow): string {
  const nested = wallet.wallet;

  const account = wallet.account;

  const candidates = [
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
  ];

  return String(
    candidates.find((candidate) => String(candidate ?? "").trim()) ?? "",
  ).trim();
}

function walletIdentityValues(wallet: AnyRow): string[] {
  const nested = wallet.wallet;

  return [
    walletPublicValue(wallet),

    wallet.name,
    wallet.walletName,
    wallet.id,

    typeof nested === "object" ? nested?.name : null,

    typeof nested === "object" ? nested?.id : null,
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
}

function walletLabel(wallet: AnyRow): string {
  const address = walletPublicValue(wallet);

  const name = String(wallet.name ?? wallet.walletName ?? "").trim();

  return name ? `${name} — ${shortAddress(address)}` : address;
}

function statusClass(status: unknown): string {
  const value = String(status ?? "");

  if (value === "succeeded" || value === "confirmed") {
    return "ok";
  }

  if (value === "failed") {
    return "bad";
  }

  if (
    value === "running" ||
    value === "planned" ||
    value === "broadcast" ||
    value === "starting"
  ) {
    return "warn";
  }

  return "";
}

function latestJob(): AnyRow | null {
  return state.selectedJob ?? state.jobs[0] ?? null;
}

function jobHeadline(job: AnyRow | null): string {
  if (!job) {
    return "No run selected";
  }

  const token =
    job.result?.token?.symbol ??
    job.result?.token?.alias ??
    job.result?.token?.mint ??
    job.result?.mint;

  return token ? `Pump launch: ${token}` : String(job.kind ?? "Launch run");
}

function openActivity(): void {
  window.location.href = "/activity";
}

function LaunchRunSummary({ job }: { job: AnyRow | null }) {
  if (!job) {
    return null;
  }

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
    <section className="launch-run-card">
      <header className="launch-run-head">
        <div>
          <span className="section-kicker">Current run</span>

          <h3>{jobHeadline(job)}</h3>

          <p>
            Started {new Date(job.createdAtMs).toLocaleString()}
            {" · "}
            updated{" "}
            {new Date(job.updatedAtMs ?? job.createdAtMs).toLocaleTimeString()}
          </p>
        </div>

        <div className="launch-run-actions">
          <span className={`pill ${statusClass(job.status)}`}>
            {String(job.status ?? "unknown")}
          </span>

          <button
            type="button"
            className="secondary compact"
            onClick={openActivity}
          >
            Open activity
          </button>
        </div>
      </header>

      {fatal ? (
        <div className="launch-run-callout bad">
          <b>Run failed:</b>{" "}
          {String(fatal.value ?? job.error ?? "Unknown error")
            .replace(
              /Pump launch requested live execution, but SOLARD_ENABLE_LIVE_TRADES=1 is not set\. Run dry-run first, then opt in explicitly\.?/i,
              "Previous failed attempt: the old backend rejected it before metadata, signing, or broadcast. No transaction was sent.",
            )
            .slice(0, 420)}
        </div>
      ) : null}

      {job.status === "queued" ? (
        <div className="launch-run-callout warn">
          Launch accepted. The background job is starting.
        </div>
      ) : job.status === "running" ? (
        <div className="launch-run-callout warn">
          Launch is running. Detailed execution events remain available in
          Activity.
        </div>
      ) : null}

      <div className="launch-run-metrics">
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
    </section>
  );
}

async function refreshOverview(): Promise<void> {
  const overview = await api<OverviewPayload>("/api/overview?fast=1");

  state.overview = {
    wallets: Array.isArray(overview.wallets) ? overview.wallets : [],

    groups: Array.isArray(overview.groups) ? overview.groups : [],

    tokens: overview.tokens ?? [],

    executions: overview.executions ?? [],

    balances: overview.balances ?? [],
  };

  normalizeSelectedWallets();

  state.lastLoadedAtMs = Date.now();
}

async function refreshJobs(): Promise<void> {
  state.jobs = await api<AnyRow[]>("/api/jobs");

  if (state.selectedJobId) {
    state.selectedJob = await api<AnyRow>(
      `/api/jobs?id=${encodeURIComponent(state.selectedJobId)}`,
    ).catch(
      () =>
        state.jobs.find(
          (job) => String(job.id ?? "") === state.selectedJobId,
        ) ?? null,
    );
  } else {
    state.selectedJob = null;
  }
}

async function runAction<T>(action: () => Promise<T>): Promise<T | undefined> {
  if (state.busy) {
    return undefined;
  }

  state.busy = true;

  state.error = null;

  update();

  try {
    return await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    state.error =
      /database is locked|database is busy|sqlite_busy|sqlite_locked/i.test(
        message,
      )
        ? "The request reached an outdated process that still blocks on SQLite. Restart the Solard web process, then submit once."
        : /SOLARD_ENABLE_LIVE_TRADES|obsolete global live-trade gate/i.test(
              message,
            )
          ? "The request reached an outdated Launch runner. Restart the Solard web process; no transaction was sent."
          : message;

    return undefined;
  } finally {
    state.busy = false;

    update();
  }
}

function clearJobsPoll(): void {
  if (jobsPollTimer != null) {
    clearTimeout(jobsPollTimer);

    jobsPollTimer = null;
  }
}

function scheduleJobsPoll(): void {
  clearJobsPoll();

  if (unmounted) {
    return;
  }

  const job = latestJob();

  const active =
    job &&
    ["queued", "running", "planned", "broadcast", "starting"].includes(
      String(job.status ?? ""),
    );

  jobsPollTimer = setTimeout(
    () => {
      void pollJobs();
    },
    active ? 1_500 : 8_000,
  );
}

async function pollJobs(): Promise<void> {
  if (jobsPollInFlight || unmounted || document.visibilityState !== "visible") {
    scheduleJobsPoll();
    return;
  }

  jobsPollInFlight = true;

  try {
    await refreshJobs();
  } catch (error) {
    console.warn("[solard:launch] job refresh failed", error);
  } finally {
    jobsPollInFlight = false;

    update();
    scheduleJobsPoll();
  }
}

async function loadLaunchPage(): Promise<void> {
  state.loading = true;

  state.error = null;

  update();

  const results = await Promise.allSettled([refreshOverview(), refreshJobs()]);

  const failure = results.find((result) => result.status === "rejected");

  if (failure && failure.status === "rejected") {
    state.error =
      failure.reason instanceof Error
        ? failure.reason.message
        : String(failure.reason);
  }

  state.loading = false;

  update();
  scheduleJobsPoll();
}

const EXPECTED_LAUNCH_RUNNER_VERSION = "v50-direct-live";

const BUYER_RESERVE_SOL = "0.02";

/**
 * The current Helius Sender dual-route endpoint requires this minimum tip.
 * It is owned by the sender choice rather than entered as a generic fee.
 */
const HELIUS_SENDER_TIP_SOL = "0.0002";

const BUYER_CU_LIMIT = 600_000;

type FollowerWallet = {
  id: string;
  wallet: string;
};

type FollowerSender = "helius-fast" | "helius-rpc";

type FollowerStrategy =
  | "fast-spam"
  | "spam-after-market-ready"
  | "after-deploy-processed"
  | "after-deploy-confirmed";

type FollowerSettingsGroup = {
  id: string;
  name: string;
  sourceGroup: string | null;
  wallets: FollowerWallet[];

  sender: FollowerSender;

  strategy: FollowerStrategy;

  minPct: string;
  maxPct: string;

  tipSol: string;
  priorityFeeSol: string;
  slippagePct: string;

  retryIntervalMs: string;
  recompileIntervalMs: string;
  freshQuoteDelayMs: string;
  maxFailedAttempts: string;
};

type LaunchDraft = {
  name: string;
  symbol: string;
  description: string;
  website: string;
  twitter: string;
  telegram: string;

  creator: string;
  creatorBuySol: string;
  mintSuffix: string;

  live: boolean;
  skipSimulation: boolean;
  cashback: boolean;
};

type ExportedFollowerGroup = {
  name: string;
  sourceGroup: string | null;
  wallets: string[];

  sender: FollowerSender;

  strategy: FollowerStrategy;

  minPct: string;
  maxPct: string;

  tipSol: string;
  priorityFeeSol: string;
  slippagePct: string;

  retryIntervalMs: string;
  recompileIntervalMs: string;
  freshQuoteDelayMs: string;
  maxFailedAttempts: string;
};

type LaunchConfigV1 = {
  schema: "solard.pump-launch-config";

  version: 1;

  exportedAt: string;

  image: {
    included: false;

    fileName: string | null;
  };

  token: {
    name: string;

    symbol: string;

    description: string;

    website: string;

    twitter: string;

    telegram: string;
  };

  deployment: {
    creator: string;

    creatorBuySol: string;

    mintSuffix: string;

    live: boolean;

    skipSimulation: boolean;

    cashback: boolean;
  };

  followers: ExportedFollowerGroup[];
};

const LAUNCH_CONFIG_SCHEMA = "solard.pump-launch-config";

const LAUNCH_CONFIG_VERSION = 1;

const MAX_LAUNCH_CONFIG_BYTES = 1_000_000;

let launchDraft: LaunchDraft = {
  name: "",

  symbol: "",

  description: "",

  website: "",

  twitter: "",

  telegram: "",

  creator: "",

  creatorBuySol: "0",

  mintSuffix: "pump",

  live: true,

  skipSimulation: false,

  cashback: true,
};

let launchConfigNotice: string | null = null;

let imageInputRevision = 0;

let configInputRevision = 0;

let followerGroups: FollowerSettingsGroup[] = [];

let selectedImage: File | null = null;

let selectedImagePreview: string | null = null;

function id(prefix: string): string {
  const suffix =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return `${prefix}:${suffix}`;
}

function mutateLaunchDraft(patch: Partial<LaunchDraft>): void {
  launchDraft = {
    ...launchDraft,
    ...patch,
  };

  launchConfigNotice = null;

  update();
}

function jsonString(value: unknown, fallback = "", maximum = 10_000): string {
  const text =
    typeof value === "string"
      ? value
      : value == null
        ? fallback
        : String(value);

  return text.slice(0, maximum);
}

function jsonBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true" || value === 1) {
    return true;
  }

  if (value === "false" || value === 0) {
    return false;
  }

  return fallback;
}

function automaticSenderTip(sender: FollowerSender): string {
  return sender === "helius-fast" ? HELIUS_SENDER_TIP_SOL : "0";
}

function followerSender(value: unknown): FollowerSender {
  return value === "helius-rpc" ? "helius-rpc" : "helius-fast";
}

function followerStrategy(value: unknown): FollowerStrategy {
  if (
    value === "spam-after-market-ready" ||
    value === "after-deploy-processed" ||
    value === "after-deploy-confirmed"
  ) {
    return value;
  }

  return "fast-spam";
}

function exportFollowerGroup(
  group: FollowerSettingsGroup,
): ExportedFollowerGroup {
  return {
    name: group.name,

    sourceGroup: group.sourceGroup,

    wallets: group.wallets.map((wallet) => walletAddress(wallet.wallet)),

    sender: group.sender,

    strategy: group.strategy,

    minPct: group.minPct,

    maxPct: group.maxPct,

    tipSol: automaticSenderTip(group.sender),

    priorityFeeSol: group.priorityFeeSol,

    slippagePct: group.slippagePct,

    retryIntervalMs: group.retryIntervalMs,

    recompileIntervalMs: group.recompileIntervalMs,

    freshQuoteDelayMs: group.freshQuoteDelayMs,

    maxFailedAttempts: group.maxFailedAttempts,
  };
}

function launchConfig(): LaunchConfigV1 {
  return {
    schema: LAUNCH_CONFIG_SCHEMA,

    version: LAUNCH_CONFIG_VERSION,

    exportedAt: new Date().toISOString(),

    image: {
      included: false,

      fileName: selectedImage?.name ?? null,
    },

    token: {
      name: launchDraft.name,

      symbol: launchDraft.symbol,

      description: launchDraft.description,

      website: launchDraft.website,

      twitter: launchDraft.twitter,

      telegram: launchDraft.telegram,
    },

    deployment: {
      creator: walletAddress(launchDraft.creator),

      creatorBuySol: launchDraft.creatorBuySol,

      mintSuffix: launchDraft.mintSuffix,

      live: true,

      skipSimulation: launchDraft.skipSimulation,

      cashback: launchDraft.cashback,
    },

    followers: followerGroups.map(exportFollowerGroup),
  };
}

function safePresetName(): string {
  const source = launchDraft.symbol || launchDraft.name || "pump-launch";

  const clean = source
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return clean || "pump-launch";
}

function exportLaunchJson(): void {
  const blob = new Blob([JSON.stringify(launchConfig(), null, 2), "\n"], {
    type: "application/json",
  });

  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");

  link.href = url;

  link.download = `${safePresetName()}.solard-launch.json`;

  link.style.display = "none";

  document.body.append(link);

  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 0);

  launchConfigNotice =
    "Exported the launch preset. Token image data is not included.";

  update();
}

function importedFollowerGroup(
  value: unknown,
  index: number,
): FollowerSettingsGroup {
  const row = value && typeof value === "object" ? (value as AnyRow) : {};

  const rawWallets = Array.isArray(row.wallets) ? row.wallets : [];

  const addresses = rawWallets
    .map(walletAddress)
    .filter((address) => Boolean(address));

  const sourceGroup = jsonString(row.sourceGroup, "", 120).trim() || null;

  return newFollowerGroup({
    name:
      jsonString(row.name, `Imported set ${index + 1}`, 120) ||
      `Imported set ${index + 1}`,

    sourceGroup: sourceGroup && addresses.length ? sourceGroup : null,

    wallets: addresses.length
      ? addresses.map((address) => newFollowerWallet(address))
      : [newFollowerWallet()],

    sender: followerSender(row.sender),

    strategy: followerStrategy(row.strategy),

    minPct: jsonString(row.minPct, "50", 32),

    maxPct: jsonString(row.maxPct, "80", 32),

    tipSol: automaticSenderTip(followerSender(row.sender)),

    priorityFeeSol: jsonString(row.priorityFeeSol, "0.0009", 32),

    slippagePct: jsonString(row.slippagePct, "2.5", 32),

    retryIntervalMs: jsonString(row.retryIntervalMs, "75", 32),

    recompileIntervalMs: jsonString(row.recompileIntervalMs, "750", 32),

    freshQuoteDelayMs: jsonString(row.freshQuoteDelayMs, "-1", 32),

    maxFailedAttempts: jsonString(row.maxFailedAttempts, "0", 32),
  });
}

function clearSelectedImage(): void {
  if (selectedImagePreview) {
    URL.revokeObjectURL(selectedImagePreview);
  }

  selectedImage = null;

  selectedImagePreview = null;

  imageInputRevision++;
}

function applyLaunchConfig(raw: unknown): void {
  const root = raw && typeof raw === "object" ? (raw as AnyRow) : null;

  if (!root) {
    throw new Error("Launch preset must be a JSON object.");
  }

  if (root.schema != null && root.schema !== LAUNCH_CONFIG_SCHEMA) {
    throw new Error(
      `Unsupported launch preset schema: ${String(root.schema)}.`,
    );
  }

  if (root.version != null && Number(root.version) !== LAUNCH_CONFIG_VERSION) {
    throw new Error(
      `Unsupported launch preset version: ${String(root.version)}.`,
    );
  }

  const token =
    root.token && typeof root.token === "object" ? (root.token as AnyRow) : {};

  const deployment =
    root.deployment && typeof root.deployment === "object"
      ? (root.deployment as AnyRow)
      : {};

  /**
   * A direct followers array is also accepted for older hand-written presets.
   */
  const followers = Array.isArray(raw)
    ? raw
    : Array.isArray(root.followers)
      ? root.followers
      : [];

  launchDraft = {
    name: jsonString(token.name ?? root.name, "", 32),

    symbol: jsonString(token.symbol ?? root.symbol, "", 10),

    description: jsonString(token.description ?? root.description, "", 500),

    website: jsonString(token.website ?? root.website, "", 2_000),

    twitter: jsonString(token.twitter ?? root.twitter, "", 2_000),

    telegram: jsonString(token.telegram ?? root.telegram, "", 2_000),

    creator: walletAddress(deployment.creator ?? root.creator),

    creatorBuySol: jsonString(
      deployment.creatorBuySol ?? root.creatorBuySol,
      "0",
      32,
    ),

    mintSuffix:
      jsonString(deployment.mintSuffix ?? root.mintSuffix, "pump", 12) ||
      "pump",

    live: true,

    skipSimulation: jsonBoolean(
      deployment.skipSimulation ?? root.skipSimulation,
      false,
    ),

    cashback: jsonBoolean(deployment.cashback ?? root.cashback, true),
  };

  followerGroups = followers.map(importedFollowerGroup);

  normalizeSelectedWallets();

  clearSelectedImage();

  state.error = null;

  const importedWalletCount = followerGroups.reduce(
    (count, group) =>
      count + group.wallets.filter((wallet) => Boolean(wallet.wallet)).length,
    0,
  );

  launchConfigNotice = `Imported ${followerGroups.length} follower ${followerGroups.length === 1 ? "set" : "sets"} and restored ${importedWalletCount} wallet ${importedWalletCount === 1 ? "selection" : "selections"}. Choose the token image before launching.`;

  update();
}

async function importLaunchJson(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement;

  const file = input.files?.[0] ?? null;

  configInputRevision++;

  if (!file) {
    update();
    return;
  }

  if (file.size <= 0 || file.size > MAX_LAUNCH_CONFIG_BYTES) {
    state.error = "Launch preset JSON must be between 1 byte and 1 MB.";

    update();
    return;
  }

  try {
    const text = await file.text();

    const parsed = JSON.parse(text);

    applyLaunchConfig(parsed);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);

    launchConfigNotice = null;

    update();
  }
}

function newFollowerWallet(wallet = ""): FollowerWallet {
  return {
    id: id("wallet"),

    wallet,
  };
}

function newFollowerGroup(
  seed: Partial<FollowerSettingsGroup> = {},
): FollowerSettingsGroup {
  return {
    id: id("followers"),

    name: "Individual",

    sourceGroup: null,

    wallets: [newFollowerWallet()],

    sender: "helius-fast",

    strategy: "fast-spam",

    minPct: "50",

    maxPct: "80",

    tipSol: HELIUS_SENDER_TIP_SOL,

    /**
     * 0.0009 SOL over a 600K CU budget equals 1,500,000 micro-lamports/CU.
     */
    priorityFeeSol: "0.0009",

    slippagePct: "2.5",

    retryIntervalMs: "75",

    recompileIntervalMs: "750",

    freshQuoteDelayMs: "-1",

    maxFailedAttempts: "0",

    ...seed,
  };
}

function wallets(): AnyRow[] {
  return state.overview?.wallets ?? [];
}

function savedGroups(): AnyRow[] {
  return state.overview?.groups ?? [];
}

function walletReference(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const row = value as AnyRow;

  const nested = row.wallet;

  const account = row.account;

  const candidates = [
    row.walletAddress,
    row.address,
    row.publicKey,
    row.pubkey,
    row.walletId,
    row.walletName,
    row.name,
    row.id,

    typeof nested === "string" ? nested : null,

    nested?.address,
    nested?.walletAddress,
    nested?.publicKey,
    nested?.pubkey,
    nested?.name,
    nested?.id,

    account?.address,
    account?.publicKey,
    account?.pubkey,
  ];

  return String(
    candidates.find((candidate) => String(candidate ?? "").trim()) ?? "",
  ).trim();
}

function walletByReference(reference: string): AnyRow | null {
  const target = reference.replace(/^@/, "").trim().toLowerCase();

  if (!target) {
    return null;
  }

  return (
    wallets().find((wallet) =>
      walletIdentityValues(wallet).some(
        (candidate) =>
          candidate.replace(/^@/, "").trim().toLowerCase() === target,
      ),
    ) ?? null
  );
}

function walletAddress(value: unknown): string {
  const reference = walletReference(value);

  if (!reference) {
    return "";
  }

  const resolved = walletByReference(reference);

  return (
    resolved ? walletPublicValue(resolved) || reference : reference
  ).trim();
}

function walletByAddress(address: string): AnyRow | null {
  return walletByReference(address);
}

function normalizeSelectedWallets(): void {
  const creator = walletAddress(launchDraft.creator);

  if (creator !== launchDraft.creator) {
    launchDraft = {
      ...launchDraft,

      creator,
    };
  }

  followerGroups = followerGroups.map((group) => ({
    ...group,

    wallets: group.wallets.map((wallet) => {
      const canonical = walletAddress(wallet.wallet);

      return canonical === wallet.wallet
        ? wallet
        : {
            ...wallet,

            wallet: canonical,
          };
    }),
  }));
}

function displayWallet(address: string): string {
  const wallet = walletByAddress(address);

  if (wallet) {
    return walletLabel(wallet);
  }

  if (!address) {
    return "Select wallet…";
  }

  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

function mutateFollowerGroup(
  groupId: string,
  patch: Partial<FollowerSettingsGroup>,
): void {
  followerGroups = followerGroups.map((group) => {
    if (group.id !== groupId) {
      return group;
    }

    const next = {
      ...group,
      ...patch,
    };

    if (patch.sender) {
      next.tipSol = automaticSenderTip(patch.sender);
    }

    return next;
  });

  update();
}

function removeFollowerGroup(groupId: string): void {
  followerGroups = followerGroups.filter((group) => group.id !== groupId);

  update();
}

function addIndividualGroup(): void {
  const number =
    followerGroups.filter((group) => group.sourceGroup == null).length + 1;

  followerGroups = [
    ...followerGroups,

    newFollowerGroup({
      name: `Wallet ${number}`,

      sourceGroup: null,

      wallets: [newFollowerWallet()],
    }),
  ];

  update();
}

function cloneFollowerSettings(groupId: string): void {
  const source = followerGroups.find((group) => group.id === groupId);

  if (!source) {
    return;
  }

  const copy = newFollowerGroup({
    name: `${source.name} copy`,

    /**
     * A clone is always an independent one-wallet set, even when the source
     * was loaded from a saved group.
     */
    sourceGroup: null,

    wallets: [newFollowerWallet()],

    sender: source.sender,

    strategy: source.strategy,

    minPct: source.minPct,

    maxPct: source.maxPct,

    tipSol: automaticSenderTip(source.sender),

    priorityFeeSol: source.priorityFeeSol,

    slippagePct: source.slippagePct,

    retryIntervalMs: source.retryIntervalMs,

    recompileIntervalMs: source.recompileIntervalMs,

    freshQuoteDelayMs: source.freshQuoteDelayMs,

    maxFailedAttempts: source.maxFailedAttempts,
  });

  const sourceIndex = followerGroups.findIndex((group) => group.id === groupId);

  followerGroups = [
    ...followerGroups.slice(0, sourceIndex + 1),

    copy,

    ...followerGroups.slice(sourceIndex + 1),
  ];

  update();
}

function savedGroupMembers(saved: AnyRow): unknown[] {
  for (const candidate of [
    saved.wallets,
    saved.members,
    saved.addresses,
    saved.walletAddresses,
    saved.walletNames,
  ]) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function addSavedGroup(groupName: string): void {
  const saved = savedGroups().find((group) => group.name === groupName);

  if (!saved) {
    return;
  }

  const addresses = Array.from(
    new Set(savedGroupMembers(saved).map(walletAddress).filter(Boolean)),
  );

  if (!addresses.length) {
    state.error = `${groupName} has no resolvable wallets. Refresh wallets/groups and try again.`;

    update();
    return;
  }

  state.error = null;

  followerGroups = [
    ...followerGroups,

    newFollowerGroup({
      name: String(saved.name ?? "Wallet group"),

      sourceGroup: String(saved.name ?? groupName),

      wallets: addresses.map((address) => newFollowerWallet(address)),
    }),
  ];

  update();
}

function updateFollowerWallet(
  groupId: string,
  walletId: string,
  patch: Partial<FollowerWallet>,
): void {
  const group = followerGroups.find((item) => item.id === groupId);

  if (!group) {
    return;
  }

  mutateFollowerGroup(groupId, {
    wallets: group.wallets.map((wallet) =>
      wallet.id === walletId
        ? {
            ...wallet,
            ...patch,
          }
        : wallet,
    ),
  });
}

function removeFollowerWallet(groupId: string, walletId: string): void {
  const group = followerGroups.find((item) => item.id === groupId);

  if (!group || group.sourceGroup) {
    return;
  }

  if (group.wallets.length <= 1) {
    removeFollowerGroup(groupId);

    return;
  }

  mutateFollowerGroup(groupId, {
    wallets: group.wallets.filter((wallet) => wallet.id !== walletId),
  });
}

function numberValue(
  value: string,
  label: string,
  options: {
    minimum?: number;
    maximum?: number;
  } = {},
): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be numeric.`);
  }

  if (options.minimum != null && parsed < options.minimum) {
    throw new Error(`${label} must be at least ${options.minimum}.`);
  }

  if (options.maximum != null && parsed > options.maximum) {
    throw new Error(`${label} must be at most ${options.maximum}.`);
  }

  return parsed;
}

function percentToBps(value: string, label: string): number {
  return Math.round(
    numberValue(value, label, {
      minimum: 0,

      maximum: 100,
    }) * 100,
  );
}

function priorityFeeSolToMicroLamports(value: string): number {
  const sol = numberValue(value, "Priority fee SOL", {
    minimum: 0,
  });

  /**
   * total priority fee lamports =
   *   microLamportsPerCU * CU limit / 1,000,000
   */
  return Math.round((sol * 1_000_000_000 * 1_000_000) / BUYER_CU_LIMIT);
}

function payloadLabel(
  group: FollowerSettingsGroup,
  wallet: FollowerWallet,
): string {
  const resolved = walletByAddress(wallet.wallet);

  return String(
    resolved?.name ?? `${group.name} ${displayWallet(wallet.wallet)}`,
  );
}

function followerPlanPayload(): AnyRow[] {
  const output: AnyRow[] = [];

  const seen = new Set<string>();

  for (const group of followerGroups) {
    const minBps = percentToBps(group.minPct, `${group.name} minimum amount`);

    const maxBps = percentToBps(group.maxPct, `${group.name} maximum amount`);

    if (minBps > maxBps) {
      throw new Error(
        `${group.name}: minimum amount cannot exceed maximum amount.`,
      );
    }

    const tipSol = automaticSenderTip(group.sender);

    const prioritySol = numberValue(
      group.priorityFeeSol,
      `${group.name} priority SOL`,
      {
        minimum: 0,
      },
    );

    if (group.sender === "helius-fast" && prioritySol <= 0) {
      throw new Error(
        `${group.name}: Helius Sender requires a positive priority fee.`,
      );
    }

    const priorityMicroLamports = priorityFeeSolToMicroLamports(
      String(prioritySol),
    );

    const slippageBps = percentToBps(
      group.slippagePct,
      `${group.name} slippage`,
    );

    const retryIntervalMs = numberValue(
      group.retryIntervalMs,
      `${group.name} retry interval`,
      {
        minimum: 0,
      },
    );

    const recompileIntervalMs = numberValue(
      group.recompileIntervalMs,
      `${group.name} recompile interval`,
      {
        minimum: 0,
      },
    );

    const freshQuoteDelayMs = numberValue(
      group.freshQuoteDelayMs,
      `${group.name} fresh quote delay`,
    );

    const maxFailedAttempts = numberValue(
      group.maxFailedAttempts,
      `${group.name} max failed attempts`,
      {
        minimum: 0,
      },
    );

    for (const wallet of group.wallets) {
      const address = walletAddress(wallet.wallet).trim();

      if (!address) {
        continue;
      }

      const normalized = address.toLowerCase();

      if (seen.has(normalized)) {
        throw new Error(
          `${displayWallet(address)} appears more than once in the follower plan.`,
        );
      }

      seen.add(normalized);

      output.push({
        wallet: address,

        label: payloadLabel(group, wallet),

        amountMode: "range-bps",

        minBps,
        maxBps,

        reserveSol: BUYER_RESERVE_SOL,

        sender: group.sender,

        strategy: group.strategy,

        tipSol: group.sender === "helius-fast" ? tipSol : undefined,

        priorityMicroLamports,

        slippageBps,

        retryIntervalMs,

        recompileIntervalMs,

        freshQuoteDelayMs,

        maxFailedAttempts,
      });
    }
  }

  return output;
}

function tokenAlias(name: string, symbol: string): string {
  const value = (symbol || name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return value || `token-${Date.now()}`;
}

const LAUNCH_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const MAX_LAUNCH_IMAGE_BYTES = 12 * 1024 * 1024;

function onImageSelected(event: Event): void {
  const input = event.currentTarget as HTMLInputElement;

  let file = input.files?.[0] ?? null;

  if (file && !LAUNCH_IMAGE_TYPES.has(file.type)) {
    state.error = "Token image must be PNG, JPG, WEBP, or GIF.";

    input.value = "";

    file = null;
  }

  if (file && (file.size <= 0 || file.size > MAX_LAUNCH_IMAGE_BYTES)) {
    state.error = "Token image must be between 1 byte and 12 MB.";

    input.value = "";

    file = null;
  }

  if (file) {
    state.error = null;

    launchConfigNotice = null;
  }

  if (selectedImagePreview) {
    URL.revokeObjectURL(selectedImagePreview);
  }

  selectedImage = file;

  selectedImagePreview = file ? URL.createObjectURL(file) : null;

  update();
}

function walletOptions(selected: string) {
  const selectedValue = walletAddress(selected);

  const known = selectedValue ? walletByReference(selectedValue) : null;

  return (
    <>
      <option value="" selected={!selectedValue}>
        Select wallet…
      </option>

      {selectedValue && !known ? (
        <option value={selectedValue} selected>
          Unlisted · {displayWallet(selectedValue)}
        </option>
      ) : null}

      {wallets().map((wallet) => {
        const value = walletPublicValue(wallet);

        if (!value) {
          return null;
        }

        return (
          <option key={value} value={value} selected={value === selectedValue}>
            {walletLabel(wallet)}
          </option>
        );
      })}
    </>
  );
}

function FollowerGroupCard({ group }: { group: FollowerSettingsGroup }) {
  return (
    <section className="launch-follower-group" key={group.id}>
      <header className="launch-follower-head">
        <div>
          <span className="launch-group-kind">
            {group.sourceGroup ? "Saved wallet group" : "Custom follower set"}
          </span>

          <input
            className="launch-group-name"
            value={group.name}
            aria-label="Follower settings group name"
            onInput={(event: any) =>
              mutateFollowerGroup(group.id, {
                name: event.currentTarget.value,
              })
            }
          />
        </div>

        <div className="launch-follower-actions">
          <button
            type="button"
            className="secondary compact"
            onClick={() => cloneFollowerSettings(group.id)}
          >
            Clone settings
          </button>

          <button
            type="button"
            className="danger compact"
            onClick={() => removeFollowerGroup(group.id)}
          >
            Remove set
          </button>
        </div>
      </header>

      <div className="launch-shared-settings">
        <fieldset>
          <legend>Amount range</legend>

          <label>
            <span>Min %</span>

            <input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={group.minPct}
              onInput={(event: any) =>
                mutateFollowerGroup(group.id, {
                  minPct: event.currentTarget.value,
                })
              }
            />
          </label>

          <label>
            <span>Max %</span>

            <input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={group.maxPct}
              onInput={(event: any) =>
                mutateFollowerGroup(group.id, {
                  maxPct: event.currentTarget.value,
                })
              }
            />
          </label>

          <small>Keeps 0.02 SOL reserved automatically.</small>
        </fieldset>

        <fieldset>
          <legend>Fees & slippage</legend>

          <div className="launch-auto-fee">
            <span>Sender tip</span>

            <b>
              {group.sender === "helius-fast"
                ? `${HELIUS_SENDER_TIP_SOL} SOL`
                : "None"}
            </b>

            <small>
              {group.sender === "helius-fast"
                ? "Automatic Helius Sender dual-route minimum."
                : "Ordinary RPC does not use a Sender tip."}
            </small>
          </div>

          <label>
            <span>Priority SOL</span>

            <input
              type="number"
              min={group.sender === "helius-fast" ? "0.000000001" : "0"}
              step="0.000000001"
              value={group.priorityFeeSol}
              onInput={(event: any) =>
                mutateFollowerGroup(group.id, {
                  priorityFeeSol: event.currentTarget.value,
                })
              }
            />
          </label>

          <label>
            <span>Slippage %</span>

            <input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={group.slippagePct}
              onInput={(event: any) =>
                mutateFollowerGroup(group.id, {
                  slippagePct: event.currentTarget.value,
                })
              }
            />
          </label>

          <small>
            Priority SOL is the total per-buy budget and accepts values down to
            one lamport. Helius Sender requires a positive priority fee.
          </small>
        </fieldset>

        <fieldset className="launch-execution-settings">
          <legend>Execution</legend>

          <label>
            <span>Sender</span>

            <select
              value={group.sender}
              onInput={(event: any) =>
                mutateFollowerGroup(group.id, {
                  sender: event.currentTarget.value,
                })
              }
            >
              <option value="helius-fast">Helius fast</option>

              <option value="helius-rpc">Helius RPC</option>
            </select>
          </label>

          <label>
            <span>Buy timing</span>

            <select
              value={group.strategy}
              onInput={(event: any) =>
                mutateFollowerGroup(group.id, {
                  strategy: event.currentTarget.value,
                })
              }
            >
              <option value="fast-spam">1 · Fast spam</option>

              <option value="after-deploy-processed">
                2 · After deploy processed
              </option>

              <option value="spam-after-market-ready">
                3 · After market ready
              </option>

              <option value="after-deploy-confirmed">
                4 · After deploy confirmed
              </option>
            </select>
          </label>
        </fieldset>
      </div>

      <div className="launch-wallet-table-wrap">
        <table className="launch-wallet-table">
          <thead>
            <tr>
              <th>
                {group.sourceGroup
                  ? `Wallets from ${group.sourceGroup}`
                  : "Wallet"}
              </th>

              {!group.sourceGroup ? (
                <th aria-label="Remove wallet set" />
              ) : null}
            </tr>
          </thead>

          <tbody>
            {group.wallets.map((wallet) => (
              <tr key={wallet.id}>
                <td>
                  {group.sourceGroup ? (
                    <div className="launch-wallet-static">
                      <b>{displayWallet(wallet.wallet)}</b>

                      <small>{wallet.wallet}</small>
                    </div>
                  ) : (
                    <select
                      key={`${wallet.id}:${walletAddress(wallet.wallet)}:${wallets().length}`}
                      value={walletAddress(wallet.wallet)}
                      aria-label={`${group.name} wallet`}
                      onInput={(event: any) =>
                        updateFollowerWallet(group.id, wallet.id, {
                          wallet: walletAddress(event.currentTarget.value),
                        })
                      }
                    >
                      {walletOptions(wallet.wallet)}
                    </select>
                  )}
                </td>

                {!group.sourceGroup ? (
                  <td>
                    <button
                      type="button"
                      className="danger compact"
                      aria-label={`Remove ${group.name}`}
                      onClick={() => removeFollowerWallet(group.id, wallet.id)}
                    >
                      ×
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="launch-advanced">
        <summary>Advanced retry settings</summary>

        <div className="launch-advanced-grid">
          <label>
            <span>Retry interval ms</span>

            <input
              type="number"
              min="0"
              step="1"
              value={group.retryIntervalMs}
              onInput={(event: any) =>
                mutateFollowerGroup(group.id, {
                  retryIntervalMs: event.currentTarget.value,
                })
              }
            />
          </label>

          <label>
            <span>Recompile ms</span>

            <input
              type="number"
              min="0"
              step="1"
              value={group.recompileIntervalMs}
              onInput={(event: any) =>
                mutateFollowerGroup(group.id, {
                  recompileIntervalMs: event.currentTarget.value,
                })
              }
            />
          </label>

          <label>
            <span>Fresh quote delay ms</span>

            <input
              type="number"
              step="1"
              value={group.freshQuoteDelayMs}
              onInput={(event: any) =>
                mutateFollowerGroup(group.id, {
                  freshQuoteDelayMs: event.currentTarget.value,
                })
              }
            />
          </label>

          <label>
            <span>Max failed attempts</span>

            <input
              type="number"
              min="0"
              step="1"
              value={group.maxFailedAttempts}
              onInput={(event: any) =>
                mutateFollowerGroup(group.id, {
                  maxFailedAttempts: event.currentTarget.value,
                })
              }
            />
          </label>
        </div>
      </details>
    </section>
  );
}

function FollowersBuilder() {
  const groups = savedGroups();

  return (
    <section className="launch-panel launch-followers">
      <header className="launch-section-head">
        <div>
          <span className="section-kicker">03</span>

          <h3>Follower buyers</h3>

          <p>
            Each set shares amount, fees, sender, timing, slippage, and retry
            behavior. Clone settings creates a new blank-wallet set with the
            same configuration.
          </p>
        </div>

        <div className="launch-followers-toolbar">
          <select id="launch-saved-group" aria-label="Saved wallet group">
            <option value="">Add saved group…</option>

            {groups.map((group) => (
              <option key={group.name} value={group.name}>
                {group.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="secondary"
            onClick={() => {
              const select = document.getElementById(
                "launch-saved-group",
              ) as HTMLSelectElement | null;

              if (select?.value) {
                addSavedGroup(select.value);

                select.value = "";
              }
            }}
          >
            Add group
          </button>

          <button type="button" onClick={addIndividualGroup}>
            Add wallet
          </button>

          <details className="launch-execution-help">
            <summary>Sender & timing guide</summary>

            <div className="launch-execution-help-panel">
              <section>
                <h4>Sender</h4>

                <dl>
                  <div>
                    <dt>Helius Sender</dt>

                    <dd>
                      Fastest submission route. The page automatically adds the
                      0.0002 SOL dual-route Sender tip, requires a positive
                      priority fee, and sends without preflight.
                    </dd>
                  </div>

                  <div>
                    <dt>Helius RPC</dt>

                    <dd>
                      Standard RPC route with no Sender tip. Usually slower and
                      less aggressive, but useful when ultra-low-latency routing
                      is not required.
                    </dd>
                  </div>
                </dl>
              </section>

              <section>
                <h4>Buy timing · fastest to slowest</h4>

                <ol>
                  <li>
                    <b>Fast spam</b>

                    <span>
                      Fastest · lowest startup reliability. Sends immediately
                      and relies on retries while deployment/market accounts may
                      still be unavailable.
                    </span>
                  </li>

                  <li>
                    <b>After deploy processed</b>

                    <span>
                      Very fast · medium startup reliability. Waits for
                      processed status, but some market accounts may still need
                      a moment to become readable.
                    </span>
                  </li>

                  <li>
                    <b>After market ready</b>

                    <span>
                      Slightly slower · high startup reliability. Waits for the
                      required Pump market accounts to be visible before buying.
                    </span>
                  </li>

                  <li>
                    <b>After deploy confirmed</b>

                    <span>
                      Slowest · highest startup reliability. Waits for confirmed
                      deployment before the follower loop starts.
                    </span>
                  </li>
                </ol>

                <p>
                  Reliability here means avoiding early “market not ready”
                  attempts. It does not guarantee that a transaction lands.
                </p>
              </section>
            </div>
          </details>
        </div>
      </header>

      <div className="launch-follower-list">
        {followerGroups.map((group) => (
          <FollowerGroupCard key={group.id} group={group} />
        ))}

        {!followerGroups.length ? (
          <div className="launch-empty-followers">
            <b>No follower buyers.</b>

            <span>
              Deploy only, add a wallet with its own settings, or load a saved
              wallet group.
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function LaunchBuilder() {
  const deployerWallets = wallets();

  return (
    <form
      className="launch-builder"
      encType="multipart/form-data"
      onSubmit={(event) => {
        event.preventDefault();

        const form = event.currentTarget;

        void runAction(async () => {
          if (!selectedImage) {
            throw new Error("Choose a token image.");
          }

          const body = new FormData(form);

          body.set("image", selectedImage, selectedImage.name);

          const tokenName = String(body.get("name") ?? "");

          const tokenSymbol = String(body.get("symbol") ?? "");

          body.set("alias", tokenAlias(tokenName, tokenSymbol));

          if (!String(body.get("mintSuffix") ?? "").trim()) {
            body.set("mintSuffix", "pump");
          }

          body.set("buyPlanJson", JSON.stringify(followerPlanPayload()));

          body.set("live", "true");

          body.set(
            "skipSimulation",
            launchDraft.skipSimulation ? "true" : "false",
          );

          body.set("cashback", launchDraft.cashback ? "true" : "false");

          const started = await api<{
            id: string;
            status?: string;
            runnerVersion?: string;
          }>("/api/launch/pump", {
            method: "POST",

            body,
          });

          if (started.runnerVersion !== EXPECTED_LAUNCH_RUNNER_VERSION) {
            throw new Error(
              `The server is still running old Launch code (${started.runnerVersion ?? "no runner version"}). Restart the Solard web process before submitting again. This request was not accepted by the current runner.`,
            );
          }

          const now = Date.now();

          const optimisticJob: AnyRow = {
            id: started.id,

            kind: "launch:pump",

            status: started.status ?? "queued",

            createdAtMs: now,

            updatedAtMs: now,

            input: {
              name: tokenName,

              symbol: tokenSymbol,

              creator: launchDraft.creator,
            },

            logs: [],
          };

          state.selectedJobId = started.id;

          state.selectedJob = optimisticJob;

          state.jobs = [
            optimisticJob,

            ...state.jobs.filter((job) => String(job.id ?? "") !== started.id),
          ];

          launchConfigNotice =
            "Launch accepted. Preparing metadata and transactions now.";

          update();
          scheduleJobsPoll();

          void refreshJobs()
            .then(() => update())
            .catch((error) =>
              console.warn(
                "[solard:launch] immediate job refresh failed",
                error,
              ),
            );
        });
      }}
    >
      <section className="launch-hero">
        <div>
          <span className="section-kicker">Pump launch builder</span>

          <h2>Deploy token</h2>

          <p>
            Enter the token details, upload the image, choose the deployer, and
            optionally configure follower sets.
          </p>
        </div>

        <div className="launch-actions">
          <div className="launch-json-actions">
            <label className="secondary compact launch-json-import">
              Import JSON
              <input
                key={`launch-config-import:${configInputRevision}`}
                type="file"
                accept="application/json,.json"
                onInput={(event: Event) => {
                  void importLaunchJson(event);
                }}
              />
            </label>

            <button
              type="button"
              className="secondary compact"
              onClick={exportLaunchJson}
            >
              Export JSON
            </button>
          </div>

          <span
            className="launch-live-badge"
            title="Expected backend Launch runner"
          >
            Live · {EXPECTED_LAUNCH_RUNNER_VERSION}
          </span>

          <button type="submit" className="primary-large" disabled={state.busy}>
            {state.busy ? "Starting…" : "Start launch"}
          </button>
        </div>
      </section>

      {launchConfigNotice ? (
        <section className="launch-config-notice" role="status">
          <span>{launchConfigNotice}</span>

          <button
            type="button"
            className="secondary compact"
            onClick={() => {
              launchConfigNotice = null;

              update();
            }}
          >
            Dismiss
          </button>
        </section>
      ) : null}

      <LaunchRunSummary job={latestJob()} />

      <details className="launch-global-advanced">
        <summary>Advanced launch behavior</summary>

        <div>
          <p>
            This page always submits a live launch. These options are rarely
            needed.
          </p>

          <label className="toggle-card">
            <span>Skip simulation</span>

            <input
              type="checkbox"
              checked={launchDraft.skipSimulation}
              onInput={(event: any) =>
                mutateLaunchDraft({
                  skipSimulation: event.currentTarget.checked,
                })
              }
            />
          </label>

          <label className="toggle-card">
            <span>Cashback</span>

            <input
              type="checkbox"
              checked={launchDraft.cashback}
              onInput={(event: any) =>
                mutateLaunchDraft({
                  cashback: event.currentTarget.checked,
                })
              }
            />
          </label>
        </div>
      </details>

      <div className="launch-primary-grid">
        <section className="launch-panel launch-metadata">
          <header className="launch-section-head">
            <div>
              <span className="section-kicker">01</span>

              <h3>Token</h3>

              <p>
                These fields become the token metadata. No metadata path or URI
                is required.
              </p>
            </div>
          </header>

          <div className="launch-token-form">
            <label>
              <span>Image</span>

              <span className="launch-image-picker">
                <input
                  key={`launch-image:${imageInputRevision}`}
                  type="file"
                  name="image"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  onInput={onImageSelected}
                />

                <img
                  className={selectedImagePreview ? "visible" : ""}
                  src={selectedImagePreview ?? undefined}
                  alt=""
                  aria-hidden="true"
                />

                <span
                  className={`launch-image-empty ${selectedImagePreview ? "hidden" : ""}`}
                >
                  Upload PNG, JPG, WEBP, or GIF
                </span>

                <small>{selectedImage?.name ?? "No image selected"}</small>
              </span>
            </label>

            <div className="launch-name-row">
              <label>
                <span>Name</span>

                <input
                  name="name"
                  required
                  maxLength={32}
                  placeholder="Token name"
                  value={launchDraft.name}
                  onInput={(event: any) =>
                    mutateLaunchDraft({
                      name: event.currentTarget.value,
                    })
                  }
                />
              </label>

              <label>
                <span>Symbol</span>

                <input
                  name="symbol"
                  required
                  maxLength={10}
                  placeholder="TOKEN"
                  value={launchDraft.symbol}
                  onInput={(event: any) =>
                    mutateLaunchDraft({
                      symbol: event.currentTarget.value,
                    })
                  }
                />
              </label>
            </div>

            <label>
              <span>Description</span>

              <textarea
                name="description"
                rows={5}
                maxLength={500}
                required
                placeholder="What is this token?"
                value={launchDraft.description}
                onInput={(event: any) =>
                  mutateLaunchDraft({
                    description: event.currentTarget.value,
                  })
                }
              />
            </label>

            <div className="launch-social-row">
              <label>
                <span>Website</span>

                <input
                  type="url"
                  name="website"
                  placeholder="https://"
                  value={launchDraft.website}
                  onInput={(event: any) =>
                    mutateLaunchDraft({
                      website: event.currentTarget.value,
                    })
                  }
                />
              </label>

              <label>
                <span>X / Twitter</span>

                <input
                  name="twitter"
                  placeholder="https://x.com/…"
                  value={launchDraft.twitter}
                  onInput={(event: any) =>
                    mutateLaunchDraft({
                      twitter: event.currentTarget.value,
                    })
                  }
                />
              </label>

              <label>
                <span>Telegram</span>

                <input
                  name="telegram"
                  placeholder="https://t.me/…"
                  value={launchDraft.telegram}
                  onInput={(event: any) =>
                    mutateLaunchDraft({
                      telegram: event.currentTarget.value,
                    })
                  }
                />
              </label>
            </div>
          </div>
        </section>

        <section className="launch-panel launch-deployer">
          <header className="launch-section-head">
            <div>
              <span className="section-kicker">02</span>

              <h3>Deployer</h3>

              <p>Choose a loaded wallet and enter the optional creator buy.</p>
            </div>
          </header>

          <div className="launch-deployer-form">
            <label>
              <span>Deployer wallet</span>

              <select
                key={`launch-creator:${walletAddress(launchDraft.creator)}:${deployerWallets.length}`}
                name="creator"
                required
                value={walletAddress(launchDraft.creator)}
                onInput={(event: any) =>
                  mutateLaunchDraft({
                    creator: walletAddress(event.currentTarget.value),
                  })
                }
              >
                <option value="">Select deployer…</option>

                {walletAddress(launchDraft.creator) &&
                !deployerWallets.some(
                  (wallet) =>
                    walletPublicValue(wallet) ===
                    walletAddress(launchDraft.creator),
                ) ? (
                  <option value={walletAddress(launchDraft.creator)} selected>
                    Unlisted ·{" "}
                    {displayWallet(walletAddress(launchDraft.creator))}
                  </option>
                ) : null}

                {deployerWallets.map((wallet) => {
                  const value = walletPublicValue(wallet);

                  if (!value) {
                    return null;
                  }

                  return (
                    <option
                      key={value}
                      value={value}
                      selected={value === walletAddress(launchDraft.creator)}
                    >
                      {walletLabel(wallet)}
                    </option>
                  );
                })}
              </select>
            </label>

            <label>
              <span>Creator buy SOL</span>

              <input
                type="number"
                name="creatorBuySol"
                min="0"
                step="0.001"
                value={launchDraft.creatorBuySol}
                onInput={(event: any) =>
                  mutateLaunchDraft({
                    creatorBuySol: event.currentTarget.value,
                  })
                }
              />
            </label>

            <label>
              <span>Mint suffix</span>

              <input
                name="mintSuffix"
                value={launchDraft.mintSuffix}
                maxLength={12}
                autoComplete="off"
                onInput={(event: any) =>
                  mutateLaunchDraft({
                    mintSuffix: event.currentTarget.value,
                  })
                }
                onBlur={() => {
                  if (!launchDraft.mintSuffix.trim()) {
                    mutateLaunchDraft({
                      mintSuffix: "pump",
                    });
                  }
                }}
              />
            </label>

            <small className="launch-deployer-note">
              The suffix defaults to pump. Generation limits use the launcher's
              internal policy instead of extra form fields.
            </small>
          </div>
        </section>
      </div>

      <FollowersBuilder />

      <footer className="launch-submit-bar">
        <div>
          <b>Ready to launch</b>

          <span>
            {followerGroups.reduce(
              (count, group) =>
                count +
                group.wallets.filter((wallet) => Boolean(wallet.wallet.trim()))
                  .length,
              0,
            )}{" "}
            follower wallets configured
          </span>
        </div>

        <button type="submit" className="primary-large" disabled={state.busy}>
          {state.busy ? "Starting…" : "Start launch"}
        </button>
      </footer>
    </form>
  );
}

export function LaunchPage() {
  return (
    <main className="launch-page-direct">
      {state.error ? (
        <section className="launch-page-message bad" role="alert">
          <span>{state.error}</span>

          <button
            type="button"
            className="secondary compact"
            onClick={() => {
              state.error = null;

              update();
            }}
          >
            Dismiss
          </button>
        </section>
      ) : null}

      {state.loading ? (
        <section className="launch-page-message">
          Loading wallets, saved groups, and recent launches…
        </section>
      ) : null}

      <LaunchBuilder />
    </main>
  );
}

export default function mount() {
  unmounted = false;

  update();

  void loadLaunchPage();

  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      void Promise.allSettled([refreshOverview(), refreshJobs()]).then(() => {
        update();
        scheduleJobsPoll();
      });
    } else {
      clearJobsPoll();
    }
  };

  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    unmounted = true;

    document.removeEventListener("visibilitychange", onVisibility);

    clearJobsPoll();

    jobsPollInFlight = false;

    if (renderFrame != null) {
      cancelAnimationFrame(renderFrame);

      renderFrame = null;
    }

    renderPending = false;

    if (selectedImagePreview) {
      URL.revokeObjectURL(selectedImagePreview);

      selectedImagePreview = null;
    }

    selectedImage = null;
  };
}
