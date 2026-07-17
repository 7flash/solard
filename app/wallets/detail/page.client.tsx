import "./page.css";
import { render } from "tradjs/client";

type AnyRow = Record<string, any>;
type ParseStatus = "pending" | "parsed" | "ignored" | "error";

type WalletRow = {
  address: string;
  label?: string | null;
  enabled?: number | boolean;
  backfillEnabled?: number | boolean;
  lastBackfillAtMs?: number;
  lastSeenSlot?: number;
  tradeCount?: number;
  lastTradeAtMs?: number | null;
};

type TransactionRow = {
  walletTxKey: string;
  wallet: string;
  signature: string;
  slot: number;
  confidence: string;
  parseStatus: ParseStatus;
  parserVersion: string;
  error?: string | null;
  tradedAtMs: number;
  updatedAtMs: number;
  swapCount?: number;
  rawJson?: string;
};

type SwapRow = {
  eventKey: string;
  signature: string;
  side: string;
  inputMint: string;
  inputAmountUi: number;
  outputMint: string;
  outputAmountUi: number;
  subjectMint: string;
  quoteMint?: string | null;
  venue: string;
  parser: string;
  classificationConfidence: string;
  copyable: number | boolean;
  token?: AnyRow;
  tradedAtMs: number;
};

type DiagnosticsPayload = {
  wallets?: WalletRow[];
  swaps?: SwapRow[];
  positions?: AnyRow[];
  worker?: AnyRow | null;
  transactionStats?: AnyRow;
  stats?: AnyRow;
  diagnostics?: {
    transactions?: TransactionRow[];
    parseStatuses?: Array<{ key: string; count: number }>;
    parserVersions?: Array<{ key: string; count: number }>;
    swapParsers?: Array<{ key: string; count: number }>;
    venues?: Array<{ key: string; count: number }>;
    confidence?: Array<{ key: string; count: number }>;
    errors?: AnyRow[];
    selectedTransaction?: (TransactionRow & { swaps?: SwapRow[] }) | null;
    copyProfiles?: AnyRow[];
    copyIntents?: AnyRow[];
  };
  generatedAtMs?: number;
};

type PageState = {
  payload: DiagnosticsPayload;
  wallet: string;
  status: "" | ParseStatus;
  search: string;
  loading: boolean;
  action: string | null;
  error: string | null;
  notice: string | null;
  selectedSignature: string;
  selectedLoading: boolean;
};

const state: PageState = {
  payload: { wallets: [], diagnostics: { transactions: [] } },
  wallet: "",
  status: "",
  search: "",
  loading: true,
  action: null,
  error: null,
  notice: null,
  selectedSignature: "",
  selectedLoading: false,
};

let unmounted = false;
let renderFrame: number | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function rootElement(): HTMLElement {
  const root = document.getElementById("app-root");
  if (!root) throw new Error("Missing #app-root.");
  return root;
}

function updateActiveNavigation(): void {
  document
    .querySelectorAll<HTMLAnchorElement>("#main-nav a")
    .forEach((link) =>
      link.classList.toggle("active", link.dataset.page === "wallets"),
    );
}

function rerender(): void {
  if (unmounted || renderFrame != null) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;
    render(<WalletDiagnosticsPage />, rootElement(), {
      reconciler: "sequential",
    });
    updateActiveNavigation();
  });
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem("solwal:web-token") ?? "";
  return token ? { "x-solwal-web-token": token } : {};
}

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...authHeaders(),
      ...(options.headers ?? {}),
    },
  });
  const body = await response.text();
  let payload: any = {};
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    payload = { error: body };
  }
  if (!response.ok || payload?.ok === false) {
    throw new Error(
      String(payload?.error ?? payload?.message ?? `HTTP ${response.status}`),
    );
  }
  return (payload?.value ?? payload?.data ?? payload) as T;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function enabled(value: unknown): boolean {
  return value === true || number(value) > 0;
}

