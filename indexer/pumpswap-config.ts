import { SOLARD_DB_PATH } from "../shared/db.js";

export const OFFICIAL_PUMPSWAP_PROGRAM_ID =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export type PumpSwapConfig = {
  name: string;
  buildId: string;
  dbPath: string;
  statePath: string;

  programId: string;
  rpcUrl: string;
  wsUrl: string;
  commitment: "confirmed" | "finalized";
  wsCommitment: "processed" | "confirmed" | "finalized";

  heartbeatMs: number;
  lifecycleRefreshMs: number;
  activeWindowMs: number;
  interestWindowMs: number;
  minInterestScore: number;
  requireInterestSignal: boolean;
  maxTrackedTokens: number;

  maxConnections: number;
  maxSubscriptionsPerConnection: number;
  subscriptionFlushMs: number;
  repairPollMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;

  discoveryRefreshMs: number;
  discoveryPerCycle: number;
  discoveryLimit: number;
  discoveryRetryMinMs: number;
  discoveryRetryMaxMs: number;

  historyMs: number;
  historyTokensPerCycle: number;
  historyLimit: number;
  historyMaxPages: number;

  rpcTimeoutMs: number;
  rpcConcurrency: number;

  tokenDecimals: number;
  solUsd: number | null;
  solUsdRefreshMs: number;
};

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(env(name) ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function integerEnv(name: string, fallback: number, min = 0): number {
  return Math.max(min, Math.floor(numberEnv(name, fallback)));
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

export function loadPumpSwapConfig(): PumpSwapConfig {
  const apiKey = env("HELIUS_API_KEY");
  const explicitRpc =
    env("SOLARD_PUMPSWAP_RPC_URL") ??
    env("HELIUS_RPC_URL") ??
    env("RPC_ENDPOINT") ??
    env("SOLANA_RPC_URL");
  const explicitWs = env("SOLARD_PUMPSWAP_WS_URL") ?? env("HELIUS_WS_URL");

  const rpcUrl =
    explicitRpc ??
    (explicitWs
      ? wsToRpc(explicitWs)
      : apiKey
        ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}`
        : undefined);
  const wsUrl =
    explicitWs ??
    (explicitRpc
      ? rpcToWs(explicitRpc)
      : apiKey
        ? `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`
        : undefined);

  if (!rpcUrl || !wsUrl) {
    throw new Error(
      "Missing PumpSwap RPC/WebSocket URL. Set SOLARD_PUMPSWAP_RPC_URL and SOLARD_PUMPSWAP_WS_URL, or HELIUS_API_KEY.",
    );
  }

  const requestedCommitment = env("SOLARD_PUMPSWAP_COMMITMENT");
  const commitment =
    requestedCommitment === "finalized" ? "finalized" : "confirmed";
  const requestedWsCommitment = env("SOLARD_PUMPSWAP_WS_COMMITMENT");
  const wsCommitment =
    requestedWsCommitment === "finalized"
      ? "finalized"
      : requestedWsCommitment === "confirmed"
        ? "confirmed"
        : "processed";

  const maxConnections = Math.min(
    5,
    integerEnv("SOLARD_PUMPSWAP_WS_CONNECTIONS", 5, 1),
  );
  const maxSubscriptionsPerConnection = Math.min(
    1_000,
    integerEnv("SOLARD_PUMPSWAP_SUBSCRIPTIONS_PER_CONNECTION", 1_000, 1),
  );
  const hardCapacity = maxConnections * maxSubscriptionsPerConnection;
  const configuredSolUsd = Number(env("SOLARD_SOL_USD") ?? "");

  return {
    name: env("SOLARD_PUMPSWAP_INDEXER_NAME") ?? "solard-pumpswap-subs",
    buildId:
      env("SOLARD_PUMPSWAP_BUILD_ID") ??
      "pumpswap-v3-multiplexed-account-subscriptions",
    dbPath: SOLARD_DB_PATH,
    statePath:
      env("SOLARD_PUMPSWAP_STATE_PATH") ??
      `${SOLARD_DB_PATH}.pumpswap-poller.json`,

    programId:
      env("SOLARD_PUMPSWAP_PROGRAM_ID") ?? OFFICIAL_PUMPSWAP_PROGRAM_ID,
    rpcUrl,
    wsUrl,
    commitment,
    wsCommitment,

    heartbeatMs: integerEnv("SOLARD_PUMPSWAP_HEARTBEAT_MS", 10_000, 1_000),
    lifecycleRefreshMs: integerEnv(
      "SOLARD_PUMPSWAP_LIFECYCLE_REFRESH_MS",
      2_000,
      500,
    ),
    activeWindowMs: integerEnv(
      "SOLARD_PUMPSWAP_ACTIVE_WINDOW_MS",
      24 * 60 * 60_000,
      60_000,
    ),
    interestWindowMs: integerEnv(
      "SOLARD_PUMPSWAP_INTEREST_WINDOW_MS",
      30 * 60_000,
      60_000,
    ),
    minInterestScore: numberEnv("SOLARD_PUMPSWAP_MIN_INTEREST_SCORE", 0),
    requireInterestSignal: boolEnv(
      "SOLARD_PUMPSWAP_REQUIRE_INTEREST_SIGNAL",
      false,
    ),
    maxTrackedTokens: Math.min(
      hardCapacity,
      integerEnv("SOLARD_PUMPSWAP_MAX_TRACKED_TOKENS", hardCapacity, 1),
    ),

    maxConnections,
    maxSubscriptionsPerConnection,
    subscriptionFlushMs: integerEnv(
      "SOLARD_PUMPSWAP_SUBSCRIPTION_FLUSH_MS",
      1_000,
      200,
    ),
    repairPollMs: integerEnv(
      "SOLARD_PUMPSWAP_REPAIR_POLL_MS",
      integerEnv("SOLARD_PUMPSWAP_POLL_MS", 60_000, 5_000),
      5_000,
    ),
    reconnectMinMs: integerEnv("SOLARD_PUMPSWAP_RECONNECT_MIN_MS", 750, 250),
    reconnectMaxMs: integerEnv(
      "SOLARD_PUMPSWAP_RECONNECT_MAX_MS",
      30_000,
      1_000,
    ),

    discoveryRefreshMs: integerEnv(
      "SOLARD_PUMPSWAP_DISCOVERY_REFRESH_MS",
      15_000,
      5_000,
    ),
    discoveryPerCycle: integerEnv("SOLARD_PUMPSWAP_DISCOVERY_PER_CYCLE", 4, 1),
    discoveryLimit: Math.min(
      1_000,
      integerEnv("SOLARD_PUMPSWAP_DISCOVERY_LIMIT", 50, 1),
    ),
    discoveryRetryMinMs: integerEnv(
      "SOLARD_PUMPSWAP_DISCOVERY_RETRY_MIN_MS",
      15_000,
      1_000,
    ),
    discoveryRetryMaxMs: integerEnv(
      "SOLARD_PUMPSWAP_DISCOVERY_RETRY_MAX_MS",
      10 * 60_000,
      5_000,
    ),

    historyMs: integerEnv("SOLARD_PUMPSWAP_HISTORY_MS", 0, 0),
    historyTokensPerCycle: integerEnv(
      "SOLARD_PUMPSWAP_HISTORY_TOKENS_PER_CYCLE",
      2,
      1,
    ),
    historyLimit: Math.min(
      1_000,
      integerEnv("SOLARD_PUMPSWAP_HISTORY_LIMIT", 100, 1),
    ),
    historyMaxPages: integerEnv("SOLARD_PUMPSWAP_HISTORY_MAX_PAGES", 2, 1),

    rpcTimeoutMs: integerEnv("SOLARD_PUMPSWAP_RPC_TIMEOUT_MS", 8_000, 1_000),
    rpcConcurrency: Math.min(
      8,
      integerEnv("SOLARD_PUMPSWAP_RPC_CONCURRENCY", 3, 1),
    ),

    tokenDecimals: integerEnv("SOLARD_PUMP_TOKEN_DECIMALS", 6, 0),
    solUsd:
      Number.isFinite(configuredSolUsd) && configuredSolUsd > 0
        ? configuredSolUsd
        : null,
    solUsdRefreshMs: integerEnv("SOLARD_SOL_USD_REFRESH_MS", 30_000, 5_000),
  };
}
