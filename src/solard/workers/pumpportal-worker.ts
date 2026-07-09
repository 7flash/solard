#!/usr/bin/env bun
import {
  dbWrite,
  insertTerminalTrade,
  recomputeTerminalIndicators,
  upsertProcessStatus,
  upsertTerminalToken,
} from "../db/terminal-store.js";
import {
  pruneIngestionKeys,
  recordWorkerError,
  rememberIngestionKey,
} from "../db/terminal-ingestion.js";
import { workerMeasure, summarizeForMeasure } from "../measure.js";
import { resolveSolUsd } from "../prices/sol-usd.js";
import {
  isPumpPortalCreate,
  pumpPortalMint,
  pumpPortalSignature,
  pumpPortalTokenPatch,
  pumpPortalTradePatch,
  type RawPumpPortalEvent,
} from "../pump/pumpportal-normalize.js";

const NAME = "solard-pumpportal-live-v2";
const BUILD_ID = "pumpportal-live-v3-source-filter-probe";
const KIND = "pumpportal-event";
const PUMPPORTAL_API_KEY =
  process.env.SOLARD_PUMPPORTAL_API_KEY?.trim() ||
  process.env.PUMPPORTAL_API_KEY?.trim() ||
  process.env.PUMPPORTAL_API_TOKEN?.trim() ||
  "";
const BASE_WS_URL =
  process.env.SOLARD_PUMPPORTAL_WS_URL?.trim() ||
  process.env.PUMPPORTAL_WS_URL?.trim() ||
  "wss://pumpportal.fun/api/data";
function pumpPortalWsUrl(): string {
  if (!PUMPPORTAL_API_KEY || /[?&]api-key=/i.test(BASE_WS_URL))
    return BASE_WS_URL;
  return `${BASE_WS_URL}${BASE_WS_URL.includes("?") ? "&" : "?"}api-key=${encodeURIComponent(PUMPPORTAL_API_KEY)}`;
}
function redactUrl(value: string): string {
  return value.replace(/api-key=[^&]+/i, "api-key=***");
}
const WS_URL = pumpPortalWsUrl();
const RETAIN_SEEN_MS = Math.max(
  60_000,
  Number(process.env.SOLARD_TERMINAL_SEEN_RETAIN_MS ?? "3600000"),
);
const MAX_WATCHED = Math.max(
  10,
  Number(process.env.SOLARD_PUMPPORTAL_WATCHED_MINTS ?? "300"),
);
const HEARTBEAT_MS = Math.max(
  2500,
  Number(process.env.SOLARD_PUMPPORTAL_HEARTBEAT_MS ?? "5000"),
);
const RECONNECT_MS = Math.max(
  500,
  Number(process.env.SOLARD_PUMPPORTAL_RECONNECT_MS ?? "1500"),
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function send(ws: WebSocket | null, payload: Record<string, unknown>): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function summarizeRaw(raw: RawPumpPortalEvent): Record<string, unknown> {
  const keys = Object.keys(raw).slice(0, 30);
  return {
    keys,
    txType: raw.txType ?? raw.type ?? raw.eventType ?? null,
    mint: raw.mint ?? raw.tokenMint ?? raw.ca ?? null,
    symbol: raw.symbol ?? raw.ticker ?? null,
    name: raw.name ?? raw.tokenName ?? null,
    marketCapSol: raw.marketCapSol ?? raw.market_cap_sol ?? raw.mcapSol ?? null,
    marketCapUsd:
      raw.marketCapUsd ?? raw.market_cap_usd ?? raw.usdMarketCap ?? null,
    hasImage: !!(
      raw.image ||
      raw.imageUrl ||
      raw.image_uri ||
      (raw.metadata &&
        typeof raw.metadata === "object" &&
        (raw.metadata as any).image)
    ),
  };
}

function keyFor(
  raw: RawPumpPortalEvent,
  kind: "create" | "trade",
  seq: number,
): string {
  const sig = pumpPortalSignature(raw);
  const mint = pumpPortalMint(raw);
  return `${KIND}:${kind}:${sig ?? mint ?? "unknown"}:${sig ? "" : seq}`;
}

const METADATA_FETCH_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.SOLARD_PUMP_METADATA_TIMEOUT_MS ?? "2500"),
);
const METADATA_MIN_INTERVAL_MS = Math.max(
  0,
  Number(process.env.SOLARD_PUMP_METADATA_INTERVAL_MS ?? "250"),
);
let lastMetadataFetchAtMs = 0;

