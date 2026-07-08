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

export function ActivityPage() {
  const selected = state.selectedJob ?? state.jobs[0] ?? null;
  const jobs = state.jobs;
  const executions = state.overview?.executions ?? [];
  const rawRetries = executions
    .filter((row: AnyRow) => isRetryExecution(row))
    .slice(0, 60);
  const highLevel = executions
    .filter((row: AnyRow) => !isRetryExecution(row))
    .slice(0, 20);
  return (
    <div className="activity-layout">
      <div className="activity-hero">
        <div>
          <div className="section-kicker">Activity center</div>
          <h2>Runs, not noise</h2>
          <p className="muted">
            A launch can generate thousands of retry attempts. This page
            separates the launch job from low-level attempts so “failed retry”
            does not look like “failed app”.
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          onClick={() =>
            void runAction(async () => {
              await refreshJobs();
              await refreshOverview();
            })
          }
        >
          Refresh activity
        </button>
      </div>

      <div className="activity-columns">
        <div className="card runs-list">
          <h3>Launch runs</h3>
          {!jobs.length ? (
            <p className="muted">No launch jobs in this server process yet.</p>
          ) : null}
          {jobs.map((job: AnyRow) => (
            <button
              type="button"
              className={`run-list-item ${selected?.id === job.id ? "active-row" : ""}`}
              onClick={() => {
                state.selectedJobId = job.id;
                void refreshJobs().then(update);
              }}
            >
              <span>
                {jobStatusPill(job)} <b>{jobHeadline(job)}</b>
              </span>
              <small>{new Date(job.createdAtMs).toLocaleTimeString()}</small>
            </button>
          ))}
        </div>

        <div className="card run-detail">
          <h3>Selected run</h3>
          {selected ? (
            <>
              <LaunchRunSummary job={selected} />
              <div className="job-log-list">
                {(selected.logs ?? [])
                  .slice(-80)
                  .reverse()
                  .map((entry: AnyRow) => (
                    <details className="log-entry">
                      <summary>
                        <span className="muted small">
                          {new Date(entry.atMs).toLocaleTimeString()}
                        </span>{" "}
                        <b>{entry.label}</b>
                      </summary>
                      <pre>{JSON.stringify(entry.value, null, 2)}</pre>
                    </details>
                  ))}
              </div>
            </>
          ) : (
            <p className="muted">Select a launch run.</p>
          )}
        </div>
      </div>

      <div className="activity-columns lower">
        <div className="card">
          <h3>High-level executions</h3>
          <table className="clean-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Action</th>
                <th>Wallet</th>
                <th>Sig</th>
              </tr>
            </thead>
            <tbody>
              {highLevel.map((row: AnyRow) => (
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
        </div>
        <div className="card">
          <h3>Retry attempt log</h3>
          <div className="callout warn">
            These rows are expected during spam modes. A failed retry only means
            that one attempt failed; the lane may still continue.
          </div>
          <table className="clean-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Attempt</th>
                <th>Wallet</th>
              </tr>
            </thead>
            <tbody>
              {rawRetries.map((row: AnyRow) => (
                <tr>
                  <td>
                    <span className={`pill ${statusClass(row.status)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="code">
                    {String(row.kind ?? "").replace(/^cli:/, "")}
                  </td>
                  <td className="code">{short(row.walletAddress)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function mount() {
  return mountPage("jobs", ActivityPage);
}
