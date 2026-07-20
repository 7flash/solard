import { PublicKey } from "@solana/web3.js";
import { HeliusSender, HttpRpcSender, sol } from "../index.ts";
import { loadSolardRuntimeConfig, resolveRpcUrl } from "../solard/config.ts";

export function liveTradingEnabled(): boolean {
  return loadSolardRuntimeConfig().liveTradingEnabled;
}

export function assertLiveTradeAllowed(context: string): void {
  const config = loadSolardRuntimeConfig();
  if (!config.liveTradingEnabled) {
    throw Object.assign(
      new Error(
        `${context} requested live execution, but live trading is disabled. Set SOLARD_ENABLE_LIVE_TRADES=1 only after reviewing dry-run output.`,
      ),
      { status: 403 },
    );
  }
  if (!config.rpcUrl) {
    throw Object.assign(
      new Error(
        `${context} requested live execution, but no RPC URL is configured.`,
      ),
      { status: 400 },
    );
  }
}

export function installWebTradeSenders(slrd: any): void {
  const rpcUrl = resolveRpcUrl().url;
  const senderUrl = process.env.HELIUS_SENDER_URL?.trim();
  if (senderUrl)
    slrd.registerSender(new HeliusSender(senderUrl, "helius-fast"));
  if (rpcUrl)
    slrd.registerSender(
      new HttpRpcSender(
        "helius-rpc",
        rpcUrl,
        "HELIUS_RPC_URL/RPC_ENDPOINT/HELIUS_API_KEY",
      ),
    );
}

export function parseSolLamports(
  value: string | undefined,
  fallback: string,
): bigint {
  return sol(value && value.trim() ? value : fallback).raw;
}

export function heliusTipAccount(context = "helius-fast live send"): PublicKey {
  const value =
    process.env.HELIUS_TIP_ACCOUNT?.trim() ||
    process.env.SOLWAL_HELIUS_TIP_ACCOUNT?.trim() ||
    process.env.SLRD_HELIUS_TIP_ACCOUNT?.trim();
  if (!value)
    throw Object.assign(new Error(`${context} requires HELIUS_TIP_ACCOUNT.`), {
      status: 400,
    });
  return new PublicKey(value);
}
