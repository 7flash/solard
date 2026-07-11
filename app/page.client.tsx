import { render } from "tradjs/client";
import { api } from "./_client/api";
import { short, solFromLamports, statusClass } from "./_client/format";
import type { AnyRow, JobRow, OverviewPayload } from "./_client/types";

type PageState = {
  overview: OverviewPayload;
  jobs: JobRow[];
  busy: boolean;
  loadedAtMs: number | null;
  error: string | null;
};

function emptyOverview(): OverviewPayload {
  return { wallets: [], groups: [], tokens: [], executions: [], balances: [] };
}

const state: PageState = {
  overview: emptyOverview(),
  jobs: [],
  busy: false,
  loadedAtMs: null,
  error: null,
};

let unmounted = false;

function rootElement(): HTMLElement {
  const root = document.getElementById("app-root");
  if (!root) throw new Error("Missing #app-root");
  return root;
}

function rerender(): void {
  if (unmounted) return;
  render(<MainPage />, rootElement());
  document
    .querySelectorAll<HTMLAnchorElement>("#main-nav a")
    .forEach((link) =>
      link.classList.toggle("active", link.dataset.page === "overview"),
    );
}

function isRetryExecution(row: AnyRow): boolean {
  const kind = String(row.kind ?? "").toLowerCase();
  return (
    kind.includes(":attempt:") ||
    /:trader:\d+/.test(kind) ||
    kind.includes(":retry") ||
    kind.includes("retry")
  );
}

function friendlyExecutionKind(row: AnyRow): string {
  const text = String(row.kind ?? row.action ?? "—");
  if (text.includes("launch:pump") || text.includes("launch-pump"))
    return "Pump launch";
  if (text.includes(":create-and-creator-buy")) return "Create token";
  if (text.includes(":trader:")) return "Follower buy attempt";
  if (text.includes("buy")) return "Buy";
  if (text.includes("sell")) return "Sell";
  return text.replace(/^cli:/, "");
}

function jobHeadline(job: JobRow): string {
  const token =
    job.result?.token?.symbol ||
    job.result?.token?.alias ||
    job.result?.token?.mint ||
    job.input?.symbol ||
    job.input?.alias ||
    job.input?.name;
  return token ? `Pump launch: ${token}` : String(job.kind ?? "Launch run");
}

async function refresh(): Promise<void> {
  state.busy = true;
  state.error = null;
  rerender();

  try {
    const [overviewValue, jobsValue] = await Promise.all([
      api<OverviewPayload>(
        "/api/overview?fast=0&balances=sol&tokenLimit=500&executionLimit=100",
      ),
      api<JobRow[]>("/api/jobs?limit=20"),
    ]);

    state.overview = {
      ...emptyOverview(),
      ...(overviewValue ?? {}),
      wallets: overviewValue?.wallets ?? [],
      groups: overviewValue?.groups ?? [],
      tokens: overviewValue?.tokens ?? [],
      executions: overviewValue?.executions ?? [],
      balances: overviewValue?.balances ?? [],
    };
    state.jobs = Array.isArray(jobsValue) ? jobsValue : [];
    state.loadedAtMs = Date.now();
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.busy = false;
    rerender();
  }
}

