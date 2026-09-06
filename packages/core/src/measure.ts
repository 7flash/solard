/**
 * Legacy measure-fn compatibility facade.
 *
 * New core code should import `createSolardMeasure`, `measured` and
 * `measuredSync` from `core/log.ts` / `core/measured.ts`.
 *
 * This module intentionally preserves the older raw measure-fn export names so
 * workers and launch tooling can migrate without a flag day. Configuration,
 * redaction policy, shared scopes and error summarization all come from the
 * canonical core/log.ts implementation.
 */
import { configureSolardMeasure } from "./core/log.ts";

configureSolardMeasure();

export {
  apiMeasure,
  compactId,
  configureSolardMeasure,
  createMeasure,
  DB_RETRY,
  dbMeasure,
  indexerMeasure,
  processMeasure,
  rawMeasure as measure,
  rawMeasureSync as measureSync,
  safeStringify,
  summarizeError,
  summarizeForMeasure,
  workerMeasure,
} from "./core/log.ts";
