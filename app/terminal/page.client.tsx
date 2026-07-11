import { render } from "tradjs/client";
import { api } from "../_client/api";
import {
  age,
  formatMcap,
  formatPrice,
  numberValue,
  short,
} from "../_client/format";
import {
  storageFlag,
  storageGet,
  storageJson,
  storageSet,
} from "../_client/storage";
import type {
  AnyRow,
  PumpFeedRow,
  TerminalFeedPayload,
  TerminalHealthPayload,
} from "../_client/types";

type Source = "helius" | "pumpportal" | "both";
type Status = "idle" | "connecting" | "connected" | "error";

/**
 * 0 means "show latest DB rows" instead of only rows updated in the last N ms.
 * Health counts the full DB, so the feed should also be able to surface already
 * populated DB rows even when workers are stale.
 */
const ACTIVE_WINDOW_MS = 0;

type PageState = {
  source: Source;
  filter: string;
  rows: PumpFeedRow[];
  health: TerminalHealthPayload | null;
  status: Status;
  lastPollAtMs: number | null;
  lastRows: number;
  feedMeta: AnyRow | null;
  probeFallback: string | null;
  error: string | null;
  hideMayhem: boolean;
  hideUsdc: boolean;
  selectedKey: string | null;
  pinned: string[];
};

const state: PageState = {
  source: normalizeSource(storageGet("solwal:pump-feed-source", "both")),
  filter: "",
  rows: [],
  health: null,
  status: "idle",
  lastPollAtMs: null,
  lastRows: 0,
  feedMeta: null,
  probeFallback: null,
  error: null,
  hideMayhem: storageFlag("solwal:pump-hide-mayhem"),
  hideUsdc: storageFlag("solwal:pump-hide-usdc"),
  selectedKey: storageGet("solard:terminal-inspector-key", "") || null,
  pinned: storageJson<string[]>("solard:terminal-pinned-mints", []).filter(
    (item) => typeof item === "string",
  ),
};

let unmounted = false;
let pollInterval: ReturnType<typeof setInterval> | null = null;

function rootElement(): HTMLElement {
  const root = document.getElementById("app-root");
  if (!root) throw new Error("Missing #app-root");
  return root;
}

function rerender(): void {
  if (unmounted) return;
  render(<TerminalPage />, rootElement());
  document
    .querySelectorAll<HTMLAnchorElement>("#main-nav a")
    .forEach((link) =>
      link.classList.toggle("active", link.dataset.page === "terminal"),
    );
}

function normalizeSource(value: string): Source {
  if (value === "both" || value === "pumpportal" || value === "helius")
    return value;
  return "both";
}

function rowKey(row: PumpFeedRow): string {
  return (
    row.mint ||
    row.signature ||
    `${row.symbol ?? row.name ?? "row"}:${row.createdAtMs ?? row.updatedAtMs ?? ""}`
  );
}

function latestMcap(
  row: Partial<PumpFeedRow> | null | undefined,
): number | string | null {
  return (
    row?.marketCapUsd ??
    row?.marketCapSol ??
    row?.initialMarketCapUsd ??
    row?.initialMarketCapSol ??
    null
  );
}

function isPinned(row: PumpFeedRow): boolean {
  return !!row.mint && state.pinned.includes(row.mint);
}

function priceClass(row: PumpFeedRow): string {
  const status = String(row.priceStatus ?? "").toLowerCase();
  if (status === "live") return "good";
  if (status === "missing") return "bad";
  if (status === "stale" || status === "snapshot") return "warn";
  return numberValue(latestMcap(row)) == null ? "bad" : "good";
}

function sourceLabel(source: Source): string {
  if (source === "both") return "Both";
  if (source === "pumpportal") return "PumpPortal";
  return "Helius";
}

function socialLinks(row: PumpFeedRow): Array<{ kind: string; href: string }> {
  return [
    ["website", row.website],
    ["twitter", row.twitter],
    ["telegram", row.telegram],
    ["uri", row.uri],
  ]
    .filter(
      (item): item is [string, string] =>
        typeof item[1] === "string" && item[1].trim().startsWith("http"),
    )
    .map(([kind, href]) => ({ kind, href }));
}

function visibleRows(): PumpFeedRow[] {
  const q = state.filter.trim().toLowerCase();
  const filtered = q
    ? state.rows.filter((row) =>
        [
          row.name,
          row.symbol,
          row.mint,
          row.creator,
          row.quoteAsset,
          row.quoteMint,
          row.source,
        ]
          .join(" ")
          .toLowerCase()
          .includes(q),
      )
    : state.rows;

  return [...filtered].sort((a, b) => {
    const ap = isPinned(a);
    const bp = isPinned(b);
    if (ap !== bp) return ap ? -1 : 1;
    const at = Math.max(
      Number(a.lastTradeAtMs ?? 0),
      Number(a.priceUpdatedAtMs ?? 0),
      Number(a.updatedAtMs ?? 0),
      Number(a.createdAtMs ?? 0),
    );
    const bt = Math.max(
      Number(b.lastTradeAtMs ?? 0),
      Number(b.priceUpdatedAtMs ?? 0),
      Number(b.updatedAtMs ?? 0),
      Number(b.createdAtMs ?? 0),
    );
    return bt - at;
  });
}

