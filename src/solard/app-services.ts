import { createTraderSowl, type Sowl } from "../index.js";
import {
  loadSolardOverview,
  type SolardOverviewOptions,
} from "./overview-service.js";
import {
  loadSolardPortfolio,
  type SolardPortfolioOptions,
} from "./portfolio-service.js";
import { loadTokenHolders } from "./token-holder-service.js";
import {
  listTelegramSignals,
  upsertTelegramSignalSource,
  ingestTelegramSignal,
  updateTelegramSignalStatus,
  clearTelegramSignals,
  deleteTelegramSignalSource,
} from "../signals/telegram-signal-service.js";
import {
  addTokenToWatchGroup,
  clearCurrentSessionWatchGroup,
  createTokenWatchGroup,
  listPumpLiveState,
  removeTokenFromWatchGroup,
} from "../pump/services/pump-live-store.js";

export type SolardAppServices = {
  sowl: Sowl;
  overview: {
    load(
      options?: SolardOverviewOptions,
    ): ReturnType<typeof loadSolardOverview>;
  };
  portfolio: {
    load(
      options?: SolardPortfolioOptions,
    ): ReturnType<typeof loadSolardPortfolio>;
  };
  tokenHolders: {
    load(
      input: Parameters<typeof loadTokenHolders>[1],
    ): ReturnType<typeof loadTokenHolders>;
  };
  pumpLive: {
    list(): ReturnType<typeof listPumpLiveState>;
    createGroup(name: string): ReturnType<typeof createTokenWatchGroup>;
    addToken(
      input: Parameters<typeof addTokenToWatchGroup>[0],
    ): ReturnType<typeof addTokenToWatchGroup>;
    removeToken(
      groupId: string,
      mint: string,
    ): ReturnType<typeof removeTokenFromWatchGroup>;
    clearCurrentSession(): ReturnType<typeof clearCurrentSessionWatchGroup>;
  };
  signals: {
    list(): ReturnType<typeof listTelegramSignals>;
    upsertSource(
      input: Parameters<typeof upsertTelegramSignalSource>[1],
    ): ReturnType<typeof upsertTelegramSignalSource>;
    deleteSource(id: string): ReturnType<typeof deleteTelegramSignalSource>;
    ingest(
      input: Parameters<typeof ingestTelegramSignal>[1],
    ): ReturnType<typeof ingestTelegramSignal>;
    updateStatus(
      input: Parameters<typeof updateTelegramSignalStatus>[1],
    ): ReturnType<typeof updateTelegramSignalStatus>;
    clear(): ReturnType<typeof clearTelegramSignals>;
  };
  close(): void;
};

/**
 * Shared app service factory for CLI commands and web API routes.
 * Route/command handlers should be thin adapters over this object or over
 * service modules in src/solard, src/pump, src/signals, src/launches, and src/tx.
 */
export function createSolardAppServices(
  args: { rpcUrl?: string } = {},
): SolardAppServices {
  const sowl = createTraderSowl({ rpcUrl: args.rpcUrl });
  return {
    sowl,
    overview: {
      load: (options) => loadSolardOverview(sowl, options),
    },
    portfolio: {
      load: (options) => loadSolardPortfolio(sowl, options),
    },
    tokenHolders: {
      load: (input) => loadTokenHolders(sowl, input),
    },
    pumpLive: {
      list: () => listPumpLiveState(),
      createGroup: (name) => createTokenWatchGroup(name),
      addToken: (input) => addTokenToWatchGroup(input),
      removeToken: (groupId, mint) => removeTokenFromWatchGroup(groupId, mint),
      clearCurrentSession: () => clearCurrentSessionWatchGroup(),
    },
    signals: {
      list: () => listTelegramSignals(sowl),
      upsertSource: (input) => upsertTelegramSignalSource(sowl, input),
      deleteSource: (id) => deleteTelegramSignalSource(sowl, id),
      ingest: (input) => ingestTelegramSignal(sowl, input),
      updateStatus: (input) => updateTelegramSignalStatus(sowl, input),
      clear: () => clearTelegramSignals(sowl),
    },
    close: () => sowl.close(),
  };
}
