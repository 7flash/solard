import {
  followTerminalFeedAction,
  terminalFeedSnapshotAction,
} from "../actions/terminal.js";
import { followTradesAction } from "../actions/streams.js";
import {
  ensureProcessesAction,
  listProcessesAction,
  stopProcessAction,
} from "../actions/processes.js";
import {
  listTelegramSignals,
  terminalStoreStats,
} from "../db/terminal-store.js";

export type ParsedCli = {
  values: string[];
  flags: Map<string, string>;
};

function bool(
  flags: Map<string, string>,
  key: string,
  fallback = false,
): boolean {
  if (!flags.has(key)) return fallback;
  const value = flags.get(key);
  return value == null || value === "" || value === "true" || value === "1";
}

function int(
  flags: Map<string, string>,
  key: string,
  fallback: number,
): number {
  const value = flags.get(key);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key}: ${value}`);
  return parsed;
}

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function emit(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : json(value)}\n`);
}

export async function maybeRunWorkerCliCommand(
  parsed: ParsedCli,
): Promise<boolean> {
  const [cmd, sub, extra] = parsed.values;
  const flags = parsed.flags;
  const asJson = bool(flags, "json", false);

  if (cmd === "terminal" && sub === "feed") {
    if (bool(flags, "once", false) || asJson) {
      const snapshot = await terminalFeedSnapshotAction({
        limit: int(flags, "limit", 250),
        sinceMs: int(flags, "since-ms", 0),
      });
      if (asJson) emit(snapshot);
      else
        for (const row of snapshot.rows as any[])
          emit(
            `${row.symbol ? "$" + row.symbol : "$?"}\t${row.mint}\tmcap=${row.marketCapUsd ?? "—"}`,
          );
      return true;
    }
    await followTerminalFeedAction({
      pollMs: int(flags, "poll-ms", 1000),
      limit: int(flags, "limit", 250),
      once: false,
      json: asJson,
      telegram: bool(flags, "telegram", false),
    });
    return true;
  }

  if (cmd === "stream" && sub === "trades") {
    await followTradesAction({
      pollMs: int(flags, "poll-ms", 1000),
      limit: int(flags, "limit", 250),
      once: bool(flags, "once", false),
      json: asJson,
      mint: flags.get("mint") ?? null,
    });
    return true;
  }

  if (cmd === "workers" || cmd === "processes") {
    if (sub === "stop") {
      emit(stopProcessAction(extra ?? flags.get("worker") ?? ""));
      return true;
    }
    if (sub === "ensure" || sub === "start" || !sub) {
      const result = await ensureProcessesAction({
        worker: extra ?? flags.get("worker") ?? null,
        all: !extra && !flags.get("worker"),
        telegram: bool(flags, "telegram", false),
        restart: bool(flags, "restart", false),
      });
      emit(result);
      return true;
    }
    if (sub === "list" || sub === "status") {
      emit(listProcessesAction());
      return true;
    }
  }

  if (cmd === "signals" && sub === "telegram") {
    if (extra === "listen") {
      const result = await ensureProcessesAction({
        worker: "solard-telegram-signals",
        restart: bool(flags, "restart", false),
      });
      emit(result);
      return true;
    }
    if (extra === "list" || !extra) {
      emit({
        signals: listTelegramSignals(int(flags, "limit", 100)),
        stats: terminalStoreStats(),
      });
      return true;
    }
  }

  return false;
}
