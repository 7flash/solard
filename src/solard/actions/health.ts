import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { configuredRpcUrl, liveTradesEnabled } from "./context.js";

function present(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function redactUrl(value: string | undefined): string | null {
  if (!value) return null;
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

export function healthAction(): Record<string, unknown> {
  const dbPath =
    process.env.SOWL_DB_PATH?.trim() ||
    process.env.SOLARD_DB_PATH?.trim() ||
    "./sowl.db";
  const absoluteDbPath = resolve(dbPath);
  const rpcUrl = configuredRpcUrl();
  return {
    ok: true,
    service: "solard",
    cwd: process.cwd(),
    db: {
      path: absoluteDbPath,
      exists: existsSync(absoluteDbPath),
    },
    rpc: {
      url: redactUrl(rpcUrl),
      configured: Boolean(rpcUrl),
      source: process.env.HELIUS_RPC_URL?.trim()
        ? "HELIUS_RPC_URL"
        : process.env.RPC_ENDPOINT?.trim()
          ? "RPC_ENDPOINT"
          : null,
    },
    env: {
      SOLARD_ENABLE_LIVE_TRADES: liveTradesEnabled(),
      SOLWAL_WEB_TOKEN: present("SOLWAL_WEB_TOKEN"),
      HELIUS_API_KEY: present("HELIUS_API_KEY"),
      HELIUS_SENDER_URL: present("HELIUS_SENDER_URL"),
      HELIUS_TIP_ACCOUNT:
        present("HELIUS_TIP_ACCOUNT") ||
        present("SOLWAL_HELIUS_TIP_ACCOUNT") ||
        present("SOWL_HELIUS_TIP_ACCOUNT"),
      JITO_BLOCK_ENGINE_URL: present("JITO_BLOCK_ENGINE_URL"),
      PINATA_JWT: present("PINATA_JWT"),
    },
  };
}