function selectedRow(rows: PumpFeedRow[]): PumpFeedRow | null {
  return (
    rows.find(
      (row) =>
        rowKey(row) === state.selectedKey || row.mint === state.selectedKey,
    ) ??
    rows[0] ??
    null
  );
}

async function loadProbeFallback(): Promise<PumpFeedRow[]> {
  try {
    const params = new URLSearchParams({
      source: "both",
      ensure: "0",
      restartStale: "0",
      inject: "0",
      limit: "300",
    });

    const result = await api<AnyRow>(`/api/terminal/probe?${params}`);
    const rows = Array.isArray(result?.rows)
      ? (result.rows as PumpFeedRow[])
      : [];

    state.probeFallback = `probe rows=${rows.length} ok=${result?.ok === true ? "yes" : "no"}`;

    if (result?.stats || result?.workers || result?.errors) {
      state.health = {
        ...(state.health ?? {}),
        store: result.stats ?? state.health?.store,
        processes: Array.isArray(result.workers)
          ? result.workers
          : state.health?.processes,
        errors: Array.isArray(result.errors)
          ? result.errors
          : state.health?.errors,
        ok: result.ok === true,
      };
    }

    return rows;
  } catch (err) {
    state.probeFallback = `probe failed: ${err instanceof Error ? err.message : String(err)}`;
    return [];
  }
}

async function reload(
  options: { includeHealth?: boolean } = {},
): Promise<void> {
  state.status = "connecting";
  state.error = null;
  rerender();

  try {
    const params = new URLSearchParams({
      limit: "300",
      activeWindowMs: String(ACTIVE_WINDOW_MS),
      includeUnpriced: "1",
      source: state.source,
      hideMayhem: state.hideMayhem ? "1" : "0",
      hideUsdc: state.hideUsdc ? "1" : "0",
      stats: options.includeHealth ? "1" : "0",
      health: options.includeHealth ? "1" : "0",
      fallback: "1",
    });

    const payload = await api<TerminalFeedPayload>(
      `/api/terminal/feed?${params}`,
    );
    let rows = payload.rows ?? [];
    state.feedMeta = payload.meta ?? null;
    state.probeFallback = null;

    if (!rows.length) {
      rows = await loadProbeFallback();
    }

    state.rows = rows;
    state.lastRows = rows.length;
    state.lastPollAtMs = Date.now();
    if (payload.health) state.health = payload.health;
    state.status = "connected";
  } catch (err) {
    state.status = "error";
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    rerender();
  }
}

function stopPolling(): void {
  if (pollInterval != null) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (state.status !== "error") state.status = "idle";
  rerender();
}

function startPolling(): void {
  stopPolling();
  void reload({ includeHealth: true });
  pollInterval = setInterval(() => void reload(), 2500);
}

async function restartWorkers(): Promise<void> {
  state.error = null;
  rerender();

  try {
    await api("/api/workers/ensure", {
      method: "POST",
      body: JSON.stringify({
        action: "restart",
        worker: "all",
        all: true,
        telegram: true,
        restartStale: true,
        source: state.source,
        clearLive: true,
      }),
    });
    startPolling();
  } catch (err) {
    state.status = "error";
    state.error = err instanceof Error ? err.message : String(err);
    rerender();
  }
}

function setSource(next: Source): void {
  state.source = next;
  storageSet("solwal:pump-feed-source", next);
  void reload({ includeHealth: true });
}

function setFilter(next: string): void {
  state.filter = next;
  rerender();
}

function togglePinned(row: PumpFeedRow): void {
  if (!row.mint) return;
  state.pinned = state.pinned.includes(row.mint)
    ? state.pinned.filter((mint) => mint !== row.mint)
    : [row.mint, ...state.pinned];
  storageSet("solard:terminal-pinned-mints", JSON.stringify(state.pinned));
  rerender();
}

function selectRow(row: PumpFeedRow): void {
  const key = rowKey(row);
  state.selectedKey = key;
  storageSet("solard:terminal-inspector-key", key);
  rerender();
}

function toggleFlag(key: string, field: "hideMayhem" | "hideUsdc"): void {
  state[field] = !state[field];
  storageSet(key, state[field] ? "1" : "0");
  void reload({ includeHealth: true });
}

