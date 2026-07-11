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

type SortKey =
  | "newest"
  | "mcap-desc"
  | "mcap-asc"
  | "sma1m-desc"
  | "sma1m-asc"
  | "sma5m-desc"
  | "sma5m-asc"
  | "sma15m-desc"
  | "sma15m-asc";

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
  sort: (storageGet("solwal:pump-feed-sort", "newest") as SortKey) || "newest",
  selectedKey: storageGet("solard:terminal-inspector-key", "") || null,
  pinned: storageJson<string[]>("solard:terminal-pinned-mints", []).filter(
    (x) => typeof x === "string",
  ),
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
};

let unmounted = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollInFlight = false;
let unsubscribeLogs: (() => void) | null = null;

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

let renderQueued = false;
let renderAgain = false;

function renderTerminalPage(): void {
  let root = rootElement();

  try {
    /**
     * Terminal owns its renderer directly. Never remove children from a root
     * already tracked by TradJS because that leaves the stored fiber tree
     * pointing at detached nodes. Sequential reconciliation also avoids keyed
     * row moves while Newest/mcap sorting changes table order every second.
     */
    render(<TerminalPage />, root, {
      reconciler: "sequential",
    });
  } catch (error) {
    if (
      error instanceof DOMException &&
      error.name === "NotFoundError" &&
      root.parentNode
    ) {
      /**
       * Recover only from a root that was already corrupted by an older page
       * build. Replacing the root element gives TradJS a new untracked mount
       * target without mutating children behind its reconciler.
       */
      const replacement = root.cloneNode(false) as HTMLElement;

      root.parentNode.replaceChild(replacement, root);

      root = replacement;

      render(<TerminalPage />, root, {
        reconciler: "sequential",
      });

      measureEvent(SCOPE, "recovered terminal render root", {
        error: error.message,
      });

      return;
    }

    throw error;
  }

  document
    .querySelectorAll<HTMLAnchorElement>("#main-nav a")
    .forEach((link) =>
      link.classList.toggle("active", link.dataset.page === "terminal"),
    );
}

