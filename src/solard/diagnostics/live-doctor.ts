import { initTerminalStore, insertTerminalProbeRow, listTerminalFeed, upsertProcessStatus } from "../db/terminal-store.js";
import { parsePumpLogs } from "../helius/pump-log-events.js";
import { parsePumpTransaction, PUMPFUN_PROGRAM_ID } from "../pump/pump-parser.js";
import { resolveSolUsd } from "../prices/sol-usd.js";
import { createMeasure, summarizeError, summarizeForMeasure } from "../measure.js";

const doctorMeasure = createMeasure("solard:doctor");

export type DoctorSource = "helius" | "pumpportal" | "both";

export type DoctorOptions = {
  source?: DoctorSource | string | null;
  seconds?: number | string | null;
  writeProbe?: boolean | string | null;
  sampleTransaction?: boolean | string | null;
};

type CheckResult = {
  ok: boolean;
  name: string;
  durationMs: number;
  data?: Record<string, unknown>;
  error?: unknown;
};

export type LiveDoctorResult = {
  ok: boolean;
  source: DoctorSource;
  seconds: number;
  startedAtMs: number;
  finishedAtMs: number;
  checks: CheckResult[];
  recommendation: string[];
};

function normalizeSource(value: unknown): DoctorSource {
  const raw = String(value ?? "helius").toLowerCase();
  if (raw.includes("both")) return "both";
  if (raw.includes("pump")) return "pumpportal";
  return "helius";
}

