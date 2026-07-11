export function short(value: unknown, left = 4, right = 4): string {
  const text = String(value ?? "");
  if (!text) return "—";
  if (text.length <= left + right + 3) return text;
  return `${text.slice(0, left)}…${text.slice(-right)}`;
}

export function solFromLamports(value: unknown): string {
  if (value == null || value === "") return "—";
  const text = String(value);
  if (!/^-?\d+$/.test(text)) return text;
  const whole = BigInt(text);
  const sign = whole < 0n ? "-" : "";
  const abs = whole < 0n ? -whole : whole;
  const int = abs / 1_000_000_000n;
  const frac = abs % 1_000_000_000n;
  const fracText = frac.toString().padStart(9, "0").replace(/0+$/, "");
  return `${sign}${int.toString()}${fracText ? `.${fracText}` : ""}`;
}

export function numberValue(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatMcap(value: unknown): string {
  const n = numberValue(value);
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(3)}`;
}

export function formatPrice(value: unknown): string {
  const n = numberValue(value);
  if (n == null) return "—";
  if (Math.abs(n) >= 1) return `$${n.toFixed(4)}`;
  return `$${n.toExponential(4)}`;
}

export function statusClass(status: unknown): string {
  const text = String(status ?? "").toLowerCase();
  if (
    [
      "ok",
      "done",
      "success",
      "succeeded",
      "confirmed",
      "complete",
      "completed",
    ].some((x) => text.includes(x))
  )
    return "ok";
  if (
    ["fail", "error", "rejected", "dropped", "bad"].some((x) =>
      text.includes(x),
    )
  )
    return "bad";
  if (
    [
      "pending",
      "running",
      "started",
      "retry",
      "queued",
      "processing",
      "planned",
      "broadcast",
    ].some((x) => text.includes(x))
  )
    return "warn";
  return "";
}

export function age(value: unknown, now = Date.now()): string {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const delta = Math.max(0, now - ms);
  if (delta < 1000) return "now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}
