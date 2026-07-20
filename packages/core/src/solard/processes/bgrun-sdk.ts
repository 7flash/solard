import bgrun, * as bgrunModule from "bgrun";

export type BgrunProcess = {
  name?: string;
  pid?: number;
  command?: string;
  directory?: string;
  workdir?: string;
  cwd?: string;
  env?: Record<string, unknown>;
  [key: string]: unknown;
};

export type BgrunRunInput = {
  action: "run";
  name: string;
  command: string;
  directory: string;
  env?: Record<string, string>;
  force?: boolean;
  remoteName?: string;
};

export type BgrunSdk = {
  handleRun: (input: BgrunRunInput) => Promise<unknown> | unknown;
  handleStop: (name: string) => Promise<unknown> | unknown;
  getAllProcesses: () => BgrunProcess[];
  getManagedChildProcesses: (parentName: string) => BgrunProcess[];
  getProcess: (name: string) => BgrunProcess | null | undefined;
  isProcessRunning: (
    pid: number,
    command?: string,
  ) => Promise<boolean> | boolean;
};

function hasSdkShape(value: unknown): value is BgrunSdk {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<keyof BgrunSdk, unknown>;

  return (
    typeof row.handleRun === "function" &&
    typeof row.handleStop === "function" &&
    typeof row.getAllProcesses === "function" &&
    typeof row.getManagedChildProcesses === "function" &&
    typeof row.getProcess === "function" &&
    typeof row.isProcessRunning === "function"
  );
}

function resolveBgrunSdk(): BgrunSdk {
  const direct = bgrun as Record<string, unknown> | null | undefined;
  const module = bgrunModule as Record<string, unknown>;

  const candidates = [
    direct,
    direct?.default,
    module,
    module.default,
    (module.default as Record<string, unknown> | null | undefined)?.default,
  ];

  for (const candidate of candidates) {
    if (hasSdkShape(candidate)) return candidate;
  }

  const keys = new Set<string>();
  for (const candidate of candidates) {
    if (
      candidate &&
      (typeof candidate === "object" || typeof candidate === "function")
    ) {
      for (const key of Object.keys(candidate)) {
        keys.add(key);
      }
    }
  }

  throw new Error(
    `bgrun SDK is missing required Solard lifecycle exports. ` +
      `Found exports: ${Array.from(keys).sort().join(", ") || "(none)"}. ` +
      `Update bgrun to the Solard SDK finalization build and ensure package exports src/api.`,
  );
}

export const bgrunSdk = resolveBgrunSdk();
export default bgrunSdk;

export function assertBgrunSdk(value: Partial<BgrunSdk> = bgrunSdk): BgrunSdk {
  if (!hasSdkShape(value)) return resolveBgrunSdk();
  return value;
}

export async function stopBgrunProcessByName(name: string): Promise<boolean> {
  const sdk = assertBgrunSdk();
  const existing = sdk.getProcess(name);
  if (!existing) return false;
  await sdk.handleStop(name);
  return true;
}

export function normalizeBgrunProcess(
  row: BgrunProcess,
): Record<string, unknown> {
  return {
    ...row,
    name: row.name ?? "",
    pid: typeof row.pid === "number" ? row.pid : 0,
    command: row.command ?? "",
    workdir: row.workdir ?? row.directory ?? row.cwd ?? "",
    env: row.env ?? {},
  };
}
