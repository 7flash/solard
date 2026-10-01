import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";

import { Solard } from "../index.ts";

const createdPaths: string[] = [];

function tempDb(label: string): string {
  const path = join(
    tmpdir(),
    `solard-${label}-${process.pid}-${Date.now()}-${Math.random()}.sqlite`,
  );
  createdPaths.push(path);
  return path;
}

afterEach(() => {
  for (const path of createdPaths.splice(0)) {
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

test("execution token resolution preserves registered-token lookup", async () => {
  const slrd = new Solard({ dbPath: tempDb("execution-token-registered") });
  try {
    const mint = Keypair.generate().publicKey.toBase58();
    const stored = slrd.tokens.upsert({ mint });
    let inspections = 0;
    slrd.addToken = async () => {
      inspections += 1;
      throw new Error("unexpected inspection");
    };

    const resolved = await slrd.resolveTokenForExecution(mint);

    expect(resolved.id).toBe(stored.id);
    expect(resolved.mint).toBe(mint);
    expect(inspections).toBe(0);
  } finally {
    slrd.close();
  }
});

test("execution token resolution auto-inspects an unregistered raw mint", async () => {
  const slrd = new Solard({ dbPath: tempDb("execution-token-auto-add") });
  try {
    const mint = Keypair.generate().publicKey.toBase58();
    let inspections = 0;
    slrd.addToken = async (mintRef) => {
      inspections += 1;
      return slrd.tokens.upsert({ mint: mintRef, decimals: 6 });
    };

    const resolved = await slrd.resolveTokenForExecution(mint);

    expect(resolved.mint).toBe(mint);
    expect(resolved.decimals).toBe(6);
    expect(inspections).toBe(1);
    expect(slrd.resolveToken(mint).mint).toBe(mint);
  } finally {
    slrd.close();
  }
});

test("execution token resolution does not auto-register unknown aliases", async () => {
  const slrd = new Solard({ dbPath: tempDb("execution-token-alias") });
  try {
    let inspections = 0;
    slrd.addToken = async () => {
      inspections += 1;
      throw new Error("unexpected inspection");
    };

    await expect(slrd.resolveTokenForExecution("NOT_A_MINT")).rejects.toThrow(
      "Unknown token",
    );
    expect(inspections).toBe(0);
  } finally {
    slrd.close();
  }
});

test("concurrent first-use execution shares one token inspection", async () => {
  const slrd = new Solard({ dbPath: tempDb("execution-token-concurrent") });
  try {
    const mint = Keypair.generate().publicKey.toBase58();
    let inspections = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    slrd.addToken = async (mintRef) => {
      inspections += 1;
      await gate;
      return slrd.tokens.upsert({ mint: mintRef });
    };

    const first = slrd.resolveTokenForExecution(mint);
    const second = slrd.resolveTokenForExecution(mint);

    expect(inspections).toBe(1);
    release();
    const [left, right] = await Promise.all([first, second]);

    expect(left.id).toBe(right.id);
    expect(inspections).toBe(1);
  } finally {
    slrd.close();
  }
});

test("failed first-use inspection can be retried", async () => {
  const slrd = new Solard({ dbPath: tempDb("execution-token-retry") });
  try {
    const mint = Keypair.generate().publicKey.toBase58();
    let inspections = 0;
    slrd.addToken = async (mintRef) => {
      inspections += 1;
      if (inspections === 1) throw new Error("inspection failed");
      return slrd.tokens.upsert({ mint: mintRef });
    };

    await expect(slrd.resolveTokenForExecution(mint)).rejects.toThrow(
      "inspection failed",
    );
    const resolved = await slrd.resolveTokenForExecution(mint);

    expect(resolved.mint).toBe(mint);
    expect(inspections).toBe(2);
  } finally {
    slrd.close();
  }
});
