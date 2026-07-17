import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type StateFile = {
  version: 2;
  updatedAtMs: number;
  mints: Record<string, number>;
};

type PumpDiscoveryStateOptions = {
  flushMs?: number;
  maxAgeMs?: number;
};

export class PumpDiscoveryState {
  private readonly mints = new Map<string, number>();
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushMs: number;
  private readonly maxAgeMs: number;

  constructor(
    private readonly path: string,
    options: PumpDiscoveryStateOptions = {},
  ) {
    this.flushMs = Math.max(250, Math.trunc(options.flushMs ?? 2_000));
    this.maxAgeMs = Math.max(
      60_000,
      Math.trunc(options.maxAgeMs ?? 60 * 60_000),
    );
    this.load();
    this.prune(this.maxAgeMs);
  }

  has(mint: string): boolean {
    return this.mints.has(mint);
  }

  add(mint: string, discoveredAtMs = Date.now()): void {
    if (!mint) return;
    const atMs =
      Number.isFinite(discoveredAtMs) && discoveredAtMs > 0
        ? discoveredAtMs
        : Date.now();
    if (this.mints.get(mint) === atMs) return;
    this.mints.set(mint, atMs);
    this.markDirty();
  }

  delete(mint: string): void {
    if (this.mints.delete(mint)) this.markDirty();
  }

  size(): number {
    return this.mints.size;
  }

  prune(maxAgeMs = this.maxAgeMs, now = Date.now()): number {
    const cutoff = now - Math.max(60_000, maxAgeMs);
    let deleted = 0;
    for (const [mint, discoveredAtMs] of this.mints) {
      if (discoveredAtMs >= cutoff) continue;
      this.mints.delete(mint);
      deleted++;
    }
    if (deleted) this.markDirty();
    return deleted;
  }

  save(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const file: StateFile = {
      version: 2,
      updatedAtMs: Date.now(),
      mints: Object.fromEntries([...this.mints.entries()].sort()),
    };
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(file)}\n`, "utf8");
    renameSync(temporary, this.path);
    this.dirty = false;
  }

  close(): void {
    this.save();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.save(), this.flushMs);
    (this.flushTimer as any).unref?.();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(
        readFileSync(this.path, "utf8"),
      ) as Partial<StateFile>;
      if (![1, 2].includes(Number(parsed.version)) || !parsed.mints) return;
      for (const [mint, atMs] of Object.entries(parsed.mints)) {
        const value = Number(atMs);
        if (mint && Number.isFinite(value) && value > 0)
          this.mints.set(mint, value);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.warn("[solard:pump] discovery state load failed", error);
      }
    }
  }
}
