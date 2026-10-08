import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureAdditiveSqliteColumns } from "./additive-migration.ts";
import { Database as OrmDatabase, z } from "sqlite-zod-orm";

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) if (existsSync(path)) rmSync(path);
});

describe("ensureAdditiveSqliteColumns", () => {
  test("append-only ORM-compatible column and backfill preserve rows/triggers when reopening the ORM", () => {
    const path = join(
      tmpdir(),
      `solard-orm-additive-${Date.now()}-${Math.random()}.db`,
    );
    paths.push(path);
    const options = { timestamps: false, softDeletes: false };
    const before = new OrmDatabase(
      path,
      { trades: z.object({ signature: z.string() }) },
      options,
    );
    before.trades.insert({ signature: "before" });
    before.close();
    const raw = new Database(path);
    raw.exec(
      "CREATE TABLE audit (signature TEXT); CREATE TRIGGER trades_audit AFTER INSERT ON trades BEGIN INSERT INTO audit VALUES (NEW.signature); END;",
    );
    raw.close();
    ensureAdditiveSqliteColumns(path, "trades", [
      { name: "snapshotValue", definition: "INTEGER", backfill: 0 },
    ]);
    const after = new OrmDatabase(
      path,
      {
        trades: z.object({
          signature: z.string(),
          snapshotValue: z.number().default(0),
        }),
      },
      options,
    );
    expect(after.trades.select().first()?.signature).toBe("before");
    expect(after.trades.select().first()?.snapshotValue).toBe(0);
    after.trades.insert({ signature: "after" });
    after.close();
    const verify = new Database(path);
    expect(verify.query("SELECT signature FROM audit").all()).toEqual([
      { signature: "after" },
    ]);
    expect(
      verify
        .query("SELECT name FROM sqlite_master WHERE name LIKE 'trades_v%'")
        .all(),
    ).toEqual([]);
    verify.close();
  });

  test("preserves populated rows and triggers", () => {
    const path = join(
      tmpdir(),
      `solard-additive-${Date.now()}-${Math.random()}.db`,
    );
    paths.push(path);
    const db = new Database(path, { create: true });
    db.exec(`
      CREATE TABLE trades (id INTEGER PRIMARY KEY, signature TEXT NOT NULL);
      CREATE TABLE audit (trade_id INTEGER NOT NULL);
      CREATE TRIGGER trades_audit AFTER INSERT ON trades
      BEGIN INSERT INTO audit(trade_id) VALUES (NEW.id); END;
      INSERT INTO trades(signature) VALUES ('before');
    `);
    db.close();

    expect(
      ensureAdditiveSqliteColumns(path, "trades", [
        { name: "snapshotValue", definition: "REAL NOT NULL DEFAULT 0" },
      ]),
    ).toEqual({ added: ["snapshotValue"], existing: [] });

    const verify = new Database(path);
    expect(
      verify.query("SELECT id, signature, snapshotValue FROM trades").get(),
    ).toEqual({
      id: 1,
      signature: "before",
      snapshotValue: 0,
    });
    verify.exec("INSERT INTO trades(signature) VALUES ('after')");
    expect(
      verify.query("SELECT COUNT(*) AS count FROM audit").get() as {
        count: number;
      },
    ).toEqual({ count: 2 });
    verify.close();

    expect(
      ensureAdditiveSqliteColumns(path, "trades", [
        { name: "snapshotValue", definition: "REAL NOT NULL DEFAULT 0" },
      ]),
    ).toEqual({ added: [], existing: ["snapshotValue"] });
  });
});
