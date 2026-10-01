import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { openDatabase, closeDatabase } from "../db/database.ts";
import { TradeIntentStore } from "./trade-intent.ts";
import { Solard } from "../core/solard.ts";
import { tradeResult } from "./trade-result.ts";
test("intent survives restart, reconciles original signature and blocks a second operation", async () => {
  const folder = mkdtempSync(join(tmpdir(), "solard-intent-")); const path = join(folder, "db.sqlite");
  try {
    const payer = Keypair.generate(); let db = openDatabase(path); const store = new TradeIntentStore(db);
    expect(store.claim("I-1", "same", payer.publicKey.toBase58())).toBe(true);
    expect(store.claim("I-1", "same", payer.publicKey.toBase58())).toBe(false);
    store.update("I-1", (intent) => intent.submissions.push({ signature: "original", executionId: 1, lastValidBlockHeight: 100, sender: "rpc", priorityMicroLamports: 100 }));
    closeDatabase(path); db = openDatabase(path);
    const core: Solard = Object.create(Solard.prototype); Object.defineProperty(core, "db", { value: db });
    core.signer = () => payer;
    core.confirmSignature = async (signature) => ({ signature, sender: "rpc", status: "submitted", slot: null });
    core.connection = () => ({ getBlockHeight: async () => 101, getSignatureStatuses: async () => ({ value: [null] }), getTransaction: async () => null }) as any;
    let sends = 0;
    const result = await core.runReliableTrade("wallet", "I-1", "same", async () => { sends++; return tradeResult({ signature: "new", sender: "rpc", status: "submitted", slot: null }); });
    expect(sends).toBe(0); expect(result.signature).toBe("original"); expect(result.code).toBe("EXPIRED"); expect(result.status).toBe("failed");
    expect((await core.resumeTrade("I-1")).signature).toBe("original");
    const conflict = await core.runReliableTrade("wallet", "I-1", "different", async () => { sends++; throw new Error(); });
    expect(conflict.code).toBe("INTENT_CONFLICT"); expect(sends).toBe(0);
  } finally { closeDatabase(path); rmSync(folder, { recursive: true, force: true }); }
});
