import { Database } from "bun:sqlite";

export class CheckpointStore {
  readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS checkpoints (
        name TEXT PRIMARY KEY,
        next_block INTEGER NOT NULL,
        parent_hash TEXT
      );
    `);
  }
  get(name: string): { nextBlock: number; parentHash?: string } | null {
    const row = this.db
      .query<{ next_block: number; parent_hash: string | null }, [string]>(
        "SELECT next_block, parent_hash FROM checkpoints WHERE name = ?",
      )
      .get(name);
    if (!row) return null;
    return {
      nextBlock: row.next_block,
      ...(row.parent_hash ? { parentHash: row.parent_hash } : {}),
    };
  }
  set(name: string, nextBlock: number, parentHash?: string): void {
    this.db.run(
      `INSERT INTO checkpoints(name, next_block, parent_hash) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET next_block=excluded.next_block, parent_hash=excluded.parent_hash`,
      [name, nextBlock, parentHash ?? null],
    );
  }
}
