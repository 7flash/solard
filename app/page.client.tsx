import { render } from "tradjs/client";

type AnyRow = Record<string, any>;
type Overview = {
  wallets: AnyRow[];
  tokens: AnyRow[];
  groups: AnyRow[];
  executions: AnyRow[];
  balances: AnyRow[];
};

type BuyPlanRow = {
  id: string;
  wallet: string;
  label: string;
  amountMode: "range-bps" | "exact-sol" | "exact-lamports";
  minBps: string;
  maxBps: string;
  reserveSol: string;
  exactSol: string;
  exactLamports: string;
  sender: "helius-fast" | "helius-rpc";
  strategy:
    | "fast-spam"
    | "spam-after-market-ready"
    | "after-deploy-processed"
    | "after-deploy-confirmed";
  tipSol: string;
  priorityMicroLamports: string;
  slippageBps: string;
  retryIntervalMs: string;
  recompileIntervalMs: string;
  freshQuoteDelayMs: string;
  maxFailedAttempts: string;
};

type PumpFeedRow = {
  seq?: number;
  receivedAt?: string;
  eventType?: string;
  mint?: string | null;
  name?: string | null;
  symbol?: string | null;
  uri?: string | null;
  creator?: string | null;
  signature?: string | null;
  initialBuy?: number | null;
  solAmount?: number | null;
  marketCapSol?: number | null;
  raw?: AnyRow;
};

