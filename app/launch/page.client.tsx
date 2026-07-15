import "./page.css";
import { render } from "tradjs/client";

type AnyRow = Record<string, any>;

type OverviewPayload = {
  wallets?: AnyRow[];
  groups?: AnyRow[];
};

type JobRow = {
  id: string;
  status?: string | null;
  createdAtMs?: number | null;
  updatedAtMs?: number | null;
  input?: AnyRow | null;
  result?: AnyRow | null;
  error?: unknown;
  message?: unknown;
  logs?: AnyRow[];
  [key: string]: any;
};

type LaunchStart = {
  id: string;
  status?: string | null;
  runnerVersion?: string | null;
};

type BundlerDraft = {
  id: string;
  wallet: string;
  minPct: string;
  maxPct: string;
  priorityFeeSol: string;
  slippagePct: string;
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
  skipSimulation: boolean;
  bundlers: BundlerDraft[];
};

type PageState = {
  overview: OverviewPayload;
  loadingWallets: boolean;
  submitting: boolean;
  polling: boolean;
  error: string | null;
  pollError: string | null;
  job: JobRow | null;
  imageFile: File | null;
  imagePreviewUrl: string | null;
  imageInputRevision: number;
};

const ACTIVE_JOB_STORAGE_KEY = "solard:active-pump-launch-job";
const MAX_BUNDLERS = 4;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const BUYER_RESERVE_SOL = "0.02";
const BUYER_CU_LIMIT = 600_000;
const POLL_INTERVAL_MS = 1_250;
const POLL_RETRY_MS = 3_000;

const state: PageState = {
  overview: { wallets: [], groups: [] },
  loadingWallets: true,
  submitting: false,
  polling: false,
  error: null,
  pollError: null,
  job: null,
  imageFile: null,
  imagePreviewUrl: null,
  imageInputRevision: 0,
};

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
  skipSimulation: false,
  bundlers: [],
};

let unmounted = false;
let renderFrame: number | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollRequestActive = false;
let nextId = 1;

function rootElement(): HTMLElement {
  const root = document.getElementById("app-root");
  if (!root) throw new Error("Missing #app-root.");
  return root;
}

function updateActiveNavigation(): void {
  document
    .querySelectorAll<HTMLAnchorElement>("#main-nav a")
    .forEach((link) =>
      link.classList.toggle("active", link.dataset.page === "launch"),
    );
}

function rerender(): void {
  if (unmounted || renderFrame != null) return;

  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;
    render(<LaunchPage />, rootElement(), { reconciler: "sequential" });
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
  const isFormData =
    typeof FormData !== "undefined" && options.body instanceof FormData;
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(isFormData
        ? {}
        : options.body
          ? { "content-type": "application/json" }
          : {}),
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

function shortAddress(value: unknown, head = 5, tail = 5): string {
  const valueText = text(value);
  if (valueText.length <= head + tail + 1) return valueText;
  return `${valueText.slice(0, head)}…${valueText.slice(-tail)}`;
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

function wallets(): AnyRow[] {
  return Array.isArray(state.overview.wallets) ? state.overview.wallets : [];
}

function walletName(address: string): string {
  const wallet = wallets().find((row) => walletAddress(row) === address);
  return (
    text(wallet?.name ?? wallet?.walletName ?? wallet?.wallet?.name) ||
    shortAddress(address)
  );
}

function newBundler(): BundlerDraft {
  return {
    id: `bundler-${nextId++}`,
    wallet: "",
    minPct: "50",
    maxPct: "80",
    priorityFeeSol: "0.0009",
    slippagePct: "2.5",
  };
}

function setDraft(patch: Partial<LaunchDraft>): void {
  launchDraft = { ...launchDraft, ...patch };
  state.error = null;
  rerender();
}

function updateBundler(id: string, patch: Partial<BundlerDraft>): void {
  launchDraft = {
    ...launchDraft,
    bundlers: launchDraft.bundlers.map((bundler) =>
      bundler.id === id ? { ...bundler, ...patch } : bundler,
    ),
  };
  state.error = null;
  rerender();
}

function addBundler(): void {
  if (launchDraft.bundlers.length >= MAX_BUNDLERS) return;
  setDraft({ bundlers: [...launchDraft.bundlers, newBundler()] });
}

function removeBundler(id: string): void {
  setDraft({
    bundlers: launchDraft.bundlers.filter((bundler) => bundler.id !== id),
  });
}

function setImage(file: File | null): void {
  if (state.imagePreviewUrl) URL.revokeObjectURL(state.imagePreviewUrl);

  state.imageFile = file;
  state.imagePreviewUrl = file ? URL.createObjectURL(file) : null;
  state.error = null;
  rerender();
}

function selectImage(file: File | null): void {
  if (!file) {
    setImage(null);
    return;
  }
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    state.error = "Token image must be PNG, JPG, WEBP, or GIF.";
    rerender();
    return;
  }
  if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
    state.error = "Token image must be between 1 byte and 12 MB.";
    rerender();
    return;
  }
  setImage(file);
}

