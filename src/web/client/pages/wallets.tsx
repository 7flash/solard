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

export function WalletsPage() {
  const data = state.overview;
  const walletQuery = state.walletSearch.trim().toLowerCase();
  const groupQuery = state.groupSearch.trim().toLowerCase();
  const wallets = (data?.wallets ?? []).filter((wallet: AnyRow) => {
    if (!walletQuery) return true;
    return (
      String(wallet.name ?? "")
        .toLowerCase()
        .includes(walletQuery) ||
      String(wallet.address ?? "")
        .toLowerCase()
        .includes(walletQuery)
    );
  });
  const groups = (data?.groups ?? []).filter((group: AnyRow) => {
    if (!groupQuery) return true;
    const haystack = [
      group.name,
      group.description,
      ...(group.wallets ?? []).map(
        (member: AnyRow) =>
          member.name ?? member.walletAddress ?? member.address,
      ),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(groupQuery);
  });
  const selectedWallet = state.terminalDefaultWallet
    ? data?.wallets?.find(
        (wallet: AnyRow) => wallet.address === state.terminalDefaultWallet,
      )
    : null;
  const selectedBalance = walletBalanceForAddress(state.terminalDefaultWallet);
  return (
    <div className="wallets-page">
      <section className="console-panel hero-panel">
        <div>
          <div className="section-kicker">Wallet command center</div>
          <h2>Wallets and groups</h2>
          <p className="muted">
            Encrypted local wallet store, buyer groups, default trading wallet,
            and live balances in one place.
          </p>
        </div>
        <div className="wallet-default-card">
          <label>
            <span>Default trading wallet</span>
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
              {(data?.wallets ?? []).map((wallet: AnyRow) => (
                <option value={wallet.address}>
                  {wallet.name
                    ? `${wallet.name} · ${short(wallet.address)}`
                    : wallet.address}
                </option>
              ))}
            </select>
          </label>
          <div className="wallet-default-meta">
            <b>{selectedWallet?.name ?? "no wallet selected"}</b>
            <span className="code">
              {selectedWallet?.address
                ? short(selectedWallet.address, 8, 8)
                : "—"}
            </span>
            <span>
              {selectedBalance
                ? `${solFromLamports(selectedBalance.solLamports)} SOL`
                : "—"}
            </span>
          </div>
        </div>
      </section>

      <div className="wallet-action-grid">
        <form
          className="console-panel"
          onSubmit={(event) => {
            event.preventDefault();
            const body = formData(event.currentTarget);
            void runAction(async () => {
              await api("/api/wallets/import", {
                method: "POST",
                body: JSON.stringify(body),
              });
              await refreshOverview();
            });
          }}
        >
          <h3>Import wallet</h3>
          <label>
            Name
            <input name="name" placeholder="main / buyer-1" />
          </label>
          <label>
            Private key
            <textarea
              name="privateKey"
              placeholder="base58 secret or keypair JSON"
            />
          </label>
          <button type="submit">Import encrypted wallet</button>
        </form>
        <form
          className="console-panel"
          onSubmit={(event) => {
            event.preventDefault();
            const body = formData(event.currentTarget);
            void runAction(async () => {
              await api("/api/groups/create", {
                method: "POST",
                body: JSON.stringify(body),
              });
              await refreshOverview();
            });
          }}
        >
          <h3>Create group</h3>
          <label>
            Group name
            <input name="name" placeholder="mind-buyers" />
          </label>
          <label>
            Description
            <input name="description" placeholder="Launch buyers / scalpers" />
          </label>
          <button type="submit">Create group</button>
        </form>
        <form
          className="console-panel"
          onSubmit={(event) => {
            event.preventDefault();
            const body = formData(event.currentTarget);
            void runAction(async () => {
              await api("/api/groups/add", {
                method: "POST",
                body: JSON.stringify(body),
              });
              await refreshOverview();
            });
          }}
        >
          <h3>Add member</h3>
          <label>
            Group
            <select name="groupName">
              <option value="">select group…</option>
              {(data?.groups ?? []).map((group: AnyRow) => (
                <option value={group.name}>{group.name}</option>
              ))}
            </select>
          </label>
          <label>
            Wallet
            <select name="wallet">
              <option value="">select wallet…</option>
              {(data?.wallets ?? []).map((wallet: AnyRow) => (
                <option value={wallet.address}>
                  {wallet.name
                    ? `${wallet.name} · ${short(wallet.address)}`
                    : wallet.address}
                </option>
              ))}
            </select>
          </label>
          <label>
            Weight bps
            <input name="weightBps" defaultValue="10000" />
          </label>
          <button type="submit">Add to group</button>
        </form>
      </div>

      <section className="console-panel">
        <div className="row between wrap">
          <div>
            <div className="section-kicker">Wallet inventory</div>
            <h2>All wallets</h2>
            <p className="muted small">
              {wallets.length}/{data?.wallets?.length ?? 0} wallets shown.
              Balances are best-effort RPC reads.
            </p>
          </div>
          <div className="toolbar compact-toolbar">
            <input
              value={state.walletSearch}
              placeholder="search name/address"
              onInput={(event: any) => {
                state.walletSearch = event.currentTarget.value;
                localStorage.setItem(
                  "solard:wallet-search",
                  state.walletSearch,
                );
                update();
              }}
            />
            <button
              type="button"
              className="secondary compact"
              onClick={() => void runAction(refreshOverview)}
            >
              Refresh
            </button>
          </div>
        </div>
        <div className="table-scroll tall-table">
          <table className="clean-table wallet-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Address</th>
                <th>SOL</th>
                <th>Holdings</th>
                <th>Use</th>
              </tr>
            </thead>
            <tbody>
              {wallets.map((wallet: AnyRow) => {
                const balance = walletBalanceForAddress(wallet.address);
                return (
                  <tr>
                    <td className="strong-cell">{wallet.name ?? "—"}</td>
                    <td className="code address-cell" title={wallet.address}>
                      {short(wallet.address, 8, 8)}
                    </td>
                    <td className="sol-cell">
                      {balance
                        ? `${solFromLamports(balance.solLamports)} SOL`
                        : "—"}
                    </td>
                    <td>
                      <div className="holdings">
                        {walletHoldingsChips(balance?.visibleTokenBalances)}
                      </div>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="secondary compact"
                        onClick={() => {
                          state.terminalDefaultWallet = wallet.address;
                          localStorage.setItem(
                            "solwal:terminal-default-wallet",
                            state.terminalDefaultWallet,
                          );
                          update();
                        }}
                      >
                        Set default
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="console-panel">
        <div className="row between wrap">
          <div>
            <div className="section-kicker">Buyer groups</div>
            <h2>Groups</h2>
            <p className="muted small">
              {groups.length}/{data?.groups?.length ?? 0} groups shown. Members
              are rendered as wallet chips.
            </p>
          </div>
          <input
            className="inline-search"
            value={state.groupSearch}
            placeholder="search groups"
            onInput={(event: any) => {
              state.groupSearch = event.currentTarget.value;
              localStorage.setItem("solard:group-search", state.groupSearch);
              update();
            }}
          />
        </div>
        <div className="group-grid">
          {groups.map((group: AnyRow) => (
            <div className="group-card">
              <div className="row between">
                <h3>{group.name}</h3>
                <span className="pill">
                  {group.wallets?.length ?? 0} wallets
                </span>
              </div>
              {group.description ? (
                <p className="muted small">{group.description}</p>
              ) : null}
              <div className="member-chip-list">
                {(group.wallets ?? []).map((member: AnyRow) => {
                  const address =
                    member.address ?? member.walletAddress ?? member.wallet;
                  const wallet = (data?.wallets ?? []).find(
                    (item: AnyRow) =>
                      item.address === address || item.name === member.name,
                  );
                  return (
                    <span className="member-chip" title={address}>
                      {wallet?.name ?? member.name ?? short(address)}{" "}
                      <small>{short(address, 4, 4)}</small>
                    </span>
                  );
                })}
                {!(group.wallets ?? []).length ? (
                  <span className="muted tiny">empty group</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export default function mount() {
  return mountPage("wallets", WalletsPage);
}
