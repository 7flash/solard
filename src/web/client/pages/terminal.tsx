import {
  state,
  update,
  runAction,
  startPumpFeed,
  stopPumpFeed,
  short,
  tokenUrl,
  tokenImage,
  passesBadgeFilters,
  formatMcap,
  latestMcap,
  mcapChangePct,
  formatPct,
  sortFeedRows,
  age,
  selectedWatchGroup,
  addWatchedToken,
  starPumpFeedRow,
  quickBuyPumpFeedRow,
  pumpRowKey,
  isTerminalPinned,
  toggleTerminalPinned,
  fixTerminalInspector,
  followLatestInTerminalInspector,
  tokenSocialLinks,
  refreshTokenHolders,
  isLikelySolanaPublicKey,
} from "../runtime";
import type { AnyRow, PumpFeedRow, TokenHolder } from "../runtime";

function sortPinnedFirst(rows: PumpFeedRow[]): PumpFeedRow[] {
  const pinned = new Set(state.terminalPinnedMints);
  return [...rows].sort((a, b) => {
    const ap = !!a.mint && pinned.has(a.mint);
    const bp = !!b.mint && pinned.has(b.mint);
    if (ap !== bp) return ap ? -1 : 1;
    return 0;
  });
}

function chooseInspector(rows: PumpFeedRow[]): PumpFeedRow | null {
  if (state.terminalInspectorFixed && state.terminalInspectorKey) {
    const fixed = rows.find(
      (row) =>
        pumpRowKey(row) === state.terminalInspectorKey ||
        row.mint === state.terminalInspectorKey ||
        row.signature === state.terminalInspectorKey,
    );
    if (fixed) return fixed;
  }
  return rows[0] ?? state.pumpFeed[0] ?? null;
}

let holderHoverTimer: ReturnType<typeof setTimeout> | null = null;

function inspectRow(row: PumpFeedRow): void {
  fixTerminalInspector(row);
  if (holderHoverTimer) clearTimeout(holderHoverTimer);
  if (!isLikelySolanaPublicKey(row.mint)) return;
  const key = pumpRowKey(row);
  const mint = row.mint!;
  holderHoverTimer = setTimeout(() => {
    if (
      state.terminalInspectorKey === key ||
      state.terminalInspectorKey === mint
    ) {
      void refreshTokenHolders(mint)
        .then(update)
        .catch(() => undefined);
    }
  }, 275);
}

function SocialLinks({ row }: { row: PumpFeedRow }) {
  const links = tokenSocialLinks(row).filter((link) => link.kind !== "uri");
  return (
    <div className="terminal-socials">
      {links.length ? (
        links.slice(0, 5).map((link) => (
          <a href={link.href} target="_blank" rel="noreferrer">
            {link.kind}
          </a>
        ))
      ) : (
        <span className="muted tiny">no socials</span>
      )}
    </div>
  );
}

function HolderList({ mint }: { mint?: string | null }) {
  if (!mint) return <p className="muted tiny">No mint.</p>;
  const holders = state.tokenHolders[mint] ?? [];
  const loading = state.tokenHoldersLoadingMint === mint;
  const error = state.tokenHolderErrors[mint];
  if (!isLikelySolanaPublicKey(mint))
    return <p className="muted tiny">No valid token mint extracted yet.</p>;
  if (loading && !holders.length)
    return <p className="muted tiny">loading holders…</p>;
  if (error && !holders.length)
    return <p className="muted tiny">holders indexing / not ready yet</p>;
  if (!holders.length)
    return (
      <p className="muted tiny">
        hover keeps inspector here; click refresh holders.
      </p>
    );
  return (
    <div className="terminal-holder-list">
      {holders.slice(0, 10).map((holder: TokenHolder, index: number) => (
        <a
          className="terminal-holder"
          href={`https://solscan.io/account/${holder.owner ?? holder.tokenAccount}`}
          target="_blank"
          rel="noreferrer"
        >
          <span>#{index + 1}</span>
          <b>{holder.uiAmount ?? holder.amount ?? "—"}</b>
          <code>{short(holder.owner ?? holder.tokenAccount, 4, 4)}</code>
        </a>
      ))}
    </div>
  );
}

