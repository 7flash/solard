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

function terminalMcapValues(rows: PumpFeedRow[]): number[] {
  return rows
    .map((row) => latestMcap(row))
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    );
}

export function TerminalPage() {
  const filter = state.pumpFeedFilter.trim().toLowerCase();
  const visibleFeed = state.pumpFeed.filter(passesBadgeFilters);
  const filteredRows = filter
    ? visibleFeed.filter((row) =>
        [row.name, row.symbol, row.mint, row.creator, row.quoteAsset].some(
          (value) =>
            String(value ?? "")
              .toLowerCase()
              .includes(filter),
        ),
      )
    : visibleFeed;
  const rows = sortFeedRows(filteredRows);
  const mcapValues = terminalMcapValues(rows);
  const topMcap = mcapValues.length ? Math.max(...mcapValues) : null;
  const movers = rows.filter((row) => (mcapChange(row) ?? 0) > 0).length;
  const latest = state.pumpFeed[0] ?? null;
  const selectedWalletLabel = state.terminalDefaultWallet
    ? ((state.overview?.wallets ?? []).find(
        (wallet: AnyRow) =>
          wallet.name === state.terminalDefaultWallet ||
          wallet.address === state.terminalDefaultWallet,
      )?.name ?? short(state.terminalDefaultWallet))
    : "none";

  return (
    <div className="terminal-page">
      <section className="terminal-command-bar">
        <div className="terminal-command-main">
          <div className="section-kicker">Live feed</div>
          <h2>Pump terminal</h2>
          <p className="muted">
            Track new launches, sort by market-cap movement, star tokens into
            watchlists, and quick-buy from the selected default wallet.
          </p>
        </div>
        <div className="terminal-status-tile">
          <span className="label">Feed</span>
          <span
            className={`pill ${state.pumpFeedStatus === "connected" ? "ok" : state.pumpFeedStatus === "error" ? "bad" : ""}`}
          >
            {state.pumpFeedStatus}
          </span>
          <span className="muted small">
            {state.pumpFeedSource === "helius"
              ? "Helius direct"
              : "PumpPortal enriched"}
          </span>
        </div>
        <div className="terminal-status-tile">
          <span className="label">Quick wallet</span>
          <b>{selectedWalletLabel}</b>
          <span className="muted small">
            {state.terminalQuickLive ? "LIVE buys" : "simulation"}
          </span>
        </div>
      </section>

      <section className="terminal-toolbar-grid">
        <div className="terminal-panel stream-panel">
          <div className="panel-title-row">
            <h3>Stream</h3>
            {state.pumpFeedError ? (
              <span className="pill bad">{state.pumpFeedError}</span>
            ) : null}
          </div>
          <div className="terminal-form-grid compact-grid">
            <label className="field">
              <span>Source</span>
              <select
                value={state.pumpFeedSource}
                onInput={(event: any) => {
                  state.pumpFeedSource = event.currentTarget.value;
                  localStorage.setItem(
                    "solwal:pump-feed-source",
                    state.pumpFeedSource,
                  );
                  update();
                }}
              >
                <option value="helius">Helius direct</option>
                <option value="pumpportal">PumpPortal enriched</option>
              </select>
            </label>
            <label className="field">
              <span>Watch group</span>
              <select
                value={state.selectedWatchGroupId ?? ""}
                onInput={(event: any) => {
                  state.selectedWatchGroupId =
                    event.currentTarget.value || null;
                  update();
                }}
              >
                <option value="">watch group…</option>
                {state.watchGroups.map((group) => (
                  <option value={group.id}>{group.name}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="button-row">
            <button
              type="button"
              className="primary"
              onClick={() => void startPumpFeed()}
            >
              {state.pumpFeedStatus === "connected" ? "Reconnect" : "Connect"}
            </button>
            <button type="button" className="secondary" onClick={stopPumpFeed}>
              Stop
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                state.pumpFeed = [];
                update();
              }}
            >
              Clear session
            </button>
          </div>
        </div>

        <div className="terminal-panel quick-buy-panel">
          <div className="panel-title-row">
            <h3>Default quick buy</h3>
            <label className="quick-live">
              <input
                type="checkbox"
                checked={state.terminalQuickLive}
                onInput={(event: any) => {
                  state.terminalQuickLive = event.currentTarget.checked;
                  localStorage.setItem(
                    "solwal:terminal-quick-live",
                    state.terminalQuickLive ? "1" : "0",
                  );
                  update();
                }}
              />
              <span>{state.terminalQuickLive ? "LIVE" : "SIM"}</span>
            </label>
          </div>
          <div className="terminal-form-grid buy-grid">
            <label className="field wide">
              <span>Wallet</span>
              <select
                value={state.terminalDefaultWallet}
                onInput={(event: any) => {
                  state.terminalDefaultWallet = event.currentTarget.value;
                  localStorage.setItem(
                    "solwal:terminal-default-wallet",
                    state.terminalDefaultWallet,
                  );
                  update();
                }}
              >
                <option value="">select wallet…</option>
                {(state.overview?.wallets ?? []).map((wallet: AnyRow) => (
                  <option value={wallet.name ?? wallet.address}>
                    {wallet.name ?? short(wallet.address)} ·{" "}
                    {short(wallet.address, 4, 4)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Buy SOL</span>
              <input
                value={state.terminalDefaultBuySol}
                onInput={(event: any) => {
                  state.terminalDefaultBuySol = event.currentTarget.value;
                  localStorage.setItem(
                    "solwal:terminal-default-buy-sol",
                    state.terminalDefaultBuySol,
                  );
                  update();
                }}
              />
            </label>
            <label className="field">
              <span>Sender</span>
              <select
                value={state.terminalDefaultSender}
                onInput={(event: any) => {
                  state.terminalDefaultSender = event.currentTarget.value;
                  localStorage.setItem(
                    "solwal:terminal-default-sender",
                    state.terminalDefaultSender,
                  );
                  update();
                }}
              >
                <option value="helius-fast">Helius fast</option>
                <option value="helius-rpc">Helius RPC</option>
                <option value="rpc">RPC</option>
              </select>
            </label>
            <label className="field">
              <span>Slippage bps</span>
              <input
                value={state.terminalDefaultSlippageBps}
                onInput={(event: any) => {
                  state.terminalDefaultSlippageBps = event.currentTarget.value;
                  localStorage.setItem(
                    "solwal:terminal-default-slippage-bps",
                    state.terminalDefaultSlippageBps,
                  );
                  update();
                }}
              />
            </label>
            <label className="field">
              <span>Tip SOL</span>
              <input
                value={state.terminalDefaultTipSol}
                onInput={(event: any) => {
                  state.terminalDefaultTipSol = event.currentTarget.value;
                  localStorage.setItem(
                    "solwal:terminal-default-tip-sol",
                    state.terminalDefaultTipSol,
                  );
                  update();
                }}
              />
            </label>
            <label className="field">
              <span>Priority µ-lamports</span>
              <input
                value={state.terminalDefaultPriorityMicroLamports}
                onInput={(event: any) => {
                  state.terminalDefaultPriorityMicroLamports =
                    event.currentTarget.value;
                  localStorage.setItem(
                    "solwal:terminal-default-priority-micro-lamports",
                    state.terminalDefaultPriorityMicroLamports,
                  );
                  update();
                }}
              />
            </label>
          </div>
        </div>

        <div className="terminal-panel filter-panel">
          <div className="panel-title-row">
            <h3>Filter / sort</h3>
            <span className="pill">
              {rows.length} shown / {state.pumpFeed.length} cached
            </span>
          </div>
          <div className="terminal-form-grid compact-grid">
            <label className="field wide">
              <span>Search</span>
              <input
                value={state.pumpFeedFilter}
                placeholder="symbol, name, mint, creator"
                onInput={(event: any) => {
                  state.pumpFeedFilter = event.currentTarget.value;
                  update();
                }}
              />
            </label>
            <label className="field">
              <span>Sort</span>
              <select
                value={state.pumpFeedSort}
                onInput={(event: any) => {
                  state.pumpFeedSort = event.currentTarget.value;
                  localStorage.setItem(
                    "solwal:pump-feed-sort",
                    state.pumpFeedSort,
                  );
                  update();
                }}
              >
                <option value="newest">Newest</option>
                <option value="mcap-desc">MCap high → low</option>
                <option value="mcap-asc">MCap low → high</option>
                <option value="mcap-change-desc">Raised most SOL</option>
                <option value="mcap-change-pct-desc">Raised most %</option>
                <option value="trades-desc">Most trades</option>
              </select>
            </label>
          </div>
          <div className="button-row filters-row">
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
          </div>
        </div>
      </section>

      <section className="terminal-metrics">
        <div>
          <span>Cached</span>
          <b>{state.pumpFeed.length}</b>
        </div>
        <div>
          <span>Shown</span>
          <b>{rows.length}</b>
        </div>
        <div>
          <span>Top mcap</span>
          <b>{formatMcap(topMcap)}</b>
        </div>
        <div>
          <span>Movers</span>
          <b>{movers}</b>
        </div>
        <div>
          <span>Watch groups</span>
          <b>{state.watchGroups.length}</b>
        </div>
      </section>

      <section className="terminal-feed-layout">
        <div className="terminal-panel feed-panel">
          <div className="panel-title-row">
            <h3>Live launch feed</h3>
            <span className="muted small">
              Newest and updated rows are merged by mint.
            </span>
          </div>
          <div className="terminal-table improved-feed-table">
            <table>
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Mint</th>
                  <th>Creator</th>
                  <th>Initial</th>
                  <th>MCap</th>
                  <th>Δ SOL</th>
                  <th>Δ %</th>
                  <th>SMA 1m</th>
                  <th>SMA 5m</th>
                  <th>Trade age</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr>
                    <td className="token-cell">
                      {tokenImage(row) ? (
                        <img
                          className="token-img large"
                          src={tokenImage(row)!}
                          loading="lazy"
                        />
                      ) : (
                        <div className="token-img large placeholder" />
                      )}
                      <div>
                        <div className="token-title">
                          {row.symbol ? `$${row.symbol}` : "—"}{" "}
                          <TokenBadges {...row} />
                        </div>
                        <div className="muted small">
                          {row.name ?? row.eventType ?? "new token"}
                        </div>
                        <div className="muted tiny">
                          {row.receivedAt
                            ? new Date(row.receivedAt).toLocaleTimeString()
                            : "—"}
                        </div>
                      </div>
                    </td>
                    <td className="code">
                      {row.mint ? (
                        <a
                          href={tokenUrl(row.mint)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {short(row.mint)}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="code">{short(row.creator)}</td>
                    <td>{formatSol(row.initialBuy ?? row.solAmount)}</td>
                    <td>{formatMcap(latestMcap(row))}</td>
                    <td
                      className={
                        mcapChange(row) != null && mcapChange(row)! > 0
                          ? "gain"
                          : mcapChange(row) != null && mcapChange(row)! < 0
                            ? "loss"
                            : ""
                      }
                    >
                      {formatSignedMcap(mcapChange(row))}
                    </td>
                    <td
                      className={
                        mcapChangePct(row) != null && mcapChangePct(row)! > 0
                          ? "gain"
                          : mcapChangePct(row) != null &&
                              mcapChangePct(row)! < 0
                            ? "loss"
                            : ""
                      }
                    >
                      {formatPct(mcapChangePct(row))}
                    </td>
                    <td>{formatMcap(row.sma1m)}</td>
                    <td>{formatMcap(row.sma5m)}</td>
                    <td>{row.lastTradeAtMs ? age(row.lastTradeAtMs) : "—"}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="primary compact"
                          disabled={!row.mint || !state.terminalDefaultWallet}
                          onClick={() =>
                            void runAction(() => quickBuyPumpFeedRow(row))
                          }
                        >
                          {state.terminalQuickLive ? "BUY" : "SIM"}
                        </button>
                        <button
                          type="button"
                          className="secondary compact"
                          disabled={!row.mint}
                          onClick={() =>
                            void runAction(() => starPumpFeedRow(row))
                          }
                        >
                          ★
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length ? (
            <div className="empty-console">
              <b>No tokens visible.</b>
              <span>Connect the stream or loosen filters.</span>
            </div>
          ) : null}
        </div>

        <aside className="terminal-panel inspector-panel">
          <div className="panel-title-row">
            <h3>Inspector</h3>
            <span className="muted small">latest event</span>
          </div>
          {latest ? (
            <div className="inspector-content">
              <div className="inspector-token">
                {tokenImage(latest) ? (
                  <img
                    className="token-img xlarge"
                    src={tokenImage(latest)!}
                    loading="lazy"
                  />
                ) : (
                  <div className="token-img xlarge placeholder" />
                )}
                <div>
                  <h4>{latest.symbol ? `$${latest.symbol}` : "Token"}</h4>
                  <p className="muted">
                    {latest.name ?? latest.mint ?? "latest feed event"}
                  </p>
                </div>
              </div>
              <div className="kv-grid">
                <span>Mint</span>
                <b className="code">{short(latest.mint)}</b>
                <span>Creator</span>
                <b className="code">{short(latest.creator)}</b>
                <span>MCap</span>
                <b>{formatMcap(latestMcap(latest))}</b>
                <span>Δ</span>
                <b>{formatSignedMcap(mcapChange(latest))}</b>
              </div>
              <details>
                <summary>Raw JSON</summary>
                <pre>{JSON.stringify(latest, null, 2)}</pre>
              </details>
            </div>
          ) : (
            <p className="muted">No event selected yet.</p>
          )}
        </aside>
      </section>
    </div>
  );
}

export default function mount() {
  return mountPage("terminal", TerminalPage);
}
