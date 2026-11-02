import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

const encode = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v);
/** One writer per bot (its existing PID lock); shared index uses a short process lock. */
export function recordBotSnapshot(root: string, wallet: string, mint: string, state: unknown, event: string, detail?: unknown) {
  const folder = join(root, "bot-history");
  mkdirSync(folder, { recursive: true });
  const at = new Date().toISOString();
  appendFileSync(join(folder, `${wallet}-${mint}.jsonl`), encode({ at, event, wallet, mint, state, detail }) + "\n");
  const lock = join(root, "bot-positions.json.lock");
  let fd: number | undefined;
  for (let n = 0; n < 20; n++) {
    try { fd = openSync(lock, "wx"); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; Bun.sleepSync(10); }
  }
  if (fd == null) throw new Error("Shared positions index is locked; bot history remains durable");
  try {
    const positions: unknown[] = [];
    for (const name of readdirSync(root).filter((name: string) => /^bot-.*\.json$/.test(name) && name !== "bot-positions.json")) {
      const s = JSON.parse(readFileSync(join(root, name), "utf8"));
      positions.push({ source: name, phase: s.phase, position: s.position, pending: s.pending,
        health: s.health ?? "unverified", strategy: s.strategy ?? null, range: s.rangeSpec ?? null, lastResult: s.lastResult ?? null,
        sellAtLoss: s.sellAtLoss ?? false, lastSample: s.prices?.at(-1) ?? null });
    }
    const tmp = join(root, `bot-positions.json.${process.pid}.tmp`);
    writeFileSync(tmp, encode({ updatedAt: at, positions }));
    renameSync(tmp, join(root, "bot-positions.json"));
  } finally { closeSync(fd); unlinkSync(lock); }
}
