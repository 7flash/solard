import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { upsertProcessStatus } from "../db/terminal-store.js";
import { createMeasure, summarizeForMeasure } from "../measure.js";
import {
  resolveWorkerNames,
  WORKER_SPECS,
  type SolardStreamSource,
  type SolardWorkerName,
} from "./bgrun.js";

const serverWorkerMeasure = createMeasure("solard:server-workers");

export type ServerWorkerSupervisorOptions = {
  source?: SolardStreamSource | string | null;
  telegram?: boolean;
  restartOnExit?: boolean;
  stopDetachedBgrun?: boolean;
};

type ManagedChild = {
  name: SolardWorkerName;
  child: ChildProcessWithoutNullStreams;
  restarts: number;
  stopping: boolean;
};

export type ServerWorkerSupervisor = {
  readonly names: SolardWorkerName[];
  readonly running: () => Array<{
    name: SolardWorkerName;
    pid: number | undefined;
  }>;
  stop: (reason?: string) => Promise<void>;
};

function bunCommand(): string {
  const execPath = process.execPath;
  if (execPath && /bun(?:\.exe)?$/i.test(execPath)) return execPath;
  return process.platform === "win32" ? "bun.exe" : "bun";
}

function parseBunRunCommand(command: string): string[] {
  const parts = command.trim().split(/\s+/g);
  if (parts[0] !== "bun" || parts[1] !== "run" || parts.length < 3) {
    throw new Error(
      `Server worker supervisor only supports bun run commands: ${command}`,
    );
  }
  return parts.slice(1);
}

function writePrefixed(
  prefix: string,
  chunk: Buffer,
  out: NodeJS.WriteStream,
): void {
  const text = chunk.toString("utf8");
  for (const line of text.split(/\r?\n/g)) {
    if (!line.trim()) continue;
    out.write(`[${prefix}] ${line}\n`);
  }
}

function stopDetachedBgrunWorker(name: SolardWorkerName): void {
  const child = spawn(bunCommand(), ["x", "bgrun", "--stop", name], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: "ignore",
    detached: false,
    windowsHide: true,
  });
  const timer = setTimeout(
    () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // best effort only
      }
    },
    Number(process.env.SOLARD_BGRUN_STOP_TIMEOUT_MS ?? "8000"),
  );
  child.once("exit", () => clearTimeout(timer));
}

function launchChild(
  name: SolardWorkerName,
  restarts: number,
  restartOnExit: boolean,
  children: Map<SolardWorkerName, ManagedChild>,
): ManagedChild {
  const spec = WORKER_SPECS[name];
  const args = parseBunRunCommand(spec.command);
  const child = spawn(bunCommand(), args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SOLARD_WORKER_NAME: name,
      SOLARD_WORKER_SUPERVISOR: "server",
      SOLARD_EXPECTED_BUILD_ID: spec.buildId,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    windowsHide: true,
  });
  const managed: ManagedChild = { name, child, restarts, stopping: false };
  children.set(name, managed);

  child.stdout.on("data", (chunk) =>
    writePrefixed(name, chunk, process.stdout),
  );
  child.stderr.on("data", (chunk) =>
    writePrefixed(name, chunk, process.stderr),
  );

  upsertProcessStatus({
    name,
    kind: spec.kind,
    status: "server-supervised",
    data: {
      supervisor: "server",
      pid: child.pid ?? null,
      command: spec.command,
      buildId: spec.buildId,
      restarts,
    },
  });

  child.once("exit", (code, signal) => {
    children.delete(name);
    upsertProcessStatus({
      name,
      kind: spec.kind,
      status: managed.stopping ? "server-stopped" : "server-exited",
      error: managed.stopping
        ? null
        : `worker exited code=${code ?? "null"} signal=${signal ?? "null"}`,
      data: {
        supervisor: "server",
        pid: child.pid ?? null,
        command: spec.command,
        buildId: spec.buildId,
        restarts,
        code,
        signal,
      },
    });

    if (!managed.stopping && restartOnExit) {
      const nextRestarts = restarts + 1;
      const delay = Math.min(30_000, 500 * 2 ** Math.min(nextRestarts, 6));
      setTimeout(() => {
        if (!children.has(name))
          launchChild(name, nextRestarts, restartOnExit, children);
      }, delay).unref?.();
    }
  });

  return managed;
}

export function startServerWorkerSupervisor(
  options: ServerWorkerSupervisorOptions = {},
): ServerWorkerSupervisor {
  const names = resolveWorkerNames({
    source: options.source,
    telegram: options.telegram,
  });
  const restartOnExit = options.restartOnExit !== false;
  const stopDetached = options.stopDetachedBgrun !== false;
  const children = new Map<SolardWorkerName, ManagedChild>();

  serverWorkerMeasure.measureSync(
    {
      start: () => "start server worker supervisor",
      end: () => ({ names, supervisor: "server" }),
      catch: (error) => {
        throw error;
      },
    },
    () => {
      for (const name of names) {
        if (stopDetached) stopDetachedBgrunWorker(name);
        launchChild(name, 0, restartOnExit, children);
      }
      return { names };
    },
  );

  return {
    names,
    running: () =>
      [...children.values()].map((child) => ({
        name: child.name,
        pid: child.child.pid,
      })),
    stop: async (reason = "shutdown") => {
      await serverWorkerMeasure.measure(
        {
          start: () => "stop server worker supervisor",
          end: () => ({ reason, stopped: names.length }),
        },
        async () => {
          const pending = [...children.values()].map(
            (managed) =>
              new Promise<void>((resolve) => {
                const spec = WORKER_SPECS[managed.name];
                managed.stopping = true;
                upsertProcessStatus({
                  name: managed.name,
                  kind: spec.kind,
                  status: "server-stopping",
                  data: {
                    supervisor: "server",
                    pid: managed.child.pid ?? null,
                    command: spec.command,
                    buildId: spec.buildId,
                    reason,
                  },
                });
                const timer = setTimeout(
                  () => {
                    try {
                      managed.child.kill("SIGKILL");
                    } catch {
                      // already gone
                    }
                    resolve();
                  },
                  Number(process.env.SOLARD_WORKER_KILL_TIMEOUT_MS ?? "2500"),
                );
                managed.child.once("exit", () => {
                  clearTimeout(timer);
                  resolve();
                });
                try {
                  managed.child.kill("SIGTERM");
                } catch {
                  clearTimeout(timer);
                  resolve();
                }
              }),
          );
          await Promise.allSettled(pending);
          return summarizeForMeasure({ stopped: names });
        },
      );
    },
  };
}
