import { render } from "tradjs/client";
import { api } from "../_client/api";
import { age, formatMcap, numberValue, short } from "../_client/format";
import {
  storageFlag,
  storageGet,
  storageJson,
  storageSet,
} from "../_client/storage";
import {
  clearClientMeasureEntries,
  getClientMeasureEntries,
  measureClient,
  measureEvent,
  subscribeClientMeasure,
  summarizeError,
  type ClientMeasureEntry,
} from "../_client/measure";
import type {
  AnyRow,
  OverviewPayload,
  PumpFeedRow,
  TerminalFeedPayload,
  TerminalHealthPayload,
  WalletRow,
} from "../_client/types";

type SortBase =
  | "created"
  | "lastTrade"
  | "mcap"
  | "sma1m"
  | "sma5m"
  | "sma15m"
  | "trades"
  | "trades1m"
  | "volume1m";

type SortKey = `${SortBase}-asc` | `${SortBase}-desc`;

type HolderRow = {
  owner?: string | null;
  tokenAccount?: string | null;
  uiAmount?: string | number | null;
  amountUi?: string | number | null;
  amount?: string | number | null;
  pctSupply?: string | number | null;
  percent?: string | number | null;
  [key: string]: any;
};

type PageState = {
  rows: PumpFeedRow[];
  health: TerminalHealthPayload | null;
  feedMeta: AnyRow | null;
  status: "idle" | "loading" | "live" | "error";
  error: string | null;
  lastPollAtMs: number | null;
  lastRows: number;
  filter: string;
  hideMayhem: boolean;
  hideUsdc: boolean;
  sort: SortKey;
  selectedKey: string | null;
  pinned: string[];

  resetBusy: boolean;
  resetMessage: string | null;

  wallets: WalletRow[];
  selectedWallet: string;
  buySol: string;
  sellPct: string;
  slippageBps: string;
  sender: string;
  liveTrade: boolean;
  tradeBusy: boolean;
  tradeMessage: string | null;
  tradeError: string | null;
  holdersMint: string | null;
  holders: HolderRow[];
  holdersBusy: boolean;
  holdersMessage: string | null;
  holdersError: string | null;
  showLogs: boolean;
  logs: ClientMeasureEntry[];

  selectedLogId: string | number | null;
  copiedLogId: string | number | null;
};

const SCOPE = "solard:web:terminal-direct";
const FEED_LIMIT = 160;
const FEED_WINDOW_MS = Number(
  storageGet("solard:terminal-feed-window-ms", "300000"),
);

const state: PageState = {
  rows: [],
  health: null,
  feedMeta: null,
  status: "idle",
  error: null,
  lastPollAtMs: null,
  lastRows: 0,
  filter: storageGet("solwal:pump-feed-filter", ""),
  hideMayhem: storageFlag("solwal:pump-hide-mayhem"),
  hideUsdc: storageFlag("solwal:pump-hide-usdc"),
  sort: (() => {
    const saved = storageGet("solwal:pump-feed-sort", "created-desc");

    if (saved === "newest" || saved.startsWith("age")) {
      return "created-desc";
    }

    return saved as SortKey;
  })(),
  selectedKey: storageGet("solard:terminal-inspector-key", "") || null,
  pinned: storageJson<string[]>("solard:terminal-pinned-mints", []).filter(
    (x) => typeof x === "string",
  ),

  resetBusy: false,
  resetMessage: null,

  wallets: [],
  selectedWallet: storageGet("solwal:terminal-default-wallet", ""),
  buySol: storageGet("solwal:terminal-default-buy-sol", "0.05"),
  sellPct: storageGet("solwal:terminal-default-sell-pct", "100"),
  slippageBps: storageGet("solwal:terminal-default-slippage-bps", "9999"),
  sender: storageGet("solwal:terminal-default-sender", "helius-fast"),
  liveTrade: storageFlag("solwal:terminal-quick-live"),
  tradeBusy: false,
  tradeMessage: null,
  tradeError: null,
  holdersMint: null,
  holders: [],
  holdersBusy: false,
  holdersMessage: null,
  holdersError: null,
  showLogs: storageGet("solard:terminal-show-logs", "1") !== "0",
  logs: getClientMeasureEntries(),

  selectedLogId: null,
  copiedLogId: null,
};

let unmounted = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollInFlight = false;
let unsubscribeLogs: (() => void) | null = null;
let logRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function pollMs(): number {
  const parsed = Number(storageGet("solard:terminal-poll-ms", "1000"));
  return Number.isFinite(parsed)
    ? Math.max(1000, Math.min(parsed, 30000))
    : 1000;
}

function rootElement(): HTMLElement {
  const root = document.getElementById("app-root");
  if (!root) throw new Error("Missing #app-root");
  return root;
}

let renderFrame: number | null = null;

let renderGeneration = 0;

type TerminalUiMemory = {
  windowX: number;
  windowY: number;

  tableLeft: number;
  tableTop: number;

  activityLeft: number;
  activityTop: number;

  focusKey: string | null;
  selectionStart: number | null;
  selectionEnd: number | null;
};

const uiMemory: TerminalUiMemory = {
  windowX: 0,
  windowY: 0,

  tableLeft: 0,
  tableTop: 0,

  activityLeft: 0,
  activityTop: 0,

  focusKey: null,
  selectionStart: null,
  selectionEnd: null,
};

function rememberTerminalUi(root: HTMLElement): void {
  uiMemory.windowX = window.scrollX;

  uiMemory.windowY = window.scrollY;

  const table = root.querySelector<HTMLElement>(".terminal-v10-table-wrap");

  if (table) {
    uiMemory.tableLeft = table.scrollLeft;

    uiMemory.tableTop = table.scrollTop;
  }

  const activity = root.querySelector<HTMLElement>(".terminal-v10-log-rows");

  if (activity) {
    uiMemory.activityLeft = activity.scrollLeft;

    uiMemory.activityTop = activity.scrollTop;
  }

  const active =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  uiMemory.focusKey = active?.dataset.terminalFocus ?? null;

  const input =
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? active
      : null;

  uiMemory.selectionStart = input?.selectionStart ?? null;

  uiMemory.selectionEnd = input?.selectionEnd ?? null;
}

function observeTerminalUi(root: HTMLElement): void {
  const table = root.querySelector<HTMLElement>(".terminal-v10-table-wrap");

  table?.addEventListener(
    "scroll",
    () => {
      uiMemory.tableLeft = table.scrollLeft;

      uiMemory.tableTop = table.scrollTop;
    },
    {
      passive: true,
    },
  );

  const activity = root.querySelector<HTMLElement>(".terminal-v10-log-rows");

  activity?.addEventListener(
    "scroll",
    () => {
      uiMemory.activityLeft = activity.scrollLeft;

      uiMemory.activityTop = activity.scrollTop;
    },
    {
      passive: true,
    },
  );

  root.addEventListener("focusin", (event) => {
    const target = event.target;

    if (target instanceof HTMLElement) {
      uiMemory.focusKey = target.dataset.terminalFocus ?? null;
    }
  });

  root.addEventListener("input", (event) => {
    const target = event.target;

    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    ) {
      uiMemory.focusKey = target.dataset.terminalFocus ?? null;

      uiMemory.selectionStart = target.selectionStart;

      uiMemory.selectionEnd = target.selectionEnd;
    }
  });
}