function numberValue(
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

function percentToBps(value: string, label: string): number {
  return Math.round(numberValue(value, label, 0, 100) * 100);
}

function priorityFeeSolToMicroLamports(value: string): number {
  const sol = numberValue(value, "Priority fee", 0);
  return Math.round((sol * 1_000_000_000 * 1_000_000) / BUYER_CU_LIMIT);
}

function cleanMintSuffix(): string {
  const suffix = text(launchDraft.mintSuffix) || "pump";
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(suffix)) {
    throw new Error("Mint suffix must contain only base58 characters.");
  }
  if (suffix.length > 8) {
    throw new Error("Mint suffix must be at most 8 characters.");
  }
  return suffix;
}

function buyPlan(): AnyRow[] {
  const creator = text(launchDraft.creator).toLowerCase();
  const seen = new Set<string>();

  return launchDraft.bundlers
    .filter((bundler) => text(bundler.wallet))
    .map((bundler, index) => {
      const wallet = text(bundler.wallet);
      const normalized = wallet.toLowerCase();
      if (normalized === creator) {
        throw new Error(`Bundler ${index + 1} cannot use the deployer wallet.`);
      }
      if (seen.has(normalized)) {
        throw new Error(
          `Bundler wallet ${shortAddress(wallet)} is selected more than once.`,
        );
      }
      seen.add(normalized);

      const minBps = percentToBps(
        bundler.minPct,
        `Bundler ${index + 1} minimum balance percent`,
      );
      const maxBps = percentToBps(
        bundler.maxPct,
        `Bundler ${index + 1} maximum balance percent`,
      );
      if (minBps > maxBps) {
        throw new Error(`Bundler ${index + 1} minimum cannot exceed maximum.`);
      }

      const priorityMicroLamports = priorityFeeSolToMicroLamports(
        bundler.priorityFeeSol,
      );
      return {
        wallet,
        label: walletName(wallet),
        amountMode: "range-bps",
        minBps,
        maxBps,
        reserveSol: BUYER_RESERVE_SOL,
        priorityMicroLamports,
        slippageBps: percentToBps(
          bundler.slippagePct,
          `Bundler ${index + 1} slippage`,
        ),
        retryIntervalMs: 75,
        recompileIntervalMs: 750,
        freshQuoteDelayMs: -1,
        maxFailedAttempts: 0,
      };
    });
}

function validateLaunch(): void {
  if (!state.imageFile) throw new Error("Upload a token image.");
  if (!text(launchDraft.name)) throw new Error("Enter the token name.");
  if (!text(launchDraft.symbol)) throw new Error("Enter the token symbol.");
  if (!text(launchDraft.description))
    throw new Error("Enter a token description.");
  if (!text(launchDraft.creator))
    throw new Error("Select the deployer wallet.");
  numberValue(launchDraft.creatorBuySol, "Creator buy SOL", 0);
  cleanMintSuffix();
  buyPlan();
}

