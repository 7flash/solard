import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type StateFile = {
  version: 1;
  updatedAtMs: number;
  mints: Record<string, number>;
};

export class PumpDiscoveryState {
  private readonly mints = new Map<string, number>();
  private dirty = false;

  constructor(private readonly path: string) {
    this.load();
  }

  has(mint: string): boolean {
    return this.mints.has(mint);
  }

  add(mint: string, discoveredAtMs = Date.now()): void {
    if (!mint) return;
    if (this.mints.get(mint) === discoveredAtMs) return;
    this.mints.set(mint, discoveredAtMs);
    this.dirty = true;
    this.save();
  }

  delete(mint: string): void {
    if (this.mints.delete(mint)) {
      this.dirty = true;
      this.save();
    }
  }

  size(): number {
    return this.mints.size;
  }

  save(): void {
    if (!this.dirty) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const file: StateFile = {
      version: 1,
      updatedAtMs: Date.now(),
      mints: Object.fromEntries([...this.mints.entries()].sort()),
    };
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    renameSync(temporary, this.path);
    this.dirty = false;
  }

  private load(): void {
    try {
      const parsed = JSON.parse(
        readFileSync(this.path, "utf8"),
      ) as Partial<StateFile>;
      if (parsed.version !== 1 || !parsed.mints) return;
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