function restoreTerminalUi(root: HTMLElement, generation: number): void {
  const restore = () => {
    if (
      unmounted ||
      generation !== renderGeneration ||
      root !== document.getElementById("app-root")
    ) {
      return;
    }

    const table = root.querySelector<HTMLElement>(".terminal-v10-table-wrap");

    if (table) {
      table.scrollLeft = Math.min(
        uiMemory.tableLeft,
        Math.max(0, table.scrollWidth - table.clientWidth),
      );

      table.scrollTop = Math.min(
        uiMemory.tableTop,
        Math.max(0, table.scrollHeight - table.clientHeight),
      );
    }

    const activity = root.querySelector<HTMLElement>(".terminal-v10-log-rows");

    if (activity) {
      activity.scrollLeft = Math.min(
        uiMemory.activityLeft,
        Math.max(0, activity.scrollWidth - activity.clientWidth),
      );

      activity.scrollTop = Math.min(
        uiMemory.activityTop,
        Math.max(0, activity.scrollHeight - activity.clientHeight),
      );
    }

    if (uiMemory.focusKey) {
      const target = root.querySelector<HTMLElement>(
        `[data-terminal-focus="${uiMemory.focusKey}"]`,
      );

      target?.focus({
        preventScroll: true,
      });

      if (
        (target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement) &&
        uiMemory.selectionStart != null &&
        uiMemory.selectionEnd != null
      ) {
        try {
          target.setSelectionRange(
            uiMemory.selectionStart,
            uiMemory.selectionEnd,
          );
        } catch {}
      }
    }

    window.scrollTo(uiMemory.windowX, uiMemory.windowY);
  };

  /**
   * Restore once immediately and again after layout settles. Generation checks
   * prevent an older render from resetting a newer root.
   */
  restore();

  requestAnimationFrame(restore);

  setTimeout(restore, 40);
}

function copyRootAttributes(source: HTMLElement, target: HTMLElement): void {
  for (const attribute of [...source.attributes]) {
    if (
      attribute.name === "id" ||
      attribute.name === "data-terminal-render-generation"
    ) {
      continue;
    }

    target.setAttribute(attribute.name, attribute.value);
  }
}

function renderTerminalPage(): void {
  const current = rootElement();

  const parent = current.parentNode;

  if (!parent) {
    throw new Error("Terminal root is detached");
  }

  rememberTerminalUi(current);

  const generation = ++renderGeneration;

  /**
   * Render into a completely detached, uniquely named element first.
   *
   * The live #app-root remains untouched while TradJS builds the new tree, so
   * no renderer state can refer to children that another refresh has removed.
   * Only after a successful mount do we atomically swap the finished root into
   * the document.
   */
  const staged = document.createElement(current.tagName.toLowerCase());

  copyRootAttributes(current, staged);

  staged.id = `terminal-stage-${generation}`;

  staged.dataset.terminalRenderGeneration = String(generation);

  render(<TerminalPage />, staged, {
    reconciler: "sequential",
  });

  /**
   * Avoid duplicate #app-root ids during the swap.
   */
  current.removeAttribute("id");

  staged.id = "app-root";

  parent.replaceChild(staged, current);

  observeTerminalUi(staged);

  document
    .querySelectorAll<HTMLAnchorElement>("#main-nav a")
    .forEach((link) =>
      link.classList.toggle("active", link.dataset.page === "terminal"),
    );

  restoreTerminalUi(staged, generation);
}

function rerender(): void {
  if (unmounted || renderFrame != null) {
    return;
  }

  /**
   * One render per animation frame. Feed completion, activity updates, and
   * state changes in the same frame collapse into a single detached mount.
   */
  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;

    if (unmounted) {
      return;
    }

    try {
      renderTerminalPage();
    } catch (error) {
      state.status = "error";

      state.error = error instanceof Error ? error.message : String(error);

      console.error("[solard:terminal] render failed", error);
    }
  });
}

