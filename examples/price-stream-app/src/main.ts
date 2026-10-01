import {
  connectPriceFeed,
  type PriceFeedClient,
  type PriceFeedLaunch,
  type PriceFeedPrice,
  type PriceFeedStatus,
} from "../../price-feed-client.ts";

type TokenState = {
  mint: string;
  launch: PriceFeedLaunch | null;
  price: PriceFeedPrice | null;
  firstPriceUsd: number | null;
  peakMarketCapUsd: number | null;
  ticks: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
};

type SortKey = "activity" | "market-cap" | "launch" | "price";

const tokens = new Map<string, TokenState>();
const recentPriceEvents: number[] = [];
let client: PriceFeedClient | null = null;
let controller: AbortController | null = null;
let connectedAtMs = Date.now();
let totalLaunches = 0;
let totalPrices = 0;
let statusText = "disconnected";
let statusTone: "good" | "warn" | "bad" = "bad";
let renderPending = false;
let renderTimer: number | null = null;
let paused = false;

const $ = <T extends HTMLElement>(selector: string): T => {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`Missing element: ${selector}`);
  return node as T;
};

const feedInput = $("#feed-url") as HTMLInputElement;
const connectButton = $("#connect") as HTMLButtonElement;
const pauseButton = $("#pause") as HTMLButtonElement;
const clearButton = $("#clear") as HTMLButtonElement;
const searchInput = $("#search") as HTMLInputElement;
const venueSelect = $("#venue") as HTMLSelectElement;
const sortSelect = $("#sort") as HTMLSelectElement;
const sessionOnly = $("#session-only") as HTMLInputElement;
const pricedOnly = $("#priced-only") as HTMLInputElement;
const rows = $("#token-rows") as HTMLTableSectionElement;
const empty = $("#empty") as HTMLDivElement;
const connectionDot = $("#connection-dot");
const connectionText = $("#connection-text");
const statLaunches = $("#stat-launches");
const statPriced = $("#stat-priced");
const statRate = $("#stat-rate");
const statTracked = $("#stat-tracked");
const eventLog = $("#event-log");

const params = new URLSearchParams(location.search);
feedInput.value = params.get("feed") ?? `ws://${location.hostname}:8788/ws`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function compact(value: string, left = 5, right = 5): string {
  if (value.length <= left + right + 1) return value;
  return `${value.slice(0, left)}…${value.slice(-right)}`;
}

function fmtUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000)
    return `$${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}m`;
  if (value >= 1_000)
    return `$${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.001) return `$${value.toFixed(6)}`;
  return `$${value.toExponential(3)}`;
}

function fmtSol(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 0.001) return value.toFixed(6);
  return value.toExponential(3);
}

function fmtPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(Math.abs(value) >= 100 ? 0 : 1)}%`;
}

function age(atMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - atMs) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function venueLabel(value: string): string {
  if (value === "raydium-launchlab") return "LaunchLab";
  if (value === "rpc-fallback") return "RPC";
  if (value === "pumpswap") return "PumpSwap";
  return "Pump";
}

function stateFor(mint: string, atMs: number): TokenState {
  let state = tokens.get(mint);
  if (!state) {
    state = {
      mint,
      launch: null,
      price: null,
      firstPriceUsd: null,
      peakMarketCapUsd: null,
      ticks: 0,
      firstSeenAtMs: atMs,
      lastSeenAtMs: atMs,
    };
    tokens.set(mint, state);
  }
  return state;
}

function addEvent(text: string, tone: "neutral" | "good" | "warn" = "neutral") {
  const line = document.createElement("div");
  line.className = `event-line ${tone}`;
  line.innerHTML = `<span>${new Date().toLocaleTimeString()}</span><strong>${escapeHtml(text)}</strong>`;
  eventLog.prepend(line);
  while (eventLog.children.length > 8) eventLog.lastElementChild?.remove();
}

function onLaunch(launch: PriceFeedLaunch) {
  if (launch.isMayhemMode === true) return;
  totalLaunches += 1;
  const state = stateFor(launch.mint, launch.atMs);
  const wasMissing = state.launch == null;
  state.launch = launch;
  state.firstSeenAtMs = Math.min(state.firstSeenAtMs, launch.atMs);
  state.lastSeenAtMs = Math.max(state.lastSeenAtMs, launch.atMs);
  if (wasMissing && launch.atMs >= connectedAtMs - 2_000) {
    addEvent(
      `new ${launch.symbol ? `$${launch.symbol}` : compact(launch.mint)} · ${venueLabel(launch.venue)}`,
      "good",
    );
  }
  requestRender();
}