function tokenAlias(): string {
  return (
    text(launchDraft.symbol || launchDraft.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || `token-${Date.now()}`
  );
}

function launchFormData(): FormData {
  validateLaunch();
  const form = new FormData();
  form.set("image", state.imageFile as File);
  form.set("name", text(launchDraft.name));
  form.set("symbol", text(launchDraft.symbol));
  form.set("description", text(launchDraft.description));
  form.set("creator", text(launchDraft.creator));
  form.set(
    "creatorBuySol",
    String(numberValue(launchDraft.creatorBuySol, "Creator buy SOL", 0)),
  );
  form.set("mintSuffix", cleanMintSuffix());
  form.set("alias", tokenAlias());
  form.set("live", "true");
  if (launchDraft.skipSimulation) form.set("skipSimulation", "true");

  if (text(launchDraft.website)) form.set("website", text(launchDraft.website));
  if (text(launchDraft.twitter)) form.set("twitter", text(launchDraft.twitter));
  if (text(launchDraft.telegram))
    form.set("telegram", text(launchDraft.telegram));

  const plan = buyPlan();
  if (plan.length) form.set("buyPlanJson", JSON.stringify(plan));
  return form;
}

function normalizeStatus(status: unknown): string {
  return text(status)
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

function jobPhase(
  job: JobRow | null,
): "idle" | "pending" | "success" | "error" {
  if (!job) return "idle";
  const status = normalizeStatus(job.status);
  if (
    ["success", "succeeded", "completed", "complete", "done"].includes(
      status,
    ) ||
    status.startsWith("succeeded-") ||
    status.startsWith("completed-")
  ) {
    return "success";
  }
  if (
    ["failed", "failure", "error", "cancelled", "canceled", "aborted"].includes(
      status,
    ) ||
    status.startsWith("failed-") ||
    status.startsWith("error-")
  ) {
    return "error";
  }
  return "pending";
}

function isTerminal(job: JobRow | null): boolean {
  const phase = jobPhase(job);
  return phase === "success" || phase === "error";
}

function jobError(job: JobRow | null): string | null {
  if (!job) return null;
  const candidates = [
    job.error,
    job.message,
    job.result?.error,
    job.result?.message,
    job.result?.reason,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === "object" && "message" in candidate) {
      return String((candidate as { message: unknown }).message);
    }
    return String(candidate);
  }
  return null;
}

function jobMint(job: JobRow | null): string {
  return text(
    job?.result?.token?.mint ??
      job?.result?.mint ??
      job?.result?.mintAddress ??
      job?.input?.mintAddress,
  );
}

function jobSignature(job: JobRow | null): string {
  return text(
    job?.result?.signature ??
      job?.result?.transactionSignature ??
      job?.result?.createSignature ??
      job?.result?.token?.signature,
  );
}

function clearPollTimer(): void {
  if (pollTimer != null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function schedulePoll(delayMs: number): void {
  clearPollTimer();
  if (unmounted || !state.job || isTerminal(state.job)) return;
  pollTimer = setTimeout(() => void pollJob(state.job?.id ?? ""), delayMs);
}

async function pollJob(id: string): Promise<void> {
  if (!id || unmounted || pollRequestActive) return;
  pollRequestActive = true;
  state.polling = true;
  rerender();

  try {
    const job = await api<JobRow>(`/api/jobs?id=${encodeURIComponent(id)}`);
    if (!job?.id)
      throw new Error("Launch service returned an invalid job status.");

    state.job = job;
    state.pollError = null;

    if (isTerminal(job)) {
      localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
      clearPollTimer();
    } else {
      schedulePoll(
        document.visibilityState === "visible" ? POLL_INTERVAL_MS : 4_000,
      );
    }
  } catch (error) {
    state.pollError = error instanceof Error ? error.message : String(error);
    schedulePoll(POLL_RETRY_MS);
  } finally {
    pollRequestActive = false;
    state.polling = false;
    rerender();
  }
}

async function submitLaunch(): Promise<void> {
  if (state.submitting || jobPhase(state.job) === "pending") return;

  state.error = null;
  state.pollError = null;
  state.submitting = true;
  rerender();

  try {
    const started = await api<LaunchStart>("/api/launch/pump", {
      method: "POST",
      body: launchFormData(),
    });
    if (!started?.id)
      throw new Error("Launch service did not return a launch job ID.");

    const job: JobRow = { id: started.id, status: started.status ?? "queued" };
    state.job = job;
    localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, started.id);
    schedulePoll(0);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.submitting = false;
    rerender();
  }
}

async function refreshWallets(): Promise<void> {
  state.loadingWallets = true;
  rerender();
  try {
    const overview = await api<OverviewPayload>(
      "/api/overview?fast=1&balances=none",
    );
    state.overview = {
      wallets: Array.isArray(overview.wallets) ? overview.wallets : [],
      groups: Array.isArray(overview.groups) ? overview.groups : [],
    };
    state.error = null;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.loadingWallets = false;
    rerender();
  }
}

function resetForNextLaunch(): void {
  clearPollTimer();
  localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
  state.job = null;
  state.pollError = null;
  state.error = null;
  state.imageInputRevision += 1;
  setImage(null);
}

function copyValue(value: string): void {
  if (!value) return;
  void navigator.clipboard.writeText(value).catch((error) => {
    state.error = error instanceof Error ? error.message : String(error);
    rerender();
  });
}

function WalletOptions({ exclude = [] }: { exclude?: string[] }) {
  const blocked = new Set(exclude.filter(Boolean));
  return (
    <>
      <option value="">Select wallet…</option>
      {wallets().map((wallet) => {
        const address = walletAddress(wallet);
        if (!address || blocked.has(address)) return null;
        return (
          <option key={address} value={address}>
            {walletLabel(wallet)}
          </option>
        );
      })}
    </>
  );
}

function ImagePicker() {
  return (
    <label
      className={`launch-image-picker ${state.imagePreviewUrl ? "has-image" : ""}`}
    >
      <input
        key={`launch-image-${state.imageInputRevision}`}
        type="file"
        name="image"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onInput={(event: any) =>
          selectImage(event.currentTarget.files?.[0] ?? null)
        }
      />
      {state.imagePreviewUrl ? (
        <img src={state.imagePreviewUrl} alt="Token preview" />
      ) : (
        <span className="launch-image-placeholder" aria-hidden="true">
          +
        </span>
      )}
      <span>
        <b>{state.imageFile?.name ?? "Upload token image"}</b>
        <small>PNG, JPG, WEBP, or GIF · max 12 MB</small>
      </span>
    </label>
  );
}

function BundlerRow({
  bundler,
  index,
}: {
  bundler: BundlerDraft;
  index: number;
  key?: string;
}) {
  const selectedOtherWallets = launchDraft.bundlers
    .filter((row) => row.id !== bundler.id)
    .map((row) => row.wallet);

  return (
    <article className="launch-bundler-row">
      <header>
        <div>
          <span className="launch-step">Bundler {index + 1}</span>
          <b>{bundler.wallet ? walletName(bundler.wallet) : "Not selected"}</b>
        </div>
        <button
          type="button"
          className="secondary compact"
          onClick={() => removeBundler(bundler.id)}
        >
          Remove
        </button>
      </header>

      <div className="launch-bundler-grid">
        <label className="wide">
          <span>Wallet</span>
          <select
            value={bundler.wallet}
            onInput={(event: any) =>
              updateBundler(bundler.id, { wallet: event.currentTarget.value })
            }
          >
            <WalletOptions
              exclude={[launchDraft.creator, ...selectedOtherWallets]}
            />
          </select>
        </label>

        <label>
          <span>Use from balance</span>
          <div className="launch-range-inputs">
            <input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={bundler.minPct}
              aria-label={`Bundler ${index + 1} minimum balance percent`}
              onInput={(event: any) =>
                updateBundler(bundler.id, { minPct: event.currentTarget.value })
              }
            />
            <span>to</span>
            <input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={bundler.maxPct}
              aria-label={`Bundler ${index + 1} maximum balance percent`}
              onInput={(event: any) =>
                updateBundler(bundler.id, { maxPct: event.currentTarget.value })
              }
            />
            <span>%</span>
          </div>
        </label>
      </div>

      <details className="launch-advanced">
        <summary>Advanced transaction settings</summary>
        <div className="launch-advanced-grid">
          <label>
            <span>Priority fee SOL</span>
            <input
              type="number"
              min="0"
              step="0.0001"
              value={bundler.priorityFeeSol}
              onInput={(event: any) =>
                updateBundler(bundler.id, {
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
              value={bundler.slippagePct}
              onInput={(event: any) =>
                updateBundler(bundler.id, {
                  slippagePct: event.currentTarget.value,
                })
              }
            />
          </label>
        </div>
      </details>
    </article>
  );
}

function LaunchStatus() {
  if (!state.job) return null;

  const phase = jobPhase(state.job);
  const status = text(state.job.status) || "queued";
  const mint = jobMint(state.job);
  const signature = jobSignature(state.job);
  const error = jobError(state.job);

  return (
    <section className={`launch-status-card ${phase}`} aria-live="polite">
      <header>
        <div>
          <span className={`launch-status-dot ${phase}`} />
          <div>
            <span className="section-kicker">Jito bundle status</span>
            <h3>
              {phase === "success"
                ? "Launch completed"
                : phase === "error"
                  ? "Launch failed"
                  : "Launch in progress"}
            </h3>
          </div>
        </div>
        <span
          className={`pill ${phase === "success" ? "ok" : phase === "error" ? "bad" : "warn"}`}
        >
          {status}
        </span>
      </header>

      <dl className="launch-status-details">
        <div>
          <dt>Job</dt>
          <dd className="code">{state.job.id}</dd>
        </div>
        {mint ? (
          <div>
            <dt>Mint</dt>
            <dd>
              <button
                type="button"
                className="copy-value code"
                onClick={() => copyValue(mint)}
              >
                {mint}
              </button>
            </dd>
          </div>
        ) : null}
        {signature ? (
          <div>
            <dt>Signature</dt>
            <dd>
              <button
                type="button"
                className="copy-value code"
                onClick={() => copyValue(signature)}
              >
                {signature}
              </button>
            </dd>
          </div>
        ) : null}
      </dl>

      {phase === "pending" ? (
        <p className="muted">
          Signing, Jito submission, and confirmation are in progress. Status
          updates automatically.
        </p>
      ) : null}
      {state.pollError && phase === "pending" ? (
        <p className="launch-inline-error">
          Status temporarily unavailable: {state.pollError}. Retrying
          automatically.
        </p>
      ) : null}
      {phase === "error" && error ? (
        <p className="launch-inline-error">{error}</p>
      ) : null}

      <footer>
        {phase === "pending" ? (
          <button
            type="button"
            className="secondary"
            disabled={state.polling}
            onClick={() => void pollJob(state.job?.id ?? "")}
          >
            {state.polling ? "Checking…" : "Check now"}
          </button>
        ) : (
          <button
            type="button"
            className="secondary"
            onClick={resetForNextLaunch}
          >
            New launch
          </button>
        )}
        <a className="button-link secondary" href="/activity">
          Open activity
        </a>
      </footer>
    </section>
  );
}

function LaunchForm() {
  const active = jobPhase(state.job) === "pending";
  const disabled = state.submitting || active;
  const selectedBundlers = launchDraft.bundlers.filter(
    (row) => row.wallet,
  ).length;

  return (
    <form
      className="launch-form"
      encType="multipart/form-data"
      onSubmit={(event: any) => {
        event.preventDefault();
        void submitLaunch();
      }}
    >
      <section className="launch-hero">
        <div>
          <span className="section-kicker">Pump launch</span>
          <h2>Launch a token</h2>
          <p>
            Upload the image, choose the deployer, and optionally add up to four
            buyers. The launch is sent as an ordered Jito bundle.
          </p>
        </div>
        <div className="launch-hero-actions">
          <button
            type="button"
            className="secondary"
            disabled={state.loadingWallets || disabled}
            onClick={() => void refreshWallets()}
          >
            {state.loadingWallets ? "Loading wallets…" : "Refresh wallets"}
          </button>
          <button type="submit" className="primary-large" disabled={disabled}>
            {state.submitting
              ? "Starting launch…"
              : active
                ? "Launch in progress"
                : "Launch token"}
          </button>
        </div>
      </section>

      <div className="launch-main-grid">
        <section className="launch-panel launch-token-panel">
          <header className="launch-section-head">
            <div>
              <span className="launch-step">01</span>
              <h3>Token</h3>
            </div>
            <span className="muted small">Image and metadata</span>
          </header>

          <div className="launch-token-form">
            <ImagePicker />
            <div className="launch-name-grid">
              <label>
                <span>Name</span>
                <input
                  required
                  maxLength={64}
                  value={launchDraft.name}
                  onInput={(event: any) =>
                    setDraft({ name: event.currentTarget.value })
                  }
                />
              </label>
              <label>
                <span>Symbol</span>
                <input
                  required
                  maxLength={12}
                  value={launchDraft.symbol}
                  onInput={(event: any) =>
                    setDraft({
                      symbol: event.currentTarget.value.toUpperCase(),
                    })
                  }
                />
              </label>
            </div>
            <label>
              <span>Description</span>
              <textarea
                required
                rows={4}
                maxLength={500}
                value={launchDraft.description}
                onInput={(event: any) =>
                  setDraft({ description: event.currentTarget.value })
                }
              />
            </label>
            <details className="launch-advanced">
              <summary>Optional links</summary>
              <div className="launch-links-grid">
                <label>
                  <span>Website</span>
                  <input
                    type="url"
                    placeholder="https://"
                    value={launchDraft.website}
                    onInput={(event: any) =>
                      setDraft({ website: event.currentTarget.value })
                    }
                  />
                </label>
                <label>
                  <span>X / Twitter</span>
                  <input
                    placeholder="https://x.com/…"
                    value={launchDraft.twitter}
                    onInput={(event: any) =>
                      setDraft({ twitter: event.currentTarget.value })
                    }
                  />
                </label>
                <label>
                  <span>Telegram</span>
                  <input
                    placeholder="https://t.me/…"
                    value={launchDraft.telegram}
                    onInput={(event: any) =>
                      setDraft({ telegram: event.currentTarget.value })
                    }
                  />
                </label>
              </div>
            </details>
          </div>
        </section>

        <section className="launch-panel launch-execution-panel">
          <header className="launch-section-head">
            <div>
              <span className="launch-step">02</span>
              <h3>Execution</h3>
            </div>
            <span className="muted small">Jito bundle</span>
          </header>

          <div className="launch-execution-form">
            <label>
              <span>Deployer wallet</span>
              <select
                required
                value={launchDraft.creator}
                onInput={(event: any) =>
                  setDraft({ creator: event.currentTarget.value })
                }
              >
                <WalletOptions
                  exclude={launchDraft.bundlers.map((row) => row.wallet)}
                />
              </select>
            </label>
            <label>
              <span>Creator buy SOL</span>
              <input
                type="number"
                min="0"
                step="0.001"
                value={launchDraft.creatorBuySol}
                onInput={(event: any) =>
                  setDraft({ creatorBuySol: event.currentTarget.value })
                }
              />
            </label>
            <label>
              <span>Mint suffix</span>
              <input
                maxLength={8}
                value={launchDraft.mintSuffix}
                onInput={(event: any) =>
                  setDraft({ mintSuffix: event.currentTarget.value })
                }
              />
            </label>
            <label className="launch-checkbox">
              <input
                type="checkbox"
                checked={launchDraft.skipSimulation}
                onInput={(event: any) =>
                  setDraft({ skipSimulation: event.currentTarget.checked })
                }
              />
              <span>Skip simulation</span>
            </label>
          </div>
        </section>
      </div>

      <section className="launch-panel launch-bundlers-panel">
        <header className="launch-section-head">
          <div>
            <span className="launch-step">03</span>
            <h3>Bundler wallets</h3>
            <p>
              Optional buys are placed after deployment in the same Jito bundle.
            </p>
          </div>
          <button
            type="button"
            className="secondary"
            disabled={disabled || launchDraft.bundlers.length >= MAX_BUNDLERS}
            onClick={addBundler}
          >
            Add bundler ({launchDraft.bundlers.length}/{MAX_BUNDLERS})
          </button>
        </header>

        <div className="launch-jito-note" role="note">
          <b>Ordered Jito bundle</b>
          <span>
            Jito guarantees sequential execution inside the bundle: deployment
            runs first, then bundler wallet buys run in the order shown below.
          </span>
        </div>

        {launchDraft.bundlers.length ? (
          <div className="launch-bundlers-list">
            {launchDraft.bundlers.map((bundler, index) => (
              <BundlerRow key={bundler.id} bundler={bundler} index={index} />
            ))}
          </div>
        ) : (
          <button
            type="button"
            className="launch-empty-bundlers"
            disabled={disabled}
            onClick={addBundler}
          >
            <b>No bundler wallets</b>
            <span>
              Launch with the deployer only, or add up to four wallets.
            </span>
          </button>
        )}
      </section>

      <footer className="launch-submit-bar">
        <div>
          <b>
            {selectedBundlers
              ? `${selectedBundlers} bundler wallet${selectedBundlers === 1 ? "" : "s"} configured`
              : "Deployer-only launch"}
          </b>
          <span>Inputs stay locked while the launch is in progress.</span>
        </div>
        <button type="submit" className="primary-large" disabled={disabled}>
          {state.submitting
            ? "Starting launch…"
            : active
              ? "Launch in progress"
              : "Launch token"}
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
              rerender();
            }}
          >
            Dismiss
          </button>
        </section>
      ) : null}
      <LaunchStatus />
      <LaunchForm />
    </main>
  );
}

export default function mount() {
  unmounted = false;
  rerender();
  void refreshWallets();

  const savedJobId = text(localStorage.getItem(ACTIVE_JOB_STORAGE_KEY));
  if (savedJobId) {
    state.job = { id: savedJobId, status: "checking" };
    schedulePoll(0);
  }

  const onVisibility = () => {
    if (
      document.visibilityState === "visible" &&
      state.job &&
      !isTerminal(state.job)
    ) {
      schedulePoll(0);
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    unmounted = true;
    document.removeEventListener("visibilitychange", onVisibility);
    clearPollTimer();
    if (renderFrame != null) cancelAnimationFrame(renderFrame);
    renderFrame = null;
    if (state.imagePreviewUrl) URL.revokeObjectURL(state.imagePreviewUrl);
    state.imagePreviewUrl = null;
  };
}
