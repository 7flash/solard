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

export function WatchlistsPage() {
  const active = selectedWatchGroup();
  const tokenRows = sortWatchRows(
    (active?.tokens ?? []).filter(passesBadgeFilters),
  );
  return (
    <div className="grid">
      <div className="card span-12 terminal-head">
        <div>
          <h2>Watched token groups</h2>
          <p className="muted">
            Star tokens from the Pump terminal into groups. The backend
            subscribes to watched-token trades and updates live market-cap + SMA
            columns.
          </p>
        </div>
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            const name = state.watchGroupName.trim();
            if (name) void runAction(() => createWatchGroup(name));
          }}
        >
          <input
            value={state.watchGroupName}
            placeholder="group name"
            onInput={(event: any) => {
              state.watchGroupName = event.currentTarget.value;
            }}
          />
          <button type="submit">Create group</button>
          <button
            type="button"
            className="secondary"
            onClick={() => void runAction(refreshWatchGroups)}
          >
            Refresh
          </button>
          <label>
            Sort
            <select
              value={state.watchSort}
              onInput={(event: any) => {
                state.watchSort = event.currentTarget.value;
                localStorage.setItem("solwal:watch-sort", state.watchSort);
                update();
              }}
            >
              <option value="mcap-desc">MCap high → low</option>
              <option value="mcap-asc">MCap low → high</option>
              <option value="mcap-change-desc">Raised most SOL</option>
              <option value="mcap-change-pct-desc">Raised most %</option>
              <option value="sma1m-desc">SMA 1m high → low</option>
              <option value="trades-desc">Most trades</option>
              <option value="newest">Newest added</option>
            </select>
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={state.hideMayhem}
              onInput={(event: any) => {
                state.hideMayhem = event.currentTarget.checked;
                localStorage.setItem(
                  "solwal:pump-hide-mayhem",
                  state.hideMayhem ? "1" : "0",
                );
                update();
              }}
            />
            <span>Hide Mayhem</span>
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={state.hideUsdc}
              onInput={(event: any) => {
                state.hideUsdc = event.currentTarget.checked;
                localStorage.setItem(
                  "solwal:pump-hide-usdc",
                  state.hideUsdc ? "1" : "0",
                );
                update();
              }}
            />
            <span>Hide USDC</span>
          </label>
        </form>
      </div>

      <div className="card span-3">
        <h3>Groups</h3>
        <div className="watch-group-list">
          {state.watchGroups.map((group) => (
            <button
              type="button"
              className={group.id === active?.id ? "active-row" : "secondary"}
              onClick={() => {
                state.selectedWatchGroupId = group.id;
                update();
              }}
            >
              <span>{group.name}</span>
              <span className="pill">{group.tokens.length}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="card span-9">
        <div className="row between">
          <h3>{active ? active.name : "No group selected"}</h3>
          <form
            className="row"
            onSubmit={(event) => {
              event.preventDefault();
              if (!active) return;
              const body = formData(event.currentTarget);
              const mint = String(body.mint ?? "").trim();
              if (!mint) return;
              void runAction(() =>
                addWatchedToken(active.id, {
                  mint,
                  name: String(body.name ?? "").trim() || null,
                  symbol: String(body.symbol ?? "").trim() || null,
                  marketCapSol: body.marketCapSol
                    ? Number(body.marketCapSol)
                    : null,
                  source: "manual",
                }),
              );
              event.currentTarget.reset();
            }}
          >
            <input name="mint" placeholder="mint" />
            <input name="symbol" placeholder="symbol" />
            <input name="name" placeholder="name" />
            <input name="marketCapSol" placeholder="mcap SOL" />
            <button type="submit" disabled={!active}>
              Add
            </button>
          </form>
        </div>
        <div className="watch-grid-table">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Token</th>
                <th>Mint</th>
                <th>Creator</th>
                <th>Last mcap</th>
                <th>Δ MCap</th>
                <th>Δ %</th>
                <th>SMA 1m</th>
                <th>SMA 5m</th>
                <th>SMA 15m</th>
                <th>SMA 60m</th>
                <th>Trades</th>
                <th>Last trade</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tokenRows.map((token) => (
                <tr>
                  <td>
                    {tokenImage(token) ? (
                      <img
                        className="token-img"
                        src={tokenImage(token)!}
                        loading="lazy"
                      />
                    ) : (
                      <div className="token-img placeholder" />
                    )}
                  </td>
                  <td>
                    <div className="token-title">
                      {token.symbol ? `$${token.symbol}` : "—"}{" "}
                      <TokenBadges {...token} />
                    </div>
                    <div className="muted small">
                      {token.name ?? "watched token"}
                    </div>
                  </td>
                  <td className="code">
                    <a
                      href={tokenUrl(token.mint)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {short(token.mint)}
                    </a>
                  </td>
                  <td className="code">{short(token.creator)}</td>
                  <td>{formatMcap(latestMcap(token))}</td>
                  <td
                    className={
                      mcapChange(token) != null && mcapChange(token)! > 0
                        ? "gain"
                        : mcapChange(token) != null && mcapChange(token)! < 0
                          ? "loss"
                          : ""
                    }
                  >
                    {formatSignedMcap(mcapChange(token))}
                  </td>
                  <td
                    className={
                      mcapChangePct(token) != null && mcapChangePct(token)! > 0
                        ? "gain"
                        : mcapChangePct(token) != null &&
                            mcapChangePct(token)! < 0
                          ? "loss"
                          : ""
                    }
                  >
                    {formatPct(mcapChangePct(token))}
                  </td>
                  <td>{formatMcap(token.sma1m)}</td>
                  <td>{formatMcap(token.sma5m)}</td>
                  <td>{formatMcap(token.sma15m)}</td>
                  <td>{formatMcap(token.sma60m)}</td>
                  <td>{token.trades?.length ?? token.samples.length}</td>
                  <td>
                    {token.lastTradeAtMs ? age(token.lastTradeAtMs) : "—"}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="danger compact"
                      onClick={() =>
                        void runAction(() =>
                          removeWatchedToken(active!.id, token.mint),
                        )
                      }
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!tokenRows.length ? (
          <p className="muted">
            No watched tokens yet. Star tokens from the Pump terminal or add a
            mint manually.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default function mount() {
  return mountPage("watchlists", WatchlistsPage);
}
