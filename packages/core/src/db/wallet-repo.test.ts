import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { closeDatabase, openDatabase } from "./database.ts";
import { WalletRepo } from "./wallet-repo.ts";

const originalMasterKey = process.env.SLRD_MASTER_KEY;
let dbPath = "";

function secretB58(keypair: Keypair): string {
  return bs58.encode(keypair.secretKey);
}

beforeEach(() => {
  process.env.SLRD_MASTER_KEY = "test-master-key-for-wallet-repo";
  dbPath = join(
    tmpdir(),
    `solard-wallet-repo-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  mkdirSync(tmpdir(), { recursive: true });
});

afterEach(() => {
  try {
    closeDatabase(dbPath);
  } catch {
    // ignore
  }
  try {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  } catch {
    // ignore
  }
  if (originalMasterKey == null) delete process.env.SLRD_MASTER_KEY;
  else process.env.SLRD_MASTER_KEY = originalMasterKey;
});

describe("WalletRepo.import name collision", () => {
  test("imports a new wallet under a name", () => {
    const db = openDatabase(dbPath);
    const repo = new WalletRepo(db);
    const key = Keypair.generate();
    const row = repo.import(secretB58(key), "alice");
    expect(row.name).toBe("alice");
    expect(row.address).toBe(key.publicKey.toBase58());
  });

  test("re-importing the same address updates without force", () => {
    const db = openDatabase(dbPath);
    const repo = new WalletRepo(db);
    const key = Keypair.generate();
    repo.import(secretB58(key), "alice");
    const updated = repo.import(secretB58(key), "alice-renamed");
    expect(updated.address).toBe(key.publicKey.toBase58());
    expect(updated.name).toBe("alice-renamed");
    expect(repo.list()).toHaveLength(1);
  });

  test("refuses a name already used by a different address", () => {
    const db = openDatabase(dbPath);
    const repo = new WalletRepo(db);
    const a = Keypair.generate();
    const b = Keypair.generate();
    repo.import(secretB58(a), "alice");
    expect(() => repo.import(secretB58(b), "alice")).toThrow(
      /already used by/,
    );
    expect(repo.list()).toHaveLength(1);
    expect(repo.list()[0]!.address).toBe(a.publicKey.toBase58());
  });

  test("overwrite replaces the named wallet with the new key", () => {
    const db = openDatabase(dbPath);
    const repo = new WalletRepo(db);
    const a = Keypair.generate();
    const b = Keypair.generate();
    repo.import(secretB58(a), "alice");
    const replaced = repo.import(secretB58(b), "alice", { overwrite: true });
    expect(replaced.name).toBe("alice");
    expect(replaced.address).toBe(b.publicKey.toBase58());
    expect(repo.list()).toHaveLength(1);
  });

  test("overwrite renames a conflicting name row when re-importing an existing address", () => {
    const db = openDatabase(dbPath);
    const repo = new WalletRepo(db);
    const a = Keypair.generate();
    const b = Keypair.generate();
    
    repo.import(secretB58(a), "bob");
    repo.import(secretB58(b), "alice");

    const updated = repo.import(secretB58(a), "alice", { overwrite: true });
    expect(updated.address).toBe(a.publicKey.toBase58());
    expect(updated.name).toBe("alice");

    const active = repo.list();
    expect(active).toHaveLength(1);
    expect(active[0]!.address).toBe(a.publicKey.toBase58());
    expect(active[0]!.name).toBe("alice");

    const retired = db.wallets
      .select()
      .where({ address: b.publicKey.toBase58() })
      .first() as { name: string; isActive: number } | undefined;
    expect(retired).toBeTruthy();
    expect(retired!.isActive).toBe(0);
    expect(retired!.name).not.toBe("alice");
    expect(retired!.name.startsWith("alice-replaced-")).toBe(true);
  });
});
