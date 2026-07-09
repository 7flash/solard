import {
  followTerminalFeedAction,
  terminalFeedSnapshotAction,
} from "../actions/terminal.js";
import { followTradesAction } from "../actions/streams.js";
import {
  ensureProcessesAction,
  listProcessesAction,
  restartProcessesAction,
  stopProcessAction,
} from "../actions/processes.js";
import {
  listTelegramSignals,
  terminalStoreStats,
} from "../db/terminal-store.js";
import { formatProcessRow } from "../terminal/presenter.js";

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

function workerArg(
  extra: string | undefined,
  flags: Map<string, string>,
): string | null {
  return extra ?? flags.get("worker") ?? flags.get("name") ?? null;
}

function sourceArg(
  flags: Map<string, string>,
): "helius" | "pumpportal" | "both" | undefined {
  const text = String(
    flags.get("source") ??
      flags.get("provider") ??
      process.env.SOLARD_STREAM_SOURCE ??
      "helius",
  ).toLowerCase();
  if (text.includes("both")) return "both";
  if (text.includes("pump")) return "pumpportal";
  if (text.includes("helius")) return "helius";
  return "helius";
}

function printProcessTable(result: Record<string, unknown>): void {
  const workers = Array.isArray(result.workers)
    ? (result.workers as any[])
    : [];
  if (workers.length === 0) {
    emit(result);
    return;
  }
  for (const row of workers) emit(formatProcessRow(row));
}

export async function maybeRunWorkerCliCommand(
  parsed: ParsedCli,
): Promise<boolean> {
  const [cmd, sub, extra] = parsed.values;
  const flags = parsed.flags;
  const asJson = bool(flags, "json", false);

  if (cmd === "terminal" && sub === "feed") {
    if (
      bool(flags, "once", false) ||
      (asJson && !bool(flags, "follow", false))
    ) {
      const snapshot = await terminalFeedSnapshotAction({
        limit: int(flags, "limit", 250),
        sinceMs: int(flags, "since-ms", 0),
        source: sourceArg(flags),
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
      restartStale: !bool(flags, "no-restart-stale", false),
      source: sourceArg(flags),
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
      restart: bool(flags, "restart", false),
      source: sourceArg(flags),
    });
    return true;
  }

  if (cmd === "workers" || cmd === "processes") {
    if (sub === "list" || sub === "status" || !sub) {
      const result = listProcessesAction({
        telegram: bool(flags, "telegram", false),
        source: sourceArg(flags),
      });
      if (asJson) emit(result);
      else printProcessTable(result);
      return true;
    }
    if (sub === "ensure" || sub === "start" || sub === "up") {
      const result = await ensureProcessesAction({
        worker: workerArg(extra, flags),
        all: !workerArg(extra, flags),
        telegram: bool(flags, "telegram", false),
        source: sourceArg(flags),
        restart: bool(flags, "restart", false),
        restartStale: !bool(flags, "no-restart-stale", false),
      });
      emit(result);
      return true;
    }
    if (sub === "restart") {
      const result = await restartProcessesAction({
        worker: workerArg(extra, flags) ?? "all",
        telegram: bool(flags, "telegram", false),
        source: sourceArg(flags),
      });
      emit(result);
      return true;
    }
    if (sub === "stop" || sub === "down") {
      emit(
        stopProcessAction(workerArg(extra, flags) ?? "all", {
          telegram: bool(flags, "telegram", false),
          source: sourceArg(flags),
        }),
      );
      return true;
    }
  }

  if (
    cmd === "dev" &&
    ["up", "start", "restart", "stop", "down", "status"].includes(sub ?? "")
  ) {
    if (sub === "stop" || sub === "down") {
      emit(
        stopProcessAction("all", {
          telegram: bool(flags, "telegram", true),
          source: sourceArg(flags),
        }),
      );
      return true;
    }
    if (sub === "status") {
      const result = listProcessesAction({
        telegram: bool(flags, "telegram", true),
        source: sourceArg(flags),
      });
      if (asJson) emit(result);
      else printProcessTable(result);
      return true;
    }
    const result =
      sub === "restart"
        ? await restartProcessesAction({
            worker: "all",
            telegram: bool(flags, "telegram", true),
            source: sourceArg(flags),
          })
        : await ensureProcessesAction({
            worker: "all",
            telegram: bool(flags, "telegram", true),
            source: sourceArg(flags),
            restartStale: true,
          });
    emit(result);
    return true;
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
