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

export function PortfolioPage() {
  const data = state.portfolio;
  const query = state.portfolioSearch.trim().toLowerCase();
  const rows = (data?.rows ?? []).filter((row: AnyRow) => {
    if (state.portfolioHideZero && String(row.amountRaw ?? "0") === "0")
      return false;
    if (!query) return true;
    const haystack = [
      row.wallet?.name,
      row.wallet?.address,
      row.mint,
      row.symbol,
      row.name,
      row.tokenAccount,
      ...(row.wallet?.groups ?? []),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
  const grouped = new Map<string, AnyRow[]>();
  for (const row of rows) {
    const key = row.wallet?.address ?? "unknown";
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  return (
    <div className="portfolio-page">
      <section className="console-panel hero-panel">
        <div>
          <div className="section-kicker">Portfolio</div>
          <h2>Holdings, separated from Home</h2>
          <p className="muted">
            Home stays instant from SQLite. Portfolio can spend RPC time
            refreshing SOL and non-zero token accounts across wallets.
          </p>
        </div>
        <div className="row right-actions">
          <button
            type="button"
            onClick={() => void runAction(refreshPortfolio)}
          >
            Refresh portfolio
          </button>
        </div>
      </section>

      <div className="home-metrics">
        <div className="metric-card">
          <div className="muted small">Wallets scanned</div>
          <div className="stat">{data?.totals?.wallets ?? "—"}</div>
        </div>
        <div className="metric-card">
          <div className="muted small">Non-zero holdings</div>
          <div className="stat">{data?.totals?.holdings ?? "—"}</div>
        </div>
        <div className="metric-card">
          <div className="muted small">Token accounts</div>
          <div className="stat">{data?.totals?.tokenAccounts ?? "—"}</div>
        </div>
        <div className="metric-card">
          <div className="muted small">SOL total</div>
          <div className="stat">
            {solFromLamports(data?.totals?.solLamports)}
          </div>
        </div>
      </div>

      <section className="console-panel portfolio-controls">
        <label>
          Search
          <input
            value={state.portfolioSearch}
            placeholder="wallet, group, mint, symbol"
            onInput={(event: any) => {
              state.portfolioSearch = event.currentTarget.value;
              localStorage.setItem(
                "solard:portfolio-search",
                state.portfolioSearch,
              );
              update();
            }}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={state.portfolioHideZero}
            onChange={(event: any) => {
              state.portfolioHideZero = event.currentTarget.checked;
              localStorage.setItem(
                "solard:portfolio-hide-zero",
                state.portfolioHideZero ? "1" : "0",
              );
              update();
            }}
          />{" "}
          Hide zero accounts
        </label>
        <span className="muted small">
          Loaded{" "}
          {data?.loadedAtMs
            ? new Date(data.loadedAtMs).toLocaleTimeString()
            : "not yet"}
        </span>
      </section>

      <section className="console-panel portfolio-table-panel">
        <table className="clean-table portfolio-table">
          <thead>
            <tr>
              <th>Wallet</th>
              <th>Groups</th>
              <th>Asset</th>
              <th>Amount</th>
              <th>Mint</th>
              <th>Token account</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row: AnyRow) => (
              <tr>
                <td>
                  <b>{row.wallet?.name ?? "—"}</b>
                  <div className="code tiny">
                    {short(row.wallet?.address, 8, 8)}
                  </div>
                </td>
                <td>
                  <div className="groups-inline">
                    {(row.wallet?.groups ?? []).length ? (
                      row.wallet.groups.map((name: string) => (
                        <span className="group-chip">{name}</span>
                      ))
                    ) : (
                      <span className="muted tiny">none</span>
                    )}
                  </div>
                </td>
                <td>
                  {row.symbol ? (
                    <b>${row.symbol}</b>
                  ) : row.name ? (
                    <b>{row.name}</b>
                  ) : (
                    <b>{row.kind === "sol" ? "SOL" : short(row.mint, 4, 4)}</b>
                  )}
                  <div className="muted tiny">{row.kind ?? "token"}</div>
                </td>
                <td className="strong-cell">
                  {row.amountUi ?? row.amountRaw ?? "—"}
                </td>
                <td className="code">
                  {row.mint ? (
                    <a href={tokenUrl(row.mint)} target="_blank">
                      {short(row.mint, 8, 8)}
                    </a>
                  ) : (
                    "native"
                  )}
                </td>
                <td className="code">
                  {row.tokenAccount ? short(row.tokenAccount, 8, 8) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? (
          <p className="muted">
            No holdings loaded yet. Refresh portfolio after RPC is configured.
          </p>
        ) : null}
      </section>
    </div>
  );
}

export default function mount() {
  return mountPage("portfolio", PortfolioPage);
}
