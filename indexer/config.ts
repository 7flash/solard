import { SOLARD_DB_PATH } from "../shared/db.js";

export const OFFICIAL_PUMP_PROGRAM_ID =
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export type IndexerConfig = {
  name: string;
  buildId: string;
  dbPath: string;

  programId: string;
  rpcUrl: string;
  wsUrl: string;
  commitment: "processed" | "confirmed" | "finalized";

  pumpPortalUrl: string;

  reconnectMinMs: number;
  reconnectMaxMs: number;
  heartbeatMs: number;

  metadataFetch: boolean;
  metadataTimeoutMs: number;
  metadataMaxBytes: number;
  metadataConcurrency: number;

  solUsd: number | null;
  solUsdRefreshMs: number;

  tokenDecimals: number;
  pumpSupplyUi: number;

  maxConnections: number;
  maxSubscriptionsPerConnection: number;
  maxTrackedTokens: number;
  lifecycleRefreshMs: number;
  activeWindowMs: number;
  interestWindowMs: number;
  minInterestScore: number;
  requireInterestSignal: boolean;
  curveRepairPollMs: number;
  curvePollMs: number;
  curveRpcTimeoutMs: number;
};

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function numberEnv(name: string, fallback: number): number {
  const parsed = Number(env(name) ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name: string, fallback = false): boolean {
  const value = env(name);
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function wsToRpc(value: string): string {
  if (value.startsWith("wss://")) return `https://${value.slice(6)}`;
  if (value.startsWith("ws://")) return `http://${value.slice(5)}`;
  return value;
}

function rpcToWs(value: string): string {
  if (value.startsWith("wss://") || value.startsWith("ws://")) return value;
  if (value.startsWith("https://")) return `wss://${value.slice(8)}`;
  if (value.startsWith("http://")) return `ws://${value.slice(7)}`;
  return value;
}

export function redactedUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|auth|jwt/i.test(key))
        url.searchParams.set(key, "***");
    }
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return value.replace(/(api[-_]?key=)[^&\s]+/gi, "$1***");
  }
}

