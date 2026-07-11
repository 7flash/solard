import {
  SOLARD_DB_PATH,
  terminalDb,
  type TerminalDatabase,
} from "../shared/terminal-db.js";

export {
  getTerminalToken,
  listProcessStatus,
  listTerminalFeed,
  listWorkerErrors,
  pruneIngestionKeys,
  recomputeIndicators,
  recordWorkerError,
  rememberIngestionKey,
  terminalStoreStats,
  upsertProcessStatus,
  upsertTerminalIndicator,
  upsertTerminalToken,
  upsertTerminalTrade,
} from "../shared/terminal-repo.js";

export type IndexerDb = {
  db: TerminalDatabase;
  path: string;
  close(): void;
};

export function openIndexerDb(): IndexerDb {
  return {
    db: terminalDb,
    path: SOLARD_DB_PATH,
    close: () => undefined,
  };
}
