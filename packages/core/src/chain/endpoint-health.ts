/** Endpoint failure classification plus a cross-process "dead key" registry.
 *
 * A 429 means two different things at Helius-style providers:
 *  - too many requests this second: retry the same key in ~1s
 *  - "max usage reached": the key's monthly credits are gone; skip it for every process
 * Dead marks are stored in ~/.solard/rpc-health.json (SLRD_RPC_HEALTH_FILE overrides,
 * "off" disables) and expire after DEAD_RECHECK_MS so a renewed key comes back on its own. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { rpcEndpointIdentity } from "./rpc-scheduler.ts";

export type EndpointFailure = "ok" | "rate" | "exhausted" | "auth" | "server";
/** Monthly quotas do not come back in minutes: one probe a day per dead key. Override: SLRD_RPC_DEAD_RECHECK_MS. */
export const DEAD_RECHECK_MS = Math.max(60_000, Number(process.env.SLRD_RPC_DEAD_RECHECK_MS) || 24 * 3_600_000);

const EXHAUSTED = /max(?:imum)? usage reached|credits? (?:exhausted|depleted)|out of credits|quota exceeded|monthly (?:limit|quota)/i;
const AUTH = /unauthori[sz]ed|forbidden|invalid api.?key|api.?key.*(?:expired|disabled|invalid)/i;
const RATE = /rate limit|too many requests/i;

export async function classifyEndpointResponse(response: Response): Promise<EndpointFailure> {
  let message = "";
  if (response.status !== 200 || response.headers.get("content-type")?.includes("json")) {
    try {
      const text = await response.clone().text();
      try { const p = JSON.parse(text); message = String(p?.error?.message ?? p?.message ?? p?.error ?? text); }
      catch { message = text; }
    } catch {}
  }
  if (EXHAUSTED.test(message)) return "exhausted";
  if (response.status === 401 || response.status === 403 || AUTH.test(message)) return "auth";
  if (response.status === 429 || RATE.test(message)) return "rate";
  if (response.status >= 500) return "server";
  return "ok";
}

type Mark = { state: "exhausted" | "auth"; until: number; endpoint: string; reason: string; at: number };
export function rpcHealthPath(): string | undefined {
  const v = process.env.SLRD_RPC_HEALTH_FILE;
  if (v !== undefined) return v.trim() && !/^(off|0|false|none)$/i.test(v.trim()) ? v : undefined;
  if (process.env.NODE_ENV === "test") return undefined;
  return join(homedir(), ".solard", "rpc-health.json");
}
let cache: { path: string; at: number; marks: Record<string, Mark> } | null = null;
const memory: Record<string, Mark> = {};
function readMarks(): Record<string, Mark> {
  const path = rpcHealthPath();
  if (!path) return memory;
  if (cache && cache.path === path && Date.now() - cache.at < 2_000) return cache.marks;
  let marks: Record<string, Mark> = {};
  try { if (existsSync(path)) marks = JSON.parse(readFileSync(path, "utf8")); } catch {}
  cache = { path, at: Date.now(), marks };
  return marks;
}
/** Skip this URL in every process until the mark expires. */
export function markEndpointDead(url: string, state: Mark["state"], endpoint: string, reason: string, now = Date.now()) {
  const id = rpcEndpointIdentity(url);
  const path = rpcHealthPath();
  if (!path) { memory[id] = { state, until: now + DEAD_RECHECK_MS, endpoint, reason, at: now }; return; }
  const marks = { ...readMarks() };
  for (const [key, mark] of Object.entries(marks)) if (mark.until <= now) delete marks[key];
  marks[id] = { state, until: now + DEAD_RECHECK_MS, endpoint, reason: reason.slice(0, 200), at: now };
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(marks, null, 1)); renameSync(tmp, path);
  } catch {}
  cache = { path, at: now, marks };
}
export function endpointDead(url: string, now = Date.now()): Mark | null {
  const mark = readMarks()[rpcEndpointIdentity(url)];
  return mark && mark.until > now ? mark : null;
}
export function clearEndpointMark(url: string) {
  const id = rpcEndpointIdentity(url), marks = readMarks();
  if (!marks[id]) return;
  delete marks[id];
  const path = rpcHealthPath();
  if (path) try { const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(marks, null, 1)); renameSync(tmp, path); } catch {}
}
/** Test helper: forget every mark kept in this process. */
export function resetEndpointMarks() { for (const key of Object.keys(memory)) delete memory[key]; cache = null; }
/** Short cooldown for "too fast"; the shared rate window does the real pacing. */
export function rateCooldownMs(consecutive: number, retryAfterMs = 0) {
  return Math.max(retryAfterMs, Math.min(8_000, 1_000 * 2 ** Math.max(0, Math.min(3, consecutive - 1))));
}
