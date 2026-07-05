import type { AltRow, SowlDatabase } from "./schema.js";
export class AltRepo {
  constructor(private readonly db: SowlDatabase) {}
  register(address: string, label?: string): AltRow {
    const existing = this.db.alts.select().where({ address }).first() as AltRow | undefined;
    if (existing) { existing.isActive = 1; existing.label = label ?? existing.label; existing.updatedAtMs = Date.now(); return existing; }
    const now = Date.now();
    return this.db.alts.insert({ address, label: label ?? null, isActive: 1, createdAtMs: now, updatedAtMs: now }) as AltRow;
  }
  list(): AltRow[] { return this.db.alts.select().where({ isActive: 1 }).orderBy("id", "asc").all() as AltRow[]; }
}
