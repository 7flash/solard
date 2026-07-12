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

function walletLabel(wallet: AnyRow): string {
  const address = String(wallet.address ?? "");

  return wallet.name ? `${wallet.name} — ${shortAddress(address)}` : address;
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
          {String(fatal.value ?? job.error ?? "Unknown error").slice(0, 420)}
        </div>
      ) : null}

      {job.status === "running" ? (
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
    state.error = error instanceof Error ? error.message : String(error);

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
    ["running", "planned", "broadcast", "starting"].includes(
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

const BUYER_RESERVE_SOL = "0.02";

const BUYER_CU_LIMIT = 600_000;

type FollowerWallet = {
  id: string;
  wallet: string;

  sender: "helius-fast" | "helius-rpc";

  strategy:
    | "fast-spam"
    | "spam-after-market-ready"
    | "after-deploy-processed"
    | "after-deploy-confirmed";
};

type FollowerSettingsGroup = {
  id: string;
  name: string;
  sourceGroup: string | null;
  wallets: FollowerWallet[];

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

let followerGroups: FollowerSettingsGroup[] = [];

let selectedImage: File | null = null;

let selectedImagePreview: string | null = null;

function id(prefix: string): string {
  const suffix =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return `${prefix}:${suffix}`;
}

function newFollowerWallet(wallet = ""): FollowerWallet {
  return {
    id: id("wallet"),

    wallet,

    sender: "helius-fast",

    strategy: "fast-spam",
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

    minPct: "50",

    maxPct: "80",

    tipSol: "0.001",

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

function walletAddress(value: AnyRow): string {
  const raw = String(
    value.walletAddress ??
      value.address ??
      value.wallet?.address ??
      value.wallet?.name ??
      value.wallet ??
      "",
  ).trim();

  if (!raw) {
    return "";
  }

  const direct = walletByAddress(raw);

  if (direct?.address) {
    return String(direct.address);
  }

  const name = raw.replace(/^@/, "").toLowerCase();

  const named = wallets().find(
    (wallet) => String(wallet.name ?? "").toLowerCase() === name,
  );

  return String(named?.address ?? raw).trim();
}

function walletByAddress(address: string): AnyRow | null {
  const target = address.toLowerCase();

  return (
    wallets().find(
      (wallet) => String(wallet.address ?? "").toLowerCase() === target,
    ) ?? null
  );
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
  followerGroups = followerGroups.map((group) =>
    group.id === groupId
      ? {
          ...group,
          ...patch,
        }
      : group,
  );

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
      name: `Individual ${number}`,
    }),
  ];

  update();
}

function addSavedGroup(groupName: string): void {
  const saved = savedGroups().find((group) => group.name === groupName);

  if (!saved) {
    return;
  }

  const addresses = Array.from(
    new Set((saved.wallets ?? []).map(walletAddress).filter(Boolean)),
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

function addWalletToFollowerGroup(groupId: string): void {
  const group = followerGroups.find((item) => item.id === groupId);

  if (!group) {
    return;
  }

  mutateFollowerGroup(groupId, {
    wallets: [...group.wallets, newFollowerWallet()],
  });
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

  if (!group) {
    return;
  }

  const remaining = group.wallets.filter((wallet) => wallet.id !== walletId);

  mutateFollowerGroup(groupId, {
    wallets: remaining.length ? remaining : [newFollowerWallet()],
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

    const tipSol = String(
      numberValue(group.tipSol, `${group.name} tip SOL`, {
        minimum: 0,
      }),
    );

    const priorityMicroLamports = priorityFeeSolToMicroLamports(
      group.priorityFeeSol,
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
      const address = wallet.wallet.trim();

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

        sender: wallet.sender,

        strategy: wallet.strategy,

        tipSol: wallet.sender === "helius-fast" ? tipSol : undefined,

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
  }

  if (selectedImagePreview) {
    URL.revokeObjectURL(selectedImagePreview);
  }

  selectedImage = file;

  selectedImagePreview = file ? URL.createObjectURL(file) : null;

  update();
}

function walletOptions(selected: string) {
  const known = selected ? walletByAddress(selected) : null;

  return (
    <>
      <option value="">Select wallet…</option>

      {selected && !known ? (
        <option value={selected}>Unlisted · {displayWallet(selected)}</option>
      ) : null}

      {wallets().map((wallet) => (
        <option key={wallet.address} value={wallet.address}>
          {walletLabel(wallet)}
        </option>
      ))}
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
            onClick={() => addWalletToFollowerGroup(group.id)}
          >
            Add wallet
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

          <label>
            <span>Tip SOL</span>

            <input
              type="number"
              min="0"
              step="0.0001"
              value={group.tipSol}
              onInput={(event: any) =>
                mutateFollowerGroup(group.id, {
                  tipSol: event.currentTarget.value,
                })
              }
            />
          </label>

          <label>
            <span>Priority SOL</span>

            <input
              type="number"
              min="0"
              step="0.0001"
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
            Priority SOL is the total per-buy priority budget, converted with
            the launcher's 600K compute-unit cap.
          </small>
        </fieldset>
      </div>

      <div className="launch-wallet-table-wrap">
        <table className="launch-wallet-table">
          <thead>
            <tr>
              <th>Wallet</th>

              <th>Sender</th>

              <th>Buy timing</th>

              <th aria-label="Remove wallet" />
            </tr>
          </thead>

          <tbody>
            {group.wallets.map((wallet) => (
              <tr key={wallet.id}>
                <td>
                  <select
                    value={wallet.wallet}
                    onInput={(event: any) =>
                      updateFollowerWallet(group.id, wallet.id, {
                        wallet: event.currentTarget.value,
                      })
                    }
                  >
                    {walletOptions(wallet.wallet)}
                  </select>
                </td>

                <td>
                  <select
                    value={wallet.sender}
                    onInput={(event: any) =>
                      updateFollowerWallet(group.id, wallet.id, {
                        sender: event.currentTarget.value,
                      })
                    }
                  >
                    <option value="helius-fast">Helius fast</option>

                    <option value="helius-rpc">Helius RPC</option>
                  </select>
                </td>

                <td>
                  <select
                    value={wallet.strategy}
                    onInput={(event: any) =>
                      updateFollowerWallet(group.id, wallet.id, {
                        strategy: event.currentTarget.value,
                      })
                    }
                  >
                    <option value="fast-spam">Fast spam</option>

                    <option value="spam-after-market-ready">
                      After market ready
                    </option>

                    <option value="after-deploy-processed">
                      After deploy processed
                    </option>

                    <option value="after-deploy-confirmed">
                      After deploy confirmed
                    </option>
                  </select>
                </td>

                <td>
                  <button
                    type="button"
                    className="danger compact"
                    aria-label={`Remove ${displayWallet(wallet.wallet)}`}
                    onClick={() => removeFollowerWallet(group.id, wallet.id)}
                  >
                    ×
                  </button>
                </td>
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
            A settings set shares amount, fees, slippage, and retry behavior.
            Every follower wallet remains one compact table row with its own
            sender and buy timing.
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
            Add individual
          </button>
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
              Deploy only, add an individual wallet, or load a saved wallet
              group.
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

          body.set(
            "live",
            form.querySelector<HTMLInputElement>("[name=live]")?.checked
              ? "true"
              : "false",
          );

          body.set(
            "skipSimulation",
            form.querySelector<HTMLInputElement>("[name=skipSimulation]")
              ?.checked
              ? "true"
              : "false",
          );

          body.set(
            "cashback",
            form.querySelector<HTMLInputElement>("[name=cashback]")?.checked
              ? "true"
              : "false",
          );

          const started = await api<{
            id: string;
          }>("/api/launch/pump", {
            method: "POST",

            body,
          });

          state.selectedJobId = started.id;

          await refreshJobs();
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
          <label className="toggle-card">
            <span>Live</span>

            <input type="checkbox" name="live" />
          </label>

          <label className="toggle-card">
            <span>Skip simulation (live)</span>

            <input type="checkbox" name="skipSimulation" />
          </label>

          <label className="toggle-card">
            <span>Cashback</span>

            <input type="checkbox" name="cashback" defaultChecked />
          </label>

          <button type="submit" className="primary-large" disabled={state.busy}>
            {state.busy ? "Starting…" : "Start launch"}
          </button>
        </div>
      </section>

      <LaunchRunSummary job={latestJob()} />

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
                  type="file"
                  name="image"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  required
                  onInput={onImageSelected}
                />

                {selectedImagePreview ? (
                  <img src={selectedImagePreview} alt="Selected token" />
                ) : (
                  <span className="launch-image-empty">
                    Upload PNG, JPG, WEBP, or GIF
                  </span>
                )}

                {selectedImage ? <small>{selectedImage.name}</small> : null}
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
                />
              </label>

              <label>
                <span>Symbol</span>

                <input
                  name="symbol"
                  required
                  maxLength={10}
                  placeholder="TOKEN"
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
              />
            </label>

            <div className="launch-social-row">
              <label>
                <span>Website</span>

                <input type="url" name="website" placeholder="https://" />
              </label>

              <label>
                <span>X / Twitter</span>

                <input name="twitter" placeholder="https://x.com/…" />
              </label>

              <label>
                <span>Telegram</span>

                <input name="telegram" placeholder="https://t.me/…" />
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

              <select name="creator" required>
                <option value="">Select deployer…</option>

                {deployerWallets.map((wallet) => (
                  <option key={wallet.address} value={wallet.address}>
                    {walletLabel(wallet)}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Creator buy SOL</span>

              <input
                type="number"
                name="creatorBuySol"
                min="0"
                step="0.001"
                defaultValue="0"
              />
            </label>

            <label>
              <span>Mint suffix</span>

              <input
                name="mintSuffix"
                defaultValue="pump"
                maxLength={12}
                autoComplete="off"
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
