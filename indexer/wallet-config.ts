import { SOLARD_DB_PATH } from "../shared/db.js";
import { OFFICIAL_PUMP_PROGRAM_ID } from "./config.ts";
import {
  OFFICIAL_PUMPSWAP_PROGRAM_ID,
  USDC_MINT,
  WSOL_MINT,
} from "./pumpswap-config.ts";

export { USDC_MINT, WSOL_MINT };

export type WalletIndexerConfig = {
  name: string;
  buildId: string;
  dbPath: string;

  rpcUrl: string;
  wsUrl: string;
  commitment: "confirmed" | "finalized";

  pumpProgramId: string;
  pumpSwapProgramId: string;
  tokenDecimals: number;
  pumpSupplyUi: number;

  heartbeatMs: number;
  walletRefreshMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  maxWallets: number;

  backfillEnabled: boolean;
  backfillRefreshMs: number;
  backfillWalletsPerCycle: number;
  backfillLimit: number;
  rpcTimeoutMs: number;
  rpcConcurrency: number;

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

export function redactedWalletUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|auth|jwt/i.test(key)) {
        url.searchParams.set(key, "***");
      }
    }
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return value.replace(/(api[-_]?key=)[^&\s]+/gi, "$1***");
  }
}

export function loadWalletIndexerConfig(): WalletIndexerConfig {
  const apiKey = env("HELIUS_API_KEY");
  const explicitRpc =
    env("SOLARD_WALLET_RPC_URL") ??
    env("HELIUS_RPC_URL") ??
    env("RPC_ENDPOINT") ??
    env("SOLANA_RPC_URL");
  const explicitWs = env("SOLARD_WALLET_WS_URL") ?? env("HELIUS_WS_URL");

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
      "Missing wallet indexer RPC/WebSocket URL. Set SOLARD_WALLET_RPC_URL and SOLARD_WALLET_WS_URL, or HELIUS_API_KEY.",
    );
  }

  const commitment =
    env("SOLARD_WALLET_COMMITMENT") === "finalized" ? "finalized" : "confirmed";
  const parsedSolUsd = Number(env("SOLARD_SOL_USD") ?? "");

  return {
    name: env("SOLARD_WALLET_INDEXER_NAME") ?? "solard-wallet-indexer",
    buildId:
      env("SOLARD_WALLET_INDEXER_BUILD_ID") ??
      "wallet-indexer-v1-transaction-subscribe",
    dbPath: SOLARD_DB_PATH,

    rpcUrl,
    wsUrl,
    commitment,

    pumpProgramId: env("SOLARD_PUMPFUN_PROGRAM_ID") ?? OFFICIAL_PUMP_PROGRAM_ID,
    pumpSwapProgramId:
      env("SOLARD_PUMPSWAP_PROGRAM_ID") ?? OFFICIAL_PUMPSWAP_PROGRAM_ID,
    tokenDecimals: numberEnv("SOLARD_PUMP_TOKEN_DECIMALS", 6),
    pumpSupplyUi: numberEnv("SOLARD_PUMP_SUPPLY_UI", 1_000_000_000),

    heartbeatMs: integerEnv("SOLARD_WALLET_HEARTBEAT_MS", 10_000, 1_000),
    walletRefreshMs: integerEnv("SOLARD_WALLET_REFRESH_MS", 2_000, 500),
    reconnectMinMs: integerEnv("SOLARD_WALLET_RECONNECT_MIN_MS", 750, 250),
    reconnectMaxMs: integerEnv("SOLARD_WALLET_RECONNECT_MAX_MS", 30_000, 1_000),
    maxWallets: Math.min(
      50_000,
      integerEnv("SOLARD_WALLET_MAX_WALLETS", 5_000, 1),
    ),

    backfillEnabled: boolEnv("SOLARD_WALLET_BACKFILL", true),
    backfillRefreshMs: integerEnv(
      "SOLARD_WALLET_BACKFILL_REFRESH_MS",
      30_000,
      5_000,
    ),
    backfillWalletsPerCycle: integerEnv(
      "SOLARD_WALLET_BACKFILL_WALLETS_PER_CYCLE",
      10,
      1,
    ),
    backfillLimit: Math.min(
      1_000,
      integerEnv("SOLARD_WALLET_BACKFILL_LIMIT", 100, 1),
    ),
    rpcTimeoutMs: integerEnv("SOLARD_WALLET_RPC_TIMEOUT_MS", 8_000, 500),
    rpcConcurrency: integerEnv("SOLARD_WALLET_RPC_CONCURRENCY", 4, 1),

    solUsd:
      Number.isFinite(parsedSolUsd) && parsedSolUsd > 0 ? parsedSolUsd : null,
    solUsdRefreshMs: integerEnv("SOLARD_SOL_USD_REFRESH_MS", 30_000, 5_000),
  };
}
