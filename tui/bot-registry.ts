/** Which bots the slrd-bots daemon should run: .range-bots/bots.json. The TUI and range-term edit it; the daemon follows it. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** mode "target" (default): trade the wallet's whole balance toward the budget's target inventory.
 * mode "engine": the older per-step range engines that only track their own fills. */
export type BotEntry = { wallet: string; mint: string; amount: string; addedAt: number; mode?: "target" | "engine"; buysPaused?: boolean;
  /** Opened automatically by the migration watcher. */
  auto?: boolean;
  /** Opened by the smart-wallet signal (counts against SLRD_SMART_MAX, not the migration limit). */
  smart?: boolean;
  /** The followable wallets whose buys opened this bot: when half of them have sold out, so does the bot. */
  signal?: string[];
  /** You keep this range: the daemon never moves it, even when the price has left it. */
  rangeLocked?: boolean;
  /** Your size before the range was moved to a smaller bag; an empty bot goes back to it. */
  baseAmount?: string };
export const registryPath = (root: string) => join(root, ".range-bots", "bots.json");
export const daemonPidPath = (root: string) => join(root, ".range-bots", "daemon.pid");

export function readRegistry(root: string): BotEntry[] {
  try {
    const value = JSON.parse(readFileSync(registryPath(root), "utf8"));
    return Array.isArray(value?.bots) ? value.bots.filter((b: BotEntry) => b?.wallet && b?.mint) : [];
  } catch { return []; }
}
function writeRegistry(root: string, bots: BotEntry[]) {
  mkdirSync(join(root, ".range-bots"), { recursive: true });
  const path = registryPath(root), tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ bots }, null, 2) + "\n"); renameSync(tmp, path);
}
export function addBot(root: string, entry: Omit<BotEntry, "addedAt">) {
  const existing = readRegistry(root).find(b => b.wallet === entry.wallet && b.mint === entry.mint);
  const bots = readRegistry(root).filter(b => !(b.wallet === entry.wallet && b.mint === entry.mint));
  bots.push({ mode: existing?.mode ?? "target", ...entry, addedAt: Date.now() }); writeRegistry(root, bots);
}
export function updateBot(root: string, wallet: string, mint: string, patch: Partial<BotEntry>) {
  writeRegistry(root, readRegistry(root).map(b => b.wallet === wallet && b.mint === mint ? { ...b, ...patch } : b));
}
export function removeBot(root: string, wallet: string, mint: string) {
  writeRegistry(root, readRegistry(root).filter(b => !(b.wallet === wallet && b.mint === mint)));
}
/** PID of the running daemon, or null. */
export function daemonPid(root: string): number | null {
  if (!existsSync(daemonPidPath(root))) return null;
  const pid = Number(readFileSync(daemonPidPath(root), "utf8").trim());
  try { process.kill(pid, 0); return pid; } catch { return null; }
}