function rerender(): void {
  if (unmounted) return;

  if (renderQueued) {
    renderAgain = true;
    return;
  }

  renderQueued = true;

  queueMicrotask(() => {
    try {
      do {
        renderAgain = false;

        if (!unmounted) {
          renderTerminalPage();
        }
      } while (renderAgain && !unmounted);
    } catch (error) {
      state.status = "error";
      state.error = error instanceof Error ? error.message : String(error);

      console.error("[solard:terminal] render failed", error);
    } finally {
      renderQueued = false;

      if (renderAgain && !unmounted) {
        rerender();
      }
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
    numberValue((row as any)?.lastMarketCapUsd) ??
    numberValue(row?.marketCapSol) ??
    numberValue((row as any)?.lastMarketCapSol) ??
    numberValue(row?.initialMarketCapUsd) ??
    numberValue(row?.initialMarketCapSol)
  );
}

function latestTime(row: PumpFeedRow): number {
  return Math.max(
    Number(row.lastTradeAtMs ?? 0),
    Number((row as any).priceUpdatedAtMs ?? 0),
    Number(row.updatedAtMs ?? 0),
    Number(row.createdAtMs ?? 0),
  );
}

function isMayhem(row: PumpFeedRow): boolean {
  const value = row.isMayhemMode ?? row.raw?.isMayhemMode;
  return value === true || value === 1 || value === "1" || value === "true";
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
  if (state.hideMayhem && isMayhem(row)) return false;
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

function sortValue(row: PumpFeedRow): number {
  if (state.sort.startsWith("mcap")) return latestMcap(row) ?? -Infinity;
  if (state.sort.startsWith("sma1m"))
    return numberValue(row.sma1m) ?? -Infinity;
  if (state.sort.startsWith("sma5m"))
    return numberValue(row.sma5m) ?? -Infinity;
  if (state.sort.startsWith("sma15m"))
    return numberValue(row.sma15m) ?? -Infinity;
  return latestTime(row);
}

function visibleRows(): PumpFeedRow[] {
  return state.rows.filter(passesFilters).sort((a, b) => {
    if (isPinned(a) !== isPinned(b)) return isPinned(a) ? -1 : 1;
    const dir = state.sort.endsWith("-asc") ? 1 : -1;
    const av = sortValue(a);
    const bv = sortValue(b);
    if (av !== bv) return (av - bv) * dir;
    return latestTime(b) - latestTime(a);
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

function setSort(base: "mcap" | "sma1m" | "sma5m" | "sma15m"): void {
  const desc = `${base}-desc` as SortKey;
  state.sort = state.sort === desc ? (`${base}-asc` as SortKey) : desc;
  storageSet("solwal:pump-feed-sort", state.sort);
  measureEvent(SCOPE, "sort", { sort: state.sort });
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
  rerender();

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
    isMayhemMode:
      typeof row.isMayhemMode === "boolean" ? row.isMayhemMode : null,
    quoteAsset: row.quoteAsset ?? null,
    quoteMint: row.quoteMint ?? null,
  };
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

function linksFor(row: PumpFeedRow): Array<{ label: string; href: string }> {
  const links: Array<{ label: string; href: string }> = [];
  if (row.mint) {
    links.push({
      label: "solscan",
      href: `https://solscan.io/token/${row.mint}`,
    });
    links.push({ label: "pump", href: `https://pump.fun/${row.mint}` });
  }
  for (const [label, value] of [
    ["site", row.website],
    ["x", row.twitter],
    ["tg", row.telegram],
  ] as Array<[string, unknown]>) {
    const href = typeof value === "string" ? value.trim() : "";
    if (href.startsWith("http")) links.push({ label, href });
  }
  return links;
}

function SortButton({
  base,
  label,
}: {
  base: "mcap" | "sma1m" | "sma5m" | "sma15m";
  label: string;
}) {
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
      <td className="terminal-v10-num">{row.tradeCount ?? "—"}</td>
      <td>
        <div className="terminal-v10-small">{age(latestTime(row))}</div>
        <div className="terminal-v10-small">{short(row.mint, 4, 4)}</div>
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
      </div>

      <div className="terminal-v10-selected-grid">
        <div className="terminal-v10-panel">
          <h3>Trade</h3>
          <div className="terminal-v10-trade-form">
            <select
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
              value={state.buySol}
              placeholder="Buy SOL"
              onInput={(event: any) =>
                updateTradeField("buySol", event.currentTarget.value)
              }
            />
            <input
              value={state.sellPct}
              placeholder="Sell %"
              onInput={(event: any) =>
                updateTradeField("sellPct", event.currentTarget.value)
              }
            />
            <input
              value={state.slippageBps}
              placeholder="Slippage bps"
              onInput={(event: any) =>
                updateTradeField("slippageBps", event.currentTarget.value)
              }
            />
          </div>
          <div className="terminal-v10-trade-form">
            <select
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

function LogsPanel() {
  if (!state.showLogs) return null;
  return (
    <section className="terminal-v10-logs">
      <div className="terminal-v10-logs-head">
        <div>
          <b>Browser measure-fn</b>
          <span className="muted small">
            {state.logs.length} events · also in DevTools console
          </span>
        </div>
        <div className="terminal-v10-links">
          <button
            type="button"
            className="secondary compact"
            onClick={() => {
              clearClientMeasureEntries();
              state.logs = [];
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
            Hide logs
          </button>
        </div>
      </div>
      <div className="terminal-v10-log-rows">
        {state.logs.slice(0, 40).map((entry) => (
          <details
            className={`terminal-v10-log-row ${entry.status}`}
            key={entry.id}
          >
            <summary>
              <span>{entry.status}</span>
              <span>{entry.tookMs.toFixed(1)}ms</span>
              <b>{entry.label}</b>
              <small>{new Date(entry.atMs).toLocaleTimeString()}</small>
            </summary>
            <pre>
              {JSON.stringify(entry.error ?? entry.summary ?? {}, null, 2)}
            </pre>
          </details>
        ))}
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

  return (
    <div className="terminal-v10">
      <section className="terminal-v10-top">
        <div className="terminal-v10-title">
          <h2>Pump</h2>
          <span
            className={`pill ${state.status === "live" ? "ok" : state.status === "error" ? "bad" : "warn"}`}
          >
            {state.status}
          </span>
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
            {state.showLogs ? "Hide logs" : "Show logs"}
          </button>
        </div>
      </section>

      {state.error ? <div className="pill bad">{state.error}</div> : null}

      <section className="terminal-v10-controls">
        <input
          placeholder="filter symbol, mint, creator"
          value={state.filter}
          onInput={(event: any) => setFilter(event.currentTarget.value)}
        />
        <button
          type="button"
          className={`terminal-v10-toggle ${state.hideMayhem ? "active" : ""}`}
          onClick={() => toggleHide("hideMayhem", "solwal:pump-hide-mayhem")}
        >
          Hide mayhem
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
          className={`terminal-v10-sort ${state.sort === "newest" ? "active" : ""}`}
          onClick={() => {
            state.sort = "newest";
            storageSet("solwal:pump-feed-sort", state.sort);
            measureEvent(SCOPE, "sort", { sort: state.sort });
            rerender();
          }}
        >
          Newest
        </button>
      </section>

      <section className="terminal-v10-health">
        <b>Terminal health</b>
        <span
          className={`pill ${state.health?.ok === true && stale === 0 ? "ok" : "warn"}`}
        >
          {state.health?.ok === true && stale === 0 ? "ok" : "check"}
        </span>
        <span className="muted small">
          tokens={state.health?.store?.tokens ?? "?"} · priced=
          {state.health?.store?.pricedTokens ?? "?"} · trades=
          {state.health?.store?.trades ?? "?"} · stale={stale}
        </span>
        <span className="muted small">
          ws={indexer.messages ?? "?"} · events=
          {indexer.recognizedEventLines ?? "?"} · parsed-trades=
          {indexer.parsedTrades ?? "?"} · unknown=
          {indexer.unknownEventLines ?? "?"} · parse-errors=
          {indexer.eventParseErrors ?? "?"}
        </span>
      </section>

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
                <th>Trades</th>
                <th>Age / Mint</th>
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
    rerender();
  });
  measureEvent(SCOPE, "mount", { path: window.location.pathname });
  rerender();
  void loadWallets();
  void reloadFeed({ includeHealth: true, scheduleNext: true });

  return () => {
    measureEvent(SCOPE, "unmount", { path: window.location.pathname });
    unmounted = true;
    clearPollTimer();
    pollInFlight = false;
    unsubscribeLogs?.();
    unsubscribeLogs = null;
  };
}
