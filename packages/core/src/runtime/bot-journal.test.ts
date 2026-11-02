const { rmSync } = require("fs") as { rmSync(path: string, options: { recursive: boolean; force: boolean }): void };
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { recordBotSnapshot } from "./bot-journal.ts";
test("shared positions retains every bot while histories append independently", () => {
 const root=mkdtempSync(join(tmpdir(),"bot-journal-"));
 try {
  writeFileSync(join(root,"bot-w-a.json"),JSON.stringify({phase:"sell",position:{amountRaw:"12"},pending:{key:"pending"},health:"BALANCE_MISMATCH"}));
  writeFileSync(join(root,"bot-w-b.json"),JSON.stringify({phase:"buy",position:null,pending:null}));
  recordBotSnapshot(root,"w","a",{amount:12n},"result");
  recordBotSnapshot(root,"w","b",{},"snapshot");
  recordBotSnapshot(root,"w","a",{},"snapshot");
  const shared=JSON.parse(readFileSync(join(root,"bot-positions.json"),"utf8"));
  expect(shared.positions).toHaveLength(2);
  expect(shared.positions.find((p:any)=>p.source==="bot-w-a.json").health).toBe("BALANCE_MISMATCH");
  expect(readFileSync(join(root,"bot-history/w-a.jsonl"),"utf8").trim().split("\n")).toHaveLength(2);
  expect(readFileSync(join(root,"bot-history/w-b.jsonl"),"utf8").trim().split("\n")).toHaveLength(1);
 } finally {rmSync(root,{recursive:true,force:true});}
});
