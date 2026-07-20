import type {
  ProcessStatus,
  TerminalFeedRow,
  TerminalTrade,
} from "@solard/core/db.js";

export function short(
  value: string | null | undefined,
  left = 6,
  right = 4,
): string {
  if (!value) return "—";
  const text = String(value);
  return text.length <= left + right + 1
    ? text
    : `${text.slice(0, left)}…${text.slice(-right)}`;
}

export function compactUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  const abs = Math.abs(n);
  if (abs > 0 && abs < 0.000001) return `$${n.toExponential(2)}`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: abs >= 1000 ? "compact" : "standard",
    maximumFractionDigits: abs >= 1000 ? 1 : abs >= 1 ? 2 : 8,
  }).format(n);
}

export function formatAge(
  ms: number | null | undefined,
  now = Date.now(),
): string {
  if (!ms || !Number.isFinite(Number(ms))) return "—";
  const age = Math.max(0, now - Number(ms));
  if (age < 60_000) return `${Math.round(age / 1000)}s`;
  if (age < 3_600_000) return `${Math.round(age / 60_000)}m`;
  if (age < 86_400_000) return `${Math.round(age / 3_600_000)}h`;
  return `${Math.round(age / 86_400_000)}d`;
}

export function formatTerminalFeedRow(
  row: TerminalFeedRow,
  now = Date.now(),
): string {
  const kind = row.kind === "signal" ? "[SIGNAL]" : "[PUMP]";
  const symbol = row.symbol ? `$${row.symbol}` : row.name ? row.name : "$?";
  const updatedAtMs = Number(row.updatedAtMs || row.createdAtMs || 0);
  const parts = [
    kind.padEnd(8, " "),
    String(symbol).padEnd(14, " "),
    short(row.mint, 7, 7),
    `mcap=${compactUsd(row.marketCapUsd)}`,
    `sma1=${compactUsd(row.sma1m)}`,
    `sma5=${compactUsd(row.sma5m)}`,
    `sma15=${compactUsd(row.sma15m)}`,
    `trades=${row.tradeCount ?? 0}`,
    `age=${formatAge(updatedAtMs, now)}`,
  ];
  if (row.signalText)
    parts.push(`text=${JSON.stringify(row.signalText.slice(0, 96))}`);
  return parts.join("\t");
}

export function formatTerminalTradeRow(row: TerminalTrade): string {
  const side = String(row.side || "unknown").padEnd(4, " ");
  const sol = Number(row.solDeltaUi || 0).toLocaleString("en-US", {
    maximumFractionDigits: 6,
  });
  return [
    side,
    short(row.mint, 7, 7),
    `${sol} SOL`,
    `mcap=${compactUsd(row.marketCapUsd)}`,
    `price=${compactUsd(row.priceUsd)}`,
    `owner=${short(row.owner)}`,
    `sig=${short(row.signature, 8, 6)}`,
    row.confidence,
  ].join("\t");
}

export type RuntimeProcessStatus = ProcessStatus & {
  data?: Record<string, unknown>;
  ageMs?: number;
  stale?: boolean;
  managed?: boolean;
  bgrun?: Record<string, unknown> | null;
};

export function formatProcessRow(
  row: RuntimeProcessStatus,
  now = Date.now(),
): string {
  const age = formatAge(row.heartbeatAtMs, now);
  const state = row.stale ? "stale" : row.status || "unknown";
  const suffix = row.error
    ? ` error=${JSON.stringify(row.error).slice(0, 120)}`
    : "";
  return `${row.name}\t${row.kind}\t${state}\tage=${age}${suffix}`;
}

export function formatProcessSummary(
  rows: RuntimeProcessStatus[] | undefined,
): string {
  const list = rows ?? [];
  if (list.length === 0) return "workers=unknown";
  const stale = list.filter((row) => row.stale).length;
  const errors = list.filter(
    (row) => row.error || row.status === "error",
  ).length;
  if (errors > 0)
    return `workers=error/${errors} stale=${stale}/${list.length}`;
  if (stale > 0) return `workers=stale/${stale}/${list.length}`;
  return `workers=ok/${list.length}`;
}
