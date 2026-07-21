import { PublicKey } from "@solana/web3.js";
import { HeliusSender, HttpRpcSender, sol } from "../index.ts";
import { resolveRpcUrl } from "../solard/config.ts";
import {
  liveTradeEnvHint,
  liveTradesEnabled,
} from "../solard/safety.ts";

export function liveTradingEnabled(): boolean {
  return liveTradesEnabled();
}

export function assertLiveTradeAllowed(context: string): void {
  if (!liveTradesEnabled()) {
    throw Object.assign(
      new Error(
        `${context} requested live execution, but live trading is disabled. ${liveTradeEnvHint()}`,
      ),
      { status: 403 },
    );
  }
  if (!resolveRpcUrl().url) {
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