function ipfsGateway(value: string): string {
  if (value.startsWith("ipfs://"))
    return `https://ipfs.io/ipfs/${value.slice("ipfs://".length)}`;
  return value;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function enrichFromMetadataUri(
  tokenPatch: Record<string, any>,
): Promise<Record<string, any>> {
  if (process.env.SOLARD_PUMP_METADATA_ENRICH === "0") return tokenPatch;
  if (tokenPatch.image || !tokenPatch.uri) return tokenPatch;
  const elapsed = Date.now() - lastMetadataFetchAtMs;
  if (elapsed < METADATA_MIN_INTERVAL_MS)
    await sleep(METADATA_MIN_INTERVAL_MS - elapsed);
  lastMetadataFetchAtMs = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), METADATA_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ipfsGateway(String(tokenPatch.uri)), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return tokenPatch;
    const metadata = (await res.json()) as Record<string, unknown>;
    return {
      ...tokenPatch,
      name: tokenPatch.name || cleanText(metadata.name),
      symbol: tokenPatch.symbol || cleanText(metadata.symbol),
      description: tokenPatch.description || cleanText(metadata.description),
      image:
        tokenPatch.image ||
        (cleanText(metadata.image)
          ? ipfsGateway(cleanText(metadata.image)!)
          : null),
      website: tokenPatch.website || cleanText(metadata.website),
      twitter: tokenPatch.twitter || cleanText(metadata.twitter),
      telegram: tokenPatch.telegram || cleanText(metadata.telegram),
    };
  } catch {
    return tokenPatch;
  } finally {
    clearTimeout(timer);
  }
}

async function recordEvent(
  raw: RawPumpPortalEvent,
  seq: number,
  source = "pumpportal",
): Promise<"create" | "trade" | "skip"> {
  return await workerMeasure.measure(
    {
      start: () => "pumpportal record event",
      end: (result) => result,
      catch: (error) => {
        recordWorkerError(NAME, error, { raw: summarizeRaw(raw) });
        return "skip" as const;
      },
    },
    async () => {
      const now = Date.now();
      const solUsd = await resolveSolUsd();
      const create = isPumpPortalCreate(raw);
      const kind = create ? "create" : "trade";
      const dedupeKey = keyFor(raw, kind, seq);
      if (!rememberIngestionKey(dedupeKey, KIND, now)) return "skip";

      let tokenPatch = pumpPortalTokenPatch({ raw, source, solUsd, now });
      if (!tokenPatch) return "skip";
      tokenPatch = (await enrichFromMetadataUri(
        tokenPatch as Record<string, any>,
      )) as any;

      await dbWrite(`pumpportal_${kind}`, () => {
        upsertTerminalToken(tokenPatch);
        const tradePatch = pumpPortalTradePatch({ raw, source, solUsd, now });
        if (tradePatch) insertTerminalTrade(tradePatch);
        recomputeTerminalIndicators(tokenPatch.mint, now);
      });
      return kind;
    },
  );
}