function SmaInline({ row }: { row: PumpFeedRow }) {
  return (
    <span className="terminal-sma-inline">
      <b>{formatMcap(row.sma1m)}</b>
      <b>{formatMcap(row.sma5m)}</b>
      <b>{formatMcap(row.sma15m)}</b>
    </span>
  );
}

async function addToSelectedWatch(row: PumpFeedRow): Promise<void> {
  const group = selectedWatchGroup() ?? state.watchGroups[0];
  if (!group) throw new Error("Create or select a watch group first");
  if (!row.mint) throw new Error("Token mint is required");
  await addWatchedToken(group.id, {
    mint: row.mint,
    name: row.name ?? null,
    symbol: row.symbol ?? null,
    creator: row.creator ?? null,
    uri: row.uri ?? null,
    image: row.image ?? null,
    signature: row.signature ?? null,
    marketCapSol: latestMcap(row),
    isMayhemMode: row.isMayhemMode ?? null,
    quoteAsset: row.quoteAsset ?? null,
    quoteMint: row.quoteMint ?? null,
    source: "terminal-inspector",
  });
}

function compactWalletLabel(): string {
  if (!state.terminalDefaultWallet) return "wallet…";
  return (
    (state.overview?.wallets ?? []).find(
      (wallet: AnyRow) =>
        wallet.address === state.terminalDefaultWallet ||
        wallet.name === state.terminalDefaultWallet,
    )?.name ?? short(state.terminalDefaultWallet, 4, 4)
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
  const rows = sortPinnedFirst(sortFeedRows(filteredRows));
  const inspector = chooseInspector(rows);
  const currentMcap = latestMcap(inspector ?? {});
  const currentDeltaPct = mcapChangePct(inspector ?? {});

  return (
    <div className="terminal-page-only">
      <section className="terminal-commandbar">
        <div className="terminal-title-compact">
          <span
            className={`dot ${state.pumpFeedStatus === "connected" ? "good" : state.pumpFeedStatus === "error" ? "bad" : ""}`}
          />
          <h2>Pump</h2>
          <span className="muted tiny">
            {state.pumpFeedSource === "helius" ? "Helius" : "PumpPortal"} ·{" "}
            {rows.length}/{state.pumpFeed.length} ·{" "}
            {state.terminalPinnedMints.length} pinned
          </span>
        </div>
        <div className="terminal-actions-compact">
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
            <option value="helius">Helius</option>
            <option value="pumpportal">PumpPortal</option>
          </select>
          <button
            type="button"
            className="primary compact"
            onClick={() => void startPumpFeed()}
          >
            {state.pumpFeedStatus === "connected" ? "reconnect" : "connect"}
          </button>
          <button
            type="button"
            className="secondary compact"
            onClick={stopPumpFeed}
          >
            stop
          </button>
          <select
            value={state.selectedWatchGroupId ?? ""}
            onInput={(event: any) => {
              state.selectedWatchGroupId = event.currentTarget.value || null;
              update();
            }}
          >
            <option value="">watch…</option>
            {state.watchGroups.map((group) => (
              <option value={group.id}>{group.name}</option>
            ))}
          </select>
          <select
            value={state.terminalDefaultWallet}
            title={compactWalletLabel()}
            onInput={(event: any) => {
              state.terminalDefaultWallet = event.currentTarget.value;
              localStorage.setItem(
                "solwal:terminal-default-wallet",
                state.terminalDefaultWallet,
              );
              update();
            }}
          >
            <option value="">wallet…</option>
            {(state.overview?.wallets ?? []).map((wallet: AnyRow) => (
              <option value={wallet.address}>
                {wallet.name ?? short(wallet.address)} ·{" "}
                {short(wallet.address, 3, 3)}
              </option>
            ))}
          </select>
          <input
            className="micro-input"
            value={state.terminalDefaultBuySol}
            title="default buy SOL"
            onInput={(event: any) => {
              state.terminalDefaultBuySol = event.currentTarget.value;
              localStorage.setItem(
                "solwal:terminal-default-buy-sol",
                state.terminalDefaultBuySol,
              );
              update();
            }}
          />
          <label className="terminal-sim">
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
            {state.terminalQuickLive ? "LIVE" : "SIM"}
          </label>
        </div>
      </section>

      <section className="terminal-filterbar">
        <input
          value={state.pumpFeedFilter}
          placeholder="filter symbol / name"
          onInput={(event: any) => {
            state.pumpFeedFilter = event.currentTarget.value;
            update();
          }}
        />
        <select
          value={state.pumpFeedSort}
          onInput={(event: any) => {
            state.pumpFeedSort = event.currentTarget.value;
            localStorage.setItem("solwal:pump-feed-sort", state.pumpFeedSort);
            update();
          }}
        >
          <option value="newest">newest</option>
          <option value="mcap-desc">mcap ↓</option>
          <option value="mcap-asc">mcap ↑</option>
          <option value="mcap-change-pct-desc">Δ% ↓</option>
          <option value="sma1m-desc">SMA 1m ↓</option>
          <option value="sma5m-desc">SMA 5m ↓</option>
          <option value="sma15m-desc">SMA 15m ↓</option>
          <option value="trades-desc">trades ↓</option>
        </select>
        <label>
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
          />{" "}
          hide mayhem
        </label>
        <label>
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
          />{" "}
          hide usdc
        </label>
        <button
          type="button"
          className="danger compact"
          onClick={() => {
            state.pumpFeed = [];
            followLatestInTerminalInspector();
            update();
          }}
        >
          clear
        </button>
      </section>

      <section className="terminal-grid-tight">
        <div className="terminal-table-wrap">
          <table className="terminal-tight-table">
            <thead>
              <tr>
                <th></th>
                <th>token</th>
                <th>mcap</th>
                <th>Δ%</th>
                <th>SMA 1/5/15</th>
                <th>trd</th>
                <th>age</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const pinned = isTerminalPinned(row);
                const inspected =
                  inspector && pumpRowKey(row) === pumpRowKey(inspector);
                return (
                  <tr
                    className={`${pinned ? "pinned-row" : ""} ${inspected ? "inspected-row" : ""}`}
                    onMouseEnter={() => inspectRow(row)}
                  >
                    <td>
                      <button
                        type="button"
                        className={`pin-button ${pinned ? "active" : ""}`}
                        disabled={!row.mint}
                        onClick={(event: any) => {
                          event.preventDefault();
                          event.stopPropagation();
                          toggleTerminalPinned(row);
                        }}
                      >
                        {pinned ? "◆" : "◇"}
                      </button>
                    </td>
                    <td className="terminal-token-cell">
                      <a
                        href={tokenUrl(row.mint)}
                        target="_blank"
                        rel="noreferrer"
                        onFocus={() => inspectRow(row)}
                      >
                        {tokenImage(row) ? (
                          <img src={tokenImage(row)!} loading="lazy" />
                        ) : (
                          <span className="img-placeholder" />
                        )}
                        <span>
                          <b>{row.symbol ? `$${row.symbol}` : "—"}</b>
                          <small>{row.name ?? "new token"}</small>
                        </span>
                      </a>
                    </td>
                    <td className="num-cell">{formatMcap(latestMcap(row))}</td>
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
                    <td>
                      <SmaInline row={row} />
                    </td>
                    <td>{row.trades?.length ?? 0}</td>
                    <td>
                      {row.lastTradeAtMs
                        ? age(row.lastTradeAtMs)
                        : row.createdAtMs
                          ? age(row.createdAtMs)
                          : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length ? (
            <div className="empty-console">
              <b>No tokens visible.</b>
              <span>Connect the stream or loosen filters.</span>
            </div>
          ) : null}
        </div>

        <aside className="terminal-hover-inspector">
          <header>
            <span className="section-kicker">Inspector</span>
            <button
              type="button"
              className="secondary compact"
              onClick={() => {
                followLatestInTerminalInspector();
                update();
              }}
            >
              latest
            </button>
          </header>
          {inspector ? (
            <div className="terminal-inspector-body">
              <div className="terminal-inspector-token">
                {tokenImage(inspector) ? (
                  <img src={tokenImage(inspector)!} loading="lazy" />
                ) : (
                  <div className="img-placeholder large" />
                )}
                <div>
                  <h3>{inspector.symbol ? `$${inspector.symbol}` : "Token"}</h3>
                  <p>{inspector.name ?? "latest feed token"}</p>
                  <SocialLinks row={inspector} />
                </div>
              </div>
              <div className="terminal-inspector-actions">
                <button
                  type="button"
                  className={`secondary compact ${isTerminalPinned(inspector) ? "active" : ""}`}
                  disabled={!inspector.mint}
                  onClick={() => {
                    toggleTerminalPinned(inspector);
                    update();
                  }}
                >
                  {isTerminalPinned(inspector) ? "unpin" : "pin"}
                </button>
                <button
                  type="button"
                  className="secondary compact"
                  disabled={!inspector.mint}
                  onClick={() =>
                    void runAction(() => addToSelectedWatch(inspector))
                  }
                >
                  watch
                </button>
                <button
                  type="button"
                  className="primary compact"
                  disabled={!inspector.mint || !state.terminalDefaultWallet}
                  onClick={() =>
                    void runAction(() => quickBuyPumpFeedRow(inspector))
                  }
                >
                  {state.terminalQuickLive ? "BUY" : "SIM"}
                </button>
                <button
                  type="button"
                  className="secondary compact"
                  disabled={!inspector.mint}
                  onClick={() => void starPumpFeedRow(inspector)}
                >
                  ★
                </button>
              </div>
              <div className="terminal-kv">
                <span>MCap</span>
                <b>{formatMcap(currentMcap)} SOL</b>
                <span>Δ %</span>
                <b
                  className={
                    currentDeltaPct != null && currentDeltaPct > 0
                      ? "gain"
                      : currentDeltaPct != null && currentDeltaPct < 0
                        ? "loss"
                        : ""
                  }
                >
                  {formatPct(currentDeltaPct)}
                </b>
                <span>SMA 1m</span>
                <b>{formatMcap(inspector.sma1m)}</b>
                <span>SMA 5m</span>
                <b>{formatMcap(inspector.sma5m)}</b>
                <span>SMA 15m</span>
                <b>{formatMcap(inspector.sma15m)}</b>
                <span>Trades</span>
                <b>{inspector.trades?.length ?? 0}</b>
                <span>Mint</span>
                <a
                  href={tokenUrl(inspector.mint)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {short(inspector.mint ?? "", 5, 5)}
                </a>
              </div>
              <div className="terminal-holders">
                <div>
                  <b>Top holders</b>
                  <button
                    type="button"
                    className="secondary compact"
                    disabled={!isLikelySolanaPublicKey(inspector.mint)}
                    onClick={() =>
                      inspector.mint &&
                      void refreshTokenHolders(inspector.mint).then(update)
                    }
                  >
                    refresh
                  </button>
                </div>
                <HolderList mint={inspector.mint} />
              </div>
              <details className="raw-json">
                <summary>raw</summary>
                <pre>
                  {JSON.stringify(inspector.raw ?? inspector, null, 2).slice(
                    0,
                    4000,
                  )}
                </pre>
              </details>
            </div>
          ) : (
            <p className="muted">No token selected yet.</p>
          )}
        </aside>
      </section>
    </div>
  );
}