function numberOpt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function boolOpt(value: unknown, fallback = false): boolean {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const raw = String(value).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function redact(value: string): string {
  return value.replace(/(api-key|apiKey)=([^&]+)/gi, "$1=<redacted>").replace(/([?&]key=)([^&]+)/gi, "$1<redacted>");
}

function apiKeyFromUrl(url: string | null | undefined): string | null {
  const match = String(url ?? "").match(/[?&](?:api-key|apiKey)=([^&]+)/i);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function heliusRpcUrl(): string {
  const explicit = process.env.HELIUS_RPC_URL?.trim() || process.env.RPC_ENDPOINT?.trim() || process.env.SOLANA_RPC_URL?.trim();
  if (explicit) return explicit;
  const key = process.env.HELIUS_API_KEY?.trim();
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  throw new Error("Missing Helius RPC config. Set HELIUS_RPC_URL, RPC_ENDPOINT, SOLANA_RPC_URL, or HELIUS_API_KEY.");
}

export function heliusWsUrl(): string {
  const explicit = process.env.SOLARD_HELIUS_LOGS_WS_URL?.trim() || process.env.SOLARD_HELIUS_WS_URL?.trim() || process.env.HELIUS_WS_URL?.trim();
  if (explicit) return explicit;
  const rpc = process.env.HELIUS_RPC_URL?.trim() || process.env.RPC_ENDPOINT?.trim() || process.env.SOLANA_RPC_URL?.trim() || "";
  if (/^https:\/\//i.test(rpc) && /helius-rpc\.com/i.test(rpc)) return rpc.replace(/^https:/i, "wss:");
  if (/^http:\/\//i.test(rpc) && /helius-rpc\.com/i.test(rpc)) return rpc.replace(/^http:/i, "ws:");
  const key = process.env.HELIUS_API_KEY?.trim() || apiKeyFromUrl(rpc);
  if (key) return `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  throw new Error("Missing Helius WebSocket config. Set HELIUS_API_KEY, HELIUS_RPC_URL, SOLARD_HELIUS_WS_URL, or HELIUS_WS_URL.");
}

async function timed<T extends Record<string, unknown>>(name: string, fn: () => Promise<T>): Promise<CheckResult> {
  const start = Date.now();
  try {
    const data = await doctorMeasure.measure(
      {
        start: () => `doctor ${name}`,
        end: (result) => summarizeForMeasure(result),
        catch: (error) => ({ error: summarizeError(error) }),
      },
      fn,
    );
    return { ok: true, name, durationMs: Date.now() - start, data };
  } catch (error) {
    return { ok: false, name, durationMs: Date.now() - start, error: summarizeError(error) };
  }
}

async function rpc(method: string, params: unknown[], timeoutMs = 10_000): Promise<any> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(heliusRpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}: ${JSON.stringify(body)?.slice(0, 300)}`);
    if (body?.error) throw new Error(`RPC ${method} error: ${JSON.stringify(body.error)?.slice(0, 500)}`);
    return body?.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkSqlite(writeProbe: boolean): Promise<Record<string, unknown>> {
  initTerminalStore();
  let probe: unknown = null;
  if (writeProbe) probe = insertTerminalProbeRow({ source: "doctor" });
  const rows = listTerminalFeed({ limit: 3, source: null, includeUnpriced: true, hideMayhem: false });
  return { dbPath: process.env.SOWL_DB_PATH ?? process.env.SOLARD_DB_PATH ?? null, writeProbe, probe, feedRows: rows.length, newestMint: rows[0]?.mint ?? null };
}

async function checkHeliusHttp(sampleTransaction: boolean): Promise<Record<string, unknown>> {
  const solUsd = await resolveSolUsd().catch(() => null);
  const signatures = await rpc("getSignaturesForAddress", [PUMPFUN_PROGRAM_ID, { limit: sampleTransaction ? 8 : 1 }]);
  const first = Array.isArray(signatures) ? signatures.find((row) => row?.signature)?.signature : null;
  const out: Record<string, unknown> = {
    rpcUrl: redact(heliusRpcUrl()),
    solUsd,
    signatures: Array.isArray(signatures) ? signatures.length : 0,
    firstSignature: first,
  };
  if (!sampleTransaction || !first) return out;

  const tx = await rpc("getTransaction", [first, { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], 15_000).catch(async (error) => {
    const fallback = await rpc("getTransaction", [first, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 }], 15_000);
    return { __jsonParsedError: String(error?.message ?? error), ...fallback };
  });
  const parsed = parsePumpTransaction({ tx, signature: first, solUsd, now: Date.now() });
  return {
    ...out,
    sampled: true,
    slot: tx?.slot ?? null,
    parsedCreates: parsed.creates.length,
    parsedTrades: parsed.trades.length,
    parsedCompletes: parsed.completes.length,
    jsonParsedFallbackError: tx?.__jsonParsedError ?? null,
  };
}

function wsData(event: any): string {
  const data = event?.data;
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return String(data ?? "");
}

async function checkHeliusLogs(seconds: number): Promise<Record<string, unknown>> {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) throw new Error("globalThis.WebSocket is unavailable in this runtime");
  const url = heliusWsUrl();
  const solUsd = await resolveSolUsd().catch(() => null);
  const counters = {
    opened: false,
    subscribed: false,
    subscriptionId: null as unknown,
    received: 0,
    notifications: 0,
    erroredNotifications: 0,
    programDataLogs: 0,
    decodedCreates: 0,
    decodedTrades: 0,
    decodedCompletes: 0,
    lastSignature: null as string | null,
    lastSlot: null as number | null,
    lastRaw: null as unknown,
  };

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocketCtor(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve();
    }, seconds * 1000);

    ws.addEventListener("open", () => {
      counters.opened = true;
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [{ mentions: [PUMPFUN_PROGRAM_ID] }, { commitment: process.env.SOLARD_HELIUS_LOGS_COMMITMENT ?? "processed" }],
      }));
    });

    ws.addEventListener("message", (event: any) => {
      counters.received++;
      const raw = wsData(event);
      try {
        const msg = JSON.parse(raw);
        counters.lastRaw = { id: msg?.id ?? null, method: msg?.method ?? null, hasParams: !!msg?.params, bytes: raw.length };
        if (msg?.id === 1 && msg?.result != null) {
          counters.subscribed = true;
          counters.subscriptionId = msg.result;
          return;
        }
        if (msg?.method !== "logsNotification") return;
        counters.notifications++;
        const value = msg?.params?.result?.value ?? {};
        if (value?.err) {
          counters.erroredNotifications++;
          return;
        }
        const signature = String(value?.signature ?? "");
        const logs = Array.isArray(value?.logs) ? value.logs.map(String) : [];
        const slot = Number(msg?.params?.result?.context?.slot ?? 0);
        counters.lastSignature = signature || counters.lastSignature;
        counters.lastSlot = Number.isFinite(slot) ? slot : counters.lastSlot;
        counters.programDataLogs += logs.filter((line: string) => line.includes("Program data: ")).length;
        const parsed = parsePumpLogs({ logs, signature, slot, solUsd, now: Date.now() });
        counters.decodedCreates += parsed.creates.length;
        counters.decodedTrades += parsed.trades.length;
        counters.decodedCompletes += parsed.completes.length;
      } catch (error) {
        counters.lastRaw = { parseError: String((error as Error)?.message ?? error), bytes: raw.length, sample: raw.slice(0, 200) };
      }
    });

    ws.addEventListener("close", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", (event: any) => {
      clearTimeout(timer);
      reject(new Error(String(event?.message ?? "Helius logs websocket error")));
    });
  });

  return { url: redact(url), seconds, ...counters };
}

