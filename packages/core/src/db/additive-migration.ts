import { Database as SqliteDatabase } from "bun:sqlite";

export type AdditiveSqliteColumn = {
  name: string;
  /** SQLite column definition after the column name, e.g. `INTEGER NOT NULL DEFAULT 0`. */
  definition: string;
  /** Backfill existing NULL rows without adding a SQL DEFAULT to the schema. */
  backfill?: string | number | null;
};

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    throw new Error(`Unsafe SQLite identifier: ${value}`);
  return `"${value}"`;
}

function columnDefinition(value: string): string {
  const normalized = value.trim();
  if (!normalized || /[;\u0000]/.test(normalized))
    throw new Error("Invalid additive SQLite column definition");
  // SQLite ADD COLUMN deliberately cannot add PRIMARY KEY/UNIQUE and has
  // restrictions around non-constant defaults. Keep this helper additive-only.
  if (/\b(?:PRIMARY\s+KEY|UNIQUE)\b/i.test(normalized))
    throw new Error(
      "Additive SQLite columns cannot introduce PRIMARY KEY or UNIQUE constraints",
    );
  return normalized;
}

/**
 * Add missing columns with native ALTER TABLE. SQLite preserves rows, indexes
 * and triggers for ADD COLUMN. This does not disable an ORM's later schema sync:
 * sqlite-zod-orm compares CREATE TABLE SQL and may still rename/recreate a table
 * whose resulting SQL differs from its generated schema (including defaults).
 */
export function ensureAdditiveSqliteColumns(
  path: string,
  table: string,
  columns: readonly AdditiveSqliteColumn[],
): { added: string[]; existing: string[] } {
  const db = new SqliteDatabase(path, { create: true });
  try {
    const tableName = identifier(table);
    const present = new Set(
      (
        db.query(`PRAGMA table_info(${tableName})`).all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    if (present.size === 0)
      throw new Error(
        `SQLite table ${table} does not exist; additive migration requires an existing table`,
      );

    const added: string[] = [];
    const existing: string[] = [];
    db.transaction(() => {
      for (const column of columns) {
        if (present.has(column.name)) {
          existing.push(column.name);
          continue;
        }
        const columnName = identifier(column.name);
        const definition = columnDefinition(column.definition);
        db.exec(
          `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`,
        );
        if (column.backfill !== undefined)
          db.query(
            `UPDATE ${tableName} SET ${columnName} = ? WHERE ${columnName} IS NULL`,
          ).run(column.backfill);
        present.add(column.name);
        added.push(column.name);
      }
    })();
    return { added, existing };
  } finally {
    db.close();
  }
}
