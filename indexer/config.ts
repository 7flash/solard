export type IndexerConfig = {
  name: string;
  buildId: string;
  dbPath: string;
  programId: string;
  wsUrl: string;
  commitment: string;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  heartbeatMs: number;
  metadataFetch: boolean;
  solUsd: number | null;
  tokenDecimals: number;
  pumpSupplyUi: number;
};
function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
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
function rpcToWs(value: string): string {
  if (value.startsWith("wss://") || value.startsWith("ws://")) return value;
  if (value.startsWith("https://"))
    return `wss://${value.slice("https://".length)}`;
  if (value.startsWith("http://"))
    return `ws://${value.slice("http://".length)}`;
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
  const apiKey = env("HELIUS_API_KEY");
  const explicitWs = env("SOLARD_HELIUS_LOGS_WS_URL") ?? env("HELIUS_WS_URL");
  const rpc =
    env("HELIUS_RPC_URL") ??
    env("RPC_ENDPOINT") ??
    env("SOLANA_RPC_URL") ??
    (apiKey ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}` : undefined);
  const wsUrl = explicitWs ?? (rpc ? rpcToWs(rpc) : undefined);
  if (!wsUrl)
    throw new Error(
      "Missing Helius websocket URL. Set SOLARD_HELIUS_LOGS_WS_URL, HELIUS_WS_URL, HELIUS_RPC_URL, RPC_ENDPOINT, SOLANA_RPC_URL, or HELIUS_API_KEY.",
    );
  const solUsd = env("SOLARD_SOL_USD");
  const parsedSolUsd = solUsd == null ? null : Number(solUsd);
  return {
    name: env("SOLARD_INDEXER_NAME") ?? "solard-indexer-helius",
    buildId: env("SOLARD_INDEXER_BUILD_ID") ?? "indexer-v1-standalone",
    dbPath:
      env("SOLARD_INDEXER_DB_PATH") ??
      env("SOWL_DB_PATH") ??
      env("SOLARD_DB_PATH") ??
      "./sowl.db",
    programId:
      env("SOLARD_PUMPFUN_PROGRAM_ID") ??
      "6EF8rrecthR5DkL6sKJGWMWYg32R56HsZ6uC9h8Cqd5",
    wsUrl,
    commitment: env("SOLARD_INDEXER_COMMITMENT") ?? "processed",
    reconnectMinMs: numberEnv("SOLARD_INDEXER_RECONNECT_MIN_MS", 750),
    reconnectMaxMs: numberEnv("SOLARD_INDEXER_RECONNECT_MAX_MS", 30000),
    heartbeatMs: numberEnv("SOLARD_INDEXER_HEARTBEAT_MS", 5000),
    metadataFetch: boolEnv("SOLARD_INDEXER_METADATA", false),
    solUsd: Number.isFinite(parsedSolUsd) ? parsedSolUsd : null,
    tokenDecimals: numberEnv("SOLARD_PUMP_TOKEN_DECIMALS", 6),
    pumpSupplyUi: numberEnv("SOLARD_PUMP_SUPPLY_UI", 1000000000),
  };
}
