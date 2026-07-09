import bgrun from "bgrun";

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
  isProcessRunning: (pid: number, command?: string) => Promise<boolean> | boolean;
};

export const bgrunSdk = bgrun as BgrunSdk;
export default bgrunSdk;

export function assertBgrunSdk(value: Partial<BgrunSdk> = bgrunSdk): BgrunSdk {
  const missing = [
    "handleRun",
    "handleStop",
    "getAllProcesses",
    "getManagedChildProcesses",
    "getProcess",
    "isProcessRunning",
  ].filter((key) => typeof (value as Record<string, unknown>)[key] !== "function");

  if (missing.length) {
    throw new Error(
      `bgrun SDK is missing required Solard lifecycle exports: ${missing.join(", ")}. ` +
        "Update bgrun to the Solard SDK finalization build.",
    );
  }

  return value as BgrunSdk;
}

export async function stopBgrunProcessByName(name: string): Promise<boolean> {
  const existing = bgrunSdk.getProcess(name);
  if (!existing) return false;
  await bgrunSdk.handleStop(name);
  return true;
}

export function normalizeBgrunProcess(row: BgrunProcess): Record<string, unknown> {
  return {
    ...row,
    name: row.name ?? "",
    pid: typeof row.pid === "number" ? row.pid : 0,
    command: row.command ?? "",
    workdir: row.workdir ?? row.directory ?? row.cwd ?? "",
    env: row.env ?? {},
  };
}
