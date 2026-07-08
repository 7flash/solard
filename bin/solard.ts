#!/usr/bin/env bun
import { startSolardConsole } from "../src/solard/start.js";

function flag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(
      `solard\n\nCommands:\n  solard start [--host 127.0.0.1] [--port 3000] [--open]\n`,
    );
    return;
  }
  if (command === "start") {
    process.exitCode = await startSolardConsole({
      host: flag(rest, "host"),
      port: flag(rest, "port"),
      open: rest.includes("--open"),
    });
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
