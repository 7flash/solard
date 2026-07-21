import {
  createTraderSolard,
  HeliusSender,
  HttpRpcSender,
  type Solard,
} from "../../index.ts";
import {
  liveTradeEnvHint,
  liveTradesEnabled as liveTradesEnabledFromEnv,
} from "../safety.ts";

export type SolardActionContext = {
  slrd: Solard;
  close(): void;
  liveTradesEnabled: boolean;
  rpcUrl?: string;
};

export type CreateSolardActionContextOptions = {
  slrd?: Solard;
  rpcUrl?: string;
  dbPath?: string;
  installSenders?: boolean;
};

export function configuredRpcUrl(): string | undefined {
  return (
    process.env.HELIUS_RPC_URL?.trim() ||
    process.env.RPC_ENDPOINT?.trim() ||
    undefined
  );
}

/** Re-export of the shared live-trading gate (all env aliases). */
export function liveTradesEnabled(): boolean {
  return liveTradesEnabledFromEnv();
}

export function assertLiveAllowed(
  ctx: SolardActionContext,
  action: string,
): void {
  if (!ctx.liveTradesEnabled) {
    throw new Error(
      `${action} requested live execution, but live trading is disabled. ${liveTradeEnvHint()}`,
    );
  }
}

export function installConfiguredSenders(slrd: Solard): void {
  const rpcUrl = configuredRpcUrl();
  const senderUrl = process.env.HELIUS_SENDER_URL?.trim();

  if (senderUrl) {
    slrd.registerSender(new HeliusSender(senderUrl, "helius-fast"));
  }

  if (rpcUrl) {
    slrd.registerSender(
      new HttpRpcSender("helius-rpc", rpcUrl, "HELIUS_RPC_URL/RPC_ENDPOINT"),
    );
  }
}

export function createSolardActionContext(
  options: CreateSolardActionContextOptions = {},
): SolardActionContext {
  const ownsSolard = !options.slrd;
  const rpcUrl = options.rpcUrl ?? configuredRpcUrl();
  const slrd =
    options.slrd ??
    createTraderSolard({
      rpcUrl,
      dbPath:
        options.dbPath ??
        process.env.SLRD_DB_PATH ??
        process.env.SOLARD_DB_PATH,
    });

  if (options.installSenders !== false) installConfiguredSenders(slrd);

  return {
    slrd,
    rpcUrl,
    liveTradesEnabled: liveTradesEnabled(),
    close: () => {
      if (ownsSolard) slrd.close();
    },
  };
}
