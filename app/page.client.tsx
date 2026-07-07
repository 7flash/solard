import { render } from "tradjs/client";

type AnyRow = Record<string, any>;
type Overview = {
  wallets: AnyRow[];
  tokens: AnyRow[];
  groups: AnyRow[];
  executions: AnyRow[];
  balances: AnyRow[];
};

type State = {
  tab: "overview" | "wallets" | "launch" | "trade" | "jobs";
  overview: Overview | null;
  jobs: AnyRow[];
  selectedJobId: string | null;
  selectedJob: AnyRow | null;
  busy: boolean;
  error: string | null;
  token: string;
};

const state: State = {
  tab: "overview",
  overview: null,
  jobs: [],
  selectedJobId: null,
  selectedJob: null,
  busy: false,
  error: null,
  token: localStorage.getItem("solwal:web-token") ?? "",
};

function authHeaders(): HeadersInit {
  return state.token ? { "x-solwal-web-token": state.token } : {};
}

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
      ...(options.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false)
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload.value as T;
}

function short(value: string | null | undefined, head = 6, tail = 6): string {
  if (!value) return "—";
  return value.length <= head + tail + 1
    ? value
    : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function solFromLamports(value: any): string {
  const raw = typeof value === "bigint" ? value : BigInt(String(value ?? "0"));
  const whole = raw / 1_000_000_000n;
  const frac = (raw % 1_000_000_000n)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}`;
}

function formData(form: HTMLFormElement): AnyRow {
  return Object.fromEntries(new FormData(form).entries());
}

async function refreshOverview(): Promise<void> {
  state.overview = await api<Overview>("/api/overview");
  const status = document.getElementById("connection-status");
  if (status) {
    status.textContent = "connected";
    status.className = "pill ok";
  }
  const last = document.getElementById("last-refresh");
  if (last) last.textContent = new Date().toLocaleTimeString();
}

async function refreshJobs(): Promise<void> {
  state.jobs = await api<AnyRow[]>("/api/jobs");
  if (state.selectedJobId)
    state.selectedJob = await api<AnyRow>(
      `/api/jobs?id=${encodeURIComponent(state.selectedJobId)}`,
    );
}

async function runAction<T>(fn: () => Promise<T>): Promise<T | undefined> {
  state.busy = true;
  state.error = null;
  update();
  try {
    const result = await fn();
    await Promise.allSettled([refreshOverview(), refreshJobs()]);
    return result;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.busy = false;
    update();
  }
}

function Stats() {
  const data = state.overview;
  return (
    <div className="grid">
      <div className="card span-3">
        <div className="muted small">Wallets</div>
        <div className="stat">{data?.wallets.length ?? "—"}</div>
      </div>
      <div className="card span-3">
        <div className="muted small">Groups</div>
        <div className="stat">{data?.groups.length ?? "—"}</div>
      </div>
      <div className="card span-3">
        <div className="muted small">Tokens</div>
        <div className="stat">{data?.tokens.length ?? "—"}</div>
      </div>
      <div className="card span-3">
        <div className="muted small">Executions</div>
        <div className="stat">{data?.executions.length ?? "—"}</div>
      </div>
    </div>
  );
}

function OverviewView() {
  const data = state.overview;
  return (
    <div className="grid">
      <div className="span-12">
        <Stats />
      </div>
      <div className="card span-6">
        <h2>Wallet balances</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Address</th>
              <th>SOL</th>
            </tr>
          </thead>
          <tbody>
            {(data?.balances ?? []).map((row: AnyRow) => (
              <tr>
                <td>{row.wallet?.name ?? "—"}</td>
                <td className="code">{short(row.wallet?.address)}</td>
                <td>
                  {row.error ? row.error : solFromLamports(row.solLamports)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card span-6">
        <h2>Recent executions</h2>
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Kind</th>
              <th>Wallet</th>
              <th>Sig</th>
            </tr>
          </thead>
          <tbody>
            {(data?.executions ?? []).slice(0, 18).map((row: AnyRow) => (
              <tr>
                <td>
                  <span
                    className={`pill ${row.status === "confirmed" ? "ok" : row.status === "failed" ? "bad" : ""}`}
                  >
                    {row.status}
                  </span>
                </td>
                <td>{row.kind}</td>
                <td className="code">{short(row.walletAddress)}</td>
                <td className="code">{short(row.signature)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WalletsView() {
  const data = state.overview;
  return (
    <div className="grid">
      <form
        className="card span-4"
        onSubmit={(event) => {
          event.preventDefault();
          const body = formData(event.currentTarget);
          void runAction(() =>
            api("/api/wallets/import", {
              method: "POST",
              body: JSON.stringify(body),
            }),
          );
        }}
      >
        <h2>Import wallet</h2>
        <div className="form-grid">
          <label className="full">
            Name
            <input name="name" placeholder="main / buyer-1" />
          </label>
          <label className="full">
            Private key
            <textarea
              name="privateKey"
              placeholder="base58 secret or keypair JSON"
            />
          </label>
          <button className="full" type="submit">
            Import encrypted wallet
          </button>
        </div>
      </form>
      <form
        className="card span-4"
        onSubmit={(event) => {
          event.preventDefault();
          const body = formData(event.currentTarget);
          void runAction(() =>
            api("/api/groups/create", {
              method: "POST",
              body: JSON.stringify(body),
            }),
          );
        }}
      >
        <h2>Create group</h2>
        <div className="form-grid">
          <label className="full">
            Group name
            <input name="name" placeholder="mind-buyers" />
          </label>
          <label className="full">
            Description
            <input name="description" placeholder="Launch buyers" />
          </label>
          <button className="full" type="submit">
            Create group
          </button>
        </div>
      </form>
      <form
        className="card span-4"
        onSubmit={(event) => {
          event.preventDefault();
          const body = formData(event.currentTarget);
          void runAction(() =>
            api("/api/groups/add", {
              method: "POST",
              body: JSON.stringify(body),
            }),
          );
        }}
      >
        <h2>Add wallet to group</h2>
        <div className="form-grid">
          <label>
            Group
            <input name="groupName" placeholder="mind-buyers" />
          </label>
          <label>
            Wallet
            <input name="wallet" placeholder="name or address" />
          </label>
          <label className="full">
            Weight bps
            <input name="weightBps" defaultValue="10000" />
          </label>
          <button className="full" type="submit">
            Add member
          </button>
        </div>
      </form>
      <div className="card span-6">
        <h2>Wallets</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Address</th>
            </tr>
          </thead>
          <tbody>
            {(data?.wallets ?? []).map((w: AnyRow) => (
              <tr>
                <td>{w.name}</td>
                <td className="code">{w.address}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card span-6">
        <h2>Groups</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Members</th>
            </tr>
          </thead>
          <tbody>
            {(data?.groups ?? []).map((g: AnyRow) => (
              <tr>
                <td>{g.name}</td>
                <td>{g.wallets?.length ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LaunchView() {
  return (
    <form
      className="grid"
      onSubmit={(event) => {
        event.preventDefault();
        const body = formData(event.currentTarget);
        body.live = event.currentTarget.querySelector<HTMLInputElement>(
          "[name=live]",
        )?.checked
          ? "true"
          : "false";
        body.skipSimulation =
          event.currentTarget.querySelector<HTMLInputElement>(
            "[name=skipSimulation]",
          )?.checked
            ? "true"
            : "false";
        void runAction(async () => {
          const started = await api<{ id: string }>("/api/launch/pump", {
            method: "POST",
            body: JSON.stringify(body),
          });
          state.selectedJobId = started.id;
          state.tab = "jobs";
          await refreshJobs();
        });
      }}
    >
      <div className="card span-12">
        <h2>Launch pump token</h2>
        <p className="muted">
          Use metadata path for server-local JSON, or fill
          alias/name/symbol/uri/image fields directly.
        </p>
      </div>
      <div className="card span-6">
        <h3>Token</h3>
        <div className="form-grid">
          <label className="full">
            Metadata JSON path
            <input name="metadataPath" placeholder="./metadata/mind.json" />
          </label>
          <label>
            Alias
            <input name="alias" />
          </label>
          <label>
            Name
            <input name="name" />
          </label>
          <label>
            Symbol
            <input name="symbol" />
          </label>
          <label>
            Metadata URI
            <input name="uri" />
          </label>
          <label className="full">
            Server image path
            <input name="imagePath" />
          </label>
          <label className="full">
            Description
            <input name="description" />
          </label>
        </div>
      </div>
      <div className="card span-6">
        <h3>Participants</h3>
        <div className="form-grid">
          <label>
            Creator
            <input name="creator" required />
          </label>
          <label>
            Buyer group
            <input name="buyerGroup" placeholder="mind-buyers" />
          </label>
          <label>
            Creator buy SOL
            <input name="creatorBuySol" placeholder="0" />
          </label>
          <label>
            Buyer reserve SOL
            <input name="buyerReserveSol" defaultValue="0.02" />
          </label>
          <label>
            Buyer min bps
            <input name="buyerMinBps" defaultValue="5000" />
          </label>
          <label>
            Buyer max bps
            <input name="buyerMaxBps" defaultValue="8000" />
          </label>
        </div>
      </div>
      <div className="card span-12">
        <h3>Execution</h3>
        <div className="form-grid">
          <label>
            Deployment sender
            <select name="deploymentSender">
              <option value="helius-rpc">helius-rpc</option>
              <option value="helius-fast">helius-fast</option>
            </select>
          </label>
          <label>
            Buyer sender
            <select name="buyerSender">
              <option value="helius-fast">helius-fast</option>
              <option value="helius-rpc">helius-rpc</option>
            </select>
          </label>
          <label>
            Submit mode
            <select name="submitMode">
              <option value="fast-spam">fast-spam</option>
              <option value="spam-after-market-ready">
                spam-after-market-ready
              </option>
              <option value="after-deploy-processed">
                after-deploy-processed
              </option>
              <option value="after-deploy-confirmed">
                after-deploy-confirmed
              </option>
            </select>
          </label>
          <label>
            Sender TPS
            <input name="senderTps" defaultValue="40" />
          </label>
          <label>
            Helius tip SOL
            <input name="heliusTipSol" defaultValue="0.001" />
          </label>
          <label>
            Buyer priority µ-lamports
            <input name="buyerPriorityMicroLamports" defaultValue="1500000" />
          </label>
          <label>
            Slippage bps
            <input name="slippageBps" defaultValue="9999" />
          </label>
          <label>
            Fresh quote delay ms
            <input name="freshQuoteDelayMs" defaultValue="-1" />
          </label>
          <label>
            <span>Live</span>
            <input type="checkbox" name="live" />
          </label>
          <label>
            <span>Skip simulation</span>
            <input type="checkbox" name="skipSimulation" defaultChecked />
          </label>
          <button className="full" type="submit">
            Start launch job
          </button>
        </div>
      </div>
    </form>
  );
}

function TradeView() {
  return (
    <div className="grid">
      <form
        className="card span-6"
        onSubmit={(event) => {
          event.preventDefault();
          const body = formData(event.currentTarget);
          body.live = event.currentTarget.querySelector<HTMLInputElement>(
            "[name=live]",
          )?.checked
            ? "true"
            : "false";
          void runAction(() =>
            api("/api/trade/buy", {
              method: "POST",
              body: JSON.stringify(body),
            }),
          );
        }}
      >
        <h2>Buy</h2>
        <div className="form-grid">
          <label>
            Wallet
            <input name="wallet" required />
          </label>
          <label>
            Token
            <input name="token" required />
          </label>
          <label>
            SOL
            <input name="amountSol" defaultValue="0.01" />
          </label>
          <label>
            Slippage bps
            <input name="slippageBps" defaultValue="1500" />
          </label>
          <label>
            Sender
            <input name="sender" defaultValue="rpc" />
          </label>
          <label>
            <span>Live</span>
            <input type="checkbox" name="live" />
          </label>
          <button className="full">Buy</button>
        </div>
      </form>
      <form
        className="card span-6"
        onSubmit={(event) => {
          event.preventDefault();
          const body = formData(event.currentTarget);
          body.live = event.currentTarget.querySelector<HTMLInputElement>(
            "[name=live]",
          )?.checked
            ? "true"
            : "false";
          void runAction(() =>
            api("/api/trade/sell", {
              method: "POST",
              body: JSON.stringify(body),
            }),
          );
        }}
      >
        <h2>Sell</h2>
        <div className="form-grid">
          <label>
            Wallet
            <input name="wallet" required />
          </label>
          <label>
            Token
            <input name="token" required />
          </label>
          <label>
            Sell bps
            <input name="bps" defaultValue="10000" />
          </label>
          <label>
            Slippage bps
            <input name="slippageBps" defaultValue="1500" />
          </label>
          <label>
            Sender
            <input name="sender" defaultValue="rpc" />
          </label>
          <label>
            <span>Live</span>
            <input type="checkbox" name="live" />
          </label>
          <button className="full danger">Sell</button>
        </div>
      </form>
    </div>
  );
}

function JobsView() {
  const selected = state.selectedJob;
  return (
    <div className="grid">
      <div className="card span-4">
        <h2>Jobs</h2>
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {state.jobs.map((job: AnyRow) => (
              <tr
                onClick={() => {
                  state.selectedJobId = job.id;
                  void refreshJobs().then(update);
                }}
              >
                <td>
                  <span
                    className={`pill ${job.status === "succeeded" ? "ok" : job.status === "failed" ? "bad" : ""}`}
                  >
                    {job.status}
                  </span>
                </td>
                <td>{new Date(job.createdAtMs).toLocaleTimeString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card span-8">
        <h2>Selected job</h2>
        {selected ? (
          <>
            <p className="code">{selected.id}</p>
            <pre>{JSON.stringify(selected, null, 2)}</pre>
          </>
        ) : (
          <p className="muted">Select a job.</p>
        )}
      </div>
    </div>
  );
}

function App() {
  return (
    <>
      <div className="notice row">
        <label style="max-width: 360px">
          Web token, optional
          <input
            value={state.token}
            onInput={(event: any) => {
              state.token = event.currentTarget.value;
              localStorage.setItem("solwal:web-token", state.token);
            }}
          />
        </label>
        <button
          className="secondary"
          onClick={() => void runAction(refreshOverview)}
        >
          Refresh
        </button>
        {state.busy ? <span className="pill">working…</span> : null}
        {state.error ? <span className="pill bad">{state.error}</span> : null}
      </div>
      {state.tab === "overview" ? (
        <OverviewView />
      ) : state.tab === "wallets" ? (
        <WalletsView />
      ) : state.tab === "launch" ? (
        <LaunchView />
      ) : state.tab === "trade" ? (
        <TradeView />
      ) : (
        <JobsView />
      )}
    </>
  );
}

function update() {
  const root = document.getElementById("app-root");
  if (root) render(<App />, root);
  document
    .querySelectorAll<HTMLButtonElement>("#tabs button")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.tab === state.tab),
    );
}

export default function mount() {
  document
    .querySelectorAll<HTMLButtonElement>("#tabs button")
    .forEach((button) => {
      button.addEventListener("click", () => {
        state.tab = button.dataset.tab as State["tab"];
        update();
      });
    });
  void runAction(async () => {
    await refreshOverview();
    await refreshJobs();
  });
  const interval = setInterval(() => {
    if (state.tab === "jobs" || state.selectedJobId)
      void refreshJobs()
        .then(update)
        .catch(() => undefined);
  }, 1500);
  update();
  return () => clearInterval(interval);
}
