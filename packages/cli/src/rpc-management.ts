import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { createHash } from "crypto";

export type RpcEntry = { url: string; group: string; rps: number; concurrency: number };
export type RpcConfig = { version: 1; auto: boolean; http: RpcEntry[]; websocket: string[]; aggregateRps: number | null };
export function rpcConfigPath() { return process.env.SLRD_RPC_CONFIG_PATH ?? join(homedir(), ".solard", "rpc.json"); }
const empty = (): RpcConfig => ({ version: 1, auto: true, http: [], websocket: [], aggregateRps: null });
export function rpcUrl(raw: string, transport: "http" | "ws"): string {
  const u = new URL(raw);
  if (u.username || u.password || u.hash || !((transport === "http" ? ["http:","https:"] : ["ws:","wss:"]).includes(u.protocol)))
    throw new Error("Invalid RPC URL transport or URL contains userinfo/fragment");
  return u.toString();
}
export function safeUrl(raw: string) { try { const u = new URL(raw); return `${u.protocol}//${u.host}/***`; } catch { return "<invalid URL>"; } }
export function loadRpcConfig(): RpcConfig {
  let data: RpcConfig;
  try { data = JSON.parse(readFileSync(rpcConfigPath(), "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty(); throw new Error("Cannot read RPC configuration"); }
  if (data.version !== 1 || !Array.isArray(data.http) || !Array.isArray(data.websocket)) throw new Error("Invalid RPC configuration");
  for (const entry of data.http) {
    entry.url = rpcUrl(entry.url, "http");
    if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(entry.group) || !Number.isSafeInteger(entry.rps) || entry.rps < 1 ||
      !Number.isSafeInteger(entry.concurrency) || entry.concurrency < 1) throw new Error("Invalid RPC budget");
  }
  data.websocket = data.websocket.map(url => rpcUrl(url, "ws"));
  return data;
}
export function saveRpcConfig(config: RpcConfig) {
  const path = rpcConfigPath(); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}
export function effectiveRpc(flags: ReadonlyMap<string,string> = new Map()) {
  const saved = loadRpcConfig();
  const manual = flags.get("rpc-url") ?? process.env.RPC_ENDPOINT;
  let envUrls: string[] = [];
  if (process.env.SLRD_RPC_URLS) {
    const parsed: unknown = JSON.parse(process.env.SLRD_RPC_URLS);
    if (!Array.isArray(parsed) || !parsed.every(value => typeof value === "string")) throw new Error("SLRD_RPC_URLS must be an array");
    envUrls = parsed as string[];
  }
  const initial = [...(manual ? [manual] : []), ...envUrls, ...saved.http.map(e => e.url)];
  const http = [...new Set(initial.map(url => rpcUrl(url, "http")))];
  const wsEnv: unknown = process.env.SLRD_WS_URLS ? JSON.parse(process.env.SLRD_WS_URLS) : [];
  if (!Array.isArray(wsEnv) || !wsEnv.every(v => typeof v === "string")) throw new Error("Invalid SLRD_WS_URLS");
  const websocket = [...new Set([...(wsEnv as string[]), ...saved.websocket].map(url => rpcUrl(url, "ws")))];
  const enabledHttp = saved.auto ? http : http.slice(0,1);
  const limits: Record<string, { group: string; rps: number; concurrency: number }> = {};
  for (const entry of saved.http) {
    const identity = createHash("sha256").update(entry.url).digest("hex");
    limits[identity] = { group: entry.group, rps: entry.rps, concurrency: entry.concurrency };
  }
  return { saved, http: enabledHttp, websocket, limits, source: flags.has("rpc-url") ? "flag" : manual ? "environment" : envUrls.length ? "SLRD_RPC_URLS" : "file" };
}
export function activateRpc(flags: ReadonlyMap<string,string>) {
  const result = effectiveRpc(flags);
  if (result.http.length) { process.env.RPC_ENDPOINT = result.http[0]; process.env.SLRD_RPC_URLS = JSON.stringify(result.http); }
  process.env.SLRD_WS_URLS = JSON.stringify(result.websocket);
  process.env.SLRD_RPC_PROVIDER_LIMITS = JSON.stringify(result.limits);
  if (result.saved.aggregateRps !== null) process.env.SLRD_RPC_AGGREGATE_RPS = String(result.saved.aggregateRps);
  process.env.SLRD_RPC_VERIFY_MAINNET = "1";
  return result;
}
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export async function probeHttp(url: string) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 6500);
  const start = Date.now();
  const result = (state: string, reason: string) => ({ endpoint: safeUrl(url), state, reason, latencyMs: Date.now() - start });
  try {
    for (const method of ["getGenesisHash", "getBalance", "getAccountInfo"]) {
      const response = await fetch(url, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: method === "getGenesisHash" ? [] :
          method === "getBalance" ? ["11111111111111111111111111111111"] :
            ["11111111111111111111111111111111", { encoding: "base64" }] }) });
      if (!response.ok) return result("unavailable", `HTTP ${response.status}`);
      const body = await response.json() as { error?: { code?: number; message?: string }; result?: any };
      if (body.error) return result("unavailable", `RPC ${body.error.code ?? "error"}`);
      if (method === "getGenesisHash" && body.result !== GENESIS) return result("wrong-cluster", "Mainnet genesis mismatch");
      if (method === "getBalance" && (!Number.isFinite(body.result?.value) || !Number.isFinite(body.result?.context?.slot)))
        return result("unavailable", "Balance read missing");
      if (method === "getAccountInfo" && !Number.isFinite(body.result?.context?.slot))
        return result("unavailable", "Account read missing");
    }
    return result("healthy", "Mainnet and account reads verified");
  } catch { return result("unavailable", "Timeout or transport failure"); }
  finally { clearTimeout(timeout); }
}
export async function probeWs(url: string) {
  return await new Promise<{ endpoint: string; state: string; reason: string }>(resolve => {
    let socket: WebSocket | undefined, finished = false;
    function done(state: string, reason: string) {
      if (finished) return; finished = true; clearTimeout(timer);
      try { socket?.close(); } catch {} resolve({ endpoint: safeUrl(url), state, reason });
    }
    const timer = setTimeout(() => done("unavailable", "Subscription timeout"), 6500);
    try {
      socket = new WebSocket(url);
      socket.addEventListener("open", () => socket?.send(JSON.stringify({ jsonrpc: "2.0", id: 71, method: "slotSubscribe" })));
      socket.addEventListener("message", event => { try { const data = JSON.parse(String(event.data));
        if (data.id === 71) done(Number.isInteger(data.result) ? "healthy" : "unavailable", "Subscription ACK (not delivery guarantee)");
      } catch { done("unavailable", "Invalid WebSocket reply"); } });
      socket.addEventListener("error", () => done("unavailable", "WebSocket failure"));
      socket.addEventListener("close", () => done("unavailable", "Disconnected"));
    } catch { done("unavailable", "WebSocket construction failed"); }
  });
}
