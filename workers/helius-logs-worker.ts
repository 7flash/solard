#!/usr/bin/env bun
/** Compatibility entrypoint. The Helius log indexer now lives in /indexer and imports nothing from /src. */
import { runIndexer } from "../indexer/main.js";
await runIndexer();