type State = {
  tab: "overview" | "wallets" | "terminal" | "launch" | "trade" | "jobs";
  overview: Overview | null;
  jobs: AnyRow[];
  selectedJobId: string | null;
  selectedJob: AnyRow | null;
  busy: boolean;
  error: string | null;
  token: string;
  buyPlanRows: BuyPlanRow[];
  pumpFeed: PumpFeedRow[];
  pumpFeedStatus: "idle" | "connecting" | "connected" | "error" | "closed";
  pumpFeedError: string | null;
  pumpFeedFilter: string;
  pumpFeedAbort: AbortController | null;
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
  buyPlanRows: [],
  pumpFeed: [],
  pumpFeedStatus: "idle",
  pumpFeedError: null,
  pumpFeedFilter: "",
  pumpFeedAbort: null,
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

function formatSol(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value >= 0.001
    ? value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")
    : value.toExponential(2);
}

function tokenUrl(mint: string | null | undefined): string {
  return mint ? `https://pump.fun/coin/${mint}` : "#";
}

let pumpFeedUpdateScheduled = false;
function schedulePumpFeedUpdate(): void {
  if (pumpFeedUpdateScheduled) return;
  pumpFeedUpdateScheduled = true;
  setTimeout(() => {
    pumpFeedUpdateScheduled = false;
    update();
  }, 120);
}

function appendPumpFeed(row: PumpFeedRow): void {
  state.pumpFeed = [row, ...state.pumpFeed].slice(0, 350);
  schedulePumpFeedUpdate();
}

function handleSseBlock(block: string): void {
  const lines = block.split("\n");
  let event = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:"))
      dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return;
  const text = dataLines.join("\n");
  try {
    const payload = JSON.parse(text);
    if (event === "token") appendPumpFeed(payload as PumpFeedRow);
    else if (event === "status") {
      state.pumpFeedStatus = (payload.status ??
        event) as State["pumpFeedStatus"];
      state.pumpFeedError = null;
      schedulePumpFeedUpdate();
    } else if (event === "warning") {
      state.pumpFeedError = payload.error ?? "Pump feed warning";
      schedulePumpFeedUpdate();
    }
  } catch {
    state.pumpFeedError = text;
    schedulePumpFeedUpdate();
  }
}

async function startPumpFeed(): Promise<void> {
  state.pumpFeedAbort?.abort();
  const abort = new AbortController();
  state.pumpFeedAbort = abort;
  state.pumpFeedStatus = "connecting";
  state.pumpFeedError = null;
  update();
  try {
    const response = await fetch("/api/pump-feed", {
      headers: authHeaders(),
      signal: abort.signal,
    });
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error ?? `Pump feed HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!abort.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        handleSseBlock(block);
        split = buffer.indexOf("\n\n");
      }
    }
    if (!abort.signal.aborted) state.pumpFeedStatus = "closed";
  } catch (error) {
    if (!abort.signal.aborted) {
      state.pumpFeedStatus = "error";
      state.pumpFeedError =
        error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (state.pumpFeedAbort === abort) state.pumpFeedAbort = null;
    update();
  }
}

function stopPumpFeed(): void {
  state.pumpFeedAbort?.abort();
  state.pumpFeedAbort = null;
  state.pumpFeedStatus = "closed";
  update();
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

function newBuyPlanRow(seed: Partial<BuyPlanRow> = {}): BuyPlanRow {
  return {
    id: String(Date.now()) + ":" + Math.random().toString(36).slice(2),
    wallet: "",
    label: "",
    amountMode: "range-bps",
    minBps: "5000",
    maxBps: "8000",
    reserveSol: "0.02",
    exactSol: "",
    exactLamports: "",
    sender: "helius-fast",
    strategy: "fast-spam",
    tipSol: "0.001",
    priorityMicroLamports: "1500000",
    slippageBps: "9999",
    retryIntervalMs: "75",
    recompileIntervalMs: "750",
    freshQuoteDelayMs: "-1",
    maxFailedAttempts: "0",
    ...seed,
  };
}

function updateBuyPlanRow(id: string, patch: Partial<BuyPlanRow>): void {
  state.buyPlanRows = state.buyPlanRows.map((row) =>
    row.id === id ? { ...row, ...patch } : row,
  );
  update();
}

function removeBuyPlanRow(id: string): void {
  state.buyPlanRows = state.buyPlanRows.filter((row) => row.id !== id);
  update();
}

function walletLabel(wallet: AnyRow): string {
  return wallet.name
    ? `${wallet.name} — ${short(wallet.address, 4, 4)}`
    : wallet.address;
}

function populateBuyPlanFromGroup(groupName: string): void {
  const group = state.overview?.groups.find(
    (item: AnyRow) => item.name === groupName,
  );
  const members = group?.wallets ?? [];
  state.buyPlanRows = members.map((member: AnyRow, index: number) =>
    newBuyPlanRow({
      wallet:
        member.walletAddress ?? member.address ?? String(member.wallet ?? ""),
      label: `buyer-${index + 1}`,
    }),
  );
  update();
}

function buyPlanPayload(): AnyRow[] {
  return state.buyPlanRows
    .filter((row) => row.wallet.trim())
    .map((row) => ({
      wallet: row.wallet.trim(),
      label: row.label.trim() || undefined,
      amountMode: row.amountMode,
      minBps: row.amountMode === "range-bps" ? row.minBps : undefined,
      maxBps: row.amountMode === "range-bps" ? row.maxBps : undefined,
      reserveSol: row.amountMode === "range-bps" ? row.reserveSol : undefined,
      exactSol: row.amountMode === "exact-sol" ? row.exactSol : undefined,
      exactLamports:
        row.amountMode === "exact-lamports" ? row.exactLamports : undefined,
      sender: row.sender,
      strategy: row.strategy,
      tipSol: row.sender === "helius-fast" ? row.tipSol : undefined,
      priorityMicroLamports: row.priorityMicroLamports,
      slippageBps: row.slippageBps,
      retryIntervalMs: row.retryIntervalMs,
      recompileIntervalMs: row.recompileIntervalMs,
      freshQuoteDelayMs: row.freshQuoteDelayMs,
      maxFailedAttempts: row.maxFailedAttempts,
    }));
}

function BuyPlanTable() {
  const wallets = state.overview?.wallets ?? [];
  return (
    <div className="card span-12">
      <div className="row between">
        <div>
          <h3>Follower buy plan</h3>
          <p className="muted">
            Optional. When rows are present, these rows override the
            buyer-group/global buyer settings. Each wallet runs in parallel with
            its own sender, strategy, fees and retry rhythm.
          </p>
        </div>
        <div className="row">
          <select id="buy-plan-group-select">
            <option value="">load group…</option>
            {(state.overview?.groups ?? []).map((group: AnyRow) => (
              <option value={group.name}>{group.name}</option>
            ))}
          </select>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              const select = document.getElementById(
                "buy-plan-group-select",
              ) as HTMLSelectElement | null;
              if (select?.value) populateBuyPlanFromGroup(select.value);
            }}
          >
            Load group
          </button>
          <button
            type="button"
            onClick={() => {
              state.buyPlanRows = [...state.buyPlanRows, newBuyPlanRow()];
              update();
            }}
          >
            Add row
          </button>
        </div>
      </div>
      <div className="wide-table">
        <table>
          <thead>
            <tr>
              <th>Wallet</th>
              <th>Amount</th>
              <th>Execution</th>
              <th>Fees</th>
              <th>Retry</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {state.buyPlanRows.map((row) => (
              <tr>
                <td>
                  <input
                    placeholder="label"
                    value={row.label}
                    onInput={(event: any) =>
                      updateBuyPlanRow(row.id, {
                        label: event.currentTarget.value,
                      })
                    }
                  />
                  <select
                    value={row.wallet}
                    onInput={(event: any) =>
                      updateBuyPlanRow(row.id, {
                        wallet: event.currentTarget.value,
                      })
                    }
                  >
                    <option value="">select wallet…</option>
                    {wallets.map((wallet: AnyRow) => (
                      <option value={wallet.address}>
                        {walletLabel(wallet)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    value={row.amountMode}
                    onInput={(event: any) =>
                      updateBuyPlanRow(row.id, {
                        amountMode: event.currentTarget.value,
                      })
                    }
                  >
                    <option value="range-bps">balance % range</option>
                    <option value="exact-sol">exact SOL</option>
                    <option value="exact-lamports">exact lamports</option>
                  </select>
                  {row.amountMode === "range-bps" ? (
                    <div className="mini-grid">
                      <input
                        title="min bps"
                        value={row.minBps}
                        onInput={(event: any) =>
                          updateBuyPlanRow(row.id, {
                            minBps: event.currentTarget.value,
                          })
                        }
                      />
                      <input
                        title="max bps"
                        value={row.maxBps}
                        onInput={(event: any) =>
                          updateBuyPlanRow(row.id, {
                            maxBps: event.currentTarget.value,
                          })
                        }
                      />
                      <input
                        title="reserve SOL"
                        value={row.reserveSol}
                        onInput={(event: any) =>
                          updateBuyPlanRow(row.id, {
                            reserveSol: event.currentTarget.value,
                          })
                        }
                      />
                    </div>
                  ) : null}
                  {row.amountMode === "exact-sol" ? (
                    <input
                      placeholder="exact SOL"
                      value={row.exactSol}
                      onInput={(event: any) =>
                        updateBuyPlanRow(row.id, {
                          exactSol: event.currentTarget.value,
                        })
                      }
                    />
                  ) : null}
                  {row.amountMode === "exact-lamports" ? (
                    <input
                      placeholder="exact lamports"
                      value={row.exactLamports}
                      onInput={(event: any) =>
                        updateBuyPlanRow(row.id, {
                          exactLamports: event.currentTarget.value,
                        })
                      }
                    />
                  ) : null}
                </td>
                <td>
                  <select
                    value={row.sender}
                    onInput={(event: any) =>
                      updateBuyPlanRow(row.id, {
                        sender: event.currentTarget.value,
                      })
                    }
                  >
                    <option value="helius-fast">helius-fast</option>
                    <option value="helius-rpc">helius-rpc</option>
                  </select>
                  <select
                    value={row.strategy}
                    onInput={(event: any) =>
                      updateBuyPlanRow(row.id, {
                        strategy: event.currentTarget.value,
                      })
                    }
                  >
                    <option value="fast-spam">fast-spam</option>
                    <option value="spam-after-market-ready">
                      market-ready spam
                    </option>
                    <option value="after-deploy-processed">
                      after processed
                    </option>
                    <option value="after-deploy-confirmed">
                      after confirmed
                    </option>
                  </select>
                </td>
                <td>
                  <input
                    title="tip SOL"
                    value={row.tipSol}
                    onInput={(event: any) =>
                      updateBuyPlanRow(row.id, {
                        tipSol: event.currentTarget.value,
                      })
                    }
                  />
                  <input
                    title="priority micro lamports"
                    value={row.priorityMicroLamports}
                    onInput={(event: any) =>
                      updateBuyPlanRow(row.id, {
                        priorityMicroLamports: event.currentTarget.value,
                      })
                    }
                  />
                  <input
                    title="slippage bps"
                    value={row.slippageBps}
                    onInput={(event: any) =>
                      updateBuyPlanRow(row.id, {
                        slippageBps: event.currentTarget.value,
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    title="retry ms"
                    value={row.retryIntervalMs}
                    onInput={(event: any) =>
                      updateBuyPlanRow(row.id, {
                        retryIntervalMs: event.currentTarget.value,
                      })
                    }
                  />
                  <input
                    title="recompile ms"
                    value={row.recompileIntervalMs}
                    onInput={(event: any) =>
                      updateBuyPlanRow(row.id, {
                        recompileIntervalMs: event.currentTarget.value,
                      })
                    }
                  />
                  <input
                    title="fresh quote delay"
                    value={row.freshQuoteDelayMs}
                    onInput={(event: any) =>
                      updateBuyPlanRow(row.id, {
                        freshQuoteDelayMs: event.currentTarget.value,
                      })
                    }
                  />
                  <input
                    title="max failed"
                    value={row.maxFailedAttempts}
                    onInput={(event: any) =>
                      updateBuyPlanRow(row.id, {
                        maxFailedAttempts: event.currentTarget.value,
                      })
                    }
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => removeBuyPlanRow(row.id)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TerminalView() {
  const filter = state.pumpFeedFilter.trim().toLowerCase();
  const rows = filter
    ? state.pumpFeed.filter((row) =>
        [row.name, row.symbol, row.mint, row.creator].some((value) =>
          String(value ?? "")
            .toLowerCase()
            .includes(filter),
        ),
      )
    : state.pumpFeed;
  return (
    <div className="grid">
      <div className="card span-12 terminal-head">
        <div>
          <h2>Pump.fun new-token terminal</h2>
          <p className="muted">
            Live feed from PumpPortal WebSocket subscribeNewToken. Use it for
            watch-only discovery; trading still requires an explicit
            launch/trade action.
          </p>
        </div>
        <div className="row">
          <span
            className={`pill ${state.pumpFeedStatus === "connected" ? "ok" : state.pumpFeedStatus === "error" ? "bad" : ""}`}
          >
            {state.pumpFeedStatus}
          </span>
          <button type="button" onClick={() => void startPumpFeed()}>
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
            Clear
          </button>
        </div>
      </div>
      <div className="card span-12">
        <div className="row between">
          <div className="row">
            <label>
              Filter
              <input
                value={state.pumpFeedFilter}
                placeholder="symbol, name, mint, creator"
                onInput={(event: any) => {
                  state.pumpFeedFilter = event.currentTarget.value;
                  update();
                }}
              />
            </label>
            <span className="pill">
              {rows.length} shown / {state.pumpFeed.length} cached
            </span>
          </div>
          {state.pumpFeedError ? (
            <span className="pill bad">{state.pumpFeedError}</span>
          ) : null}
        </div>
        <div className="terminal-table">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Token</th>
                <th>Mint</th>
                <th>Creator</th>
                <th>Initial buy</th>
                <th>MCap SOL</th>
                <th>Sig</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr>
                  <td className="code">
                    {row.receivedAt
                      ? new Date(row.receivedAt).toLocaleTimeString()
                      : "—"}
                  </td>
                  <td>
                    <div className="token-title">
                      {row.symbol ? `$${row.symbol}` : "—"}
                    </div>
                    <div className="muted small">
                      {row.name ?? row.eventType ?? "new token"}
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
                  <td>{formatSol(row.marketCapSol)}</td>
                  <td className="code">{short(row.signature)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card span-12">
        <h3>Latest raw event</h3>
        {state.pumpFeed[0] ? (
          <pre>{JSON.stringify(state.pumpFeed[0], null, 2)}</pre>
        ) : (
          <p className="muted">
            Connect to the feed to see new Pump.fun launches.
          </p>
        )}
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
        const explicitBuyPlan = buyPlanPayload();
        if (explicitBuyPlan.length > 0) body.buyPlan = explicitBuyPlan;
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
            Buyer group fallback
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
      <BuyPlanTable />
      <div className="card span-12">
        <h3>Global defaults</h3>
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
      ) : state.tab === "terminal" ? (
        <TerminalView />
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
  return () => {
    clearInterval(interval);
    state.pumpFeedAbort?.abort();
  };
}
