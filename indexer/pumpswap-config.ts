import { SOLARD_DB_PATH } from "../shared/db.js";

export const OFFICIAL_PUMPSWAP_PROGRAM_ID =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export type PumpSwapConfig = {
  name: string;
  buildId: string;
  dbPath: string;

  programId: string;
  rpcUrl: string;
  wsUrl: string;
  commitment: "processed" | "confirmed" | "finalized";

  heartbeatMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;

  rpcTimeoutMs: number;
  transactionFetchAttempts: number;
  transactionFetchDelayMs: number;

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

function wsToRpc(value: string): string {
  if (value.startsWith("wss://")) {
    return `https://${value.slice(6)}`;
  }

  if (value.startsWith("ws://")) {
    return `http://${value.slice(5)}`;
  }

  return value;
}

function rpcToWs(value: string): string {
  if (value.startsWith("https://")) {
    return `wss://${value.slice(8)}`;
  }

  if (value.startsWith("http://")) {
    return `ws://${value.slice(7)}`;
  }

  return value;
}

export function redactedUrl(value: string): string {
  try {
    const url = new URL(value);

    for (const key of url.searchParams.keys()) {
      if (/key|token|secret|auth/i.test(key)) {
        url.searchParams.set(key, "***");
      }
    }

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

  const wsUrl = explicitWs ?? (rpcUrl ? rpcToWs(rpcUrl) : undefined);

  if (!rpcUrl || !wsUrl) {
    throw new Error(
      "Missing PumpSwap Helius RPC/WS URL. Set SOLARD_PUMPSWAP_RPC_URL, SOLARD_PUMPSWAP_WS_URL, HELIUS_RPC_URL, HELIUS_WS_URL, or HELIUS_API_KEY.",
    );
  }

  const commitmentValue = env("SOLARD_PUMPSWAP_COMMITMENT") ?? "processed";

  const commitment =
    commitmentValue === "confirmed" || commitmentValue === "finalized"
      ? commitmentValue
      : "processed";

  const configuredSolUsd = Number(env("SOLARD_SOL_USD") ?? "");

  return {
    name: env("SOLARD_INDEXER_NAME") ?? "solard-pumpswap-indexer",

    buildId: env("SOLARD_INDEXER_BUILD_ID") ?? "pumpswap-indexer-v1",

    dbPath: SOLARD_DB_PATH,

    programId:
      env("SOLARD_PUMPSWAP_PROGRAM_ID") ?? OFFICIAL_PUMPSWAP_PROGRAM_ID,

    rpcUrl,
    wsUrl,
    commitment,

    heartbeatMs: numberEnv("SOLARD_PUMPSWAP_HEARTBEAT_MS", 5_000),

    reconnectMinMs: numberEnv("SOLARD_PUMPSWAP_RECONNECT_MIN_MS", 750),

    reconnectMaxMs: numberEnv("SOLARD_PUMPSWAP_RECONNECT_MAX_MS", 30_000),

    rpcTimeoutMs: numberEnv("SOLARD_PUMPSWAP_RPC_TIMEOUT_MS", 4_000),

    transactionFetchAttempts: Math.max(
      1,
      Math.floor(numberEnv("SOLARD_PUMPSWAP_TX_FETCH_ATTEMPTS", 6)),
    ),

    transactionFetchDelayMs: Math.max(
      10,
      Math.floor(numberEnv("SOLARD_PUMPSWAP_TX_FETCH_DELAY_MS", 80)),
    ),

    solUsd:
      Number.isFinite(configuredSolUsd) && configuredSolUsd > 0
        ? configuredSolUsd
        : null,

    solUsdRefreshMs: numberEnv("SOLARD_SOL_USD_REFRESH_MS", 30_000),
  };
}
