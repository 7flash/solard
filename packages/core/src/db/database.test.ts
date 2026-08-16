import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { Solard } from "../index.ts";
import { resolveDbPath } from "./database.ts";

const createdPaths: string[] = [];
const previousMasterKey = process.env.SLRD_MASTER_KEY;
const previousDbPath = process.env.SLRD_DB_PATH;
const previousLegacyDbPath = process.env.SOLARD_DB_PATH;

afterEach(() => {
  process.env.SLRD_MASTER_KEY = previousMasterKey;
  if (previousDbPath == null) delete process.env.SLRD_DB_PATH;
  else process.env.SLRD_DB_PATH = previousDbPath;
  if (previousLegacyDbPath == null) delete process.env.SOLARD_DB_PATH;
  else process.env.SOLARD_DB_PATH = previousLegacyDbPath;
  for (const path of createdPaths.splice(0)) {
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

test("default database path is stable across working directories", () => {
  delete process.env.SLRD_DB_PATH;
  delete process.env.SOLARD_DB_PATH;
  const path = resolveDbPath();
  expect(path).toBe(join(homedir(), ".solard", "solard.sqlite"));
  expect(isAbsolute(path)).toBe(true);
});

test("explicit and environment database paths override the stable default", () => {
  delete process.env.SOLARD_DB_PATH;
  process.env.SLRD_DB_PATH = "./custom-solard.sqlite";
  expect(resolveDbPath()).toBe(resolve("./custom-solard.sqlite"));
  expect(resolveDbPath("./explicit.sqlite")).toBe(resolve("./explicit.sqlite"));
});

test("multiple Solard instances share the canonical database without premature close", () => {
  process.env.SLRD_MASTER_KEY = "solard-database-test-master-key";
  const dbPath = join(
    tmpdir(),
    `solard-db-${process.pid}-${Date.now()}-${Math.random()}.sqlite`,
  );
  createdPaths.push(dbPath);

  const first = new Solard({ dbPath });
  const second = new Solard({ dbPath });
  try {
    const wallet = first.createWallet("shared");
    expect(
      second.listWallets().some((row) => row.address === wallet.address),
    ).toBe(true);

    first.close();
    expect(
      second.listWallets().some((row) => row.address === wallet.address),
    ).toBe(true);
  } finally {
    first.close();
    second.close();
  }
});
