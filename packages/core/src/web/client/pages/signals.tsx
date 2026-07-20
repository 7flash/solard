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
} from "../runtime.tsx";
import type {
  AnyRow,
  BuyPlanRow,
  PumpFeedRow,
  TokenWatchToken,
} from "../runtime.tsx";

export function SignalsPage() {
  const signals = state.signals;
  const sources = signals?.sources ?? [];
  const rows = signals?.signals ?? [];
  const activeSource =
    sources.find((source) => source.id === state.signalSourceId) ??
    sources[0] ??
    null;
  return (
    <div className="signals-layout">
      <div className="activity-hero">
        <div>
          <div className="section-kicker">Telegram signals</div>
          <h2>Signal parser</h2>
          <p className="muted">
            Paste Telegram calls or wire a connector later. The parser extracts
            mint addresses, symbols, links, side, and SOL sizing into the shared
            Solard database state.
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          onClick={() => void runAction(refreshSignals)}
        >
          Refresh signals
        </button>
      </div>

      <div className="grid two">
        <form
          className="card"
          onSubmit={(event: any) => {
            event.preventDefault();
            void runAction(async () => {
              await signalAction("upsert-source", {
                name: state.signalSourceName,
                chatRef: state.signalSourceChatRef,
              });
              await refreshSignals();
            });
          }}
        >
          <h3>Sources</h3>
          <div className="form-grid">
            <label>
              Name
              <input
                value={state.signalSourceName}
                onInput={(event: any) => {
                  state.signalSourceName = event.currentTarget.value;
                }}
              />
            </label>
            <label>
              Telegram group/channel ref
              <input
                placeholder="@group, invite, chat id"
                value={state.signalSourceChatRef}
                onInput={(event: any) => {
                  state.signalSourceChatRef = event.currentTarget.value;
                }}
              />
            </label>
            <button className="secondary full">Save source</button>
          </div>
          <div className="source-list">
            {sources.map((source) => (
              <button
                type="button"
                className={`source-row ${activeSource?.id === source.id ? "active-row" : ""}`}
                onClick={() => {
                  state.signalSourceId = source.id;
                  state.signalSourceName = source.name;
                  state.signalSourceChatRef = source.chatRef ?? "";
                  update();
                }}
              >
                <b>{source.name}</b>
                <small>{source.chatRef || "manual"}</small>
              </button>
            ))}
          </div>
        </form>

        <form
          className="card"
          onSubmit={(event: any) => {
            event.preventDefault();
            void runAction(async () => {
              await signalAction("ingest", {
                sourceId: activeSource?.id ?? null,
                text: state.signalText,
              });
              state.signalText = "";
              await refreshSignals();
            });
          }}
        >
          <h3>Manual ingest</h3>
          <label>
            Paste Telegram signal
            <textarea
              rows={8}
              value={state.signalText}
              onInput={(event: any) => {
                state.signalText = event.currentTarget.value;
              }}
              placeholder="Example: BUY $ABC 0.2 SOL mint 7x... website https://..."
            />
          </label>
          <div className="row">
            <button>Parse signal</button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                state.signalText = "";
                update();
              }}
            >
              Clear text
            </button>
            <button
              type="button"
              className="danger"
              onClick={() =>
                void runAction(async () => {
                  await signalAction("clear");
                  await refreshSignals();
                })
              }
            >
              Clear signals
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h3>Parsed signals</h3>
        <table className="clean-table signals-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Side</th>
              <th>Source</th>
              <th>Mint / symbol</th>
              <th>Amount</th>
              <th>Links</th>
              <th>Status</th>
              <th>Text</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((signal) => (
              <tr>
                <td className="code">
                  {new Date(signal.receivedAtMs).toLocaleTimeString()}
                </td>
                <td>
                  <span
                    className={`pill ${signal.direction === "buy" ? "good" : signal.direction === "sell" ? "bad" : ""}`}
                  >
                    {signal.direction}
                  </span>
                </td>
                <td>{signal.sourceName ?? "manual"}</td>
                <td className="code">
                  {signal.mints[0]
                    ? short(signal.mints[0])
                    : signal.symbols.map((symbol) => `$${symbol}`).join(", ") ||
                      "—"}
                </td>
                <td>{signal.amountSol ? `${signal.amountSol} SOL` : "—"}</td>
                <td>
                  {signal.urls.slice(0, 2).map((url) => (
                    <a target="_blank" href={url}>
                      link
                    </a>
                  ))}
                </td>
                <td>
                  <select
                    value={signal.status}
                    onChange={(event: any) =>
                      void runAction(async () => {
                        await signalAction("status", {
                          id: signal.id,
                          status: event.currentTarget.value,
                        });
                        await refreshSignals();
                      })
                    }
                  >
                    <option value="new">new</option>
                    <option value="watched">watched</option>
                    <option value="ignored">ignored</option>
                    <option value="traded">traded</option>
                  </select>
                </td>
                <td className="signal-text">{signal.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? <p className="muted">No signals yet.</p> : null}
      </div>
    </div>
  );
}

export default function mount() {
  return mountPage("signals", SignalsPage);
}
