import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { jsonReplacer } from "./http.js";
import { scopedLogger } from "./logger.js";

type JobLike = {
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type JobPage<T> = {
  items: T[];
  nextCursor: string | null;
  total: number;
};

export type PersistentJobStoreOptions<T extends JobLike> = {
  path: string;
  maxRows: number;
  revive?: (row: any) => T | null;
};

const logger = scopedLogger("job-store");

function safeJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, jsonReplacer));
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export class PersistentJobStore<T extends JobLike> {
  private readonly path: string;
  private readonly journalPath: string;
  private readonly maxRows: number;
  private readonly revive?: (row: any) => T | null;
  private readonly rows = new Map<string, T>();
  private loaded = false;

  constructor(options: PersistentJobStoreOptions<T>) {
    this.path = resolve(options.path);
    this.journalPath = `${this.path}l`;
    this.maxRows = Math.max(1, options.maxRows);
    this.revive = options.revive;
  }

  loadOnce(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      const rows = Array.isArray(parsed?.jobs)
        ? parsed.jobs
        : Array.isArray(parsed?.items)
          ? parsed.items
          : [];
      for (const row of rows) {
        const revived = this.revive ? this.revive(row) : (row as T);
        if (revived?.id) this.rows.set(revived.id, revived);
      }
      this.prune(false);
    } catch (error) {
      logger.warn("could not load persisted jobs", { path: this.path, error });
    }
  }

  all(): T[] {
    this.loadOnce();
    return [...this.rows.values()].sort(
      (a, b) => b.createdAtMs - a.createdAtMs,
    );
  }

  get(id: string): T | undefined {
    this.loadOnce();
    return this.rows.get(id);
  }

  put(row: T): void {
    this.loadOnce();
    this.rows.set(row.id, safeJson(row));
    this.prune(false);
    this.flush();
    this.appendJournal("put", row);
  }

  delete(id: string): boolean {
    this.loadOnce();
    const deleted = this.rows.delete(id);
    if (deleted) {
      this.flush();
      this.appendJournal("delete", { id });
    }
    return deleted;
  }

  page(
    args: {
      limit?: number;
      cursor?: string | null;
      status?: string | null;
    } = {},
  ): JobPage<T> {
    const limit = Math.max(1, Math.min(250, Number(args.limit ?? 50)));
    const rows = this.all().filter((row: any) =>
      args.status ? String(row.status ?? "") === args.status : true,
    );
    const start = args.cursor
      ? rows.findIndex((row) => row.id === args.cursor) + 1
      : 0;
    const offset = start > 0 ? start : 0;
    const items = rows.slice(offset, offset + limit);
    const nextCursor =
      offset + limit < rows.length ? (items.at(-1)?.id ?? null) : null;
    return { items, nextCursor, total: rows.length };
  }

  prune(flush = true): void {
    if (this.rows.size <= this.maxRows) return;
    const stale = [...this.rows.values()]
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs)
      .slice(0, this.rows.size - this.maxRows);
    for (const row of stale) this.rows.delete(row.id);
    if (flush) this.flush();
  }

  pruneOlderThan(cutoffMs: number): number {
    this.loadOnce();
    let deleted = 0;
    for (const row of this.rows.values()) {
      if (row.updatedAtMs < cutoffMs) {
        this.rows.delete(row.id);
        deleted += 1;
      }
    }
    if (deleted) this.flush();
    return deleted;
  }

  flush(): void {
    const jobs = this.all().slice(0, this.maxRows).map(safeJson);
    atomicWrite(this.path, JSON.stringify({ version: 2, jobs }, null, 2));
  }

  private appendJournal(action: string, row: unknown): void {
    try {
      mkdirSync(dirname(this.journalPath), { recursive: true });
      appendFileSync(
        this.journalPath,
        `${JSON.stringify({ atMs: Date.now(), action, row: safeJson(row) }, jsonReplacer)}\n`,
      );
    } catch (error) {
      logger.warn("could not append job journal", {
        path: this.journalPath,
        error,
      });
    }
  }
}