function workerSummary(health: TerminalHealthPayload | null): {
  processes: AnyRow[];
  errors: AnyRow[];
  stale: number;
  ok: boolean;
} {
  const processes = Array.isArray(health?.processes) ? health!.processes! : [];
  const errors = Array.isArray(health?.errors) ? health!.errors! : [];
  const stale = processes.filter((row) => row.stale).length;
  return { processes, errors, stale, ok: health?.ok === true && stale === 0 };
}

function TerminalPage() {
  const rows = visibleRows();
  const inspector = selectedRow(rows);
  const worker = workerSummary(state.health);

  return (
    <div className="terminal-compact terminal-page">
      {state.error ? (
        <div className="global-error-strip">
          <span className="pill bad">{state.error}</span>
        </div>
      ) : null}

      <section className="terminal-topline">
        <div className="terminal-titleline">
          <span
            className={`dot ${state.status === "connected" ? "good" : state.status === "error" ? "bad" : ""}`}
          />
          <h2>Pump</h2>
          <span className="muted tiny">
            {sourceLabel(state.source)} · {state.status} · {rows.length}/
            {state.rows.length} · {state.pinned.length} pinned
          </span>
        </div>

        <div className="terminal-controls-inline">
          <select
            value={state.source}
            onInput={(event: any) =>
              setSource(normalizeSource(event.currentTarget.value))
            }
          >
            <option value="both">Both</option>
            <option value="helius">Helius primary</option>
            <option value="pumpportal">PumpPortal secondary</option>
          </select>

          <button
            type="button"
            className="primary compact"
            onClick={startPolling}
          >
            {state.status === "connected" ? "restart poll" : "connect"}
          </button>
          <button
            type="button"
            className="secondary compact"
            onClick={stopPolling}
          >
            stop
          </button>
          <button
            type="button"
            className="secondary compact"
            onClick={() => void reload({ includeHealth: true })}
          >
            refresh
          </button>
          <button
            type="button"
            className="secondary compact"
            onClick={() => void restartWorkers()}
          >
            restart workers
          </button>
        </div>
      </section>

      <section className="terminal-filterline">
        <input
          aria-label="filter terminal rows"
          placeholder="filter symbol, mint, creator"
          value={state.filter}
          onInput={(event: any) => setFilter(event.currentTarget.value)}
        />

        <button
          type="button"
          className={`micro-switch ${state.hideMayhem ? "active" : ""}`}
          onClick={() => toggleFlag("solwal:pump-hide-mayhem", "hideMayhem")}
        >
          hide mayhem
        </button>

        <button
          type="button"
          className={`micro-switch ${state.hideUsdc ? "active" : ""}`}
          onClick={() => toggleFlag("solwal:pump-hide-usdc", "hideUsdc")}
        >
          hide usdc
        </button>

        <span
          className={`pill ${worker.ok ? "ok" : state.health ? "warn" : ""}`}
        >
          health {state.health ? (worker.ok ? "ok" : "check") : "not loaded"}
        </span>
        <span className="muted tiny">
          poll={state.lastPollAtMs ? age(state.lastPollAtMs) : "never"} · rows=
          {state.lastRows}
          {state.feedMeta
            ? ` · raw=${state.feedMeta.count ?? state.feedMeta.raw ?? "?"} fallback=${state.feedMeta.fallbackUsed ? "yes" : "no"}`
            : ""}
          {state.probeFallback ? ` · ${state.probeFallback}` : ""}
        </span>
      </section>

      <section className="terminal-diagnostics">
        <div>
          <b>{worker.ok ? "workers ok" : "terminal health"}</b>
          <span>
            tokens={state.health?.store?.tokens ?? "?"} priced=
            {state.health?.store?.pricedTokens ?? "?"} trades=
            {state.health?.store?.trades ?? "?"}
          </span>
        </div>
        <div className="terminal-worker-list">
          {worker.processes.slice(0, 6).map((proc) => (
            <span
              key={String(proc.name ?? proc.pid ?? Math.random())}
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
          {!worker.processes.length ? (
            <span className="warn">health not loaded</span>
          ) : null}
        </div>
      </section>

      <section className="terminal-split compact-split terminal-feed-layout">
        <div className="terminal-feed-compact feed-panel">
          <div className="improved-feed-table">
            <table className="terminal-feed-table clean-table">
              <thead>
                <tr>
                  <th>Pin</th>
                  <th>Token</th>
                  <th>Mcap</th>
                  <th>Price</th>
                  <th>SMA</th>
                  <th>Status</th>
                  <th>Source</th>
                  <th>Mint</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const key = rowKey(row);
                  const active = inspector ? rowKey(inspector) === key : false;
                  return (
                    <tr
                      key={key}
                      className={`${active ? "active-row inspected-row" : ""} ${isPinned(row) ? "pinned-row" : ""}`}
                      onClick={() => selectRow(row)}
                    >
                      <td>
                        <button
                          type="button"
                          className={`pin-button ${isPinned(row) ? "active" : ""}`}
                          onClick={(event: any) => {
                            event.stopPropagation();
                            togglePinned(row);
                          }}
                        >
                          {isPinned(row) ? "★" : "☆"}
                        </button>
                      </td>
                      <td>
                        <b>{row.symbol ? `$${row.symbol}` : row.name || "—"}</b>
                        <div className="muted tiny">
                          {row.name || "unnamed"}
                        </div>
                      </td>
                      <td>{formatMcap(latestMcap(row))}</td>
                      <td>{formatPrice(row.priceUsd)}</td>
                      <td className="sma-stack">
                        <span>{formatMcap(row.sma1m)}</span>
                        <span>{formatMcap(row.sma5m)}</span>
                        <span>{formatMcap(row.sma15m)}</span>
                      </td>
                      <td>
                        <span className={`pill ${priceClass(row)}`}>
                          {row.priceStatus ?? "—"}
                        </span>
                      </td>
                      <td>{row.source ?? "—"}</td>
                      <td className="code">{short(row.mint, 5, 5)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {!rows.length ? (
            <p className="muted" style={{ padding: "12px" }}>
              No terminal rows yet. Feed and probe fallback both returned zero
              rows. Open
              /api/terminal/probe?source=both&ensure=0&restartStale=0&limit=20
              to inspect the server-side row source.
            </p>
          ) : null}
        </div>

        <aside className="terminal-inspector-compact inspector-panel sticky-inspector">
          {inspector ? (
            <>
              <div className="row between">
                <div>
                  <h3>
                    {inspector.symbol
                      ? `$${inspector.symbol}`
                      : inspector.name || "Token"}
                  </h3>
                  <div className="muted small">
                    {inspector.name || short(inspector.mint, 8, 8)}
                  </div>
                </div>
                <span className={`pill ${priceClass(inspector)}`}>
                  {inspector.priceStatus ?? "price"}
                </span>
              </div>

              <div className="inspector-actions">
                <button
                  type="button"
                  className="secondary compact"
                  onClick={() => togglePinned(inspector)}
                >
                  {isPinned(inspector) ? "unpin" : "pin"}
                </button>
                {inspector.mint ? (
                  <a
                    className="button-link secondary compact"
                    href={`https://solscan.io/token/${inspector.mint}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    solscan
                  </a>
                ) : null}
                {inspector.mint ? (
                  <a
                    className="button-link secondary compact"
                    href={`https://pump.fun/${inspector.mint}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    pump
                  </a>
                ) : null}
              </div>

              <div className="social-links">
                {socialLinks(inspector).length ? (
                  socialLinks(inspector).map((link) => (
                    <a
                      key={`${link.kind}:${link.href}`}
                      href={link.href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {link.kind}
                    </a>
                  ))
                ) : (
                  <span className="muted tiny">no socials</span>
                )}
              </div>

              <div className="terminal-token-stats">
                <span>Mcap</span>
                <b>{formatMcap(latestMcap(inspector))}</b>
                <span>Price</span>
                <b>{formatPrice(inspector.priceUsd)}</b>
                <span>SMA 1m</span>
                <b>{formatMcap(inspector.sma1m)}</b>
                <span>SMA 5m</span>
                <b>{formatMcap(inspector.sma5m)}</b>
                <span>SMA 15m</span>
                <b>{formatMcap(inspector.sma15m)}</b>
                <span>Trades</span>
                <b>{inspector.tradeCount ?? 0}</b>
                <span>Creator</span>
                <b className="code">{short(inspector.creator, 5, 5)}</b>
                <span>Mint</span>
                <b className="code">{short(inspector.mint, 6, 6)}</b>
              </div>

              <details className="raw-json">
                <summary>raw token row</summary>
                <pre>
                  {JSON.stringify(inspector.raw ?? inspector, null, 2).slice(
                    0,
                    5000,
                  )}
                </pre>
              </details>

              {worker.errors.length ? (
                <details className="raw-json">
                  <summary>
                    latest worker errors ({worker.errors.length})
                  </summary>
                  <pre>
                    {JSON.stringify(worker.errors.slice(0, 5), null, 2).slice(
                      0,
                      3000,
                    )}
                  </pre>
                </details>
              ) : null}
            </>
          ) : (
            <p className="muted">No token selected yet.</p>
          )}
        </aside>
      </section>
    </div>
  );
}

export default function mount() {
  unmounted = false;
  rerender();
  void reload({ includeHealth: true });

  if (storageGet("solard:pump-auto-connect", "") === "1") {
    startPolling();
  }

  return () => {
    unmounted = true;
    if (pollInterval != null) clearInterval(pollInterval);
    pollInterval = null;
  };
}
