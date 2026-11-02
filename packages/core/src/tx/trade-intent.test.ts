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
  const folder = mkdtempSync(join(tmpdir(), "solard-intent-"));
  const path = join(folder, "db.sqlite");
  try {
    const payer = Keypair.generate();
    let db = openDatabase(path);
    const store = new TradeIntentStore(db);
    expect(store.claim("I-1", "same", payer.publicKey.toBase58())).toBe(true);
    expect(store.claim("I-1", "same", payer.publicKey.toBase58())).toBe(false);
    store.update("I-1", (intent) =>
      intent.submissions.push({
        signature: "original",
        executionId: 1,
        lastValidBlockHeight: 100,
        sender: "rpc",
        priorityMicroLamports: 100,
      }),
    );
    closeDatabase(path);
    db = openDatabase(path);
    const core: Solard = Object.create(Solard.prototype);
    Object.defineProperty(core, "db", { value: db });
    core.signer = () => payer;
    core.confirmSignature = async (signature) => ({
      signature,
      sender: "rpc",
      status: "submitted",
      slot: null,
    });
    core.connection = () =>
      ({
        getBlockHeight: async () => 101,
        getSignatureStatuses: async () => ({ value: [null] }),
        getTransaction: async () => null,
      }) as any;
    let sends = 0;
    const result = await core.runReliableTrade(
      "wallet",
      "I-1",
      "same",
      async () => {
        sends++;
        return tradeResult({
          signature: "new",
          sender: "rpc",
          status: "submitted",
          slot: null,
        });
      },
    );
    expect(sends).toBe(0);
    expect(result.signature).toBe("original");
    expect(result.code).toBe("EXPIRED");
    expect(result.status).toBe("failed");
    expect((await core.resumeTrade("I-1")).signature).toBe("original");
    const conflict = await core.runReliableTrade(
      "wallet",
      "I-1",
      "different",
      async () => {
        sends++;
        throw new Error();
      },
    );
    expect(conflict.code).toBe("INTENT_CONFLICT");
    expect(sends).toBe(0);
  } finally {
    closeDatabase(path);
    rmSync(folder, { recursive: true, force: true });
  }
});

test("terminal rejection survives a transient SQLite lock and restart", async () => {
  const folder = mkdtempSync(join(tmpdir(), "solard-intent-busy-"));
  const path = join(folder, "db.sqlite");
  try {
    let db = openDatabase(path);
    const payer = Keypair.generate();
    const core: Solard = Object.create(Solard.prototype);
    let failures = 0;
    const wrapped = new Proxy(db, { get(target, prop) {
      if (prop === "transaction") return (callback: () => unknown) => {
        if (failures++ === 0) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        return target.transaction(callback);
      };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    Object.defineProperty(core, "db", { value: wrapped });
    core.signer = () => payer;
    const rejected = { slot: null, solPrincipalDeltaLamports: null,
      targetTokenDeltaRaw: null, networkFeeLamports: null, status: "failed" as const,
      phase: "before-submission" as const, code: "BELOW_MINIMUM", message: "guard",
      retryable: false, attempts: [], quotedMinimum: 87n, requiredMinimum: 101n };
    expect(await core.runReliableTrade("wallet", "rejected", "same", async () => rejected)).toEqual(rejected);
    expect(failures).toBe(2);
    closeDatabase(path);
    db = openDatabase(path);
    expect(new TradeIntentStore(db).get("rejected")?.result).toEqual(rejected);
  } finally {
    closeDatabase(path);
    rmSync(folder, { recursive: true, force: true });
  }
});

test("exhausted outcome persistence reports the known result instead of silently stranding it", async () => {
  const folder = mkdtempSync(join(tmpdir(), "solard-intent-fail-"));
  const path = join(folder, "db.sqlite");
  try {
    const db = openDatabase(path);
    const core: Solard = Object.create(Solard.prototype);
    const payer = Keypair.generate();
    const wrapped = new Proxy(db, { get(target, prop) {
      if (prop === "transaction") return () => { throw new Error("disk failure"); };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    Object.defineProperty(core, "db", { value: wrapped });
    core.signer = () => payer;
    const result = { slot: null, solPrincipalDeltaLamports: null, targetTokenDeltaRaw: null,
      networkFeeLamports: null, status: "failed" as const, phase: "before-submission" as const,
      code: "BELOW_MINIMUM", message: "guard", retryable: false, attempts: [] };
    let error: any;
    try { await core.runReliableTrade("wallet", "save-failure", "same", async () => result); }
    catch (caught) { error = caught; }
    expect(error?.code).toBe("TRADE_OUTCOME_PERSISTENCE_FAILED");
    expect(error?.tradeResult).toEqual(result);
    expect(error?.intentKey).toBe("save-failure");
  } finally {
    closeDatabase(path);
    rmSync(folder, { recursive: true, force: true });
  }
});
import { abandonedBeforeSubmission } from './trade-intent.ts';
import { hostname } from 'node:os';
test('only a definitely dead local owner with no submissions is recoverable',()=>{
 const intent={fingerprint:'x',wallet:'w',submissions:[],owner:{pid:process.pid,hostname:hostname()}};
 expect(abandonedBeforeSubmission(intent)).toBe(false);
 expect(abandonedBeforeSubmission({...intent,owner:{pid:2147483647,hostname:hostname()}})).toBe(true);
 expect(abandonedBeforeSubmission({...intent,owner:undefined})).toBe(false);
 expect(abandonedBeforeSubmission({...intent,owner:{pid:2147483647,hostname:'other-host'}})).toBe(false);
 expect(abandonedBeforeSubmission({...intent,submissions:[{signature:'sent',executionId:1,sender:'rpc',lastValidBlockHeight:2,priorityMicroLamports:0}]})).toBe(false);
});
