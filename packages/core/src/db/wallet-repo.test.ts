import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Solard } from "../index.ts";

const createdPaths: string[] = [];
const previousMasterKey = process.env.SLRD_MASTER_KEY;

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
  const dbPath = join(
    tmpdir(),
    `solard-wallet-${process.pid}-${Date.now()}-${Math.random()}.sqlite`,
  );
  createdPaths.push(dbPath);

  const slrd = new Solard({ dbPath });
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
