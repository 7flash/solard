import "./page.css";
import { render } from "tradjs/client";
import { api } from "../_client/api";
import { short } from "../_client/format";
import { storageFlag, storageJson, storageSet } from "../_client/storage";

type AnyRow = Record<string, any>;
type DistributionMode = "fixed" | "equal-total" | "pro-rata";

type Holder = {
  owner?: string;
  tokenAccount?: string;
  amountUi?: number | string;
  uiAmount?: number | string;
  balanceUi?: number | string;
  pctSupply?: number | string;
  percent?: number | string;
  rank?: number;
};

type HoldersPayload = {
  mint?: string;
  holders?: Holder[];
  supply?: unknown;
  stale?: boolean;
  updatedAtMs?: number;
};

type OverviewPayload = {
  wallets?: AnyRow[];
};

type AirdropDraft = {
  name: string;
  sourceMint: string;
  payoutMint: string;
  bankWallet: string;
  holderLimit: string;
  minBalanceUi: string;
  minSharePct: string;
  excludedOwners: string;
  mode: DistributionMode;
  fixedAmountUi: string;
  totalAmountUi: string;
  payoutDecimals: string;
  memo: string;
  live: boolean;
  confirmation: string;
};

type Recipient = {
  owner: string;
  sourceBalanceUi: number;
  sourceSharePct: number;
  amountUi: string;
};

type AirdropPlan = {
  name: string;
  bankWallet: string;
  sourceMint: string;
  payoutMint: string;
  payoutDecimals: number;
  mode: DistributionMode;
  memo: string | null;
  recipientCount: number;
  totalAmountUi: string;
  recipients: Recipient[];
};

const DRAFT_KEY = "solard:airdrops:draft:v1";
const AUTO_REFRESH_KEY = "solard:airdrops:auto-refresh";
const BANK_SAVED_KEY = "solard:airdrops:bank-saved";

const defaultDraft: AirdropDraft = {
  name: "Holder rewards",
  sourceMint: "",
  payoutMint: "",
  bankWallet: "",
  holderLimit: "50",
  minBalanceUi: "0",
  minSharePct: "0",
  excludedOwners: "",
  mode: "fixed",
  fixedAmountUi: "1",
  totalAmountUi: "1000",
  payoutDecimals: "6",
  memo: "Holder rewards",
  live: false,
  confirmation: "",
};

let draft = {
  ...defaultDraft,
  ...storageJson<Partial<AirdropDraft>>(DRAFT_KEY, {}),
};

const state = {
  wallets: [] as AnyRow[],
  holders: null as HoldersPayload | null,
  previousSnapshot: {} as Record<string, number>,
  loading: false,
  executing: false,
  error: null as string | null,
  message: "Enter a source token mint to begin tracking holders.",
  loadedAtMs: null as number | null,
  autoRefresh: storageFlag(AUTO_REFRESH_KEY, false),
  bankSaved: storageFlag(BANK_SAVED_KEY, false),
};

