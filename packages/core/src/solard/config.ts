import { resolveDbPath } from "../db/database.ts";
import {
  liveTradesEnabled,
  webAuthConfigured,
} from "./safety.ts";

export type SolardConfigIssue = {
  level: "warn" | "error";
  key: string;
  message: string;
};

export type SolardRuntimeConfig = {
  loadedAtMs: number;
  nodeEnv: string | null;
  dbPath: string;
  rpcUrl: string | null;
  rpcSource: "HELIUS_RPC_URL" | "RPC_ENDPOINT" | "HELIUS_API_KEY" | null;
  websocketUrl: string | null;
  heliusSenderUrl: string | null;
  heliusTipAccount: string | null;
  webAuthConfigured: boolean;
  liveTradingEnabled: boolean;
  pump: {
    metadataProvider: string | null;
    liveCurveMemory: number;
    feedSource: string | null;
  };
  issues: SolardConfigIssue[];
};

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function intEnv(name: string, fallback: number): number {
  const raw = clean(process.env[name]);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function resolveRpcUrl(): {
  url: string | null;
  source: SolardRuntimeConfig["rpcSource"];
} {
  const heliusRpcUrl = clean(process.env.HELIUS_RPC_URL);
  if (heliusRpcUrl) return { url: heliusRpcUrl, source: "HELIUS_RPC_URL" };

  const rpcEndpoint = clean(process.env.RPC_ENDPOINT);
  if (rpcEndpoint) return { url: rpcEndpoint, source: "RPC_ENDPOINT" };

  const heliusApiKey = clean(process.env.HELIUS_API_KEY);
  if (heliusApiKey) {
    return {
      url: `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`,
      source: "HELIUS_API_KEY",
    };
  }

  return { url: null, source: null };
}

export function redactSecret(value: string | null): string | null {
  if (!value) return null;
  return value
    .replace(/(api-key=)[^&]+/i, "$1***")
    .replace(/(bearer\s+)[a-z0-9._-]+/i, "$1***")
    .replace(/(jwt=)[^&]+/i, "$1***");
}

export function loadSolardRuntimeConfig(): SolardRuntimeConfig {
  const rpc = resolveRpcUrl();
  const heliusApiKey = clean(process.env.HELIUS_API_KEY);
  const websocketUrl =
    clean(process.env.SOLWAL_HELIUS_WS_URL) ||
    clean(process.env.SLRD_HELIUS_WS_URL) ||
    (heliusApiKey
      ? `wss://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
      : null);

  const heliusSenderUrl = clean(process.env.HELIUS_SENDER_URL);
  const heliusTipAccount =
    clean(process.env.HELIUS_TIP_ACCOUNT) ||
    clean(process.env.SOLWAL_HELIUS_TIP_ACCOUNT) ||
    clean(process.env.SLRD_HELIUS_TIP_ACCOUNT);

  const issues: SolardConfigIssue[] = [];
  if (!rpc.url) {
    issues.push({
      level: "warn",
      key: "HELIUS_RPC_URL/RPC_ENDPOINT/HELIUS_API_KEY",
      message:
        "No RPC URL configured; local pages can load but chain-backed calls will fail.",
    });
  }
  if (heliusSenderUrl && !heliusTipAccount) {
    issues.push({
      level: "warn",
      key: "HELIUS_TIP_ACCOUNT",
      message: "HELIUS_SENDER_URL is set but no tip account is configured.",
    });
  }

  const liveTradingEnabled = liveTradesEnabled();

  if (liveTradingEnabled && !rpc.url) {
    issues.push({
      level: "error",
      key: "HELIUS_RPC_URL/RPC_ENDPOINT/HELIUS_API_KEY",
      message: "Live trading is enabled without an RPC URL.",
    });
  }

  return {
    loadedAtMs: Date.now(),
    nodeEnv: clean(process.env.NODE_ENV),
    dbPath: resolveDbPath(),
    rpcUrl: rpc.url,
    rpcSource: rpc.source,
    websocketUrl,
    heliusSenderUrl,
    heliusTipAccount,
    webAuthConfigured: webAuthConfigured(),
    liveTradingEnabled,
    pump: {
      metadataProvider:
        clean(process.env.PUMP_METADATA_PROVIDER) ||
        clean(process.env.SLRD_METADATA_UPLOADER) ||
        "pump-frontend",
      liveCurveMemory: Math.max(
        10,
        intEnv(
          "SOLARD_PUMP_LIVE_CURVE_MEMORY",
          intEnv("SOLWAL_PUMP_LIVE_CURVE_MEMORY", 250),
        ),
      ),
      feedSource:
        clean(process.env.SOLARD_PUMP_FEED_SOURCE) ||
        clean(process.env.SOLWAL_PUMP_FEED_SOURCE),
    },
    issues,
  };
}

export function publicSolardConfig(config = loadSolardRuntimeConfig()) {
  return {
    ...config,
    rpcUrl: redactSecret(config.rpcUrl),
    websocketUrl: redactSecret(config.websocketUrl),
    heliusSenderUrl: redactSecret(config.heliusSenderUrl),
    heliusTipAccount: config.heliusTipAccount,
  };
}

let logged = false;

export function logSolardBootConfigOnce(): void {
  if (logged || process.env.SOLARD_BOOT_LOG === "0") return;
  logged = true;
  const config = publicSolardConfig();
  console.info(
    "[solard] boot",
    JSON.stringify(
      {
        dbPath: config.dbPath,
        rpcSource: config.rpcSource,
        rpcUrl: config.rpcUrl,
        websocketUrl: config.websocketUrl,
        heliusSenderConfigured: Boolean(config.heliusSenderUrl),
        heliusTipAccountConfigured: Boolean(config.heliusTipAccount),
        webAuthConfigured: config.webAuthConfigured,
        liveTradingEnabled: config.liveTradingEnabled,
        issues: config.issues,
      },
      null,
      2,
    ),
  );
}