function MainPage() {
  const overview = state.overview;
  const visibleExecutions = overview.executions
    .filter((row) => !isRetryExecution(row))
    .slice(0, 12);
  const hiddenRetries = overview.executions.filter(isRetryExecution).length;

  return (
    <div className="home-layout">
      {state.error ? (
        <div className="global-error-strip">
          <span className="pill bad">{state.error}</span>
        </div>
      ) : null}

      <div className="home-top">
        <div>
          <div className="section-kicker">Console home</div>
          <h2>What needs attention</h2>
          <p className="muted">
            Main owns its page state directly. The old shared client runtime is
            no longer required for this page.
          </p>
        </div>

        <div className="quick-actions">
          <a className="button-link" href="/terminal">
            Open Pump terminal
          </a>
          <a className="button-link secondary" href="/launch">
            Build launch
          </a>
          <a className="button-link secondary" href="/portfolio">
            Open portfolio
          </a>
          <button
            type="button"
            className="secondary"
            disabled={state.busy}
            onClick={() => void refresh()}
          >
            {state.busy ? "Refreshing…" : "Refresh all"}
          </button>
        </div>
      </div>

      <div className="home-metrics">
        <div className="metric-card">
          <div className="muted small">Wallets loaded</div>
          <div className="stat">{overview.wallets.length || "—"}</div>
          <div className="muted small">
            {overview.balances.length
              ? `${overview.balances.length}/${overview.wallets.length} balance rows`
              : "waiting for overview"}
          </div>
        </div>
        <div className="metric-card">
          <div className="muted small">Groups</div>
          <div className="stat">{overview.groups.length || "—"}</div>
        </div>
        <div className="metric-card">
          <div className="muted small">Tokens tracked</div>
          <div className="stat">{overview.tokens.length || "—"}</div>
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

      <div className="home-columns">
        <div className="card">
          <div className="row between">
            <div>
              <h2>Wallet balances</h2>
              <div className="muted small">
                Showing all {overview.balances.length} wallets from overview.
              </div>
            </div>
            <a className="button-link secondary compact" href="/wallets">
              Manage
            </a>
          </div>

          <div className="wallet-balance-scroll">
            <table className="clean-table wallet-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Address</th>
                  <th>Groups</th>
                  <th>SOL</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {overview.balances.map((row, index) => (
                  <tr key={row.wallet?.address ?? row.wallet?.name ?? index}>
                    <td className="strong-cell">{row.wallet?.name ?? "—"}</td>
                    <td
                      className="code address-cell"
                      title={row.wallet?.address ?? ""}
                    >
                      {short(row.wallet?.address)}
                    </td>
                    <td>
                      <div className="groups-inline">
                        {(row.wallet?.groups ?? []).length ? (
                          row.wallet!.groups!.map((name: string) => (
                            <span key={name} className="group-chip">
                              {name}
                            </span>
                          ))
                        ) : (
                          <span className="muted tiny">none</span>
                        )}
                      </div>
                    </td>
                    <td className="sol-cell">
                      {solFromLamports(row.solLamports)}
                      {String(row.solLamports ?? "").match(/^\d+$/)
                        ? " SOL"
                        : ""}
                    </td>
                    <td>
                      {row.balanceWarning ? (
                        <span className="pill warn">balance pending</span>
                      ) : (
                        <span className="pill ok">ok</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {!overview.balances.length ? (
              <p className="muted">
                No wallets returned by overview yet. Check the encrypted store
                and refresh.
              </p>
            ) : null}
          </div>
        </div>

        <div className="card">
          <div className="row between">
            <h2>Launch / trade activity</h2>
            <a className="button-link secondary compact" href="/activity">
              Open Activity
            </a>
          </div>

          {hiddenRetries > 0 ? (
            <div className="callout">
              {hiddenRetries} low-level retry attempts are hidden here.
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
              {visibleExecutions.map((row, index) => (
                <tr key={`${row.kind ?? "row"}:${row.signature ?? index}`}>
                  <td>
                    <span className={`pill ${statusClass(row.status)}`}>
                      {row.status ?? "—"}
                    </span>
                  </td>
                  <td>{friendlyExecutionKind(row)}</td>
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

      <div className="card">
        <div className="row between">
          <div>
            <h2>Recent jobs</h2>
            <div className="muted small">
              {state.loadedAtMs
                ? `Loaded ${new Date(state.loadedAtMs).toLocaleTimeString()}`
                : "Not loaded yet"}
            </div>
          </div>
          <a className="button-link secondary compact" href="/activity">
            View all
          </a>
        </div>

        {!state.jobs.length ? (
          <p className="muted">No launch jobs in this server process yet.</p>
        ) : null}

        <div className="runs-list">
          {state.jobs.slice(0, 12).map((job) => (
            <div key={job.id} className="run-list-item">
              <span>
                <span className={`pill ${statusClass(job.status)}`}>
                  {job.status ?? "job"}
                </span>{" "}
                <b>{jobHeadline(job)}</b>
              </span>
              <small>
                {job.createdAtMs
                  ? new Date(job.createdAtMs).toLocaleTimeString()
                  : job.id}
              </small>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function mount() {
  unmounted = false;
  rerender();
  void refresh();

  return () => {
    unmounted = true;
  };
}