let unmounted = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function rootElement(): HTMLElement {
  const value = document.getElementById("app-root");
  if (!value) throw new Error("Missing #app-root");
  return value;
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function holderOwner(holder: Holder): string {
  return String(holder.owner ?? holder.tokenAccount ?? "").trim();
}

function holderBalance(holder: Holder): number {
  return finite(holder.amountUi ?? holder.uiAmount ?? holder.balanceUi, 0);
}

function holderShare(holder: Holder): number {
  return finite(holder.pctSupply ?? holder.percent, 0);
}

function walletAddress(wallet: AnyRow): string {
  const nested = wallet?.wallet;
  const account = wallet?.account;
  const value =
    wallet?.walletAddress ??
    wallet?.address ??
    wallet?.publicKey ??
    wallet?.pubkey ??
    nested?.address ??
    nested?.walletAddress ??
    nested?.publicKey ??
    nested?.pubkey ??
    account?.address ??
    account?.publicKey ??
    account?.pubkey ??
    "";
  return String(value).trim();
}

function walletLabel(wallet: AnyRow): string {
  const address = walletAddress(wallet);
  return String(
    wallet?.name ?? wallet?.label ?? wallet?.alias ?? short(address, 6, 6),
  );
}

function snapshotKey(mint: string): string {
  return `solard:airdrops:snapshot:${mint.trim()}`;
}

function currentSnapshot(holders: Holder[]): Record<string, number> {
  return Object.fromEntries(
    holders
      .map((holder) => [holderOwner(holder), holderBalance(holder)] as const)
      .filter(([owner]) => Boolean(owner)),
  );
}

function saveDraft(): void {
  storageSet(DRAFT_KEY, JSON.stringify(draft));
}

function updateDraft(patch: Partial<AirdropDraft>): void {
  draft = { ...draft, ...patch };
  saveDraft();
  rerender();
}

function excludedOwners(): Set<string> {
  return new Set(
    draft.excludedOwners
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function eligibleHolders(): Holder[] {
  const excluded = excludedOwners();
  const minimumBalance = Math.max(0, finite(draft.minBalanceUi, 0));
  const minimumShare = Math.max(0, finite(draft.minSharePct, 0));
  const bank = draft.bankWallet.trim();

  return (state.holders?.holders ?? []).filter((holder) => {
    const owner = holderOwner(holder);
    if (!owner || owner === bank || excluded.has(owner)) return false;
    return (
      holderBalance(holder) >= minimumBalance &&
      holderShare(holder) >= minimumShare
    );
  });
}

function decimals(): number {
  return Math.max(0, Math.min(18, Math.floor(finite(draft.payoutDecimals, 0))));
}

function amountText(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return value.toFixed(decimals()).replace(/\.?0+$/, "");
}

function buildPlan(): AirdropPlan {
  const holders = eligibleHolders();
  if (!draft.sourceMint.trim())
    throw new Error("Source token mint is required.");
  if (!draft.payoutMint.trim())
    throw new Error("Payout token mint is required.");
  if (!draft.bankWallet.trim()) throw new Error("Select a bank wallet.");
  if (!holders.length) throw new Error("No holders match the current filters.");

  const totalSourceBalance = holders.reduce(
    (sum, holder) => sum + holderBalance(holder),
    0,
  );
  const requestedTotal = Math.max(0, finite(draft.totalAmountUi, 0));
  const fixedAmount = Math.max(0, finite(draft.fixedAmountUi, 0));

  const recipients = holders.map((holder) => {
    const sourceBalanceUi = holderBalance(holder);
    let amount = fixedAmount;

    if (draft.mode === "equal-total") {
      amount = requestedTotal / holders.length;
    } else if (draft.mode === "pro-rata") {
      amount =
        totalSourceBalance > 0
          ? requestedTotal * (sourceBalanceUi / totalSourceBalance)
          : 0;
    }

    return {
      owner: holderOwner(holder),
      sourceBalanceUi,
      sourceSharePct: holderShare(holder),
      amountUi: amountText(amount),
    };
  });

  if (recipients.some((recipient) => finite(recipient.amountUi, 0) <= 0)) {
    throw new Error("Every recipient amount must be greater than zero.");
  }

  const totalAmountUi = amountText(
    recipients.reduce(
      (sum, recipient) => sum + finite(recipient.amountUi, 0),
      0,
    ),
  );

  return {
    name: draft.name.trim() || "Holder rewards",
    bankWallet: draft.bankWallet.trim(),
    sourceMint: draft.sourceMint.trim(),
    payoutMint: draft.payoutMint.trim(),
    payoutDecimals: decimals(),
    mode: draft.mode,
    memo: draft.memo.trim() || null,
    recipientCount: recipients.length,
    totalAmountUi,
    recipients,
  };
}

function planOrNull(): AirdropPlan | null {
  try {
    return buildPlan();
  } catch {
    return null;
  }
}

function setShellStatus(status: string, healthy: boolean): void {
  const connection = document.getElementById("connection-status");
  if (connection) {
    connection.textContent = status;
    connection.className = `pill ${healthy ? "ok" : "bad"}`;
  }
  const refreshed = document.getElementById("last-refresh");
  if (refreshed) {
    refreshed.textContent = state.loadedAtMs
      ? `holders ${new Date(state.loadedAtMs).toLocaleTimeString()}`
      : "—";
  }
}

function rerender(): void {
  if (unmounted) return;
  render(<AirdropsPage />, rootElement());
  document
    .querySelectorAll<HTMLAnchorElement>("#main-nav a")
    .forEach((link) =>
      link.classList.toggle("active", link.dataset.page === "airdrops"),
    );
  setShellStatus(state.error ? "error" : "ready", !state.error);
}

function scheduleRefresh(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!state.autoRefresh || unmounted) return;
  timer = setTimeout(() => void loadHolders(false), 30_000);
}

async function loadWallets(): Promise<void> {
  try {
    const overview = await api<OverviewPayload>(
      "/api/overview?fast=1&balances=none",
    );
    state.wallets = Array.isArray(overview?.wallets) ? overview.wallets : [];
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  }
}

async function loadHolders(refresh: boolean): Promise<void> {
  const mint = draft.sourceMint.trim();
  if (!mint) {
    state.error = "Source token mint is required.";
    rerender();
    return;
  }

  state.loading = true;
  state.error = null;
  state.message = refresh
    ? "Refreshing holder snapshot…"
    : "Loading holder snapshot…";
  rerender();

  try {
    const limit = Math.max(
      1,
      Math.min(50, Math.floor(finite(draft.holderLimit, 50))),
    );
    const oldSnapshot = storageJson<Record<string, number>>(
      snapshotKey(mint),
      {},
    );
    const value = await api<HoldersPayload>(
      `/api/token-holders?mint=${encodeURIComponent(mint)}&limit=${limit}&refresh=${refresh ? "1" : "0"}`,
    );
    const holders = Array.isArray(value?.holders) ? value.holders : [];
    state.previousSnapshot = oldSnapshot;
    state.holders = { ...value, holders };
    state.loadedAtMs = Date.now();
    state.message = `${holders.length} holder${holders.length === 1 ? "" : "s"} tracked.`;
    storageSet(snapshotKey(mint), JSON.stringify(currentSnapshot(holders)));
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.message = "Holder lookup failed.";
  } finally {
    state.loading = false;
    rerender();
    scheduleRefresh();
  }
}

function saveBank(): void {
  if (!draft.bankWallet.trim()) {
    state.error = "Select a managed wallet for the bank.";
    rerender();
    return;
  }
  if (!draft.payoutMint.trim()) {
    state.error = "Payout token mint is required.";
    rerender();
    return;
  }
  state.bankSaved = true;
  state.error = null;
  state.message =
    "Bank profile saved locally. Funding and signing stay server-side.";
  storageSet(BANK_SAVED_KEY, "1");
  saveDraft();
  rerender();
}

async function submitPlan(live: boolean): Promise<void> {
  let plan: AirdropPlan;
  try {
    plan = buildPlan();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    rerender();
    return;
  }

  if (live && draft.confirmation !== "AIRDROP") {
    state.error = 'Type "AIRDROP" before executing a live distribution.';
    rerender();
    return;
  }

  state.executing = true;
  state.error = null;
  state.message = live ? "Submitting live airdrop…" : "Validating payout plan…";
  rerender();

  try {
    const result = await api<AnyRow>("/api/airdrops/distribute", {
      method: "POST",
      body: JSON.stringify({ ...plan, live, confirmation: draft.confirmation }),
    });
    state.message = live
      ? `Airdrop submitted: ${String(result?.status ?? "accepted")}.`
      : `Plan validated: ${plan.recipientCount} recipients, ${plan.totalAmountUi} tokens.`;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.message = live
      ? "Live distribution was not submitted."
      : "Plan validation failed.";
  } finally {
    state.executing = false;
    rerender();
  }
}

function downloadCsv(): void {
  try {
    const plan = buildPlan();
    const lines = [
      "owner,amount_ui,source_balance_ui,source_share_pct",
      ...plan.recipients.map((recipient) =>
        [
          recipient.owner,
          recipient.amountUi,
          recipient.sourceBalanceUi,
          recipient.sourceSharePct,
        ].join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${plan.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "airdrop"}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    rerender();
  }
}

function deltaFor(holder: Holder): number | null {
  const owner = holderOwner(holder);
  if (!Object.prototype.hasOwnProperty.call(state.previousSnapshot, owner))
    return null;
  return holderBalance(holder) - finite(state.previousSnapshot[owner], 0);
}

function formatNumber(value: unknown, maximumFractionDigits = 6): string {
  const number = finite(value, 0);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(
    number,
  );
}

function AirdropsPage() {
  const holders = state.holders?.holders ?? [];
  const eligible = eligibleHolders();
  const plan = planOrNull();

  return (
    <div className="airdrops-page">
      <header className="airdrops-hero">
        <div>
          <div className="section-kicker">Holder rewards</div>
          <h2>Airdrops</h2>
          <p className="muted">
            Track holders of one token, configure a managed wallet as the bank,
            and distribute another token using fixed, equal, or pro-rata
            payouts.
          </p>
        </div>
        <div className="airdrops-hero-actions">
          <button
            type="button"
            className="secondary"
            disabled={state.loading}
            onClick={() => void loadHolders(true)}
          >
            {state.loading ? "Refreshing…" : "Refresh holders"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!plan}
            onClick={downloadCsv}
          >
            Export CSV
          </button>
        </div>
      </header>

      {state.error ? (
        <div className="global-error-strip">
          <span className="pill bad">{state.error}</span>
        </div>
      ) : null}
      <div className="airdrops-status-row">
        <span className={`pill ${state.holders?.stale ? "warn" : "ok"}`}>
          {state.holders?.stale ? "stale snapshot" : "tracker ready"}
        </span>
        <span className="muted small">{state.message}</span>
        <label className="airdrops-inline-check">
          <input
            type="checkbox"
            checked={state.autoRefresh}
            onChange={(event: any) => {
              state.autoRefresh = Boolean(event.currentTarget.checked);
              storageSet(AUTO_REFRESH_KEY, state.autoRefresh ? "1" : "0");
              scheduleRefresh();
              rerender();
            }}
          />
          refresh every 30s
        </label>
      </div>

      <div className="airdrops-grid">
        <section className="card airdrops-config-card">
          <div className="row between">
            <div>
              <div className="section-kicker">1 · Track</div>
              <h3>Holder source</h3>
            </div>
            <span className="pill">top {draft.holderLimit || "50"}</span>
          </div>

          <label>
            Source token mint
            <input
              className="code"
              value={draft.sourceMint}
              placeholder="Token whose holders receive the airdrop"
              onInput={(event: any) =>
                updateDraft({ sourceMint: event.currentTarget.value })
              }
            />
          </label>

          <div className="airdrops-form-row three">
            <label>
              Holder limit
              <select
                value={draft.holderLimit}
                onChange={(event: any) =>
                  updateDraft({ holderLimit: event.currentTarget.value })
                }
              >
                <option value="10">10</option>
                <option value="20">20</option>
                <option value="50">50</option>
              </select>
            </label>
            <label>
              Min balance
              <input
                inputMode="decimal"
                value={draft.minBalanceUi}
                onInput={(event: any) =>
                  updateDraft({ minBalanceUi: event.currentTarget.value })
                }
              />
            </label>
            <label>
              Min supply %
              <input
                inputMode="decimal"
                value={draft.minSharePct}
                onInput={(event: any) =>
                  updateDraft({ minSharePct: event.currentTarget.value })
                }
              />
            </label>
          </div>

          <label>
            Excluded owners
            <textarea
              className="code"
              rows={3}
              value={draft.excludedOwners}
              placeholder="Comma, space, or newline separated wallet addresses"
              onInput={(event: any) =>
                updateDraft({ excludedOwners: event.currentTarget.value })
              }
            />
          </label>

          <button
            type="button"
            disabled={state.loading || !draft.sourceMint.trim()}
            onClick={() => void loadHolders(true)}
          >
            {state.loading ? "Loading holders…" : "Track holders"}
          </button>
        </section>

        <section className="card airdrops-config-card">
          <div className="row between">
            <div>
              <div className="section-kicker">2 · Bank</div>
              <h3>Distribution bank</h3>
            </div>
            <span className={`pill ${state.bankSaved ? "ok" : "warn"}`}>
              {state.bankSaved ? "saved" : "draft"}
            </span>
          </div>

          <label>
            Bank profile name
            <input
              value={draft.name}
              onInput={(event: any) =>
                updateDraft({ name: event.currentTarget.value })
              }
            />
          </label>

          <label>
            Managed bank wallet
            <select
              value={draft.bankWallet}
              onChange={(event: any) =>
                updateDraft({ bankWallet: event.currentTarget.value })
              }
            >
              <option value="">Select wallet…</option>
              {state.wallets.map((wallet) => {
                const address = walletAddress(wallet);
                return address ? (
                  <option value={address}>
                    {walletLabel(wallet)} · {short(address, 5, 5)}
                  </option>
                ) : null;
              })}
            </select>
          </label>

          <label>
            Payout token mint
            <input
              className="code"
              value={draft.payoutMint}
              placeholder="Token held by the bank wallet"
              onInput={(event: any) =>
                updateDraft({ payoutMint: event.currentTarget.value })
              }
            />
          </label>

          <div className="airdrops-form-row two">
            <label>
              Token decimals
              <input
                inputMode="numeric"
                value={draft.payoutDecimals}
                onInput={(event: any) =>
                  updateDraft({ payoutDecimals: event.currentTarget.value })
                }
              />
            </label>
            <label>
              Memo
              <input
                value={draft.memo}
                onInput={(event: any) =>
                  updateDraft({ memo: event.currentTarget.value })
                }
              />
            </label>
          </div>

          <div className="row gap">
            <button type="button" onClick={saveBank}>
              Create bank profile
            </button>
            <a className="button-link secondary" href="/wallets">
              Manage wallets
            </a>
          </div>
          <p className="muted small">
            The bank is an existing server-managed wallet. This page never asks
            for or stores a private key.
          </p>
        </section>

        <section className="card airdrops-config-card">
          <div>
            <div className="section-kicker">3 · Allocate</div>
            <h3>Payout rules</h3>
          </div>

          <label>
            Distribution mode
            <select
              value={draft.mode}
              onChange={(event: any) =>
                updateDraft({
                  mode: event.currentTarget.value as DistributionMode,
                })
              }
            >
              <option value="fixed">Fixed amount per holder</option>
              <option value="equal-total">Split a total equally</option>
              <option value="pro-rata">Split a total by holder balance</option>
            </select>
          </label>

          {draft.mode === "fixed" ? (
            <label>
              Amount per holder
              <input
                inputMode="decimal"
                value={draft.fixedAmountUi}
                onInput={(event: any) =>
                  updateDraft({ fixedAmountUi: event.currentTarget.value })
                }
              />
            </label>
          ) : (
            <label>
              Total amount to distribute
              <input
                inputMode="decimal"
                value={draft.totalAmountUi}
                onInput={(event: any) =>
                  updateDraft({ totalAmountUi: event.currentTarget.value })
                }
              />
            </label>
          )}

          <div className="airdrops-summary">
            <div>
              <span>Tracked</span>
              <b>{holders.length}</b>
            </div>
            <div>
              <span>Eligible</span>
              <b>{eligible.length}</b>
            </div>
            <div>
              <span>Total payout</span>
              <b>{plan?.totalAmountUi ?? "—"}</b>
            </div>
          </div>

          <button
            type="button"
            className="secondary"
            disabled={!plan || state.executing}
            onClick={() => void submitPlan(false)}
          >
            {state.executing ? "Validating…" : "Validate payout plan"}
          </button>
        </section>
      </div>

      <section className="card airdrops-holder-card">
        <div className="row between">
          <div>
            <div className="section-kicker">Holder tracker</div>
            <h3>Recipients and balance changes</h3>
          </div>
          <span className="muted small">
            Existing holder endpoint currently returns up to 50 wallets.
          </span>
        </div>
        <div className="airdrops-table-wrap">
          <table className="airdrops-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Owner</th>
                <th>Balance</th>
                <th>Change</th>
                <th>Supply %</th>
                <th>Eligible</th>
                <th>Payout</th>
              </tr>
            </thead>
            <tbody>
              {holders.map((holder, index) => {
                const owner = holderOwner(holder);
                const delta = deltaFor(holder);
                const recipient = plan?.recipients.find(
                  (row) => row.owner === owner,
                );
                return (
                  <tr key={owner || String(index)}>
                    <td>{holder.rank ?? index + 1}</td>
                    <td className="code" title={owner}>
                      {short(owner, 7, 7)}
                    </td>
                    <td>{formatNumber(holderBalance(holder))}</td>
                    <td
                      className={
                        delta == null
                          ? "muted"
                          : delta > 0
                            ? "positive"
                            : delta < 0
                              ? "negative"
                              : "muted"
                      }
                    >
                      {delta == null
                        ? "new"
                        : `${delta > 0 ? "+" : ""}${formatNumber(delta)}`}
                    </td>
                    <td>{formatNumber(holderShare(holder), 4)}%</td>
                    <td>
                      <span className={`pill ${recipient ? "ok" : ""}`}>
                        {recipient ? "yes" : "no"}
                      </span>
                    </td>
                    <td>{recipient?.amountUi ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!holders.length ? (
            <div className="airdrops-empty">No holder snapshot loaded yet.</div>
          ) : null}
        </div>
      </section>

      <section className="card airdrops-execute-card">
        <div>
          <div className="section-kicker">4 · Distribute</div>
          <h3>Execute from the bank</h3>
          <p className="muted">
            Live execution is sent only to the configured server-side airdrop
            executor. Validate and export the plan before enabling it.
          </p>
        </div>

        <label className="airdrops-live-toggle">
          <input
            type="checkbox"
            checked={draft.live}
            onChange={(event: any) =>
              updateDraft({
                live: Boolean(event.currentTarget.checked),
                confirmation: "",
              })
            }
          />
          Enable live token transfers
        </label>

        {draft.live ? (
          <label>
            Type AIRDROP to confirm
            <input
              value={draft.confirmation}
              autoComplete="off"
              onInput={(event: any) =>
                updateDraft({ confirmation: event.currentTarget.value })
              }
            />
          </label>
        ) : null}

        <div className="airdrops-execute-summary">
          <span>
            <b>{plan?.recipientCount ?? 0}</b> recipients
          </span>
          <span>
            <b>{plan?.totalAmountUi ?? "0"}</b> payout tokens
          </span>
          <span className="code">
            <b>{short(draft.bankWallet, 6, 6)}</b> bank
          </span>
        </div>

        <button
          type="button"
          className="danger-action"
          disabled={
            !draft.live ||
            draft.confirmation !== "AIRDROP" ||
            !plan ||
            state.executing
          }
          onClick={() => void submitPlan(true)}
        >
          {state.executing ? "Submitting…" : "Execute airdrop"}
        </button>
      </section>
    </div>
  );
}

export default function mount() {
  unmounted = false;
  rerender();
  void loadWallets().then(() => {
    rerender();
    if (draft.sourceMint.trim()) void loadHolders(false);
  });

  return () => {
    unmounted = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
