import { processMeasure, summarizeForMeasure } from "../measure.js";
import {
  listProcessStatus,
  upsertProcessStatus,
} from "../db/terminal-store.js";

export type SolardWorkerName =
  | "solard-pump-creates"
  | "solard-pump-trades"
  | "solard-reconciler"
  | "solard-telegram-signals";

export type WorkerSpec = {
  name: SolardWorkerName;
  kind: string;
  command: string;
  env?: Record<string, string>;
};

const ROOT = process.cwd();

export const WORKER_SPECS: Record<SolardWorkerName, WorkerSpec> = {
  "solard-pump-creates": {
    name: "solard-pump-creates",
    kind: "stream",
    command: "bun run ./src/solard/workers/pump-create-worker.ts",
  },
  "solard-pump-trades": {
    name: "solard-pump-trades",
    kind: "stream",
    command: "bun run ./src/solard/workers/pump-trade-worker.ts",
  },
  "solard-reconciler": {
    name: "solard-reconciler",
    kind: "reconciler",
    command: "bun run ./src/solard/workers/reconciler-worker.ts",
  },
  "solard-telegram-signals": {
    name: "solard-telegram-signals",
    kind: "signals",
    command: "bun run ./src/solard/workers/telegram-signal-worker.ts",
  },
};

function decode(stdout: Uint8Array | null | undefined): string {
  return stdout ? new TextDecoder().decode(stdout).trim() : "";
}

function runBgrun(args: string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const proc = Bun.spawnSync({
    cmd: ["bun", "x", "bgrun", ...args],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  return {
    exitCode: proc.exitCode,
    stdout: decode(proc.stdout),
    stderr: decode(proc.stderr),
  };
}

export function listBgrunProcesses(): Array<Record<string, unknown>> {
  return processMeasure.measureSync(
    {
      start: () => "bgrun list",
      end: (rows) => ({ result: summarizeForMeasure(rows) }),
    },
    () => {
      const result = runBgrun(["--json"]);
      if (result.exitCode !== 0) return [];
      try {
        const parsed = JSON.parse(result.stdout);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },
  );
}

export async function ensureBgrunWorker(
  name: SolardWorkerName,
  restart = false,
): Promise<Record<string, unknown>> {
  const spec = WORKER_SPECS[name];
  return await processMeasure.measure(
    {
      start: () => `ensure ${name}`,
      end: (result) => ({ result: summarizeForMeasure(result) }),
      catch: (error) => {
        upsertProcessStatus({
          name,
          kind: spec.kind,
          status: "error",
          error,
          data: { command: spec.command, phase: "ensure" },
        });
        throw error;
      },
    },
    async () => {
      const rows = listBgrunProcesses();
      const exists = rows.some((row) => String(row.name ?? "") === name);
      const args =
        restart && exists
          ? ["--restart", name]
          : exists
            ? []
            : [
                "--name",
                name,
                "--command",
                spec.command,
                "--directory",
                ROOT,
                "--force",
              ];

      if (args.length > 0) {
        const result = runBgrun(args);
        if (result.exitCode !== 0) {
          throw new Error(
            `bgrun ${name} failed: ${result.stderr || result.stdout || result.exitCode}`,
          );
        }
      }

      upsertProcessStatus({
        name,
        kind: spec.kind,
        status: exists && !restart ? "already-running" : "started",
        data: { command: spec.command, restart },
      });

      return {
        name,
        kind: spec.kind,
        running: true,
        restarted: restart,
        command: spec.command,
      };
    },
  );
}

export async function ensureWorkerGroup(
  args: { telegram?: boolean; restart?: boolean } = {},
): Promise<Record<string, unknown>> {
  const workers: SolardWorkerName[] = [
    "solard-pump-creates",
    "solard-pump-trades",
    "solard-reconciler",
  ];
  if (args.telegram || process.env.SOLARD_TELEGRAM_SIGNALS === "1") {
    workers.push("solard-telegram-signals");
  }
  const results = [];
  for (const name of workers) {
    results.push(await ensureBgrunWorker(name, args.restart === true));
    await Bun.sleep(350);
  }
  return { workers: results, processStatus: listProcessStatus() };
}

export function stopBgrunWorker(
  name: SolardWorkerName,
): Record<string, unknown> {
  return processMeasure.measureSync(
    {
      start: () => `stop ${name}`,
      end: (result) => ({ result }),
    },
    () => {
      const result = runBgrun(["--stop", name]);
      upsertProcessStatus({
        name,
        kind: WORKER_SPECS[name].kind,
        status: result.exitCode === 0 ? "stopped" : "stop-failed",
        data: { stdout: result.stdout },
        error: result.exitCode === 0 ? null : result.stderr,
      });
      return {
        name,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  );
}