async function runOnce(): Promise<void> {
  let ws: WebSocket | null = null;
  let seq = 0;
  let creates = 0;
  let trades = 0;
  let skipped = 0;
  let lastEventAtMs = 0;
  let lastCreateAtMs = 0;
  let lastTradeAtMs = 0;
  let lastRaw: Record<string, unknown> | null = null;
  const watched: string[] = [];

  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    const heartbeat = setInterval(() => {
      upsertProcessStatus({
        name: NAME,
        kind: "stream",
        status: ws?.readyState === WebSocket.OPEN ? "ok" : "connecting",
        data: {
          wsUrl: redactUrl(WS_URL),
          buildId: BUILD_ID,
          creates,
          trades,
          skipped,
          watched: watched.length,
          lastEventAtMs,
          lastCreateAtMs,
          lastTradeAtMs,
          lastEventAgeMs: lastEventAtMs ? Date.now() - lastEventAtMs : null,
          hasApiKey: !!PUMPPORTAL_API_KEY,
          tradeSubscription: PUMPPORTAL_API_KEY
            ? "enabled"
            : "disabled-missing-api-key",
          lastRaw,
        },
      });
    }, HEARTBEAT_MS);

    ws = new WebSocket(WS_URL);
    upsertProcessStatus({
      name: NAME,
      kind: "stream",
      status: "connecting",
      data: { wsUrl: redactUrl(WS_URL) },
    });

    ws.addEventListener("open", () => {
      upsertProcessStatus({
        name: NAME,
        kind: "stream",
        status: "ok",
        data: {
          phase: "connected",
          buildId: BUILD_ID,
          wsUrl: redactUrl(WS_URL),
          hasApiKey: !!PUMPPORTAL_API_KEY,
          tradeSubscription: PUMPPORTAL_API_KEY
            ? "enabled"
            : "disabled-missing-api-key",
        },
      });
      send(ws, { method: "subscribeNewToken" });
    });

    ws.addEventListener("message", (message) => {
      void (async () => {
        try {
          const text =
            typeof message.data === "string"
              ? message.data
              : String(message.data);
          const raw = JSON.parse(text) as RawPumpPortalEvent;
          const mint = pumpPortalMint(raw);
          lastRaw = summarizeRaw(raw);
          const result = await recordEvent(raw, ++seq);
          lastEventAtMs = Date.now();
          if (result === "create") {
            creates++;
            lastCreateAtMs = lastEventAtMs;
            if (mint && !watched.includes(mint)) {
              watched.unshift(mint);
              while (watched.length > MAX_WATCHED) watched.pop();
              if (PUMPPORTAL_API_KEY) {
                send(ws, { method: "subscribeTokenTrade", keys: [mint] });
              }
            }
          } else if (result === "trade") {
            trades++;
            lastTradeAtMs = lastEventAtMs;
          } else {
            skipped++;
          }
          upsertProcessStatus({
            name: NAME,
            kind: "stream",
            status: "ok",
            data: {
              phase: "message",
              buildId: BUILD_ID,
              creates,
              trades,
              skipped,
              watched: watched.length,
              lastEventAtMs,
              lastCreateAtMs,
              lastTradeAtMs,
              lastEventAgeMs: 0,
              hasApiKey: !!PUMPPORTAL_API_KEY,
              tradeSubscription: PUMPPORTAL_API_KEY
                ? "enabled"
                : "disabled-missing-api-key",
              lastRaw,
            },
          });
        } catch (error) {
          skipped++;
          recordWorkerError(NAME, error);
        }
      })();
    });

    ws.addEventListener("error", () => {
      recordWorkerError(NAME, new Error("PumpPortal websocket error"));
      upsertProcessStatus({
        name: NAME,
        kind: "stream",
        status: "error",
        error: "PumpPortal websocket error",
      });
    });

    ws.addEventListener("close", (event) => {
      clearInterval(heartbeat);
      const pruned = pruneIngestionKeys(KIND, RETAIN_SEEN_MS);
      upsertProcessStatus({
        name: NAME,
        kind: "stream",
        status: "closed",
        data: {
          code: event.code,
          reason: event.reason || null,
          creates,
          trades,
          skipped,
          pruned,
        },
      });
      finish();
    });
  });
}

async function main(): Promise<void> {
  while (true) {
    await workerMeasure.measure(
      {
        start: () => "pumpportal worker session",
        end: () => ({
          result: summarizeForMeasure({ reconnectMs: RECONNECT_MS }),
        }),
        catch: (error) => {
          recordWorkerError(NAME, error);
          upsertProcessStatus({
            name: NAME,
            kind: "stream",
            status: "error",
            error,
          });
          return null;
        },
      },
      () => runOnce(),
    );
    await sleep(RECONNECT_MS);
  }
}

main().catch((error) => {
  recordWorkerError(NAME, error);
  upsertProcessStatus({ name: NAME, kind: "stream", status: "fatal", error });
  throw error;
});
