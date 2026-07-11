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
  api,
  mountPage,
} from "../runtime";
import type { AnyRow, PumpFeedRow, TokenHolder } from "../runtime";

function sourceLabel(): string {
  return state.pumpFeedSource === "both"
    ? "Both"
    : state.pumpFeedSource === "helius"
      ? "Helius"
      : "PumpPortal";
}

function sortPinnedFirst(rows: PumpFeedRow[]): PumpFeedRow[] {
  const pinned = new Set(state.terminalPinnedMints);
  return [...rows].sort((a, b) => {
    const ap = !!a.mint && pinned.has(a.mint);
    const bp = !!b.mint && pinned.has(b.mint);
    if (ap !== bp) return ap ? -1 : 1;
    return 0;
  });
}

function rowFreshnessMs(row: PumpFeedRow): number | null {
  const raw = (row.raw ?? {}) as AnyRow;
  for (const value of [
    (row as any).priceUpdatedAtMs,
    raw.priceUpdatedAtMs,
    row.lastTradeAtMs,
    row.updatedAtMs,
    row.createdAtMs,
  ]) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function priceStatus(
  row: PumpFeedRow,
): "live" | "stale" | "snapshot" | "missing" {
  const direct = String((row as any).priceStatus ?? row.raw?.priceStatus ?? "");
  if (["live", "stale", "snapshot", "missing"].includes(direct)) {
    return direct as "live" | "stale" | "snapshot" | "missing";
  }
  if (latestMcap(row) == null && row.priceUsd == null) return "missing";
  const fresh = rowFreshnessMs(row);
  if (!fresh) return "missing";
  if (Date.now() - fresh > 30_000) return "stale";
  const source = String(
    (row as any).priceSource ?? row.raw?.priceSource ?? row.source ?? "",
  );
  return source.includes("snapshot") ? "snapshot" : "live";
}

function priceClass(row: PumpFeedRow): string {
  const status = priceStatus(row);
  return status === "live" ? "good" : status === "missing" ? "bad" : "warn";
}

function tradeCount(row: PumpFeedRow | null | undefined): number {
  if (!row) return 0;
  const direct = Number((row as any).tradeCount ?? NaN);
  if (Number.isFinite(direct)) return direct;
  return row.trades?.length ?? 0;
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

async function reloadTerminalRows(
  options: { health?: boolean } = {},
): Promise<void> {
  state.pumpFeedStatus = "connecting";
  state.terminalLastError = null;
  update();

  const payload = await api<{
    rows: PumpFeedRow[];
    rawRows?: AnyRow[];
    health?: AnyRow | null;
    stats?: AnyRow | null;
    meta?: AnyRow;
  }>(
    `/api/terminal/feed?limit=300&activeWindowMs=${encodeURIComponent(String(5 * 60_000))}&includeUnpriced=${state.pumpFeedSource === "helius" ? "1" : "0"}&source=${encodeURIComponent(state.pumpFeedSource)}&hideMayhem=${state.hideMayhem ? "1" : "0"}&hideUsdc=${state.hideUsdc ? "1" : "0"}&stats=${options.health ? "1" : "0"}&health=${options.health ? "1" : "0"}`,
  );

  state.pumpFeed = payload.rows ?? [];
  state.terminalLastPollAtMs = Date.now();
  state.terminalLastRows = state.pumpFeed.length;
  if (payload.health) state.terminalHealth = payload.health;
  state.pumpFeedStatus = "connected";
}

function healthSummary() {
  const health = state.terminalHealth as AnyRow | null;
  const store = (health?.store ?? {}) as AnyRow;
  const processes = Array.isArray(health?.processes)
    ? (health!.processes as AnyRow[])
    : [];
  const errors = Array.isArray(health?.errors)
    ? (health!.errors as AnyRow[])
    : [];
  const stale = processes.filter((row) => row.stale).length;
  return { health, store, processes, errors, stale };
}

function WorkerDiagnostics() {
  const { health, store, processes, errors, stale } = healthSummary();
  const ok = health?.ok === true && stale === 0;
  return (
    <section className={`terminal-diagnostics ${ok ? "ok" : "warn"}`}>
      <div>
        <b>{ok ? "workers ok" : "terminal health"}</b>
        <span>
          rows={state.terminalLastRows} poll=
          {state.terminalLastPollAtMs
            ? age(state.terminalLastPollAtMs)
            : "never"}{" "}
          · tokens={store.tokens ?? "?"} priced={store.pricedTokens ?? "?"}{" "}
          images={store.imagedTokens ?? "?"} trades={store.trades ?? "?"}
        </span>
        {state.terminalLastError ? (
          <code>{state.terminalLastError}</code>
        ) : null}
      </div>
      <div className="terminal-worker-list">
        {processes.slice(0, 6).map((proc) => (
          <span
            className={proc.stale || proc.error ? "bad" : "good"}
            title={proc.error ?? JSON.stringify(proc.data ?? {})}
          >
            {String(proc.name ?? "worker").replace(/^solard-/, "")}:
            {proc.buildMismatch
              ? "build-mismatch"
              : proc.stale
                ? "stale"
                : proc.status}
          </span>
        ))}
        {!processes.length ? (
          <span className="warn">health not loaded</span>
        ) : null}
      </div>
      <div className="terminal-diagnostic-actions">
        <button
          type="button"
          className="secondary compact"
          onClick={() =>
            void runAction(() => reloadTerminalRows({ health: true }), {
              refreshAfter: false,
            })
          }
        >
          refresh rows
        </button>
        <button
          type="button"
          className="secondary compact"
          onClick={() =>
            void runAction(
              async () => {
                state.terminalHealth = await api<AnyRow>(
                  `/api/terminal/health?errors=12&source=${encodeURIComponent(state.pumpFeedSource)}`,
                );
              },
              { refreshAfter: false },
            )
          }
        >
          health
        </button>
        <button
          type="button"
          className="secondary compact"
          onClick={() =>
            void runAction(
              async () => {
                await api("/api/workers/ensure", {
                  method: "POST",
                  body: JSON.stringify({
                    action: "restart",
                    worker: "all",
                    all: true,
                    telegram: true,
                    restartStale: true,
                    source: state.pumpFeedSource,
                    clearLive: true,
                  }),
                });
                await startPumpFeed({ hardRestart: true, clearRows: true });
              },
              { refreshAfter: false },
            )
          }
        >
          restart workers
        </button>
      </div>
      {errors.length ? (
        <details>
          <summary>latest worker errors ({errors.length})</summary>
          <pre>
            {JSON.stringify(errors.slice(0, 5), null, 2).slice(0, 3000)}
          </pre>
        </details>
      ) : null}
    </section>
  );
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
    return <p className="muted tiny">holders unavailable: {error}</p>;
  if (!holders.length)
    return <p className="muted tiny">click refresh to load holders.</p>;
  const maxPct = Math.max(
    0.000001,
    ...holders.map((holder) => Number(holder.pctSupply ?? 0)),
  );
  return (
    <div className="terminal-holder-list">
      {holders.slice(0, 12).map((holder: TokenHolder, index: number) => {
        const pct = Number(holder.pctSupply ?? 0);
        return (
          <a
            className="terminal-holder"
            href={`https://solscan.io/account/${holder.owner ?? holder.tokenAccount}`}
            target="_blank"
            rel="noreferrer"
          >
            <span>#{index + 1}</span>
            <b>{holder.uiAmount ?? holder.amount ?? "—"}</b>
            <code>{short(holder.owner ?? holder.tokenAccount, 4, 4)}</code>
            <span className="holder-pct">
              {pct > 0 ? `${pct.toFixed(pct >= 1 ? 2 : 4)}%` : "—"}
            </span>
            <em title={`${pct.toFixed(4)}% supply`}>
              <i
                style={{
                  width: `${Math.max(3, Math.min(100, (pct / maxPct) * 100))}%`,
                }}
              />
            </em>
          </a>
        );
      })}
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

  return (
    <div className="terminal-page-only">
      <section className="terminal-commandbar">
        <div className="terminal-title-compact">
          <span
            className={`dot ${state.pumpFeedStatus === "connected" ? "good" : state.pumpFeedStatus === "error" ? "bad" : ""}`}
          />
          <h2>Pump</h2>
          <span className="muted tiny">
            {sourceLabel()} · {state.pumpFeedStatus} · {rows.length}/
            {state.pumpFeed.length} · {state.terminalPinnedMints.length} pinned
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
              void reloadTerminalRows()
                .then(update)
                .catch(() => undefined);
              update();
            }}
          >
            <option value="helius">Helius primary</option>
            <option value="pumpportal">PumpPortal secondary</option>
            <option value="both">Both</option>
          </select>
          <button
            type="button"
            className="primary compact"
            onClick={() =>
              void startPumpFeed({
                hardRestart: state.pumpFeedStatus === "connected",
                clearRows: true,
              })
            }
          >
            {state.pumpFeedStatus === "connected" ? "restart poll" : "connect"}
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

      <WorkerDiagnostics />

      <section className="terminal-filterbar">
        <input
          value={state.pumpFeedFilter}
          placeholder="filter symbol / name / mint"
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
              void reloadTerminalRows()
                .then(update)
                .catch(() => undefined);
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
              void reloadTerminalRows()
                .then(update)
                .catch(() => undefined);
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
                <th>price</th>
                <th>mcap $</th>
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
                const fresh = rowFreshnessMs(row);
                return (
                  <tr
                    className={`${pinned ? "pinned-row" : ""} ${inspected ? "inspected-row" : ""}`}
                    onMouseEnter={() => fixTerminalInspector(row)}
                    onClick={() => fixTerminalInspector(row)}
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
                      >
                        {tokenImage(row) ? (
                          <img src={tokenImage(row)!} loading="lazy" />
                        ) : (
                          <span className="img-placeholder" />
                        )}
                        <span>
                          <b>{row.symbol ? `$${row.symbol}` : "—"}</b>
                          <small>
                            {row.name ??
                              short(row.mint ?? "", 4, 4) ??
                              "new token"}
                          </small>
                        </span>
                      </a>
                    </td>
                    <td className={`num-cell ${priceClass(row)}`}>
                      {row.priceUsd ? `$${row.priceUsd.toExponential(2)}` : "—"}
                    </td>
                    <td className="num-cell">{formatMcap(latestMcap(row))}</td>
                    <td>
                      <SmaInline row={row} />
                    </td>
                    <td>{tradeCount(row)}</td>
                    <td title={priceStatus(row)}>{fresh ? age(fresh) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length ? (
            <div className="empty-console">
              <b>No tokens visible.</b>
              <span>
                The shell loaded. Start workers, wait for trades, or loosen
                filters.
              </span>
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
                  <p>{inspector.name ?? short(inspector.mint ?? "", 5, 5)}</p>
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
                    void runAction(() => addToSelectedWatch(inspector), {
                      refreshAfter: false,
                    })
                  }
                >
                  watch
                </button>
                <button
                  type="button"
                  className="primary compact"
                  disabled={!inspector.mint || !state.terminalDefaultWallet}
                  onClick={() =>
                    void runAction(() => quickBuyPumpFeedRow(inspector), {
                      refreshAfter: false,
                    })
                  }
                >
                  {state.terminalQuickLive ? "LIVE BUY" : "SIM BUY"}
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
                <span>Status</span>
                <b className={priceClass(inspector)}>
                  {priceStatus(inspector)}
                </b>
                <span>MCap</span>
                <b>{formatMcap(currentMcap)}</b>
                <span>Price</span>
                <b>
                  {inspector.priceUsd
                    ? `$${inspector.priceUsd.toExponential(4)}`
                    : "—"}
                </b>
                <span>SMA 1m</span>
                <b>{formatMcap(inspector.sma1m)}</b>
                <span>SMA 5m</span>
                <b>{formatMcap(inspector.sma5m)}</b>
                <span>SMA 15m</span>
                <b>{formatMcap(inspector.sma15m)}</b>
                <span>Trades</span>
                <b>{tradeCount(inspector)}</b>
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

export default function mount() {
  return mountPage("terminal", TerminalPage);
}
