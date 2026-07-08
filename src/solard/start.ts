import { spawn } from "node:child_process";

export type SolardStartOptions = {
  host?: string;
  port?: string | number;
  cwd?: string;
  open?: boolean;
};

function boolEnv(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Starts the local TradJS admin console. This helper is intended to back
 * `npx solard start` and any future `solard start` CLI command.
 */
export async function startSolardConsole(
  options: SolardStartOptions = {},
): Promise<number> {
  const host = String(
    options.host ??
      process.env.SOLARD_HOST ??
      process.env.SOLWAL_HOST ??
      "127.0.0.1",
  );
  const port = String(
    options.port ??
      process.env.SOLARD_PORT ??
      process.env.SOLWAL_PORT ??
      "3000",
  );
  const cwd = options.cwd ?? process.cwd();
  const shouldOpen = options.open ?? boolEnv("SOLARD_OPEN");

  const args = ["tradjs", "serve", "--host", host, "--port", port];
  const child = spawn("bunx", args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      SOLARD_HOST: host,
      SOLARD_PORT: port,
    },
  });

  if (shouldOpen) {
    const url = `http://${host}:${port}`;
    const command =
      process.platform === "win32"
        ? "start"
        : process.platform === "darwin"
          ? "open"
          : "xdg-open";
    spawn(command, [url], {
      shell: true,
      detached: true,
      stdio: "ignore",
    }).unref();
  }

  return await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}
