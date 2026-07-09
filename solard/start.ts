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

function bunCommand(): string {
  const execPath = process.execPath;
  if (execPath && /bun(?:\.exe)?$/i.test(execPath)) return execPath;
  return process.platform === "win32" ? "bun.exe" : "bun";
}

function openUrl(url: string): void {
  const command =
    process.platform === "win32"
      ? "start"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";

  const args = process.platform === "win32" ? ["", url] : [url];
  spawn(command, args, {
    shell: true,
    detached: true,
    stdio: "ignore",
  }).unref();
}

/**
 * Starts the Solard console through server.ts, not through a parallel tradjs
 * process. This keeps the CLI start path and `bun run server.ts` on the same
 * lifecycle: server.ts owns worker startup and worker shutdown.
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

  const args = ["run", "server.ts", "--host", host, "--port", port];
  const child = spawn(bunCommand(), args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      SOLARD_HOST: host,
      SOLARD_PORT: port,
      SOLWAL_HOST: host,
      SOLWAL_PORT: port,
      SOLARD_SERVER_WORKERS: process.env.SOLARD_SERVER_WORKERS ?? "1",
    },
  });

  if (shouldOpen) openUrl(`http://${host}:${port}`);

  return await new Promise<number>((resolve) => {
    child.on("exit", (code, signal) => {
      if (typeof code === "number") resolve(code);
      else resolve(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
    });
    child.on("error", (error) => {
      console.error("[solard:start] failed to launch server.ts", error);
      resolve(1);
    });
  });
}