function clearPollTimer(): void {
  if (pollTimer != null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function scheduleNextPoll(): void {
  clearPollTimer();
  if (unmounted || state.status === "idle") return;
  pollTimer = setTimeout(
    () => void reloadFeed({ scheduleNext: true }),
    pollMs(),
  );
}

function imageUrl(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (text.startsWith("ipfs://"))
    return `https://ipfs.io/ipfs/${text.replace(/^ipfs:\/\//, "")}`;
  if (/^https?:\/\//i.test(text)) return text;
  return null;
}

function tokenImage(row: PumpFeedRow | null | undefined): string | null {
  if (!row) return null;
  return (
    imageUrl(row.image) ??
    imageUrl(row.raw?.image) ??
    imageUrl(row.raw?.metadata?.image) ??
    imageUrl(row.raw?.content?.links?.image) ??
    null
  );
}

function TokenAvatar({
  row,
  large = false,
}: {
  row: PumpFeedRow;
  large?: boolean;
}) {
  const src = tokenImage(row);
  const initial =
    String(row.symbol ?? row.name ?? "?")
      .replace(/^\$/, "")
      .slice(0, 2)
      .toUpperCase() || "?";
  return src ? (
    <img
      className={`terminal-v10-avatar ${large ? "large" : ""}`}
      src={src}
      loading="lazy"
      alt={String(row.symbol ?? row.name ?? "token")}
    />
  ) : (
    <div
      className={`terminal-v10-avatar terminal-v10-avatar-fallback ${large ? "large" : ""}`}
    >
      {initial}
    </div>
  );
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
): number | null {
  return (
    numberValue(row?.marketCapUsd) ??
    numberValue((row as any)?.currentMarketCapUsd) ??
    numberValue((row as any)?.lastMarketCapUsd)
  );
}

function createdTime(row: PumpFeedRow): number | null {
  const value = Number(row.createdAtMs ?? 0);

  return Number.isFinite(value) && value > 0 ? value : null;
}

function lastTradeTime(row: PumpFeedRow): number | null {
  const value = Number(row.lastTradeAtMs ?? 0);

  return Number.isFinite(value) && value > 0 ? value : null;
}

function displayAge(value: number | null): string {
  return value == null ? "—" : age(value);
}

function booleanFlag(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") {
    return true;
  }

  if (value === false || value === 0 || value === "0") {
    return false;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (normalized === "true" || normalized === "yes") {
      return true;
    }

    if (normalized === "false" || normalized === "no") {
      return false;
    }
  }

  return null;
}

function mayhemFlag(row: PumpFeedRow): boolean | null {
  for (const value of [
    row.isMayhemMode,
    (row as any).is_mayhem_mode,
    row.raw?.isMayhemMode,
    row.raw?.is_mayhem_mode,
    row.raw?.metadata?.isMayhemMode,
    row.raw?.metadata?.is_mayhem_mode,
  ]) {
    const parsed = booleanFlag(value);

    if (parsed != null) {
      return parsed;
    }
  }

  return null;
}

function isMayhemKnown(row: PumpFeedRow): boolean {
  return (
    Number((row as any).mayhemCheckedAtMs ?? row.raw?.mayhemCheckedAtMs ?? 0) >
      0 || mayhemFlag(row) != null
  );
}

function isMayhem(row: PumpFeedRow): boolean {
  return mayhemFlag(row) === true;
}

function isUsdc(row: PumpFeedRow): boolean {
  const haystack =
    `${row.quoteAsset ?? ""} ${row.quoteMint ?? ""} ${row.raw?.quoteAsset ?? ""} ${row.raw?.quoteMint ?? ""}`.toLowerCase();
  return (
    haystack.includes("usdc") ||
    haystack.includes("epjfwdd5aufqssqem2qn1xzybapc8g4wegkgzwydt1v")
  );
}

function isPinned(row: PumpFeedRow): boolean {
  return !!row.mint && state.pinned.includes(row.mint);
}

function passesFilters(row: PumpFeedRow): boolean {
  if (state.hideMayhem && isMayhemKnown(row) && isMayhem(row)) {
    return false;
  }
  if (state.hideUsdc && isUsdc(row)) return false;
  const q = state.filter.trim().toLowerCase();
  if (!q) return true;
  return [
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
    .includes(q);
}

function trades15m(row: PumpFeedRow): number {
  return (
    numberValue((row as any).trades15m) ?? numberValue(row.tradeCount) ?? 0
  );
}

function trades1m(row: PumpFeedRow): number {
  return numberValue((row as any).trades1m) ?? 0;
}

function volumeSol1m(row: PumpFeedRow): number {
  return numberValue((row as any).volumeSol1m) ?? 0;
}

function sortValue(row: PumpFeedRow): number {
  if (state.sort.startsWith("created")) {
    return createdTime(row) ?? -Infinity;
  }

  if (state.sort.startsWith("lastTrade")) {
    return lastTradeTime(row) ?? -Infinity;
  }

  if (state.sort.startsWith("mcap")) return latestMcap(row) ?? -Infinity;
  if (state.sort.startsWith("sma1m"))
    return numberValue(row.sma1m) ?? -Infinity;
  if (state.sort.startsWith("sma5m"))
    return numberValue(row.sma5m) ?? -Infinity;
  if (state.sort.startsWith("sma15m"))
    return numberValue(row.sma15m) ?? -Infinity;
  if (state.sort.startsWith("trades1m")) return trades1m(row);
  if (state.sort.startsWith("trades")) return trades15m(row);
  if (state.sort.startsWith("volume1m")) return volumeSol1m(row);

  return createdTime(row) ?? -Infinity;
}

function visibleRows(): PumpFeedRow[] {
  return state.rows.filter(passesFilters).sort((a, b) => {
    if (isPinned(a) !== isPinned(b)) return isPinned(a) ? -1 : 1;
    const dir = state.sort.endsWith("-asc") ? 1 : -1;
    const av = sortValue(a);
    const bv = sortValue(b);
    if (av !== bv) return (av - bv) * dir;
    return (createdTime(b) ?? 0) - (createdTime(a) ?? 0);
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

function setSort(base: SortBase): void {
  const defaultKey = `${base}-desc` as SortKey;

  const alternateKey = (
    defaultKey.endsWith("-asc") ? `${base}-desc` : `${base}-asc`
  ) as SortKey;

  state.sort = state.sort === defaultKey ? alternateKey : defaultKey;

  storageSet("solwal:pump-feed-sort", state.sort);

  measureEvent(SCOPE, "sort", {
    sort: state.sort,
  });

  rerender();
}

function sortMark(base: string): string {
  return state.sort === `${base}-asc`
    ? "↑"
    : state.sort === `${base}-desc`
      ? "↓"
      : "";
}

function setFilter(value: string): void {
  state.filter = value;
  storageSet("solwal:pump-feed-filter", value);
  rerender();
}

function toggleHide(field: "hideMayhem" | "hideUsdc", key: string): void {
  state[field] = !state[field];
  storageSet(key, state[field] ? "1" : "0");
  measureEvent(SCOPE, "toggle filter", { field, value: state[field] });
  void reloadFeed();
  rerender();
}

function togglePinned(row: PumpFeedRow): void {
  if (!row.mint) return;
  state.pinned = state.pinned.includes(row.mint)
    ? state.pinned.filter((mint) => mint !== row.mint)
    : [row.mint, ...state.pinned];
  storageSet("solard:terminal-pinned-mints", JSON.stringify(state.pinned));
  measureEvent(SCOPE, "pin token", { mint: row.mint, pinned: isPinned(row) });
  rerender();
}

function selectRow(row: PumpFeedRow): void {
  const key = rowKey(row);
  state.selectedKey = key;
  storageSet("solard:terminal-inspector-key", key);
  state.tradeError = null;
  state.tradeMessage = null;
  measureEvent(SCOPE, "select token", {
    mint: row.mint,
    symbol: row.symbol,
    mcap: latestMcap(row),
  });
  rerender();
}

async function loadWallets(): Promise<void> {
  await measureClient(
    {
      scope: SCOPE,
      start: () => "load wallets",
      end: (overview: OverviewPayload) => ({
        wallets: overview.wallets?.length ?? 0,
      }),
      catch: summarizeError,
    },
    async () => {
      const overview = await api<OverviewPayload>(
        "/api/overview?fast=1&balances=none&tokenLimit=0&executionLimit=0",
      );
      state.wallets = overview.wallets ?? [];
      if (!state.selectedWallet && state.wallets[0]?.address) {
        state.selectedWallet = state.wallets[0].address;
        storageSet("solwal:terminal-default-wallet", state.selectedWallet);
      }
      return overview;
    },
  ).catch(() => undefined);
  rerender();
}

async function reloadFeed(
  options: { includeHealth?: boolean; scheduleNext?: boolean } = {},
): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;
  state.status = state.rows.length ? "live" : "loading";

  state.error = null;

  if (!state.rows.length) {
    rerender();
  }

  try {
    const payload = await measureClient(
      {
        scope: SCOPE,
        start: () =>
          `feed refresh limit=${FEED_LIMIT} window=${FEED_WINDOW_MS} health=${options.includeHealth ? 1 : 0}`,
        end: (payload: TerminalFeedPayload) => ({
          rows: payload.rows?.length ?? 0,
          raw: payload.meta?.count ?? null,
          priced: payload.meta?.priced ?? null,
          latestPriceAgeMs: payload.meta?.latestPriceAgeMs ?? null,
          activeWindowMs: payload.meta?.activeWindowMs ?? null,
        }),
        catch: summarizeError,
      },
      async () => {
        const params = new URLSearchParams({
          limit: String(FEED_LIMIT),
          activeWindowMs: String(FEED_WINDOW_MS),
          includeUnpriced: "1",
          source: "both",
          hideMayhem: state.hideMayhem ? "1" : "0",
          hideUsdc: state.hideUsdc ? "1" : "0",
          stats: options.includeHealth ? "1" : "0",
          health: options.includeHealth ? "1" : "0",

          pinned: state.pinned.join(","),
        });

        return await api<TerminalFeedPayload>(`/api/terminal/feed?${params}`);
      },
    );

    state.rows = payload.rows ?? [];
    state.feedMeta = payload.meta ?? null;
    state.lastRows = state.rows.length;
    state.lastPollAtMs = Date.now();
    if (payload.health) state.health = payload.health;
    state.status = "live";
  } catch (error) {
    state.status = "error";
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    pollInFlight = false;
    rerender();
    if (options.scheduleNext) scheduleNextPoll();
  }
}

async function resetFeed(): Promise<void> {
  if (state.resetBusy) return;

  const keep = state.pinned.length;

  const confirmed = window.confirm(
    `Reset the live feed? ${keep} pinned token${keep === 1 ? "" : "s"} will remain visible. Append-only trade history will not be deleted.`,
  );

  if (!confirmed) return;

  state.resetBusy = true;
  state.resetMessage = null;
  state.error = null;

  clearPollTimer();
  rerender();

  try {
    /**
     * Let the current poll settle first so an older response cannot visually
     * repopulate rows after the reset.
     */
    while (pollInFlight && !unmounted) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    clearPollTimer();

    const result = await measureClient(
      {
        scope: SCOPE,

        start: () => `reset feed pinned=${state.pinned.length}`,

        end: (value: AnyRow) => ({
          resetAtMs: value.resetAtMs ?? null,

          pinned: Array.isArray(value.pinned) ? value.pinned.length : 0,
        }),

        catch: summarizeError,
      },
      async () =>
        await api<AnyRow>("/api/terminal/feed/reset", {
          method: "POST",

          body: JSON.stringify({
            pinned: state.pinned,
          }),
        }),
    );

    state.rows = state.rows.filter((row) => isPinned(row));

    if (
      state.selectedKey &&
      !state.rows.some(
        (row) =>
          rowKey(row) === state.selectedKey || row.mint === state.selectedKey,
      )
    ) {
      state.selectedKey = state.rows[0] ? rowKey(state.rows[0]) : null;

      storageSet("solard:terminal-inspector-key", state.selectedKey ?? "");
    }

    state.resetMessage = `Feed reset · kept ${state.pinned.length} pinned`;

    measureEvent(SCOPE, "feed reset", {
      resetAtMs: result.resetAtMs ?? null,

      pinned: state.pinned.length,
    });

    await reloadFeed({
      includeHealth: true,
      scheduleNext: true,
    });
  } catch (error) {
    state.status = "error";

    state.error = error instanceof Error ? error.message : String(error);

    scheduleNextPoll();
  } finally {
    state.resetBusy = false;
    rerender();
  }
}

function restartWorkers(): void {
  void measureClient(
    {
      scope: SCOPE,
      start: () => "restart workers",
      end: (value) => value,
      catch: summarizeError,
    },
    async () =>
      await api("/api/workers/ensure", {
        method: "POST",
        body: JSON.stringify({
          action: "restart",
          worker: "all",
          all: true,
          telegram: true,
          restartStale: true,
          source: "both",
          clearLive: false,
        }),
      }),
  )
    .then(() => reloadFeed({ includeHealth: true }))
    .catch((error) => {
      state.error = error instanceof Error ? error.message : String(error);
      state.status = "error";
      rerender();
    });
}

function walletLabel(wallet: WalletRow): string {
  return wallet.name
    ? `${wallet.name} · ${short(wallet.address, 4, 4)}`
    : short(wallet.address, 5, 5);
}

function selectedWalletLabel(): string {
  const wallet = state.wallets.find(
    (row) =>
      row.address === state.selectedWallet || row.name === state.selectedWallet,
  );
  return wallet
    ? walletLabel(wallet)
    : state.selectedWallet
      ? short(state.selectedWallet, 5, 5)
      : "select wallet";
}

function updateTradeField(
  field: keyof PageState,
  value: string | boolean,
): void {
  (state as any)[field] = value;
  if (field === "selectedWallet")
    storageSet("solwal:terminal-default-wallet", String(value));
  if (field === "buySol")
    storageSet("solwal:terminal-default-buy-sol", String(value));
  if (field === "sellPct")
    storageSet("solwal:terminal-default-sell-pct", String(value));
  if (field === "slippageBps")
    storageSet("solwal:terminal-default-slippage-bps", String(value));
  if (field === "sender")
    storageSet("solwal:terminal-default-sender", String(value));
  if (field === "liveTrade")
    storageSet("solwal:terminal-quick-live", value ? "1" : "0");
  rerender();
}

function tokenMeta(row: PumpFeedRow): AnyRow {
  return {
    name: row.name ?? null,
    symbol: row.symbol ?? null,
    creator: row.creator ?? null,
    uri: row.uri ?? null,
    image: tokenImage(row),
    signature: row.signature ?? null,
    marketCapSol: row.marketCapSol ?? null,
    marketCapUsd: row.marketCapUsd ?? null,
    isMayhemMode: isMayhemKnown(row) ? isMayhem(row) : null,
    quoteAsset: row.quoteAsset ?? null,
    quoteMint: row.quoteMint ?? null,
  };
}

function apiErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const row = value as AnyRow;

  const nested =
    row.error && typeof row.error === "object" ? (row.error as AnyRow) : null;

  if (
    row.ok === false ||
    row.success === false ||
    row.name === "Error" ||
    nested
  ) {
    return String(
      nested?.message ?? row.message ?? row.error ?? "Request failed",
    );
  }

  return null;
}

async function tradeSelected(
  row: PumpFeedRow,
  side: "buy" | "sell",
): Promise<void> {
  if (!row.mint) {
    state.tradeError = "Selected token has no mint.";
    rerender();
    return;
  }
  if (!state.selectedWallet) {
    state.tradeError = "Select a wallet first.";
    rerender();
    return;
  }

  state.tradeBusy = true;
  state.tradeMessage = null;
  state.tradeError = null;
  rerender();

  try {
    const result = await measureClient(
      {
        scope: SCOPE,
        start: () =>
          `${side} token live=${state.liveTrade ? 1 : 0} mint=${short(row.mint, 4, 4)} wallet=${selectedWalletLabel()}`,
        end: (value) => ({ ok: true, value }),
        catch: summarizeError,
      },
      async () => {
        const body =
          side === "buy"
            ? {
                token: row.mint,
                amountSol: state.buySol,
                wallet: state.selectedWallet,
                slippageBps: Number(state.slippageBps || "9999"),
                sender: state.sender,
                live: state.liveTrade,
                skipSimulation: false,
                skipPreflight: true,
                tokenMeta: tokenMeta(row),
              }
            : {
                token: row.mint,
                wallet: state.selectedWallet,
                bps: Math.max(
                  1,
                  Math.min(
                    10000,
                    Math.round(Number(state.sellPct || "100") * 100),
                  ),
                ),
                slippageBps: Number(state.slippageBps || "9999"),
                sender: state.sender,
                live: state.liveTrade,
                skipSimulation: false,
                skipPreflight: true,
              };
        return await api<AnyRow>(`/api/trade/${side}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
      },
    );
    const responseError = apiErrorMessage(result);

    if (responseError) {
      throw new Error(responseError);
    }

    state.tradeMessage = `${side.toUpperCase()} ${state.liveTrade ? "live" : "sim"} ok: ${JSON.stringify(result).slice(0, 220)}`;
  } catch (error) {
    state.tradeError = error instanceof Error ? error.message : String(error);
  } finally {
    state.tradeBusy = false;
    rerender();
  }
}

async function refreshHolders(row: PumpFeedRow): Promise<void> {
  if (!row.mint) return;
  state.holdersBusy = true;
  state.holdersMint = row.mint;
  state.holdersError = null;
  state.holdersMessage = "Loading holders…";
  rerender();

  try {
    const result = await measureClient(
      {
        scope: SCOPE,
        start: () => `refresh holders mint=${short(row.mint, 4, 4)}`,
        end: (value: AnyRow) => ({
          holders: Array.isArray(value.holders) ? value.holders.length : 0,
          ok: value.ok,
        }),
        catch: summarizeError,
      },
      async () => {
        const params = new URLSearchParams({
          mint: row.mint!,
          limit: "20",
          refresh: "1",
          source: "terminal-ui",
        });
        return await api<AnyRow>(`/api/token-holders?${params}`);
      },
    );
    state.holders = Array.isArray(result.holders) ? result.holders : [];
    state.holdersMessage =
      result.unavailableReason ??
      (state.holders.length
        ? `${state.holders.length} holders`
        : "No holders yet");
  } catch (error) {
    state.holders = [];
    state.holdersError = error instanceof Error ? error.message : String(error);
    state.holdersMessage = null;
  } finally {
    state.holdersBusy = false;
    rerender();
  }
}

function formatVolumeSol(value: unknown): string {
  const number = numberValue(value);

  if (number == null) {
    return "—";
  }

  if (number === 0) {
    return "0 SOL";
  }

  const absolute = Math.abs(number);

  const maximumFractionDigits =
    absolute < 0.001
      ? 8
      : absolute < 0.01
        ? 6
        : absolute < 1
          ? 4
          : absolute < 100
            ? 2
            : 1;

  const formatted = new Intl.NumberFormat("en-US", {
    notation: absolute >= 10_000 ? "compact" : "standard",

    maximumFractionDigits,

    minimumFractionDigits:
      absolute < 0.01 ? Math.min(4, maximumFractionDigits) : 0,
  }).format(number);

  return `${formatted} SOL`;
}

function normalizedExternalUrl(
  kind: "site" | "x" | "tg",
  value: unknown,
): string | null {
  const raw = typeof value === "string" ? value.trim() : "";

  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  if (
    kind === "site" &&
    /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(raw)
  ) {
    return `https://${raw}`;
  }

  const handle = raw
    .replace(/^@/, "")
    .replace(/^(?:x|twitter|telegram|tg):/i, "")
    .trim();

  if (!/^[a-z0-9_]{2,64}$/i.test(handle)) {
    return null;
  }

  if (kind === "x") {
    return `https://x.com/${handle}`;
  }

  if (kind === "tg") {
    return `https://t.me/${handle}`;
  }

  return null;
}

function linksFor(row: PumpFeedRow): Array<{
  label: string;
  href: string;
}> {
  const links: Array<{
    label: string;
    href: string;
  }> = [];

  if (row.mint) {
    links.push({
      label: "solscan",
      href: `https://solscan.io/token/${row.mint}`,
    });

    links.push({
      label: "pump",
      href: `https://pump.fun/${row.mint}`,
    });
  }

  const candidates: Array<["site" | "x" | "tg", unknown[]]> = [
    [
      "site",
      [
        row.website,
        row.raw?.website,
        row.raw?.metadata?.website,
        row.raw?.metadata?.external_url,
      ],
    ],

    [
      "x",
      [
        row.twitter,
        row.raw?.twitter,
        row.raw?.x,
        row.raw?.metadata?.twitter,
        row.raw?.metadata?.x,
      ],
    ],

    ["tg", [row.telegram, row.raw?.telegram, row.raw?.metadata?.telegram]],
  ];

  for (const [label, values] of candidates) {
    const href =
      values
        .map((value) => normalizedExternalUrl(label, value))
        .find(Boolean) ?? null;

    if (href) {
      links.push({
        label,
        href,
      });
    }
  }

  return links;
}

function SortButton({ base, label }: { base: SortBase; label: string }) {
  return (
    <button
      type="button"
      className={`terminal-v10-sort ${state.sort.startsWith(base) ? "active" : ""}`}
      onClick={() => setSort(base)}
    >
      {label} {sortMark(base)}
    </button>
  );
}

function TokenRow({ row, selected }: { row: PumpFeedRow; selected: boolean }) {
  return (
    <tr
      className={`${selected ? "selected" : ""} ${isPinned(row) ? "pinned" : ""}`}
      onClick={() => selectRow(row)}
    >
      <td>
        <button
          type="button"
          className={`terminal-v10-pin ${isPinned(row) ? "active" : ""}`}
          onClick={(event: any) => {
            event.stopPropagation();
            togglePinned(row);
          }}
        >
          ★
        </button>
      </td>
      <td>
        <div className="terminal-v10-token-cell">
          <TokenAvatar row={row} />
          <div>
            <div className="terminal-v10-symbol">
              {row.symbol
                ? `$${row.symbol}`
                : row.name || short(row.mint, 5, 5)}
            </div>
            <div className="terminal-v10-name">{row.name || "unnamed"}</div>
          </div>
        </div>
      </td>

      <td className="terminal-v10-num">{formatMcap(latestMcap(row))}</td>
      <td className="terminal-v10-num">{formatMcap(row.sma1m)}</td>
      <td className="terminal-v10-num">{formatMcap(row.sma5m)}</td>
      <td className="terminal-v10-num">{formatMcap(row.sma15m)}</td>

      <td className="terminal-v10-num">{trades15m(row)}</td>
      <td className="terminal-v10-num">{trades1m(row)}</td>
      <td className="terminal-v10-num">{formatVolumeSol(volumeSol1m(row))}</td>

      <td className="terminal-v10-num">{displayAge(createdTime(row))}</td>

      <td className="terminal-v10-num">{displayAge(lastTradeTime(row))}</td>

      <td
        className="terminal-v10-mint-cell"
        style={{
          padding: 0,
        }}
      >
        {row.mint ? (
          <a
            className="terminal-v10-small code"
            href={`https://pump.fun/${row.mint}`}
            target="_blank"
            rel="noreferrer"
            title={`Open ${row.mint} on Pump.fun`}
            onClick={(event: any) => event.stopPropagation()}
            style={{
              display: "flex",
              alignItems: "center",
              width: "100%",
              minHeight: "44px",
              padding: "0 10px",
              boxSizing: "border-box",
            }}
          >
            {short(row.mint, 5, 5)}
          </a>
        ) : (
          <span
            className="terminal-v10-small"
            style={{
              display: "flex",
              alignItems: "center",
              minHeight: "44px",
              padding: "0 10px",
            }}
          >
            —
          </span>
        )}
      </td>
    </tr>
  );
}

function SelectedToken({ row }: { row: PumpFeedRow | null }) {
  if (!row)
    return (
      <section className="terminal-v10-selected">
        <p className="muted">Select a token.</p>
      </section>
    );
  const holders = state.holdersMint === row.mint ? state.holders : [];

  return (
    <section className="terminal-v10-selected">
      <div className="terminal-v10-selected-head">
        <TokenAvatar row={row} large />
        <div>
          <h3>{row.symbol ? `$${row.symbol}` : row.name || "Token"}</h3>
          <div className="muted">{row.name || short(row.mint, 8, 8)}</div>
          <div className="terminal-v10-links">
            {linksFor(row).map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noreferrer"
              >
                {link.label}
              </a>
            ))}
          </div>
        </div>
        <div className="terminal-v10-links">
          <button
            type="button"
            className="secondary compact"
            onClick={() => togglePinned(row)}
          >
            {isPinned(row) ? "Unpin" : "Pin"}
          </button>
          <button
            type="button"
            className="secondary compact"
            disabled={!row.mint || state.holdersBusy}
            onClick={() => void refreshHolders(row)}
          >
            {state.holdersBusy ? "Loading holders…" : "Refresh holders"}
          </button>
        </div>
      </div>

      <div className="terminal-v10-stats">
        <div>
          <span>MCap</span>
          <b>{formatMcap(latestMcap(row))}</b>
        </div>
        <div>
          <span>SMA 1m</span>
          <b>{formatMcap(row.sma1m)}</b>
        </div>
        <div>
          <span>SMA 5m</span>
          <b>{formatMcap(row.sma5m)}</b>
        </div>
        <div>
          <span>SMA 15m</span>
          <b>{formatMcap(row.sma15m)}</b>
        </div>
        <div>
          <span>Trades 1m</span>
          <b>{trades1m(row)}</b>
        </div>
        <div>
          <span>Volume 1m</span>
          <b>{formatVolumeSol(volumeSol1m(row))}</b>
        </div>
        <div>
          <span>Created</span>
          <b>{displayAge(createdTime(row))}</b>
        </div>
        <div>
          <span>Last trade</span>
          <b>{displayAge(lastTradeTime(row))}</b>
        </div>
        <div>
          <span>Mayhem</span>
          <b>
            {isMayhemKnown(row) ? (isMayhem(row) ? "yes" : "no") : "checking"}
          </b>
        </div>
      </div>

      <div className="terminal-v10-selected-grid">
        <div className="terminal-v10-panel">
          <h3>Trade</h3>
          <div className="terminal-v10-trade-form">
            <select
              data-terminal-focus="wallet"
              value={state.selectedWallet}
              title={selectedWalletLabel()}
              onInput={(event: any) =>
                updateTradeField("selectedWallet", event.currentTarget.value)
              }
            >
              <option value="">Select wallet…</option>
              {state.wallets.map((wallet) => (
                <option value={wallet.address ?? wallet.name ?? ""}>
                  {walletLabel(wallet)}
                </option>
              ))}
            </select>
            <input
              data-terminal-focus="buy-sol"
              value={state.buySol}
              placeholder="Buy SOL"
              onInput={(event: any) =>
                updateTradeField("buySol", event.currentTarget.value)
              }
            />
            <input
              data-terminal-focus="sell-pct"
              value={state.sellPct}
              placeholder="Sell %"
              onInput={(event: any) =>
                updateTradeField("sellPct", event.currentTarget.value)
              }
            />
            <input
              data-terminal-focus="slippage-bps"
              value={state.slippageBps}
              placeholder="Slippage bps"
              onInput={(event: any) =>
                updateTradeField("slippageBps", event.currentTarget.value)
              }
            />
          </div>
          <div className="terminal-v10-trade-form">
            <select
              data-terminal-focus="sender"
              value={state.sender}
              onInput={(event: any) =>
                updateTradeField("sender", event.currentTarget.value)
              }
            >
              <option value="helius-fast">Helius fast</option>
              <option value="helius-rpc">Helius RPC</option>
              <option value="rpc">RPC</option>
            </select>
            <label className="check">
              <input
                data-terminal-focus="live-trade"
                type="checkbox"
                checked={state.liveTrade}
                onChange={(event: any) =>
                  updateTradeField("liveTrade", event.currentTarget.checked)
                }
              />{" "}
              Live
            </label>
            <span className="muted small">
              {state.liveTrade ? "Live trade" : "Simulation"}
            </span>
            <span className="muted small">Wallet: {selectedWalletLabel()}</span>
          </div>
          <div className="terminal-v10-trade-actions">
            <button
              type="button"
              disabled={state.tradeBusy || !row.mint}
              onClick={() => void tradeSelected(row, "buy")}
            >
              Buy {state.buySol || "0"} SOL
            </button>
            <button
              type="button"
              className="secondary"
              disabled={state.tradeBusy || !row.mint}
              onClick={() => void tradeSelected(row, "sell")}
            >
              Sell {state.sellPct || "0"}%
            </button>
          </div>
          {state.tradeMessage ? (
            <div className="pill ok">{state.tradeMessage}</div>
          ) : null}
          {state.tradeError ? (
            <div className="pill bad">{state.tradeError}</div>
          ) : null}
        </div>

        <div className="terminal-v10-panel">
          <div className="row between">
            <h3>Holders</h3>
            <span className="muted small">
              {state.holdersMint === row.mint
                ? state.holdersMessage
                : "Click refresh holders"}
            </span>
          </div>
          {state.holdersError ? (
            <div className="pill bad">{state.holdersError}</div>
          ) : null}
          {holders.length ? (
            <table className="terminal-v10-holders">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Owner</th>
                  <th>Amount</th>
                  <th>%</th>
                </tr>
              </thead>
              <tbody>
                {holders.slice(0, 20).map((holder, index) => (
                  <tr>
                    <td>{index + 1}</td>
                    <td className="code">
                      {short(holder.owner ?? holder.tokenAccount, 5, 5)}
                    </td>
                    <td>
                      {holder.uiAmount ??
                        holder.amountUi ??
                        holder.amount ??
                        "—"}
                    </td>
                    <td>
                      {numberValue(holder.pctSupply ?? holder.percent) == null
                        ? "—"
                        : `${numberValue(holder.pctSupply ?? holder.percent)!.toFixed(2)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">
              {state.holdersMint === row.mint
                ? (state.holdersMessage ?? "No holders loaded.")
                : "Holder lookup is on demand."}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function logPayload(entry: ClientMeasureEntry): unknown {
  return entry.error ?? entry.summary ?? {};
}

function nestedErrorMessage(value: unknown, depth = 0): string | null {
  if (value == null || depth > 5) {
    return null;
  }

  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === "string") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = nestedErrorMessage(item, depth + 1);

      if (found) {
        return found;
      }
    }

    return null;
  }

  if (typeof value === "object") {
    const row = value as Record<string, unknown>;

    const direct = row.error ?? (row.name === "Error" ? row.message : null);

    if (typeof direct === "string" && direct.trim()) {
      return direct.trim();
    }

    if (direct && typeof direct === "object") {
      const nested = nestedErrorMessage(direct, depth + 1);

      if (nested) {
        return nested;
      }
    }

    for (const item of Object.values(row)) {
      const found = nestedErrorMessage(item, depth + 1);

      if (found) {
        return found;
      }
    }
  }

  return null;
}

function logErrorMessage(entry: ClientMeasureEntry): string | null {
  if (entry.error) {
    return nestedErrorMessage(entry.error) ?? String(entry.error);
  }

  return nestedErrorMessage(entry.summary);
}

function logStatus(entry: ClientMeasureEntry): "ok" | "error" {
  return entry.status === "error" || logErrorMessage(entry) ? "error" : "ok";
}

function friendlyLogLabel(entry: ClientMeasureEntry): string {
  const error = logErrorMessage(entry);

  if (error?.includes("insertBefore")) {
    return "Terminal render error";
  }

  let label = String(entry.label ?? "Terminal activity")
    .replace(/^solard:web:terminal-direct(?::[a-z0-9_-]+)?/i, "")
    .replace(/^[:\s-]+/, "")
    .trim();

  if (!label || /^[a-z]{1,3}$/i.test(label)) {
    label = error ? "Terminal error" : "Terminal activity";
  }

  return label
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayedLogs(): ClientMeasureEntry[] {
  const recent = state.logs.slice(0, 40);

  if (
    !state.selectedLogId ||
    recent.some((entry) => entry.id === state.selectedLogId)
  ) {
    return recent;
  }

  const selected = state.logs.find((entry) => entry.id === state.selectedLogId);

  return selected ? [selected, ...recent] : recent;
}

function selectLog(entry: ClientMeasureEntry): void {
  state.selectedLogId = entry.id;

  state.copiedLogId = null;

  rerender();
}

function closeLog(): void {
  state.selectedLogId = null;

  state.copiedLogId = null;

  rerender();
}

async function copyLog(
  entry: ClientMeasureEntry,
  errorOnly = false,
): Promise<void> {
  const error = logErrorMessage(entry);

  const text =
    errorOnly && error
      ? error
      : JSON.stringify(
          {
            status: logStatus(entry),

            label: friendlyLogLabel(entry),

            tookMs: entry.tookMs,

            at: new Date(entry.atMs).toISOString(),

            error,

            details: logPayload(entry),
          },
          null,
          2,
        );

  try {
    await navigator.clipboard.writeText(text);

    state.copiedLogId = entry.id;
  } catch {
    const textarea = document.createElement("textarea");

    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";

    document.body.appendChild(textarea);

    textarea.select();

    document.execCommand("copy");

    textarea.remove();

    state.copiedLogId = entry.id;
  }

  rerender();
}

function LogsPanel() {
  if (!state.showLogs) {
    return null;
  }

  const entries = displayedLogs();

  return (
    <section className="terminal-v10-logs">
      <div className="terminal-v10-logs-head">
        <div>
          <b>Activity log</b>

          <span className="muted small">
            {state.logs.length} recent events · select an entry to inspect or
            copy it
          </span>
        </div>

        <div className="terminal-v10-links">
          <button
            type="button"
            className="secondary compact"
            onClick={() => {
              clearClientMeasureEntries();

              state.logs = [];

              state.selectedLogId = null;

              state.copiedLogId = null;

              rerender();
            }}
          >
            Clear
          </button>

          <button
            type="button"
            className="secondary compact"
            onClick={() => {
              state.showLogs = false;

              storageSet("solard:terminal-show-logs", "0");

              rerender();
            }}
          >
            Hide activity
          </button>
        </div>
      </div>

      <div className="terminal-v10-log-rows">
        {entries.map((entry) => {
          const status = logStatus(entry);

          const error = logErrorMessage(entry);

          const selected = state.selectedLogId === entry.id;

          return (
            <details
              className={`terminal-v10-log-row ${status} ${selected ? "selected" : ""}`}
              data-log-id={entry.id}
              open={selected}
            >
              <summary
                onClick={(event: any) => {
                  event.preventDefault();

                  selectLog(entry);
                }}
              >
                <span>{status}</span>

                <span>
                  {entry.tookMs.toFixed(1)}
                  ms
                </span>

                <b>{friendlyLogLabel(entry)}</b>

                <small>{new Date(entry.atMs).toLocaleTimeString()}</small>
              </summary>

              {selected ? (
                <div className="terminal-v10-log-detail">
                  {error ? <div className="pill bad">{error}</div> : null}

                  <pre>{JSON.stringify(logPayload(entry), null, 2)}</pre>

                  <div className="terminal-v10-links">
                    {error ? (
                      <button
                        type="button"
                        className="secondary compact"
                        onClick={() => void copyLog(entry, true)}
                      >
                        Copy error
                      </button>
                    ) : null}

                    <button
                      type="button"
                      className="secondary compact"
                      onClick={() => void copyLog(entry)}
                    >
                      Copy details
                    </button>

                    <button
                      type="button"
                      className="secondary compact"
                      onClick={closeLog}
                    >
                      Close
                    </button>

                    {state.copiedLogId === entry.id ? (
                      <span className="pill ok">Copied</span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </details>
          );
        })}
      </div>
    </section>
  );
}

function processData(row: AnyRow | null | undefined): AnyRow {
  if (!row) return {};

  if (row.data && typeof row.data === "object") {
    return row.data;
  }

  try {
    const parsed = JSON.parse(String(row.dataJson ?? "{}"));

    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function TerminalPage() {
  const rows = visibleRows();
  const selected = selectedRow(rows);
  const processes = Array.isArray(state.health?.processes)
    ? state.health!.processes!
    : [];
  const stale = processes.filter((row) => row.stale || row.error).length;

  const indexerProcess =
    processes.find((row: AnyRow) =>
      String(row.name ?? "").includes("indexer"),
    ) ?? null;

  const indexer =
    state.health?.indexer && typeof state.health.indexer === "object"
      ? state.health.indexer
      : processData(indexerProcess);

  const hasIndexerDiagnostics = [
    indexer.messages,
    indexer.recognizedEventLines,
    indexer.parsedTrades,
    indexer.unknownEventLines,
    indexer.eventParseErrors,
  ].some((value) => value != null);

  const pricedRows = state.rows.filter((row) => latestMcap(row) != null).length;

  return (
    <div className="terminal-v10">
      <section className="terminal-v10-top">
        <div className="terminal-v10-title">
          <h2>Pump</h2>
          <span className="muted small">feed={state.status}</span>
          <span className="muted small">
            rows={rows.length}/{state.rows.length} · raw=
            {state.feedMeta?.count ?? "?"} · poll=
            {state.lastPollAtMs ? age(state.lastPollAtMs) : "never"} · every=
            {pollMs()}ms
          </span>
        </div>
        <div className="terminal-v10-actions">
          <button
            type="button"
            className="secondary compact"
            onClick={() => void reloadFeed({ includeHealth: true })}
          >
            Refresh
          </button>

          <button
            type="button"
            className="secondary compact"
            disabled={state.resetBusy}
            onClick={() => void resetFeed()}
          >
            {state.resetBusy ? "Resetting…" : "Reset feed"}
          </button>

          <a className="secondary compact button" href="/system">
            System logs
          </a>

          <button
            type="button"
            className="secondary compact"
            onClick={restartWorkers}
          >
            Restart workers
          </button>
          <button
            type="button"
            className="secondary compact"
            onClick={() => {
              state.showLogs = !state.showLogs;
              storageSet(
                "solard:terminal-show-logs",
                state.showLogs ? "1" : "0",
              );
              rerender();
            }}
          >
            {state.showLogs ? "Hide activity" : "Show activity"}
          </button>
        </div>
      </section>

      {state.error ? <div className="pill bad">{state.error}</div> : null}

      {state.resetMessage ? (
        <div className="pill ok">{state.resetMessage}</div>
      ) : null}

      <section className="terminal-v10-controls">
        <input
          data-terminal-focus="filter"
          placeholder="filter symbol, mint, creator"
          value={state.filter}
          onInput={(event: any) => setFilter(event.currentTarget.value)}
        />
        <button
          type="button"
          className={`terminal-v10-toggle ${state.hideMayhem ? "active" : ""}`}
          onClick={() => toggleHide("hideMayhem", "solwal:pump-hide-mayhem")}
        >
          {state.hideMayhem ? "Mayhem hidden" : "Hide mayhem"}
        </button>
        <button
          type="button"
          className={`terminal-v10-toggle ${state.hideUsdc ? "active" : ""}`}
          onClick={() => toggleHide("hideUsdc", "solwal:pump-hide-usdc")}
        >
          Hide USDC
        </button>
        <button
          type="button"
          className={`terminal-v10-sort ${state.sort.startsWith("created") ? "active" : ""}`}
          onClick={() => setSort("created")}
        >
          Created {sortMark("created")}
        </button>
      </section>

      {(state.health as AnyRow | null)?.status !== "ok" ? (
        <section className="terminal-v10-health">
          <b>System {(state.health as AnyRow | null)?.status ?? "checking"}</b>

          {(state.health as AnyRow | null)?.indexerError ? (
            <span className="pill bad">
              {(state.health as AnyRow).indexerError}
            </span>
          ) : null}

          <a className="secondary compact button" href="/system">
            Open system status and logs
          </a>
        </section>
      ) : null}

      <section className="terminal-v10-table-card">
        <div className="terminal-v10-table-wrap">
          <table className="terminal-v10-table">
            <thead>
              <tr>
                <th className="terminal-v10-pin-col">Pin</th>
                <th>Token</th>
                <th>
                  <SortButton base="mcap" label="MCap" />
                </th>
                <th>
                  <SortButton base="sma1m" label="SMA 1m" />
                </th>
                <th>
                  <SortButton base="sma5m" label="SMA 5m" />
                </th>
                <th>
                  <SortButton base="sma15m" label="SMA 15m" />
                </th>
                <th>
                  <SortButton base="trades" label="Trades 15m" />
                </th>
                <th>
                  <SortButton base="trades1m" label="Trades 1m" />
                </th>
                <th>
                  <SortButton base="volume1m" label="Vol 1m" />
                </th>
                <th>
                  <SortButton base="created" label="Created" />
                </th>
                <th>
                  <SortButton base="lastTrade" label="Last trade" />
                </th>
                <th>Mint</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <TokenRow
                  row={row}
                  selected={selected ? rowKey(row) === rowKey(selected) : false}
                />
              ))}
            </tbody>
          </table>
          {!rows.length ? (
            <div className="terminal-v10-empty">
              No rows in the live window yet. The route no longer full-scans
              history during polling.
            </div>
          ) : null}
        </div>
      </section>

      <SelectedToken row={selected} />
      <LogsPanel />
    </div>
  );
}

export default function mount() {
  unmounted = false;
  state.logs = getClientMeasureEntries();
  unsubscribeLogs = subscribeClientMeasure(() => {
    state.logs = getClientMeasureEntries();

    if (logRefreshTimer != null) {
      return;
    }

    logRefreshTimer = setTimeout(() => {
      logRefreshTimer = null;

      rerender();
    }, 250);
  });
  measureEvent(SCOPE, "mount", { path: window.location.pathname });
  rerender();
  void loadWallets();
  void reloadFeed({ includeHealth: true, scheduleNext: true });

  return () => {
    measureEvent(SCOPE, "unmount", { path: window.location.pathname });
    unmounted = true;

    if (renderFrame != null) {
      cancelAnimationFrame(renderFrame);

      renderFrame = null;
    }

    clearPollTimer();
    pollInFlight = false;
    unsubscribeLogs?.();
    unsubscribeLogs = null;

    if (logRefreshTimer != null) {
      clearTimeout(logRefreshTimer);

      logRefreshTimer = null;
    }
  };
}
