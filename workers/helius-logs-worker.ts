#!/usr/bin/env bun
/**
 * Compatibility entrypoint.
 *
 * The Helius log indexer now lives in /indexer and does not import anything
 * from /src. Keep this file only so existing bgrun/process config can still
 * launch "workers/helius-logs-worker.ts".
 */
import { runIndexer } from "../indexer/main.js";

await runIndexer();
