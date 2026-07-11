import { render } from "tradjs/client";
import { api } from "../_client/api";
import { age } from "../_client/format";

type AnyRow = Record<string, any>;

type LogTarget = "solard" | "solard-server-worker" | "solard-helius-logs-v1";

type LogStream = "stdout" | "stderr";

const state = {
  payload: null as AnyRow | null,

  error: null as string | null,

  loading: false,

  target: "solard-helius-logs-v1" as LogTarget,

  stream: "stderr" as LogStream,

  logText: "",

  logMeta: null as AnyRow | null,

  copied: false,
};

let stopped = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function root(): HTMLElement {
  const value = document.getElementById("app-root");

  if (!value) {
    throw new Error("Missing #app-root");
  }

  return value;
}

function rerender(): void {
  if (stopped) {
    return;
  }

  const current = root();

  const parent = current.parentNode;

  if (!parent) {
    return;
  }

  const replacement = current.cloneNode(false) as HTMLElement;

  parent.replaceChild(replacement, current);

  render(<SystemPage />, replacement, {
    reconciler: "sequential",
  });
}

function statusClass(row: AnyRow): string {
  return row.healthy ? "ok" : row.alive ? "warn" : "bad";
}

function statusText(row: AnyRow): string {
  if (row.healthy) {
    return "healthy";
  }

  if (!row.alive) {
    return "down";
  }

  if (row.stale) {
    return "stale";
  }

  if (row.buildMismatch) {
    return "wrong build";
  }

  if (row.hasError) {
    return "error";
  }

  return "degraded";
}

async function reload(schedule = true): Promise<void> {
  if (state.loading) {
    return;
  }

  state.loading = true;

  try {
    const [payload, logs] = await Promise.all([
      api<AnyRow>("/api/system?errors=50"),

      api<AnyRow>(
        `/api/system/logs?name=${encodeURIComponent(state.target)}&stream=${state.stream}&lines=350`,
      ),
    ]);

    state.payload = payload;

    state.logText = String(logs.text ?? "");

    state.logMeta = logs;

    state.error = null;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.loading = false;

    rerender();

    if (schedule && !stopped) {
      if (timer) {
        clearTimeout(timer);
      }

      timer = setTimeout(() => void reload(true), 2_000);
    }
  }
}

function selectLog(target: LogTarget, stream: LogStream): void {
  state.target = target;

  state.stream = stream;

  state.logText = "Loading…";

  state.copied = false;

  rerender();

  void reload(false);
}

async function copyLogs(): Promise<void> {
  await navigator.clipboard.writeText(state.logText);

  state.copied = true;

  rerender();
}

function ProcessCard({ row }: { row: AnyRow }) {
  return (
    <article className="card">
      <div className="row between">
        <div>
          <h3>{row.label ?? row.name}</h3>

          <div className="muted small">{row.name}</div>
        </div>

        <span className={`pill ${statusClass(row)}`}>{statusText(row)}</span>
      </div>

      <div className="stats-grid compact">
        <div>
          <span>Alive</span>
          <b>{row.alive ? "yes" : "no"}</b>
        </div>

        <div>
          <span>Heartbeat</span>
          <b>{row.heartbeatAtMs ? age(row.heartbeatAtMs) : "never"}</b>
        </div>

        <div>
          <span>PID</span>
          <b>{row.pid || "—"}</b>
        </div>

        <div>
          <span>Status</span>
          <b>{row.status ?? "unknown"}</b>
        </div>
      </div>

      {row.error ? <pre className="pill bad">{row.error}</pre> : null}

      {row.command ? (
        <div className="muted small code">{row.command}</div>
      ) : null}
    </article>
  );
}

function SystemPage() {
  const health = state.payload?.health ?? {};

  const processes = Array.isArray(health.processes) ? health.processes : [];

  const errors = Array.isArray(state.payload?.errors)
    ? state.payload.errors
    : [];

  return (
    <div className="page-stack">
      <section className="page-head">
        <div>
          <p className="eyebrow">Runtime</p>

          <h2>System status & logs</h2>

          <p className="muted">
            Actual bgrun process state, database heartbeat, recent worker
            errors, and separate server/indexer logs.
          </p>
        </div>

        <div className="row gap">
          <a className="secondary compact button" href="/terminal">
            Terminal
          </a>

          <button
            type="button"
            className="secondary compact"
            disabled={state.loading}
            onClick={() => void reload(false)}
          >
            {state.loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </section>

      {state.error ? <div className="pill bad">{state.error}</div> : null}

      <section className="card">
        <div className="row between">
          <b>Overall</b>

          <span
            className={`pill ${
              health.status === "ok"
                ? "ok"
                : health.status === "down"
                  ? "bad"
                  : "warn"
            }`}
          >
            {health.status ?? "loading"}
          </span>
        </div>
      </section>

      <section className="grid two">
        {processes.map((row: AnyRow) => (
          <ProcessCard row={row} />
        ))}
      </section>

      <section className="card">
        <div className="row between">
          <div>
            <h3>Process logs</h3>

            <div className="muted small">
              Server and standalone Helius indexer logs from bgrun.
            </div>
          </div>

          <button
            type="button"
            className="secondary compact"
            onClick={() => void copyLogs()}
          >
            {state.copied ? "Copied" : "Copy"}
          </button>
        </div>

        <div className="row gap wrap">
          {[
            ["solard-server-worker", "Server"],
            ["solard-helius-logs-v1", "Indexer"],
            ["solard", "Supervisor"],
          ].map(([value, label]) => (
            <button
              type="button"
              className={`secondary compact ${
                state.target === value ? "active" : ""
              }`}
              onClick={() => selectLog(value as LogTarget, state.stream)}
            >
              {label}
            </button>
          ))}

          {["stderr", "stdout"].map((value) => (
            <button
              type="button"
              className={`secondary compact ${
                state.stream === value ? "active" : ""
              }`}
              onClick={() => selectLog(state.target, value as LogStream)}
            >
              {value}
            </button>
          ))}
        </div>

        <pre
          className="code"
          style={{
            maxHeight: "520px",
            overflow: "auto",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            border: "1px solid var(--line)",
            padding: "12px",
          }}
        >
          {state.logText || "(no log output)"}
        </pre>
      </section>

      <section className="card">
        <div className="row between">
          <h3>Recent worker errors</h3>

          <span className="muted small">{errors.length}</span>
        </div>

        <div className="stack">
          {errors.length ? (
            errors.map((row: AnyRow) => (
              <details>
                <summary>
                  <span className="pill bad">error</span> <b>{row.worker}</b>
                  {" · "}
                  <span className="muted small">{age(row.createdAtMs)}</span>
                </summary>

                <pre
                  className="code"
                  style={{
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {row.message}
                  {row.stack ? `\n\n${row.stack}` : ""}
                </pre>
              </details>
            ))
          ) : (
            <div className="muted">No recorded worker errors.</div>
          )}
        </div>
      </section>
    </div>
  );
}

export default function mount() {
  stopped = false;

  rerender();

  void reload(true);

  return () => {
    stopped = true;

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