async function checkPumpPortal(seconds: number): Promise<Record<string, unknown>> {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) throw new Error("globalThis.WebSocket is unavailable in this runtime");
  const url = process.env.SOLARD_PUMPPORTAL_WS_URL?.trim() || "wss://pumpportal.fun/api/data";
  const counters = {
    opened: false,
    sentSubscribe: false,
    received: 0,
    tokenLike: 0,
    tradeLike: 0,
    lastRaw: null as unknown,
    lastMint: null as string | null,
  };

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocketCtor(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve();
    }, seconds * 1000);

    ws.addEventListener("open", () => {
      counters.opened = true;
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      counters.sentSubscribe = true;
    });
    ws.addEventListener("message", (event: any) => {
      counters.received++;
      const raw = wsData(event);
      try {
        const msg = JSON.parse(raw);
        const mint = String(msg?.mint ?? msg?.tokenMint ?? msg?.ca ?? "");
        counters.lastRaw = { keys: Object.keys(msg).slice(0, 16), txType: msg?.txType ?? msg?.type ?? null, hasMint: !!mint, bytes: raw.length };
        if (mint) counters.lastMint = mint;
        if (mint && (msg?.name || msg?.symbol || msg?.uri || msg?.metadataUri || msg?.txType === "create")) counters.tokenLike++;
        if (mint && (msg?.txType === "buy" || msg?.txType === "sell" || msg?.isBuy != null || msg?.solAmount != null)) counters.tradeLike++;
      } catch {
        counters.lastRaw = { bytes: raw.length, sample: raw.slice(0, 200) };
      }
    });
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", (event: any) => {
      clearTimeout(timer);
      reject(new Error(String(event?.message ?? "PumpPortal websocket error")));
    });
  });

  return { url: redact(url), seconds, ...counters };
}

function recommendations(checks: CheckResult[]): string[] {
  const out: string[] = [];
  const sqlite = checks.find((row) => row.name === "sqlite");
  const heliusLogs = checks.find((row) => row.name === "helius.logsSubscribe");
  const heliusHttp = checks.find((row) => row.name === "helius.httpRpc");
  const pump = checks.find((row) => row.name === "pumpportal.ws");

  if (!sqlite?.ok) out.push("SQLite is failing before stream data can render. Fix DB path/schema first.");
  if (heliusLogs && !heliusLogs.ok) out.push("Helius logs WebSocket is not connecting. Check HELIUS_API_KEY / HELIUS_WS_URL and plan permissions.");
  if (heliusLogs?.ok && Number(heliusLogs.data?.received ?? 0) === 0) out.push("Helius WebSocket opened but received no messages during the sample window. Try a longer window or confirmed/processed commitment toggle.");
  if (heliusLogs?.ok && Number(heliusLogs.data?.notifications ?? 0) > 0 && Number(heliusLogs.data?.decodedCreates ?? 0) + Number(heliusLogs.data?.decodedTrades ?? 0) === 0) out.push("Helius delivered Pump logs but parser decoded no Pump events. Capture lastRaw/log sample and update event layout/discriminators.");
  if (heliusHttp && !heliusHttp.ok) out.push("Helius HTTP RPC failed. The polling fallback cannot work until RPC config is fixed.");
  if (pump && pump.ok && Number(pump.data?.received ?? 0) === 0) out.push("PumpPortal WebSocket opened but delivered no messages during the sample window.");
  if (out.length === 0) out.push("Transport and DB checks passed. If UI is blank, the issue is likely feed filters, source selection, or row mapping.");
  return out;
}

export async function runLiveDoctor(options: DoctorOptions = {}): Promise<LiveDoctorResult> {
  const source = normalizeSource(options.source);
  const seconds = numberOpt(options.seconds, 12, 3, 60);
  const writeProbe = boolOpt(options.writeProbe, true);
  const sampleTransaction = boolOpt(options.sampleTransaction, true);
  const startedAtMs = Date.now();
  const checks: CheckResult[] = [];

  checks.push(await timed("sqlite", () => checkSqlite(writeProbe)));
  if (source === "helius" || source === "both") {
    checks.push(await timed("helius.httpRpc", () => checkHeliusHttp(sampleTransaction)));
    checks.push(await timed("helius.logsSubscribe", () => checkHeliusLogs(seconds)));
  }
  if (source === "pumpportal" || source === "both") {
    checks.push(await timed("pumpportal.ws", () => checkPumpPortal(seconds)));
  }

  const finishedAtMs = Date.now();
  const result: LiveDoctorResult = {
    ok: checks.every((row) => row.ok),
    source,
    seconds,
    startedAtMs,
    finishedAtMs,
    checks,
    recommendation: recommendations(checks),
  };

  try {
    upsertProcessStatus({
      name: "solard-live-doctor",
      kind: "diagnostic",
      status: result.ok ? "ok" : "warn",
      data: result,
      error: result.ok ? null : result.recommendation.join(" | "),
    });
  } catch {}

  return result;
}
