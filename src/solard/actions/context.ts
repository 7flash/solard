import {
  createTraderSowl,
  HeliusSender,
  HttpRpcSender,
  type Sowl,
} from "../../index.js";

export type SolardActionContext = {
  sowl: Sowl;
  close(): void;
  liveTradesEnabled: boolean;
  rpcUrl?: string;
};

export type CreateSolardActionContextOptions = {
  sowl?: Sowl;
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

export function liveTradesEnabled(): boolean {
  return process.env.SOLARD_ENABLE_LIVE_TRADES?.trim() === "1";
}

export function assertLiveAllowed(
  ctx: SolardActionContext,
  action: string,
): void {
  if (!ctx.liveTradesEnabled) {
    throw new Error(
      `${action} requested live execution, but SOLARD_ENABLE_LIVE_TRADES=1 is not set. Run a dry-run/simulation first, then opt in explicitly.`,
    );
  }
}

export function installConfiguredSenders(sowl: Sowl): void {
  const rpcUrl = configuredRpcUrl();
  const senderUrl = process.env.HELIUS_SENDER_URL?.trim();

  if (senderUrl) {
    sowl.registerSender(new HeliusSender(senderUrl, "helius-fast"));
  }

  if (rpcUrl) {
    sowl.registerSender(
      new HttpRpcSender("helius-rpc", rpcUrl, "HELIUS_RPC_URL/RPC_ENDPOINT"),
    );
  }
}

export function createSolardActionContext(
  options: CreateSolardActionContextOptions = {},
): SolardActionContext {
  const ownsSowl = !options.sowl;
  const rpcUrl = options.rpcUrl ?? configuredRpcUrl();
  const sowl =
    options.sowl ??
    createTraderSowl({
      rpcUrl,
      dbPath:
        options.dbPath ??
        process.env.SOWL_DB_PATH ??
        process.env.SOLARD_DB_PATH,
    });

  if (options.installSenders !== false) installConfiguredSenders(sowl);

  return {
    sowl,
    rpcUrl,
    liveTradesEnabled: liveTradesEnabled(),
    close: () => {
      if (ownsSowl) sowl.close();
    },
  };
}
