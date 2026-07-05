import { existsSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SowlConfig, SowlScriptEntry } from "./config.js";

const CONFIG_FILES = ["sowl.config.ts", "sowl.config.mts", "sowl.config.js", "sowl.config.mjs"];

export type ResolvedScript = {
  id: string;
  path: string;
  description?: string;
  source: "path" | "config" | "scripts-directory";
};

async function readConfig(cwd: string): Promise<SowlConfig> {
  for (const name of CONFIG_FILES) {
    const path = resolve(cwd, name);
    if (!existsSync(path)) continue;
    const module = await import(`${pathToFileURL(path).href}?t=${Date.now()}`) as { default?: SowlConfig };
    return module.default ?? {};
  }
  return {};
}

function pathFromEntry(entry: SowlScriptEntry): { path: string; description?: string } {
  return typeof entry === "string" ? { path: entry } : entry;
}

function directCandidates(ref: string, cwd: string): string[] {
  const path = isAbsolute(ref) ? ref : resolve(cwd, ref);
  if (extname(path)) return [path];
  return [path, `${path}.ts`, `${path}.mts`, `${path}.js`, `${path}.mjs`];
}

export async function listScripts(cwd = process.cwd()): Promise<Array<{ id: string; path: string; description?: string }>> {
  const config = await readConfig(cwd);
  return Object.entries(config.scripts ?? {}).map(([id, value]) => {
    const entry = pathFromEntry(value);
    return { id, path: resolve(cwd, entry.path), description: entry.description };
  });
}

export async function resolveScript(ref: string, cwd = process.cwd()): Promise<ResolvedScript> {
  for (const candidate of directCandidates(ref, cwd)) {
    if (existsSync(candidate)) {
      return { id: basename(ref, extname(ref)), path: candidate, source: "path" };
    }
  }

  const config = await readConfig(cwd);
  const configured = config.scripts?.[ref];
  if (configured) {
    const entry = pathFromEntry(configured);
    const path = resolve(cwd, entry.path);
    if (!existsSync(path)) throw new Error(`Configured script '${ref}' does not exist: ${path}`);
    return { id: ref, path, description: entry.description, source: "config" };
  }

  for (const extension of [".ts", ".mts", ".js", ".mjs"]) {
    const path = resolve(cwd, "scripts", `${ref}${extension}`);
    if (existsSync(path)) return { id: ref, path, source: "scripts-directory" };
  }
  throw new Error(`Unknown script: ${ref}. Use a file path, create scripts/${ref}.ts, or register it in sowl.config.ts.`);
}

export async function runScript(ref: string, argv: string[], cwd = process.cwd()): Promise<number> {
  const script = await resolveScript(ref, cwd);
  const child = Bun.spawn([process.execPath, script.path, ...argv], {
    cwd,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}