function onPrice(price: PriceFeedPrice) {
  totalPrices += 1;
  recentPriceEvents.push(Date.now());
  const state = stateFor(price.mint, price.atMs);
  state.price = price;
  state.ticks += 1;
  state.lastSeenAtMs = Math.max(state.lastSeenAtMs, price.atMs);
  if (state.firstPriceUsd == null && price.priceUsd != null)
    state.firstPriceUsd = price.priceUsd;
  if (price.marketCapUsd != null) {
    state.peakMarketCapUsd = Math.max(
      state.peakMarketCapUsd ?? 0,
      price.marketCapUsd,
    );
  }
  requestRender();
}

function onStatus(status: PriceFeedStatus) {
  addEvent(`server: ${status.event}`);
}

function setConnection(text: string, tone: "good" | "warn" | "bad") {
  statusText = text;
  statusTone = tone;
  connectionText.textContent = text;
  connectionDot.className = `status-dot ${tone}`;
}

async function connect() {
  controller?.abort();
  client?.close();
  client = null;
  controller = new AbortController();
  connectedAtMs = Date.now();
  setConnection("connecting", "warn");
  connectButton.disabled = true;
  const url = feedInput.value.trim();
  try {
    client = await connectPriceFeed({
      url,
      signal: controller.signal,
      subscribe: {
        op: "subscribe",
        launches: true,
        allPrices: true,
      },
      onMessage(message) {
        if (message.type === "launch") onLaunch(message);
        else if (message.type === "price") onPrice(message);
        else onStatus(message);
      },
      onStatus(event, data) {
        if (event === "connected") {
          setConnection("connected", "good");
          addEvent("price feed connected", "good");
        } else if (event === "connect-error") {
          setConnection("reconnecting", "warn");
          addEvent(
            `feed reconnect: ${String(data?.error ?? "connection error")}`,
            "warn",
          );
        } else if (event === "callback-error" || event === "listener-error") {
          addEvent(String(data?.error ?? event), "warn");
        }
      },
    });
    const next = new URL(location.href);
    next.searchParams.set("feed", url);
    history.replaceState(null, "", next);
  } catch (error) {
    setConnection("offline", "bad");
    addEvent(error instanceof Error ? error.message : String(error), "warn");
  } finally {
    connectButton.disabled = false;
  }
}

function visibleTokens(): TokenState[] {
  const query = searchInput.value.trim().toLowerCase();
  const venue = venueSelect.value;
  const onlySession = sessionOnly.checked;
  const onlyPriced = pricedOnly.checked;
  const values = [...tokens.values()].filter((state) => {
    if (onlySession && state.firstSeenAtMs < connectedAtMs - 2_000)
      return false;
    if (
      onlyPriced &&
      state.price?.priceUsd == null &&
      state.price?.priceSol == null
    )
      return false;
    const actualVenue = state.price?.venue ?? state.launch?.venue ?? "";
    if (venue !== "all" && actualVenue !== venue) {
      if (!(venue === "pump" && actualVenue === "pumpswap")) return false;
    }
    if (!query) return true;
    return [
      state.mint,
      state.launch?.symbol ?? "",
      state.launch?.name ?? "",
    ].some((value) => value.toLowerCase().includes(query));
  });

  const sort = sortSelect.value as SortKey;
  values.sort((a, b) => {
    if (sort === "market-cap")
      return (b.price?.marketCapUsd ?? -1) - (a.price?.marketCapUsd ?? -1);
    if (sort === "launch")
      return (
        (b.launch?.atMs ?? b.firstSeenAtMs) -
        (a.launch?.atMs ?? a.firstSeenAtMs)
      );
    if (sort === "price")
      return (b.price?.priceUsd ?? -1) - (a.price?.priceUsd ?? -1);
    return b.lastSeenAtMs - a.lastSeenAtMs;
  });
  return values;
}

