import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";

import { Solard } from "../index.ts";
import { encryptKeypair } from "../core/keypair.ts";

const createdPaths: string[] = [];
const previousMasterKey = process.env.SLRD_MASTER_KEY;

function tempDb(label: string): string {
  const path = join(
    tmpdir(),
    `solard-${label}-${process.pid}-${Date.now()}-${Math.random()}.sqlite`,
  );
  createdPaths.push(path);
  return path;
}

function secret(keypair: Keypair): string {
  return JSON.stringify([...keypair.secretKey]);
}

afterEach(() => {
  process.env.SLRD_MASTER_KEY = previousMasterKey;
  for (const path of createdPaths.splice(0)) {
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

test("createWallet generates, encrypts, lists and signs from the canonical DB", () => {
  process.env.SLRD_MASTER_KEY = "solard-wallet-test-master-key";
  const slrd = new Solard({ dbPath: tempDb("wallet") });
  try {
    const created = slrd.createWallet("generated");

    expect(created.name).toBe("generated");
    expect(created.address.length).toBeGreaterThan(30);
    expect("encryptedSecretKey" in created).toBe(false);

    const listed = slrd.listWallets();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.address).toBe(created.address);
    expect("encryptedSecretKey" in (listed[0] ?? {})).toBe(false);

    const signer = slrd.signer(created.address);
    expect(signer.publicKey.toBase58()).toBe(created.address);
  } finally {
    slrd.close();
  }
});

test("createWallet with a different master key cannot change the wallet database", () => {
  process.env.SLRD_MASTER_KEY = "solard-wallet-key-a";
  const slrd = new Solard({ dbPath: tempDb("wrong-create-key") });
  try {
    const first = slrd.createWallet("first");

    process.env.SLRD_MASTER_KEY = "solard-wallet-key-b";
    expect(() => slrd.createWallet("second")).toThrow(
      "current SLRD_MASTER_KEY must decrypt every stored signing wallet",
    );

    process.env.SLRD_MASTER_KEY = "solard-wallet-key-a";
    expect(slrd.listWallets().map((row) => row.address)).toEqual([
      first.address,
    ]);
    expect(slrd.wallets.integrity()).toEqual({
      total: 1,
      decrypted: 1,
      failures: [],
    });
  } finally {
    slrd.close();
  }
});

test("importWallet with a different master key cannot change the wallet database", () => {
  process.env.SLRD_MASTER_KEY = "solard-wallet-key-a";
  const slrd = new Solard({ dbPath: tempDb("wrong-import-key") });
  try {
    const first = slrd.createWallet("first");
    const imported = Keypair.generate();

    process.env.SLRD_MASTER_KEY = "solard-wallet-key-b";
    expect(() => slrd.importWallet(secret(imported), "imported")).toThrow(
      "current SLRD_MASTER_KEY must decrypt every stored signing wallet",
    );

    process.env.SLRD_MASTER_KEY = "solard-wallet-key-a";
    expect(slrd.listWallets().map((row) => row.address)).toEqual([
      first.address,
    ]);
    expect(slrd.wallets.integrity()).toEqual({
      total: 1,
      decrypted: 1,
      failures: [],
    });
  } finally {
    slrd.close();
  }
});

test("post-write integrity failure rolls back the wallet insert", () => {
  process.env.SLRD_MASTER_KEY = "solard-wallet-key-a";
  const slrd = new Solard({ dbPath: tempDb("post-write-rollback") });
  try {
    const first = slrd.createWallet("first");
    const rawDb = slrd.db as unknown as { exec(sql: string): unknown };

    rawDb.exec(`
      CREATE TRIGGER corrupt_wallet_after_insert
      AFTER INSERT ON wallets
      BEGIN
        UPDATE wallets
        SET authTag = 'AAAA'
        WHERE id = NEW.id;
      END
    `);

    expect(() => slrd.createWallet("corrupted")).toThrow(
      "current SLRD_MASTER_KEY must decrypt every stored signing wallet",
    );

    rawDb.exec("DROP TRIGGER corrupt_wallet_after_insert");

    expect(slrd.listWallets().map((row) => row.address)).toEqual([
      first.address,
    ]);
    expect(slrd.wallets.integrity()).toEqual({
      total: 1,
      decrypted: 1,
      failures: [],
    });
  } finally {
    slrd.close();
  }
});

test("re-import can repair one mismatched wallet without weakening the full-database invariant", () => {
  process.env.SLRD_MASTER_KEY = "solard-wallet-key-a";
  const slrd = new Solard({ dbPath: tempDb("repair-one") });
  try {
    const good = slrd.createWallet("good");
    const damagedKeypair = Keypair.generate();
    const damaged = slrd.importWallet(secret(damagedKeypair), "damaged");

    process.env.SLRD_MASTER_KEY = "solard-wallet-key-b";
    const wrongEncryption = encryptKeypair(damagedKeypair);
    slrd.db.wallets.update(wrongEncryption).where({ id: damaged.id }).exec();

    process.env.SLRD_MASTER_KEY = "solard-wallet-key-a";
    expect(slrd.wallets.integrity()).toEqual({
      total: 2,
      decrypted: 1,
      failures: [
        {
          id: damaged.id,
          name: damaged.name,
          address: damaged.address,
        },
      ],
    });

    const repaired = slrd.importWallet(secret(damagedKeypair), "damaged");
    expect(repaired.address).toBe(damaged.address);
    expect(slrd.wallets.integrity()).toEqual({
      total: 2,
      decrypted: 2,
      failures: [],
    });
    expect(slrd.signer(good.address).publicKey.toBase58()).toBe(good.address);
    expect(slrd.signer(damaged.address).publicKey.toBase58()).toBe(
      damaged.address,
    );
  } finally {
    slrd.close();
  }
});
