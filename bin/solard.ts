#!/usr/bin/env bun
import { startSolardConsole } from "../src/solard/start.js";
import { runCli, formatCliError } from "../src/cli.js";

function flag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "start") {
    return await startSolardConsole({
      host: flag(rest, "host"),
      port: flag(rest, "port"),
      open: rest.includes("--open"),
    });
  }
  return await runCli(process.argv.slice(2));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(formatCliError(error));
    process.exitCode = 1;
  });
