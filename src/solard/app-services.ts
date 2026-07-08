import { createTraderSowl, type Sowl } from "../index.js";
import {
  listTelegramSignals,
  upsertTelegramSignalSource,
  ingestTelegramSignal,
  updateTelegramSignalStatus,
  clearTelegramSignals,
  deleteTelegramSignalSource,
} from "../signals/telegram-signal-service.js";

export type SolardAppServices = {
  sowl: Sowl;
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
 * Keep route/command handlers as thin adapters over this object.
 */
export function createSolardAppServices(
  args: { rpcUrl?: string } = {},
): SolardAppServices {
  const sowl = createTraderSowl({ rpcUrl: args.rpcUrl });
  return {
    sowl,
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
