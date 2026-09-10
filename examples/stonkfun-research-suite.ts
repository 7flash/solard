#!/usr/bin/env bun
// Compatibility name from V13. The research engine is venue-neutral; Pump,
// PumpSwap and Raydium/LaunchLab all use the same durable replay surface.
import { runTokenResearch } from "./token-research-suite.ts";

await runTokenResearch().catch((error) => {
  process.stderr.write(
    `RESEARCH ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
