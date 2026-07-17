/**
 * @deprecated Compatibility facade. New code must import from shared/db.ts.
 * This file owns no schemas, tables, views, or Database instance.
 */
export * from "./db.js";

export type TerminalFeedSource =
  "helius" | "pumpportal" | "both" | null | undefined;
