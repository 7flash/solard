import type { Sowl } from "../sdk/sowl.js";

export type SignalDirection = "buy" | "sell" | "watch" | "unknown";
export type SignalSourceKind = "telegram" | "manual";

export type TelegramSignalSource = {
  id: string;
  kind: SignalSourceKind;
  name: string;
  chatRef?: string | null;
  isActive: boolean;
  createdAtMs: number;
  updatedAtMs: number;
};

export type TelegramSignal = {
  id: string;
  sourceId: string | null;
  sourceName: string | null;
  receivedAtMs: number;
  direction: SignalDirection;
  confidence: number;
  text: string;
  mints: string[];
  symbols: string[];
  urls: string[];
  amountSol: string | null;
  status: "new" | "watched" | "ignored" | "traded";
  notes?: string | null;
  raw?: Record<string, unknown> | null;
};

export type TelegramSignalsState = {
  version: 1;
  sources: TelegramSignalSource[];
  signals: TelegramSignal[];
};

const SETTINGS_KEY = "signals:telegram:v1";
const MAX_SIGNALS = 2_000;
const SOLANA_MINT_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const URL_RE = /https?:\/\/[^\s)\]}>'"]+/gi;
const SYMBOL_RE = /\$[A-Za-z][A-Za-z0-9_]{1,20}\b/g;
const AMOUNT_RE =
  /(?:buy|ape|entry|amount|size)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:sol|◎)\b/i;

function now(): number {
  return Date.now();
}
function stableId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

function cleanList(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))];
}

function readState(sowl: Sowl): TelegramSignalsState {
  const row = sowl.db.settings.select().where({ key: SETTINGS_KEY }).first() as
    { value?: string } | undefined;
  if (!row?.value) return { version: 1, sources: [], signals: [] };
  try {
    const parsed = JSON.parse(row.value) as Partial<TelegramSignalsState>;
    return {
      version: 1,
      sources: Array.isArray(parsed.sources)
        ? (parsed.sources as TelegramSignalSource[])
        : [],
      signals: Array.isArray(parsed.signals)
        ? (parsed.signals as TelegramSignal[])
        : [],
    };
  } catch {
    return { version: 1, sources: [], signals: [] };
  }
}

function writeState(
  sowl: Sowl,
  state: TelegramSignalsState,
): TelegramSignalsState {
  const value = JSON.stringify({
    ...state,
    signals: state.signals.slice(0, MAX_SIGNALS),
  });
  const existing = sowl.db.settings
    .select()
    .where({ key: SETTINGS_KEY })
    .first() as { value?: string; updatedAtMs?: number } | undefined;
  if (existing) {
    existing.value = value;
    existing.updatedAtMs = now();
  } else {
    sowl.db.settings.insert({ key: SETTINGS_KEY, value, updatedAtMs: now() });
  }
  return readState(sowl);
}

export function listTelegramSignals(sowl: Sowl): TelegramSignalsState {
  return readState(sowl);
}

export function upsertTelegramSignalSource(
  sowl: Sowl,
  input: {
    id?: string;
    name: string;
    chatRef?: string | null;
    kind?: SignalSourceKind;
    isActive?: boolean;
  },
): TelegramSignalsState {
  const state = readState(sowl);
  const id = input.id?.trim() || stableId("tgsrc");
  const existing = state.sources.find(
    (source) =>
      source.id === id ||
      source.name.toLowerCase() === input.name.trim().toLowerCase(),
  );
  const timestamp = now();
  if (existing) {
    existing.name = input.name.trim();
    existing.chatRef = input.chatRef?.trim() || null;
    existing.kind = input.kind ?? existing.kind;
    existing.isActive = input.isActive ?? existing.isActive;
    existing.updatedAtMs = timestamp;
  } else {
    state.sources.push({
      id,
      kind: input.kind ?? "telegram",
      name: input.name.trim(),
      chatRef: input.chatRef?.trim() || null,
      isActive: input.isActive ?? true,
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
    });
  }
  return writeState(sowl, state);
}

export function deleteTelegramSignalSource(
  sowl: Sowl,
  id: string,
): TelegramSignalsState {
  const state = readState(sowl);
  state.sources = state.sources.filter((source) => source.id !== id);
  return writeState(sowl, state);
}

export function parseTelegramSignalText(
  text: string,
): Pick<
  TelegramSignal,
  "direction" | "confidence" | "mints" | "symbols" | "urls" | "amountSol"
> {
  const lower = text.toLowerCase();
  const direction: SignalDirection = /\b(sell|dump|exit|take profit|tp)\b/.test(
    lower,
  )
    ? "sell"
    : /\b(buy|ape|entry|long|call|gem|send|snipe)\b/.test(lower)
      ? "buy"
      : /\b(watch|monitor|track|wait)\b/.test(lower)
        ? "watch"
        : "unknown";
  const mints = cleanList(text.match(SOLANA_MINT_RE) ?? []);
  const urls = cleanList(text.match(URL_RE) ?? []);
  const symbols = cleanList(
    (text.match(SYMBOL_RE) ?? []).map((value) =>
      value.replace(/^\$/, "").toUpperCase(),
    ),
  );
  const amountSol = text.match(AMOUNT_RE)?.[1] ?? null;
  const confidence = Math.min(
    1,
    (mints.length ? 0.55 : 0) +
      (symbols.length ? 0.15 : 0) +
      (urls.length ? 0.15 : 0) +
      (direction !== "unknown" ? 0.15 : 0),
  );
  return { direction, confidence, mints, symbols, urls, amountSol };
}

export function ingestTelegramSignal(
  sowl: Sowl,
  input: {
    sourceId?: string | null;
    text: string;
    raw?: Record<string, unknown> | null;
  },
): { state: TelegramSignalsState; signal: TelegramSignal } {
  const state = readState(sowl);
  const source = input.sourceId
    ? (state.sources.find((item) => item.id === input.sourceId) ?? null)
    : null;
  const parsed = parseTelegramSignalText(input.text);
  const signal: TelegramSignal = {
    id: stableId("sig"),
    sourceId: source?.id ?? input.sourceId ?? null,
    sourceName: source?.name ?? null,
    receivedAtMs: now(),
    text: input.text,
    status: "new",
    raw: input.raw ?? null,
    ...parsed,
  };
  state.signals.unshift(signal);

  for (const mint of signal.mints) {
    try {
      sowl.tokens.upsert({
        mint,
        name: signal.symbols[0] ?? null,
        symbol: signal.symbols[0] ?? null,
        metadataJson: JSON.stringify({
          source: "telegram-signal",
          signalId: signal.id,
          urls: signal.urls,
          text: signal.text.slice(0, 500),
        }),
      });
    } catch {
      // Token upsert is best-effort; malformed addresses should not break signal capture.
    }
  }

  return { signal, state: writeState(sowl, state) };
}

export function updateTelegramSignalStatus(
  sowl: Sowl,
  input: {
    id: string;
    status: TelegramSignal["status"];
    notes?: string | null;
  },
): TelegramSignalsState {
  const state = readState(sowl);
  const signal = state.signals.find((item) => item.id === input.id);
  if (signal) {
    signal.status = input.status;
    signal.notes = input.notes ?? signal.notes ?? null;
  }
  return writeState(sowl, state);
}

export function clearTelegramSignals(sowl: Sowl): TelegramSignalsState {
  const state = readState(sowl);
  state.signals = [];
  return writeState(sowl, state);
}
