import { createTraderSolard, type Solard } from "../index.ts";
import {
  loadSolardOverview,
  type SolardOverviewOptions,
} from "./overview-service.ts";
import {
  loadSolardPortfolio,
  type SolardPortfolioOptions,
} from "./portfolio-service.ts";
import { loadTokenHolders } from "./token-holder-service.ts";
import {
  listTelegramSignals,
  upsertTelegramSignalSource,
  ingestTelegramSignal,
  updateTelegramSignalStatus,
  clearTelegramSignals,
  deleteTelegramSignalSource,
} from "../signals/telegram-signal-service.ts";
import {
  addTokenToWatchGroup,
  clearCurrentSessionWatchGroup,
  createTokenWatchGroup,
  listPumpLiveState,
  removeTokenFromWatchGroup,
} from "../pump/services/pump-live-store.ts";

export type SolardAppServices = {
  slrd: Solard;
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
  const slrd = createTraderSolard({ rpcUrl: args.rpcUrl });
  return {
    slrd,
    overview: {
      load: (options) => loadSolardOverview(slrd, options),
    },
    portfolio: {
      load: (options) => loadSolardPortfolio(slrd, options),
    },
    tokenHolders: {
      load: (input) => loadTokenHolders(slrd, input),
    },
    pumpLive: {
      list: () => listPumpLiveState(),
      createGroup: (name) => createTokenWatchGroup(name),
      addToken: (input) => addTokenToWatchGroup(input),
      removeToken: (groupId, mint) => removeTokenFromWatchGroup(groupId, mint),
      clearCurrentSession: () => clearCurrentSessionWatchGroup(),
    },
    signals: {
      list: () => listTelegramSignals(slrd),
      upsertSource: (input) => upsertTelegramSignalSource(slrd, input),
      deleteSource: (id) => deleteTelegramSignalSource(slrd, id),
      ingest: (input) => ingestTelegramSignal(slrd, input),
      updateStatus: (input) => updateTelegramSignalStatus(slrd, input),
      clear: () => clearTelegramSignals(slrd),
    },
    close: () => slrd.close(),
  };
}