function render() {
  renderPending = false;
  renderTimer = null;
  if (paused) return;
  const now = Date.now();
  while (recentPriceEvents.length && recentPriceEvents[0]! < now - 10_000)
    recentPriceEvents.shift();

  const values = visibleTokens();
  const limited = values.slice(0, 350);
  const priced = [...tokens.values()].filter(
    (row) => row.price?.priceUsd != null || row.price?.priceSol != null,
  ).length;

  statLaunches.textContent = totalLaunches.toLocaleString();
  statPriced.textContent = priced.toLocaleString();
  statTracked.textContent = tokens.size.toLocaleString();
  statRate.textContent = `${(recentPriceEvents.length / 10).toFixed(1)}/s`;

  rows.innerHTML = limited
    .map((state) => {
      const launch = state.launch;
      const price = state.price;
      const symbol = launch?.symbol
        ? `$${launch.symbol}`
        : compact(state.mint, 6, 4);
      const name = launch?.name ?? "Unlabelled token";
      const venue = venueLabel(price?.venue ?? launch?.venue ?? "pump");
      const baseline = state.firstPriceUsd;
      const change =
        baseline && price?.priceUsd != null
          ? (price.priceUsd / baseline - 1) * 100
          : null;
      const isFresh = state.lastSeenAtMs >= now - 3_000;
      const launchedThisSession =
        (launch?.atMs ?? state.firstSeenAtMs) >= connectedAtMs - 2_000;
      const changeClass =
        change == null ? "muted" : change >= 0 ? "positive" : "negative";
      return `
      <tr class="${isFresh ? "fresh" : ""}" data-mint="${escapeHtml(state.mint)}">
        <td>
          <div class="token-cell">
            <div class="token-icon">${escapeHtml((launch?.symbol?.[0] ?? "•").toUpperCase())}</div>
            <div class="token-copy">
              <div class="token-title">${escapeHtml(symbol)} ${launchedThisSession ? '<span class="new-badge">NEW</span>' : ""}</div>
              <div class="token-name">${escapeHtml(name)}</div>
            </div>
          </div>
        </td>
        <td><span class="venue-badge venue-${escapeHtml((price?.venue ?? launch?.venue ?? "pump").replaceAll("-", "_"))}">${escapeHtml(venue)}</span></td>
        <td class="numeric strong">${fmtUsd(price?.priceUsd ?? null)}</td>
        <td class="numeric mono subtle">${fmtSol(price?.priceSol ?? null)}</td>
        <td class="numeric strong">${fmtUsd(price?.marketCapUsd ?? null)}</td>
        <td class="numeric ${changeClass}">${fmtPct(change)}</td>
        <td class="numeric">${state.peakMarketCapUsd == null ? "—" : fmtUsd(state.peakMarketCapUsd)}</td>
        <td class="numeric mono">${state.ticks.toLocaleString()}</td>
        <td class="numeric age-cell">${age(state.lastSeenAtMs)}</td>
        <td><button class="copy-mint" data-copy="${escapeHtml(state.mint)}" title="Copy mint">Copy</button></td>
      </tr>`;
    })
    .join("");

  empty.hidden = limited.length > 0;
  empty.textContent =
    tokens.size === 0
      ? "Waiting for the feed…"
      : "No tokens match the current filters.";
}

function requestRender() {
  if (paused || renderPending) return;
  renderPending = true;
  renderTimer = window.setTimeout(render, 160);
}

connectButton.addEventListener("click", () => void connect());
pauseButton.addEventListener("click", () => {
  paused = !paused;
  pauseButton.textContent = paused ? "Resume UI" : "Pause UI";
  pauseButton.classList.toggle("active", paused);
  if (!paused) render();
});
clearButton.addEventListener("click", () => {
  tokens.clear();
  totalLaunches = 0;
  totalPrices = 0;
  recentPriceEvents.length = 0;
  eventLog.innerHTML = "";
  connectedAtMs = Date.now();
  render();
});
for (const control of [
  searchInput,
  venueSelect,
  sortSelect,
  sessionOnly,
  pricedOnly,
]) {
  control.addEventListener("input", requestRender);
  control.addEventListener("change", requestRender);
}
rows.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>("button[data-copy]");
  if (!button) return;
  const mint = button.dataset.copy;
  if (!mint) return;
  await navigator.clipboard.writeText(mint);
  const previous = button.textContent;
  button.textContent = "Copied";
  window.setTimeout(() => {
    button.textContent = previous;
  }, 900);
});

window.setInterval(() => {
  if (client && !client.connected && statusText === "connected")
    setConnection("reconnecting", "warn");
  requestRender();
}, 1_000);

window.addEventListener("beforeunload", () => {
  controller?.abort();
  client?.close();
});

render();
void connect();
