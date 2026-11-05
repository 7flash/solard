/** Server-side access to the local slrd-bridge (token from .range-bots/bridge-token) and the page's access check. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..", "..");
export const bridgeToken = () => readFileSync(resolve(root, ".range-bots", "bridge-token"), "utf8").trim();
const bridgeUrl = `http://127.0.0.1:${process.env.SLRD_BRIDGE_PORT ?? 5174}`;

export async function bridge<T>(path: string): Promise<T> {
  const r = await fetch(bridgeUrl + path, { headers: { "x-slrd-token": bridgeToken() }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`bridge ${path}: HTTP ${r.status}`);
  return (await r.json()) as T;
}
export const readJson = <T,>(rel: string): T | null => { try { return JSON.parse(readFileSync(resolve(root, rel), "utf8")) as T; } catch { return null; } };

/** Cookie set by visiting /?key=<bridge token> once. */
export function authorized(req: Request) {
  const cookie = req.headers.get("cookie") ?? "";
  return cookie.split(/;\s*/).some(c => c === `slrd_web=${bridgeToken()}`);
}
