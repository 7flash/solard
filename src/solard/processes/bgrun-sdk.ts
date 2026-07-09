import { createRequire } from "node:module";

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
  getAllProcesses: () => BgrunProcess[];
  getProcess: (name: string) => BgrunProcess | null | undefined;
  isProcessRunning: (pid: number, command?: string) => Promise<boolean> | boolean;
  terminateProcess: (pid: number, force?: boolean) => Promise<unknown> | unknown;
  removeProcessByName: (name: string) => Promise<unknown> | unknown;
};

let cachedSdk: BgrunSdk | null = null;
let cachedAsyncSdk: Promise<BgrunSdk> | null = null;

function unwrapBgrunModule(mod: unknown): BgrunSdk {
  const value = ((mod as { default?: unknown })?.default ?? mod) as Partial<BgrunSdk>;
  const missing = [
    "handleRun",
    "getAllProcesses",
    "getProcess",
    "isProcessRunning",
    "terminateProcess",
    "removeProcessByName",
  ].filter((key) => typeof (value as Record<string, unknown>)[key] !== "function");

  if (missing.length) {
    throw new Error(`bgrun SDK is missing required exports: ${missing.join(", ")}`);
  }

  return value as BgrunSdk;
}

export function getBgrunSdkSync(): BgrunSdk {
  if (cachedSdk) return cachedSdk;
  const require = createRequire(import.meta.url);
  cachedSdk = unwrapBgrunModule(require("bgrun"));
  return cachedSdk;
}

export async function getBgrunSdk(): Promise<BgrunSdk> {
  if (cachedSdk) return cachedSdk;
  if (!cachedAsyncSdk) {
    cachedAsyncSdk = import("bgrun").then((mod) => {
      cachedSdk = unwrapBgrunModule(mod);
      return cachedSdk;
    });
  }
  return await cachedAsyncSdk;
}

export function safeGetBgrunSdkSync(): BgrunSdk | null {
  try {
    return getBgrunSdkSync();
  } catch {
    return null;
  }
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
