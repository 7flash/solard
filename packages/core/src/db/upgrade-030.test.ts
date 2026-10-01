import { test, expect } from "bun:test";
import { Database, z } from "sqlite-zod-orm";
import { Database as Sqlite } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenSchema } from "./schema.ts";
import { openDatabase, closeDatabase } from "./database.ts";
test("0.2.29 token rows/index/trigger survive expanded venue enum and full 0.2.30 open", () => {
  const folder = mkdtempSync(join(tmpdir(), "solard-upgrade-")); const path = join(folder, "db.sqlite");
  try {
    const old = new Database(path, { tokens: TokenSchema.extend({ venueHint: z.enum(["unknown", "pump-curve", "pumpswap"]).default("unknown") }) }, { timestamps: false, softDeletes: false, unique: { tokens: [["mint"]] }, indexes: { tokens: ["mint", "name", "symbol", "venueHint"] } });
    old.tokens.insert({ mint: "first", createdAtMs: 1, updatedAtMs: 1 });
    old.tokens.insert({ mint: "second", createdAtMs: 2, updatedAtMs: 2 }); old.close();
    const raw = new Sqlite(path); raw.exec("CREATE TABLE audit (mint TEXT); CREATE TRIGGER token_audit AFTER INSERT ON tokens BEGIN INSERT INTO audit VALUES (NEW.mint); END;");
    const sqlBefore = raw.query("SELECT sql FROM sqlite_master WHERE name='tokens'").get(); raw.close();
    const current = openDatabase(path);
    expect(current.tokens.select().all().map((row) => row.mint)).toEqual(["first", "second"]);
    current.tokens.insert({ mint: "third", venueHint: "jupiter", createdAtMs: 3, updatedAtMs: 3 });
    expect(current.raw("PRAGMA busy_timeout")[0].timeout).toBe(5000);
    closeDatabase(path);
    const verify = new Sqlite(path);
    expect(verify.query("SELECT sql FROM sqlite_master WHERE name='tokens'").get()).toEqual(sqlBefore);
    expect(verify.query("SELECT mint FROM audit").all()).toEqual([{ mint: "third" }]);
    expect(verify.query("SELECT name FROM sqlite_master WHERE name LIKE 'tokens_v%'").all()).toEqual([]);
    expect(verify.query("SELECT COUNT(*) AS n FROM tokens").get()).toEqual({ n: 3 }); verify.close();
  } finally { closeDatabase(path); rmSync(folder, { recursive: true, force: true }); }
});
