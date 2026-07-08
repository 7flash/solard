import {
  state,
  update,
  runAction,
  api,
  formData,
  mountPage,
  refreshOverview,
  refreshJobs,
  refreshPortfolio,
  refreshSignals,
  refreshPumpLive,
  refreshWatchGroups,
  startPumpFeed,
  stopPumpFeed,
  navigatePage,
  short,
  solFromLamports,
  formatSol,
  tokenUrl,
  tokenImage,
  TokenBadges,
  passesBadgeFilters,
  formatMcap,
  latestMcap,
  mcapChange,
  mcapChangePct,
  formatSignedMcap,
  formatPct,
  sortFeedRows,
  sortWatchRows,
  age,
  selectedWatchGroup,
  statusClass,
  isRetryExecution,
  friendlyExecutionKind,
  jobHeadline,
  jobStatusPill,
  latestJob,
  LaunchRunSummary,
  walletGroupBadges,
  walletHoldingsChips,
  walletBalanceForAddress,
  newBuyPlanRow,
  updateBuyPlanRow,
  removeBuyPlanRow,
  walletLabel,
  populateBuyPlanFromGroup,
  buyPlanPayload,
  addWatchedToken,
  removeWatchedToken,
  starPumpFeedRow,
  quickBuyPumpFeedRow,
  signalAction,
} from "../runtime";
import type {
  AnyRow,
  BuyPlanRow,
  PumpFeedRow,
  TokenWatchToken,
} from "../runtime";

function Stats() {
  const data = state.overview;
  const visibleExecutions = (data?.executions ?? []).filter(
    (row: AnyRow) => !isRetryExecution(row),
  );
  const hiddenRetries =
    (data?.executions ?? []).length - visibleExecutions.length;
  const walletCount = data?.wallets.length ?? 0;
  const balanceCount = data?.balances.length ?? 0;
  return (
    <div className="home-metrics">
      <div className="metric-card">
        <div className="muted small">Wallets loaded</div>
        <div className="stat">{walletCount || "—"}</div>
        <div className="muted small">
          {balanceCount
            ? `${balanceCount}/${walletCount} balance rows`
            : "waiting for overview"}
        </div>
      </div>
      <div className="metric-card">
        <div className="muted small">Groups</div>
        <div className="stat">{data?.groups.length ?? "—"}</div>
      </div>
      <div className="metric-card">
        <div className="muted small">Tokens tracked</div>
        <div className="stat">{data?.tokens.length ?? "—"}</div>
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
  );
}

export function OverviewPage() {
  const data = state.overview;
  const visibleExecutions = (data?.executions ?? [])
    .filter((row: AnyRow) => !isRetryExecution(row))
    .slice(0, 12);
  const hiddenRetries = (data?.executions ?? []).filter((row: AnyRow) =>
    isRetryExecution(row),
  ).length;
  return (
    <div className="home-layout">
      <div className="home-top">
        <div>
          <div className="section-kicker">Console home</div>
          <h2>What needs attention</h2>
          <p className="muted">
            Home shows only high-level runs and balances. Spam/retry attempts
            are expected noise and are hidden here.
          </p>
        </div>
        <div className="quick-actions">
          <button type="button" onClick={() => navigatePage("terminal")}>
            Open Pump terminal
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => navigatePage("launch")}
          >
            Build launch
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => navigatePage("portfolio")}
          >
            Open portfolio
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                await refreshOverview();
                await refreshJobs();
                if (state.tab === "terminal" || state.tab === "watchlists")
                  await refreshPumpLive();
              })
            }
          >
            Refresh all
          </button>
        </div>
      </div>
      <Stats />
      <div className="home-columns">
        <div className="card">
          <div className="row between">
            <div>
              <h2>Wallet balances</h2>
              <div className="muted small">
                Showing all {(data?.balances ?? []).length} wallets from the
                local encrypted store.
              </div>
            </div>
            <button
              type="button"
              className="secondary compact"
              onClick={() => navigatePage("wallets")}
            >
              Manage
            </button>
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
                {(data?.balances ?? []).map((row: AnyRow) => (
                  <tr>
                    <td className="strong-cell">{row.wallet?.name ?? "—"}</td>
                    <td
                      className="code address-cell"
                      title={row.wallet?.address}
                    >
                      {short(row.wallet?.address)}
                    </td>
                    <td>
                      <div className="groups-inline">
                        {walletGroupBadges(row)}
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
          </div>
          {!(data?.balances ?? []).length ? (
            <p className="muted">
              No wallets returned by overview yet. Check SOWL_MASTER_KEY /
              SOLARD_MASTER_KEY and refresh.
            </p>
          ) : null}
        </div>
        <div className="card">
          <div className="row between">
            <h2>Launch / trade activity</h2>
            <button
              type="button"
              className="secondary compact"
              onClick={() => navigatePage("jobs")}
            >
              Open Activity
            </button>
          </div>
          {hiddenRetries > 0 ? (
            <div className="callout">
              {hiddenRetries} low-level retry attempts are hidden here. This
              does not mean the app failed; it means spam lanes retried.
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
              {visibleExecutions.map((row: AnyRow) => (
                <tr>
                  <td>
                    <span className={`pill ${statusClass(row.status)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td>{friendlyExecutionKind(row.kind)}</td>
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
      <LaunchRunSummary job={latestJob()} />
    </div>
  );
}

export default function mount() {
  return mountPage("overview", OverviewPage);
}
