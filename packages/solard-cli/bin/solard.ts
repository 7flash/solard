#!/usr/bin/env bun
// Load this repo's .config.toml (bgrun-style: [section] key -> SECTION_KEY)
// before the CLI starts, so `slrd` uses the solwal wallets from any shell.
// Variables already set in the environment win; SLRD_CONFIG_TOML overrides the file.
const configPath = process.env.SLRD_CONFIG_TOML ?? new URL("../../../.config.toml", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const file = Bun.file(configPath);
if (await file.exists()) {
  const toml = Bun.TOML.parse(await file.text()) as Record<string, unknown>;
  for (const [section, value] of Object.entries(toml)) {
    const entries = value && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value).map(([key, v]) => [`${section}_${key}`.toUpperCase(), String(v)] as const)
      : [[section.toUpperCase(), String(value)] as const];
    for (const [name, v] of entries) process.env[name] ??= v;
  }
}
await import("@solard/cli/bin/solard.ts");