export function loadConfig(): IndexerConfig {
  const heliusApiKey = env("HELIUS_API_KEY");
  const explicitWs =
    env("SOLARD_HELIUS_ACCOUNT_WS_URL") ?? env("HELIUS_WS_URL");
  const rpc =
    env("HELIUS_RPC_URL") ??
    env("RPC_ENDPOINT") ??
    env("SOLANA_RPC_URL") ??
    (heliusApiKey
      ? `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
      : undefined);
  const wsUrl = explicitWs ?? (rpc ? rpcToWs(rpc) : undefined);
  const rpcUrl = rpc ?? (explicitWs ? wsToRpc(explicitWs) : undefined);
  if (!wsUrl || !rpcUrl) {
    throw new Error("Missing Helius RPC/WS URL or HELIUS_API_KEY");
  }

  const pumpPortalApiKey = env("PUMPPORTAL_API_KEY");
  const pumpPortalUrl =
    env("SOLARD_PUMPPORTAL_WS_URL") ??
    (pumpPortalApiKey
      ? `wss://pumpportal.fun/api/data?api-key=${encodeURIComponent(pumpPortalApiKey)}`
      : undefined);
  if (!pumpPortalUrl) {
    throw new Error(
      "Missing PumpPortal creation source. Set PUMPPORTAL_API_KEY or SOLARD_PUMPPORTAL_WS_URL.",
    );
  }

  const commitmentRaw = env("SOLARD_INDEXER_COMMITMENT") ?? "processed";
  const commitment = (
    ["processed", "confirmed", "finalized"] as const
  ).includes(commitmentRaw as any)
    ? (commitmentRaw as IndexerConfig["commitment"])
    : "processed";

  const maxConnections = Math.max(
    1,
    Math.min(5, Math.trunc(numberEnv("SOLARD_PUMP_WS_CONNECTIONS", 5))),
  );
  const maxSubscriptionsPerConnection = Math.max(
    1,
    Math.min(
      1000,
      Math.trunc(numberEnv("SOLARD_PUMP_SUBSCRIPTIONS_PER_CONNECTION", 1000)),
    ),
  );
  const hardCapacity = maxConnections * maxSubscriptionsPerConnection;

  const parsedSolUsd = Number(env("SOLARD_SOL_USD") ?? "");

  return {
    name: env("SOLARD_INDEXER_NAME") ?? "solard-indexer-pumpportal",
    buildId: env("SOLARD_INDEXER_BUILD_ID") ?? "indexer-v19-exact-token-logs",
    dbPath: SOLARD_DB_PATH,
    programId: env("SOLARD_PUMPFUN_PROGRAM_ID") ?? OFFICIAL_PUMP_PROGRAM_ID,
    rpcUrl,
    wsUrl,
    commitment,
    pumpPortalUrl,
    reconnectMinMs: Math.max(
      250,
      numberEnv("SOLARD_INDEXER_RECONNECT_MIN_MS", 750),
    ),
    reconnectMaxMs: Math.max(
      1000,
      numberEnv("SOLARD_INDEXER_RECONNECT_MAX_MS", 30_000),
    ),
    heartbeatMs: Math.max(1000, numberEnv("SOLARD_INDEXER_HEARTBEAT_MS", 5000)),
    metadataFetch: boolEnv("SOLARD_INDEXER_METADATA", true),
    metadataTimeoutMs: numberEnv("SOLARD_INDEXER_METADATA_TIMEOUT_MS", 3500),
    metadataMaxBytes: numberEnv("SOLARD_INDEXER_METADATA_MAX_BYTES", 1_000_000),
    metadataConcurrency: numberEnv("SOLARD_INDEXER_METADATA_CONCURRENCY", 4),
    solUsd:
      Number.isFinite(parsedSolUsd) && parsedSolUsd > 0 ? parsedSolUsd : null,
    solUsdRefreshMs: Math.max(
      5000,
      numberEnv("SOLARD_SOL_USD_REFRESH_MS", 30_000),
    ),
    tokenDecimals: numberEnv("SOLARD_PUMP_TOKEN_DECIMALS", 6),
    pumpSupplyUi: numberEnv("SOLARD_PUMP_SUPPLY_UI", 1_000_000_000),
    maxConnections,
    maxSubscriptionsPerConnection,
    maxTrackedTokens: Math.max(
      1,
      Math.min(
        hardCapacity,
        Math.trunc(numberEnv("SOLARD_PUMP_MAX_TRACKED_TOKENS", hardCapacity)),
      ),
    ),
    lifecycleRefreshMs: Math.max(
      500,
      numberEnv("SOLARD_PUMP_LIFECYCLE_REFRESH_MS", 2000),
    ),
    activeWindowMs: Math.max(
      60_000,
      numberEnv("SOLARD_PUMP_ACTIVE_WINDOW_MS", 60 * 60_000),
    ),
    interestWindowMs: Math.max(
      60_000,
      numberEnv("SOLARD_PUMP_INTEREST_WINDOW_MS", 30 * 60_000),
    ),
    minInterestScore: numberEnv("SOLARD_PUMP_MIN_INTEREST_SCORE", 0),
    requireInterestSignal: boolEnv(
      "SOLARD_PUMP_REQUIRE_INTEREST_SIGNAL",
      false,
    ),
    curveRepairPollMs: Math.max(
      10_000,
      numberEnv("SOLARD_PUMP_CURVE_REPAIR_POLL_MS", 60_000),
    ),
    curvePollMs: Math.max(1_000, numberEnv("SOLARD_PUMP_CURVE_POLL_MS", 5_000)),
    curveRpcTimeoutMs: Math.max(
      500,
      numberEnv("SOLARD_PUMP_CURVE_RPC_TIMEOUT_MS", 4000),
    ),
  };
}