function shortAddress(value: unknown, head = 7, tail = 7): string {
  const raw = text(value);
  if (raw.length <= head + tail + 1) return raw;
  return `${raw.slice(0, head)}…${raw.slice(-tail)}`;
}

function formatInteger(value: unknown): string {
  return Math.max(0, number(value)).toLocaleString();
}

function formatAmount(value: unknown): string {
  const parsed = number(value);
  if (!parsed) return "0";
  if (Math.abs(parsed) >= 1_000)
    return parsed.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return parsed.toLocaleString(undefined, { maximumSignificantDigits: 7 });
}

function timeAgo(value: unknown): string {
  const timestamp = number(value);
  if (!timestamp) return "Never";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function wallets(): WalletRow[] {
  return Array.isArray(state.payload.wallets) ? state.payload.wallets : [];
}

function selectedWallet(): WalletRow | null {
  return wallets().find((row) => row.address === state.wallet) ?? null;
}

function transactions(): TransactionRow[] {
  const rows = state.payload.diagnostics?.transactions;
  return Array.isArray(rows) ? rows : [];
}

function filteredTransactions(): TransactionRow[] {
  const query = state.search.trim().toLowerCase();
  return transactions().filter((row) => {
    if (state.status && row.parseStatus !== state.status) return false;
    if (!query) return true;
    return [
      row.signature,
      row.parserVersion,
      row.error,
      row.confidence,
      row.slot,
    ].some((value) =>
      String(value ?? "")
        .toLowerCase()
        .includes(query),
    );
  });
}

function walletLabel(wallet: WalletRow): string {
  return text(wallet.label) || shortAddress(wallet.address);
}

function diagnosticsQuery(
  input: { signature?: string; includeRaw?: boolean } = {},
): string {
  const params = new URLSearchParams({
    includeTransactions: "1",
    transactionLimit: "1000",
    limit: "500",
    positionLimit: "20000",
  });
  if (state.wallet) params.set("wallet", state.wallet);
  if (input.signature) params.set("signature", input.signature);
  if (input.includeRaw) params.set("includeRaw", "1");
  return `/api/wallet-tracker?${params.toString()}`;
}

function schedulePoll(delay = 6_000): void {
  if (pollTimer) clearTimeout(pollTimer);
  if (unmounted) return;
  pollTimer = setTimeout(() => void refresh(false), delay);
}

async function refresh(showSpinner = true): Promise<void> {
  if (showSpinner) state.loading = true;
  rerender();
  try {
    const payload = await api<DiagnosticsPayload>(
      diagnosticsQuery(
        state.selectedSignature
          ? { signature: state.selectedSignature, includeRaw: true }
          : {},
      ),
    );
    state.payload = payload;
    state.error = null;
    if (!state.wallet && wallets()[0]) {
      state.wallet = wallets()[0]!.address;
      history.replaceState(
        null,
        "",
        `/wallets/detail?wallet=${encodeURIComponent(state.wallet)}`,
      );
      const selected = await api<DiagnosticsPayload>(diagnosticsQuery());
      state.payload = selected;
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.loading = false;
    rerender();
    schedulePoll();
  }
}

async function chooseWallet(address: string): Promise<void> {
  state.wallet = address;
  state.selectedSignature = "";
  state.payload.diagnostics = { transactions: [] };
  history.replaceState(
    null,
    "",
    address
      ? `/wallets/detail?wallet=${encodeURIComponent(address)}`
      : "/wallets/detail",
  );
  await refresh();
}

async function inspectTransaction(signature: string): Promise<void> {
  if (!state.wallet || !signature) return;
  state.selectedSignature = signature;
  state.selectedLoading = true;
  rerender();
  try {
    const payload = await api<DiagnosticsPayload>(
      diagnosticsQuery({ signature, includeRaw: true }),
    );
    state.payload = {
      ...state.payload,
      diagnostics: {
        ...state.payload.diagnostics,
        selectedTransaction: payload.diagnostics?.selectedTransaction ?? null,
      },
    };
    state.error = null;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.selectedLoading = false;
    rerender();
  }
}

async function walletAction(action: string, extra: AnyRow = {}): Promise<void> {
  if (!state.wallet || state.action) return;
  state.action = action;
  state.error = null;
  state.notice = null;
  rerender();
  try {
    const result = await api<any>("/api/wallet-tracker", {
      method: "PATCH",
      body: JSON.stringify({ address: state.wallet, action, ...extra }),
    });
    const queued = number(result?.queued ?? result?.transactions?.length);
    state.notice =
      action === "reindex"
        ? "Historical backfill was reset and queued."
        : action === "reparse"
          ? "Transaction queued for reparse."
          : `${formatInteger(queued)} transaction${queued === 1 ? "" : "s"} queued for reparse.`;
    await refresh(false);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.action = null;
    rerender();
  }
}

function copyValue(value: string): void {
  void navigator.clipboard.writeText(value).catch((error) => {
    state.error = error instanceof Error ? error.message : String(error);
    rerender();
  });
}

function StatusPill({ status }: { status: ParseStatus }) {
  return <span className={`diag-pill ${status}`}>{status}</span>;
}

function Header() {
  const wallet = selectedWallet();
  return (
    <section className="diag-hero">
      <div>
        <span className="section-kicker">Wallet intelligence</span>
        <h2>{wallet ? walletLabel(wallet) : "Wallet diagnostics"}</h2>
        <p>
          Inspect ingestion, parser decisions, normalized swaps, backfill state,
          and downstream copy intents for one tracked wallet.
        </p>
      </div>
      <div className="diag-hero-actions">
        <a className="button-link secondary" href="/wallets">
          Tracked wallets
        </a>
        {state.wallet ? (
          <a
            className="button-link secondary"
            href={`/copy?leader=${encodeURIComponent(state.wallet)}`}
          >
            Copy strategy
          </a>
        ) : null}
        <button
          type="button"
          className="secondary"
          disabled={state.loading}
          onClick={() => void refresh()}
        >
          {state.loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    </section>
  );
}

function Messages() {
  if (!state.error && !state.notice) return null;
  return (
    <section className={`diag-message ${state.error ? "bad" : "ok"}`}>
      <span>{state.error ?? state.notice}</span>
      <button
        type="button"
        className="secondary compact"
        onClick={() => {
          state.error = null;
          state.notice = null;
          rerender();
        }}
      >
        Dismiss
      </button>
    </section>
  );
}

function Controls() {
  const stats = state.payload.transactionStats ?? {};
  return (
    <section className="diag-panel diag-controls">
      <div className="diag-control-grid">
        <label>
          <span>Tracked wallet</span>
          <select
            value={state.wallet}
            onInput={(event: any) =>
              void chooseWallet(event.currentTarget.value)
            }
          >
            <option value="">Select wallet…</option>
            {wallets().map((wallet) => (
              <option key={wallet.address} value={wallet.address}>
                {walletLabel(wallet)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Parse status</span>
          <select
            value={state.status}
            onInput={(event: any) => {
              state.status = event.currentTarget.value;
              rerender();
            }}
          >
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="parsed">Parsed</option>
            <option value="ignored">Ignored</option>
            <option value="error">Error</option>
          </select>
        </label>
        <label className="wide">
          <span>Search</span>
          <input
            value={state.search}
            placeholder="Signature, parser, slot, error…"
            onInput={(event: any) => {
              state.search = event.currentTarget.value;
              rerender();
            }}
          />
        </label>
      </div>
      <div className="diag-action-row">
        <button
          type="button"
          className="secondary"
          disabled={!state.wallet || Boolean(state.action)}
          onClick={() => void walletAction("reindex")}
        >
          Reset backfill
        </button>
        <button
          type="button"
          className="secondary"
          disabled={
            !state.wallet || Boolean(state.action) || !number(stats.errors)
          }
          onClick={() => void walletAction("reparse-errors", { limit: 1000 })}
        >
          Reparse errors ({formatInteger(stats.errors)})
        </button>
        <button
          type="button"
          className="secondary"
          disabled={
            !state.wallet || Boolean(state.action) || !number(stats.ignored)
          }
          onClick={() => void walletAction("reparse-ignored", { limit: 1000 })}
        >
          Reparse ignored ({formatInteger(stats.ignored)})
        </button>
      </div>
    </section>
  );
}

function SummaryCards() {
  const tx = state.payload.transactionStats ?? {};
  const wallet = selectedWallet();
  const worker = state.payload.worker;
  const workerAge = Date.now() - number(worker?.updatedAtMs);
  const workerOnline =
    Boolean(worker) && workerAge < 45_000 && text(worker?.status) !== "stopped";
  const cards = [
    {
      label: "Worker",
      value: workerOnline ? "Online" : "Offline",
      detail: worker
        ? `${timeAgo(worker.updatedAtMs)} · ${text(worker.status)}`
        : "No heartbeat",
      tone: workerOnline ? "ok" : "bad",
    },
    {
      label: "Transactions",
      value: formatInteger(tx.total),
      detail: `${formatInteger(tx.parsed)} parsed · ${formatInteger(tx.pending)} pending`,
    },
    {
      label: "Ignored",
      value: formatInteger(tx.ignored),
      detail: "No supported swap identified",
    },
    {
      label: "Errors",
      value: formatInteger(tx.errors),
      detail: "Eligible for reparse",
      tone: number(tx.errors) ? "bad" : "ok",
    },
    {
      label: "Last backfill",
      value: wallet?.lastBackfillAtMs
        ? timeAgo(wallet.lastBackfillAtMs)
        : "Never",
      detail: `Last seen slot ${formatInteger(wallet?.lastSeenSlot)}`,
    },
  ];
  return (
    <section className="diag-summary-grid">
      {cards.map((card) => (
        <article key={card.label} className={`diag-stat ${card.tone ?? ""}`}>
          <span>{card.label}</span>
          <b>{card.value}</b>
          <small>{card.detail}</small>
        </article>
      ))}
    </section>
  );
}

function Distribution({
  title,
  rows,
}: {
  title: string;
  rows?: Array<{ key: string; count: number }>;
}) {
  const values = Array.isArray(rows) ? rows : [];
  const max = Math.max(1, ...values.map((row) => row.count));
  return (
    <article className="diag-distribution">
      <header>
        <b>{title}</b>
        <span>
          {formatInteger(values.reduce((sum, row) => sum + row.count, 0))}
        </span>
      </header>
      {values.length ? (
        values.slice(0, 8).map((row) => (
          <div key={row.key} className="diag-bar-row">
            <span title={row.key}>{row.key}</span>
            <div>
              <i
                style={{ width: `${Math.max(4, (row.count / max) * 100)}%` }}
              />
            </div>
            <b>{formatInteger(row.count)}</b>
          </div>
        ))
      ) : (
        <p className="muted">No data yet.</p>
      )}
    </article>
  );
}

function ParserHealth() {
  const diagnostics = state.payload.diagnostics ?? {};
  return (
    <section className="diag-panel">
      <header className="diag-section-head">
        <div>
          <span className="diag-step">01</span>
          <h3>Parser health</h3>
          <p>How stored transactions became normalized swap events.</p>
        </div>
      </header>
      <div className="diag-distribution-grid">
        <Distribution
          title="Transaction status"
          rows={diagnostics.parseStatuses}
        />
        <Distribution title="Swap parsers" rows={diagnostics.swapParsers} />
        <Distribution title="Venues" rows={diagnostics.venues} />
        <Distribution title="Classification" rows={diagnostics.confidence} />
      </div>
    </section>
  );
}

function TransactionsTable() {
  const rows = filteredTransactions();
  return (
    <section className="diag-panel diag-transactions-panel">
      <header className="diag-section-head">
        <div>
          <span className="diag-step">02</span>
          <h3>Transactions</h3>
          <p>
            Raw wallet references and the parser outcome for each signature.
          </p>
        </div>
        <span className="muted small">{formatInteger(rows.length)} shown</span>
      </header>
      {rows.length ? (
        <div className="diag-table-wrap">
          <table className="diag-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Status</th>
                <th>Signature</th>
                <th>Parser</th>
                <th>Swaps</th>
                <th>Slot</th>
                <th>Issue</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.walletTxKey}
                  className={
                    state.selectedSignature === row.signature ? "selected" : ""
                  }
                >
                  <td>{timeAgo(row.tradedAtMs)}</td>
                  <td>
                    <StatusPill status={row.parseStatus} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="diag-copy code"
                      onClick={() => copyValue(row.signature)}
                    >
                      {shortAddress(row.signature, 8, 8)}
                    </button>
                  </td>
                  <td>{row.parserVersion}</td>
                  <td>{formatInteger(row.swapCount)}</td>
                  <td className="code">{formatInteger(row.slot)}</td>
                  <td className="diag-error-cell" title={text(row.error)}>
                    {text(row.error) || "—"}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="secondary compact"
                      onClick={() => void inspectTransaction(row.signature)}
                    >
                      Inspect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="diag-empty">
          <b>No matching transactions</b>
          <span>Run a backfill or adjust the filters.</span>
        </div>
      )}
    </section>
  );
}

function SwapList({ swaps }: { swaps: SwapRow[] }) {
  if (!swaps.length)
    return (
      <div className="diag-empty small">
        <b>No normalized swaps</b>
        <span>The transaction was ignored or parsing failed.</span>
      </div>
    );
  return (
    <div className="diag-swap-list">
      {swaps.map((swap) => (
        <article key={swap.eventKey}>
          <header>
            <StatusPill
              status={
                swap.side === "buy" || swap.side === "sell"
                  ? "parsed"
                  : "ignored"
              }
            />
            <b>
              {swap.side.toUpperCase()}{" "}
              {text(swap.token?.symbol) || shortAddress(swap.subjectMint)}
            </b>
            <span>{swap.venue}</span>
          </header>
          <div>
            <span>
              {formatAmount(swap.inputAmountUi)}{" "}
              {shortAddress(swap.inputMint, 4, 4)}
            </span>
            <b>→</b>
            <span>
              {formatAmount(swap.outputAmountUi)}{" "}
              {shortAddress(swap.outputMint, 4, 4)}
            </span>
          </div>
          <footer>
            <span>{swap.parser}</span>
            <span>{swap.classificationConfidence}</span>
            <span>{enabled(swap.copyable) ? "copyable" : "display only"}</span>
          </footer>
        </article>
      ))}
    </div>
  );
}

function TransactionInspector() {
  const selected = state.payload.diagnostics?.selectedTransaction;
  if (!state.selectedSignature) return null;
  const raw = text(selected?.rawJson);
  let formattedRaw = raw;
  try {
    formattedRaw = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {}
  return (
    <section className="diag-panel diag-inspector">
      <header className="diag-section-head">
        <div>
          <span className="diag-step">03</span>
          <h3>Transaction inspector</h3>
          <p className="code">{state.selectedSignature}</p>
        </div>
        <div className="diag-head-actions">
          <button
            type="button"
            className="secondary compact"
            onClick={() => copyValue(state.selectedSignature)}
          >
            Copy signature
          </button>
          <button
            type="button"
            className="secondary compact"
            disabled={Boolean(state.action)}
            onClick={() =>
              void walletAction("reparse", {
                signature: state.selectedSignature,
              })
            }
          >
            Reparse
          </button>
          <button
            type="button"
            className="secondary compact"
            onClick={() => {
              state.selectedSignature = "";
              if (state.payload.diagnostics)
                state.payload.diagnostics.selectedTransaction = null;
              rerender();
            }}
          >
            Close
          </button>
        </div>
      </header>
      {state.selectedLoading ? (
        <p className="muted">Loading transaction…</p>
      ) : selected ? (
        <div className="diag-inspector-grid">
          <div>
            <dl className="diag-details">
              <div>
                <dt>Status</dt>
                <dd>
                  <StatusPill status={selected.parseStatus} />
                </dd>
              </div>
              <div>
                <dt>Parser</dt>
                <dd>{selected.parserVersion}</dd>
              </div>
              <div>
                <dt>Confidence</dt>
                <dd>{selected.confidence}</dd>
              </div>
              <div>
                <dt>Slot</dt>
                <dd className="code">{formatInteger(selected.slot)}</dd>
              </div>
              <div>
                <dt>Observed</dt>
                <dd>{new Date(selected.tradedAtMs).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Error</dt>
                <dd className={selected.error ? "bad-text" : ""}>
                  {selected.error || "None"}
                </dd>
              </div>
            </dl>
            <h4>Normalized swaps</h4>
            <SwapList
              swaps={Array.isArray(selected.swaps) ? selected.swaps : []}
            />
          </div>
          <details className="diag-raw" open>
            <summary>Stored raw transaction</summary>
            <pre>{formattedRaw || "Raw payload unavailable."}</pre>
          </details>
        </div>
      ) : (
        <p className="muted">Transaction not found.</p>
      )}
    </section>
  );
}

function CopyTrace() {
  const profiles = state.payload.diagnostics?.copyProfiles ?? [];
  const intents = state.payload.diagnostics?.copyIntents ?? [];
  return (
    <section className="diag-panel">
      <header className="diag-section-head">
        <div>
          <span className="diag-step">04</span>
          <h3>Copy-trade trace</h3>
          <p>
            Strategies and execution intents generated from this leader wallet.
          </p>
        </div>
        {state.wallet ? (
          <a
            className="button-link secondary compact"
            href={`/copy?leader=${encodeURIComponent(state.wallet)}`}
          >
            Manage strategies
          </a>
        ) : null}
      </header>
      <div className="diag-copy-summary">
        <article>
          <span>Profiles</span>
          <b>{formatInteger(profiles.length)}</b>
        </article>
        <article>
          <span>Intents</span>
          <b>{formatInteger(intents.length)}</b>
        </article>
        <article>
          <span>Failed</span>
          <b>
            {formatInteger(
              intents.filter((row) => row.status === "failed").length,
            )}
          </b>
        </article>
        <article>
          <span>Sent / paper</span>
          <b>
            {formatInteger(
              intents.filter(
                (row) => row.status === "sent" || row.status === "paper",
              ).length,
            )}
          </b>
        </article>
      </div>
      {intents.length ? (
        <div className="diag-intent-list">
          {intents.slice(0, 30).map((intent) => (
            <article key={intent.intentKey}>
              <span className={`diag-intent-status ${intent.status}`}>
                {intent.status}
              </span>
              <b>
                {String(intent.side).toUpperCase()}{" "}
                {shortAddress(intent.subjectMint)}
              </b>
              <span>
                {text(intent.reason) || `${intent.mode} · ${intent.amountKind}`}
              </span>
              <time>{timeAgo(intent.createdAtMs)}</time>
            </article>
          ))}
        </div>
      ) : (
        <div className="diag-empty small">
          <b>No copy intents</b>
          <span>Create a paper strategy to trace this wallet end to end.</span>
        </div>
      )}
    </section>
  );
}

function WalletDiagnosticsPage() {
  return (
    <main className="wallet-diagnostics-page">
      <Messages />
      <Header />
      <Controls />
      <SummaryCards />
      <ParserHealth />
      <TransactionsTable />
      <TransactionInspector />
      <CopyTrace />
    </main>
  );
}

export default function mount() {
  unmounted = false;
  const params = new URLSearchParams(location.search);
  state.wallet = text(params.get("wallet"));
  rerender();
  void refresh();

  const onVisibility = () => {
    if (document.visibilityState === "visible") void refresh(false);
  };
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    unmounted = true;
    document.removeEventListener("visibilitychange", onVisibility);
    if (pollTimer) clearTimeout(pollTimer);
    if (renderFrame != null) cancelAnimationFrame(renderFrame);
    renderFrame = null;
  };
}
